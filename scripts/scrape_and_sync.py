#!/usr/bin/env python3
"""
mnmm.xyz -> marketplace sync.

Scrapes https://mnmm.xyz, extracts the TOP N newest website URLs
(the directory grid is sorted newest-first), and pushes them to the
marketplace API endpoint.

Env vars:
    MARKETPLACE_API_URL   target endpoint (required unless DRY_RUN=1)
    API_KEY               bearer token sent as Authorization header
    DRY_RUN               set to "1" to skip the POST and just print
    TOP_N                 override how many entries to take (default 5)

Usage:
    python scripts/scrape_and_sync.py
"""

import logging
import os
import re
import sys
from datetime import date, datetime, timezone

import requests
from bs4 import BeautifulSoup

MNMM_URL = "https://mnmm.xyz"
TOP_N = int(os.environ.get("TOP_N", "5"))
TIMEOUT_SECS = 30
RETRIES = 3

DATE_SLUG_RE = re.compile(r"/websites/(\d{4}-\d{2}-\d{2})-")

log = logging.getLogger("mnmm-sync")


# --------------------------------------------------------------------------- #
#  Logging                                                                     #
# --------------------------------------------------------------------------- #

def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
        force=True,
    )


# --------------------------------------------------------------------------- #
#  Fetch                                                                       #
# --------------------------------------------------------------------------- #

def fetch_directory() -> str:
    """Fetch the raw HTML of mnmm.xyz with retries."""
    last_err: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            resp = requests.get(
                MNMM_URL,
                timeout=TIMEOUT_SECS,
                headers={"User-Agent": "mnmm-marketplace-sync/1.0"},
            )
            resp.raise_for_status()
            log.info("Fetched %s (%d bytes)", MNMM_URL, len(resp.text))
            return resp.text
        except requests.RequestException as err:
            last_err = err
            wait = attempt * 3
            log.warning("Fetch attempt %d/%d failed: %s — retrying in %ds",
                        attempt, RETRIES, err, wait)
            import time
            time.sleep(wait)
    raise RuntimeError(f"Could not fetch {MNMM_URL}: {last_err}")


# --------------------------------------------------------------------------- #
#  Extract                                                                     #
# --------------------------------------------------------------------------- #

def normalize_domain(url: str) -> str:
    """https://rokadakia.com/ -> rokadakia.com"""
    domain = re.sub(r"^https?://", "", url.strip())
    domain = domain.rstrip("/")
    return domain


def extract_top_sites(html: str, n: int = TOP_N) -> list[dict]:
    """
    Return the first N site cards from the directory grid.
    Grid order == newest-first (verified against mnmm.xyz).
    Each record: {"url": "<domain>", "date_added": "<YYYY-MM-DD>"}
    date_added comes from the card's detail-page slug when present,
    otherwise falls back to today.
    """
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select(".websites .website")  # section.websites > div.website

    if not cards:
        raise RuntimeError(
            "No .websites .website cards found — mnmm.xyz markup may have changed."
        )

    log.info("Found %d cards in grid", len(cards))

    records: list[dict] = []
    seen: set[str] = set()

    for card in cards:
        # external link sits in .details > a.link
        link_el = card.select_one(".details a.link") or card.select_one("a.link")
        if not link_el or not link_el.get("href"):
            continue

        domain = normalize_domain(link_el["href"])

        # basic sanity: must look like a bare domain
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}", domain, re.I):
            continue

        if domain in seen:
            continue

        # real date_added lives in the internal detail link: /websites/YYYY-MM-DD-slug
        date_added = None
        img_link = card.select_one("a.image[href]")
        if img_link:
            m = DATE_SLUG_RE.search(img_link["href"])
            if m:
                date_added = m.group(1)

        if not date_added:
            date_added = date.today().isoformat()

        seen.add(domain)
        records.append({"url": domain, "date_added": date_added})

        if len(records) >= n:
            break

    if not records:
        raise RuntimeError("Extracted zero valid records — check selectors.")

    return records


# --------------------------------------------------------------------------- #
#  Push                                                                        #
# --------------------------------------------------------------------------- #

def send_to_marketplace(records: list[dict]) -> int:
    """POST records to MARKETPLACE_API_URL. Returns HTTP status code."""
    api_url = os.environ.get("MARKETPLACE_API_URL")
    api_key = os.environ.get("API_KEY")

    if os.environ.get("DRY_RUN") == "1":
        log.info("DRY_RUN=1 — skipping POST. Payload:")
        log.info("%s", records)
        return 0

    if not api_url:
        raise RuntimeError("MARKETPLACE_API_URL env var is required.")
    if not api_key:
        raise RuntimeError("API_KEY env var is required.")

    payload = {
        "source": "mnmm.xyz",
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "records": records,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    last_err: Exception | None = None
    last_status: int | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            resp = requests.post(api_url, json=payload, headers=headers,
                                 timeout=TIMEOUT_SECS)
            last_status = resp.status_code

            if 200 <= resp.status_code < 300:
                log.info("Pushed %d records to %s (HTTP %d)",
                         len(records), api_url, resp.status_code)
                return resp.status_code

            log.warning("Attempt %d/%d: HTTP %d — %s",
                        attempt, RETRIES, resp.status_code, resp.text[:300])
            # client errors won't fix themselves — don't retry 4xx (except 429)
            if 400 <= resp.status_code < 500 and resp.status_code != 429:
                raise RuntimeError(
                    f"Marketplace rejected payload (HTTP {resp.status_code}): "
                    f"{resp.text[:300]}"
                )
        except requests.RequestException as err:
            last_err = err
            log.warning("Attempt %d/%d network error: %s", attempt, RETRIES, err)

        import time
        time.sleep(attempt * 5)

    raise RuntimeError(
        f"Failed to push after {RETRIES} attempts "
        f"(last_status={last_status}, last_err={last_err})"
    )


# --------------------------------------------------------------------------- #
#  Main                                                                        #
# --------------------------------------------------------------------------- #

def main() -> int:
    setup_logging()

    try:
        html = fetch_directory()
        records = extract_top_sites(html)

        log.info("Top %d newest sites:", len(records))
        for i, r in enumerate(records, 1):
            log.info("  %d. %-32s %s", i, r["url"], r["date_added"])

        status = send_to_marketplace(records)

        log.info("Done.")
        return 0

    except Exception as exc:
        log.error("FATAL: %s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())

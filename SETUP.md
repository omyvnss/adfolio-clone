# Adfolio Clone — Setup Guide

## What You're Building

```
Google Sheet → GitHub Actions (Playwright) → Supabase → Your Gallery
     ↑                                              ↓
 You add rows                              Images load instantly
```

---

## Step 1: Create Supabase Project (5 min)

1. Go to **https://supabase.com** → Sign in → Click **"New project"**
2. Fill in:
   - **Organization:** Select or create one
   - **Project name:** `adfolio-clone`
   - **Database password:** Enter a strong password (save it!)
   - **Region:** Pick closest to you
3. Click **"Create new project"** → Wait ~2 minutes

---

## Step 2: Run the SQL (2 min)

1. In your Supabase dashboard → Click **"SQL Editor"** in the left sidebar
2. Click **"New query"**
3. Copy the ENTIRE contents of `scripts/supabase-setup.sql` and paste it
4. Click **"Run"** (bottom right)
5. You should see: `Success. No rows returned`

**This creates:**
- `ads` table (stores company name, image URL, category, date)
- `ad-images` storage bucket (stores the actual screenshot PNGs)
- Public read policies (your gallery can read data)

---

## Step 3: Get Your Supabase Keys (2 min)

1. In Supabase dashboard → Click **"Settings"** (gear icon, bottom left) → **"API"**
2. Copy these two values:

| What | Where | What it looks like |
|------|-------|--------------------|
| **Project URL** | Settings > API > Project URL | `https://xxxxxxxx.supabase.co` |
| **Anon Key** | Settings > API > Project API keys > `anon` `public` | `eyJhbGciOiJIUzI1NiIs...` |
| **Service Role Key** | Settings > API > Project API keys > `service_role` | `eyJhbGciOiJIUzI1NiIs...` (keep secret!) |

---

## Step 4: Update index.html (1 min)

Open `index.html` and find these two lines near the bottom:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Replace with your actual values:

```js
const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIs...';
```

---

## Step 5: Set Up Google Sheets Service Account (5 min)

This lets GitHub Actions read your Google Sheet.

1. Go to **https://console.cloud.google.com**
2. Select or create a project
3. Enable the **Google Sheets API**:
   - Click **"APIs & Services"** → **"Library"**
   - Search **"Google Sheets API"** → Click it → Click **"Enable"**
4. Create a service account:
   - Click **"APIs & Services"** → **"Credentials"**
   - Click **"+ Create Credentials"** → **"Service account"**
   - Name: `adfolio-sync`
   - Click **"Done"**
5. Create a key:
   - Click on the service account you just created
   - Go to **"Keys"** tab → **"Add key"** → **"Create new key"**
   - Select **"JSON"** → Click **"Create"**
   - A JSON file downloads — **save it somewhere safe**
6. Share your Google Sheet with the service account email:
   - Open your Google Sheet
   - Click **"Share"**
   - Paste the service account email (from the JSON file, looks like `adfolio-sync@project.iam.gserviceaccount.com`)
   - Set to **"Editor"**
   - Click **"Share"**

---

## Step 6: Add GitHub Secrets (5 min)

1. Go to your GitHub repo → **"Settings"** → **"Secrets and variables"** → **"Actions"**
2. Click **"New repository secret"** for each:

| Name | Value |
|------|-------|
| `SUPABASE_URL` | Your Supabase Project URL (from Step 3) |
| `SUPABASE_KEY` | Your Supabase **service_role** key (from Step 3) |
| `GOOGLE_SHEET_ID` | From your Sheet URL: `https://docs.google.com/spreadsheets/d/`**THIS_PART**`/edit` |
| `GOOGLE_SHEETS_EMAIL` | Service account email from the JSON file |
| `GOOGLE_SHEETS_KEY` | Private key from the JSON file (the `\n` should be literal `\n`) |

**To extract the private key:**
```bash
# Open the JSON file and find the "private_key" field
# It looks like: "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
# Copy everything INSIDE the quotes, including the \n literals
```

---

## Step 7: Install Dependencies & Test Locally (3 min)

```bash
cd "minimal site"
npm install
npx playwright install chromium
```

**Test the sync locally:**
```bash
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_KEY=your-service-role-key \
GOOGLE_SHEET_ID=your-sheet-id \
GOOGLE_SHEETS_EMAIL=your-email@project.iam.gserviceaccount.com \
GOOGLE_SHEETS_KEY="your-private-key" \
node scripts/sync-ads.js
```

You should see:
```
🔄 Starting ad sync...
📋 Reading Google Sheet...
   Found 5 new entries

📸 Processing: Folk
   → Capturing https://www.adfolio.design/...
   → Uploading to Supabase Storage as folk.png
   → Inserting into database...
   → Marking as processed...
   ✅ Done!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Synced: 5 ads
❌ Failed: 0 ads
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Step 8: Push to GitHub & Activate Actions (2 min)

```bash
git add .
git commit -m "feat: adfolio clone with supabase + playwright sync"
git push
```

1. Go to your repo → **"Actions"** tab
2. Click **"Sync Ad Screenshots"** → **"Run workflow"**
3. Wait ~5 minutes for the first run
4. Check **Supabase Dashboard → Storage → ad-images** to see the uploaded screenshots

---

## Step 9: Verify Everything Works

1. **Supabase Storage:** Go to Storage → `ad-images` → You should see PNG files
2. **Supabase Database:** Go to Table Editor → `ads` → You should see rows with company names and image URLs
3. **Your Gallery:** Open your site → Images should load from Supabase

---

## How It Works After Setup

| What | When | How |
|------|------|-----|
| **Add new ads** | Whenever you want | Add rows to your Google Sheet |
| **Screenshots captured** | Every hour (or manual) | GitHub Actions runs Playwright |
| **Images uploaded** | Automatically | Script uploads to Supabase Storage |
| **Gallery updates** | On page refresh | Frontend queries Supabase |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Failed to load" on gallery | Check `SUPABASE_URL` and `SUPABASE_ANON_KEY` in index.html |
| Images show broken | Check Supabase Storage bucket is public |
| GitHub Action fails | Check all 5 secrets are set correctly |
| Google Sheet error | Make sure you shared the sheet with the service account email |
| Playwright timeout | The ad page might be slow — increase timeout in sync-ads.js |

---

## File Structure

```
minimal site/
├── index.html                    # Gallery frontend (queries Supabase)
├── package.json                  # Dependencies
├── scripts/
│   ├── supabase-setup.sql        # Run this in Supabase SQL Editor
│   └── sync-ads.js               # Sync script (Playwright + Supabase)
├── .github/
│   └── workflows/
│       └── sync-ads.yml          # GitHub Actions workflow
├── data/                         # Old CSV cache (can delete)
├── server.js                     # Old local server (can delete)
└── SETUP.md                      # This file
```

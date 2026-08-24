/**
 * sync-ads.js
 * 
 * Reads rows from public Google Sheet CSV, screenshots each ad with Playwright,
 * uploads to Supabase Storage, inserts into Supabase Database.
 * 
 * Handles Vercel bot protection by waiting for challenge page to resolve.
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// Config
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const BUCKET_NAME = 'ad-images';
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_HEIGHT = 900;

// ============================================================
// Read Google Sheet via public CSV export
// ============================================================

async function readSheet() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
  console.log(`   Fetching: ${csvUrl}`);

  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Failed to fetch sheet: HTTP ${res.status}`);

  const text = await res.text();

  if (/^\s*<(?:!doctype|html)/i.test(text)) {
    throw new Error('Got HTML instead of CSV. Make sure your Google Sheet is set to "Anyone with the link can view".');
  }

  // Parse CSV
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0].trim()) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim()) rows.push(row);

  return rows;
}

function parseSheetRows(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());

  const nameIdx = header.findIndex(h => h.includes('company'));
  const urlIdx = header.findIndex(h => h.includes('image') || h.includes('url'));
  const dateIdx = header.findIndex(h => h.includes('date'));

  return rows.slice(1).map((row, i) => ({
    rowIndex: i + 2,
    companyName: (row[nameIdx] || '').trim(),
    imageUrl: (row[urlIdx] || '').trim(),
    date: (row[dateIdx] || '').trim(),
  })).filter(r => r.companyName && r.imageUrl);
}

// ============================================================
// Check if ad already exists in Supabase
// ============================================================

async function adExists(supabase, companyName) {
  const { data } = await supabase
    .from('ads')
    .select('id')
    .eq('company_name', companyName)
    .limit(1);

  return data && data.length > 0;
}

// ============================================================
// Capture image using Playwright
// Handles Vercel challenge pages and direct image URLs
// ============================================================

async function captureAd(url) {
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });

    // Remove webdriver detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();

    // Navigate with generous timeout
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Wait for Vercel challenge to resolve (if any)
    // The challenge page runs JS that redirects to the actual content
    let attempts = 0;
    while (attempts < 10) {
      const title = await page.title();
      const contentUrl = page.url();

      // If we're still on a challenge page, wait
      if (title.includes('Just a moment') || title.includes('Challenge')) {
        await page.waitForTimeout(2000);
        attempts++;
        continue;
      }

      // Check if we got the actual image
      const contentType = await page.evaluate(() => {
        return document.contentType || '';
      });

      if (contentType.startsWith('image/')) {
        // Direct image — screenshot it
        const screenshot = await page.screenshot({ type: 'png' });
        return screenshot;
      }

      // Check if there's an img tag we can extract
      const imgBuffer = await page.evaluate(async () => {
        const img = document.querySelector('img');
        if (!img) return null;

        // Wait for image to load
        if (!img.complete) {
          await new Promise(resolve => {
            img.onload = resolve;
            img.onerror = resolve;
            setTimeout(resolve, 5000);
          });
        }

        // Draw to canvas and get blob
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return null;
        const arrayBuffer = await blob.arrayBuffer();
        return Array.from(new Uint8Array(arrayBuffer));
      });

      if (imgBuffer) {
        return Buffer.from(imgBuffer);
      }

      break;
    }

    // Last resort: screenshot whatever is on the page
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    return screenshot;

  } finally {
    await browser.close();
  }
}

// ============================================================
// Upload to Supabase Storage
// ============================================================

async function uploadToStorage(supabase, filename, buffer) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(filename, buffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(filename);

  return urlData.publicUrl;
}

// ============================================================
// Insert into Supabase Database
// ============================================================

async function insertAd(supabase, ad) {
  const { error } = await supabase
    .from('ads')
    .insert({
      company_name: ad.companyName,
      image_url: ad.imageUrl,
      original_ad_url: ad.originalAdUrl,
      category: 'B2B SaaS',
      processed: true,
    });

  if (error) throw error;
}

// ============================================================
// Generate slug from company name
// ============================================================

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================
// Main sync function
// ============================================================

async function sync() {
  console.log('🔄 Starting ad sync...\n');

  // Validate env vars
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY');
    process.exit(1);
  }

  if (!SHEET_ID) {
    console.error('❌ Missing GOOGLE_SHEET_ID');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Read sheet
  console.log('📋 Reading Google Sheet...');
  const rows = await readSheet();
  const entries = parseSheetRows(rows);
  console.log(`   Found ${entries.length} entries in sheet\n`);

  if (entries.length === 0) {
    console.log('✅ Sheet is empty. Nothing to sync!');
    return;
  }

  let success = 0;
  let skipped = 0;
  let failed = 0;

  // 2. Process each entry
  for (const entry of entries) {
    console.log(`📸 Processing: ${entry.companyName}`);

    try {
      // Check if already exists
      const exists = await adExists(supabase, entry.companyName);
      if (exists) {
        console.log(`   ⏭ Already exists — skipping\n`);
        skipped++;
        continue;
      }

      // Capture
      console.log(`   → Capturing ${entry.imageUrl}...`);
      const screenshot = await captureAd(entry.imageUrl);

      // Upload to Supabase Storage
      const filename = `${slugify(entry.companyName)}.png`;
      console.log(`   → Uploading to Supabase Storage as ${filename}...`);
      const publicUrl = await uploadToStorage(supabase, filename, screenshot);

      // Insert into database
      console.log(`   → Inserting into database...`);
      await insertAd(supabase, {
        companyName: entry.companyName,
        imageUrl: publicUrl,
        originalAdUrl: entry.imageUrl,
      });

      console.log(`   ✅ Done!\n`);
      success++;
    } catch (e) {
      console.error(`   ❌ Failed: ${e.message}\n`);
      failed++;
    }
  }

  // Summary
  console.log('━'.repeat(40));
  console.log(`✅ Synced: ${success} new ads`);
  console.log(`⏭ Skipped: ${skipped} (already exist)`);
  console.log(`❌ Failed: ${failed}`);
  console.log('━'.repeat(40));
}

// ============================================================
// Run
// ============================================================

sync().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

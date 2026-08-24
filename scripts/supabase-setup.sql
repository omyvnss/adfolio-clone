-- ============================================================
-- SUPABASE SETUP — Run this in Supabase SQL Editor
-- ============================================================
-- Go to: https://supabase.com/dashboard → Your Project → SQL Editor
-- Paste this entire file → Click "Run"
-- ============================================================

-- 1. Create the ads table
CREATE TABLE IF NOT EXISTS ads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  original_ad_url TEXT,
  category TEXT DEFAULT 'B2B SaaS',
  processed BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;

-- 3. Allow public read access (your gallery needs to read)
CREATE POLICY "Public read access" ON ads
  FOR SELECT USING (true);

-- 4. Allow service role full access (your sync script needs to write)
CREATE POLICY "Service role full access" ON ads
  FOR ALL USING (auth.role() = 'service_role');

-- 5. Create storage bucket for ad images
INSERT INTO storage.buckets (id, name, public)
VALUES ('ad-images', 'ad-images', true)
ON CONFLICT (id) DO NOTHING;

-- 6. Allow public read access to storage
CREATE POLICY "Public read access" ON storage.objects
  FOR SELECT USING (bucket_id = 'ad-images');

-- 7. Allow service role upload access
CREATE POLICY "Service role upload access" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'ad-images' AND auth.role() = 'service_role');

-- 8. Allow service role delete access
CREATE POLICY "Service role delete access" ON storage.objects
  FOR DELETE USING (bucket_id = 'ad-images' AND auth.role() = 'service_role');

-- ============================================================
-- DONE! Your Supabase is ready.
-- ============================================================
-- Next: Go to Settings > API and copy:
--   1. Project URL (looks like: https://xxxx.supabase.co)
--   2. service_role key (under "Service roles" section)
-- ============================================================

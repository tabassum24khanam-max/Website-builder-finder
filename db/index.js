const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || '.';
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'leadhunter.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS searches (
    id         TEXT PRIMARY KEY,
    category   TEXT NOT NULL,
    location   TEXT NOT NULL,
    country    TEXT NOT NULL DEFAULT '',
    radius_km  INTEGER DEFAULT 10,
    limit_count INTEGER DEFAULT 20,
    status     TEXT DEFAULT 'running',
    leads_found INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS leads (
    id                       TEXT PRIMARY KEY,
    search_id                TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    name                     TEXT NOT NULL,
    category                 TEXT,
    city                     TEXT,
    address                  TEXT,
    phone                    TEXT,
    website                  TEXT,
    website_status           TEXT,
    rating                   REAL,
    review_count             INTEGER DEFAULT 0,
    instagram_handle         TEXT,
    instagram_followers      INTEGER,
    instagram_posts          INTEGER,
    instagram_posts_per_month REAL,
    instagram_last_post      TEXT,
    instagram_bio            TEXT,
    instagram_url            TEXT,
    linkedin_company_url     TEXT,
    linkedin_owner_name      TEXT,
    linkedin_owner_url       TEXT,
    email                    TEXT,
    owner_email              TEXT,
    ai_score                 INTEGER DEFAULT 0,
    marketing_score          INTEGER DEFAULT 0,
    ai_reasoning             TEXT,
    outreach_message         TEXT,
    maps_url                 TEXT,
    status                   TEXT DEFAULT 'new',
    notes                    TEXT,
    scraped_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_leads_search ON leads(search_id);
  CREATE INDEX IF NOT EXISTS idx_leads_score  ON leads(ai_score DESC);
`);

const q = {
  insertSearch: db.prepare(`
    INSERT INTO searches (id, category, location, country, radius_km, limit_count)
    VALUES (@id, @category, @location, @country, @radius_km, @limit_count)
  `),
  updateSearchStatus: db.prepare(`
    UPDATE searches
    SET status = @status, leads_found = @leads_found, completed_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `),
  getSearch:     db.prepare('SELECT * FROM searches WHERE id = ?'),
  listSearches:  db.prepare('SELECT * FROM searches ORDER BY created_at DESC'),
  deleteSearch:  db.prepare('DELETE FROM searches WHERE id = ?'),

  insertLead: db.prepare(`
    INSERT INTO leads (
      id, search_id, name, category, city, address, phone, website, website_status,
      rating, review_count, instagram_handle, instagram_followers, instagram_posts,
      instagram_posts_per_month, instagram_last_post, instagram_bio, instagram_url,
      linkedin_company_url, linkedin_owner_name, linkedin_owner_url,
      email, owner_email, ai_score, marketing_score, ai_reasoning, outreach_message, maps_url
    ) VALUES (
      @id, @search_id, @name, @category, @city, @address, @phone, @website, @website_status,
      @rating, @review_count, @instagram_handle, @instagram_followers, @instagram_posts,
      @instagram_posts_per_month, @instagram_last_post, @instagram_bio, @instagram_url,
      @linkedin_company_url, @linkedin_owner_name, @linkedin_owner_url,
      @email, @owner_email, @ai_score, @marketing_score, @ai_reasoning, @outreach_message, @maps_url
    )
  `),
  updateLead: db.prepare(`
    UPDATE leads SET status = @status, notes = @notes, outreach_message = @outreach_message,
    updated_at = CURRENT_TIMESTAMP WHERE id = @id
  `),
  getLead:          db.prepare('SELECT * FROM leads WHERE id = ?'),
  getLeadsBySearch: db.prepare('SELECT * FROM leads WHERE search_id = ? ORDER BY ai_score DESC'),
  deleteLead:       db.prepare('DELETE FROM leads WHERE id = ?'),

  stats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN website_status = 'none' OR website IS NULL OR website = '' THEN 1 ELSE 0 END) as no_website,
      SUM(CASE WHEN ai_score >= 7 THEN 1 ELSE 0 END) as high_score,
      SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as has_email,
      SUM(CASE WHEN instagram_handle IS NOT NULL THEN 1 ELSE 0 END) as has_instagram,
      SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
      SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted
    FROM leads
  `),
};

module.exports = { db, q };

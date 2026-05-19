// Main agent orchestrator
// Discovery: GPT-4o drives Google Maps (primary) → OSM Overpass fallback
// Enrichment: Playwright → Instagram, LinkedIn, email → GPT-4o scorer
const { chromium } = require('playwright');
const { findBusinessesGoogleMapsAI } = require('./maps-ai');
const { findBusinessesOSM } = require('./osm');
const { analyzeWebsite } = require('./website');
const { findAndAnalyzeInstagram } = require('./instagram');
const { findLinkedIn } = require('./linkedin');
const { findEmail } = require('./email');
const { scoreLead } = require('./scorer');
const { q } = require('../db');
const { v4: uuid } = require('uuid');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const HEADLESS = String(process.env.HEADLESS || '').toLowerCase() === 'true';

// Active searches — searchId → { stop: fn }
const activeSearches = new Map();

function stopSearch(searchId) {
  const entry = activeSearches.get(searchId);
  if (entry) entry.stopped = true;
}

async function runSearch(searchConfig, broadcast) {
  const { id: searchId, category, location, country, radius_km, limit_count, lat, lng, no_website_only } = searchConfig;

  let stopped = false;
  activeSearches.set(searchId, { get stopped() { return stopped; }, set stopped(v) { stopped = v; } });

  const log = (msg, level = 'info') => broadcast({ type: 'agent_log', searchId, level, message: msg });
  const shouldStop = () => stopped;

  log(`🚀 Starting agent search: "${category}" in ${location}${country ? ', ' + country : ''}`, 'success');

  let browser;
  let leadsFound = 0;

  try {
    // Step 1 — AI-powered Google Maps discovery (GPT-4o drives a real browser)
    let businesses = [];
    try {
      businesses = await findBusinessesGoogleMapsAI({
        category, location, country,
        lat: lat || null, lng: lng || null,
        radius_km: radius_km || 5,
        limit: limit_count || 20,
        log,
      });
    } catch (e) {
      log(`⚠️  AI Google Maps discovery failed: ${e.message}`, 'warn');
    }

    // Step 1b — fallback to OpenStreetMap if AI returned nothing
    if (!businesses.length) {
      log(`⚠️  Google Maps AI returned no results. Falling back to OpenStreetMap...`, 'warn');
      try {
        businesses = await findBusinessesOSM({
          category, location, country,
          lat: lat || null, lng: lng || null,
          radius_km: radius_km || 5,
          limit: limit_count || 30,
          noWebsiteOnly: no_website_only !== false,
          log,
        });
      } catch (e) {
        log(`⚠️  OpenStreetMap also failed: ${e.message}`, 'warn');
      }
    }

    if (!businesses.length) {
      log('❌  No businesses found. Try a wider radius or different category.', 'error');
      q.updateSearchStatus.run({ id: searchId, status: 'done', leads_found: 0 });
      broadcast({ type: 'search_complete', searchId, total: 0 });
      return;
    }

    log(`📋 Discovered ${businesses.length} businesses. Starting enrichment...`, 'success');

    // Set up browser for enrichment (Instagram, LinkedIn, email)
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    const toolPage = await context.newPage();

    // Step 2 — analyze each business
    for (const biz of businesses) {
      if (shouldStop()) {
        log('■ Search stopped by user.', 'warn');
        break;
      }

      log(`\n🔎 Analyzing: ${biz.name}`, 'info');
      broadcast({ type: 'agent_step', searchId, step: 'analyzing', businessName: biz.name });

      try {
        const lead = await analyzeBusiness(biz, toolPage, { searchId, location, country }, log, shouldStop);
        if (!lead) continue;

        // Save to DB
        const leadId = uuid();
        q.insertLead.run({
          id: leadId,
          search_id: searchId,
          name: lead.name,
          category: lead.category || category,
          city: location,
          address: lead.address || null,
          phone: lead.phone || null,
          website: lead.website || null,
          website_status: lead.websiteStatus || 'none',
          rating: lead.rating || null,
          review_count: lead.reviewCount || 0,
          instagram_handle: lead.instagramHandle || null,
          instagram_followers: lead.instagramFollowers || null,
          instagram_posts: lead.instagramPosts || null,
          instagram_posts_per_month: lead.instagramPostsPerMonth || null,
          instagram_last_post: lead.instagramLastPost || null,
          instagram_bio: lead.instagramBio || null,
          instagram_url: lead.instagramUrl || null,
          linkedin_company_url: lead.linkedinCompanyUrl || null,
          linkedin_owner_name: lead.ownerName || null,
          linkedin_owner_url: lead.ownerLinkedinUrl || null,
          email: lead.email || null,
          owner_email: null,
          ai_score: lead.aiScore || 0,
          marketing_score: lead.marketingScore || 0,
          ai_reasoning: lead.aiReasoning || null,
          outreach_message: lead.outreachMessage || null,
          maps_url: lead.mapsUrl || null,
          lat: lead.lat || null,
          lng: lead.lng || null,
        });

        leadsFound++;
        log(`🏆 Score ${lead.aiScore}/10 — ${lead.name} saved`, lead.aiScore >= 7 ? 'success' : 'info');
        broadcast({ type: 'lead_found', searchId, lead: { id: leadId, ...lead, searchId } });

      } catch (err) {
        log(`⚠️  Skipped ${biz.name}: ${err.message}`, 'warn');
      }

      // Polite delay between businesses
      if (!shouldStop()) await delay(DELAY);
    }

    q.updateSearchStatus.run({ id: searchId, status: stopped ? 'stopped' : 'done', leads_found: leadsFound });
    log(`\n✅ Search complete — ${leadsFound} leads saved`, 'success');
    broadcast({ type: 'search_complete', searchId, total: leadsFound });

  } catch (err) {
    log(`❌ Fatal error: ${err.message}`, 'error');
    q.updateSearchStatus.run({ id: searchId, status: 'error', leads_found: leadsFound });
    broadcast({ type: 'search_error', searchId, error: err.message });
  } finally {
    activeSearches.delete(searchId);
    if (browser) await browser.close().catch(() => {});
  }
}

async function analyzeBusiness(biz, page, { searchId, location, country }, log, shouldStop) {
  // Website analysis
  let websiteStatus = 'none';
  let websiteSummary = '';
  if (biz.website) {
    const ws = await analyzeWebsite(biz.website, biz.name, log);
    websiteStatus = ws.status;
    websiteSummary = ws.summary;
    log(`🌐 Website: ${websiteStatus} — ${websiteSummary}`);
  } else {
    log(`🚫 No website listed`);
  }

  if (shouldStop()) return null;

  // Instagram
  const ig = await findAndAnalyzeInstagram(page, {
    name: biz.name, city: location, country, websiteUrl: biz.website,
  }, log);

  if (ig.handle) {
    const freq = ig.postsPerMonth ? `${ig.postsPerMonth} posts/month` : 'post frequency unknown';
    log(`📸 @${ig.handle} — ${ig.followers?.toLocaleString() || '?'} followers, ${freq}`);
  } else {
    log(`📸 No Instagram found`);
  }

  if (shouldStop()) return null;

  // LinkedIn
  const li = await findLinkedIn(page, { name: biz.name, city: location, country }, log);

  if (shouldStop()) return null;

  // Email
  log(`📬 Looking for email...`);
  const email = await findEmail({
    name: biz.name, city: location, country,
    website: biz.website,
    instagramBio: ig.bio,
  }, log);
  if (!email) log(`📬 Email not found`);

  if (shouldStop()) return null;

  // Score
  log(`🤖 Scoring lead...`);
  const score = await scoreLead({
    name: biz.name,
    category: biz.category,
    city: location,
    country,
    address: biz.address,
    phone: biz.phone,
    website: biz.website,
    websiteStatus,
    rating: biz.rating,
    reviewCount: biz.reviewCount,
    instagramHandle: ig.handle,
    instagramFollowers: ig.followers,
    instagramPostsPerMonth: ig.postsPerMonth,
    instagramLastPost: ig.lastPost,
    linkedinCompanyUrl: li.companyUrl,
    ownerName: li.ownerName,
    email,
  });

  return {
    name: biz.name,
    category: biz.category,
    address: biz.address,
    phone: biz.phone,
    website: biz.website,
    websiteStatus,
    websiteSummary,
    rating: biz.rating,
    reviewCount: biz.reviewCount,
    instagramHandle: ig.handle,
    instagramFollowers: ig.followers,
    instagramPosts: ig.posts,
    instagramPostsPerMonth: ig.postsPerMonth,
    instagramLastPost: ig.lastPost,
    instagramBio: ig.bio,
    instagramUrl: ig.url,
    linkedinCompanyUrl: li.companyUrl,
    ownerName: li.ownerName,
    ownerLinkedinUrl: li.ownerUrl,
    email,
    aiScore: score.aiScore,
    marketingScore: score.marketingScore,
    aiReasoning: score.aiReasoning,
    outreachMessage: score.outreachMessage,
    mapsUrl: biz.mapsUrl,
    lat: biz.lat,
    lng: biz.lng,
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runSearch, stopSearch };

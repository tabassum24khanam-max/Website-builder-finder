// Main agent orchestrator
// Discovery: Serper /places (primary) → Google Places API → OpenStreetMap fallback
// Enrichment: HTTP only — no Playwright browser needed

const { findBusinessesSerper } = require('./serper-places');
const { findBusinessesPlaces } = require('./places-api');
const { findBusinessesOSM } = require('./osm');
const { analyzeWebsite, findOwnerPhone } = require('./website');
const { findAndAnalyzeInstagram } = require('./instagram');
const { findLinkedIn } = require('./linkedin');
const { findEmail } = require('./email');
const { scoreLead } = require('./scorer');
const { q } = require('../db');
const { v4: uuid } = require('uuid');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1000');

// Active searches — searchId → { stopped }
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

  log(`🚀 Starting search: "${category}" in ${location}${country ? ', ' + country : ''}`, 'success');

  let leadsFound = 0;

  try {
    // Step 1 — Serper /places (Google Maps results via API — phone, address, coords included)
    let businesses = [];

    try {
      businesses = await findBusinessesSerper({
        category, location, country,
        radius_km: radius_km || 5,
        limit: limit_count || 20,
        log,
      });
    } catch (e) {
      log(`⚠️  Serper Places failed: ${e.message}`, 'warn');
    }

    // Step 1b — Google Places API if Serper returned nothing and key is set
    if (!businesses.length && process.env.GOOGLE_PLACES_API_KEY) {
      log(`⚠️  Trying Google Places API...`, 'warn');
      try {
        businesses = await findBusinessesPlaces({
          category, location, country,
          lat: lat || null, lng: lng || null,
          radius_km: radius_km || 5,
          limit: limit_count || 20,
          log,
        });
      } catch (e) {
        log(`⚠️  Google Places API failed: ${e.message}`, 'warn');
      }
    }

    // Step 1c — OpenStreetMap last resort
    if (!businesses.length) {
      log(`⚠️  Falling back to OpenStreetMap...`, 'warn');
      try {
        businesses = await findBusinessesOSM({
          category, location, country,
          lat: lat || null, lng: lng || null,
          radius_km: radius_km || 5,
          limit: limit_count || 30,
          noWebsiteOnly: false,
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

    log(`📋 Found ${businesses.length} businesses. Starting enrichment...`, 'success');

    // Step 2 — enrich each business (all HTTP, no browser)
    for (const biz of businesses) {
      if (shouldStop()) { log('■ Search stopped by user.', 'warn'); break; }

      log(`\n🔎 Analyzing: ${biz.name}`, 'info');
      broadcast({ type: 'agent_step', searchId, step: 'analyzing', businessName: biz.name });

      try {
        const lead = await analyzeBusiness(biz, { searchId, location, country }, log, shouldStop);
        if (!lead) continue;

        if (no_website_only && lead.websiteStatus === 'good') {
          log(`⏭️  Skipping ${lead.name} — has a working website`, 'info');
          continue;
        }

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
          owner_phone: lead.ownerPhone || null,
          ai_score: lead.aiScore || 0,
          marketing_score: lead.marketingScore || 0,
          ai_reasoning: lead.aiReasoning || null,
          outreach_message: lead.outreachMessage || null,
          maps_url: lead.mapsUrl || null,
          lat: lead.lat || null,
          lng: lead.lng || null,
          photo_url: lead.photoUrl || null,
        });

        leadsFound++;
        log(`🏆 Score ${lead.aiScore}/10 — ${lead.name} saved`, lead.aiScore >= 7 ? 'success' : 'info');
        broadcast({ type: 'lead_found', searchId, lead: { id: leadId, ...lead, searchId } });

      } catch (err) {
        log(`⚠️  Skipped ${biz.name}: ${err.message}`, 'warn');
      }

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
  }
}

async function analyzeBusiness(biz, { location, country }, log, shouldStop) {
  // Website
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

  // Instagram (HTTP only, no browser)
  const ig = await findAndAnalyzeInstagram(null, {
    name: biz.name, city: location, country, websiteUrl: biz.website,
  }, log);

  if (ig.handle) {
    log(`📸 @${ig.handle} — ${ig.followers?.toLocaleString() || '?'} followers`);
  } else {
    log(`📸 No Instagram found`);
  }

  if (shouldStop()) return null;

  // LinkedIn (HTTP only, no browser)
  const li = await findLinkedIn(null, { name: biz.name, city: location, country }, log);

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

  // Owner phone from website contact pages
  let ownerPhone = null;
  if (biz.website && websiteStatus !== 'none') {
    log(`📞 Looking for owner/manager phone...`);
    try { ownerPhone = await findOwnerPhone(biz.website, log); } catch (_) {}
    if (!ownerPhone) log(`📞 Owner phone not found`);
  }

  if (shouldStop()) return null;

  // AI score
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
    ownerPhone,
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
    ownerPhone,
    aiScore: score.aiScore,
    marketingScore: score.marketingScore,
    aiReasoning: score.aiReasoning,
    outreachMessage: score.outreachMessage,
    mapsUrl: biz.mapsUrl,
    lat: biz.lat,
    lng: biz.lng,
    photoUrl: biz.photoUrl || null,
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runSearch, stopSearch };

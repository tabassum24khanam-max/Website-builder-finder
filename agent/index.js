// Main agent orchestrator.
//
// Per business (strict order, every step hard-timeout-bounded so it can never
// hang — one business takes seconds, not minutes):
//   1. /places discovery  → name, coords, rating, reviews
//   2. enrich (1 /search)  → website, phone, address, Instagram hint
//   3. website analyze     → good/basic/outdated/menu_only/social/linktree/none
//   4. instagram           → verified handle + followers + bio (phone/email from bio)
//   5. linkedin            → company + owner (verified match only)
//   6. email               → IG bio / website / Hunter
//   7. phone cascade + AI score + save (skip chains & zero-contact leads)

const { findBusinessesSerper, enrichBusiness } = require('./serper-places');
const { findBusinessesPlaces } = require('./places-api');
const { findBusinessesOSM } = require('./osm');
const { analyzeWebsite, findOwnerPhone } = require('./website');
const { findInstagram } = require('./instagram');
const { findLinkedIn } = require('./linkedin');
const { findEmail } = require('./email');
const { scoreLead } = require('./scorer');
const { withTimeout, delay } = require('./util');
const { q } = require('../db');
const { v4: uuid } = require('uuid');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '300', 10);
const BUSINESS_BUDGET_MS = 50000; // hard cap per business — guarantees forward progress

const activeSearches = new Map();
function stopSearch(searchId) {
  const s = activeSearches.get(searchId);
  if (s) s.stopped = true;
}

async function runSearch(searchConfig, broadcast) {
  const { id: searchId, category, location, country, radius_km, limit_count, lat, lng, no_website_only, neighborhood, zip, city } = searchConfig;
  const cityLabel = city || location; // display/enrichment city
  const targetCount = limit_count || 20;

  const state = { stopped: false };
  activeSearches.set(searchId, state);
  const shouldStop = () => state.stopped;
  const log = (msg, level = 'info') => broadcast({ type: 'agent_log', searchId, level, message: msg });

  log(`🚀 Starting search: "${category}" in ${location}${country ? ', ' + country : ''}`, 'success');
  let leadsFound = 0;

  try {
    const businesses = await discover({ category, city: cityLabel, neighborhood, zip, country, lat, lng, radius_km, limit_count, log });
    if (!businesses.length) {
      log('❌  No businesses found. Try a different category or location.', 'error');
      q.updateSearchStatus.run({ id: searchId, status: 'done', leads_found: 0 });
      broadcast({ type: 'search_complete', searchId, total: 0 });
      return;
    }

    log(`📋 Found ${businesses.length} businesses. Starting enrichment...`, 'success');

    for (const biz of businesses) {
      if (shouldStop()) { log('■ Search stopped by user.', 'warn'); break; }

      log(`\n🔎 Analyzing: ${biz.name}`, 'info');
      broadcast({ type: 'agent_step', searchId, step: 'analyzing', businessName: biz.name });

      // Overall hard cap per business — if anything drags, we move on.
      const lead = await withTimeout(processBusiness(biz, { location: cityLabel, country, category, no_website_only }, log, shouldStop), BUSINESS_BUDGET_MS, null);

      if (!lead) { log(`⏭️  Skipped ${biz.name} (timed out or no data)`, 'warn'); continue; }
      if (lead.skip) { log(`⏭️  Skipping ${biz.name} — ${lead.reason}`, 'info'); continue; }

      const leadId = uuid();
      q.insertLead.run(toRow(leadId, searchId, cityLabel, category, lead));
      leadsFound++;
      log(`🏆 Score ${lead.aiScore}/10 — ${lead.name} saved`, lead.aiScore >= 7 ? 'success' : 'info');
      broadcast({ type: 'lead_found', searchId, lead: { id: leadId, ...lead, searchId } });

      // Honor the requested count — stop once we've saved that many leads.
      if (leadsFound >= targetCount) { log(`🎯 Reached target of ${targetCount} leads.`, 'success'); break; }
      if (!shouldStop()) await delay(DELAY);
    }

    q.updateSearchStatus.run({ id: searchId, status: state.stopped ? 'stopped' : 'done', leads_found: leadsFound });
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

// ── Discovery with fallbacks ─────────────────────────────────────────────────

async function discover({ category, city, neighborhood, zip, country, lat, lng, radius_km, limit_count, log }) {
  const tag = b => b.map(x => ({ ...x, instagramHint: x.instagramHint || null, searchedCategory: x.searchedCategory || category }));

  // 1. Serper /places (primary) — neighborhood in `q`, ll pin + distance filter
  try {
    const b = await findBusinessesSerper({ category, city, neighborhood, zip, country, lat, lng, radiusKm: radius_km || 10, limit: limit_count || 20, log });
    if (b.length) return tag(b);
  } catch (e) { log(`⚠️  Serper Places failed: ${e.message}`, 'warn'); }

  // 2. Google Places API (only if a key is configured)
  if (process.env.GOOGLE_PLACES_API_KEY) {
    log('⚠️  Trying Google Places API...', 'warn');
    try {
      const b = await findBusinessesPlaces({ category, location: city, country, lat: lat || null, lng: lng || null, radius_km: radius_km || 5, limit: limit_count || 20, log });
      if (b.length) return tag(b);
    } catch (e) { log(`⚠️  Google Places API failed: ${e.message}`, 'warn'); }
  }

  // 3. OpenStreetMap (last resort)
  log('⚠️  Falling back to OpenStreetMap...', 'warn');
  try {
    const loc = [neighborhood, city].filter(Boolean).join(', ') || zip || city;
    const b = await findBusinessesOSM({ category, location: loc, country, lat: lat || null, lng: lng || null, radius_km: radius_km || 5, limit: limit_count || 30, noWebsiteOnly: false, log });
    if (b.length) return tag(b);
  } catch (e) { log(`⚠️  OpenStreetMap also failed: ${e.message}`, 'warn'); }

  return [];
}

// ── Per-business pipeline ────────────────────────────────────────────────────

async function processBusiness(biz, { location, country, category, no_website_only }, log, shouldStop) {
  // Step 2 — enrich (website / phone / address / IG) via one /search
  await withTimeout(enrichBusiness(biz, location, country, log), 14000, biz);
  if (shouldStop()) return null;

  // Step 3 — website classification
  let websiteStatus = 'none', websiteSummary = '';
  if (biz.website) {
    const ws = await withTimeout(analyzeWebsite(biz.website, biz.name, log), 24000, { status: 'basic', summary: 'Analysis timed out.' });
    websiteStatus = ws.status; websiteSummary = ws.summary;
    log(`🌐 Website: ${websiteStatus} — ${websiteSummary}`);
  } else {
    log('🚫 No website found');
  }
  // Filter: only a genuinely GOOD site disqualifies a lead. A weak presence
  // (none/social/linktree/menu/outdated/basic) is exactly who we want.
  if (no_website_only && websiteStatus === 'good') {
    return { skip: true, reason: `has a good website (${biz.website})` };
  }
  if (shouldStop()) return null;

  // Step 3b — owner/manager phone from the website contact page
  let ownerPhone = null;
  if (biz.website && !['none', 'social_only', 'linktree'].includes(websiteStatus)) {
    ownerPhone = await withTimeout(findOwnerPhone(biz.website, log), 14000, null);
  }
  if (shouldStop()) return null;

  // Step 4 — Instagram (uses the hint from enrichment; targeted search only if needed)
  const ig = await withTimeout(
    findInstagram({ name: biz.name, city: location, country, websiteUrl: biz.website, hint: biz.instagramHint }, log),
    14000, { handle: null });
  if (ig.handle) log(`📸 @${ig.handle} — ${ig.followers?.toLocaleString() || '?'} followers`);
  if (shouldStop()) return null;

  // Step 5 — LinkedIn (verified match only; usually empty for small businesses)
  const li = await withTimeout(findLinkedIn({ name: biz.name, city: location, country }, log), 16000, { companyUrl: null });
  if (shouldStop()) return null;

  // Step 6 — Email
  log('📬 Looking for email...');
  const email = await withTimeout(
    findEmail({ name: biz.name, city: location, country, website: biz.website, instagramBio: ig.bio }, log),
    14000, null) || ig.emailFromBio || null;

  // Phone cascade: business phone → IG bio phone → website contact phone
  const phone = biz.phone || ig.phoneFromBio || ownerPhone || null;
  if (shouldStop()) return null;

  // Step 7 — Score
  log('🤖 Scoring lead...');
  const score = await withTimeout(scoreLead({
    name: biz.name, category: biz.category, searchedCategory: biz.searchedCategory || category, city: location, country, address: biz.address,
    phone, website: biz.website, websiteStatus, rating: biz.rating, reviewCount: biz.reviewCount,
    instagramHandle: ig.handle, instagramFollowers: ig.followers,
    linkedinCompanyUrl: li.companyUrl, ownerName: li.ownerName, email,
  }), 24000, { isIndependent: true, categoryMatch: true, aiScore: biz.website ? 4 : 6, marketingScore: ig.handle ? 5 : 2, aiReasoning: 'Scored without AI (timeout).', outreachMessage: null });

  // Drop chains/franchises flagged by the AI (catches brands not on the denylist).
  if (score.isIndependent === false) {
    return { skip: true, reason: 'AI flagged it as a chain/franchise (not independent)' };
  }

  // Drop businesses that aren't actually the searched category (e.g. a burger
  // joint surfacing in a "cafes" search).
  if (score.categoryMatch === false) {
    return { skip: true, reason: `not a ${biz.searchedCategory || category} (AI category mismatch)` };
  }

  // Drop leads we cannot contact at all — a lead with no contact is worthless.
  if (!(phone || email || ig.handle || li.companyUrl || biz.website || ownerPhone)) {
    return { skip: true, reason: 'no contact info found anywhere' };
  }

  return {
    name: biz.name, category: biz.category, address: biz.address, phone,
    website: biz.website, websiteStatus, websiteSummary,
    rating: biz.rating, reviewCount: biz.reviewCount,
    instagramHandle: ig.handle, instagramFollowers: ig.followers, instagramPosts: ig.posts,
    instagramPostsPerMonth: ig.postsPerMonth, instagramLastPost: ig.lastPost,
    instagramBio: ig.bio, instagramUrl: ig.url,
    linkedinCompanyUrl: li.companyUrl, ownerName: li.ownerName, ownerLinkedinUrl: li.ownerUrl,
    email, ownerPhone,
    aiScore: score.aiScore, marketingScore: score.marketingScore,
    aiReasoning: score.aiReasoning, outreachMessage: score.outreachMessage,
    mapsUrl: biz.mapsUrl, lat: biz.lat, lng: biz.lng, photoUrl: biz.photoUrl || null,
  };
}

// Map a finished lead onto the DB insert parameters.
function toRow(id, searchId, city, category, lead) {
  return {
    id, search_id: searchId, name: lead.name, category: lead.category || category, city,
    address: lead.address || null, phone: lead.phone || null, website: lead.website || null,
    website_status: lead.websiteStatus || 'none', rating: lead.rating || null, review_count: lead.reviewCount || 0,
    instagram_handle: lead.instagramHandle || null, instagram_followers: lead.instagramFollowers || null,
    instagram_posts: lead.instagramPosts || null, instagram_posts_per_month: lead.instagramPostsPerMonth || null,
    instagram_last_post: lead.instagramLastPost || null, instagram_bio: lead.instagramBio || null,
    instagram_url: lead.instagramUrl || null, linkedin_company_url: lead.linkedinCompanyUrl || null,
    linkedin_owner_name: lead.ownerName || null, linkedin_owner_url: lead.ownerLinkedinUrl || null,
    email: lead.email || null, owner_email: null, owner_phone: lead.ownerPhone || null,
    ai_score: lead.aiScore || 0, marketing_score: lead.marketingScore || 0,
    ai_reasoning: lead.aiReasoning || null, outreach_message: lead.outreachMessage || null,
    maps_url: lead.mapsUrl || null, lat: lead.lat || null, lng: lead.lng || null, photo_url: lead.photoUrl || null,
  };
}

module.exports = { runSearch, stopSearch };

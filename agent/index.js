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

const { findBusinessesSerper, enrichBusiness, backfillWebsitePhone } = require('./serper-places');
const { findBusinessesPlaces } = require('./places-api');
const { findBusinessesOSM } = require('./osm');
const { findInstagram } = require('./instagram');
const { findPhone: phoneAgentFind } = require('./phone-agent');
const { withTimeout, delay, getCountryCode, isTollFreeNumber } = require('./util');
const { q } = require('../db');
const { v4: uuid } = require('uuid');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '300', 10);
const BUSINESS_BUDGET_MS = 60000; // 1-minute hard cap per business

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

  // 1. Google Places API (PRIMARY when a key is set) — returns the authoritative
  //    phone + website straight from Google Maps (the data you see in the app),
  //    which Serper does not expose. This is what makes the numbers correct.
  if (process.env.GOOGLE_PLACES_API_KEY) {
    try {
      const b = await findBusinessesPlaces({ category, city, neighborhood, zip, country, lat: lat || null, lng: lng || null, radius_km: radius_km || 5, limit: limit_count || 20, log });
      if (b.length) return tag(b);
    } catch (e) { log(`⚠️  Google Places failed (${e.message}) — falling back.`, 'warn'); }
  }

  // 2. Serper /places — neighborhood in `q`, ll pin + locality filter (free path,
  //    but Google Maps phone/website are not available here).
  try {
    const b = await findBusinessesSerper({ category, city, neighborhood, zip, country, lat, lng, radiusKm: radius_km || 10, limit: limit_count || 20, log });
    if (b.length) return tag(b);
  } catch (e) { log(`⚠️  Serper Places failed: ${e.message}`, 'warn'); }

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

// Lean per-business pipeline — only what the goal needs (phone, Instagram,
// location, website yes/no). No AI website grading, AI scoring, LinkedIn, or
// paid email lookups. Costs ~1-2 Serper calls/business + the phone fallback
// only when a number is still missing.
async function processBusiness(biz, { location, country, no_website_only }, log, shouldStop) {
  // 1 — enrich. Google Places already gave the authoritative phone/website/
  //     address, so only Serper-discovered businesses need the extra /search.
  if (!biz.fromPlaces) {
    await withTimeout(enrichBusiness(biz, location, country, log), 14000, biz);
  }
  if (shouldStop()) return null;

  // 2 — Instagram first: the handle + bio is where small local businesses keep
  //     their WhatsApp/phone, so resolve it before any phone hunt.
  const ig = await withTimeout(
    findInstagram({ name: biz.name, city: location, country, websiteUrl: biz.website, hint: biz.instagramHint }, log),
    14000, { handle: null });
  if (ig.handle) log(`📸 @${ig.handle} — ${ig.followers?.toLocaleString() || '?'} followers`);
  if (!biz.phone && ig.phoneFromBio) biz.phone = ig.phoneFromBio;
  if (shouldStop()) return null;

  // 2b — backfill: Serper's organic is a variable sample, so a second name+city
  //     query catches a website/phone the first enrichment missed (free path only).
  if (!biz.fromPlaces && (!biz.website || !biz.phone)) {
    await withTimeout(backfillWebsitePhone(biz, location, country, log), 10000, biz);
  }
  if (shouldStop()) return null;

  // 3 — phone: enrichment + the IG bio already cover most. Only spend the extra
  //     lookup when there's still no number, or just a toll-free/hotline one.
  const isTollFree = biz.phone && isTollFreeNumber(biz.phone, getCountryCode(country));
  if (!biz.phone || isTollFree) {
    log('📞 Looking for a direct number…');
    const found = await withTimeout(
      phoneAgentFind({ name: biz.name, city: location, country, website: biz.website, instagramHandle: ig.handle || biz.instagramHint?.handle }, log),
      40000, null);
    if (found) { biz.phone = found; log(`📞 Found: ${found}`); }
  }
  const phone = biz.phone || ig.phoneFromBio || null;
  if (shouldStop()) return null;

  // 4 — website: a real own-domain found during enrichment means they already
  //     have a site (no extra fetch / no AI). That's the only disqualifier.
  const hasWebsite = !!biz.website;
  log(hasWebsite ? `🌐 Has a website: ${biz.website}` : '🚫 No website found');
  if (no_website_only && hasWebsite) {
    return { skip: true, reason: `already has a website (${biz.website})` };
  }

  // 5 — email straight from the IG bio (free); 6 — must be reachable somehow.
  const email = ig.emailFromBio || null;
  if (!(phone || email || ig.handle || biz.website)) {
    return { skip: true, reason: 'no contact info found' };
  }

  // 7 — simple, free score: no website + reachable = hottest lead.
  const aiScore = hasWebsite ? 4 : (phone ? 9 : (ig.handle ? 7 : 6));
  const marketingScore = ig.handle ? (ig.followers && ig.followers > 5000 ? 7 : 5) : 2;
  const bits = [hasWebsite ? 'Already has a website' : 'No website — prime candidate to build one'];
  if (phone) bits.push('reachable by phone');
  if (ig.handle) bits.push(`on Instagram${ig.followers ? ` (${ig.followers.toLocaleString()} followers)` : ''}`);

  return {
    name: biz.name, category: biz.category, address: biz.address, phone,
    website: biz.website, websiteStatus: hasWebsite ? 'good' : 'none',
    websiteSummary: hasWebsite ? 'Has a website.' : 'No website found.',
    rating: biz.rating, reviewCount: biz.reviewCount,
    instagramHandle: ig.handle, instagramFollowers: ig.followers, instagramPosts: ig.posts,
    instagramPostsPerMonth: ig.postsPerMonth, instagramLastPost: ig.lastPost,
    instagramBio: ig.bio, instagramUrl: ig.url,
    linkedinCompanyUrl: null, ownerName: null, ownerLinkedinUrl: null,
    email, ownerPhone: null,
    aiScore, marketingScore, aiReasoning: bits.join('; '), outreachMessage: null,
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

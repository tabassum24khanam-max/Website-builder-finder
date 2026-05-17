// Google Maps scraper — searches for businesses and extracts details
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

async function searchMaps(page, { category, location, country, limit, log }) {
  const query = `${category} in ${location}${country ? ', ' + country : ''}`;
  log(`🗺️  Searching Google Maps: "${query}"`);

  await page.goto(
    `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await delay(2500);

  // Accept cookie consent if shown
  try {
    const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all"), form[action*="consent"] button').first();
    if (await acceptBtn.isVisible({ timeout: 3000 })) {
      await acceptBtn.click();
      await delay(1000);
    }
  } catch (_) {}

  // Wait for results feed
  try {
    await page.waitForSelector('[role="feed"]', { timeout: 15000 });
  } catch (_) {
    log('⚠️  Results feed not found — retrying...');
    await delay(3000);
  }

  const results = [];
  const seenNames = new Set();
  let noNewCount = 0;

  log(`📋 Feed loaded, collecting up to ${limit} businesses...`);

  while (results.length < limit) {
    const cards = await page.$$('[role="feed"] > div[jsaction]');

    for (const card of cards) {
      if (results.length >= limit) break;
      try {
        const nameEl = await card.$('.qBF1Pd, .fontHeadlineSmall');
        if (!nameEl) continue;
        const name = (await nameEl.textContent()).trim();
        if (!name || seenNames.has(name)) continue;

        seenNames.add(name);
        await card.click();
        await delay(DELAY + Math.random() * 800);

        const details = await extractDetails(page, log);
        if (!details.name) continue;

        results.push({ ...details, searchQuery: query });
        log(`✅ #${results.length} Found: ${details.name} ${details.website ? '🌐' : '🚫 No website'}`);
      } catch (err) {
        // skip broken card
      }
    }

    if (results.length >= limit) break;

    // Scroll feed to load more
    const scrolled = await scrollFeed(page);
    if (!scrolled) { noNewCount++; } else { noNewCount = 0; }
    if (noNewCount >= 3) {
      log(`📭 No more results available (found ${results.length})`);
      break;
    }
    await delay(1500);
  }

  return results;
}

async function extractDetails(page, log) {
  try {
    await page.waitForSelector('h1', { timeout: 8000 });
  } catch (_) {}

  const t = async (sel) => {
    try {
      const el = await page.$(sel);
      return el ? (await el.textContent()).trim() : '';
    } catch (_) { return ''; }
  };
  const a = async (sel, attr) => {
    try {
      const el = await page.$(sel);
      return el ? (await el.getAttribute(attr) || '').trim() : '';
    } catch (_) { return ''; }
  };

  const name    = await t('h1.DUwDvf, h1[class*="fontHeadlineLarge"]');
  const category = await t('.DkEaL, button.DkEaL');
  const address  = await t('[data-item-id="address"] .fontBodyMedium, [aria-label*="Address"] .fontBodyMedium');
  const phone    = await t('[data-item-id^="phone"] .fontBodyMedium, [aria-label*="Phone"] .fontBodyMedium');
  const website  = await t('[data-item-id="authority"] .fontBodyMedium, [aria-label*="Website"] .fontBodyMedium');

  const ratingText = await t('.F7nice span[aria-hidden="true"]');
  const rating = parseFloat(ratingText) || 0;

  const reviewAriaLabel = await a('.F7nice span[aria-label]', 'aria-label');
  const reviewCount = reviewAriaLabel ? parseInt(reviewAriaLabel.replace(/[^0-9]/g, '')) || 0 : 0;

  const mapsUrl = page.url();
  const coordMatch = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
  const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

  return { name, category, address, phone, website, rating, reviewCount, mapsUrl, lat, lng };
}

async function scrollFeed(page) {
  try {
    const feed = await page.$('[role="feed"]');
    if (!feed) return false;
    const before = await feed.evaluate(el => el.scrollTop);
    await feed.evaluate(el => el.scrollBy(0, 1500));
    await delay(1000);
    const after = await feed.evaluate(el => el.scrollTop);
    return after > before;
  } catch (_) { return false; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { searchMaps };

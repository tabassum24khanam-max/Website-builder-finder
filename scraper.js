// ============================================================
//  scraper.js — Google Maps Business Scraper (Playwright)
//  Playwright = controls a real Chrome browser automatically.
//  It scrolls, clicks, and reads pages just like a human.
// ============================================================

const { chromium } = require('playwright');

/**
 * Main scraper function.
 * @param {string} category - e.g. "restaurants"
 * @param {string} city     - e.g. "Riyadh"
 * @param {number} limit    - max businesses to scrape
 * @param {function} onLead - callback called for each scraped business
 * @param {function} onStatus - callback for status messages
 * @param {function} shouldStop - function that returns true if we should abort
 */
async function scrapeGoogleMaps(category, city, limit, onLead, onStatus, shouldStop) {
  // Set HEADLESS=true in .env to hide the browser window (useful on a server).
  // Default is visible so you can watch scraping happen.
  const headless = String(process.env.HEADLESS || '').toLowerCase() === 'true';

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  const page = await context.newPage();

  try {
    const searchQuery = `${category} in ${city}`;
    onStatus(`🔍 Searching Google Maps for: "${searchQuery}"`);

    // Go to Google Maps search
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for results to load
    await page.waitForTimeout(3000);

    // Dismiss any popups (cookie consent, etc.)
    try {
      await page.click('[aria-label="Accept all"]', { timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch (_) { /* No popup, continue */ }

    // Wait for the results feed to appear
    try {
      await page.waitForSelector('[role="feed"]', { timeout: 15000 });
    } catch (_) {
      onStatus('⚠️ Could not find results. Google Maps may have changed layout. Retrying...');
      await page.waitForTimeout(3000);
    }

    const scrapedNames = new Set(); // Avoid duplicates
    let scrapedCount = 0;
    let noNewResultsCount = 0;

    onStatus(`📋 Results loaded. Starting to extract businesses...`);

    while (scrapedCount < limit && !shouldStop()) {
      // Get all result cards currently visible in the feed
      const resultCards = await page.$$('[role="feed"] > div[jsaction]');

      let newItemsThisRound = 0;

      for (const card of resultCards) {
        if (scrapedCount >= limit || shouldStop()) break;

        try {
          // Get the business name from the card for dedup check
          const cardNameEl = await card.$('.qBF1Pd');
          if (!cardNameEl) continue;
          const cardName = await cardNameEl.textContent();
          if (!cardName || scrapedNames.has(cardName.trim())) continue;

          // Click the card to open the details panel
          await card.click();
          await page.waitForTimeout(2000 + Math.random() * 1000);

          // Wait for the details panel to load
          await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {});

          // ---- Extract all business details ----
          const name = await getText(page, 'h1.DUwDvf, h1[class*="fontHeadlineLarge"]');
          if (!name) continue;
          if (scrapedNames.has(name)) continue;

          const rawCategory = await getText(page, '.DkEaL, button.DkEaL');
          const address = await getText(page, '[data-item-id="address"] .fontBodyMedium, [aria-label*="Address"] .fontBodyMedium');
          const phone = await getText(page, '[data-item-id^="phone"] .fontBodyMedium, [aria-label*="Phone"] .fontBodyMedium');
          const website = await getText(page, '[data-item-id="authority"] .fontBodyMedium, [aria-label*="Website"] .fontBodyMedium');

          // Rating and review count
          const ratingText = await getText(page, '.F7nice span[aria-hidden="true"], span.ceNzKf');
          const rating = parseFloat(ratingText) || 0;

          const reviewAriaLabel = await getAttribute(page, '.F7nice span[aria-label], button[aria-label*="review"]', 'aria-label');
          const reviewCount = reviewAriaLabel ? parseInt(reviewAriaLabel.replace(/[^0-9]/g, '')) || 0 : 0;

          // ---- Grab a few review snippets ----
          const reviewSnippets = await scrapeReviews(page, name, onStatus);

          scrapedNames.add(name);
          newItemsThisRound++;

          onStatus(`✅ Scraped #${scrapedCount + 1}: ${name} ${website ? '🌐 Has website' : '🚫 No website'}`);

          // Return the raw business data
          await onLead({
            name: name.trim(),
            category: (rawCategory || category).trim(),
            address: (address || '').trim(),
            phone: (phone || '').trim(),
            website: (website || '').trim(),
            rating,
            reviewCount,
            reviewSnippets,
            city,
            sourceUrl: page.url()
          });

          scrapedCount++;

          // Human-like delay between businesses (1.5 - 3 seconds)
          await page.waitForTimeout(1500 + Math.random() * 1500);

        } catch (err) {
          // Skip this card silently and continue
          console.error(`[Scraper] Skipped card: ${err.message}`);
          continue;
        }
      }

      // Scroll the results feed to load more businesses
      onStatus(`📜 Scrolling for more results... (${scrapedCount}/${limit} scraped)`);

      const scrolled = await scrollFeed(page);

      if (!scrolled || newItemsThisRound === 0) {
        noNewResultsCount++;
        if (noNewResultsCount >= 3) {
          onStatus('📭 No more results available on Google Maps for this search.');
          break;
        }
      } else {
        noNewResultsCount = 0;
      }

      await page.waitForTimeout(2000);
    }

    onStatus(`🎉 Scraping complete! Total businesses scraped: ${scrapedCount}`);

  } catch (err) {
    console.error('[Scraper] Fatal error:', err);
    onStatus(`❌ Scraper error: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

// ---- Helper: Scrape review snippets ----
async function scrapeReviews(page, businessName, onStatus) {
  const snippets = [];
  try {
    // Look for "Reviews" tab and click it
    const reviewsTab = await page.$('button[aria-label*="Reviews"], [role="tab"][aria-label*="Reviews"]');
    if (!reviewsTab) return snippets;

    await reviewsTab.click();
    await page.waitForTimeout(2000);

    // Sort by Newest to get authentic reviews
    try {
      const sortBtn = await page.$('[aria-label*="Sort reviews"], button[data-value*="Sort"]');
      if (sortBtn) {
        await sortBtn.click();
        await page.waitForTimeout(800);
        const newestOption = await page.$('[data-index="1"], [aria-label*="Newest"]');
        if (newestOption) {
          await newestOption.click();
          await page.waitForTimeout(1500);
        }
      }
    } catch (_) { /* Sort failed, continue */ }

    // Extract review texts
    const reviewEls = await page.$$('.jftiEf .wiI7pd, .MyEned .wiI7pd');
    for (const el of reviewEls.slice(0, 6)) {
      const text = await el.textContent().catch(() => '');
      if (text && text.trim().length > 10) snippets.push(text.trim());
    }

    // Go back to main panel
    const backBtn = await page.$('button[aria-label*="Back"], button.hYkZhd');
    if (backBtn) {
      await backBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch (_) {
    // Reviews scraping is optional, silently fail
  }
  return snippets;
}

// ---- Helper: Scroll the results feed ----
async function scrollFeed(page) {
  try {
    const feed = await page.$('[role="feed"]');
    if (!feed) return false;

    const before = await feed.evaluate(el => el.scrollTop);
    await feed.evaluate(el => el.scrollBy(0, 1200));
    await page.waitForTimeout(1500);
    const after = await feed.evaluate(el => el.scrollTop);

    return after > before;
  } catch (_) {
    // Try alternate scroll method
    try {
      await page.keyboard.press('Tab');
      await page.evaluate(() => window.scrollBy(0, 800));
      return true;
    } catch (_) {
      return false;
    }
  }
}

// ---- Helper: Safe text extractor ----
async function getText(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return '';
    return (await el.textContent() || '').trim();
  } catch (_) {
    return '';
  }
}

// ---- Helper: Safe attribute extractor ----
async function getAttribute(page, selector, attr) {
  try {
    const el = await page.$(selector);
    if (!el) return '';
    return (await el.getAttribute(attr) || '').trim();
  } catch (_) {
    return '';
  }
}

module.exports = { scrapeGoogleMaps };

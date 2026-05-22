// AI-powered Google Maps business discovery
// Phase 1: GPT-4o drives browser to search and get business names
// Phase 2: Playwright clicks each card to extract phone, website, address, coords, photo

const { OpenAI } = require('openai');
const { chromium } = require('playwright');

const SCRAPE_MODEL = 'gpt-4o';

const SEARCH_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_on_maps',
      description: 'Type a search query into the Google Maps search box and submit.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_results',
      description: 'Read the current business result cards visible on the page.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_results',
      description: 'Scroll the results panel down to load more businesses.',
      parameters: {
        type: 'object',
        properties: { times: { type: 'integer', minimum: 1, maximum: 5 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for the page to load or update.',
      parameters: {
        type: 'object',
        properties: { ms: { type: 'integer', minimum: 500, maximum: 4000 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'return_names',
      description: 'Return all business names found. Call this once you have scrolled and read enough results.',
      parameters: {
        type: 'object',
        properties: {
          businesses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rating: { type: 'number' },
                review_count: { type: 'integer' },
              },
              required: ['name'],
            },
          },
        },
        required: ['businesses'],
      },
    },
  },
];

async function findBusinessesGoogleMapsAI({ category, location, country, lat, lng, radius_km = 5, limit = 20, log }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
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

    const page = await context.newPage();

    // Land on Google Maps at the target coordinates
    const zoom = radius_km <= 2 ? 16 : radius_km <= 5 ? 14 : radius_km <= 10 ? 13 : 12;
    const startUrl = (lat && lng)
      ? `https://www.google.com/maps/@${lat},${lng},${zoom}z?hl=en`
      : `https://www.google.com/maps?hl=en&q=${encodeURIComponent(location + (country ? ', ' + country : ''))}`;

    log(`🌐 Opening Google Maps...`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // Dismiss consent / cookie dialogs
    try {
      const acceptBtn = page.getByRole('button', { name: /accept all|agree/i });
      if (await acceptBtn.isVisible({ timeout: 2000 })) {
        await acceptBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch (_) {}

    // ── Phase 1: AI searches and collects business names ────────────────────────
    const fullLocation = `${location}${country ? ', ' + country : ''}`;
    const wantCount = Math.min(limit * 2, 40);
    const searchTask = `You control a browser on Google Maps near ${fullLocation}.
Find at least ${wantCount} ${category} businesses in this area.

IMPORTANT: Only return LOCAL, independent, single-location businesses.
DO NOT include large chains, franchises, or corporate brands such as:
Starbucks, McDonald's, KFC, Subway, Costa, Tim Hortons, Pizza Hut, Burger King,
Gym Nation, Body Masters, Anytime Fitness, Gold's Gym, Planet Fitness, Fitness First,
or any other national or international chain with multiple locations.
Focus ONLY on small local businesses that likely need a website or digital marketing.

Steps:
1. wait(2000)
2. search_on_maps("local ${category} ${location}")
3. wait(3000)
4. read_results
5. scroll_results(3)
6. read_results
7. return_names with ALL local independent businesses you saw — aim for ${wantCount}

Only return local independent businesses you actually saw listed on the page.`;

    log(`🤖 AI searching for ${category} near ${fullLocation}...`);
    const rawList = await runSearchLoop(openai, page, searchTask, log);
    log(`📋 AI found ${rawList.length} businesses — now extracting full details...`);

    if (!rawList.length) return [];

    // ── Phase 2: Click each card for full detail ─────────────────────────────────
    const enriched = [];
    const toProcess = rawList.slice(0, wantCount);

    for (let i = 0; i < toProcess.length; i++) {
      const biz = toProcess[i];
      if (!biz.name) continue;

      log(`📍 [${i + 1}/${toProcess.length}] Getting details: ${biz.name}`);

      try {
        // Find the result card in the DOM and click it
        const card = page.locator('[role="feed"] [role="article"]')
          .filter({ hasText: biz.name.slice(0, 25) })
          .first();
        await card.scrollIntoViewIfNeeded({ timeout: 3000 });
        await page.waitForTimeout(300);
        await card.click({ timeout: 6000 });
        await page.waitForTimeout(2800);

        const detailUrl = page.url();
        if (detailUrl.includes('/maps/place/') || detailUrl !== startUrl) {
          const detail = await extractPlaceDetails(page);
          enriched.push({
            name: biz.name,
            rating: biz.rating || null,
            reviewCount: biz.review_count || 0,
            lat: detail.lat,
            lng: detail.lng,
            phone: detail.phone,
            website: detail.website,
            address: detail.address,
            photoUrl: detail.photoUrl,
            mapsUrl: detailUrl.includes('/maps/') ? detailUrl : null,
          });
          log(`   ✓ ${detail.phone ? '📞 ' + detail.phone.slice(0, 20) : 'no phone'} | ${detail.website ? '🌐 found' : 'no website'} | ${detail.lat ? '📍 coords' : 'no coords'}`);
        } else {
          log(`   ⚠️  Detail panel didn't open`, 'warn');
          enriched.push({ name: biz.name, rating: biz.rating || null, reviewCount: biz.review_count || 0 });
        }

        // Navigate back to the search results
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1300);
        try { await page.locator('[role="feed"]').waitFor({ timeout: 5000 }); } catch (_) {}

      } catch (err) {
        log(`   ⚠️  Could not get detail for ${biz.name}: ${err.message}`, 'warn');
        enriched.push({ name: biz.name, rating: biz.rating || null, reviewCount: biz.review_count || 0 });
        try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch (_) {}
        await page.waitForTimeout(800);
      }
    }

    log(`✅ Detail pass complete: ${enriched.length} businesses enriched`);

    return enriched.map(b => ({
      name: b.name,
      category,
      address: b.address || null,
      phone: b.phone || null,
      website: b.website || null,
      rating: (typeof b.rating === 'number' && b.rating > 0) ? b.rating : null,
      reviewCount: b.reviewCount || 0,
      lat: b.lat || null,
      lng: b.lng || null,
      photoUrl: b.photoUrl || null,
      mapsUrl: b.mapsUrl || null,
    }));

  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Agent loop for Phase 1 ──────────────────────────────────────────────────────

async function runSearchLoop(openai, page, task, log, maxIter = 15) {
  const messages = [
    {
      role: 'system',
      content: 'You are a browser automation agent. Find local businesses on Google Maps using the tools provided. Always scroll to load more results before returning.',
    },
    { role: 'user', content: task },
  ];

  for (let i = 0; i < maxIter; i++) {
    const resp = await openai.chat.completions.create({
      model: SCRAPE_MODEL,
      messages,
      tools: SEARCH_TOOLS,
      tool_choice: 'auto',
    });

    const msg = resp.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) break;

    const toolResults = [];
    for (const call of msg.tool_calls) {
      let args;
      try { args = JSON.parse(call.function.arguments); } catch (_) { args = {}; }

      log(`🤖 ${call.function.name}(${brief(args)})`);

      if (call.function.name === 'return_names') return args.businesses || [];

      const result = await executeSearchTool(page, call.function.name, args);
      log(`   ↩ ${JSON.stringify(result).slice(0, 120)}`);
      toolResults.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    messages.push(...toolResults);
  }

  return [];
}

async function executeSearchTool(page, name, args) {
  switch (name) {
    case 'search_on_maps': {
      const box = page.locator('#searchboxinput, input[aria-label*="Search"], input[name="q"]').first();
      await box.waitFor({ timeout: 8000 });
      await box.click();
      await box.fill('');
      await page.waitForTimeout(200);
      await box.type(String(args.query), { delay: 55 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1200);
      return { ok: true, searched: args.query };
    }
    case 'read_results': {
      return await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (!feed) return { source: 'page', content: document.body.innerText.slice(0, 5000) };
        const cards = Array.from(feed.querySelectorAll('[role="article"]'))
          .map(a => a.innerText.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        return cards.length ? { card_count: cards.length, cards } : { source: 'feed', content: feed.innerText.slice(0, 6000) };
      });
    }
    case 'scroll_results': {
      const times = Math.min(args.times || 3, 5);
      for (let i = 0; i < times; i++) {
        await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          if (feed) feed.scrollBy(0, 500);
          else document.documentElement.scrollBy(0, 500);
        });
        await page.waitForTimeout(700);
      }
      const count = await page.evaluate(() => document.querySelectorAll('[role="article"]').length);
      return { scrolled: true, visible_cards: count };
    }
    case 'wait': {
      await page.waitForTimeout(Math.min(args.ms || 2000, 4000));
      return { waited: args.ms };
    }
    default:
      return { error: `Unknown: ${name}` };
  }
}

// ── Detail extraction from the open place panel ─────────────────────────────────

async function extractPlaceDetails(page) {
  // !3d{lat}!4d{lng} in the URL data param is the actual place pin coords
  // @{lat},{lng} is only the viewport center — less accurate
  const url = page.url();
  let lat = null, lng = null;
  const placeM = url.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (placeM) {
    lat = parseFloat(placeM[1]);
    lng = parseFloat(placeM[2]);
  } else {
    const viewM = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (viewM) { lat = parseFloat(viewM[1]); lng = parseFloat(viewM[2]); }
  }

  const data = await page.evaluate(() => {
    const panel = document.querySelector('[role="main"]') || document.body;

    // ── Website: first non-Google external link ──────────────
    let website = null;
    const skipDomains = ['google.', 'goo.gl', 'maps.app', 'accounts.', 'support.google', 'javascript:', 'play.google', 'apple.com/maps'];
    for (const a of panel.querySelectorAll('a[href]')) {
      const h = a.href || '';
      if (!h.startsWith('http')) continue;
      if (skipDomains.some(d => h.includes(d))) continue;
      const txt = (a.textContent || '').trim();
      if (txt && txt.length < 100 && !txt.includes('\n')) { website = h; break; }
    }

    // ── Phone: aria-label button is most reliable ────────────
    let phone = null;
    for (const btn of panel.querySelectorAll('button[aria-label], [data-item-id*="phone"]')) {
      const label = btn.getAttribute('aria-label') || btn.getAttribute('data-item-id') || '';
      if (/phone/i.test(label)) {
        const m = label.match(/(?:Phone[:\s]+)(.+)/i);
        if (m) { phone = m[1].trim(); break; }
        // Some buttons have the number as inner text
        const inner = btn.innerText.trim();
        if (/^[\+\d][\d\s\-\(\)\.]{5,}$/.test(inner)) { phone = inner; break; }
      }
    }
    if (!phone) {
      const telLink = panel.querySelector('a[href^="tel:"]');
      if (telLink) phone = decodeURIComponent(telLink.href.replace('tel:', '')).trim();
    }
    if (!phone) {
      const txt = panel.innerText;
      const pm = txt.match(/(?:^|\s)(\+?[\d][\d\s\-\(\)\.]{7,17}[\d])(?:\s|$)/m);
      if (pm) phone = pm[1].trim().replace(/\s+/g, ' ');
    }

    // ── Address: aria-label button is most reliable ──────────
    let address = null;
    for (const btn of panel.querySelectorAll('button[aria-label], [data-item-id*="address"]')) {
      const label = btn.getAttribute('aria-label') || '';
      if (/address/i.test(label)) {
        const m = label.match(/(?:Address[:\s]+)(.+)/i);
        if (m) { address = m[1].trim(); break; }
      }
    }
    if (!address) {
      const addrEl = panel.querySelector('.Io6YTe, [data-item-id*="address"] .fontBodyMedium, [data-item-id*="address"] span');
      if (addrEl) address = addrEl.textContent.trim();
    }
    // No loose text-pattern fallback — it picks up rating/price lines

    // ── Photo: first googleusercontent image ─────────────────
    let photoUrl = null;
    for (const img of panel.querySelectorAll('img')) {
      const src = img.src || '';
      if (src.includes('googleusercontent.com') && !src.includes('=s0') && img.width > 80) {
        photoUrl = src.replace(/=w\d+/, '=w600').replace(/=h\d+/, '=h400');
        break;
      }
    }
    if (!photoUrl) {
      for (const el of panel.querySelectorAll('[style*="googleusercontent"]')) {
        const bm = (el.style.backgroundImage || '').match(/url\("?(https?:\/\/[^"')]+)"?\)/);
        if (bm) { photoUrl = bm[1]; break; }
      }
    }

    return { website, phone, address, photoUrl };
  });

  return {
    lat, lng,
    phone: data.phone || null,
    website: data.website || null,
    address: data.address || null,
    photoUrl: data.photoUrl || null,
  };
}

function brief(args) {
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 80) + '...' : s;
}

module.exports = { findBusinessesGoogleMapsAI };

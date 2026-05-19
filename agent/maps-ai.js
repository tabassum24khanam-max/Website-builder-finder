// AI-powered Google Maps business discovery
// Uses GPT-4o with a tool-calling loop to drive a real browser on Google Maps,
// then returns structured business data for the enrichment pipeline.

const { OpenAI } = require('openai');
const { chromium } = require('playwright');

const SCRAPE_MODEL = 'gpt-4o'; // needs reliable instruction-following; not mini

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_on_maps',
      description: 'Type a query into the Google Maps search box and submit it. Use this to search for a business category.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, e.g. "cafes" or "barbershops"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_current_results',
      description: 'Read the current search results visible on the page. Returns card text for each result. Call this after searching or scrolling.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_results_down',
      description: 'Scroll down in the results panel to reveal more businesses.',
      parameters: {
        type: 'object',
        properties: {
          times: { type: 'integer', description: 'How many times to scroll (1–5)', minimum: 1, maximum: 5 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_page',
      description: 'Wait for the page or results to load.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'integer', description: 'Milliseconds to wait (500–4000)', minimum: 500, maximum: 4000 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'return_businesses',
      description: 'Return the complete list of businesses found. Call this when you have collected all the results you can see.',
      parameters: {
        type: 'object',
        properties: {
          businesses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address: { type: 'string' },
                phone: { type: 'string' },
                website: { type: 'string' },
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

    // Navigate to Google Maps centered on coordinates, English locale forced
    const zoom = radius_km <= 2 ? 16 : radius_km <= 5 ? 14 : radius_km <= 10 ? 13 : 12;
    const startUrl = (lat && lng)
      ? `https://www.google.com/maps/@${lat},${lng},${zoom}z?hl=en`
      : `https://www.google.com/maps/search/${encodeURIComponent(category + ' ' + location + (country ? ', ' + country : ''))}?hl=en`;

    log(`🌐 Navigating to Google Maps at ${lat && lng ? `(${lat.toFixed(4)}, ${lng.toFixed(4)})` : location}...`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // Dismiss consent / cookie dialogs if present
    try {
      const accept = page.getByRole('button', { name: /accept all|agree|i agree/i });
      if (await accept.isVisible({ timeout: 2000 })) {
        await accept.click();
        await page.waitForTimeout(1000);
      }
    } catch (_) {}

    const fullLocation = `${location}${country ? ', ' + country : ''}`;
    const task = `You are controlling a real browser on Google Maps. Your task: find ${limit} ${category} businesses near ${fullLocation}.

The browser is already open at the correct location on Google Maps.

Do this in order:
1. call wait_for_page(1500)
2. call search_on_maps with query "${category}"
3. call wait_for_page(3000)
4. call read_current_results — this shows you what businesses are listed
5. If you see fewer than ${Math.min(limit, 8)} businesses, call scroll_results_down then read_current_results again
6. Once you have enough, call return_businesses with every business you collected

When parsing results, extract: name (required), address, phone, website, rating (number), review_count (integer).
Do NOT invent businesses — only return ones you actually read from the page.`;

    const raw = await runAgentLoop(openai, page, task, log);

    log(`🤖 AI agent collected ${raw.length} businesses from Google Maps`);

    return raw.slice(0, limit).map(b => ({
      name: b.name,
      category,
      address: b.address || null,
      phone: b.phone || null,
      website: b.website || null,
      rating: (typeof b.rating === 'number' && b.rating > 0) ? b.rating : null,
      reviewCount: (typeof b.review_count === 'number') ? b.review_count : 0,
      lat: null,
      lng: null,
      mapsUrl: null,
    }));

  } finally {
    await browser.close().catch(() => {});
  }
}

async function runAgentLoop(openai, page, task, log, maxIterations = 20) {
  const messages = [
    {
      role: 'system',
      content: 'You are a browser automation agent that finds businesses on Google Maps. Use tools step by step. Extract all businesses visible in results before calling return_businesses.',
    },
    { role: 'user', content: task },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await openai.chat.completions.create({
      model: SCRAPE_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      log('⚠️  AI agent finished without returning businesses', 'warn');
      break;
    }

    const toolResults = [];
    for (const call of msg.tool_calls) {
      let args;
      try { args = JSON.parse(call.function.arguments); } catch (_) { args = {}; }

      log(`🤖 AI → ${call.function.name}(${brief(args)})`);

      if (call.function.name === 'return_businesses') {
        return args.businesses || [];
      }

      const result = await executeTool(page, call.function.name, args);
      const resultStr = JSON.stringify(result);
      log(`   ↩ ${resultStr.slice(0, 160)}${resultStr.length > 160 ? '...' : ''}`);

      toolResults.push({
        role: 'tool',
        tool_call_id: call.id,
        content: resultStr.slice(0, 10000),
      });
    }

    messages.push(...toolResults);
  }

  return [];
}

async function executeTool(page, name, args) {
  try {
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
        return { success: true, searched_for: args.query };
      }

      case 'read_current_results': {
        return await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          if (feed) {
            const cards = Array.from(feed.querySelectorAll('[role="article"]'))
              .map(a => a.innerText.replace(/\s+/g, ' ').trim())
              .filter(Boolean);
            if (cards.length) return { card_count: cards.length, cards };
            return { source: 'feed_text', content: feed.innerText.slice(0, 8000) };
          }
          const main = document.querySelector('[role="main"]');
          return {
            source: 'page_text',
            content: (main || document.body).innerText.slice(0, 6000),
            url: window.location.href,
          };
        });
      }

      case 'scroll_results_down': {
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

      case 'wait_for_page': {
        await page.waitForTimeout(Math.min(args.ms || 2000, 4000));
        return { waited_ms: args.ms };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

function brief(args) {
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 80) + '...' : s;
}

module.exports = { findBusinessesGoogleMapsAI };

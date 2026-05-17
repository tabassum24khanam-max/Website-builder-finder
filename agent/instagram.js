// Instagram finder & analyzer — uses Playwright with stealth techniques
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

async function findAndAnalyzeInstagram(page, { name, city, country, websiteUrl }, log) {
  const result = {
    handle: null, url: null, followers: null, posts: null,
    postsPerMonth: null, lastPost: null, bio: null,
  };

  // If website IS Instagram, we already have the handle
  if (websiteUrl && /instagram\.com\/([A-Za-z0-9._]+)/.test(websiteUrl)) {
    const m = websiteUrl.match(/instagram\.com\/([A-Za-z0-9._]+)/);
    result.handle = m[1];
    result.url = `https://www.instagram.com/${m[1]}/`;
  }

  // Search for Instagram handle via DuckDuckGo
  if (!result.handle) {
    log(`📸 Searching Instagram for: ${name}`);
    try {
      result.handle = await searchInstagramHandle(page, name, city, country);
      if (result.handle) result.url = `https://www.instagram.com/${result.handle}/`;
    } catch (_) {}
  }

  if (!result.handle) return result;

  // Analyze the Instagram profile
  log(`📸 Analyzing @${result.handle}...`);
  try {
    const profile = await scrapeInstagramProfile(page, result.handle);
    Object.assign(result, profile);
  } catch (err) {
    log(`⚠️  Could not fully analyze @${result.handle}: ${err.message}`);
  }

  return result;
}

async function searchInstagramHandle(page, name, city, country) {
  const query = `"${name}" ${city || ''} ${country || ''} site:instagram.com`;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await delay(1000);

  const content = await page.content();

  // Extract instagram.com URLs from results
  const patterns = [
    /instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?:\?|"|'|\s|$)/g,
    /href="https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})"/g,
  ];

  const BAD = new Set(['p', 'explore', 'reel', 'tv', 'stories', 'reels', 'accounts', 'about']);

  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const handle = m[1];
      if (handle && !BAD.has(handle.toLowerCase()) && handle.length > 2) {
        return handle;
      }
    }
  }
  return null;
}

async function scrapeInstagramProfile(page, handle) {
  const profileUrl = `https://www.instagram.com/${handle}/`;

  // Apply stealth before navigating
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await delay(DELAY + Math.random() * 500);

  const result = { followers: null, posts: null, postsPerMonth: null, lastPost: null, bio: null };

  // Try to extract from page title (often: "username (@handle) • 1,234 Followers, ...")
  try {
    const title = await page.title();
    const followerMatch = title.match(/([\d,]+)\s*Followers?/i);
    if (followerMatch) result.followers = parseNumber(followerMatch[1]);
    const postsMatch = title.match(/([\d,]+)\s*Posts?/i);
    if (postsMatch) result.posts = parseNumber(postsMatch[1]);
  } catch (_) {}

  // Try to extract from meta description
  try {
    const meta = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
    if (!result.followers) {
      const fm = meta.match(/([\d,k]+)\s*Followers?/i);
      if (fm) result.followers = parseNumber(fm[1]);
    }
    if (!result.posts) {
      const pm = meta.match(/([\d,k]+)\s*Posts?/i);
      if (pm) result.posts = parseNumber(pm[1]);
    }
    // Extract bio from description
    const bioMatch = meta.match(/^(.+?)\s*-\s*[\d,]+ Followers/i);
    if (bioMatch) result.bio = bioMatch[1].trim();
  } catch (_) {}

  // Try extracting from embedded JSON (__additionalData or __NEXT_DATA__)
  try {
    const scriptContent = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[type="application/json"], script')];
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('edge_followed_by') || txt.includes('follower_count')) return txt;
      }
      return '';
    });

    if (scriptContent) {
      const followerMatch = scriptContent.match(/"edge_followed_by":\{"count":(\d+)\}|"follower_count":(\d+)/);
      if (followerMatch) result.followers = parseInt(followerMatch[1] || followerMatch[2]);

      const postMatch = scriptContent.match(/"edge_owner_to_timeline_media":\{"count":(\d+)\}|"media_count":(\d+)/);
      if (postMatch) result.posts = parseInt(postMatch[1] || postMatch[2]);

      // Last post date
      const dateMatch = scriptContent.match(/"taken_at_timestamp":(\d+)/);
      if (dateMatch) {
        const ts = parseInt(dateMatch[1]);
        result.lastPost = new Date(ts * 1000).toISOString().split('T')[0];
        // Calculate posts per month using account age or last ~12 posts
        const allDates = [...scriptContent.matchAll(/"taken_at_timestamp":(\d+)/g)]
          .map(m => parseInt(m[1]) * 1000)
          .sort((a, b) => b - a)
          .slice(0, 12);

        if (allDates.length >= 2) {
          const spanMs = allDates[0] - allDates[allDates.length - 1];
          const spanMonths = spanMs / (30 * 24 * 60 * 60 * 1000);
          if (spanMonths > 0) result.postsPerMonth = +(allDates.length / spanMonths).toFixed(1);
        }
      }
    }
  } catch (_) {}

  // Extract email from bio text
  if (!result.bio) {
    try {
      result.bio = await page.evaluate(() => {
        const el = document.querySelector('span._ap3a, div.-vDIg, header section div span');
        return el ? el.textContent.trim() : null;
      });
    } catch (_) {}
  }

  return result;
}

function parseNumber(str) {
  const s = String(str).replace(/,/g, '').toLowerCase();
  if (s.includes('k')) return Math.round(parseFloat(s) * 1000);
  if (s.includes('m')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s) || null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { findAndAnalyzeInstagram };

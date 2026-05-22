// Instagram finder — searches Bing for Instagram handle, then scrapes profile
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

const BAD_HANDLES = new Set([
  'p', 'explore', 'reel', 'tv', 'stories', 'reels', 'accounts', 'about',
  'help', 'legal', 'press', 'api', 'blog', 'developer', 'developers',
  'privacy', 'safety', 'support', 'directory', 'challenge',
]);

async function findAndAnalyzeInstagram(page, { name, city, country, websiteUrl }, log) {
  const result = {
    handle: null, url: null, followers: null, posts: null,
    postsPerMonth: null, lastPost: null, bio: null,
  };

  // 1. If website IS Instagram, extract handle directly
  if (websiteUrl && /instagram\.com\/([A-Za-z0-9._]+)/.test(websiteUrl)) {
    const m = websiteUrl.match(/instagram\.com\/([A-Za-z0-9._]+)/);
    if (m && !BAD_HANDLES.has(m[1].toLowerCase())) {
      result.handle = m[1];
      result.url = `https://www.instagram.com/${m[1]}/`;
    }
  }

  // 2. Check the website itself for Instagram links
  if (!result.handle && websiteUrl) {
    try {
      const handle = await extractInstagramFromWebsite(page, websiteUrl);
      if (handle) {
        result.handle = handle;
        result.url = `https://www.instagram.com/${handle}/`;
        log(`📸 Found Instagram link on website: @${handle}`);
      }
    } catch (_) {}
  }

  // 3. Search Bing for the Instagram page
  if (!result.handle) {
    log(`📸 Searching Instagram for: ${name}`);
    try {
      result.handle = await searchInstagramViaBing(page, name, city, country);
      if (result.handle) result.url = `https://www.instagram.com/${result.handle}/`;
    } catch (_) {}
  }

  if (!result.handle) {
    log(`📸 No Instagram found`);
    return result;
  }

  // 4. Scrape the profile for stats
  log(`📸 Analyzing @${result.handle}...`);
  try {
    const profile = await scrapeInstagramProfile(page, result.handle);
    Object.assign(result, profile);
  } catch (err) {
    log(`⚠️  Could not analyze @${result.handle}: ${err.message}`);
  }

  return result;
}

async function extractInstagramFromWebsite(page, websiteUrl) {
  await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
  await delay(800);

  const handle = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href]')) {
      const href = (a.href || '').toLowerCase();
      const m = href.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/);
      if (m) return m[1];
    }
    return null;
  });

  if (handle && !BAD_HANDLES.has(handle.toLowerCase())) return handle;
  return null;
}

async function searchInstagramViaBing(page, name, city, country) {
  const query = `"${name}" ${city || ''} ${country || ''} site:instagram.com`;

  try {
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: 18000 });
    await delay(1200);

    const html = await page.content();
    const handle = extractHandleFromHtml(html);
    if (handle) return handle;
  } catch (_) {}

  // DuckDuckGo fallback
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(1000);

    const html = await page.content();
    return extractHandleFromHtml(html);
  } catch (_) {}

  return null;
}

function extractHandleFromHtml(html) {
  const re = /instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?:\?|"|'|\s|<|\/|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1];
    if (handle && !BAD_HANDLES.has(handle.toLowerCase()) && handle.length > 2) {
      return handle;
    }
  }
  return null;
}

async function scrapeInstagramProfile(page, handle) {
  const profileUrl = `https://www.instagram.com/${handle}/`;
  const result = { followers: null, posts: null, postsPerMonth: null, lastPost: null, bio: null };

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await delay(DELAY + Math.random() * 500);

  // Title often contains: "username (@handle) • 1,234 Followers, 56 Following, 78 Posts"
  try {
    const title = await page.title();
    const fm = title.match(/([\d,k]+)\s*Followers?/i);
    if (fm) result.followers = parseNumber(fm[1]);
    const pm = title.match(/([\d,k]+)\s*Posts?/i);
    if (pm) result.posts = parseNumber(pm[1]);
  } catch (_) {}

  // Meta description
  try {
    const meta = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
    if (!result.followers) {
      const fm = meta.match(/([\d,.k]+)\s*Followers?/i);
      if (fm) result.followers = parseNumber(fm[1]);
    }
    if (!result.posts) {
      const pm = meta.match(/([\d,.k]+)\s*Posts?/i);
      if (pm) result.posts = parseNumber(pm[1]);
    }
    const bioMatch = meta.match(/^(.+?)\s*[-–]\s*[\d,]+ Followers/i);
    if (bioMatch) result.bio = bioMatch[1].trim();
  } catch (_) {}

  // Embedded JSON data
  try {
    const scriptContent = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script[type="application/json"], script')) {
        const txt = s.textContent || '';
        if (txt.includes('edge_followed_by') || txt.includes('follower_count')) return txt;
      }
      return '';
    });
    if (scriptContent) {
      const fm = scriptContent.match(/"edge_followed_by":\{"count":(\d+)\}|"follower_count":(\d+)/);
      if (fm) result.followers = parseInt(fm[1] || fm[2]);
      const pm = scriptContent.match(/"edge_owner_to_timeline_media":\{"count":(\d+)\}|"media_count":(\d+)/);
      if (pm) result.posts = parseInt(pm[1] || pm[2]);
      const dm = scriptContent.match(/"taken_at_timestamp":(\d+)/);
      if (dm) {
        result.lastPost = new Date(parseInt(dm[1]) * 1000).toISOString().split('T')[0];
        const allDates = [...scriptContent.matchAll(/"taken_at_timestamp":(\d+)/g)]
          .map(m => parseInt(m[1]) * 1000).sort((a, b) => b - a).slice(0, 12);
        if (allDates.length >= 2) {
          const spanMonths = (allDates[0] - allDates[allDates.length - 1]) / (30 * 24 * 60 * 60 * 1000);
          if (spanMonths > 0) result.postsPerMonth = +(allDates.length / spanMonths).toFixed(1);
        }
      }
    }
  } catch (_) {}

  // Bio fallback
  if (!result.bio) {
    try {
      result.bio = await page.evaluate(() => {
        const el = document.querySelector('span._ap3a, div.-vDIg, header section div span, h1 + div span');
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

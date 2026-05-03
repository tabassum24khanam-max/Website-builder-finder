// ============================================================
//  enricher.js — Contact Info Finder
//
//  Searches DuckDuckGo (no API key, no login) to find:
//    - Email address
//    - Instagram page URL
//    - Facebook page URL
//    - LinkedIn company URL
//
//  Also scrapes the business's own website (if they have one)
//  for contact details and social links.
//
//  This is best-effort. Some businesses won't be found.
//  Uses plain HTTPS fetch — no browser needed here.
// ============================================================

const https = require('https');
const http = require('http');

const EMAIL_REGEX = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,7}\b/g;

// ---- Main export ----

async function enrichLead({ name, city, website }) {
  const result = { email: null, instagram: null, linkedin: null, facebook: null };

  // 1. If the business's "website" on Maps IS a social page, capture it directly
  if (website) {
    if (/instagram\.com/i.test(website)) result.instagram = cleanUrl(website);
    if (/facebook\.com/i.test(website)) result.facebook = cleanUrl(website);
    if (/linkedin\.com/i.test(website)) result.linkedin = cleanUrl(website);

    // 2. If they have a real website, scrape it for contact info + social links
    if (!result.instagram || !result.email) {
      try {
        const html = await fetchPage(website);
        if (!result.email) {
          result.email = extractEmail(html);
        }
        if (!result.instagram) {
          const m = html.match(/instagram\.com\/([A-Za-z0-9._]{2,30})/i);
          if (m && !['p', 'explore', 'reel', 'tv', 'stories'].includes(m[1])) {
            result.instagram = `https://www.instagram.com/${m[1]}`;
          }
        }
        if (!result.facebook) {
          const m = html.match(/facebook\.com\/(pages\/[^"'\s?#]+|[A-Za-z0-9._\-]{3,})/i);
          if (m && !['share', 'sharer', 'plugins', 'dialog', 'login', 'groups'].includes(m[1])) {
            result.facebook = `https://www.facebook.com/${m[1]}`;
          }
        }
        if (!result.linkedin) {
          const m = html.match(/linkedin\.com\/company\/([A-Za-z0-9._\-]{2,})/i);
          if (m) result.linkedin = `https://www.linkedin.com/company/${m[1]}`;
        }
      } catch (_) {}
    }
  }

  // 3. DuckDuckGo HTML searches for everything we haven't found yet
  const q = `"${name}" ${city}`;

  if (!result.instagram) {
    await pause(1200);
    try {
      const html = await ddgSearch(`${q} site:instagram.com`);
      result.instagram = extractFirstUrl(html, 'instagram.com', ['p/', 'explore/', 'reel/', 'stories/']);
    } catch (_) {}
  }

  if (!result.facebook) {
    await pause(1200);
    try {
      const html = await ddgSearch(`${q} site:facebook.com`);
      result.facebook = extractFirstUrl(html, 'facebook.com', ['share', 'sharer', 'login', 'groups/', 'events/', 'posts/']);
    } catch (_) {}
  }

  if (!result.linkedin) {
    await pause(1200);
    try {
      const html = await ddgSearch(`${q} site:linkedin.com/company`);
      result.linkedin = extractFirstUrl(html, 'linkedin.com/company', []);
    } catch (_) {}
  }

  if (!result.email) {
    await pause(1200);
    try {
      const html = await ddgSearch(`${q} email contact`);
      // Extract emails from the snippet text in search results
      const snippets = html.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi) || [];
      const resultText = snippets.join(' ') + (html.match(EMAIL_REGEX) || []).join(' ');
      result.email = extractEmail(resultText);
    } catch (_) {}
  }

  // 4. If we found their Facebook page, scrape it for email (FB pages often list email)
  if (!result.email && result.facebook) {
    await pause(800);
    try {
      const fbHtml = await fetchPage(result.facebook);
      result.email = extractEmail(fbHtml);
    } catch (_) {}
  }

  return result;
}

// ---- DuckDuckGo HTML search ----

function ddgSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  return fetchPage(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://duckduckgo.com/',
  });
}

// ---- URL extraction ----

function extractFirstUrl(html, domain, excludePathParts) {
  // DDG HTML results use direct href links (no redirect wrappers)
  // Match both https:// links and href="..." patterns
  const domainEsc = domain.replace('.', '\\.').replace('/', '\\/');
  const patterns = [
    new RegExp(`href="(https?://(?:www\\.)?${domainEsc}/[^"?#\\s]{2,})"`, 'gi'),
    new RegExp(`(https?://(?:www\\.)?${domainEsc}/[^"'\\s<>?#]{2,})`, 'gi'),
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[1].split('?')[0].replace(/\/$/, '');
      const path = url.split(domain)[1] || '';
      if (path.length < 3) continue; // just the domain root
      if (excludePathParts.some(ex => path.includes(ex))) continue;
      return url;
    }
  }
  return null;
}

// ---- Email extraction ----

function extractEmail(text) {
  const BAD = [
    'example.com', 'yourdomain', 'test.com', 'domain.com',
    'email@', '@email', 'sentry.io', 'google.com', 'apple.com',
    'microsoft.com', 'amazon.com', 'duckduckgo.com', 'bing.com',
    'wixpress.com', 'squarespace.com', 'shopify.com', 'wordpress.com',
    '.png', '.jpg', '.svg', '.gif',
  ];
  const emails = text.match(EMAIL_REGEX) || [];
  return emails.find(e => {
    const l = e.toLowerCase();
    return !BAD.some(bad => l.includes(bad));
  }) || null;
}

// ---- HTTP fetch helper ----

function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
    };

    const req = lib.get(url, opts, (res) => {
      // Follow redirects (max 4)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let next = res.headers.location;
        if (next.startsWith('/')) {
          const parsed = new URL(url);
          next = `${parsed.protocol}//${parsed.host}${next}`;
        }
        res.resume();
        return fetchPage(next, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 500_000) res.destroy(); });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function cleanUrl(url) {
  if (!url.startsWith('http')) return 'https://' + url;
  return url.split('?')[0];
}

function pause(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { enrichLead };

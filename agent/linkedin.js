// LinkedIn finder — uses Bing search to locate company/owner pages
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

async function findLinkedIn(page, { name, city, country }, log) {
  const result = { companyUrl: null, ownerName: null, ownerUrl: null };

  log(`💼 Searching LinkedIn for: ${name}`);
  const loc = [city, country].filter(Boolean).join(', ');

  // Step 1 — find company page via Bing
  try {
    const query = `"${name}" ${loc} site:linkedin.com/company`;
    const html = await bingSearch(page, query);
    const m = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/([A-Za-z0-9._\-]+)/);
    if (m) {
      result.companyUrl = m[0].split('?')[0];
      log(`💼 Found company LinkedIn: ${result.companyUrl}`);
    }
  } catch (_) {}

  // Step 2 — find owner/founder via Bing
  try {
    const query = `"${name}" ${loc} (owner OR founder OR CEO OR manager) site:linkedin.com/in`;
    const html = await bingSearch(page, query);
    const m = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9._\-]+)/);
    if (m) {
      result.ownerUrl = m[0].split('?')[0];
      const slug = result.ownerUrl.split('/in/')[1] || '';
      result.ownerName = slug.replace(/-\d+$/, '').replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase()).trim() || null;
      log(`💼 Found owner: ${result.ownerName || result.ownerUrl}`);
    }
  } catch (_) {}

  return result;
}

async function bingSearch(page, query) {
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    { waitUntil: 'domcontentloaded', timeout: 18000 });
  await delay(1000);
  return page.content();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { findLinkedIn };

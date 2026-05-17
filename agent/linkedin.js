// LinkedIn agentic scraper — finds company page + owner using browser search
// Uses DuckDuckGo to locate LinkedIn URLs, then attempts to visit them.
// LinkedIn blocks most bot access, so we extract what we can from search snippets.
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

async function findLinkedIn(page, { name, city, country }, log) {
  const result = {
    companyUrl: null,
    ownerName: null,
    ownerUrl: null,
  };

  log(`💼 Searching LinkedIn for: ${name}`);

  // Step 1 — Find company page URL via DuckDuckGo
  try {
    const query = `"${name}" ${city || ''} site:linkedin.com/company`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(ddgUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(800);

    const html = await page.content();
    const companyMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/([A-Za-z0-9._\-]+)/);
    if (companyMatch) {
      result.companyUrl = companyMatch[0].split('?')[0];
      log(`💼 Found company LinkedIn: ${result.companyUrl}`);
    }
  } catch (_) {}

  // Step 2 — Find owner/founder via DuckDuckGo
  try {
    const ownerQuery = `"${name}" ${city || ''} (owner OR founder OR CEO OR "managing director") site:linkedin.com/in`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(ownerQuery)}`;
    await page.goto(ddgUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(800);

    const html = await page.content();
    const ownerUrlMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9._\-]+)/);
    if (ownerUrlMatch) {
      result.ownerUrl = ownerUrlMatch[0].split('?')[0];

      // Try to extract owner name from the snippet text around the URL
      const snippetRegex = new RegExp(`([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)+)(?:[^<]{0,100})${result.ownerUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const nameMatch = html.match(snippetRegex);
      if (nameMatch) result.ownerName = nameMatch[1].trim();

      if (!result.ownerName) {
        // Extract name from LinkedIn /in/ slug
        const slug = result.ownerUrl.split('/in/')[1] || '';
        result.ownerName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || null;
      }
      log(`💼 Found owner: ${result.ownerName || result.ownerUrl}`);
    }
  } catch (_) {}

  // Step 3 — If we have a company URL, try to visit it (best effort — often needs login)
  if (result.companyUrl && !result.ownerName) {
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await page.goto(result.companyUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(DELAY);

      // Extract what's visible before login wall
      const title = await page.title();
      if (title && !title.toLowerCase().includes('linkedin')) {
        // We got through, try to get company description
        const desc = await page.$eval('p.description, .org-top-card-summary__tagline', el => el.textContent.trim()).catch(() => null);
        if (desc) log(`💼 Company info: ${desc.slice(0, 80)}`);
      }
    } catch (_) {}
  }

  return result;
}

module.exports = { findLinkedIn };

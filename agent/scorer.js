// Lead scorer — sends gathered data to OpenAI for a structured score, an
// independence check (drops chains worldwide), and an outreach message.
const { OpenAI } = require('openai');

// 20s timeout / 1 retry — the SDK default (10 min, 2 retries) caused the hangs.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 1 });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function scoreLead(data) {
  const {
    name, category, city, country, address, phone, website, websiteStatus,
    rating, reviewCount, instagramHandle, instagramFollowers,
    linkedinCompanyUrl, ownerName, email,
  } = data;

  const websiteDesc = {
    none: 'NO website at all',
    social_only: 'Only a social media page (not a real site)',
    linktree: 'Only a Linktree bio link',
    menu_only: 'Only a menu/PDF, no booking or contact features',
    outdated: 'An outdated website that likely needs a rebuild',
    basic: 'A very basic website with minimal content',
    good: 'A good modern website',
  }[websiteStatus] || 'Website status unknown';

  const prompt = `You are a lead-qualification expert for a web-development agency.

BUSINESS:
- Name: ${name}
- Category: ${category}
- Location: ${city}, ${country}
- Phone: ${phone || 'not found'}
- Website: ${websiteDesc}
- Google Rating: ${rating || 'N/A'}/5 (${reviewCount || 0} reviews)
- Instagram: ${instagramHandle ? `@${instagramHandle} — ${instagramFollowers?.toLocaleString() || '?'} followers` : 'not found'}
- LinkedIn: ${linkedinCompanyUrl ? 'found' : 'not found'}
- Owner: ${ownerName || 'unknown'}
- Email: ${email || 'not found'}

First decide is_independent: true if this is a single independent local business
(a good lead); false if it is a chain, franchise, or large multi-location brand
(NOT a lead — we only want independents).

ai_score (1-10): higher = better lead for website services
  9-10: no/bad website + established (50+ reviews) + clearly needs digital presence
  7-8 : no/bad website + decent (10-50 reviews)
  5-6 : no/basic website + small or newer business
  3-4 : has an ok website, might want an upgrade
  1-2 : has a good modern website OR is a chain → not a good lead

marketing_score (1-10): how active their online marketing already is.

outreach_message: 3-4 friendly, non-salesy sentences mentioning their name and
something specific; offer website help. Only if ai_score >= 5, else null.

Respond in JSON:
{ "is_independent": true, "ai_score": <int>, "marketing_score": <int>, "ai_reasoning": "<one sentence>", "outreach_message": "<message or null>" }`;

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 320,
      temperature: 0.5,
    });
    const r = JSON.parse(res.choices[0].message.content);
    return {
      isIndependent: r.is_independent !== false, // default to keeping it
      aiScore: clamp(r.ai_score, 5),
      marketingScore: clamp(r.marketing_score, 5),
      aiReasoning: r.ai_reasoning || '',
      outreachMessage: r.outreach_message || null,
    };
  } catch {
    const hasWebsite = websiteStatus && !['none', 'social_only', 'linktree'].includes(websiteStatus);
    return {
      isIndependent: true,
      aiScore: hasWebsite ? 3 : 6,
      marketingScore: instagramHandle ? 5 : 2,
      aiReasoning: 'AI scoring temporarily unavailable.',
      outreachMessage: null,
    };
  }
}

function clamp(v, dflt) { return Math.min(10, Math.max(1, parseInt(v, 10) || dflt)); }

module.exports = { scoreLead };

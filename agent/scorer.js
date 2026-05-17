// Lead scorer — sends all gathered data to OpenAI and gets structured score + outreach message
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function scoreLead(data) {
  const {
    name, category, city, country, address, phone, website, websiteStatus,
    rating, reviewCount, instagramHandle, instagramFollowers, instagramPostsPerMonth,
    instagramLastPost, linkedinCompanyUrl, ownerName, email,
  } = data;

  const websiteDesc = {
    none: 'NO website at all',
    social_only: 'Website is just a social media page (not a real site)',
    linktree: 'Website is only a Linktree bio link',
    menu_only: 'Website is just a menu/PDF with no booking or contact features',
    outdated: 'Has an outdated website that likely needs a full rebuild',
    basic: 'Has a very basic website with minimal content',
    good: 'Has a good modern website',
  }[websiteStatus] || 'Website unknown';

  const igLastPostAge = instagramLastPost
    ? Math.round((Date.now() - new Date(instagramLastPost).getTime()) / (86400000)) + ' days ago'
    : 'unknown';

  const prompt = `You are a lead qualification expert for a web development agency.

BUSINESS:
- Name: ${name}
- Category: ${category}
- Location: ${city}, ${country}
- Phone: ${phone || 'not found'}
- Website: ${websiteDesc}
- Google Rating: ${rating || 'N/A'}/5 (${reviewCount} reviews)
- Instagram: ${instagramHandle ? `@${instagramHandle} — ${instagramFollowers?.toLocaleString() || '?'} followers, ${instagramPostsPerMonth || '?'} posts/month, last post ${igLastPostAge}` : 'not found'}
- LinkedIn: ${linkedinCompanyUrl ? 'found' : 'not found'}
- Owner: ${ownerName || 'unknown'}
- Email: ${email || 'not found'}

SCORING (respond with integers):
ai_score (1-10):
  9-10: No/bad website + established business (50+ reviews) + clearly needs digital presence
  7-8: No/bad website + decent business (10-50 reviews) + good local presence
  5-6: No/basic website + small business, newer or fewer reviews
  3-4: Has ok website, might want upgrade
  1-2: Has a good modern website, not a good lead

marketing_score (1-10, how serious they are about marketing):
  9-10: Very active — posts daily/weekly, high followers, strong social presence
  6-8: Moderate — posts a few times a month, decent following
  3-5: Weak — rare posts, low followers, or only on one platform
  1-2: Almost no online marketing presence at all (actually means they NEED help more)

For the outreach_message:
- 3-4 sentences max
- Friendly and human, not salesy
- Mention their business name + something specific (rating, category, their social activity)
- Offer website development services naturally
- Only write this if ai_score >= 5, otherwise null

Respond in JSON:
{
  "ai_score": <number>,
  "marketing_score": <number>,
  "ai_reasoning": "<one sentence explaining the score>",
  "outreach_message": "<message or null>"
}`;

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 300,
      temperature: 0.5,
    });

    const result = JSON.parse(res.choices[0].message.content);
    return {
      aiScore: Math.min(10, Math.max(1, parseInt(result.ai_score) || 5)),
      marketingScore: Math.min(10, Math.max(1, parseInt(result.marketing_score) || 5)),
      aiReasoning: result.ai_reasoning || '',
      outreachMessage: result.outreach_message || null,
    };
  } catch (err) {
    // Fallback scoring without AI
    const hasWebsite = websiteStatus && websiteStatus !== 'none' && websiteStatus !== 'social_only';
    return {
      aiScore: hasWebsite ? 3 : 6,
      marketingScore: instagramHandle ? 5 : 2,
      aiReasoning: 'AI scoring temporarily unavailable.',
      outreachMessage: null,
    };
  }
}

module.exports = { scoreLead };

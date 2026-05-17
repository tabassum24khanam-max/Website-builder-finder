// ============================================================
//  ai.js — AI Lead Qualification & Outreach Message Generator
//  Uses OpenAI GPT-4o-mini (cheapest + fast, ~$0.01 per lead)
// ============================================================

const OpenAI = require('openai');

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * Qualifies a lead using AI.
 * Reads business data + reviews and returns a score, reasoning,
 * website detection, and a personalized outreach message.
 */
async function qualifyLead({ name, category, address, phone, website, rating, reviewCount, reviewSnippets, city }) {
  try {
    const reviewText = reviewSnippets && reviewSnippets.length > 0
      ? reviewSnippets.slice(0, 5).join('\n- ')
      : 'No reviews available';

    const prompt = `You are a lead qualification AI for a professional web development agency based in ${city}.

Your job is to analyze a local business and determine:
1. Whether they have a website
2. How strong a lead they are for website development services
3. A personalized outreach message if they have no website

BUSINESS DETAILS:
- Name: ${name}
- Category: ${category}
- City: ${city}
- Address: ${address || 'Not listed'}
- Phone: ${phone || 'Not listed'}
- Website Field: ${website ? website : 'EMPTY - No website listed'}
- Google Rating: ${rating}/5 stars
- Total Reviews: ${reviewCount}

RECENT CUSTOMER REVIEWS:
- ${reviewText}

SCORING CRITERIA (1-10 scale):
- 9-10: No website + high reviews (50+) + customers mention needing online presence
- 7-8: No website + decent reviews (10-50) + established local business
- 5-6: No website + few reviews + small/new business
- 3-4: Has website but it might be outdated or broken
- 1-2: Has a good website OR is a large chain/franchise

RESPOND IN VALID JSON ONLY. No extra text. Format:
{
  "hasWebsite": false,
  "score": 8,
  "reasoning": "Popular restaurant with 120 reviews and no website. Customers mention wanting to see menu online.",
  "reviewInsight": "One sentence summary of what reviews reveal about their online presence needs",
  "outreachMessage": "Personalized 3-4 sentence cold outreach message mentioning their business name, something specific from their reviews, and offering website services. Be friendly, not salesy. OR null if they have a website."
}`;

    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 500
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Safety checks
    result.hasWebsite = !!(website && website.trim().length > 0);
    result.score = Math.min(10, Math.max(1, parseInt(result.score) || 5));

    return result;

  } catch (err) {
    console.error(`[AI] Error qualifying "${name}":`, err.message);
    // Fallback without AI
    const hasWebsite = !!(website && website.trim().length > 0);
    return {
      hasWebsite,
      score: hasWebsite ? 2 : 6,
      reasoning: 'AI qualification temporarily unavailable — scored by website presence only.',
      reviewInsight: 'Could not analyze reviews.',
      outreachMessage: hasWebsite ? null : `Hi ${name}! We noticed your business doesn't have a website yet. We specialize in building professional websites for local businesses in ${city}. We'd love to help you get online and attract more customers. Would you be open to a quick chat?`
    };
  }
}

/**
 * Regenerates just the outreach message for a specific lead.
 * Called when user clicks "Regenerate Message" in dashboard.
 */
async function regenerateMessage(lead, customInstructions = '') {
  try {
    const prompt = `Write a short, personalized cold outreach message for this business offering professional website development services.

Business: ${lead.name}
Category: ${lead.category}
City: ${lead.city || 'Riyadh'}
Rating: ${lead.rating}/5 (${lead.reviewCount} reviews)
${customInstructions ? `Special instructions: ${customInstructions}` : ''}

Rules:
- 3-4 sentences max
- Friendly, not salesy
- Mention their business name
- Mention something specific (their category, their good reviews, etc.)
- End with a soft call to action
- No emojis

Return ONLY the message text, nothing else.`;

    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 200
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error('[AI] Error regenerating message:', err.message);
    throw err;
  }
}

module.exports = { qualifyLead, regenerateMessage };

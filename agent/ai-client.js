// One AI gateway for every model call in the app.
//
// The provider is chosen by which key is configured (DeepSeek wins when both
// are set — it's the cheap option, so setting its key is an explicit choice):
//
//   DEEPSEEK_API_KEY → https://api.deepseek.com  model: deepseek-chat
//                      (DeepSeek's OpenAI-compatible API; "deepseek-chat"
//                      always points at their latest chat model and supports
//                      function calling, which the agents need. The reasoner
//                      model does NOT support tools — don't use it here.)
//   OPENAI_API_KEY   → api.openai.com  models per OPENAI_MODEL / AI_MODE_MODEL
//
// getAI(kind, opts) → { client, model, fallbackModel, provider } or null when
// no usable key is configured (callers skip their AI step in that case).
//   kind 'fast' — enrichment, query generation, phone agent (cheap model)
//   kind 'deep' — AI deep-search mode (frontier model where the provider has one)

const { OpenAI } = require('openai');

const PLACEHOLDER = /paste-your-key/i;

const _clients = new Map(); // config signature → OpenAI client

function getAI(kind = 'fast', { timeoutMs = 30000, maxRetries = 0 } = {}) {
  const dsKey = process.env.DEEPSEEK_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;

  let baseURL, apiKey, model, fallbackModel, provider;
  if (dsKey && !PLACEHOLDER.test(dsKey)) {
    provider = 'deepseek';
    baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    apiKey = dsKey;
    model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    fallbackModel = model;
  } else if (oaKey && !PLACEHOLDER.test(oaKey)) {
    provider = 'openai';
    baseURL = undefined; // SDK default
    apiKey = oaKey;
    const fast = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    model = kind === 'deep' ? (process.env.AI_MODE_MODEL || 'gpt-4o') : fast;
    fallbackModel = fast;
  } else {
    return null;
  }

  const sig = [provider, baseURL || '', timeoutMs, maxRetries].join('|');
  if (!_clients.has(sig)) {
    _clients.set(sig, new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries }));
  }
  return { client: _clients.get(sig), model, fallbackModel, provider };
}

const aiConfigured = () => !!getAI();

module.exports = { getAI, aiConfigured };

// Minimal PayPal REST client — OAuth2 client_credentials + the handful of
// Subscriptions API calls this app needs. PAYPAL_MODE=live switches off
// sandbox; everything defaults to sandbox so a missing/unset mode can never
// accidentally hit real money.

const https = require('https');

function baseHost() {
  return process.env.PAYPAL_MODE === 'live' ? 'api-m.paypal.com' : 'api-m.sandbox.paypal.com';
}

function request(method, path, { body, basicAuth, token } = {}) {
  return new Promise((resolve, reject) => {
    const isForm = typeof body === 'string';
    const data = body ? (isForm ? body : JSON.stringify(body)) : null;
    const headers = { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (basicAuth) headers.Authorization = 'Basic ' + Buffer.from(basicAuth).toString('base64');
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname: baseHost(), path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j;
        try { j = d ? JSON.parse(d) : {}; } catch { j = { raw: d }; }
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(j.message || `PayPal ${method} ${path} → HTTP ${res.statusCode}`), { status: res.statusCode, body: j }));
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('PayPal request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

let cachedToken = null;
let tokenExpiresAt = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set');
  const r = await request('POST', '/v1/oauth2/token', { body: 'grant_type=client_credentials', basicAuth: `${id}:${secret}` });
  cachedToken = r.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, (r.expires_in || 0) - 60) * 1000; // renew a minute early
  return cachedToken;
}

async function api(method, path, body) {
  const token = await getAccessToken();
  return request(method, path, { body, token });
}

// ── Subscriptions ────────────────────────────────────────────────────────────

async function getSubscription(subscriptionId) {
  return api('GET', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

// PayPal returns 204 No Content on success — request() already treats an
// empty body as {} rather than a parse error, so this resolves to {}.
async function cancelSubscription(subscriptionId, reason) {
  return api('POST', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    reason: reason || 'Customer requested cancellation',
  });
}

// Used by the owner dashboard's billing-health check — confirms a configured
// PAYPAL_PLAN_ID_* actually exists (and is active) under THIS Client
// ID/Secret's account, rather than assuming Railway's env vars are correct.
async function getPlan(planId) {
  return api('GET', `/v1/billing/plans/${encodeURIComponent(planId)}`);
}

async function getWebhook(webhookId) {
  return api('GET', `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`);
}

// ── Webhook signature verification ───────────────────────────────────────────
// Delegated to PayPal's own verify endpoint rather than reimplementing their
// signature crypto locally — simpler and avoids byte-exact re-serialization
// bugs. `webhookEvent` is the already-JSON-parsed request body.
async function verifyWebhookSignature(headers, webhookEvent) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID not set');
  const r = await api('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: webhookEvent,
  });
  return r.verification_status === 'SUCCESS';
}

// ── One-time setup: create the Product + monthly Plans ───────────────────────
// Run via scripts/paypal-setup.js once credentials exist — prints the Plan
// IDs to paste into Railway as PAYPAL_PLAN_ID_STARTER / PAYPAL_PLAN_ID_PRO.
async function createProductAndPlans() {
  const { TIERS } = require('../db/tiers');
  const product = await api('POST', '/v1/catalogs/products', {
    name: 'LeadHunter AI', type: 'SERVICE', category: 'SOFTWARE',
  });

  const plans = {};
  for (const key of ['starter', 'pro']) {
    const tier = TIERS[key];
    const plan = await api('POST', '/v1/billing/plans', {
      product_id: product.id,
      name: `LeadHunter ${tier.label}`,
      description: `${tier.monthlySearches} searches/month${tier.aiMode ? ' + AI deep search' : ''}`,
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0, // 0 = renews indefinitely until cancelled
        pricing_scheme: { fixed_price: { value: tier.price.toFixed(2), currency_code: 'USD' } },
      }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
    });
    plans[key] = plan.id;
  }
  return { productId: product.id, plans };
}

// Registers a webhook subscription pointed at our /api/billing/webhook route,
// scoped to just the events routes/billing.js actually handles.
async function createWebhook(url) {
  return api('POST', '/v1/notifications/webhooks', {
    url,
    event_types: [
      { name: 'BILLING.SUBSCRIPTION.ACTIVATED' },
      { name: 'BILLING.SUBSCRIPTION.CANCELLED' },
      { name: 'BILLING.SUBSCRIPTION.EXPIRED' },
      { name: 'BILLING.SUBSCRIPTION.SUSPENDED' },
      { name: 'PAYMENT.SALE.COMPLETED' },
    ],
  });
}

module.exports = { getAccessToken, api, getSubscription, cancelSubscription, getPlan, getWebhook, verifyWebhookSignature, createProductAndPlans, createWebhook };

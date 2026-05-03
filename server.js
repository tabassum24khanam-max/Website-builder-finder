// ============================================================
//  server.js — Backend Server & API
//  Run this with: node server.js
//  Then open: http://localhost:3000 in your browser
// ============================================================

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { scrapeGoogleMaps } = require('./scraper');
const { qualifyLead, regenerateMessage } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const LEADS_FILE = path.join(__dirname, 'leads.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- State ----
let leads = loadLeads();
let isScrapingActive = false;
let stopScraping = false;
let sseClients = [];

// ============================================================
//  SSE — Real-time updates pushed to the browser dashboard
// ============================================================

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write('data: {"type":"connected"}\n\n');

  const clientId = `${Date.now()}-${Math.random()}`;
  sseClients.push({ id: clientId, res });

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try { client.res.write(msg); } catch (_) {}
  });
}

// ============================================================
//  API: Leads
// ============================================================

// Get all leads (with optional filters)
app.get('/api/leads', (req, res) => {
  let result = [...leads];
  const { noWebsiteOnly, minScore, category, status } = req.query;

  if (noWebsiteOnly === 'true') result = result.filter(l => !l.hasWebsite);
  if (minScore) result = result.filter(l => l.aiScore >= parseInt(minScore));
  if (category && category !== 'all') result = result.filter(l => l.category?.toLowerCase().includes(category.toLowerCase()));
  if (status && status !== 'all') result = result.filter(l => l.status === status);

  res.json({ leads: result, total: result.length, scraping: isScrapingActive });
});

// Get single lead
app.get('/api/leads/:id', (req, res) => {
  const lead = leads.find(l => l.id === req.params.id);
  lead ? res.json(lead) : res.status(404).json({ error: 'Lead not found' });
});

// Update lead status or notes
app.put('/api/leads/:id', (req, res) => {
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const allowed = ['status', 'notes', 'outreachMessage'];
  allowed.forEach(field => {
    if (req.body[field] !== undefined) lead[field] = req.body[field];
  });
  lead.updatedAt = new Date().toISOString();

  saveLeads();
  broadcast({ type: 'lead_updated', lead });
  res.json({ success: true, lead });
});

// Delete a lead
app.delete('/api/leads/:id', (req, res) => {
  leads = leads.filter(l => l.id !== req.params.id);
  saveLeads();
  res.json({ success: true });
});

// Delete ALL leads
app.delete('/api/leads', (req, res) => {
  leads = [];
  saveLeads();
  res.json({ success: true });
});

// Regenerate outreach message for a lead
app.post('/api/leads/:id/regenerate', async (req, res) => {
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  try {
    const newMessage = await regenerateMessage(lead, req.body.instructions || '');
    lead.outreachMessage = newMessage;
    lead.updatedAt = new Date().toISOString();
    saveLeads();
    res.json({ success: true, outreachMessage: newMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  API: Scraping
// ============================================================

app.get('/api/scrape/status', (req, res) => {
  res.json({ active: isScrapingActive, totalLeads: leads.length });
});

app.post('/api/scrape/start', async (req, res) => {
  if (isScrapingActive) {
    return res.json({ success: false, message: 'Already scraping. Stop it first.' });
  }

  const { category = 'restaurants', city = 'Riyadh', limit = 50 } = req.body;

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-paste-your-key-here') {
    return res.status(400).json({ error: 'OpenAI API key not configured. Check your .env file.' });
  }

  res.json({ success: true, message: `Starting scraper for "${category}" in ${city}` });

  // Run scraper in background
  isScrapingActive = true;
  stopScraping = false;

  broadcast({ type: 'scrape_started', category, city, limit });

  runScraper(category, city, parseInt(limit))
    .then(() => {
      isScrapingActive = false;
      broadcast({ type: 'scrape_done', totalLeads: leads.length });
    })
    .catch(err => {
      isScrapingActive = false;
      broadcast({ type: 'scrape_error', message: err.message });
    });
});

app.post('/api/scrape/stop', (req, res) => {
  stopScraping = true;
  isScrapingActive = false;
  broadcast({ type: 'scrape_stopped' });
  res.json({ success: true, message: 'Stopping scraper after current business...' });
});

async function runScraper(category, city, limit) {
  await scrapeGoogleMaps(
    category,
    city,
    limit,
    // Called for each scraped business — qualify with AI then save
    async (businessData) => {
      if (stopScraping) return;

      broadcast({ type: 'status', message: `🤖 AI qualifying: ${businessData.name}...` });

      const aiResult = await qualifyLead(businessData);

      const lead = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        ...businessData,
        hasWebsite: aiResult.hasWebsite,
        aiScore: aiResult.score,
        aiReasoning: aiResult.reasoning,
        reviewInsight: aiResult.reviewInsight,
        outreachMessage: aiResult.outreachMessage,
        status: 'new',
        scrapedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Check for duplicates
      const duplicate = leads.find(l =>
        l.name?.toLowerCase() === lead.name?.toLowerCase() &&
        l.address?.toLowerCase() === lead.address?.toLowerCase()
      );
      if (duplicate) {
        broadcast({ type: 'status', message: `⏭️ Skipping duplicate: ${lead.name}` });
        return;
      }

      leads.push(lead);
      saveLeads();
      broadcast({ type: 'new_lead', lead });
    },
    // Status messages
    (message) => {
      broadcast({ type: 'status', message });
    },
    // Should stop check
    () => stopScraping
  );
}

// ============================================================
//  API: Export CSV
// ============================================================

app.get('/api/export', (req, res) => {
  const { noWebsiteOnly, minScore } = req.query;
  let exportLeads = [...leads];

  if (noWebsiteOnly === 'true') exportLeads = exportLeads.filter(l => !l.hasWebsite);
  if (minScore) exportLeads = exportLeads.filter(l => l.aiScore >= parseInt(minScore));

  const headers = [
    'Business Name', 'Category', 'Phone', 'Address', 'Website',
    'Has Website', 'Rating', 'Review Count', 'AI Score', 'AI Reasoning',
    'Review Insight', 'Outreach Message', 'Status', 'Scraped At'
  ];

  const rows = exportLeads.map(l => [
    l.name, l.category, l.phone, l.address, l.website,
    l.hasWebsite ? 'Yes' : 'No', l.rating, l.reviewCount,
    l.aiScore, l.aiReasoning, l.reviewInsight, l.outreachMessage,
    l.status, l.scrapedAt
  ]);

  const escape = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map(row => row.map(escape).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=leads-${Date.now()}.csv`);
  res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
});

// ============================================================
//  API: Stats
// ============================================================

app.get('/api/stats', (req, res) => {
  const total = leads.length;
  const noWebsite = leads.filter(l => !l.hasWebsite).length;
  const highScore = leads.filter(l => l.aiScore >= 7).length;
  const contacted = leads.filter(l => l.status === 'contacted').length;
  const replied = leads.filter(l => l.status === 'replied').length;
  const converted = leads.filter(l => l.status === 'converted').length;

  // Category breakdown
  const byCategory = {};
  leads.forEach(l => {
    const cat = l.category || 'Unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });

  res.json({ total, noWebsite, highScore, contacted, replied, converted, byCategory });
});

// ============================================================
//  Helpers
// ============================================================

function loadLeads() {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
    }
  } catch (_) {}
  return [];
}

function saveLeads() {
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Server] Failed to save leads:', err.message);
  }
}

// ============================================================
//  Start Server
// ============================================================

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════╗');
  console.log('  ║   🚀 Lead Gen Dashboard is RUNNING!    ║');
  console.log('  ╠════════════════════════════════════════╣');
  console.log(`  ║   Open in browser: http://localhost:${PORT} ║`);
  console.log('  ╚════════════════════════════════════════╝');
  console.log('');
  console.log(`  Loaded ${leads.length} existing leads from disk.`);
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-paste-your-key-here') {
    console.log('  ⚠️  WARNING: OpenAI API key not set! Edit the .env file.');
  } else {
    console.log('  ✅ OpenAI API key loaded.');
  }
  console.log('');
});

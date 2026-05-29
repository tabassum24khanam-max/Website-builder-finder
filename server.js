require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const path = require('path');
const { v4: uuid } = require('uuid');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { q } = require('./db');
const { runSearch, stopSearch } = require('./agent');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket broadcast helpers ────────────────────────────────────────────

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send current search status on connect
  ws.send(JSON.stringify({ type: 'connected' }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (_) {}
  }
}

// ─── Searches ────────────────────────────────────────────────────────────────

app.get('/api/searches', (req, res) => {
  res.json(q.listSearches.all());
});

app.get('/api/searches/:id', (req, res) => {
  const search = q.getSearch.get(req.params.id);
  if (!search) return res.status(404).json({ error: 'Not found' });
  const leads = q.getLeadsBySearch.all(req.params.id);
  res.json({ ...search, leads });
});

app.delete('/api/searches/:id', (req, res) => {
  q.deleteSearch.run(req.params.id);
  res.json({ success: true });
});

app.post('/api/searches', (req, res) => {
  const {
    category, location, country = '',
    radius_km, radius, limit_count, count,
    lat, lng, zip, street,
    no_website_only = true,
  } = req.body;
  const effectiveRadius = parseInt(radius_km || radius) || 5;
  const effectiveCount = parseInt(limit_count || count) || 20;

  // The Serper `location` param only handles city-level targeting — neighborhoods
  // and zip codes are ignored. Keep the primary location CLEAN (city or zip only).
  // The `street` field holds the neighborhood/district; it goes into `q` via the
  // AI query generator, not the `location` param.
  const cleanLocation = (location || zip || '').trim();
  const neighborhood = (street || '').trim() || null;
  if (!category || !cleanLocation) {
    return res.status(400).json({ error: 'category and a location (city or zip) are required' });
  }
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-paste-your-key-here') {
    return res.status(400).json({ error: 'OpenAI API key not configured. Check your .env file.' });
  }

  const searchId = uuid();
  q.insertSearch.run({
    id: searchId, category, location: cleanLocation, country,
    radius_km: effectiveRadius, limit_count: effectiveCount,
  });
  const search = q.getSearch.get(searchId);

  // Attach extra fields the agent needs but aren't in the DB schema
  search.lat = parseFloat(lat) || null;
  search.lng = parseFloat(lng) || null;
  search.no_website_only = !!no_website_only;
  search.neighborhood = neighborhood;

  res.json({ success: true, search });

  // Start agent in background
  broadcast({ type: 'search_started', search });
  runSearch(search, broadcast).catch(err => {
    broadcast({ type: 'search_error', searchId, error: err.message });
  });
});

app.post('/api/searches/:id/stop', (req, res) => {
  stopSearch(req.params.id);
  res.json({ success: true });
});

// ─── Leads ───────────────────────────────────────────────────────────────────

app.get('/api/leads', (req, res) => {
  const { db } = require('./db');
  const leads = db.prepare('SELECT * FROM leads ORDER BY scraped_at DESC').all();
  res.json(leads);
});

app.get('/api/leads/:id', (req, res) => {
  const lead = q.getLead.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
});

app.put('/api/leads/:id', (req, res) => {
  const lead = q.getLead.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const { status, notes, outreach_message } = req.body;
  q.updateLead.run({
    id: req.params.id,
    status: status ?? lead.status,
    notes: notes ?? lead.notes,
    outreach_message: outreach_message ?? lead.outreach_message,
  });
  broadcast({ type: 'lead_updated', lead: q.getLead.get(req.params.id) });
  res.json({ success: true });
});

app.delete('/api/leads/:id', (req, res) => {
  q.deleteLead.run(req.params.id);
  res.json({ success: true });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  res.json(q.stats.get());
});

// ─── Exports ─────────────────────────────────────────────────────────────────

app.get('/api/export/:searchId/excel', async (req, res) => {
  const leads = req.params.searchId === 'all'
    ? require('./db').db.prepare('SELECT * FROM leads ORDER BY ai_score DESC').all()
    : q.getLeadsBySearch.all(req.params.searchId);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');

  ws.columns = [
    { header: 'Business Name', key: 'name', width: 28 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'City', key: 'city', width: 16 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Website', key: 'website', width: 30 },
    { header: 'Website Status', key: 'website_status', width: 16 },
    { header: 'Rating', key: 'rating', width: 8 },
    { header: 'Reviews', key: 'review_count', width: 10 },
    { header: 'AI Score', key: 'ai_score', width: 10 },
    { header: 'Marketing Score', key: 'marketing_score', width: 16 },
    { header: 'AI Reasoning', key: 'ai_reasoning', width: 40 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Instagram', key: 'instagram_handle', width: 20 },
    { header: 'IG Followers', key: 'instagram_followers', width: 14 },
    { header: 'IG Posts/Month', key: 'instagram_posts_per_month', width: 14 },
    { header: 'IG Last Post', key: 'instagram_last_post', width: 14 },
    { header: 'LinkedIn', key: 'linkedin_company_url', width: 36 },
    { header: 'Owner', key: 'linkedin_owner_name', width: 20 },
    { header: 'Owner LinkedIn', key: 'linkedin_owner_url', width: 36 },
    { header: 'Outreach Message', key: 'outreach_message', width: 50 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Scraped At', key: 'scraped_at', width: 20 },
  ];

  // Header style
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1f2e' } };
  ws.getRow(1).height = 20;

  for (const lead of leads) {
    const row = ws.addRow(lead);
    // Color code by score
    const score = lead.ai_score || 0;
    const fill = score >= 8 ? '22c55e' : score >= 6 ? 'f0a500' : 'ef4444';
    row.getCell('ai_score').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + fill } };
    row.getCell('ai_score').font = { bold: true, color: { argb: 'FF000000' } };
  }

  ws.autoFilter = { from: 'A1', to: ws.columns[ws.columns.length - 1].letter + '1' };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=leads-${req.params.searchId}-${Date.now()}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/export/:searchId/pdf', async (req, res) => {
  const leads = req.params.searchId === 'all'
    ? require('./db').db.prepare('SELECT * FROM leads ORDER BY ai_score DESC').all()
    : q.getLeadsBySearch.all(req.params.searchId);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=leads-${Date.now()}.pdf`);
  doc.pipe(res);

  doc.fontSize(18).fillColor('#f0a500').text('LeadHunter AI — Lead Report', { align: 'center' });
  doc.fontSize(10).fillColor('#888').text(`Generated: ${new Date().toLocaleString()} | Total leads: ${leads.length}`, { align: 'center' });
  doc.moveDown();

  const cols = ['Name', 'Phone', 'Score', 'Website', 'Email', 'Instagram', 'Status'];
  const widths = [160, 100, 45, 120, 140, 110, 70];
  let x = 40;
  let y = doc.y;

  // Header row
  doc.fillColor('#1a1f2e').rect(40, y, 760, 18).fill();
  doc.fillColor('#ffffff').fontSize(8);
  cols.forEach((col, i) => {
    doc.text(col, x, y + 4, { width: widths[i], lineBreak: false });
    x += widths[i];
  });
  y += 20;

  // Data rows
  doc.fontSize(7);
  for (const lead of leads) {
    if (y > 530) { doc.addPage({ layout: 'landscape' }); y = 40; }
    const rowColor = (lead.ai_score || 0) >= 7 ? '#0f2318' : '#1a1f2e';
    doc.fillColor(rowColor).rect(40, y, 760, 16).fill();
    doc.fillColor('#e2e8f0');
    x = 40;
    const vals = [
      lead.name, lead.phone || '—', `${lead.ai_score || 0}/10`,
      lead.website_status || 'none', lead.email || '—',
      lead.instagram_handle ? `@${lead.instagram_handle}` : '—', lead.status || 'new',
    ];
    vals.forEach((val, i) => {
      doc.text(String(val).slice(0, 30), x + 2, y + 3, { width: widths[i] - 4, lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    y += 17;
  }

  doc.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   ⚡ LeadHunter AI v2  —  RUNNING        ║');
  console.log(`  ║   Open: http://localhost:${PORT}            ║`);
  console.log('  ╚══════════════════════════════════════════╝\n');
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-paste-your-key-here') {
    console.log('  ⚠️  WARNING: OPENAI_API_KEY not set. Edit .env file.\n');
  } else {
    console.log(`  ✅ OpenAI key loaded. Model: ${process.env.OPENAI_MODEL || 'gpt-4o-mini'}\n`);
  }
});

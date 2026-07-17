# LeadHunter — Find Local Businesses That Need a Website

A web app you open in your browser. Pick a business category, give it a locality
(a city, a neighborhood, a zip, a pasted Google-Maps link or Plus Code, or a pin
on the map), click **Start Search**, and it finds the real, independent local
businesses in **that locality only** — each with:

- 📞 **Phone number** (validated for the country, never invented)
- 📸 **Instagram** and 🎵 **TikTok** handles (strictly verified to belong to that business)
- 🌐 **Website or not** — businesses *without* one are your leads
- 📍 Exact location, rating, review count, and a one-click **Open on Google**

Chains and franchises (Starbucks, Dunkin, Gong Cha, …) are filtered out
automatically. Results stream in live; everything is saved and exportable to
**Excel** or **PDF**.

---

## Quick start (local)

```bash
npm install
cp .env.example .env    # optional — the app also runs with NO keys at all
npm start               # → http://localhost:3000
```

## API keys — all optional, each one upgrades quality

| Key | What it adds | Without it |
|---|---|---|
| `SERPER_API_KEY` (recommended) | Fast Google-quality discovery + enrichment (serper.dev, ~$1/1k searches) | Falls back to OpenStreetMap discovery + a free DuckDuckGo/Bing engine — slower, still works |
| `DEEPSEEK_API_KEY` **or** `OPENAI_API_KEY` | The **AI deep search** toggle + the agentic phone hunter (finds numbers a plain search misses). DeepSeek is the cheapest option and is preferred when both keys are set | Those two steps are skipped; basic enrichment still runs |
| `GOOGLE_PLACES_API_KEY` (best quality) | Becomes the primary source: the **exact phone + website Google Maps shows**, every time | Phone/website come from search results — very good, not perfect |
| `GOOGLE_MAPS_API_KEY` | Click-to-drop-pin on the search map | Map still shows and moves; set location by typing/pasting |

The app **degrades gracefully**: any key can be missing or out of credits and
searches still complete on the free path.

## Deploy on Railway

1. Push this repo to GitHub and create a new Railway project from it (the
   included `Dockerfile` + `railway.toml` are picked up automatically).
2. In **Variables**, add whichever keys you have (see table above) and
   `DATA_DIR=/data` with a mounted **Volume** at `/data` so leads survive
   redeploys.
3. Deploy. Open the generated URL — that's the app.

## How a search works

1. **Locality lock** — your input is resolved to a precise centre
   (map pin → Google-Maps link/Plus Code → street intersection → geocode), and
   every result is hard-filtered by distance. If a geocoder points at the wrong
   place, the results' own cluster overrides it — results never leak in from
   another city.
2. **Discovery** — Google Places (if key) → Serper → OpenStreetMap, chains
   filtered on every path, nearest first.
3. **Enrichment per business** — website/phone/address from search, Instagram
   first (small businesses keep their phone in the bio), TikTok, a second-pass
   backfill, then the AI phone hunter if a number is still missing. Every phone
   is country-shape-validated and must have actually appeared in a source; every
   handle must match the business. Wrong data is dropped, never shown.

## The dashboard

- **New Search** — category chips, locality fields, movable map, paste-a-location,
  radius/count, "only businesses without a website" filter, 🤖 AI deep search toggle.
- **All Leads** — sortable table (phone, Instagram, TikTok, LinkedIn, status),
  card and map views, pipeline status (new → contacted → replied → converted),
  notes, Excel/PDF export of everything.
- **History** — every past search with its results.
- **Analytics** — totals, no-website count, score distribution.

## Project layout

```
server.js          Express + WebSocket server, REST API, exports
public/index.html  The whole frontend (single file)
agent/             The search machine:
  index.js           orchestrator (discovery → per-business pipeline)
  places-api.js      Google Places discovery (exact phone/website)
  serper-places.js   Serper discovery + enrichment + backfill
  osm.js             OpenStreetMap discovery (keyless fallback)
  free-search.js     free DuckDuckGo/Bing engine (keyless fallback)
  ai-enrich.js       AI deep-search agent (searches + reads pages like a human)
  phone-agent.js     agentic phone-number hunter
  instagram.js / tiktok.js  strictly-verified handle finders
  locate.js          Maps-link / Plus-Code / intersection / address resolver
  util.js            phone validation, handle verification, shared helpers
db/index.js        SQLite (better-sqlite3), schema + migrations
```

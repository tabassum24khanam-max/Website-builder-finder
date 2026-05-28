# 🎯 PROJECT BRIEF — "LeadHunter" (Website-Builder Lead Finder)

You are taking over an existing project. Read this entire brief before writing any code.
The previous agent over-engineered things and introduced bugs. Your job is to make
the core flow **simple, reliable, and correct**. Do not add complexity that isn't asked for.

---

## 1. THE VISION (what this product is)

I run a web-development service. I need a tool that **finds local businesses that
do NOT have a proper website** so I can pitch them on building one.

The ideal lead is:
- A **real, independent local business** (a single café, a gym, a salon, a clinic, a restaurant) —
  **NOT a big chain or franchise** (no Starbucks, no McDonald's, no "Mr Biryani | Best Indian
  Cuisine" marketing-listing junk).
- A business that has **no website**, or only a weak online presence (just an Instagram page,
  a Linktree, an outdated site, or a menu-only page).
- A business I can actually **contact** — I need a phone number, an email, or an Instagram/social
  handle. A lead with zero contact info is worthless.

So the tool's whole point: **"Show me independent local businesses near X, in category Y, that
need a website, with their contact details so I can reach out."**

---

## 2. WHAT THE TOOL SHOULD DO (feature list)

This is a web app (Node.js + Express + a single-page front-end + SQLite). The user:

1. **Starts a search** from the UI: picks a **category** (e.g. "cafes"), a **location**
   (city / area / can drop a pin on a map / GPS), a **search radius**, a **result count**,
   and a checkbox **"Only businesses without a website."**

2. The backend agent then, for each business it finds, runs a **strict, ordered enrichment
   pipeline** and streams live progress to the UI over WebSocket ("Live Agent Log"):

   **The flow must be exactly this order, and must NOT get stuck on any step:**
   1. **Find businesses** in that category + location → get name, address, phone, coords,
      rating, review count, and website (if listed).
   2. **Website check** — Does it have a website?
      - If YES → analyze it (is it good / basic / outdated / menu-only / just social?).
        If the "only without website" filter is on and it has a real working site → **skip it.**
      - If NO → keep it as a strong lead, move on.
   3. **Instagram** — Find the business's **own** Instagram. Pull followers, post count,
      and read the **bio** (the bio often contains the phone number and email!).
   4. **LinkedIn** — Find the company page and, if possible, the owner/founder's name + profile.
   5. **Email** — From the website contact page, the Instagram bio, or a web search.
   6. **Phone** — Cascade: business phone → phone in Instagram bio → phone on website contact page.
   7. **Score the lead** with AI (1–10) — how good a prospect they are for a website pitch —
      and generate a short, friendly **outreach message**.
   8. **Save** to DB and show as a card + on the map. **Skip and don't save** any lead with
      zero contact info, and skip chains/franchises.

3. **Results UI**: a list of lead cards + detail panel (scores, contact info, map pin, AI
   reasoning, editable outreach message, pipeline status New/Contacted/Replied/Converted/Skipped,
   notes). **Export** to Excel and PDF.

---

## 3. CURRENT ARCHITECTURE (what already exists — reuse it, don't rebuild from scratch)

**Stack:** Node.js, Express, `ws` (WebSocket), `better-sqlite3`, OpenAI SDK, ExcelJS, PDFKit.
Deployed on **Railway** via Docker. DB is SQLite at `DATA_DIR` (Railway uses a `/data` volume).

```
server.js              Express + WebSocket server, REST API, Excel/PDF export
db/index.js            SQLite schema + prepared statements (searches + leads tables)
public/index.html      Entire front-end (single file, ~2600 lines: map, search form, lead cards)
agent/
  index.js             ⭐ Orchestrator — runs the per-business pipeline above
  serper-places.js     Business discovery via Serper.dev /places + fill-in-missing-fields
  instagram.js         Instagram finder (Serper /search; strict handle verification)
  linkedin.js          LinkedIn finder (Serper /search; verified match)
  email.js             Email finder (website contact page, IG bio, DDG, Hunter.io)
  website.js           Fetches a site + OpenAI classifies it (good/basic/outdated/etc.)
  scorer.js            Sends all data to OpenAI → ai_score, marketing_score, outreach msg
  places-api.js        (Optional) Google Places API discovery — only if GOOGLE_PLACES_API_KEY set
  osm.js               OpenStreetMap fallback discovery
  maps-ai.js, maps.js  ⚠️ OLD Playwright-based Google Maps scrapers — NO LONGER USED, can delete
```

**Discovery order in `agent/index.js`:** Serper `/places` (primary) → Google Places API
(only if key set) → OpenStreetMap (last resort).

### APIs / Environment variables
- `OPENAI_API_KEY` — **required.** Used for website classification + lead scoring.
  `OPENAI_MODEL` defaults to `gpt-4o-mini`.
- `SERPER_API_KEY` — **the main one.** Serper.dev wraps Google Search + Google Maps.
  - `/places` endpoint → business discovery (name, phone, address, coords, rating).
  - `/search` endpoint → finding Instagram, LinkedIn, filling missing phone/website.
  - Free tier = 2,500 queries. **One key powers discovery + IG + LinkedIn.**
- `GOOGLE_PLACES_API_KEY` — optional, currently NOT set. Leave it out unless needed.
- `HUNTER_API_KEY` — optional, for email finding (free 25/month).
- `DATA_DIR`, `PORT`, `HEADLESS`, `SCRAPE_DELAY_MS` — infra config.

> NOTE: The app **no longer uses Playwright/a browser for enrichment** — everything is
> HTTP/API calls now. (The Dockerfile still uses the Playwright base image and
> `package.json` still lists `playwright` — that's leftover and can be cleaned up, but it's
> not hurting anything. Discovery + enrichment are all API-based.)

### Git / Deploy
- Repo: `tabassum24khanam-max/website-builder-finder`
- **Work on branch `claude/lead-generation-app-3jkrA`.** Commit + push there.
  Railway auto-deploys on push to the connected branch.
- Do NOT open a pull request unless explicitly asked.

---

## 4. WHAT'S BROKEN RIGHT NOW (the problems you must fix)

Tested a live search in Riyadh for cafes/restaurants. Observed bugs (with real examples):

1. **❌ Businesses that clearly HAVE a website are shown as "No Website."**
   - *Belong Cafe* — Google shows `belongcafesa.com` right there. Tool said "No website listed."
   - *Mr Biryani* — has a site too. Still slipped through.
   - → Discovery isn't capturing the website field, and the fill-in step isn't reliably
     finding the obvious official site. The website detection must actually work.

2. **❌ A chain/marketing-listing got saved as a lead with a 0/10 score and totally empty fields.**
   - *"Mr Biryani | مستر برياني | Best Indian Cuisine in Ar Rawdah | Best Indian Restaurants in Riyadh"*
     — this is a franchise / SEO-spam listing. It was saved with NO phone, NO address, NO
     website, NO Instagram, score 0/10. **This should never be saved.** Chains and
     no-contact-info leads must be filtered out *before* saving.

3. **❌ Phone numbers that are clearly listed on Google are not captured.**
   - *Tahlia Cafe* — Google shows a phone and it has 1,100+ reviews. Tool saved it with
     phone "—", address "—", no Instagram. The phone must be pulled from the places result,
     and if missing, from the IG bio / website / a follow-up search.

4. **❌ Wrong Instagram account picked.**
   - *Belong Cafe* (real IG: `@belongcafe.sa`, 19.4K followers) — tool picked
     `@instafoodieksa`, a random food blogger. Instagram handle matching must be **strict**:
     the handle has to actually belong to the business, never a generic
     foodie/influencer/blogger account.

5. **❌ The agent HANGS / gets stuck.**
   - One run sat on "Analyzing @instafoodieksa…" / "Analyzing: BELONG" for **25 minutes.**
   - Likely cause: direct HTTP requests to `instagram.com` time out / hang on cloud IPs.
   - Every step needs a hard timeout and must move on. A single business should take seconds,
     not minutes. The whole pipeline must be resilient — one slow business can't freeze the run.

> I already attempted fixes for some of these in the latest commits
> (`agent/serper-places.js`, `agent/instagram.js`, `agent/linkedin.js`, `agent/index.js`),
> but I'm not confident they actually work end-to-end. **Verify the real behavior** — don't
> assume the existing code is correct. Test against these exact examples (Belong Cafe,
> Tahlia Cafe, Mr Biryani in Riyadh).

---

## 5. YOUR JOB

1. Read the existing `agent/` code and understand the current pipeline.
2. Fix the 5 problems above so that a search in Riyadh for "cafes" returns **real
   independent cafés, correctly flagged for website / no-website, with correct phone +
   correct Instagram + contact info, with no chains and no empty/stuck leads.**
3. Keep it **simple and fast.** Every external call needs a timeout. The pipeline must never hang.
4. Test your changes for real (don't just claim it works). Confirm the example businesses
   behave correctly.
5. Commit + push to `claude/lead-generation-app-3jkrA` so Railway redeploys.

Ask me for the `SERPER_API_KEY` / `OPENAI_API_KEY` if you need to run a live test — I'll
provide them or set them as Railway env vars.

**Priorities, in order:** (1) don't hang, (2) correct website detection, (3) filter chains +
no-contact leads, (4) correct phone, (5) correct Instagram. Simplicity over cleverness.

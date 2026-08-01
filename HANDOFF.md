# HANDOFF — LeadHunter AI

**Read this entire file before touching any code.** This document exists so that
work can continue with *any* AI coding assistant (Claude Code, Codex, Cline,
Cursor, whatever) — or a human developer — without re-explaining the project
from scratch. It replaces an older, now-outdated handoff file that only
covered the very first phase of this project.

This file has two audiences:
1. **An AI coding assistant** picking up this project — read the whole thing,
   especially "Architecture" and "Rules for whoever works on this next."
2. **The owner (non-technical)** — read "For the owner" below. You don't need
   to understand the code, just the checklist and the warnings.

---

## For the owner (start here if you're not technical)

You don't have a software background, so here's the short version:

- This is a **web app** that finds local businesses without a website, so you
  (or your customers) can pitch them on building one. People can use it free
  (5 searches, no signup) or pay monthly for more searches and an "AI Deep
  Research" mode.
- It's **hosted on Railway** (a cloud hosting service) and **built with
  whatever AI coding assistant you're chatting with**. Every time an assistant
  finishes work, it "pushes" the changes to GitHub, and Railway automatically
  rebuilds and redeploys the live site within a minute or two.
- **You don't need to know how to code to keep working on this.** You just
  need to talk to your AI assistant in plain English about what's wrong or
  what you want changed, the same way you have been. Paste screenshots when
  something looks broken — that works well.
- **What you DO need to manage yourself** (an AI assistant cannot do these for
  you, they require your own accounts/identity): your Railway account
  settings, your PayPal business account and its live credentials, your
  Serper.dev accounts, and deciding on policies like refunds.
- If you switch to a different AI tool (Codex, Cline, etc.), the very first
  thing to do is paste this file's contents into the new chat, or tell it
  "read HANDOFF.md in this repo first." That's the entire point of this file.

**Golden rule when things feel confusing:** ask your assistant to explain
what it's about to do *before* it does anything that sounds permanent
(deleting something, pushing to a "live"/"production" branch, spending real
money via PayPal). A good assistant will already pause and ask before
anything risky — but it's always fine to ask "will this affect real users or
real money?" before saying yes.

---

## 1. What this product is

**LeadHunter AI** — you give it a business category (e.g. "cafes") and a
location, and it finds real, independent local businesses in that area that
**don't have a website** (or only a weak one — just Instagram, a Linktree, an
outdated site). For each one it tries to get a phone number, email, and
verified Instagram/TikTok handle, scores how good a prospect they are, and
drafts an outreach message. Chains and franchises are filtered out
automatically. Results are saved, searchable, and exportable to Excel/PDF.

**Business model:** Free tier (5 searches ever, no signup required — guests
get a real account silently in the background), Starter ($9/mo), and Pro
($19.99/mo), billed through PayPal Subscriptions. See the tier table below.

---

## 2. Current live state

- **GitHub repo:** `tabassum24khanam-max/website-builder-finder`
- **Active branch:** `claude/inspiring-shannon-crcCD` — this is the branch
  Railway is configured to auto-deploy from. **Work on this branch** unless
  the owner explicitly says to use a different one. (There are older branches
  like `claude/lead-generation-app-3jkrA` and `main` from earlier phases —
  don't use those, they're stale.)
- **Hosting:** Railway, via the `Dockerfile` in this repo. Push to the branch
  above → Railway rebuilds and redeploys automatically (usually 1-2 minutes).
- **Live URL:** `https://website-builder-finder-nijear.up.railway.app` (the
  owner will confirm if this has changed).
- **Database:** SQLite, a single file, via `better-sqlite3`. **This is the
  single biggest operational risk in this project — see "Critical: the
  database" below before doing anything else.**
- **Payments:** PayPal Subscriptions, currently in **Sandbox (test) mode** —
  no real money moves yet. Going live requires the owner's real PayPal
  Business credentials (see "PayPal: sandbox vs. live" below).

---

## 3. CRITICAL: the database (read this before anything else)

The app stores everything — every user, every subscription, every lead — in
one SQLite file, opened at `DATA_DIR/leadhunter.db`.

**The Dockerfile already defaults `DATA_DIR=/data`.** That part is handled.
The part that is *not* automatic: Railway must have an actual **persistent
Volume** created and mounted at `/data` for this service. If that volume
doesn't exist, `/data` is just a folder inside the container that gets wiped
every single time the app redeploys — meaning every push from an AI assistant
would silently delete every user, every subscription, every lead ever found.

**How to verify this is safe (owner or assistant, either can check):**
Railway dashboard → the service → **Volumes** tab. There must be a volume
listed there, mounted at path `/data`. If that tab is empty, stop and fix
this before doing anything else — ask the owner to create one, or if you're
an AI assistant with Railway access, walk them through it.

There's also a **fixed bug** worth knowing about (commit `73bc36b` era): the
database's own migration code used to run in the wrong order and would crash
the server on a truly empty/fresh database (exactly what a first-time volume
mount would produce). That's fixed — `db/index.js` now creates tables before
running migrations before creating indexes. If you ever see a crash-on-boot
again after touching `db/index.js`, check that ordering first.

**Backups:** the Owner Dashboard (in the app, log in as the owner) has a
**"Download backup"** button. It uses SQLite's own consistent-snapshot API
(safe to use while the app is live and being used), not a raw file copy. Use
it before any risky migration, and definitely before switching Railway
projects/accounts.

---

## 4. Architecture map

```
server.js                 Express app + WebSocket server + all REST routes
                           except auth/billing/owner (those are in routes/)
db/
  index.js                SQLite connection, schema, migrations, all
                           prepared SQL statements (the "q" object)
  tiers.js                Single source of truth for Free/Starter/Pro limits
  session-store.js        Custom express-session store backed by the same
                           SQLite DB (avoids an extra dependency)
middleware/
  auth.js                 requireAuth / optionalAuth / requireOwner,
                           guest account provisioning, isGuestEmail/isOwnerEmail
routes/
  auth.js                 signup / login / logout / guest / claim / me
  billing.js              PayPal confirm / cancel / webhook
  owner.js                Owner-only: stats, users, messages, billing-health,
                           backup download, one-click PayPal plan setup
agent/                    The actual lead-finding machine
  index.js                ⭐ Orchestrator — discovery, then the per-business
                           enrichment pipeline, Stop handling
  places-api.js           Google Places discovery (only if key set) — best
                           quality, exact phone/website from Google Maps
  serper-places.js        Serper.dev discovery + enrichment + backfill
  serper-pool.js          Rotates across multiple Serper API keys, tracks
                           which is dead/active, fires a "low-keys" event
  osm.js                  OpenStreetMap discovery (free, keyless fallback)
  free-search.js          Free DuckDuckGo/Bing fallback search
  ai-enrich.js            "AI Deep Research" mode — an AI agent that visits
                           sites/socials like a human instead of one lookup
  phone-agent.js          Agentic phone-number hunter (AI mode)
  instagram.js/tiktok.js  Strictly-verified social handle finders
  locate.js               Resolves pasted Maps links / Plus Codes / addresses
  paypal-client.js        Minimal PayPal REST client (OAuth2, Subscriptions,
                           Plans, Webhooks) — sandbox by default, PAYPAL_MODE=
                           live switches to real money
  util.js                 Phone validation, timeouts, shared helpers
public/index.html          THE ENTIRE FRONTEND — one file (~4700 lines):
                           landing page, login/signup screens, the main app
                           (New Search / All Leads / History / Analytics /
                           Owner), pricing modal, all CSS and JS. No build
                           step, no framework — it's just HTML/CSS/JS.
scripts/paypal-setup.js    CLI version of the one-click PayPal setup now also
                           available as a button in the Owner Dashboard
astoria-test.js, batch-test.js, loctest.js, test-locality.js
                           Legacy manual test scripts from early development
                           (testing discovery against specific real
                           locations). Not part of the served app. Safe to
                           ignore; ask the owner before deleting them.
```

**No build step.** There's no webpack/vite/bundler — `public/index.html` is
served as-is by Express's static file middleware. Edit it directly.

**No test suite.** There is no `npm test`. Verification in this project has
been: syntax-check with `node -c`, boot the server locally, and drive it with
a real headless browser (Playwright is pre-installed in this environment at
`/opt/pw-browsers`) to click through the actual flow. If you add automated
tests, that would be a genuine improvement — just isn't there yet.

---

## 5. The account/tier system

- **Nobody sees a login wall.** First visit → a marketing landing page →
  "Try free" silently creates a guest account (`POST /api/auth/guest`, email
  like `guest-<uuid>@leadhunter.local`, empty password) and drops the user
  straight into the app. Returning visitors with a valid session cookie skip
  the landing page entirely.
- **"Save my leads"** (in the sidebar) upgrades the *same* guest account in
  place — same id, same history — into a real email+password login via
  `POST /api/auth/claim`. This is different from `/api/auth/signup`, which
  always creates a brand-new empty account.
- **Owner access** is just: log in (or sign up) with whatever email is in the
  `OWNER_EMAIL` environment variable. No separate flag to set anywhere — the
  check is `middleware/auth.js`'s `isOwnerEmail()`, compared live on every
  request. The 👑 Owner nav item and dashboard appear automatically.
- **Tiers** (defined once in `db/tiers.js`, enforced server-side — never trust
  anything the browser sends):

  | | Free | Starter ($9/mo) | Pro ($19.99/mo) |
  |---|---|---|---|
  | Searches | 5 **lifetime** | 60/month | 150/month |
  | Max radius | 5 km | 20 km | 50 km |
  | Max leads/search | 6 | 20 | 50 |
  | AI Deep Research | — | 5/month | 20/month |
  | Re-search rounds/search | 3 | 5 | 20 |

  The UI shows every option to everyone, but greys out ones above the
  caller's tier with a "🔒 Starter"/"🔒 Pro" tag — clicking one opens the
  pricing modal instead of silently doing nothing.

---

## 6. PayPal: sandbox vs. live

Right now `PAYPAL_MODE` is unset, which defaults to **sandbox** — a full
fake-money test environment. Nothing anyone does today charges a real card.

The plan IDs and webhook currently configured were verified live during this
handoff (via the Owner Dashboard's "Infrastructure health" panel) and are
correctly set up in sandbox: both plans `ACTIVE`, webhook correctly
registered.

**To go live** (only the owner can do this — it needs their real PayPal
Business account):
1. PayPal must be a **Business** account, not Personal, and verified.
2. developer.paypal.com → Apps & Credentials → switch to **Live** → copy the
   live Client ID + Secret.
3. In Railway → Variables: replace `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`
   with the live values, add `PAYPAL_MODE=live`, confirm `APP_BASE_URL` is the
   real production URL.
4. Log in as owner → Owner Dashboard → **"Generate Product + Plans +
   Webhook"** button. Read the confirmation dialog carefully — **this creates
   brand-new PayPal objects every time it's run**, it does not look up
   existing ones. Only run it once per environment (or when genuinely setting
   up a fresh one). It prints the new `PAYPAL_PLAN_ID_STARTER`,
   `PAYPAL_PLAN_ID_PRO`, and `PAYPAL_WEBHOOK_ID` on screen — paste those into
   Railway Variables, then redeploy.
5. **Refund policy:** the FAQ currently says "contact us within 7 days for a
   full refund, no questions asked." This was written as a reasonable
   default, not something the owner explicitly decided. Confirm or change it
   (`public/index.html`, search for `What if I want a refund`) before relying
   on it.

---

## 7. Environment variables

Set these in **Railway → your service → Variables**, and mirror them in a
local `.env` file for local development (never commit `.env` — it's already
in `.gitignore`). `.env.example` in this repo lists all of these with
comments; keep it in sync if you add a new one.

| Variable | Required? | What it does |
|---|---|---|
| `SESSION_SECRET` | **Yes, verify this is set** | Signs login session cookies. If unset, the app falls back to an insecure hardcoded default (`server.js` logs a warning about this on boot in production). **Check Railway has a real random value here** — this wasn't confirmed during this handoff. |
| `OWNER_EMAIL` | Yes | The email that gets 👑 Owner access + unlimited quota when they log in/sign up. |
| `DATA_DIR` | Recommended `=/data` | Where the SQLite file lives. Dockerfile already defaults this to `/data`; setting it again in Railway Variables is redundant but harmless. **The Volume mount matters far more than this variable — see section 3.** |
| `SERPER_API_KEY` | Recommended | Main discovery/enrichment provider (serper.dev). Without it, the app still works via free OpenStreetMap + DuckDuckGo/Bing fallbacks, lower quality. |
| `SERPER_API_KEY_2`, `SERPER_API_KEY_3`, ... | Optional | Additional Serper accounts. **Exact naming matters**: first one has no number, then `_2`, `_3`, etc. Auto-rotates on quota/auth failure; check which is active anytime in Owner Dashboard → Infrastructure health. |
| `GOOGLE_PLACES_API_KEY` | Optional, best quality | Becomes the primary discovery source — exact phone/website straight from Google Maps. |
| `GOOGLE_MAPS_API_KEY` | Optional | Enables click-to-drop-pin on the search map. Without it, the map still works via a keyless embed. |
| `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` | One recommended | Powers AI Deep Research mode and lead scoring. DeepSeek is cheaper and preferred automatically if set. |
| `OPENAI_MODEL` | Optional | Default `gpt-4o-mini`. |
| `AI_MODE_MODEL` | Optional | Default `gpt-4o` — used specifically for AI Deep Research's judgment calls. |
| `HUNTER_API_KEY` | Optional | Extra email-finding source (free tier: 25/month). |
| `GMAIL_APP_PASSWORD` | Recommended | Powers the contact form's email notification AND the low-Serper-key email alert. Without it, contact messages still save to the DB (visible in Owner Dashboard) but no email is sent. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Required for billing | See section 6. |
| `PAYPAL_MODE` | Optional | `live` for real money; anything else (or unset) = sandbox. Defaults safe (sandbox). |
| `PAYPAL_PLAN_ID_STARTER`, `PAYPAL_PLAN_ID_PRO`, `PAYPAL_WEBHOOK_ID` | Required for billing | Generated via the Owner Dashboard button or `scripts/paypal-setup.js`. Must belong to the SAME PayPal app as the Client ID/Secret above (sandbox IDs won't work with live credentials or vice versa). |
| `APP_BASE_URL` | Required for the PayPal webhook | The real public URL of the deployed app, e.g. `https://your-app.up.railway.app`. |
| `PORT` | No | Railway sets this automatically. Defaults to 3000 locally. |
| `NODE_ENV` | Recommended `=production` on Railway | Controls whether session cookies are marked `secure`. |
| `SCRAPE_DELAY_MS` | Optional | Pacing between businesses during a search (default 300ms). |

---

## 8. What's been built so far (chronological summary)

**Phase 1 — the discovery/enrichment agent** (oldest work, `agent/` directory):
finds businesses via Google Places/Serper/OpenStreetMap with fallback chains,
verifies Instagram/TikTok handles strictly (never a random influencer
account), validates phone numbers per-country, classifies website quality,
filters out chains/franchises and map-label junk, AI-scores each lead and
drafts outreach messages. Multiple rounds of accuracy fixes (locality
locking, chain filtering, hang-prevention via hard timeouts on every network
call).

**Phase 2 — accounts, tiers, billing:** users/subscriptions DB tables,
signup/login/session auth, guest auto-provisioning with no login wall,
server-side tier enforcement (radius/count/AI caps, never trusting the
client), PayPal Subscriptions integration (subscribe, webhook-driven
renewal/cancellation), multi-account Serper failover.

**Phase 3 — full UI overhaul:** a real marketing landing page, dedicated
full-screen login/signup (not a cramped modal), an Owner Dashboard (stats,
users, contact inbox), simplified New Search UX (collapsed advanced location
fields, radius/count as visible chip rows instead of dropdowns), purposeful
animations, mobile-responsive redesign.

**Phase 4 — bug fixes found via real user testing (most recent):**
- Fixed a real **cross-user data leak**: WebSocket broadcasts went to every
  connected browser, not just the owner of that search. Now scoped per-user
  via the session cookie.
- Fixed **Stop** not working during the discovery phase (only worked once
  enrichment had started).
- Fixed a **double-subscription risk**: the pricing modal used to show a live
  "Subscribe" button for a plan the user was already on, or for a lower plan
  while already on a higher one — clicking it would create a *second* PayPal
  subscription instead of switching. Added a real cancel-subscription flow.
- Fixed pricing copy that undersold Starter/Pro (said "no AI search" when
  they get 5/mo and 20/mo) and a false "searches roll over" claim.
- Mobile: sidebar is now a proper off-canvas drawer instead of forcing
  desktop-site mode on a phone.
- Added browser Back-button support between the landing page and the app
  (there was none before — Back just left the site).
- Fixed a scroll-fighting bug (auto-scroll after a search used to override
  wherever the user had manually scrolled to) and a real performance issue
  (log lines were appended one DOM write + one forced reflow at a time
  during bursts — now batched per animation frame).
- Renamed search modes per owner feedback: default = "AI Search", the
  agent-driven mode = "AI Deep Research" (previously "AI deep search" and
  mislabeled as locked-for-everyone on Free when only the *deep research*
  toggle is actually locked there), "Research this area" → "Re-search".
- Owner Dashboard: added an Infrastructure Health panel (live Serper account
  status + live PayPal plan/webhook validation, not just "is the env var
  set"), an email alert when Serper drops to its last working key, a DB
  backup download, and the one-click PayPal setup button.

---

## 9. What's left — action items for the owner

Roughly in priority order:

1. **Verify the Railway Volume is mounted at `/data`.** This is the most
   important one — see section 3. If you already did this, just double-check
   it in Railway's Volumes tab; don't take it on faith.
2. **Verify `SESSION_SECRET` is set in Railway** to a real random value (not
   left blank). Ask your AI assistant to generate one if you're not sure how.
3. **Set up more Serper accounts** if you rely on Serper for discovery —
   `SERPER_API_KEY_2`, `_3`, etc. Check which one is currently active anytime
   via Owner Dashboard → Infrastructure health.
4. **Set `GMAIL_APP_PASSWORD`** in Railway if you want the contact form and
   low-Serper-key alerts to actually email you (they still save to the DB
   either way, visible in the Owner Dashboard).
5. **Decide the real refund policy** and confirm the wording in the FAQ
   matches what you actually intend to honor.
6. **When ready to accept real payments:** follow the "PayPal: sandbox vs.
   live" steps above. Do this deliberately, not by accident — it's the one
   part of this app that touches real money.
7. **Take a backup** (Owner Dashboard → Download backup) before any Railway
   project/account migration, and before any "go live" change.
8. Optional cleanup, not urgent: the legacy `astoria-test.js` /
   `batch-test.js` / `loctest.js` / `test-locality.js` scripts at the repo
   root aren't part of the served app — fine to leave, fine to ask an
   assistant to delete them if they're just clutter to you.

---

## 10. Rules for whoever works on this next

These are working conventions established over the course of this project —
follow them to avoid re-introducing already-fixed problems:

- **Never trust the client for tier limits, quotas, or the AI-mode flag.**
  Always re-check the caller's actual subscription row in the DB
  server-side. This has already bitten this project once.
- **Every external network call needs a hard timeout.** A single slow
  business/website/Instagram lookup must never be able to freeze an entire
  search. See `agent/util.js`'s `withTimeout` and how it's used throughout
  `agent/index.js`.
- **WebSocket broadcasts must stay scoped to the requesting user's session.**
  Do not add a new `broadcast(...)` call without a userId — see the comment
  block above `broadcast()` in `server.js`.
- **Before showing a live "Subscribe" button, check the caller's current
  tier.** Never let a UI path create a second active PayPal subscription for
  someone who already has one. See `renderPricingCards()` /
  `pricingActionHtml()` in `public/index.html`.
- **Test changes against a genuinely fresh database**, not just the
  developer's already-migrated one — the crash-on-fresh-DB bug in section 3
  only ever showed up that way.
- **When editing `public/index.html`,** remember it's one big file with no
  build step — a broken `<script>` tag breaks the entire app silently (check
  with `node -c` after extracting the inline script, and check for duplicate
  element IDs, both of which are cheap and have caught real mistakes here).
- **Verify claims by actually running the app**, not just by reading the
  code and assuming it works — this project has a working pattern of
  booting the server locally with a throwaway `DATA_DIR`, then driving it
  with headless Playwright (pre-installed at `/opt/pw-browsers` in this
  environment) to click through the real flow before calling anything done.
- **Don't push destructive/expensive real-world actions without confirming
  first** — anything that touches real PayPal objects, sends real email to
  the owner, or could wipe user data deserves a pause and an explicit
  confirmation step, the same way `cancelSubscription()` and
  `runPaypalSetup()` do in the current code.

---

## 11. Where else to look

- `README.md` — shorter, more product-focused overview of features and the
  discovery/enrichment pipeline specifically.
- `.env.example` — every environment variable with inline explanations.
- Git commit history on `claude/inspiring-shannon-crcCD` — commit messages in
  this project have consistently explained *why*, not just *what*; reading
  the last 10-15 commits will give useful context fast.

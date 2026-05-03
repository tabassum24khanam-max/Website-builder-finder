# LeadHunter — Find Local Businesses Without a Website

> **Running on Railway?** Skip to [Deploy on Railway](#deploy-on-railway) below.

A web app you open in your browser. You pick a business category and a city, click **Start**, and it:

1. Opens Google Maps and scrapes real businesses (name, phone, address, rating, reviews).
2. Uses AI to score every business 1–10 as a website-services lead.
3. Writes a short, personalized outreach message for every business that has no website.

You then review leads in a clean dark dashboard, copy the AI message with one click, send it manually on WhatsApp/Instagram/email, and track who you've contacted.

---

## What you need before you start

You only need two things:

1. **Node.js** — free. Download the **LTS** version from <https://nodejs.org> and click Next → Next → Install.
2. **An OpenAI API key** — get one at <https://platform.openai.com/api-keys>. You only pay for what you use. About **$0.10 for 50 leads**, $0.40 for 200 leads. Add $5 of credit and you're set for thousands of leads.

That's it. No databases, no accounts, no signups beyond OpenAI.

---

## Setup (first time only — about 5 minutes)

### 1. Open a terminal in this folder

- **Windows**: Hold `Shift` + right-click on this folder → **Open in Terminal** (or **Open PowerShell window here**).
- **Mac**: Right-click this folder → **New Terminal at Folder** (you may need to enable this in System Settings → Keyboard → Keyboard Shortcuts → Services).

### 2. Install the app

In the terminal, type this and press Enter:

```
npm install
```

This downloads everything the app needs. Takes about a minute.

### 3. Install the controlled browser

```
npm run install-browsers
```

This installs a copy of Chrome that the scraper can drive automatically. One-time setup, takes another minute.

### 4. Add your OpenAI key

1. In this folder, find the file called **`.env.example`**.
2. Make a copy of it and rename the copy to **`.env`** (no `.example` at the end).
3. Open `.env` in Notepad / TextEdit.
4. Replace `sk-paste-your-key-here` with your real OpenAI key.
5. Save.

Your `.env` should look like:

```
OPENAI_API_KEY=sk-abc123yourrealkeyhere
PORT=3000
HEADLESS=false
```

---

## Running the app (every time)

In the terminal, in this folder:

```
npm start
```

You should see:

```
🚀 Lead Gen Dashboard is RUNNING!
Open in browser: http://localhost:3000
```

Open that URL in your browser. You'll see the dashboard.

To stop the app, click on the terminal window and press **Ctrl + C**.

---

## How to use the dashboard

### 🔍 Scraper tab

1. Click a **business category** chip — Restaurants, Cafes, Salons, Barbershops, Clinics, Gyms, Bakeries, Pharmacies, Dental, Hotels, Car Repair, Law Offices.
2. **Or** type a custom category like "perfume shops" or "yoga studios" in the Custom Category box (this overrides the chip).
3. Type a **City** (default: Riyadh — works for any city in any country).
4. Pick how many leads: 20, 50, or 100.
5. Click **▶ Start Scraping**.
6. A Chrome browser window opens automatically. **Don't close it.** It scrolls Google Maps for you.
7. Watch the **Live Activity Log** for what's happening. Every scraped business is qualified by AI in real time.
8. To stop early, click the red **■ Stop** button.

### 📋 All Leads tab

Filter by:

- 🚫 **No Website** — only businesses without a website (your real targets)
- ⭐ **Score 7+** — AI's top picks
- 🆕 **New** / 📤 **Contacted** / 💬 **Replied** / ✅ **Converted** / ⏭ **Skipped** — pipeline stages

Plus a search box to find a specific business.

Click **View** on any row to open the full lead.

### 🔥 Hot Leads tab

The shortcut: **no website + score 7 or higher**. Start here every morning.

### Lead detail (click any lead)

- See full contact info — phone is a clickable `tel:` link.
- Read the **AI outreach message**, edit it freely in the textarea.
- **📋 Copy** — copies the message to your clipboard. Paste it into WhatsApp / IG DM / email.
- **🔄 Regenerate** — asks the AI for a fresh message if you don't like the current one.
- Set **Status** — new, contacted, replied, converted, skipped.
- Add **Notes** — anything personal you want to remember.
- Click **💾 Save Changes**.

### 📊 Analytics tab

Total leads · No-website leads · Hot leads (7+) · Converted · Pipeline funnel · Leads by category.

### Export

Click **⬇️ Export CSV** at the top right at any time. Opens in Excel / Google Sheets with full details.

### Persistence

Your leads are saved to a `leads.json` file in this folder. Close the app and reopen it — everything is still there. Back up that file if you want.

---

## Tips for getting results

- **Best leads = no website + score 7+.** Skip everything else.
- **Run categories one at a time.** Restaurants in Riyadh first. Then cafes. Then salons. Don't mix in the same run.
- **Edit the AI message before sending.** A 5-second tweak that mentions something the AI couldn't know (a specific dish, a recent review you read) doubles reply rates.
- **Phone is your friend.** Local SMBs in Riyadh and most cities respond to WhatsApp 10x more than email. Click the phone number — it opens your phone app or WhatsApp.
- **Score 9–10 means** the AI saw customers asking for an online menu, online booking, or delivery. Lead with that in your pitch.

---

## Cost

| What | Cost |
|---|---|
| Node.js, Playwright, the app itself | Free |
| Google Maps scraping | Free |
| OpenAI GPT-4o-mini per lead | ~$0.002 (about 0.2 cents) |
| 50 leads qualified | ~$0.10 |
| 200 leads qualified | ~$0.40 |

Effectively free.

---

## Troubleshooting

**"OpenAI API key not configured"**
You haven't created the `.env` file yet, or it still says `sk-paste-your-key-here`. Re-do step 4 of setup.

**"npm: command not found"** (Mac) / **"npm is not recognized"** (Windows)
Node.js isn't installed. Install it from <https://nodejs.org>, restart the terminal, try again.

**The Chrome window opens but no businesses appear**
Google Maps occasionally changes its layout. Try a different category or city, or restart the app. The scraper skips broken cards automatically — give it a minute.

**Port 3000 is already in use**
Something else is using port 3000. Edit `.env` and change `PORT=3000` to `PORT=3001`. Then open `http://localhost:3001`.

**The app crashed mid-scrape**
Just run `npm start` again. Your scraped leads up to that point are already saved in `leads.json`.

**I want to run it without seeing the browser window**
In `.env`, set `HEADLESS=true`. The scraper still works, just invisible.

---

## What this app deliberately does NOT do (and why)

- **No LinkedIn / Instagram scraping.** They detect bots in minutes, lock the account, and require login. Not worth the risk for local SMB outreach — Google Maps has everything you need.
- **No automated DM / email sending.** Auto-DMs get your Instagram account banned and your domain blacklisted within hours. The dashboard gives you copy-to-clipboard and `tel:`/WhatsApp deep links so sending stays human, personalized, and under your control.
- **No email harvesting.** Google Maps doesn't expose emails, and scraping business websites for contact emails is unreliable. Phone + WhatsApp is the right channel for local businesses anyway.

If you ever want any of these added, they require dedicated planning (paid email-finder APIs, residential proxies, etc.) and have real account-ban risk.

---

## File structure (for the curious)

```
.
├── server.js              # Express backend + SSE live updates
├── scraper.js             # Playwright Google Maps scraper
├── ai.js                  # OpenAI scoring + outreach generation
├── enricher.js            # Contact info finder (email, IG, FB, LinkedIn)
├── public/index.html      # Single-page dashboard (HTML/CSS/JS)
├── package.json           # Dependencies
├── Dockerfile             # For Railway / Docker deployment
├── railway.toml           # Railway build + health check config
├── .env.example           # Copy this to .env and add your key
├── leads.json             # Auto-created. Your leads database.
└── README.md              # You're reading it.
```

---

## Deploy on Railway

Railway hosts the app in the cloud so you can open it from any device (phone, different laptop, anywhere) without needing a computer running at home.

### What you need

- A Railway account — <https://railway.app> (free to sign up, Hobby plan is $5/month and gives you everything needed)
- Your OpenAI API key

### Step 1 — Push this code to GitHub

If you haven't already, push this repository to your GitHub account. Railway deploys directly from GitHub.

In the terminal inside this folder:

```
git init           # skip if already a git repo
git add .
git commit -m "LeadHunter"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

### Step 2 — Create a new Railway project

1. Go to <https://railway.app> and log in.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Connect your GitHub account if prompted.
4. Select the repo you just pushed.
5. Railway will detect the `Dockerfile` and start building. **The first build takes 3–5 minutes** (it's downloading Chromium). Subsequent builds are fast.

### Step 3 — Add your environment variables

While the build runs (or after):

1. Click on your service in Railway.
2. Go to the **Variables** tab.
3. Add these variables one by one:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-your-real-key-here` |
| `HEADLESS` | `true` |
| `PORT` | `3000` |

Railway automatically sets `PORT` — but adding it explicitly doesn't hurt.

### Step 4 — Add a Volume so your leads are not deleted on each redeploy

Without this step, every time Railway redeploys your app (after a code push or restart), your leads.json gets wiped. A Volume is persistent disk storage.

1. In your Railway project, click **New** → **Volume**.
2. Set the **Mount Path** to `/data`.
3. Click **Add**.
4. Go back to your service → **Variables** tab → add:

| Variable | Value |
|---|---|
| `DATA_DIR` | `/data` |

Now your `leads.json` will be stored at `/data/leads.json` which survives redeploys forever.

### Step 5 — Get your public URL

1. In Railway, go to your service → **Settings** tab → **Networking** section.
2. Click **Generate Domain**.
3. Railway gives you a URL like `https://leadhunter-production-abc123.railway.app`.
4. Open that URL in your browser. **Your dashboard is live.**

### Done

Bookmark the Railway URL. Open it from your phone, your laptop, anywhere. Your leads are saved in the Volume and survive forever.

---

### Railway troubleshooting

**Build fails with "no space left on device"**
The Playwright Docker image is ~1.5 GB. Railway's free build has limited space. Upgrade to Hobby ($5/month) which has 100 GB.

**"Application failed to respond" after deploy**
Go to your service → **Deployments** tab → click the failed deploy → read the logs. Most common cause: `OPENAI_API_KEY` not set. Add it in the Variables tab.

**Scraping hangs or crashes**
Google Maps scraping requires real memory. Railway's Hobby plan gives 512 MB by default. Go to your service → **Settings** → increase Memory to 1 GB or 2 GB.

**Leads disappeared after redeploy**
You didn't add the Volume + set `DATA_DIR=/data`. Do Step 4 above. Previous leads are gone, but new ones will persist.

**I want to run it locally too**
Local: `npm start` (uses `.env` file).
Railway: uses environment variables from the Railway dashboard.
Both can run independently and have their own `leads.json`.

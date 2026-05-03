# ============================================================
#  Dockerfile — LeadHunter AI
#  Uses the official Playwright image so Chromium is already
#  installed with all its Linux dependencies. No extra setup.
# ============================================================

# Playwright v1.45 on Ubuntu Jammy (matches the npm package version)
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Install Node dependencies first (layer-cached unless package.json changes)
COPY package*.json ./
RUN npm ci

# Copy application files
COPY . .

# Persistent data directory — mount a Railway Volume to /data
# to keep leads.json across redeploys (see README for how to do this)
RUN mkdir -p /data

# ---- Environment defaults ----
# Chromium must be headless on a server (no screen)
ENV HEADLESS=true
# Where to store leads.json — override with DATA_DIR=/data in Railway if using a Volume
ENV DATA_DIR=/app
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]

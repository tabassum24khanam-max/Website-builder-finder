# Plain Node image — the app is pure HTTP/API now (no browser/Playwright).
FROM node:22-slim

# Build tools for better-sqlite3 native compilation.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]

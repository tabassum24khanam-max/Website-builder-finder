FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# Build tools needed for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV HEADLESS=true
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]

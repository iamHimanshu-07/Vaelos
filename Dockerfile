FROM node:20-bookworm-slim

# System deps for better-sqlite3 native build + cairo for PDF export
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gcc ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cached layer)
COPY package*.json ./
COPY .npmrc ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Persistent volume target — Railway mounts /data here
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    VAELOS_DB=/data/vaelos.db \
    PORT=8080

EXPOSE 8080

USER node

# Hardened startup: retry loop, log everything, never exit silently
CMD ["sh", "start.sh"]

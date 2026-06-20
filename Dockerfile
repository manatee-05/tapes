# syntax=docker/dockerfile:1
#
# RetroTape — single-container image.
# Packages the Node/Express app, compiles the Tailwind stylesheet, and runs
# the server. All persistent state (SQLite DB + uploaded tapes) lives under
# DATA_DIR, which is expected to be a mounted volume.

FROM node:22-bookworm-slim

# Build tools are only needed if better-sqlite3 has to compile from source
# (prebuilt binaries are used when available). ffmpeg/etc. are NOT required —
# we stream original files untouched.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching. We include dev deps so
# the Tailwind CLI is available to compile CSS, then prune them afterwards.
COPY package*.json ./
RUN npm ci --include=dev

# Copy the rest of the application source.
COPY . .

# Compile the Tailwind stylesheet into /public/css/tailwind.css, then drop
# devDependencies to slim the final image.
RUN npm run build:css \
  && npm prune --omit=dev \
  && npm cache clean --force

# Default runtime configuration. These can all be overridden at deploy time.
#   DATA_DIR    -> SQLite database + sessions (text metadata only)
#   UPLOADS_DIR -> uploaded video media, kept INSIDE the container at /app/uploads
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    UPLOADS_DIR=/app/uploads \
    BASE_URL=http://localhost:3000

# Create the internal media directory up front and make it writable by the
# application. The app also re-creates it at startup if a volume mount is empty.
RUN mkdir -p /app/uploads /data \
  && chmod -R 0775 /app/uploads /data

# Persisted locations, each backed by its own managed volume:
#   /data        -> database + config
#   /app/uploads -> video media (self-contained inside the container tree)
VOLUME ["/data", "/app/uploads"]

# Informational: the actual listen port is taken from $PORT at runtime.
EXPOSE 3000

# Lightweight health check against the no-signal homepage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]

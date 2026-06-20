"use strict";

/**
 * Centralised configuration, derived entirely from environment variables.
 *
 * Required / supported variables (see README and docker-compose.yml):
 *   PORT      - internal port the server listens on (default 3000)
 *   BASE_URL  - public domain/IP of the deployment (e.g. tapes.com)
 *   DATA_DIR  - absolute path where the SQLite DB and uploads are persisted
 *   SESSION_SECRET - optional secret for signing session cookies
 */

const path = require("path");

// The port the HTTP server binds to inside the container.
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Public base URL used for display (e.g. building shareable library links).
// We normalise it so it never carries a trailing slash.
const RAW_BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, "");

// Configuration + the SQLite database live under DATA_DIR. We default to
// ./data for local development convenience, but in containers this is an
// explicit mounted path backed by its own managed volume.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));

// The single-file SQLite database (text metadata only — never video BLOBs).
const DB_PATH = path.join(DATA_DIR, "retrotape.sqlite");

// Uploaded videos are stored on disk INSIDE the container working directory
// (default /app/uploads — process.cwd() is /app in the image), backed by a
// dedicated named volume. They are never written to a host path and never
// stored as BLOBs in SQLite. Overridable via UPLOADS_DIR for local dev.
const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads")
);

// Secret used to sign the session cookie. In production this should be set
// explicitly; otherwise we derive a stable-ish fallback so dev still works.
const SESSION_SECRET =
  process.env.SESSION_SECRET || "retrotape-please-change-this-secret";

// Cap uploads at a generous size for digitized tapes (default 4 GB).
const MAX_UPLOAD_BYTES =
  parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 4 * 1024 * 1024 * 1024;

module.exports = {
  PORT,
  BASE_URL,
  DATA_DIR,
  DB_PATH,
  UPLOADS_DIR,
  SESSION_SECRET,
  MAX_UPLOAD_BYTES,
};

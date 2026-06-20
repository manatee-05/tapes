"use strict";

/**
 * Storage controller — owns everything about how video media is persisted.
 *
 * Strategy (see README "Storage strategy"):
 *   - Videos are written to a dedicated directory INSIDE the container working
 *     directory (default /app/uploads), never to a host path and never as
 *     BLOBs in SQLite.
 *   - SQLite stores only text metadata + the unique filename of each video.
 *   - The directory is created at startup if missing, and re-checked on every
 *     upload (so a freshly (re)mounted named volume is handled gracefully).
 *   - Streaming reads from this directory and pipes the file to the response in
 *     chunks, with full HTTP Range support for fast seeking.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const { UPLOADS_DIR, MAX_UPLOAD_BYTES } = require("./config");

// Pipe video in 1 MiB chunks — a good balance for chunked transfer + seeking.
const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * Ensure the internal uploads directory exists. Cheap and idempotent, so we
 * call it at startup and again right before each write.
 */
function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  return UPLOADS_DIR;
}

// Create it now, at module load (application startup).
ensureUploadsDir();

/**
 * Generate a unique, collision-resistant filename, preserving the original
 * extension. Used as the on-disk name; the DB stores this string.
 */
function uniqueFilename(originalName) {
  const ext = path.extname(originalName || "").toLowerCase().slice(0, 10);
  const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : "";
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt}`;
}

/**
 * Resolve a stored filename to an absolute path, guarding against path
 * traversal (we only ever trust the basename). Returns null if invalid.
 */
function resolveStoredPath(filename) {
  const full = path.join(UPLOADS_DIR, path.basename(String(filename || "")));
  // Defensive: the resolved path must stay within the uploads directory.
  if (!full.startsWith(UPLOADS_DIR)) return null;
  return full;
}

/* ------------------------------------------------------------------ *
 * Multer: write incoming video streams straight into UPLOADS_DIR with
 * a unique filename, rejecting anything that isn't a video.
 * ------------------------------------------------------------------ */
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, ensureUploadsDir()); // re-create dir on the fly if needed
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (/^video\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only video files can be loaded into a tape."));
  },
});

/**
 * Delete a stored file by its filename. Best-effort; never throws.
 */
function removeFile(filename) {
  try {
    const full = resolveStoredPath(filename);
    if (full && fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    console.warn("[RetroTape] Failed to remove file:", filename, e.message);
  }
}

/**
 * Stream a stored video to the HTTP response.
 *
 * Reads the file from the internal uploads directory with the fs module and
 * pipes it to `res` in chunks (chunked transfer / HTTP 206 partial content),
 * giving fast seeking without buffering the whole file in memory.
 *
 * The caller is responsible for authorisation before invoking this.
 */
function streamVideo(req, res, video) {
  const filePath = resolveStoredPath(video.filename);
  if (!filePath) return res.status(400).send("Bad request.");

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return res.status(404).send("Tape file missing.");
  }

  const total = stat.size;
  const mime = video.mime_type || "application/octet-stream";
  const range = req.headers.range;

  // Always advertise range support.
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);

  // No range header -> stream the whole file in chunks.
  if (!range) {
    res.setHeader("Content-Length", total);
    const stream = fs.createReadStream(filePath, {
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    stream.on("error", () => res.destroy());
    return stream.pipe(res);
  }

  // Parse a single "bytes=start-end" range.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.setHeader("Content-Range", `bytes */${total}`);
    return res.status(416).end();
  }

  let start = match[1] === "" ? 0 : parseInt(match[1], 10);
  let end = match[2] === "" ? total - 1 : parseInt(match[2], 10);

  if (isNaN(start) || isNaN(end) || start > end || end >= total) {
    res.setHeader("Content-Range", `bytes */${total}`);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;
  res.status(206); // Partial Content
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", chunkSize);

  // Pipe just the requested byte window, again in chunks.
  const stream = fs.createReadStream(filePath, {
    start,
    end,
    highWaterMark: STREAM_CHUNK_BYTES,
  });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

module.exports = {
  UPLOADS_DIR,
  ensureUploadsDir,
  uniqueFilename,
  resolveStoredPath,
  upload,
  removeFile,
  streamVideo,
};

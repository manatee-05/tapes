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
 *
 * Uploads are CHUNKED. Rather than receiving a whole video in one multipart
 * request (which a 100 MB proxy cap such as Cloudflare Tunnels would reject
 * with "413 Payload Too Large"), the client slices the file and sends it as a
 * sequence of small requests:
 *
 *     1. createUploadSession()  — register an upload, get back an id
 *     2. saveChunk()  x N       — one bounded request per chunk, written to a
 *                                 per-upload scratch directory
 *     3. completeUpload()       — concatenate the parts into the final file
 *
 * Session bookkeeping is kept in memory (single-process app); the chunk parts
 * themselves live on disk so a multi-gigabyte upload never has to be buffered
 * in RAM. Stale sessions are swept periodically and any orphaned scratch files
 * are purged on startup.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { UPLOADS_DIR, MAX_UPLOAD_BYTES, MAX_CHUNK_BYTES } = require("./config");

// Pipe video in 1 MiB chunks — a good balance for chunked transfer + seeking.
const STREAM_CHUNK_BYTES = 1024 * 1024;

// Scratch area for in-progress chunked uploads, kept apart from finished media
// (a hidden subdirectory of UPLOADS_DIR so it shares the same volume). The
// streaming path only ever serves filenames recorded in the DB, so these
// transient part files are never exposed.
const CHUNKS_DIR = path.join(UPLOADS_DIR, ".chunks");

// How long a half-finished upload may sit idle before it is reclaimed.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
 * Chunked uploads
 *
 * In-memory registry of in-progress uploads. Each entry tracks which chunks
 * have arrived plus the metadata needed to assemble + record the final file.
 * Keyed by a random hex upload id.
 * ------------------------------------------------------------------ */
const uploadSessions = new Map();

/** Ensure the scratch directory for chunk parts exists. */
function ensureChunksDir() {
  if (!fs.existsSync(CHUNKS_DIR)) {
    fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  }
  return CHUNKS_DIR;
}

/**
 * Resolve the scratch directory for one upload, guarding against path
 * traversal: the id must be exactly the hex token we issued. Returns null if
 * the id is malformed.
 */
function chunkDirFor(uploadId) {
  const id = path.basename(String(uploadId || ""));
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return path.join(CHUNKS_DIR, id);
}

/** Remove a session and its scratch directory. Best-effort; never throws. */
function cleanupSession(uploadId) {
  uploadSessions.delete(uploadId);
  const dir = chunkDirFor(uploadId);
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn("[RetroTape] Failed to clean up upload:", uploadId, e.message);
    }
  }
}

/**
 * Look up an in-progress upload session (or undefined). Callers use this to
 * verify the session exists and belongs to the expected library before
 * accepting chunks.
 */
function getUploadSession(uploadId) {
  return uploadSessions.get(String(uploadId || ""));
}

/**
 * Begin a chunked upload. Validates the declared metadata up front (video MIME
 * type and overall size) and reserves a scratch directory. Returns the new
 * upload id. Throws with a user-facing message on invalid input.
 */
function createUploadSession({ libraryId, originalName, mimeType, fileSize, totalChunks }) {
  if (!/^video\//.test(String(mimeType || ""))) {
    throw new Error("Only video files can be loaded into a tape.");
  }
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("The video file appears to be empty.");
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error("That video is larger than the maximum allowed size.");
  }
  const chunks = Number(totalChunks);
  if (!Number.isInteger(chunks) || chunks < 1) {
    throw new Error("Invalid upload: bad chunk count.");
  }

  ensureChunksDir();
  const uploadId = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.join(CHUNKS_DIR, uploadId), { recursive: true });

  uploadSessions.set(uploadId, {
    uploadId,
    libraryId: String(libraryId),
    originalName: String(originalName || "video"),
    mimeType: String(mimeType),
    fileSize: size,
    totalChunks: chunks,
    received: new Set(), // indices written so far
    bytes: 0, // running total of bytes accepted
    updatedAt: Date.now(),
  });

  return uploadId;
}

/**
 * Persist a single chunk to disk. Idempotent: re-sending the same index simply
 * overwrites the part (handy for retries). Enforces per-chunk and overall size
 * limits. Returns progress so the caller can report it back to the client.
 */
function saveChunk(uploadId, index, buffer) {
  const session = uploadSessions.get(String(uploadId || ""));
  if (!session) throw new Error("Upload session not found or expired.");

  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= session.totalChunks) {
    throw new Error("Chunk index out of range.");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Received an empty chunk.");
  }
  if (buffer.length > MAX_CHUNK_BYTES) {
    throw new Error("A single chunk exceeded the maximum chunk size.");
  }

  const dir = chunkDirFor(uploadId);
  if (!dir) throw new Error("Invalid upload id.");

  // Only count freshly-seen chunks toward the running total so retries don't
  // inflate it (and reject before writing if the upload would grow too large).
  const isNew = !session.received.has(i);
  if (isNew && session.bytes + buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error("Upload exceeded the maximum allowed size.");
  }

  fs.writeFileSync(path.join(dir, `${i}.part`), buffer);

  if (isNew) {
    session.received.add(i);
    session.bytes += buffer.length;
  }
  session.updatedAt = Date.now();

  return { received: session.received.size, totalChunks: session.totalChunks };
}

/**
 * Finalise an upload: verify every chunk arrived, concatenate the parts (in
 * order, one at a time so memory stays flat) into a uniquely-named file in
 * UPLOADS_DIR, then drop the session + scratch files. Returns the metadata the
 * caller needs to record the video in the DB. Throws on incomplete uploads.
 */
function completeUpload(uploadId) {
  const session = uploadSessions.get(String(uploadId || ""));
  if (!session) throw new Error("Upload session not found or expired.");
  if (session.received.size !== session.totalChunks) {
    throw new Error("Upload is incomplete — some chunks are missing.");
  }

  const dir = chunkDirFor(uploadId);
  if (!dir) throw new Error("Invalid upload id.");

  ensureUploadsDir();
  const filename = uniqueFilename(session.originalName);
  const finalPath = path.join(UPLOADS_DIR, filename);

  const out = fs.openSync(finalPath, "w");
  let size = 0;
  try {
    for (let i = 0; i < session.totalChunks; i++) {
      const part = fs.readFileSync(path.join(dir, `${i}.part`));
      fs.writeSync(out, part);
      size += part.length;
    }
  } catch (err) {
    fs.closeSync(out);
    try {
      fs.unlinkSync(finalPath);
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
  fs.closeSync(out);

  const meta = {
    filename,
    size,
    mimeType: session.mimeType,
    originalName: session.originalName,
    libraryId: session.libraryId,
  };

  cleanupSession(uploadId);
  return meta;
}

/** Cancel an in-progress upload and discard its parts. */
function abortUpload(uploadId) {
  cleanupSession(uploadId);
}

// Periodically reclaim uploads abandoned mid-flight.
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of uploadSessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) cleanupSession(id);
  }
}, 30 * 60 * 1000).unref();

// On startup no sessions exist yet, so any part files left over from a previous
// process are orphans — clear the whole scratch area.
try {
  if (fs.existsSync(CHUNKS_DIR)) {
    fs.rmSync(CHUNKS_DIR, { recursive: true, force: true });
  }
} catch (e) {
  console.warn("[RetroTape] Failed to purge stale upload chunks:", e.message);
}

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
  removeFile,
  streamVideo,
  // Chunked upload API
  createUploadSession,
  getUploadSession,
  saveChunk,
  completeUpload,
  abortUpload,
};

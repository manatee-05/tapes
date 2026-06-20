"use strict";

/**
 * Admin panel routes.
 *
 *   GET  /admin                      -> setup wizard | login | dashboard
 *   POST /admin/setup                -> create the very first admin account
 *   POST /admin/login                -> authenticate an existing admin
 *   POST /admin/logout               -> end the admin session
 *   POST /admin/libraries            -> create a library
 *   POST /admin/libraries/:id        -> edit a library's settings
 *   POST /admin/libraries/:id/delete -> delete a library (and its tapes)
 *
 *   Chunked tape upload (keeps every request well under the proxy's payload
 *   cap; see src/storage.js and public/js/upload.js):
 *   POST   /admin/libraries/:id/uploads                       -> start a session
 *   PUT    /admin/libraries/:id/uploads/:uploadId/chunks/:i   -> send one chunk
 *   POST   /admin/libraries/:id/uploads/:uploadId/complete    -> finalise + save
 *   DELETE /admin/libraries/:id/uploads/:uploadId             -> abort a session
 *
 *   POST /admin/videos/:id/delete    -> delete a tape
 */

const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");

const db = require("../db");
// Storage controller: chunked upload session API + file removal.
const storage = require("../storage");
const { removeFile } = storage;
const { requireAdmin } = require("../middleware/auth");
const { slugify, isValidSlug, isValidPasscode } = require("../util");
const { MAX_CHUNK_BYTES } = require("../config");

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Entry point: decide which screen to show
 * ------------------------------------------------------------------ */
router.get("/", (req, res) => {
  // First-run: no admins yet -> show the setup wizard.
  if (db.adminCount() === 0) {
    return res.render("admin/setup", { error: null });
  }
  // Not authenticated -> terminal login screen.
  if (!req.session.adminId) {
    return res.render("admin/login", { error: null });
  }
  // Authenticated -> dashboard with libraries + their tape counts.
  return renderDashboard(req, res);
});

// Helper: render the dashboard with everything the admin needs.
function renderDashboard(req, res, opts = {}) {
  const libraries = db.listLibraries().map((lib) => ({
    ...lib,
    videoCount: db.videoCount(lib.id),
    secured: !!lib.passcode_hash,
  }));

  // If a library is "open" in the dashboard, load its tapes for management.
  let selected = null;
  let videos = [];
  const selectedId = req.query.library;
  if (selectedId) {
    selected = db.getLibrary(selectedId);
    if (selected) videos = db.listVideos(selected.id);
  }

  res.render("admin/dashboard", {
    username: req.session.adminUsername,
    libraries,
    selected,
    videos,
    notice: opts.notice || null,
    error: opts.error || null,
  });
}

/* ------------------------------------------------------------------ *
 * Setup wizard — create the first admin (only when none exist)
 * ------------------------------------------------------------------ */
router.post("/setup", async (req, res) => {
  if (db.adminCount() > 0) {
    return res.redirect("/admin"); // setup already completed
  }
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm || "");

  if (username.length < 3 || password.length < 6) {
    return res.render("admin/setup", {
      error: "Username must be 3+ chars and password 6+ chars.",
    });
  }
  if (password !== confirm) {
    return res.render("admin/setup", { error: "Passwords do not match." });
  }

  const hash = await bcrypt.hash(password, 12);
  const info = db.createAdmin(username, hash);
  req.session.adminId = info.lastInsertRowid;
  req.session.adminUsername = username;
  res.redirect("/admin");
});

/* ------------------------------------------------------------------ *
 * Login / logout
 * ------------------------------------------------------------------ */
router.post("/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const admin = db.findAdmin(username);

  // Use a constant-ish path whether or not the user exists.
  const ok = admin && (await bcrypt.compare(password, admin.password_hash));
  if (!ok) {
    return res.render("admin/login", { error: "ACCESS DENIED — bad credentials." });
  }
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.redirect("/admin");
});

router.post("/logout", requireAdmin, (req, res) => {
  // Only clear the admin identity; preserve any unlocked library state.
  delete req.session.adminId;
  delete req.session.adminUsername;
  res.redirect("/admin");
});

/* ------------------------------------------------------------------ *
 * Change the signed-in admin's own password
 * ------------------------------------------------------------------ */
router.post("/password", requireAdmin, async (req, res) => {
  const current = String(req.body.current_password || "");
  const next = String(req.body.new_password || "");
  const confirm = String(req.body.confirm_password || "");

  const admin = db.getAdmin(req.session.adminId);
  if (!admin) {
    return renderDashboard(req, res, { error: "Account not found — please log in again." });
  }
  if (!(await bcrypt.compare(current, admin.password_hash))) {
    return renderDashboard(req, res, { error: "Current password is incorrect." });
  }
  if (next.length < 6) {
    return renderDashboard(req, res, {
      error: "New password must be at least 6 characters.",
    });
  }
  if (next !== confirm) {
    return renderDashboard(req, res, { error: "New passwords do not match." });
  }

  const hash = await bcrypt.hash(next, 12);
  db.updateAdminPassword(admin.id, hash);
  renderDashboard(req, res, { notice: "Password updated." });
});

/* ------------------------------------------------------------------ *
 * Library management (all require an authenticated admin)
 * ------------------------------------------------------------------ */
router.post("/libraries", requireAdmin, async (req, res) => {
  const title = String(req.body.title || "").trim();
  let slug = slugify(req.body.slug || req.body.title);
  const passcode = String(req.body.passcode || "").trim();

  if (!title) {
    return renderDashboard(req, res, { error: "A library needs a title." });
  }
  if (!isValidSlug(slug)) {
    return renderDashboard(req, res, {
      error: `"${slug}" is not a usable (or is a reserved) slug.`,
    });
  }
  if (db.getLibraryBySlug(slug)) {
    return renderDashboard(req, res, { error: `Slug "${slug}" is already taken.` });
  }
  if (passcode && !isValidPasscode(passcode)) {
    return renderDashboard(req, res, {
      error: "Passcode must be 1–32 alphanumeric characters.",
    });
  }

  const passHash = passcode ? await bcrypt.hash(passcode, 10) : null;
  db.createLibrary(title, slug, passHash);
  renderDashboard(req, res, { notice: `Library "${title}" created.` });
});

router.post("/libraries/:id", requireAdmin, async (req, res) => {
  const lib = db.getLibrary(req.params.id);
  if (!lib) return renderDashboard(req, res, { error: "Library not found." });

  const title = String(req.body.title || "").trim() || lib.title;
  let slug = slugify(req.body.slug || lib.slug);
  if (!isValidSlug(slug)) {
    return renderDashboard(req, res, { error: `"${slug}" is not a usable slug.` });
  }
  const clash = db.getLibraryBySlug(slug);
  if (clash && clash.id !== lib.id) {
    return renderDashboard(req, res, { error: `Slug "${slug}" is already taken.` });
  }

  // Passcode handling:
  //   passcode_action = "keep"   -> leave unchanged
  //   passcode_action = "remove" -> drop protection
  //   passcode_action = "set"    -> set a new passcode from `passcode`
  let passHash = lib.passcode_hash;
  const action = req.body.passcode_action || "keep";
  if (action === "remove") {
    passHash = null;
  } else if (action === "set") {
    const passcode = String(req.body.passcode || "").trim();
    if (!isValidPasscode(passcode)) {
      return renderDashboard(req, res, {
        error: "Passcode must be 1–32 alphanumeric characters.",
      });
    }
    passHash = await bcrypt.hash(passcode, 10);
  }

  db.updateLibrary(lib.id, title, slug, passHash);
  renderDashboard(req, res, { notice: `Library "${title}" updated.` });
});

router.post("/libraries/:id/delete", requireAdmin, (req, res) => {
  const lib = db.getLibrary(req.params.id);
  if (lib) {
    // Remove the underlying files first, then cascade-delete rows.
    for (const v of db.listVideos(lib.id)) {
      removeFile(v.filename);
    }
    db.deleteLibrary(lib.id);
  }
  renderDashboard(req, res, { notice: "Library ejected and erased." });
});

/* ------------------------------------------------------------------ *
 * Video (tape) management — CHUNKED upload
 *
 * The browser slices the file (see public/js/upload.js) and drives the three
 * endpoints below over JSON/binary, so no single request ever approaches the
 * proxy's payload cap. Responses are JSON for the client to act on.
 * ------------------------------------------------------------------ */

// Verify the upload session exists and is bound to the library in the URL.
// Returns the session, or sends a 404 JSON error and returns null.
function sessionForRequest(req, res) {
  const session = storage.getUploadSession(req.params.uploadId);
  if (!session || session.libraryId !== String(req.params.id)) {
    res.status(404).json({ error: "Upload session not found or expired." });
    return null;
  }
  return session;
}

// 1. Start a chunked upload session.
router.post("/libraries/:id/uploads", requireAdmin, (req, res) => {
  const lib = db.getLibrary(req.params.id);
  if (!lib) return res.status(404).json({ error: "Library not found." });

  try {
    const uploadId = storage.createUploadSession({
      libraryId: lib.id,
      originalName: req.body.filename,
      mimeType: req.body.mimeType,
      fileSize: req.body.fileSize,
      totalChunks: req.body.totalChunks,
    });
    res.json({ uploadId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Receive one raw binary chunk. express.raw caps the body just above the
//    configured chunk size as a defensive backstop.
router.put(
  "/libraries/:id/uploads/:uploadId/chunks/:index",
  requireAdmin,
  express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  (req, res) => {
    if (!sessionForRequest(req, res)) return;
    try {
      const progress = storage.saveChunk(
        req.params.uploadId,
        req.params.index,
        req.body
      );
      res.json(progress);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// 3. Finalise: assemble the parts and record the tape's metadata.
router.post("/libraries/:id/uploads/:uploadId/complete", requireAdmin, (req, res) => {
  if (!sessionForRequest(req, res)) return;

  const lib = db.getLibrary(req.params.id);
  if (!lib) {
    storage.abortUpload(req.params.uploadId);
    return res.status(404).json({ error: "Library not found." });
  }

  let meta;
  try {
    meta = storage.completeUpload(req.params.uploadId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const title =
    String(req.body.title || "").trim() || path.parse(meta.originalName).name;
  const description = String(req.body.description || "").trim();

  db.createVideo({
    library_id: lib.id,
    title,
    description,
    filename: meta.filename,
    original_name: meta.originalName,
    mime_type: meta.mimeType,
    size_bytes: meta.size,
  });

  res.json({ ok: true, redirect: `/admin?library=${lib.id}` });
});

// Abort an in-progress upload (e.g. the user cancelled or navigated away).
router.delete("/libraries/:id/uploads/:uploadId", requireAdmin, (req, res) => {
  if (!sessionForRequest(req, res)) return;
  storage.abortUpload(req.params.uploadId);
  res.json({ ok: true });
});

router.post("/videos/:id/delete", requireAdmin, (req, res) => {
  const video = db.getVideo(req.params.id);
  if (video) {
    removeFile(video.filename);
    db.deleteVideo(video.id);
    return res.redirect(`/admin?library=${video.library_id}`);
  }
  res.redirect("/admin");
});

module.exports = router;

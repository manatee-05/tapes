"use strict";

/**
 * Public library routes (the catch-all part of the URL space).
 *
 *   GET  /:slug                 -> keypad (if locked) | tape shelf
 *   POST /:slug/unlock          -> verify passcode, remember in session
 *   GET  /:slug/watch/:videoId  -> the virtual VCR + player page
 *
 * These are mounted last in server.js so reserved prefixes (/admin, /media,
 * static assets) win first.
 */

const express = require("express");
const bcrypt = require("bcryptjs");

const db = require("../db");
const { hasLibraryAccess } = require("../middleware/auth");
const { RESERVED_SLUGS } = require("../util");

const router = express.Router();

// Guard: ignore reserved slugs so this router never shadows real routes.
router.use("/:slug", (req, res, next) => {
  if (RESERVED_SLUGS.has(req.params.slug)) return next("router");
  next();
});

/* ------------------------------------------------------------------ *
 * Library landing page — keypad or shelf
 * ------------------------------------------------------------------ */
router.get("/:slug", (req, res, next) => {
  const library = db.getLibraryBySlug(req.params.slug);
  if (!library) return next(); // fall through to 404

  // Locked and not yet unlocked -> show the vintage keypad.
  if (!hasLibraryAccess(req, library)) {
    return res.render("library/locked", { library, error: null });
  }

  // Unlocked / unsecured -> show the shelf of cassettes.
  const videos = db.listVideos(library.id);
  res.render("library/shelf", { library, videos });
});

/* ------------------------------------------------------------------ *
 * Passcode verification
 * ------------------------------------------------------------------ */
router.post("/:slug/unlock", async (req, res, next) => {
  const library = db.getLibraryBySlug(req.params.slug);
  if (!library) return next();

  // Already open (or never locked).
  if (!library.passcode_hash) return res.redirect(`/${library.slug}`);

  const attempt = String(req.body.passcode || "").trim();
  const ok = await bcrypt.compare(attempt, library.passcode_hash);
  if (!ok) {
    return res.render("library/locked", {
      library,
      error: "INCORRECT CODE — tape stays locked.",
    });
  }

  // Persist the unlocked state for this library in the session.
  if (!req.session.unlocked) req.session.unlocked = {};
  req.session.unlocked[library.slug] = true;
  res.redirect(`/${library.slug}`);
});

/* ------------------------------------------------------------------ *
 * Player page
 * ------------------------------------------------------------------ */
router.get("/:slug/watch/:videoId", (req, res, next) => {
  const library = db.getLibraryBySlug(req.params.slug);
  if (!library) return next();

  // Enforce the passcode gate on the player too.
  if (!hasLibraryAccess(req, library)) {
    return res.render("library/locked", { library, error: null });
  }

  const video = db.getVideo(req.params.videoId);
  if (!video || video.library_id !== library.id) return next();

  res.render("library/player", { library, video });
});

module.exports = router;

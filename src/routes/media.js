"use strict";

/**
 * Media streaming route.
 *
 * GET /media/:videoId
 *   Streams the ORIGINAL video file (from the internal /app/uploads directory)
 *   with full HTTP Range support so the browser can seek. Access is gated by
 *   the same passcode logic as the library page, so protected tapes cannot be
 *   hot-linked. The actual file read + chunked piping lives in the storage
 *   controller (src/storage.js).
 *
 * NOTE: We deliberately stream the source bytes unmodified — no transcoding,
 * no filters. All of RetroTape's visual "VHS" flavour lives in the UI around
 * the <video> element, never in the video data itself.
 */

const express = require("express");

const db = require("../db");
const storage = require("../storage");
const { hasLibraryAccess } = require("../middleware/auth");

const router = express.Router();

router.get("/:videoId", (req, res) => {
  const video = db.getVideo(req.params.videoId);
  if (!video) {
    return res.status(404).send("No tape found.");
  }

  // Authorisation: admins always have access; otherwise the library must be
  // unsecured or unlocked in this session.
  const library = db.getLibrary(video.library_id);
  const isAdmin = !!(req.session && req.session.adminId);
  if (!isAdmin && !hasLibraryAccess(req, library)) {
    return res.status(403).send("Locked. Enter the passcode first.");
  }

  // Read from the internal uploads dir and pipe to the response in chunks.
  storage.streamVideo(req, res, video);
});

module.exports = router;

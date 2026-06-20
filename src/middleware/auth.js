"use strict";

/**
 * Authentication / authorization middleware.
 */

// Require an authenticated admin for protected admin routes. If not logged in
// we send the user back to the admin entry point (which shows login/setup).
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  return res.redirect("/admin");
}

/**
 * Require that the current session has unlocked a given library (or that the
 * library has no passcode). Used to gate both the library page interactions
 * and the raw video stream so protected tapes cannot be deep-linked.
 *
 * Returns true if access is allowed.
 */
function hasLibraryAccess(req, library) {
  if (!library) return false;
  if (!library.passcode_hash) return true; // unsecured
  const unlocked = (req.session && req.session.unlocked) || {};
  return unlocked[library.slug] === true;
}

module.exports = { requireAdmin, hasLibraryAccess };

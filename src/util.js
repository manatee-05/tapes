"use strict";

/**
 * Small shared utilities: slug handling and input validation.
 */

// Routes that must never be claimed by a user-defined library slug.
const RESERVED_SLUGS = new Set([
  "admin",
  "media",
  "css",
  "js",
  "fonts",
  "public",
  "static",
  "favicon.ico",
]);

// Normalise an arbitrary string into a safe URL slug.
function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumerics -> hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 64);
}

// A valid slug is lowercase alphanumeric with optional internal hyphens.
function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

// Passcodes are optional, alphanumeric, reasonable length.
function isValidPasscode(passcode) {
  return /^[A-Za-z0-9]{1,32}$/.test(passcode);
}

module.exports = { RESERVED_SLUGS, slugify, isValidSlug, isValidPasscode };

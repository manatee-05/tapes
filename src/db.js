"use strict";

/**
 * SQLite data layer for RetroTape (single-file DB via better-sqlite3).
 *
 * The database file and the uploads directory both live under DATA_DIR so a
 * single mounted volume persists everything across container redeploys.
 */

const fs = require("fs");
const Database = require("better-sqlite3");
const { DATA_DIR, DB_PATH } = require("./config");

// Ensure the persistent DATA_DIR (which holds the SQLite file) exists before
// opening the database. The uploads directory is managed separately by the
// storage controller (src/storage.js).
fs.mkdirSync(DATA_DIR, { recursive: true });

// Open (or create) the single-file database.
const db = new Database(DB_PATH);

// Pragmas: WAL gives better concurrency for streaming + writes; foreign keys
// must be enabled explicitly in SQLite.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Create the schema if it does not already exist.
 *  - admins:    platform administrators (first one created via setup wizard)
 *  - libraries: a named collection of tapes, reached via a unique slug,
 *               optionally protected by a hashed alphanumeric passcode
 *  - videos:    individual tapes belonging to a library
 *  - sessions:  managed by better-sqlite3-session-store (created elsewhere)
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS libraries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    passcode_hash TEXT,                 -- NULL means the library is unsecured
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS videos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id    INTEGER NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT,
    filename      TEXT NOT NULL,        -- stored filename within UPLOADS_DIR
    original_name TEXT,
    mime_type     TEXT,
    size_bytes    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_videos_library ON videos(library_id);
`);

/* ------------------------------------------------------------------ *
 * Prepared statements / query helpers
 * ------------------------------------------------------------------ */

const queries = {
  // --- Admins ---
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM admins"),
  getAdminByUsername: db.prepare("SELECT * FROM admins WHERE username = ?"),
  insertAdmin: db.prepare(
    "INSERT INTO admins (username, password_hash) VALUES (?, ?)"
  ),

  // --- Libraries ---
  insertLibrary: db.prepare(
    "INSERT INTO libraries (title, slug, passcode_hash) VALUES (?, ?, ?)"
  ),
  listLibraries: db.prepare("SELECT * FROM libraries ORDER BY created_at DESC"),
  getLibraryById: db.prepare("SELECT * FROM libraries WHERE id = ?"),
  getLibraryBySlug: db.prepare("SELECT * FROM libraries WHERE slug = ?"),
  updateLibrary: db.prepare(
    "UPDATE libraries SET title = ?, slug = ?, passcode_hash = ? WHERE id = ?"
  ),
  deleteLibrary: db.prepare("DELETE FROM libraries WHERE id = ?"),
  countVideosInLibrary: db.prepare(
    "SELECT COUNT(*) AS n FROM videos WHERE library_id = ?"
  ),

  // --- Videos ---
  insertVideo: db.prepare(`
    INSERT INTO videos
      (library_id, title, description, filename, original_name, mime_type, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listVideosByLibrary: db.prepare(
    "SELECT * FROM videos WHERE library_id = ? ORDER BY created_at DESC"
  ),
  getVideoById: db.prepare("SELECT * FROM videos WHERE id = ?"),
  deleteVideo: db.prepare("DELETE FROM videos WHERE id = ?"),
};

/* ------------------------------------------------------------------ *
 * Public model API — thin wrappers giving the rest of the app clean,
 * intention-revealing methods instead of raw SQL.
 * ------------------------------------------------------------------ */

const model = {
  // Admins
  adminCount: () => queries.countAdmins.get().n,
  findAdmin: (username) => queries.getAdminByUsername.get(username),
  createAdmin: (username, passwordHash) =>
    queries.insertAdmin.run(username, passwordHash),

  // Libraries
  createLibrary: (title, slug, passcodeHash) =>
    queries.insertLibrary.run(title, slug, passcodeHash),
  listLibraries: () => queries.listLibraries.all(),
  getLibrary: (id) => queries.getLibraryById.get(id),
  getLibraryBySlug: (slug) => queries.getLibraryBySlug.get(slug),
  updateLibrary: (id, title, slug, passcodeHash) =>
    queries.updateLibrary.run(title, slug, passcodeHash, id),
  deleteLibrary: (id) => queries.deleteLibrary.run(id),
  videoCount: (libraryId) => queries.countVideosInLibrary.get(libraryId).n,

  // Videos
  createVideo: (v) =>
    queries.insertVideo.run(
      v.library_id,
      v.title,
      v.description,
      v.filename,
      v.original_name,
      v.mime_type,
      v.size_bytes
    ),
  listVideos: (libraryId) => queries.listVideosByLibrary.all(libraryId),
  getVideo: (id) => queries.getVideoById.get(id),
  deleteVideo: (id) => queries.deleteVideo.run(id),

  // Expose the raw connection for the session store.
  _db: db,
};

module.exports = model;

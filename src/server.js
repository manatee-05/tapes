"use strict";

/**
 * RetroTape — application entry point.
 *
 * A single Express server that:
 *   - renders the retro UI (EJS views + static assets),
 *   - exposes an admin panel (setup wizard / login / dashboard),
 *   - serves passcode-protected libraries of VHS-style tapes,
 *   - streams the original, untouched video with HTTP range support.
 */

const path = require("path");
const express = require("express");
const session = require("express-session");
const SqliteStoreFactory = require("better-sqlite3-session-store");

const config = require("./config");
const db = require("./db");

const adminRouter = require("./routes/admin");
const libraryRouter = require("./routes/library");
const mediaRouter = require("./routes/media");

const app = express();

// Behind a reverse proxy (Portainer/Traefik/Nginx) we trust the proxy so
// secure cookies and protocol detection work correctly.
app.set("trust proxy", 1);

// --- View engine ---------------------------------------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

// --- Body parsing --------------------------------------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Static assets (compiled Tailwind, retro CSS, client JS, fonts) ------
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: "1h",
    extensions: ["html"],
  })
);

// --- Sessions (stored in the same SQLite file under DATA_DIR) ------------
const SqliteStore = SqliteStoreFactory(session);
app.use(
  session({
    store: new SqliteStore({
      client: db._db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "retrotape.sid",
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // Only mark the cookie secure when serving over https in production.
      secure: config.BASE_URL.startsWith("https://"),
      maxAge: 1000 * 60 * 60 * 24 * 7, // one week
    },
  })
);

// Expose common values to every view.
app.use((req, res, next) => {
  res.locals.BASE_URL = config.BASE_URL;
  res.locals.isAdmin = !!(req.session && req.session.adminId);
  next();
});

// --- Routes --------------------------------------------------------------

/**
 * Root route: an old TV with NO SIGNAL. The platform is intentionally only
 * reachable via direct library links, so the homepage just shows the empty
 * "please insert cassette" state.
 */
app.get("/", (req, res) => {
  res.render("no-signal");
});

// Order matters: specific prefixes before the catch-all :slug router.
app.use("/admin", adminRouter);
app.use("/media", mediaRouter);
app.use("/", libraryRouter); // handles /:slug, /:slug/unlock, /:slug/watch/:id

// --- 404 -----------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render("no-signal", {
    title: "CHANNEL NOT FOUND",
    message: "This frequency is dead air. Check your library link and try again.",
  });
});

// --- Error handler -------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[RetroTape] Unhandled error:", err);
  if (res.headersSent) return;
  res.status(500).render("no-signal", {
    title: "TRACKING ERROR",
    message: "The tape jammed. (An internal error occurred.)",
  });
});

// --- Start ---------------------------------------------------------------
app.listen(config.PORT, () => {
  console.log("┌───────────────────────────────────────────────┐");
  console.log("│  RetroTape is online                           │");
  console.log(`│  Listening on port : ${String(config.PORT).padEnd(25)}│`);
  console.log(`│  Public BASE_URL   : ${config.BASE_URL.slice(0, 25).padEnd(25)}│`);
  console.log(`│  DATA_DIR          : ${config.DATA_DIR.slice(0, 25).padEnd(25)}│`);
  console.log("└───────────────────────────────────────────────┘");
});

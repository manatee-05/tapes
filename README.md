# 📼 RetroTape

> Host and play your digitized video tapes through a nostalgic, late-1900s VHS
> player and CRT television interface.

RetroTape is a self-contained, single-container web app. Admins create
passcode-protectable **libraries** and upload videos, which appear to visitors
as a shelf of **VHS cassettes**. Clicking a tape slides it into a virtual VCR
and plays it inside a CRT television — complete with scanlines, static, tactile
transport buttons, a simulated tracking knob, and a glowing digital timer.

The retro effects live **only** on the surrounding bezel, chassis, controls,
and empty-player states. The actual video stream is always served and rendered
**unmodified** — no filters, no transcoding, no tracking noise over the picture.

---

## ✨ Features

- **No-signal homepage** — the root URL shows a fuzzy "PLEASE INSERT CASSETTE"
  TV. The platform is only reachable through direct library links.
- **Admin panel** (`/admin`) with a first-run **setup wizard**, terminal-style
  **login**, and a dashboard to manage libraries and tapes.
- **Libraries** with a unique slug (`/joe`) and an optional alphanumeric
  passcode, entered through a vintage digital **keypad/lockbox**.
- **VHS cassette shelf** with handwritten-style paper labels and a
  tape-insert loading animation.
- **Virtual VCR + CRT player**: Play, Pause, Stop, Rewind, Fast-Forward, Eject,
  seek bar, playback speed, volume, and a simulated tracking control — all
  wired to the underlying `<video>` element.
- **Range-aware streaming** so videos seek instantly.
- **Single SQLite file + local uploads**, all under one persisted directory.

## 🧱 Tech stack

| Layer        | Choice                                   |
| ------------ | ---------------------------------------- |
| Backend      | Node.js + Express                        |
| Views        | EJS server-side templates                |
| Styling      | Tailwind CSS (compiled) + hand-written retro/CRT CSS |
| Database     | SQLite (`better-sqlite3`), single file   |
| Uploads      | Multer → internal `/app/uploads` directory |
| Sessions     | `express-session` stored in the SQLite file |
| Container    | Docker + Docker Compose (Portainer-ready)|

---

## ⚙️ Configuration (environment variables)

| Variable         | Default                  | Purpose                                                        |
| ---------------- | ------------------------ | -------------------------------------------------------------- |
| `PORT`           | `3000`                   | Internal/published port the server listens on.                 |
| `BASE_URL`       | `http://localhost:3000`  | Public domain/IP, used to display shareable library links.     |
| `DATA_DIR`       | `/data` (container)      | Path for the SQLite DB + sessions (text metadata only).        |
| `UPLOADS_DIR`    | `/app/uploads` (container) | Path for uploaded video media, kept **inside** the container. |
| `SESSION_SECRET` | dev fallback             | Secret used to sign session cookies — **set this** in prod.    |
| `MAX_UPLOAD_BYTES` | `4294967296` (4 GiB)   | Maximum upload size.                                           |

### Storage strategy

Persistence is split across two **managed Docker volumes** (no host bind
mounts), so neither the database nor the media clutters the host filesystem:

```
DATA_DIR    (/data, volume retrotape_data)
└── retrotape.sqlite     # admins, libraries, video METADATA, sessions

UPLOADS_DIR (/app/uploads, volume retrotape_media)
└── <unique>.mp4 ...     # the original uploaded video files
```

- Videos are written to disk in `UPLOADS_DIR` with a generated unique filename
  — never to a host path and **never stored as BLOBs in SQLite** (which would
  degrade read/write performance).
- SQLite stores only text metadata: titles, descriptions, and each video's
  unique filename.
- The uploads directory is created at startup if missing (and re-checked on
  every upload).

---

## 🐳 Deploy with Docker / Portainer

### Option A — Portainer Stack (recommended)

1. In Portainer, create a new **Stack**.
2. Deploy **from this Git repository** (so the Dockerfile can be built), or
   paste the contents of [`docker-compose.yml`](docker-compose.yml) into the
   **Web editor**.
3. Portainer auto-detects the environment variables. Set at least:
   - `BASE_URL` → your real domain (e.g. `https://tapes.com`)
   - `SESSION_SECRET` → a long random string
   - optionally `PORT`, `DATA_DIR`, `UPLOADS_DIR`
4. Deploy. Visit `BASE_URL/admin` to run the one-time setup wizard.

The stack defines two named volumes — `retrotape_data` (mounted at `DATA_DIR`,
the database) and `retrotape_media` (mounted at `UPLOADS_DIR`, the video files)
— so everything **persists across updates and redeploys**.

### Option B — Docker Compose CLI

```bash
cp .env.example .env        # then edit values
docker compose up -d --build
```

### Option C — plain Docker

```bash
docker build -t retrotape .
docker run -d --name retrotape \
  -p 3000:3000 \
  -e BASE_URL="https://tapes.com" \
  -e SESSION_SECRET="$(openssl rand -hex 24)" \
  -e DATA_DIR=/data \
  -e UPLOADS_DIR=/app/uploads \
  -v retrotape_data:/data \
  -v retrotape_media:/app/uploads \
  retrotape
```

> **Note:** the container runs as root so it can always write to an arbitrary
> mounted volume (the simplest behavior for self-hosted/Portainer setups). Put
> it behind your existing reverse proxy / TLS terminator.

---

## 💻 Local development

```bash
npm install
npm run build:css          # compile Tailwind once (or `npm run watch:css`)
DATA_DIR=./data BASE_URL=http://localhost:3000 npm start
```

On Windows PowerShell:

```powershell
$env:DATA_DIR=".\data"; $env:BASE_URL="http://localhost:3000"; npm start
```

Then open <http://localhost:3000/admin> to create the first admin.

---

## 🗺️ Routes

| Method | Route                         | Description                                  |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/`                           | No-signal / insert-cassette TV screen.       |
| GET    | `/admin`                      | Setup wizard \| login \| dashboard.          |
| POST   | `/admin/setup`                | Create the first admin (first run only).     |
| POST   | `/admin/login` `/admin/logout`| Authenticate / end session.                  |
| POST   | `/admin/libraries`            | Create a library.                            |
| POST   | `/admin/libraries/:id`        | Edit a library (title, slug, passcode).      |
| POST   | `/admin/libraries/:id/delete` | Delete a library and its tapes.              |
| POST   | `/admin/libraries/:id/videos` | Upload a tape (multipart).                   |
| POST   | `/admin/videos/:id/delete`    | Delete a tape.                               |
| GET    | `/:slug`                      | Library keypad (if locked) or cassette shelf.|
| POST   | `/:slug/unlock`               | Submit a passcode.                           |
| GET    | `/:slug/watch/:videoId`       | Virtual VCR + player page.                   |
| GET    | `/media/:videoId`             | Range-aware original video stream (gated).   |

---

## 🔐 Security notes

- Admin and library passcodes are hashed with **bcrypt**; passcodes are never
  stored or displayed in plaintext.
- The raw media stream enforces the same passcode gate as the library page, so
  protected tapes can't be hot-linked.
- Set a strong `SESSION_SECRET` and serve over HTTPS in production (cookies are
  marked `Secure` automatically when `BASE_URL` starts with `https://`).

## 📁 Project layout

```
src/
├── server.js              # Express app + wiring
├── config.js              # env-var driven configuration
├── db.js                  # SQLite schema + data access (metadata only)
├── storage.js             # media storage controller: Multer + chunked streaming
├── util.js                # slug/passcode helpers
├── middleware/auth.js     # admin + library-access guards
├── routes/
│   ├── admin.js           # setup, auth, library + upload management
│   ├── library.js         # public slug pages, unlock, player
│   └── media.js           # range-aware streaming
└── styles/input.css       # Tailwind entry point
views/                     # EJS templates (no-signal, admin, library)
public/                    # static assets: retro.css, JS, fonts, favicon
```

Be kind, rewind. 📼

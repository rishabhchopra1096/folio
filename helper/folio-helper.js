#!/usr/bin/env node
/*
 * =============================================================================
 * FOLIO HELPER — fetches YouTube captions for the web app
 * =============================================================================
 * WHAT THIS IS FOR:
 * Folio needs a video's real caption timings. Without them the model has to
 * guess where it is in the video, and it cannot: asked to timestamp a
 * 42-minute video it compressed the whole thing into the first 20 minutes and
 * placed a scene from 38:49 at 0:30 — a median error of 563 seconds. Handed
 * the real timings to copy, the same model lands within 16.
 *
 * WHY IT HAS TO RUN HERE, ON YOUR MACHINE:
 * Nothing else can get those captions.
 *   - A browser tab cannot read youtube.com (not CORS-readable) and the
 *     embedded player refuses to serve its own track (is_servable: false).
 *   - A cloud function cannot either: YouTube answers a datacenter IP with
 *     "Sign in to confirm you're not a bot", even through yt-dlp. Cookies
 *     would work and would mean putting a Google session on a server, which
 *     is not worth the account.
 *   - This machine can, because it is a normal residential connection.
 *
 * WHY A BROWSER IS ALLOWED TO CALL IT:
 * http://127.0.0.1 is treated as a secure context, so an https page may talk
 * to it without mixed-content blocking. CORS is opened deliberately below.
 *
 * WHAT IT DOES NOT DO:
 * No credentials, no cookies, no account. It shells out to yt-dlp for public
 * caption tracks and returns them. It serves nothing else and writes nothing
 * outside its own cache.
 * =============================================================================
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.FOLIO_HELPER_PORT || 8787);
const CACHE = path.join(os.tmpdir(), "folio-helper-cache");
fs.mkdirSync(CACHE, { recursive: true });

/* yt-dlp lives in different places depending on how it was installed. */
function findYtDlp() {
  const candidates = [
    process.env.YT_DLP,
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return "yt-dlp";                       // fall back to PATH
}
const YTDLP = findYtDlp();

const run = (args, timeout) => new Promise((resolve, reject) => {
  execFile(YTDLP, args, { timeout: timeout || 120000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(0, 400)));
      resolve(stdout);
    });
});

/*
 * A caption track, as {t, text} cues.
 *
 * Cached on disk: captions never change, and a repeat request should not go
 * near the network. Music-only cues are dropped — they carry no information
 * and would only dilute what the model is given.
 */
async function captions(videoId) {
  const file = path.join(CACHE, `${videoId}.en.json3`);
  if (!fs.existsSync(file)) {
    const base = path.join(CACHE, videoId);
    await run(["--write-auto-sub", "--sub-lang", "en", "--sub-format", "json3",
      "--skip-download", "--no-warnings", "-o", `${base}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`]);
  }
  if (!fs.existsSync(file)) throw new Error("no english caption track for this video");

  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const cues = [];
  for (const e of data.events || []) {
    if (!e.segs) continue;
    const t = Math.round((e.tStartMs || 0) / 1000);
    const text = e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text || text === "[Music]") continue;
    const last = cues[cues.length - 1];
    if (last && last.t === t) { last.text += " " + text; continue; }
    cues.push({ t, text });
  }
  return cues;
}

/* Title and duration, so the caller can size its work and label the document. */
async function meta(videoId) {
  const out = await run(["--no-warnings", "--skip-download",
    "--print", "%(duration)s|%(title)s", `https://www.youtube.com/watch?v=${videoId}`], 60000);
  const [dur, ...rest] = out.trim().split("|");
  return { duration: parseFloat(dur) || 0, title: rest.join("|").trim() };
}

function send(res, code, body) {
  const out = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json",
    // Deliberately open: this listens on loopback only, and the whole point is
    // that a page served from anywhere can ask the local machine for captions.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "content-length": out.length,
  });
  res.end(out);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "folio-helper", version: 1, ytdlp: YTDLP });
  }

  if (url.pathname === "/captions") {
    const id = (url.searchParams.get("v") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
    if (!id) return send(res, 400, { ok: false, error: "missing video id" });
    try {
      const [cues, m] = await Promise.all([captions(id), meta(id).catch(() => ({}))]);
      return send(res, 200, { ok: true, videoId: id, cues,
        duration: m.duration || 0, title: m.title || "" });
    } catch (e) {
      return send(res, 502, { ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }

  send(res, 404, { ok: false, error: "not found" });
});

// Loopback only. Nothing outside this machine can reach it.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`folio-helper listening on http://127.0.0.1:${PORT} (yt-dlp: ${YTDLP})`);
});

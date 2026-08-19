/*
 * =============================================================================
 * GEMINI.JS — YouTube transcription via the Gemini API
 * =============================================================================
 * FILE OVERVIEW:
 * Turns a YouTube URL into a timestamped transcript. Gemini accepts a YouTube
 * link directly as a `file_data` part — no downloading, no captions scraping,
 * no server — and returns segments with start times in seconds, which is
 * exactly what's needed to answer "which line is being spoken right now".
 *
 * THE COMPONENTS:
 * 1. Key storage   - the user's own API key, in localStorage
 * 2. parseYouTube  - recognise and normalise the many YouTube URL shapes
 * 3. transcribe    - the API call, returning [{ start, text }]
 *
 * WHY THE KEY LIVES IN LOCALSTORAGE:
 * Folio is a static site with a PUBLIC GitHub repo. A key committed to source
 * would be caught by GitHub secret scanning and auto-revoked, and would in any
 * case be readable in DevTools by anyone visiting the site. Gemini permits
 * direct browser calls (verified by preflight: it echoes our origin and allows
 * `x-goog-api-key`), so the user's own key stays on their machine and never
 * enters the bundle. Same arrangement as the Groq key in js/voice.js.
 * =============================================================================
 */

const Gemini = (function () {

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  const KEY_STORAGE = "folio_gemini_key";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

  // Flash is the right tier here: video understanding is the expensive part,
  // and a bigger model buys little for straight transcription.
  const MODEL = "gemini-flash-latest";

  // Video length past which we warn before spending the user's quota. Roughly
  // where a request starts taking minutes rather than seconds.
  const LONG_VIDEO_MINUTES = 30;

  // ==========================================================================
  // KEY STORAGE
  // ==========================================================================

  function getKey() { return localStorage.getItem(KEY_STORAGE) || ""; }
  function setKey(k) {
    if (!k) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, k.trim());
  }
  function clearKey() { localStorage.removeItem(KEY_STORAGE); }
  function hasKey() { return !!getKey(); }

  // ==========================================================================
  // URL PARSING
  // ==========================================================================

  /*
   * Recognise the YouTube URL shapes people actually paste: watch links, short
   * youtu.be links, /embed/, /shorts/, /live/, and any of them carrying extra
   * query parameters or a playlist. Returns { videoId, url, start } or null.
   *
   * `start` picks up ?t=90 / ?t=1m30s so pasting a link to a specific moment
   * lands you there.
   */
  function parseYouTube(raw) {
    if (!raw || typeof raw !== "string") return null;
    const s = raw.trim();
    if (!/youtube\.com|youtu\.be/i.test(s)) return null;

    let u;
    try {
      u = new URL(s.startsWith("http") ? s : "https://" + s);
    } catch {
      return null;
    }

    const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    let id = null;

    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0];
    } else if (host.endsWith("youtube.com")) {
      if (u.pathname === "/watch") {
        id = u.searchParams.get("v");
      } else {
        const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }

    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;

    return {
      videoId: id,
      url: "https://www.youtube.com/watch?v=" + id,
      start: parseStartParam(u.searchParams.get("t") || u.hash.replace(/^#t=/, "")),
    };
  }

  // "90", "90s", "1m30s", "1h2m3s" -> seconds
  function parseStartParam(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!m) return 0;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  }

  // ==========================================================================
  // TRANSCRIPTION
  // ==========================================================================

  /*
   * Ask Gemini for a timestamped transcript of a YouTube video.
   *
   * Returns [{ start: seconds, text: string }], sorted and de-duplicated.
   * `onProgress(msg)` is called with human-readable status, because a long
   * video can take minutes and silence reads as a hang.
   */
  async function transcribeYouTube(url, opts) {
    opts = opts || {};
    const key = getKey();
    if (!key) throw new Error("Add your Gemini API key in Settings → Video first.");

    const parsed = parseYouTube(url);
    if (!parsed) throw new Error("That doesn't look like a YouTube link.");

    const progress = opts.onProgress || function () {};
    progress("Asking Gemini to watch the video…");

    const body = {
      contents: [{
        parts: [
          { file_data: { file_uri: parsed.url } },
          { text: PROMPT },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        // Long videos produce long transcripts; don't get truncated mid-way.
        maxOutputTokens: 65536,
        temperature: 0,
      },
    };

    let res;
    try {
      res = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error("Network error contacting Gemini: " + (err.message || "unknown"));
    }

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || "";
      } catch { /* not JSON */ }

      if (res.status === 400 && /API key/i.test(detail)) {
        throw new Error("Gemini rejected the key. Check it in Settings → Video.");
      }
      if (res.status === 429) {
        throw new Error("Gemini rate limit reached. Try again shortly.");
      }
      if (res.status === 403) {
        throw new Error("Gemini refused the request — the key may lack access. " + detail);
      }
      throw new Error(`Gemini error ${res.status}${detail ? ": " + detail : ""}`);
    }

    progress("Reading the transcript…");
    const data = await res.json();

    // A blocked or empty response has candidates but no usable text.
    const cand = data.candidates && data.candidates[0];
    const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
    const text = part && part.text;
    if (!text) {
      const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason);
      throw new Error("Gemini returned no transcript" + (reason ? " (" + reason + ")" : ""));
    }

    return normalizeSegments(text);
  }

  const PROMPT = [
    "Transcribe the spoken audio of this video.",
    "",
    "Return JSON only: an array of objects, each with:",
    '  "start" — the moment the segment begins, in SECONDS as a number',
    '  "text"  — what is said, as clean readable prose',
    "",
    "Rules:",
    "- Split at natural sentence or thought boundaries, not fixed intervals.",
    "- Aim for segments of roughly one to three sentences.",
    "- Punctuate and capitalise properly. Remove filler words and stutters.",
    "- Do NOT include timestamps inside the text field.",
    "- Cover the whole video from start to finish, in order.",
    "- If nothing is spoken, return an empty array.",
  ].join("\n");

  /*
   * Gemini is asked for JSON and generally obliges, but be defensive: strip
   * code fences, accept a wrapped object, coerce "1:23"-style starts, drop
   * anything unusable, and enforce ordering. A malformed segment should cost
   * one line, not the whole transcript.
   */
  function normalizeSegments(raw) {
    let parsed;
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("Gemini's transcript wasn't valid JSON");
    }

    // Accept [..] or { segments: [..] } / { transcript: [..] }
    let arr = parsed;
    if (!Array.isArray(arr)) {
      arr = parsed.segments || parsed.transcript || parsed.result || null;
    }
    if (!Array.isArray(arr)) throw new Error("Gemini's transcript wasn't a list of segments");

    const out = [];
    for (const item of arr) {
      if (!item) continue;
      const text = String(item.text == null ? "" : item.text).trim();
      if (!text) continue;
      const start = toSeconds(item.start != null ? item.start : item.startTime);
      if (start == null) continue;
      out.push({ start: start, text: text });
    }

    out.sort((a, b) => a.start - b.start);

    // Drop exact duplicate start times, keeping the longer text.
    const dedup = [];
    for (const seg of out) {
      const prev = dedup[dedup.length - 1];
      if (prev && Math.abs(prev.start - seg.start) < 0.01) {
        if (seg.text.length > prev.text.length) prev.text = seg.text;
        continue;
      }
      dedup.push(seg);
    }
    return dedup;
  }

  // Accept 12, "12", "12.5", "1:23", "01:02:03"
  function toSeconds(v) {
    if (typeof v === "number" && isFinite(v)) return Math.max(0, v);
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, parseFloat(s));
    const parts = s.split(":").map((p) => parseFloat(p));
    if (parts.length >= 2 && parts.every((n) => isFinite(n))) {
      return parts.reduce((acc, n) => acc * 60 + n, 0);
    }
    return null;
  }

  // Format seconds as 1:23 / 1:02:03, for the timestamp shown beside each line.
  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  return {
    getKey, setKey, clearKey, hasKey,
    parseYouTube,
    transcribeYouTube,
    formatTime,
    LONG_VIDEO_MINUTES,
    // exported for tests
    _normalizeSegments: normalizeSegments,
    _toSeconds: toSeconds,
  };
})();

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

  /*
   * Pinned to 2.5-flash deliberately, NOT "gemini-flash-latest".
   *
   * "latest" silently follows whatever is newest — currently 3.7-flash — which
   * costs more per video for no benefit here. Straight transcription is not a
   * reasoning task, and video understanding is already the expensive part of
   * the request. Pinning also means a new model release can't quietly change
   * either the bill or the output format this code parses.
   */
  const MODEL = "gemini-2.5-flash";

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
   * Stream a timestamped transcript of a YouTube video.
   *
   * WHY STREAMING. A single blocking request on a 45-minute video measured
   * **551 seconds** — nine minutes of nothing on screen. The same video
   * streaming delivers its first line in about **28 seconds**, because output
   * tokens are generated serially and there is no reason to withhold the early
   * ones. `onSegments` is called repeatedly with whatever has arrived so far,
   * so the transcript fills in as you watch.
   *
   * WHY JSONL AND NOT A JSON ARRAY. A partially-received array is not valid
   * JSON and cannot be parsed, which defeats the point. One object per line
   * means every completed line is independently parseable the moment it lands.
   *
   * WHAT WAS NOT THE PROBLEM: thinking. It used 44 tokens on that 45-minute
   * video. Disabling it was measured and made things WORSE — 752s and a
   * truncated transcript, because without those few planning tokens the model
   * over-produces and hits the output cap. Left on deliberately.
   *
   * WHY NOT PARALLEL CHUNKS. Gemini accepts start/end offsets, but the
   * timestamps it returns for a clip are unreliable — a 60s clip came back
   * with eight segments all between 0.0 and 0.49, and a 0-240s clip returned
   * times up to 339s. Timestamps are the entire point here, so clipping is
   * unusable.
   */
  async function transcribeYouTube(url, opts) {
    opts = opts || {};
    const key = getKey();
    if (!key) throw new Error("Add your Gemini API key in Settings → Video first.");

    const parsed = parseYouTube(url);
    if (!parsed) throw new Error("That doesn't look like a YouTube link.");

    const progress = opts.onProgress || function () {};
    const onSegments = opts.onSegments || null;
    const signal = opts.signal;

    const body = {
      contents: [{
        parts: [
          { file_data: { file_uri: parsed.url, mime_type: "video/mp4" } },
          { text: PROMPT },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 65536,
        /*
         * Thinking is deliberately LEFT ON. Disabling it looked obviously
         * right — it bills at the output rate and transcription isn't a
         * reasoning task — and measuring proved the opposite:
         *
         *   thinking on   551s  output 15,911  STOP        443 segments
         *   thinking off  752s  output 65,525  MAX_TOKENS  truncated
         *
         * It used all of 44 thinking tokens, and those 44 tokens are what keep
         * the model terse and on-task. Without them it over-produces, blows
         * the output budget and the transcript is cut off. Slower AND worse.
         */
      },
    };

    progress("Gemini is watching the video…");

    let res;
    try {
      res = await fetch(
        `${API_BASE}/${MODEL}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: signal,
        }
      );
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      throw new Error("Network error contacting Gemini: " + (err.message || "unknown"));
    }

    if (!res.ok) throw await describeError(res);
    if (!res.body) throw new Error("Gemini returned no stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";      // unconsumed SSE bytes
    let textBuf = "";     // unconsumed model text, split on newlines
    const segments = [];
    let finishReason = null;
    let lastPush = 0;

    const flush = (force) => {
      if (!onSegments || !segments.length) return;
      const now = Date.now();
      // Throttled: a long transcript would otherwise rewrite the document
      // hundreds of times.
      if (!force && now - lastPush < 1500) return;
      lastPush = now;
      onSegments(segments.slice());
    };

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        break;                     // treat a broken stream as end-of-data
      }
      if (chunk.done) break;

      sseBuf += decoder.decode(chunk.value, { stream: true });

      let nl;
      while ((nl = sseBuf.indexOf("\n")) !== -1) {
        const line = sseBuf.slice(0, nl).trim();
        sseBuf = sseBuf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;

        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

        const cand = evt.candidates && evt.candidates[0];
        if (cand && cand.finishReason) finishReason = cand.finishReason;
        const parts = (cand && cand.content && cand.content.parts) || [];
        for (const p of parts) if (p.text) textBuf += p.text;
      }

      // Consume whole lines of model output as JSONL.
      let mnl;
      while ((mnl = textBuf.indexOf("\n")) !== -1) {
        const raw = textBuf.slice(0, mnl);
        textBuf = textBuf.slice(mnl + 1);
        const seg = parseJsonlLine(raw);
        if (seg) segments.push(seg);
      }
      flush(false);
    }

    // Whatever is left may be a final line with no trailing newline.
    const tail = parseJsonlLine(textBuf);
    if (tail) segments.push(tail);

    if (finishReason === "MAX_TOKENS") {
      // Keep what arrived rather than throwing it all away — a partial
      // transcript of a long video is still useful — but say so.
      progress("Transcript was cut short (hit the length limit)");
    }

    const out = dedupeSorted(segments);
    flush(true);
    if (!out.length) {
      throw new Error("Gemini returned no transcript" +
                      (finishReason ? " (" + finishReason + ")" : ""));
    }
    return out;
  }

  async function describeError(res) {
    let detail = "";
    try {
      const j = await res.json();
      detail = (j.error && j.error.message) || "";
    } catch { /* not JSON */ }
    if (res.status === 400 && /API key/i.test(detail)) {
      return new Error("Gemini rejected the key. Check it in Settings → Video.");
    }
    if (res.status === 429) return new Error("Gemini rate limit reached. Try again shortly.");
    if (res.status === 403) return new Error("Gemini refused the request. " + detail);
    return new Error(`Gemini error ${res.status}${detail ? ": " + detail : ""}`);
  }

  /*
   * One JSONL line -> a segment, or null. Tolerant by design: the model
   * occasionally emits a code fence, a stray array bracket, or a trailing
   * comma, and one bad line should cost one line rather than the transcript.
   */
  function parseJsonlLine(raw) {
    if (!raw) return null;
    let t = String(raw).trim();
    if (!t) return null;
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    t = t.replace(/^[\[,]\s*/, "").replace(/[,\]]\s*$/, "").trim();
    if (!t.startsWith("{")) return null;
    let o;
    try { o = JSON.parse(t); } catch { return null; }
    const text = String(o.text == null ? "" : o.text).trim();
    if (!text) return null;
    const start = toSeconds(o.start != null ? o.start : o.startTime);
    if (start == null) return null;
    return { start: start, text: text };
  }

  /*
   * The prompt.
   *
   * JSONL, one object per line, because a partial JSON array can't be parsed
   * and streaming is the whole point.
   *
   * It asks for what is SHOWN as well as what is said. An earlier version said
   * "transcribe the spoken audio", which threw away most of the value: Gemini
   * is already watching the frames and being billed for them, and in a
   * gameplay or demo video the important things — menus, numbers, what the
   * person actually does — are shown rather than narrated. Visual lines are
   * prefixed so they stay distinguishable from speech when you read back.
   */
  const PROMPT = [
    "Transcribe this video for someone who will read it instead of watching it.",
    "",
    "Output ONE JSON object per line. No array brackets, no code fences, no",
    "commentary. Each line must be exactly:",
    '{"start": seconds_from_video_start_as_a_number, "text": "..."}',
    "",
    "What to include:",
    "- Everything spoken, as clean readable prose.",
    "- What is SHOWN but not said, when it carries meaning: on-screen text and",
    "  numbers (read them exactly), menus opened, actions taken, results that",
    "  appear. Prefix those lines with '[shows] ' inside the text field.",
    "",
    "Rules:",
    "- Split at natural sentence or thought boundaries, never fixed intervals.",
    "- Roughly one to three sentences per line.",
    "- Punctuate and capitalise properly. Drop filler words and stutters.",
    "- Never put a timestamp inside the text field.",
    "- Cover the whole video from beginning to end, in order, increasing start.",
    "- Emit nothing at all if the video has no speech and nothing notable shown.",
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

    return dedupeSorted(out);
  }

  // Sort by time and collapse duplicate starts, keeping the fuller text.
  function dedupeSorted(list) {
    const out = list.slice().sort((a, b) => a.start - b.start);
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

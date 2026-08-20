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
  const MODEL_STORAGE = "folio_gemini_model";
  const DEFAULT_MODEL = "gemini-3.7-flash";

  /*
   * WHY FLASH, NOT PRO — AND WHY THINKING IS OFF
   * ============================================
   * The transcript has to be readable INSTEAD of watching, so the measure is
   * words written per minute of video. The speech alone runs about 146.
   *
   * Thinking turned out to be the whole story. It looked like a quality knob
   * and it was making the output both slower and thinner — the model reasoned
   * its way into condensing, and in a live run two windows spent 15.7k tokens
   * thinking and had nothing left to write with. One 10-minute window:
   *
   *     model        thinking    time    words/min
   *     3.7-flash    default      ~17s      56-94
   *     3.1-pro      default      161s        186
   *     3.5-flash    LOW           53s         32   (ignores the setting)
   *     3.7-flash    LOW           51s        203
   *     3.1-pro      LOW           47s        206   <- second sample
   *     3.1-pro      LOW           55s        234   <- first sample
   *
   * Note the two pro samples: 234 and 206. The gap over flash that seemed to
   * justify roughly three times the price is inside its own run-to-run
   * variance. On the evidence flash and pro are indistinguishable once
   * thinking is off, so the default is flash.
   *
   * Cost, from those measured token counts, for 30 minutes of video
   * (3 windows of 10 minutes, 225,690 input tokens each):
   *
   *     flash   ~677k in + ~11k out   ~$0.37
   *     pro     ~677k in + ~11k out   ~$0.97
   *
   * Overridable, because someone may want to spend the difference.
   */
  function getModel() {
    try { return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL; }
    catch { return DEFAULT_MODEL; }
  }
  function setModel(m) {
    try {
      if (!m) localStorage.removeItem(MODEL_STORAGE);
      else localStorage.setItem(MODEL_STORAGE, String(m).trim());
    } catch { /* ignore */ }
  }

  // Video length past which we warn before spending the user's quota. Roughly
  // where a request starts taking minutes rather than seconds.
  const LONG_VIDEO_MINUTES = 30;

  // ==========================================================================
  // DIAGNOSTIC LOG
  // ==========================================================================
  /*
   * A transcription can come back short for several different reasons, and
   * from the outside they all look the same: fewer lines than expected. Was it
   * the output-token cap? A repetition loop? The connection dropping? A safety
   * block? A reload that killed the request? Guessing between those wasted
   * real time, so every run now records what happened.
   *
   * Kept in localStorage so it SURVIVES A RELOAD — which matters most, because
   * the interesting failures are exactly the ones that end the page session.
   * Ring-buffered and size-capped so it can never grow into the storage budget
   * the documents need.
   *
   * The API key is never written here. Nothing logs a request body.
   */
  const LOG_KEY = "folio_gemini_log";
  const LOG_MAX_ENTRIES = 400;
  const LOG_MAX_BYTES = 120000;

  function log(event, fields) {
    const entry = Object.assign({ t: new Date().toISOString(), ev: event }, fields || {});
    try {
      console.log("[gemini]", event, fields || "");
    } catch { /* ignore */ }
    try {
      const all = getLog();
      all.push(entry);
      while (all.length > LOG_MAX_ENTRIES) all.shift();
      let out = JSON.stringify(all);
      while (out.length > LOG_MAX_BYTES && all.length > 1) {
        all.shift();
        out = JSON.stringify(all);
      }
      localStorage.setItem(LOG_KEY, out);
    } catch { /* a full or unavailable store must never break transcription */ }
    return entry;
  }

  function getLog() {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function clearLog() {
    try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ }
  }

  /* The log as readable text, for pasting somewhere useful. */
  function formatLog() {
    const all = getLog();
    if (!all.length) return "No transcription activity recorded yet.";
    return all.map((e) => {
      const { t, ev } = e;
      const rest = Object.keys(e)
        .filter((k) => k !== "t" && k !== "ev")
        .map((k) => k + "=" + (typeof e[k] === "string" ? e[k] : JSON.stringify(e[k])))
        .join("  ");
      return `${t}  ${ev.padEnd(14)} ${rest}`;
    }).join("\n");
  }

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

  const CHUNK_TEMPERATURE = 0.4;
  /*
   * THINKING COUNTS AGAINST THIS. Two windows in a live run came back
   * truncated with outputTokens=652 and thoughtTokens=15728 — 16,380 against a
   * 16,384 cap — so the model spent its entire budget reasoning and had almost
   * nothing left to write. Both produced 5 lines where they should have
   * produced twenty. Give it room for both.
   */
  const CHUNK_MAX_TOKENS = 65536;

  /*
   * THINKING WAS MAKING IT BOTH SLOWER AND WORSE.
   *
   * It looked like a quality setting, so it was left on. Measured on one
   * window of a real video, four ways — seconds spent per minute of video, and
   * words written per minute of video:
   *
   *            window   thinking   time   words/min   think tokens   s/video-min
   *              300s    default    60s     109          4,323          12s
   *              600s    default   161s     186         17,819          16s
   *              300s    LOW        35s     270              0           7s
   *              600s    LOW        55s     234              0           6s
   *
   * Turning it down is faster, cheaper AND better prose. It reasoned its way
   * into condensing, and on two windows in a live run it spent 15.7k tokens
   * thinking and had almost nothing left to write with.
   *
   * Ten-minute windows over five: 6s per video-minute against 7, fewer tokens
   * for the same video (226k per 600s versus 146k per 300s, so 293k for the
   * same ten minutes split in two), and half as many requests — which halves
   * the exposure to the 503s and rate limits that have cost whole windows.
   * The 15% density given up against the 300s figure is worth that.
   */
  const THINKING_LEVEL = "low";

  /*
   * THE CAPTION-GROUNDED PATH — this is the correct one.
   *
   * The model cannot work out where it is in a long video. Asked to timestamp
   * a 42-minute video it compressed the whole thing into the first 20 minutes
   * and put a scene from 38:49 at 0:30: a median error of 563 seconds, which
   * makes every comment anchor wrong. Handed the video's own caption timings
   * and told to COPY one for each line, the same model lands within 16
   * seconds. That is the whole difference, and no amount of prompt work
   * substitutes for it.
   *
   * One request for the whole video. Chunking exists here only to finish a
   * long video that stopped early, and it is safe now precisely because the
   * clock comes from the captions rather than from the model's sense of
   * elapsed time.
   */
  const COVERAGE_TARGET = 0.95;
  const MAX_TOPUPS = 4;

  function captionPrompt(cues, opts) {
    const { from, to, duration, continuation } = opts;
    const lines = [
      "You are writing the document that REPLACES this video.",
      "The reader will never watch it. They cannot see the screen or hear the",
      "audio. Everything they understand, they understand because you wrote it.",
      "",
      "THE EXACT WORDS SPOKEN, WITH THE SECOND EACH LINE BEGINS, ARE BELOW.",
      "They come from the video's own captions and their timings are correct.",
      "",
      "--- SPOKEN WORDS ---",
      cues.map((c) => `[${c.t}] ${c.text}`).join("\n"),
      "--- END SPOKEN WORDS ---",
      "",
      "Output ONE JSON object per line, exactly:",
      '{"start": <a number COPIED from the list above>, "text": "..."}',
      "No array brackets, no code fences, no commentary.",
      "",
      "RULES FOR `start`, WHICH MATTER MORE THAN ANYTHING ELSE:",
      "- NEVER invent, estimate or calculate a timestamp. Copy one of the",
      "  numbers in square brackets above, exactly as written.",
      "- Work through them in order and carry on to the END of the list.",
      `- Produce about ${Math.max(15, Math.round((to - from) / 20))} entries, spaced roughly 20`,
      "  seconds apart. Never leave more than 45 seconds between two entries.",
    ];
    if (continuation) {
      lines.push(
        "",
        `This continues a document already written up to ${formatTime(from)}. Do NOT`,
        "introduce the video or recap what came before — begin with what is",
        "happening at the start of this stretch.");
    } else if (duration) {
      lines.push(`- This video is ${Math.round(duration)} seconds long; your last lines`,
        "  must cover its final minutes, not stop early.");
    }
    lines.push(
      "",
      "DO NOT SUMMARISE. Write it as if the reader will be tested on the",
      "details afterwards and cannot go back to the video.",
      "",
      "Each line is one paragraph of three to six sentences weaving together:",
      "- what is SAID in that stretch — use the words above, cleaned up but",
      "  complete, keeping the speaker's meaning and voice;",
      "- what HAPPENS ON SCREEN there — where we are, what is chosen, what",
      "  changes, what results, and any name or number that carries meaning.",
      "  This is the half the captions cannot give, so it matters most.",
      "",
      "- Name things. Never write 'this guy', 'here', or 'that one'.",
      "- Never invent on-screen text you cannot actually read.",
      "- Never repeat a sentence you have already written.");
    return lines.join("\n");
  }

  async function transcribeWithCaptions(url, parsed, key, cues, opts) {
    const progress = opts.onProgress || function () {};
    const onSegments = opts.onSegments || null;
    const runId = "r" + Date.now().toString(36);
    const t0 = Date.now();
    const duration = Number(opts.durationSec) ||
      (cues.length ? cues[cues.length - 1].t : 0);
    const capEnd = cues.length ? cues[cues.length - 1].t : 0;
    const valid = new Set(cues.map((c) => c.t));

    log("request", { run: runId, video: parsed.videoId, model: getModel(),
                     why: opts.reason || "start", doc: opts.docId || null,
                     mode: "captions", cues: cues.length,
                     duration: Math.round(duration) || null });

    const all = [];
    const seen = new Set();
    const take = (text) => {
      let added = 0;
      for (const line of String(text).split("\n")) {
        const s = line.trim();
        if (!s.startsWith("{")) continue;
        let o;
        try { o = JSON.parse(s.replace(/,\s*$/, "")); } catch { continue; }
        const st = Number(o && o.start);
        if (!o || !o.text || !Number.isFinite(st)) continue;
        /*
         * The timestamp must be one we handed over. A live run produced two
         * stamped past the end of the captions — invented, not copied — and
         * this is the check that caught them.
         */
        if (!valid.has(st) || seen.has(st)) continue;
        seen.add(st);
        all.push({ start: st, text: String(o.text).trim() });
        added++;
      }
      all.sort((a, b) => a.start - b.start);
      return added;
    };

    const lastCovered = () => (all.length ? all[all.length - 1].start : 0);

    for (let pass = 0; pass <= MAX_TOPUPS; pass++) {
      const from = pass === 0 ? 0 : lastCovered() + 1;
      if (pass > 0 && from >= capEnd - 60) break;
      const to = capEnd;
      const slice = pass === 0 ? cues : cues.filter((c) => c.t >= from);
      if (!slice.length) break;

      progress(pass === 0
        ? "Writing the narrative…"
        : `Continuing from ${formatTime(from)}…`);

      const part = { fileData: { fileUri: parsed.url, mimeType: "video/mp4" } };
      // Only a continuation narrows the video, and only to what is missing.
      if (pass > 0) {
        part.videoMetadata = { startOffset: Math.floor(from) + "s",
                               endOffset: Math.ceil(Math.min(to + 5, duration || to + 5)) + "s" };
      }
      const body = {
        contents: [{ parts: [part, { text: captionPrompt(slice,
          { from, to, duration, continuation: pass > 0 }) }] }],
        generationConfig: Object.assign({
          temperature: CHUNK_TEMPERATURE,
          maxOutputTokens: CHUNK_MAX_TOKENS,
        }, /gemini-3/.test(getModel())
          ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {}),
      };

      let j;
      try {
        j = await requestWithRetry(key, body, opts.signal, { run: runId, pass }, progress);
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        /*
         * The first pass failing means there is no document at all, so it is
         * reported. A later pass failing only means the tail is missing, and
         * what is already written is worth keeping.
         */
        if (pass === 0 || err.terminal) throw err;
        log("topup-failed", { run: runId, pass, msg: err.message });
        break;
      }

      const cand = (j.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).map((p) => p.text || "").join("");
      const before = all.length;
      const added = take(text);
      const u = j.usageMetadata || {};
      log("pass", { run: runId, pass, added, total: all.length,
                    covered: Math.round(lastCovered()),
                    finish: cand.finishReason,
                    inTok: u.promptTokenCount, outTok: u.candidatesTokenCount });

      if (onSegments && all.length) onSegments(all.slice());
      if (!added || all.length === before) break;          // no progress
      if (lastCovered() >= capEnd * COVERAGE_TARGET) break; // done
    }

    log("done", { run: runId, ms: Date.now() - t0, kept: all.length,
                  lastTime: Math.round(lastCovered()),
                  covered: capEnd ? Math.round(100 * lastCovered() / capEnd) : null });
    if (!all.length) throw new Error("Gemini returned no usable lines.");
    return all;
  }

  /* describeError works on a Response; continuations already have the body. */
  function describeErrorBody(status, j) {
    const detail = ((j && j.error && j.error.message) || "").slice(0, 300);
    if (status === 429 && /credit|depleted|billing|exceeded your current quota/i.test(detail)) {
      const e = new Error("Gemini has stopped accepting requests: " + detail);
      e.terminal = true;                 // waiting cannot fix an empty account
      return e;
    }
    if (status === 400 && /API key/i.test(detail)) {
      const e = new Error("Gemini rejected the key. Check it in Settings → Video.");
      e.terminal = true;
      return e;
    }
    if (status === 429) {
      const e = new Error("Gemini rate limit reached" + (detail ? ": " + detail : "."));
      e.retryable = true;
      e.slow = true;                     // a quota refuses in milliseconds and keeps refusing
      return e;
    }
    if (status >= 500) {
      /*
       * "This model is currently experiencing high demand" is the common one,
       * and it clears in seconds. Throwing on the first of these loses the
       * whole run for something that fixes itself — which is precisely what
       * happened once the old path's retry ladder was deleted along with it.
       */
      const e = new Error(`Gemini is busy (${status})${detail ? ": " + detail : "."}`);
      e.retryable = true;
      return e;
    }
    return new Error(`Gemini error ${status}${detail ? ": " + detail : ""}`);
  }

  // A busy model recovers in seconds; a rate limit needs far longer.
  const RETRY_BUSY = [4000, 12000, 30000];
  const RETRY_LIMITED = [15000, 45000, 90000, 150000];

  /*
   * One request, retried for the failures worth retrying. Returns the parsed
   * body, or throws the last error once the ladder is exhausted.
   */
  async function requestWithRetry(key, body, signal, tag, progress) {
    let last = null;
    for (let attempt = 0; ; attempt++) {
      let res, j;
      try {
        res = await fetch(`${API_BASE}/${getModel()}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: signal,
        });
        j = await res.json();
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        last = new Error("Network error contacting Gemini: " + (err.message || "unknown"));
        last.retryable = true;
        log("neterror", Object.assign({ attempt, msg: err.message || "unknown" }, tag));
      }

      if (!last && res.ok) return j;
      if (!last) {
        last = describeErrorBody(res.status, j);
        log("httperror", Object.assign({ attempt, status: res.status, msg: last.message }, tag));
      }
      if (last.terminal || !last.retryable) throw last;

      const ladder = last.slow ? RETRY_LIMITED : RETRY_BUSY;
      if (attempt >= ladder.length) {
        log("gaveup", Object.assign({ attempts: attempt + 1, msg: last.message }, tag));
        throw last;
      }
      const wait = ladder[attempt];
      log("retry", Object.assign({ attempt: attempt + 1, waitMs: wait, msg: last.message }, tag));
      if (progress) progress(`Gemini is busy — retrying in ${Math.round(wait / 1000)}s…`);
      await new Promise((r) => setTimeout(r, wait));
      last = null;
    }
  }

  /*
   * Transcribe a YouTube video into a timestamped narrative.
   *
   * CAPTIONS ARE REQUIRED, and that is a deliberate refusal rather than a
   * missing feature. Without them the model has to work out where it is in the
   * video, and it cannot: asked to timestamp a 42-minute video it compressed
   * the whole thing into the first 20 minutes and placed a scene from 38:49 at
   * 0:30 — a median error of 563 seconds. The result reads perfectly well and
   * anchors every comment to the wrong moment, which is far worse than an
   * honest failure, and cost a day of chasing symptoms before the cause was
   * found. Given the captions to copy from, the same model lands within 16
   * seconds.
   *
   * So there is no longer a caption-free path. The chunk planner, the window
   * walker, the repetition-loop detector and the past-the-end backstop all
   * existed to make guessed timestamps survivable; none of them made the
   * guesses right, and all of them are gone.
   */
  async function transcribeYouTube(url, opts) {
    opts = opts || {};
    const key = getKey();
    if (!key) throw new Error("Add your Gemini API key in Settings → Video first.");

    const parsed = parseYouTube(url);
    if (!parsed) throw new Error("That doesn't look like a YouTube link.");

    if (!Array.isArray(opts.cues) || !opts.cues.length) {
      const e = new Error(
        "No captions for this video, so the timings would be guesses. Start the " +
        "helper (node helper/folio-helper.js) and try again, or use Import to " +
        "paste a transcript.");
      e.needsCaptions = true;
      log("refused", { video: parsed.videoId, why: "no captions" });
      throw e;
    }

    return transcribeWithCaptions(url, parsed, key, opts.cues, opts);
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
    getModel,
    setModel,
    DEFAULT_MODEL,
    formatTime,
    log,
    getLog,
    clearLog,
    formatLog,
    LONG_VIDEO_MINUTES,
  };
})();

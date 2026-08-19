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
  /*
   * WHY THIS IS CHUNKED, AND WHY IT USED TO BE WRONG
   * ================================================
   * Asking for a whole video in one request produced transcripts with large
   * stretches of INVENTED content. Two measured cases: 28 minutes fabricated
   * on a 52:37 video, and about 14 minutes on a 35:58 one, where the model
   * fell into a cycle and replayed a made-up scene with the numbers counting
   * up. It is not a subtle failure — it is most of the transcript.
   *
   * Requesting the same material as clips fixes it. Measured on the exact
   * window that had failed, 600-1200s of the second video:
   *
   *   whole video,  temperature 0    ~14 minutes fabricated, 551s
   *   clip 600-1200, temperature 0     146 lines, 94% unique, 69s
   *   clip 600-1200, temperature 0.4   121 lines, 99% unique, 34s
   *
   * Scored against YouTube's own captions for that window, the chunked output
   * is 96% precision and 95% recall on vocabulary — near caption quality.
   *
   * Two separate effects, both kept:
   *   - A bounded context stops the model drifting into a cycle, and caps what
   *     any single failure can ruin.
   *   - Temperature ABOVE ZERO. Greedy decoding is the textbook cause of
   *     degenerate repetition; the old code pinned temperature to 0, which was
   *     actively feeding the problem. It was also twice as slow.
   *
   * TIMESTAMPS. A clip must be told WHERE IT SITS. Asked for "seconds from the
   * start of the video" with no offset given, a 600s clip came back with every
   * timestamp between 0 and 56 — useless for anchoring a comment. Told "this
   * clip begins at 600 seconds, use whole-video seconds", the same request
   * returned 600.0-875.0, monotonic and in range. That instruction is load
   * bearing; do not simplify it away.
   */
  const CHUNK_SEC = 600;          // 10 minutes: proven, and ~4 requests/hour of video
  const MAX_WINDOWS = 24;         // only used when the duration is unknown
  const CHUNK_TEMPERATURE = 0.4;
  const CHUNK_MAX_TOKENS = 16384; // ample for 10 minutes; caps the cost of a bad window

  function planWindows(duration) {
    if (!(duration > 0)) return null;         // unknown — walk until it runs dry
    const out = [];
    for (let s = 0; s < duration; s += CHUNK_SEC) {
      out.push({ from: s, to: Math.min(duration, s + CHUNK_SEC) });
    }
    return out;
  }

  async function transcribeYouTube(url, opts) {
    opts = opts || {};
    const key = getKey();
    if (!key) throw new Error("Add your Gemini API key in Settings → Video first.");

    const parsed = parseYouTube(url);
    if (!parsed) throw new Error("That doesn't look like a YouTube link.");

    const progress = opts.onProgress || function () {};
    const onSegments = opts.onSegments || null;
    const signal = opts.signal;
    const runId = "r" + Date.now().toString(36);
    const t0 = Date.now();
    const since = () => Date.now() - t0;
    const duration = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 0;

    const planned = planWindows(duration);
    log("request", { run: runId, video: parsed.videoId, model: MODEL,
                     why: opts.reason || "start", doc: opts.docId || null,
                     duration: Math.round(duration) || null,
                     chunks: planned ? planned.length : "unknown" });

    const all = [];
    let emptyRun = 0;
    let firstError = null;

    for (let i = 0; ; i++) {
      const w = planned
        ? planned[i]
        : { from: i * CHUNK_SEC, to: (i + 1) * CHUNK_SEC };
      if (!w) break;
      if (!planned && i >= MAX_WINDOWS) break;

      progress(`Transcribing ${formatTime(w.from)}–${formatTime(w.to)}…`);

      let segs;
      try {
        segs = await transcribeWindow(parsed.url, key, w, {
          signal: signal,
          runId: runId,
          index: i,
          progress: progress,
          // Show the transcript growing while a window is still streaming.
          onPartial: (partial) => {
            if (onSegments) onSegments(dedupeSorted(all.concat(partial)));
          },
        });
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        /*
         * One bad window must not cost the rest of the video. Note it, carry
         * on, and let the retry button deal with the gap — losing ten minutes
         * beats losing an hour.
         */
        log("chunkfailed", { run: runId, chunk: i, from: w.from, to: w.to,
                             msg: (err && err.message) || "unknown" });
        if (!firstError) firstError = err;
        continue;
      }

      if (segs.length) {
        emptyRun = 0;
        all.push.apply(all, segs);
        if (onSegments) onSegments(dedupeSorted(all.slice()));
      } else {
        emptyRun++;
        // With no duration to plan against, two silent windows means the end.
        if (!planned && emptyRun >= 2) break;
      }
    }

    const out = dedupeSorted(all);
    log("done", { run: runId, ms: since(), kept: out.length,
                  lastTime: out.length ? Math.round(out[out.length - 1].start) : 0,
                  chunks: planned ? planned.length : "unknown" });

    if (!out.length) {
      log("empty", { run: runId });
      throw firstError || new Error("Gemini returned no transcript");
    }
    return out;
  }

  /*
   * One window, streamed. Returns its segments; throws only if the window
   * itself failed outright.
   */
  async function transcribeWindow(videoUrl, key, w, o) {
    const t0 = Date.now();
    const since = () => Date.now() - t0;
    const tag = { run: o.runId, chunk: o.index, from: w.from, to: w.to };

    const body = {
      contents: [{
        parts: [
          { fileData: { fileUri: videoUrl, mimeType: "video/mp4" },
            videoMetadata: { startOffset: w.from + "s", endOffset: w.to + "s" } },
          { text: promptFor(w.from, w.to) },
        ],
      }],
      generationConfig: {
        temperature: CHUNK_TEMPERATURE,
        maxOutputTokens: CHUNK_MAX_TOKENS,
      },
    };

    let res;
    try {
      res = await fetch(`${API_BASE}/${MODEL}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: o.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        log("aborted", Object.assign({ ms: since(), where: "connect" }, tag));
        throw err;
      }
      log("neterror", Object.assign({ ms: since(), msg: err.message || "unknown" }, tag));
      throw new Error("Network error contacting Gemini: " + (err.message || "unknown"));
    }

    log("http", Object.assign({ status: res.status, ok: res.ok, ms: since() }, tag));
    if (!res.ok) {
      const e = await describeError(res);
      log("httperror", Object.assign({ status: res.status, msg: e.message }, tag));
      throw e;
    }
    if (!res.body) {
      log("nostream", Object.assign({ ms: since() }, tag));
      throw new Error("Gemini returned no stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";
    let textBuf = "";
    const segments = [];
    let finishReason = null;
    let usage = null;
    let lastPush = 0;
    let sawFirst = false;
    let dropped = 0;
    let lastLogged = 0;
    const loop = newLoopWatch();
    let loopedAt = -1;

    const flush = (force) => {
      if (!o.onPartial || !segments.length) return;
      const now = Date.now();
      if (!force && now - lastPush < 1500) return;
      lastPush = now;
      o.onPartial(segments.slice());
    };

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err && err.name === "AbortError") {
          log("aborted", Object.assign({ ms: since(), segments: segments.length }, tag));
          throw err;
        }
        log("streambroke", Object.assign({ ms: since(), segments: segments.length,
                                           msg: (err && err.message) || "unknown" }, tag));
        break;
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

        if (evt.usageMetadata) usage = evt.usageMetadata;
        if (evt.promptFeedback && evt.promptFeedback.blockReason) {
          log("blocked", Object.assign({ reason: evt.promptFeedback.blockReason }, tag));
        }
        const cand = evt.candidates && evt.candidates[0];
        if (cand && cand.finishReason && cand.finishReason !== finishReason) {
          finishReason = cand.finishReason;
          log("finishreason", Object.assign({ reason: finishReason, ms: since(),
                                              segments: segments.length }, tag));
        }
        const parts = (cand && cand.content && cand.content.parts) || [];
        for (const p of parts) if (p.text) textBuf += p.text;
      }

      let mnl;
      while ((mnl = textBuf.indexOf("\n")) !== -1) {
        const raw = textBuf.slice(0, mnl);
        textBuf = textBuf.slice(mnl + 1);
        const seg = parseJsonlLine(raw);
        if (!seg) continue;

        /*
         * A timestamp outside the window is the model guessing rather than
         * reading. Dropping it is what keeps a comment anchored to the right
         * moment. A little slack either side absorbs rounding.
         */
        if (seg.start < w.from - 5 || seg.start > w.to + 5) { dropped++; continue; }

        segments.push(seg);

        if (!sawFirst) {
          sawFirst = true;
          log("firstline", Object.assign({ ms: since(), at: Math.round(seg.start) }, tag));
        }
        // A heartbeat every 15s, so a window that stalls is visible in the log
        // rather than just being slow.
        if (Date.now() - lastLogged > 15000) {
          lastLogged = Date.now();
          log("progress", Object.assign({ ms: since(), segments: segments.length,
                                          upto: Math.round(seg.start) }, tag));
        }

        if (loop.note(seg.text)) {
          loopedAt = loop.startedAt;
          log("loop", Object.assign({ ms: since(), detectedAt: segments.length,
                                      keeping: loopedAt,
                                      discarding: segments.length - loopedAt,
                                      lastTime: Math.round(seg.start) }, tag));
          break;
        }
      }
      if (loopedAt >= 0) break;
      flush(false);
    }

    if (loopedAt >= 0) {
      segments.length = Math.max(0, loopedAt);
      try { await reader.cancel(); } catch { /* already closed */ }
      if (o.progress) {
        o.progress(`${formatTime(w.from)}–${formatTime(w.to)}: stopped early, ` +
                   "the model began repeating itself");
      }
    } else {
      /*
       * A final line with no trailing newline — but never after a loop, or we
       * would push one of the repeated lines straight back on after having
       * just trimmed them off.
       */
      const tail = parseJsonlLine(textBuf);
      if (tail && tail.start >= w.from - 5 && tail.start <= w.to + 5) segments.push(tail);
    }

    flush(true);
    log("chunkdone", Object.assign({
      ms: since(), kept: segments.length, dropped: dropped,
      finish: finishReason || "END_OF_STREAM", looped: loopedAt >= 0,
      promptTokens: usage ? usage.promptTokenCount : null,
      outputTokens: usage ? usage.candidatesTokenCount : null,
      thoughtTokens: usage ? usage.thoughtsTokenCount : null,
    }, tag));

    return segments;
  }

  const LOOP_RUN = 18;

  /*
   * A window over which almost no NEW text appearing is itself proof of a
   * loop, whatever order the lines come in.
   */
  const LOOP_WINDOW = 40;
  /*
   * Deliberately brutal. Three or fewer distinct sentences across forty
   * consecutive lines is not speech. A looser threshold looked tempting and is
   * actively dangerous on this user's material: a Pokemon grinding sequence
   * genuinely repeats a handful of stock lines, and once digits are collapsed
   * those lines look identical. Chunking already bounds what a missed loop can
   * ruin, so this leans hard towards never cutting a real transcript short.
   */
  const LOOP_WINDOW_DISTINCT = 3;

  /*
   * Normalising for loop detection is not the same as normalising for display.
   *
   * The loop that got through varied only in its NUMBERS — a fabricated battle
   * replayed with the level and stats counting up each time, so no two lines
   * were ever byte-identical and verbatim matching never fired once in
   * fourteen minutes of invented content. Collapsing digit runs makes that
   * cycle visible as the exact repetition it actually is.
   */
  function loopKey(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\s+/g, " ")
      .trim();
  }

  function newLoopWatch() {
    const firstSeen = new Map();   // normalised text -> earliest index it appeared
    let n = 0;                     // how many segments we have inspected
    let run = 0;                   // length of the current ordered mirror
    let expect = -1;               // index the NEXT segment should mirror
    let mirrorStart = -1;          // index this run started mirroring
    let period = 0;                // cycle length, once one wrap has happened
    let startedAt = -1;            // index in OUR stream where the run began
    let lastKey = null;            // previous line, for the period-1 case
    let sameRun = 0;               // how many times it has repeated back-to-back
    let sameStart = -1;
    const recent = [];            // the last LOOP_WINDOW keys, for saturation

    const reset = (i, j) => {
      if (j < 0) { run = 0; expect = -1; mirrorStart = -1; period = 0; startedAt = -1; return; }
      run = 1; mirrorStart = j; expect = j + 1; period = 0; startedAt = i;
    };

    return {
      get startedAt() { return startedAt; },
      /* Returns true once the run is long enough to call it a loop. */
      note(text) {
        const k = loopKey(text);
        const i = n++;
        if (!k) return false;

        /*
         * Saturation: if the last LOOP_WINDOW lines contain barely any
         * distinct text, we are going in circles regardless of the order they
         * arrive in. Catches loops that interleave — an unchanging line
         * alternating with a line that only varies by a number — which the
         * ordered mirror below can miss.
         */
        recent.push(k);
        if (recent.length > LOOP_WINDOW) recent.shift();
        if (recent.length === LOOP_WINDOW &&
            new Set(recent).size <= LOOP_WINDOW_DISTINCT) {
          startedAt = Math.max(0, i - LOOP_WINDOW + 1);
          return true;
        }

        /*
         * The simplest loop of all: one line, over and over. The cycle rule
         * below deliberately ignores a period of 1 — otherwise "the same
         * sentence said twice" would start a run — so it is caught here
         * instead, where a long enough streak is unambiguous.
         */
        if (k === lastKey) { sameRun++; } else { sameRun = 1; sameStart = i; lastKey = k; }
        if (sameRun >= LOOP_RUN) { startedAt = sameStart + 1; return true; }

        if (!firstSeen.has(k)) {
          firstSeen.set(k, i);
          reset(i, -1);
          return false;
        }
        const j = firstSeen.get(k);

        if (j === expect) {
          run++;
          expect = j + 1;
        } else if (j === mirrorStart && expect - mirrorStart > 1 &&
                   (period === 0 || expect - mirrorStart === period)) {
          /*
           * The cycle has started over. Guarded three ways, because a loose
           * wrap rule is worse than none: the run must have consumed at least
           * two segments (so "the same line twice" is not a cycle), and once a
           * period is established every later wrap must match it. Without the
           * period check, four lines in random order kept the run alive by
           * chance and a genuine transcript could be cut short.
           */
          period = expect - mirrorStart;
          run++;
          expect = mirrorStart + 1;
        } else {
          reset(i, j);
        }
        return run >= LOOP_RUN;
      },
    };
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
  /*
   * The prompt for ONE window.
   *
   * The offset sentence is load bearing — see the note above transcribeYouTube.
   * So is the instruction to DESCRIBE what is on screen rather than transcribe
   * it word for word: the fabricated stretches were overwhelmingly '[shows]'
   * lines inventing menu and dialogue text the model could not actually read
   * at one frame per second.
   */
  function promptFor(from, to) {
    return [
      "Transcribe this clip for someone who will read it instead of watching it.",
      "",
      "Output ONE JSON object per line. No array brackets, no code fences, no",
      "commentary. Each line must be exactly:",
      '{"start": seconds_as_a_number, "text": "..."}',
      "",
      "WHERE THIS CLIP SITS:",
      `This clip is taken from a longer video. It begins at ${Math.round(from)} seconds`,
      `and ends at ${Math.round(to)} seconds.`,
      "- `start` is SECONDS FROM THE START OF THE WHOLE VIDEO, so every start",
      `  must be between ${Math.round(from)} and ${Math.round(to)}.`,
      "- Cover the clip from beginning to end, in order, with increasing start.",
      "",
      "What to include:",
      "- Everything spoken, as clean readable prose.",
      "- What is SHOWN but not said, when it genuinely adds meaning: a menu",
      "  opened, an action taken, a result that appears. Prefix those with",
      "  '[shows] ' and DESCRIBE them briefly in your own words.",
      "- Do NOT transcribe on-screen text word for word, and never write out",
      "  text you cannot clearly read. If you are unsure what it says, say what",
      "  is happening instead, or leave it out.",
      "",
      "Rules:",
      "- Split at natural sentence or thought boundaries, never fixed intervals.",
      "- Roughly one to three sentences per line.",
      "- Punctuate and capitalise properly. Drop filler words and stutters.",
      "- Never put a timestamp inside the text field.",
      "- Never repeat a line you have already emitted. If nothing new is",
      "  happening, emit nothing rather than restating what you just said.",
      "- Emit nothing at all if the clip has no speech and nothing notable shown.",
    ].join("\n");
  }

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
    log,
    getLog,
    clearLog,
    formatLog,
    LONG_VIDEO_MINUTES,
    // exported for tests
    _normalizeSegments: normalizeSegments,
    _newLoopWatch: newLoopWatch,
    _LOOP_RUN: LOOP_RUN,
    _toSeconds: toSeconds,
  };
})();

/*
 * =============================================================================
 * SPEECHIFY.JS — Simba 3.2 voices for the reader
 * =============================================================================
 * FILE OVERVIEW:
 * This file provides a second speech engine for js/tts.js. The system voice
 * (Web Speech) is free and instant but sounds like 2009; Speechify's Simba 3.2
 * sounds like a person. Everything else about reading — play/pause, sentence
 * navigation, dictation, pause-to-comment, the video clock — is untouched,
 * because this file implements exactly the same small interface the system
 * voice already implements:
 *
 *     { id, label, needsKey, available(), voices(), defaultVoice(),
 *       speak(text, opts) -> { stop(), setRate(r) } }
 *
 * js/tts.js calls speak() in exactly one place (js/tts.js:582) and never learns
 * which engine answered.
 *
 * HOW IT WORKS — the four things that make this hard, and what we do:
 *
 * 1. THE API IS SLOW TO FINISH BUT FAST TO START. Asking for a whole 400-
 *    character chunk and waiting takes ~3.5 seconds before any sound. Asking
 *    for the first sentence alone takes ~1.5. So every chunk is split into a
 *    small HEAD and the REST, both requested at the same moment: the head is
 *    playing long before the rest has finished arriving.
 *
 * 2. TIMINGS ARRIVE AS UNICODE CODE POINT OFFSETS, not the UTF-16 offsets
 *    JavaScript's slice() uses. Measured, not assumed: a mark reading [8,13)
 *    of "Alpha 🎨 bravo charlie" is "bravo" by code points and " brav" by
 *    slice(). One character of drift per preceding emoji, compounding down the
 *    page. Every mark is converted once, at ingest, and nothing downstream ever
 *    thinks about it again.
 *
 * 3. THE SAME REQUEST TWICE RETURNS DIFFERENT AUDIO AND DIFFERENT TIMINGS.
 *    So audio and its marks are cached together as one unit and evicted
 *    together. Re-requesting either half alone would desynchronise them.
 *
 * 4. SPEED IS A PLAYBACK CONCERN, NEVER A SYNTHESIS ONE. playbackRate changes
 *    how fast currentTime advances, not what it means, so mark milliseconds and
 *    currentTime stay in the same units at every rate and sync is automatic.
 *    If you ever find yourself multiplying a timestamp by the rate, that is the
 *    bug. Pitch correction is required by the HTML spec, so there is no
 *    chipmunk.
 *
 * MEASUREMENTS BEHIND THESE CHOICES: techDocs/speechify-phase0-measured.md
 * =============================================================================
 */

const SpeechifyProvider = (function () {

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  const KEY_STORAGE = "folio_speechify_key";
  const VOICE_STORAGE = "folio_speechify_voice";
  const STREAM_URL = "https://api.speechify.ai/v1/audio/stream/with-timestamps";
  const MODEL = "simba-3.2";

  /*
   * Only eight of Speechify's 988 voices support simba-3.2 — verified against
   * /v1/voices rather than taken from documentation. All English; a non-English
   * document has no voice here and belongs on the system engine.
   */
  const VOICES = [
    { id: "geffen_32",   name: "Geffen",   gender: "female", lang: "en-US" },
    { id: "harper_32",   name: "Harper",   gender: "female", lang: "en-US" },
    { id: "dominic_32",  name: "Dominic",  gender: "male",   lang: "en-US" },
    { id: "wyatt_32",    name: "Wyatt",    gender: "male",   lang: "en-US" },
    { id: "beatrice_32", name: "Beatrice", gender: "female", lang: "en-GB" },
    { id: "imogen_32",   name: "Imogen",   gender: "female", lang: "en-GB" },
    { id: "edmund_32",   name: "Edmund",   gender: "male",   lang: "en-GB" },
    { id: "hugh_32",     name: "Hugh",     gender: "male",   lang: "en-GB" },
  ];

  /*
   * How much of a chunk to synthesise on its own so sound starts sooner.
   * Time to FIRST audio is a flat ~800ms whatever you send; what scales is how
   * long the whole thing takes to arrive. Measured: 80 chars complete in
   * 1,328ms, 150 in 1,957ms, 300 in 2,838ms. ~120 buys a start around 1.5s.
   */
  /*
   * How much of a cold chunk to synthesise on its own so sound starts sooner.
   *
   * This has to be big enough that the head OUT-SPEAKS the tail's download,
   * or there is a hole between them. From the measured table:
   * download ≈ 0.80s + 0.00705s/char, speech ≈ 0.051s/char. At a 1,200-char
   * chunk a 120-char head speaks for 6.1s while its tail needs 8.4s to arrive —
   * a 2.3s gap, which is what raising chunks from 400 to 1,200 quietly created.
   *
   * And the faster you read, the less time the head buys, so it scales with
   * rate: 220 chars at 1×, 660 at 3×.
   */
  const HEAD_CHARS_BASE = 220;

  /*
   * Measured on this API: a request completes in about
   *   0.80s + 0.00705s per character
   * and the speech it produces runs for about
   *   0.051s per character.
   */
  const DL_FIXED_S = 0.80;
  const DL_PER_CHAR_S = 0.00705;
  const SPEAK_PER_CHAR_S = 0.051;

  /*
   * The smallest head that still out-speaks its own tail's download.
   *
   * Solving  speech(H)/rate >= download(chunk - H)  for H, rather than guessing:
   *
   *   H >= (0.80 + 0.00705·C) / (0.051/rate + 0.00705)
   *
   * The earlier version was `220 × rate`, which ignored that a smaller head
   * leaves a BIGGER tail to fetch — so it overshot, and at 2× it overshot far
   * enough that medium chunks stopped being split at all. A logged session
   * shows the cost: a 660-character chunk at rate 2 needed a 168-character
   * head, got a 440-character one, fell under the no-split threshold, and the
   * reader waited 6.8 seconds for the whole thing instead of ~2.3 for a head.
   *
   * A third is added on top as margin, and it is never allowed to grow into
   * most of the chunk — at that point splitting has stopped buying anything.
   */
  function headCharsFor(rate, chunkChars) {
    const r = Math.max(1, rate || 1);
    const C = chunkChars || 1200;
    const needed = (DL_FIXED_S + DL_PER_CHAR_S * C) /
                   (SPEAK_PER_CHAR_S / r + DL_PER_CHAR_S);
    return Math.round(Math.max(120, Math.min(C * 0.7, needed * 1.3)));
  }

  // Audio for a whole document is far too big to keep. This is a session cache.
  const CACHE_MAX = 32;

  // ==========================================================================
  // THE LOG — so a failure can be read afterwards instead of guessed at
  // ==========================================================================

  /*
   * Every request, retry, cache hit and failure, with timings.
   *
   * Reading aloud fails in ways the console cannot explain on its own: a burst
   * of 429s says the rate limit was hit but not by how many requests, and a
   * gap between sentences could be the network, the queue or a retry. This
   * records enough to tell those apart. Kept in memory only.
   */
  const LOG_MAX = 1200;
  const LOG_STORAGE = "folio_speechify_log";
  const STATS_STORAGE = "folio_speechify_stats";
  const t0Session = Date.now();

  /*
   * The log is PERSISTED, not just held in memory.
   *
   * A reading session spans reloads — that is rather the point of caching audio
   * on disk — and an in-memory log would lose exactly the history that explains
   * what a session cost. Capped, and it holds no text beyond a short excerpt.
   */
  let logEntries = (function () {
    try {
      const raw = JSON.parse(localStorage.getItem(LOG_STORAGE) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  })();

  /*
   * Running totals, so a session can be costed without replaying the log.
   *
   * `billedChars` is what was actually SENT to Speechify — the thing on the
   * invoice. `savedChars` is what was served from memory or disk instead, i.e.
   * what caching avoided paying for. Their ratio against the document's own
   * length is the number that says whether anything is leaking.
   */
  const BLANK_STATS = {
    billedChars: 0, savedChars: 0, requests: 0,
    memHits: 0, diskHits: 0, shared: 0,
    retries: 0, rateLimited: 0, dropped: 0, failed: 0,
    fetched: {},          // key excerpt -> chars, for spotting what was bought
    played: {},           // key excerpt -> times played
    startedAt: null,
  };
  let stats = (function () {
    try {
      const raw = JSON.parse(localStorage.getItem(STATS_STORAGE) || "null");
      return raw && typeof raw === "object" ? Object.assign({}, BLANK_STATS, raw)
                                            : Object.assign({}, BLANK_STATS);
    } catch { return Object.assign({}, BLANK_STATS); }
  })();

  let flushTimer = null;
  function persistSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      try {
        localStorage.setItem(LOG_STORAGE, JSON.stringify(logEntries.slice(-LOG_MAX)));
        localStorage.setItem(STATS_STORAGE, JSON.stringify(stats));
      } catch { /* storage full or private mode — the session still reads */ }
    }, 500);
  }

  function log(ev, fields) {
    const entry = Object.assign({ t: Date.now() - t0Session, ev: ev }, fields || {});
    logEntries.push(entry);
    if (logEntries.length > LOG_MAX) logEntries.shift();
    if (stats.startedAt === null) stats.startedAt = new Date().toISOString();
    persistSoon();
    return entry;
  }

  function getLog() { return logEntries.slice(); }
  function clearLog() {
    logEntries = [];
    stats = Object.assign({}, BLANK_STATS, { fetched: {}, played: {} });
    try {
      localStorage.removeItem(LOG_STORAGE);
      localStorage.removeItem(STATS_STORAGE);
    } catch { /* ignore */ }
  }

  /* A short, stable stand-in for a chunk, so the report is readable. */
  function excerpt(text) {
    return text.slice(0, 40).replace(/\s+/g, " ").trim() + "…";
  }

  /*
   * What this session cost, and what it would have cost without the cache.
   *
   * `wasted` is the important one: audio that was paid for and never played.
   * Every entry there is money spent on sound nobody heard.
   */
  function costReport(perMillion) {
    const rate = (typeof perMillion === "number" ? perMillion : 6) / 1e6;
    const wasted = Object.keys(stats.fetched)
      .filter((k) => !stats.played[k])
      .map((k) => ({ chunk: k, chars: stats.fetched[k] }));
    const wastedChars = wasted.reduce((n, w) => n + w.chars, 0);

    return {
      startedAt: stats.startedAt,
      billedChars: stats.billedChars,
      savedChars: stats.savedChars,
      spent: +(stats.billedChars * rate).toFixed(4),
      savedByCache: +(stats.savedChars * rate).toFixed(4),
      requests: stats.requests,
      memHits: stats.memHits,
      diskHits: stats.diskHits,
      sharedInFlight: stats.shared,
      retries: stats.retries,
      rateLimited: stats.rateLimited,
      droppedBeforeSending: stats.dropped,
      failed: stats.failed,
      paidForButNeverPlayed: wasted.length,
      wastedChars: wastedChars,
      wastedSpend: +(wastedChars * rate).toFixed(4),
      wastedDetail: wasted.slice(0, 20),
    };
  }

  /* Human-readable, for pasting somewhere. Summary first. */
  function formatLog() {
    const r = costReport();
    const head = [
      "===== SPEECHIFY SESSION =====",
      `started              ${r.startedAt || "(nothing yet)"}`,
      `characters BILLED    ${r.billedChars.toLocaleString()}   ($${r.spent})`,
      `characters from cache${String(r.savedChars.toLocaleString()).padStart(6)}   (saved $${r.savedByCache})`,
      `requests             ${r.requests}`,
      `  memory hits        ${r.memHits}`,
      `  disk hits          ${r.diskHits}`,
      `  shared in-flight   ${r.sharedInFlight}`,
      `  dropped unsent     ${r.droppedBeforeSending}`,
      `retries              ${r.retries}  (rate limited ${r.rateLimited})`,
      `failed               ${r.failed}`,
      `PAID FOR, NEVER HEARD${String(r.paidForButNeverPlayed).padStart(5)}   ` +
        `(${r.wastedChars.toLocaleString()} chars, $${r.wastedSpend})`,
    ];
    if (r.wastedDetail.length) {
      head.push("  wasted chunks:");
      r.wastedDetail.forEach((wd) => head.push(`    ${wd.chars} ch  ${wd.chunk}`));
    }
    head.push("===== EVENTS =====");

    return head.join("\n") + "\n" + logEntries.map((e) => {
      const rest = Object.keys(e)
        .filter((k) => k !== "t" && k !== "ev")
        .map((k) => `${k}=${typeof e[k] === "object" ? JSON.stringify(e[k]) : e[k]}`)
        .join(" ");
      return `${String((e.t / 1000).toFixed(2)).padStart(8)}s  ${e.ev.padEnd(18)} ${rest}`;
    }).join("\n");
  }

  // ==========================================================================
  // THE KEY — localStorage only, never in source
  // ==========================================================================

  function getKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
  }
  function setKey(k) {
    /*
     * Strip whitespace AND any quotes a copy-paste dragged along. A key with a
     * stray newline looks identical in a password field and fails with a 401
     * that reads like the key itself is wrong.
     */
    const clean = String(k || "").trim().replace(/^["'\s]+|["'\s]+$/g, "");
    rejectedKey = null;
    try { localStorage.setItem(KEY_STORAGE, clean); } catch { /* private mode */ }
  }
  function clearKey() {
    try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  }
  function hasKey() { return !!getKey(); }

  /*
   * A key the server has already rejected.
   *
   * Without this, one bad key produces a burst of 401s: the head, the tail and
   * the lookahead each fire their own request, and every chunk tries again.
   * The rejection is remembered against the key itself, so correcting it in
   * Settings clears the block immediately with nothing to reset by hand.
   */
  let rejectedKey = null;
  function keyWasRejected() { return rejectedKey !== null && rejectedKey === getKey(); }
  function noteKeyRejected() { rejectedKey = getKey(); }

  // ==========================================================================
  // CODE POINTS -> UTF-16
  // ==========================================================================

  /*
   * A lookup from code-point index to UTF-16 index for one string.
   *
   * Built once per synthesis and used to convert every mark, because doing it
   * per mark would rescan the string each time. The extra final entry lets an
   * end offset one past the last character resolve without a bounds check.
   */
  function codePointToUtf16Map(text) {
    const map = new Uint32Array([...text].length + 1);
    let u16 = 0, i = 0;
    for (const ch of text) { map[i++] = u16; u16 += ch.length; }
    map[i] = u16;
    return map;
  }

  // ==========================================================================
  // SYNTHESIS
  // ==========================================================================

  /*
   * Turn one piece of text into { url, marks }.
   *
   * The response is Server-Sent Events carrying base64 mp3 fragments and word
   * timings. The fragments concatenate into a valid mp3 with no container
   * fix-up — verified: 2,798 fragments for a 1,500-character chunk decoded to
   * a 72.98s file against a 73.46s batch render of the same text.
   *
   * `marks` come back with UTF-16 offsets relative to `text`, already sorted,
   * which is the shape the highlighter wants.
   */
  /*
   * NOTE THE MISSING ABORT SIGNAL, AND WHY IT IS MISSING.
   *
   * Aborting the fetch does not stop Speechify working. Measured directly: one
   * second into a long request the client abort was issued, and the account's
   * single concurrency slot stayed occupied for another ~4 seconds — the server
   * carried on generating. Generation is what is billed, so an abandoned
   * request costs exactly as much as a completed one and yields nothing.
   *
   * So once a request has STARTED it is left to finish, and its audio is cached
   * even if whoever asked for it has since paused, skipped away or closed the
   * player. The money is spent either way; this at least buys the audio, which
   * is then free the next time that passage is read.
   *
   * Abort still matters, but earlier: a job sitting in the queue has not been
   * sent yet, and dropping that genuinely saves the charge. See pump().
   */
  async function synthesize(text, voiceId) {
    const reqStart = Date.now();
    stats.requests++;
    log("request", { chars: text.length, voice: voiceId });

    if (keyWasRejected()) {
      const err = new Error("Speechify rejected this key — check it in Settings.");
      err.terminal = true;
      throw err;
    }

    const res = await fetch(STREAM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        voice_id: voiceId,
        audio_format: "mp3",
        model: MODEL,
      }),
    });

    if (!res.ok) throw await describeFailure(res);

    const cpMap = codePointToUtf16Map(text);
    const lastCp = cpMap.length - 1;
    const parts = [];
    const marks = [];
    let billed = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      /*
       * Keep the trailing fragment. A network chunk lands mid-line often
       * enough to matter, and parsing half a JSON object throws.
       */
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.audio) parts.push(base64ToBytes(ev.audio));
        if (typeof ev.billable_characters_count === "number") {
          billed += ev.billable_characters_count;
        }

        /*
         * Streaming sends a FLAT ARRAY here. The batch endpoint sends an
         * object with a .chunks array instead. Handling only one of the two
         * shapes is the single most common way to parse this API wrongly.
         */
        const sm = ev.speech_marks;
        if (!sm) continue;
        const list = Array.isArray(sm) ? sm : (sm.chunks || [sm]);
        for (const m of list) {
          if (!m || m.type !== "word") continue;
          const cs = Math.min(m.start, lastCp);
          const ce = Math.min(m.end, lastCp);
          marks.push({
            t0: m.start_time,
            t1: m.end_time,
            cs: cpMap[cs],            // now UTF-16, relative to `text`
            ce: cpMap[ce],
          });
        }
      }
    }

    if (!parts.length) throw new Error("Speechify returned no audio");

    const blob = new Blob(parts, { type: "audio/mpeg" });
    /*
     * `billed` here is what Speechify reported. It is summed across events, and
     * if the API sends a running total rather than a delta that sum overstates
     * it — so the invoice figure we trust is the characters we SENT, which is
     * what is actually charged for.
     */
    stats.billedChars += text.length;
    stats.fetched[excerpt(text)] = text.length;
    log("audio-ready", { chars: text.length, ms: Date.now() - reqStart,
                         kb: Math.round(blob.size / 1024), words: marks.length,
                         reportedBilled: billed,
                         totalBilledChars: stats.billedChars });
    return { url: URL.createObjectURL(blob), marks: marks, billed: billed, blob: blob };
  }

  /*
   * Say what actually went wrong, and whether trying again could ever help.
   *
   * An exhausted account and a rate limit are both 4xx and read alike, but one
   * clears in seconds and the other never does. Reporting the first as the
   * second sends you off to wait for something that will not happen.
   */
  async function describeFailure(res) {
    let detail = "";
    try {
      const body = await res.json();
      /*
       * The message field is not always a string — Speechify returns an object
       * for some errors, and concatenating it produced the useless
       * "Speechify: [object Object]" that made a 429 unreadable.
       */
      const raw = body && (body.message || body.error || body.detail || body);
      detail = typeof raw === "string" ? raw
             : raw ? JSON.stringify(raw).slice(0, 300)
             : "";
    } catch { /* body was not JSON */ }

    const err = new Error(
      detail ? `Speechify: ${detail}` : `Speechify error ${res.status}`);
    err.status = res.status;

    if (res.status === 401 || res.status === 403) {
      err.terminal = true;
      noteKeyRejected();
      /*
       * Describe the key without printing it. A truncated paste is by far the
       * likeliest cause, and a length is enough to see it — a working key is
       * ~45 characters and starts "sk_".
       */
      const k = getKey();
      const shape = !k ? "no key is saved"
        : `the saved key is ${k.length} characters and starts "${k.slice(0, 3)}"`;
      err.message = `Speechify rejected the API key — ${shape}. Re-paste it in Settings.`;
    } else if (res.status === 402 || /credit|quota|billing|subscription/i.test(detail)) {
      err.terminal = true;                 // more waiting will not fix an empty account
    } else if (res.status === 429) {
      err.retryable = true;
      err.rateLimited = true;
      // Honour the server's own figure when it gives one.
      const ra = res.headers.get("retry-after");
      if (ra) err.retryAfterMs = (parseFloat(ra) || 0) * 1000;
      err.message = "Speechify is rate limiting — waiting before trying again.";
    } else if (res.status >= 500) {
      err.retryable = true;
    }
    return err;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ==========================================================================
  // ONE REQUEST AT A TIME — because that is literally the plan's limit
  // ==========================================================================

  /*
   * MEASURED, not guessed. Firing two requests at once returns:
   *
   *   429 {"error":{"code":"concurrency_limit_reached",
   *        "message":"Concurrency limit exceeded: your plan allows 1
   *        simultaneous request"}}
   *
   * The first design fired three per chunk — a head, a tail and a lookahead —
   * so two of every three were refused, the chunk died, and reading stopped
   * after a sentence or two. Everything goes through this queue now; nothing
   * calls the API directly.
   *
   * A second, separate limit exists on sustained rate: 21 sequential requests
   * in 17 seconds also drew a 429. The retry ladder below covers both, and the
   * server tells us how long to wait in a Retry-After header.
   */
  const MAX_CONCURRENT = 1;
  let activeRequests = 0;
  const queue = [];

  function pump() {
    while (activeRequests < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();

      /*
       * Drop jobs nobody is waiting for any more. With one request allowed at a
       * time a job can sit here for seconds, and the reader may have been
       * stopped, or skipped somewhere else entirely, long before its turn
       * arrives. Running it anyway spends money on audio that will never be
       * played.
       */
      if (job.key) queuedByKey.delete(job.key);

      if (job.signal && job.signal.aborted) {
        stats.dropped++;
        log("dropped", { for: job.label, why: "abandoned before its turn" });
        job.reject(abortError());
        continue;
      }

      activeRequests++;
      job.run().then(job.resolve, job.reject).then(function () {
        activeRequests--;
        pump();
      });
    }
  }

  /* Jobs still waiting to be sent, by cache key, so a second caller can claim
     one before it is thrown away. See keepQueued. */
  const queuedByKey = new Map();

  function enqueue(run, label, signal, key) {
    return new Promise(function (resolve, reject) {
      const job = { run: run, resolve: resolve, reject: reject,
                    label: label, signal: signal, key: key };
      queue.push(job);
      if (key) queuedByKey.set(key, job);
      if (queue.length > 1) log("queued", { for: label, ahead: queue.length - 1 });
      pump();
    });
  }

  /*
   * Somebody else wants this too, so it must survive the first caller losing
   * interest.
   *
   * A real session showed what it costs otherwise: play was pressed, the
   * request queued, that attempt was superseded two seconds later, and
   * dropping its queued job killed the request the SECOND attempt was already
   * waiting on. The chunk had to be asked for all over again, sixteen seconds
   * later.
   */
  function keepQueued(key) {
    const job = queuedByKey.get(key);
    if (job) job.signal = null;
  }

  /*
   * A wait that gives up when the caller does.
   *
   * Plain setTimeout meant that stopping during a retry pause — up to ten
   * seconds on the last rung — still fired a fresh, billable request when the
   * timer expired.
   */
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      const id = setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener("abort", function () {
        clearTimeout(id);
        reject(abortError());
      }, { once: true });
    });
  }

  function abortError() {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
  }

  /*
   * Waiting out a refusal rather than reporting it.
   *
   * A concurrency 429 clears the moment the request ahead finishes, so the
   * first wait is short. The server's own Retry-After is preferred over our
   * guess whenever it sends one.
   */
  const RETRY_MS = [700, 2000, 5000, 10000];

  async function synthesizeWithRetry(text, voiceId, signal, label) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await synthesize(text, voiceId);
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        if (!err || !err.retryable || attempt >= RETRY_MS.length) {
          stats.failed++;
          log("failed", { for: label, attempt: attempt + 1,
                          why: String(err && err.message).slice(0, 90) });
          throw err;
        }
        const waitMs = err.retryAfterMs || RETRY_MS[attempt];
        stats.retries++;
        if (err.rateLimited) stats.rateLimited++;
        log("retry", { for: label, attempt: attempt + 1, waitMs: waitMs,
                       why: err.rateLimited ? "rate limited" : "server error" });
        await sleep(waitMs, signal);
      }
    }
  }

  // ==========================================================================
  // DISK CACHE — so a reload never costs money twice
  // ==========================================================================

  /*
   * Audio survives a reload, in IndexedDB.
   *
   * The rest of Folio keeps everything in localStorage, and this deliberately
   * does not: a single 1,200-character chunk is roughly 200KB of mp3, and a
   * real document (md.md, 18,043 words) is about 40MB against localStorage's
   * ~5MB ceiling. It would not fit, and Blobs cannot go in there anyway.
   *
   * What this buys is simple and worth the exception: you pay for a paragraph
   * ONCE. Reloading the page, re-reading yesterday's document, or scrolling
   * back to a section all replay from disk with no request and no charge.
   *
   * Keyed by voice + model + the exact text sent, so changing voice
   * synthesises afresh (correctly — the timings belong to a voice) while
   * re-reading the same words does not.
   */
  const DB_NAME = "folio-speech";
  const DB_STORE = "audio";
  const DB_VERSION = 1;
  const DISK_BUDGET_BYTES = 250 * 1024 * 1024;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: "key" });
          // Eviction walks oldest-used first, so it needs its own index.
          store.createIndex("lastUsed", "lastUsed");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB failed to open")); };
    }).catch(function (err) {
      // Private browsing and some lockdown modes refuse. Degrade to memory.
      log("disk-unavailable", { why: String(err && err.message).slice(0, 60) });
      return null;
    });
    return dbPromise;
  }

  function tx(db, mode) {
    return db.transaction(DB_STORE, mode).objectStore(DB_STORE);
  }

  const asPromise = (req) => new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });

  async function diskGet(key) {
    try {
      const db = await openDb();
      if (!db) return null;
      const rec = await asPromise(tx(db, "readonly").get(key));
      if (!rec) return null;
      // Record the touch so eviction knows what is still in use.
      rec.lastUsed = Date.now();
      try { tx(db, "readwrite").put(rec); } catch { /* touch is best effort */ }
      return rec;
    } catch (err) {
      log("disk-read-failed", { why: String(err && err.message).slice(0, 60) });
      return null;
    }
  }

  /*
   * Is this on disk? Asked before deciding whether to split a chunk, so it must
   * not drag the audio into memory just to answer.
   */
  async function diskHas(key) {
    try {
      const db = await openDb();
      if (!db) return false;
      const found = await asPromise(tx(db, "readonly").getKey(key));
      return found !== undefined;
    } catch { return false; }
  }

  async function diskPut(key, blob, marks) {
    try {
      const db = await openDb();
      if (!db) return;
      await asPromise(tx(db, "readwrite").put({
        key: key, blob: blob, marks: marks,
        bytes: blob.size, lastUsed: Date.now(),
      }));
      evictIfOver();
    } catch (err) {
      // A full disk must never stop the reading; it only stops the saving.
      log("disk-write-failed", { why: String(err && err.message).slice(0, 60) });
    }
  }

  /*
   * Drop the least recently used entries until we are back inside budget.
   * Runs after a write and never blocks playback.
   */
  async function evictIfOver() {
    try {
      const db = await openDb();
      if (!db) return;
      const all = await asPromise(tx(db, "readonly").getAll());
      let total = all.reduce((n, r) => n + (r.bytes || 0), 0);
      if (total <= DISK_BUDGET_BYTES) return;

      all.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
      const store = tx(db, "readwrite");
      let dropped = 0;
      for (const rec of all) {
        if (total <= DISK_BUDGET_BYTES * 0.9) break;
        store.delete(rec.key);
        total -= rec.bytes || 0;
        dropped++;
      }
      log("disk-evicted", { dropped: dropped, mb: Math.round(total / 1048576) });
    } catch { /* eviction is housekeeping; failing is survivable */ }
  }

  /* How much is stored, for the settings panel. */
  async function diskUsage() {
    try {
      const db = await openDb();
      if (!db) return { entries: 0, bytes: 0 };
      const all = await asPromise(tx(db, "readonly").getAll());
      return { entries: all.length, bytes: all.reduce((n, r) => n + (r.bytes || 0), 0) };
    } catch { return { entries: 0, bytes: 0 }; }
  }

  async function clearDisk() {
    try {
      const db = await openDb();
      if (!db) return;
      await asPromise(tx(db, "readwrite").clear());
      log("disk-cleared", {});
    } catch { /* ignore */ }
  }

  // ==========================================================================
  // CACHE — audio and its timings, always together
  // ==========================================================================

  /*
   * Keyed by exactly what was sent. Audio and marks are stored and dropped as
   * ONE entry because the model samples: the same request twice returns
   * different audio AND different timings, so a half-refreshed pair would put
   * the highlight permanently out of step with the sound.
   */
  const cache = new Map();
  const inFlight = new Map();

  /*
   * Voice AND model are part of the key: timings belong to the voice that
   * produced them, so a voice change must resynthesise rather than replay
   * someone else's marks. The separator is a character that cannot occur in
   * a voice id.
   */
  const cacheKey = (text, voiceId) => voiceId + "\u241f" + MODEL + "\u241f" + text;

  /*
   * Object URLs still attached to a playing <audio> element. Revoking one of
   * those kills the sound mid-sentence, and eviction had no idea which was in
   * use — reachable by moving through 32 distinct chunks in a session.
   */
  const inUse = new Set();

  function remember(key, entry) {
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      const dropped = cache.get(oldest);
      cache.delete(oldest);
      if (dropped && dropped.url && !inUse.has(dropped.url)) {
        URL.revokeObjectURL(dropped.url);
      }
    }
  }

  /*
   * Get audio for this text, synthesising only if we must.
   *
   * Requests already in flight are shared rather than duplicated — the
   * lookahead and the player routinely ask for the same segment at almost the
   * same moment, and paying twice for it would be both slower and billable.
   */
  function acquire(text, voiceId, signal) {
    const key = cacheKey(text, voiceId);
    const hit = cache.get(key);
    if (hit) {
      stats.memHits++; stats.savedChars += text.length;
      log("cache-hit", { chars: text.length, from: "memory",
                         totalSavedChars: stats.savedChars });
      return Promise.resolve(hit);
    }

    const pending = inFlight.get(key);
    if (pending) {
      keepQueued(key);            // a second claimant: it must not be dropped now
      stats.shared++; stats.savedChars += text.length;
      log("shared", { chars: text.length, totalSavedChars: stats.savedChars });
      return pending;
    }

    const label = `${text.length}ch "${text.slice(0, 24).replace(/\s+/g, " ")}…"`;

    /*
     * Disk before network, always. This is the whole point of the store: a
     * paragraph you have already heard must never be bought twice, whether you
     * reloaded the page, came back tomorrow, or scrolled up to re-read it.
     */
    const p = (async function () {
      const rec = await diskGet(key);
      if (rec && rec.blob) {
        const entry = { url: URL.createObjectURL(rec.blob), marks: rec.marks, blob: rec.blob };
        remember(key, entry);
        stats.diskHits++; stats.savedChars += text.length;
        log("cache-hit", { chars: text.length, from: "disk",
                           kb: Math.round((rec.bytes || 0) / 1024),
                           totalSavedChars: stats.savedChars });
        return entry;
      }
      const fresh = await enqueue(
        () => synthesizeWithRetry(text, voiceId, signal, label), label, signal, key);
      /*
       * Cached unconditionally. Whoever asked may have paused or skipped by
       * now, but the characters have been billed, so the audio is worth keeping
       * — it makes that passage free the next time it is read.
       */
      remember(key, fresh);
      if (fresh.blob) diskPut(key, fresh.blob, fresh.marks);   // not awaited
      return fresh;
    })();

    p.then(function () { inFlight.delete(key); },
           function () { inFlight.delete(key); });

    inFlight.set(key, p);
    return p;
  }

  /*
   * Warm a piece of text without waiting for it or caring if it fails.
   *
   * Given a signal of its own so it can be called off. A lookahead used to be
   * uncancellable, so closing the player or switching document mid-prefetch
   * still completed and billed. It deliberately does NOT share the current
   * utterance's signal — a lookahead is supposed to outlive the chunk that
   * triggered it; that is its whole purpose.
   */
  let prefetchAbort = typeof AbortController === "function" ? new AbortController() : null;

  function prefetch(text, voiceId) {
    if (!text || !text.trim() || !hasKey() || keyWasRejected()) return;
    acquire(text, voiceId, prefetchAbort && prefetchAbort.signal)
      .catch(() => { /* best effort */ });
  }

  /* Called when reading stops for good, so nothing keeps buying ahead. */
  function cancelPrefetch() {
    if (!prefetchAbort) return;
    prefetchAbort.abort();
    prefetchAbort = new AbortController();
    log("prefetch-cancelled", {});
  }

  // ==========================================================================
  // HOW LONG THE WAIT ACTUALLY IS
  // ==========================================================================

  /*
   * A network voice cannot start instantly, so the only honest thing to do is
   * say how long it will be — and then be right about it.
   *
   * Rather than quoting a number from a benchmark, this remembers how long the
   * last few starts really took on this machine and this connection, and shows
   * the median of those. The seed is the measured figure from
   * techDocs/speechify-phase0-measured.md (a ~120-character head completes in
   * about 1.5s), used only until there is real evidence to replace it.
   */
  const TIMING_STORAGE = "folio_speechify_timings";
  const SEED_FIRST_AUDIO_MS = 1500;
  const TIMING_SAMPLES = 8;

  function recordedTimings() {
    try {
      const raw = JSON.parse(localStorage.getItem(TIMING_STORAGE) || "[]");
      return Array.isArray(raw) ? raw.filter((n) => typeof n === "number" && n > 0) : [];
    } catch { return []; }
  }

  function recordFirstAudio(ms) {
    try {
      const all = recordedTimings().concat(ms).slice(-TIMING_SAMPLES);
      localStorage.setItem(TIMING_STORAGE, JSON.stringify(all));
    } catch { /* private mode — we just keep quoting the seed */ }
  }

  /*
   * The median, not the mean: one stalled request on a bad connection should
   * not drag the quoted figure up for the next eight reads.
   */
  function expectedFirstAudioMs() {
    const all = recordedTimings();
    if (!all.length) return SEED_FIRST_AUDIO_MS;
    const sorted = all.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // ==========================================================================
  // SPLITTING A CHUNK SO SOUND STARTS SOONER
  // ==========================================================================

  /*
   * Split into a short head and whatever is left.
   *
   * Both halves are requested at the same moment, so the head — which arrives
   * in about a second and a half — is already playing while the rest is still
   * downloading. Prefers a sentence end, then any space, so the seam lands
   * where a reader would pause anyway.
   */
  function splitHead(text, headChars) {
    const HEAD_CHARS = headChars || HEAD_CHARS_BASE;
    /*
     * Only skip splitting when a head would be nearly the whole chunk — then it
     * saves no time and just costs an extra request. The old threshold was 1.5×
     * the head, which at high rates excluded exactly the chunks that most
     * needed splitting.
     */
    if (text.length <= HEAD_CHARS * 1.15) return [text];

    const window = text.slice(0, HEAD_CHARS + 60);
    let cut = -1;
    const sentence = /[.!?]["')\]]?\s/g;
    let m;
    while ((m = sentence.exec(window))) {
      if (m.index + m[0].length >= HEAD_CHARS * 0.5) { cut = m.index + m[0].length; break; }
    }
    if (cut === -1) {
      const sp = text.lastIndexOf(" ", HEAD_CHARS);
      cut = sp > HEAD_CHARS * 0.4 ? sp + 1 : HEAD_CHARS;
    }
    return [text.slice(0, cut), text.slice(cut)];
  }

  // ==========================================================================
  // PLAYBACK
  // ==========================================================================

  /*
   * Which word is being spoken at time t.
   *
   * Searched fresh every frame rather than advanced with a cursor. That makes
   * it stateless, so seeking, stalling, a hidden tab and a speed change all
   * correct themselves on the next frame with no special handling for any of
   * them.
   */
  /*
   * The first word at or after a character offset — how a sentence skip turns
   * into a position in audio we already hold.
   */
  function markAtChar(marks, cs) {
    let lo = 0, hi = marks.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].cs >= cs) { best = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return best;
  }

  function markAt(marks, t) {
    let lo = 0, hi = marks.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].t0 <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  /*
   * Speak `text`, reporting each word as it is spoken.
   *
   * Returns the same handle shape js/tts.js already expects, plus setRate —
   * which the system voice cannot offer, because a Web Speech utterance's rate
   * is fixed once it starts. js/tts.js uses setRate when a provider has one and
   * falls back to stopping and respeaking when it does not, so the system voice
   * keeps its exact current behaviour.
   */
  function speak(text, opts) {
    const voiceId = (opts.voice && opts.voice.id) || currentVoiceId();
    const controller = new AbortController();

    /*
     * Split ONLY when we would otherwise be waiting.
     *
     * The head/tail split buys a fast start by getting a short first sentence
     * back in about a second — but it costs an extra request, and with a plan
     * that allows one request at a time an extra request is an extra stall.
     * A chunk that was already prefetched while the previous one played needs
     * no split at all: it is sitting in the cache, ready to play instantly.
     *
     * So the split is for the cold start, which is the only place it helps.
     */
    let segments = [text];
    let skippedChars = 0;
    let seekChars = Math.max(0, opts.startOffset || 0);
    let alreadyHave = false;

    const audio = new Audio();
    audio.preservesPitch = true;
    audio.playbackRate = opts.rate || 1;

    let stopped = false;
    let finished = false;
    let rafId = null;
    let segIndex = 0;
    let statusTimer = null;
    const startedAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
    let currentUrl = null;      // the object URL this element is holding
    let segOffset = 0;          // UTF-16 offset of this segment within `text`
    let marks = [];
    let lastReported = -1;

    const wanted = [];

    /*
     * Decide how to fetch this chunk — which cannot be done synchronously,
     * because the answer depends on what is on DISK.
     *
     * This used to ask only `cache.has(...)`, i.e. memory. After a reload
     * memory is empty, so every chunk was split into a head and a tail and
     * looked up under THEIR keys — while the disk held the whole chunk under
     * its own. Both halves missed and were bought again. The store existed and
     * was bypassed on exactly the path it was built for: reloading, and jumping
     * to a chunk you have already heard.
     */
    async function chooseSegments() {
      const wholeKey = cacheKey(text, voiceId);
      /*
       * IN FLIGHT COUNTS AS HAVING IT.
       *
       * Checking only memory and disk misses the window where the whole chunk
       * has been requested but has not arrived — which is precisely the moment
       * a pause-and-resume lands in. The resumed read saw no cached whole
       * chunk, split it, and bought a head and a tail alongside the whole one
       * already on its way: the same passage paid for twice.
       */
      alreadyHave = cache.has(wholeKey) || inFlight.has(wholeKey) ||
                    await diskHas(wholeKey);

      const allSegments = alreadyHave
        ? [text]
        : splitHead(text, headCharsFor(opts.rate, text.length));

      /*
       * Starting partway in: begin at the segment the offset lands in. Earlier
       * segments are never requested, so skipping into the middle of a chunk
       * does not pay for the part you skipped.
       */
      let firstSeg = 0;
      while (firstSeg < allSegments.length - 1 && seekChars >= allSegments[firstSeg].length) {
        seekChars -= allSegments[firstSeg].length;
        firstSeg++;
      }
      skippedChars = allSegments.slice(0, firstSeg).reduce((n, x) => n + x.length, 0);
      segments = allSegments.slice(firstSeg);

      log("speak", { chars: text.length, segments: segments.length,
                     have: alreadyHave ? "yes" : "no", rate: opts.rate || 1,
                     startAt: opts.startOffset || 0 });

      /*
       * Ask for the FIRST segment only. The tail is requested once the head is
       * actually playing (see playSegment), so a jump you abandon in the first
       * second costs a head rather than a whole chunk — which is the difference
       * between skimming cheaply and paying for eight times what you hear.
       */
      wanted[0] = acquire(segments[0], voiceId, controller.signal);
      wanted[0].catch(() => { /* surfaced when we await it */ });

      /*
       * The lookahead goes in AFTER the chunk being played, never before.
       *
       * This used to fire from the body of speak(), which runs before this
       * function's `await diskHas` resolves — so with one request allowed at a
       * time the NEXT chunk was synthesised first and the one you were waiting
       * for queued behind it. A real session showed 22 seconds between pressing
       * play and hearing anything, six of them spent rendering a passage that
       * had not been reached yet.
       */
      if (opts.next) prefetch(opts.next, voiceId);
    }

    const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

    /*
     * Say what is happening while there is nothing to hear.
     *
     * Deliberately silent for the first fifth of a second: a prefetched chunk
     * starts almost immediately, and flashing "preparing" at every chunk seam
     * would be noise rather than information.
     */
    function beginStatus() {
      if (!opts.onStatus) return;
      statusTimer = setInterval(function () {
        const elapsed = nowMs() - startedAt;
        if (elapsed < 200) return;
        opts.onStatus({
          phase: "preparing",
          elapsedMs: elapsed,
          expectedMs: expectedFirstAudioMs(),
        });
      }, 100);
    }

    function endStatus(phase) {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      if (opts.onStatus) opts.onStatus({ phase: phase });
    }

    function done(err) {
      if (finished) return;
      finished = true;
      endStatus(err ? "error" : "ended");
      cancelAnimationFrame(rafId);
      audio.pause();
      audio.removeAttribute("src");
      if (currentUrl) { inUse.delete(currentUrl); currentUrl = null; }
      if (err) opts.onError(err.message || "Speechify failed", err);
      else opts.onEnd();
    }

    function tick() {
      if (stopped || finished) return;
      const t = audio.currentTime * 1000;
      const i = markAt(marks, t);
      if (i !== -1 && i !== lastReported) {
        lastReported = i;
        const m = marks[i];
        // Offsets are relative to the whole `text` js/tts.js handed us.
        opts.onWord(segOffset + m.cs, m.ce - m.cs);
      }
      rafId = requestAnimationFrame(tick);
    }

    async function playSegment(i) {
      if (stopped) return;
      let entry;
      try {
        entry = await wanted[i];
      } catch (err) {
        return done(err);
      }
      if (stopped) return;

      marks = entry.marks;
      lastReported = -1;
      segOffset = skippedChars + segments.slice(0, i).reduce((n, s) => n + s.length, 0);

      if (currentUrl) inUse.delete(currentUrl);
      currentUrl = entry.url;
      inUse.add(currentUrl);

      const heard = excerpt(segments[i]);
      stats.played[heard] = (stats.played[heard] || 0) + 1;

      audio.src = entry.url;
      audio.playbackRate = opts.rate || 1;

      /*
       * Jump to the requested word rather than replaying from the top. This is
       * what makes a sentence skip instant: the audio is already here and the
       * marks say exactly where that character is spoken.
       */
      if (i === 0 && seekChars > 0) {
        const mi = markAtChar(entry.marks, seekChars);
        if (mi !== -1) {
          const at = entry.marks[mi].t0 / 1000;
          const seekWhenReady = function () { try { audio.currentTime = at; } catch { /* not seekable yet */ } };
          if (audio.readyState >= 1) seekWhenReady();
          else audio.addEventListener("loadedmetadata", seekWhenReady, { once: true });
          log("seek", { toChar: seekChars, toMs: Math.round(at * 1000) });
        }
      }
      audio.onended = function () {
        if (stopped) return;
        segIndex++;
        if (segIndex >= segments.length) return done(null);
        // If the next segment is not ready yet, this is where a gap is heard.
        log("seam", { to: segIndex, ready: !!cache.get(cacheKey(segments[segIndex], voiceId)) });
        playSegment(segIndex);
      };
      audio.onerror = function () {
        if (!stopped) done(new Error("Could not play the synthesised audio"));
      };

      try {
        await audio.play();
      } catch (err) {
        // Autoplay refusal is the realistic cause, and it is not recoverable
        // from here — the caller needs a real user gesture.
        return done(new Error("Playback was blocked by the browser"));
      }
      /*
       * Sound is out. Only the FIRST segment tells us anything about the wait —
       * later ones were prefetched while this one played, so timing them would
       * quietly train the estimate down towards zero and make the number a lie.
       */
      if (i === 0) {
        const waited = nowMs() - startedAt;
        /*
         * Only a genuine synthesis says anything about how long a wait is. A
         * cache hit returns in ~20ms, and folding those into the median trained
         * the "~1.5s" estimate down towards zero — so the bar promised a wait
         * it could not honour the next time a chunk was cold.
         */
        if (!alreadyHave) recordFirstAudio(waited);
        log("sound", { waitedMs: Math.round(waited), chars: segments[0].length,
                       from: alreadyHave ? "cache" : "network" });
        endStatus("speaking");

        /*
         * NOW ask for the rest of the chunk. Deferring it to this moment is
         * what makes skimming cheap: a jump abandoned before the head plays
         * never buys the tail at all.
         */
        for (let n = 1; n < segments.length; n++) {
          if (!wanted[n]) {
            wanted[n] = acquire(segments[n], voiceId, controller.signal);
            wanted[n].catch(() => { /* surfaced when awaited */ });
          }
        }
      }

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }

    beginStatus();
    chooseSegments().then(function () {
      if (!stopped) playSegment(0);
    }, function (err) {
      if (!stopped) done(err);
    });


    return {
      stop: function () {
        stopped = true;
        finished = true;
        endStatus("stopped");
        controller.abort();
        if (currentUrl) { inUse.delete(currentUrl); currentUrl = null; }
        cancelAnimationFrame(rafId);
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
      },
      /*
       * Speed, changed in place. No new request, no restart, no cost — and the
       * highlight needs no compensation, because playbackRate changes how fast
       * currentTime advances, not what it means.
       */
      setRate: function (r) {
        opts.rate = r;
        audio.playbackRate = r;
      },
    };
  }

  // ==========================================================================
  // VOICE SELECTION
  // ==========================================================================

  function currentVoiceId() {
    try { return localStorage.getItem(VOICE_STORAGE) || VOICES[0].id; }
    catch { return VOICES[0].id; }
  }
  function setVoiceId(id) {
    try { localStorage.setItem(VOICE_STORAGE, id); } catch { /* ignore */ }
  }

  // ==========================================================================
  // THE PROVIDER INTERFACE — identical in shape to the system voice
  // ==========================================================================

  return {
    id: "speechify",
    label: "Speechify Simba 3.2",
    needsKey: true,
    /*
     * Audio can be scrubbed, so js/tts.js sends the whole chunk and an offset
     * instead of slicing the text — which would miss the cache and re-bill.
     */
    canSeek: true,

    available: function () {
      return hasKey() && typeof Audio !== "undefined" && typeof fetch === "function";
    },

    /*
     * Shaped like SpeechSynthesisVoice enough for the settings UI to list them
     * without caring which engine they came from.
     */
    voices: function () {
      return VOICES.map((v) => ({
        id: v.id,
        name: `${v.name} (${v.lang === "en-GB" ? "British" : "American"} ${v.gender})`,
        lang: v.lang,
        localService: false,
      }));
    },

    defaultVoice: function () {
      const id = currentVoiceId();
      return this.voices().find((v) => v.id === id) || this.voices()[0] || null;
    },

    speak: speak,

    // Key + voice management, used by Settings.
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    hasKey: hasKey,
    setVoiceId: setVoiceId,
    currentVoiceId: currentVoiceId,

    // Called when reading stops, so no lookahead keeps buying.
    cancelPrefetch: cancelPrefetch,

    // The audio store, for the settings panel.
    diskUsage: diskUsage,
    clearDisk: clearDisk,

    // Diagnostics.
    costReport: costReport,
    getLog: getLog,
    clearLog: clearLog,
    formatLog: formatLog,

    // True once the server has rejected the key currently saved.
    keyWasRejected: keyWasRejected,

    // What the wait is expected to be, in ms, learned from real starts.
    expectedFirstAudioMs: expectedFirstAudioMs,

    // Exposed for tests and for warming the first chunk when a document opens.
    prefetch: prefetch,
    _recordFirstAudio: recordFirstAudio,
    _codePointToUtf16Map: codePointToUtf16Map,
    _splitHead: splitHead,
    _markAt: markAt,
    _markAtChar: markAtChar,
    _headCharsFor: headCharsFor,
  };
})();

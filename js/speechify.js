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
  const HEAD_CHARS = 120;

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
  const LOG_MAX = 400;
  const logEntries = [];
  const t0Session = Date.now();

  function log(ev, fields) {
    const entry = Object.assign({ t: Date.now() - t0Session, ev: ev }, fields || {});
    logEntries.push(entry);
    if (logEntries.length > LOG_MAX) logEntries.shift();
    return entry;
  }

  function getLog() { return logEntries.slice(); }
  function clearLog() { logEntries.length = 0; }

  /* Human-readable, for pasting somewhere. */
  function formatLog() {
    return logEntries.map((e) => {
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
  async function synthesize(text, voiceId, signal) {
    const reqStart = Date.now();
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
      signal: signal,
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
    log("audio-ready", { chars: text.length, ms: Date.now() - reqStart,
                         kb: Math.round(blob.size / 1024), words: marks.length,
                         billed: billed });
    return { url: URL.createObjectURL(blob), marks: marks, billed: billed };
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
      activeRequests++;
      job.run().then(job.resolve, job.reject).then(function () {
        activeRequests--;
        pump();
      });
    }
  }

  function enqueue(run, label) {
    return new Promise(function (resolve, reject) {
      queue.push({ run: run, resolve: resolve, reject: reject });
      if (queue.length > 1) log("queued", { for: label, ahead: queue.length - 1 });
      pump();
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        return await synthesize(text, voiceId, signal);
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        if (!err || !err.retryable || attempt >= RETRY_MS.length) {
          log("failed", { for: label, attempt: attempt + 1,
                          why: String(err && err.message).slice(0, 90) });
          throw err;
        }
        const waitMs = err.retryAfterMs || RETRY_MS[attempt];
        log("retry", { for: label, attempt: attempt + 1, waitMs: waitMs,
                       why: err.rateLimited ? "rate limited" : "server error" });
        await sleep(waitMs);
      }
    }
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

  const cacheKey = (text, voiceId) => `${voiceId} ${text}`;

  function remember(key, entry) {
    cache.set(key, entry);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      const dropped = cache.get(oldest);
      cache.delete(oldest);
      if (dropped && dropped.url) URL.revokeObjectURL(dropped.url);
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
    if (hit) { log("cache-hit", { chars: text.length }); return Promise.resolve(hit); }

    const pending = inFlight.get(key);
    if (pending) { log("shared", { chars: text.length }); return pending; }

    const label = `${text.length}ch "${text.slice(0, 24).replace(/\s+/g, " ")}…"`;
    const p = enqueue(() => synthesizeWithRetry(text, voiceId, signal, label), label)
      .then((entry) => { remember(key, entry); inFlight.delete(key); return entry; })
      .catch((err) => { inFlight.delete(key); throw err; });

    inFlight.set(key, p);
    return p;
  }

  /* Warm a piece of text without waiting for it or caring if it fails. */
  function prefetch(text, voiceId) {
    if (!text || !text.trim() || !hasKey() || keyWasRejected()) return;
    acquire(text, voiceId, undefined).catch(() => { /* best effort */ });
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
  function splitHead(text) {
    if (text.length <= HEAD_CHARS * 1.5) return [text];

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
    const alreadyHave = cache.has(cacheKey(text, voiceId));
    const segments = alreadyHave ? [text] : splitHead(text);
    log("speak", { chars: text.length, segments: segments.length,
                   cached: alreadyHave, rate: opts.rate || 1 });

    const audio = new Audio();
    audio.preservesPitch = true;
    audio.playbackRate = opts.rate || 1;

    let stopped = false;
    let finished = false;
    let rafId = null;
    let segIndex = 0;
    let statusTimer = null;
    const startedAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
    let segOffset = 0;          // UTF-16 offset of this segment within `text`
    let marks = [];
    let lastReported = -1;

    /* Both halves at once: the tail downloads while the head plays. */
    const wanted = segments.map((s) => acquire(s, voiceId, controller.signal));
    wanted.forEach((p) => p.catch(() => { /* surfaced when we await it */ }));

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
      segOffset = segments.slice(0, i).reduce((n, s) => n + s.length, 0);

      audio.src = entry.url;
      audio.playbackRate = opts.rate || 1;
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
        recordFirstAudio(waited);
        log("sound", { waitedMs: Math.round(waited), cached: alreadyHave });
        endStatus("speaking");
      }

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }

    beginStatus();
    playSegment(0);

    /*
     * Warm the chunk that comes next while this one plays. Without it every
     * chunk boundary would pay the full synthesis wait again, which is audible
     * as a gap roughly every twenty seconds.
     */
    if (opts.next) prefetch(opts.next, voiceId);

    return {
      stop: function () {
        stopped = true;
        finished = true;
        endStatus("stopped");
        controller.abort();
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

    // Diagnostics.
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
  };
})();

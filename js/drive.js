/*
 * =============================================================================
 * DRIVE.JS — Folio for a phone in a car cradle
 * =============================================================================
 * FILE OVERVIEW:
 * This is a second, much smaller front end for Folio, built for one situation:
 * you are driving, the phone is in a cradle or in your pocket, and you want a
 * document read to you and a way to say what you think about it without ever
 * looking at the screen for more than a second.
 *
 * So it has five controls and nothing else: play/pause, back fifteen seconds,
 * forward fifteen seconds, slower, faster — and one enormous button in the
 * middle that records a thought and files it against whatever paragraph was
 * being read when you pressed it.
 *
 * HOW IT WORKS - The Components:
 * 1. The picker      - every document, biggest tap targets possible, pick one
 * 2. preparation     - fetches each chunk's audio and JOINS IT INTO ONE FILE
 * 3. the player      - one <audio> element, played like a podcast
 * 4. media session   - puts play/pause/skip on the iOS lock screen
 * 5. voice notes     - record, hold the audio safely, transcribe, file the note
 * 6. the outbox      - notes that could not be sent yet, kept in IndexedDB
 *
 * THE FLOW:
 * You pick a document. We render it off screen (the same HTML the reader uses,
 * so it is cut into the same pieces and already-paid-for audio is reused), ask
 * Speechify for each piece, and glue the pieces into a single MP3. You press
 * the big play button once — that one real tap is what buys us permission to
 * control audio for the rest of the trip — and from then on everything works,
 * including from the lock screen.
 *
 * =============================================================================
 * WHY ONE BIG FILE AND NOT CHUNK-BY-CHUNK STREAMING
 * =============================================================================
 * The reader (js/tts.js) plays one chunk, then creates a new audio element for
 * the next one. On a desktop that is invisible. On a locked iPhone it is fatal:
 * WebKit will not let a backgrounded page start a NEW media element, so the
 * read goes silent at the first chunk boundary — about thirty seconds in — and
 * stays silent until you unlock the phone. That is the single most important
 * fact behind the design of this file.
 *
 * The way out is that MP3 is a stream of self-contained frames: concatenating
 * the bytes of two MP3s produces one valid MP3 that plays straight through. So
 * we fetch every chunk, join the bytes, and hand the result to ONE audio
 * element as ONE source. There are no boundaries left to cross, so there is
 * nothing for iOS to refuse. It is, as far as the operating system is
 * concerned, a podcast episode.
 *
 * While a document is still being fetched we play what we have and rebuild the
 * file as more arrives — but only while the screen is on, because a swap is
 * exactly the operation a locked phone forbids. Until the whole document has
 * been fetched the status line says so, in those words.
 *
 * WHAT STILL NEEDS THE SCREEN:
 * Recording. A lock screen button cannot ask for the microphone, so the record
 * button lives in the app. That was agreed rather than discovered.
 * =============================================================================
 */

const Drive = (function () {

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  // Speeds the slower/faster buttons step through. Safari clamps somewhere
  // above 2x on some devices, which is why the top of the range is sparse —
  // there is no point offering steps the hardware will quietly ignore.
  const RATES = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3];

  // How far the skip buttons jump. Fifteen seconds is what every podcast app
  // uses and what iOS itself offers on the lock screen, so it is what a thumb
  // already expects.
  const SKIP_SECONDS = 15;

  // Rebuild the joined file when this little playable audio is left. Each
  // rebuild costs a small audible gap, so we do it as rarely as we can get
  // away with — but far enough ahead that we never actually run dry.
  const RESTITCH_WHEN_REMAINING_UNDER = 45;

  // Don't start playing until there is at least this much to play, so the
  // first rebuild is not three seconds after you press play.
  const MIN_SECONDS_BEFORE_PLAY = 100;

  // Where the last position is remembered, so a stop for petrol doesn't lose
  // your place.
  const POS_KEY = "folio_drive_position";

  // ==========================================================================
  // STATE
  // ==========================================================================

  let docId = null;
  let docTitle = "";
  let plan = null;            // from Chunker: docText, blocks, sentences, chunks
  let nodes = [];             // the article's text nodes, for anchoring notes

  let audio = null;           // THE audio element. There is only ever one.
  let objectUrl = null;       // the blob URL it is currently holding

  let parts = [];             // parts[i] = Blob of chunk i's MP3, or undefined
  let durations = [];         // durations[i] = chunk i's length in seconds
  let ready = 0;              // how many chunks, from the start, we have in hand
  let stitched = 0;           // how many of those are in the file now playing
  let fetching = false;
  let fetchFailed = null;     // the message, if preparation gave up

  let rateIdx = RATES.indexOf(1);
  let wakeLock = null;

  // Recording
  let micState = "idle";      // 'idle' | 'recording' | 'working'
  let micHandle = null;
  let micAnchor = null;
  let micResume = false;
  let micStartedAt = 0;
  let micTimer = null;

  let outboxCount = 0;
  let ticker = null;

  // ==========================================================================
  // DOM
  // ==========================================================================

  const el = {};
  function grab() {
    [
      "drive-picker", "drive-player", "drive-doc-list", "drive-title",
      "drive-status", "drive-elapsed", "drive-remaining", "drive-progress-fill",
      "drive-play", "drive-back", "drive-fwd", "drive-rate", "drive-slower",
      "drive-faster", "drive-record", "drive-record-label", "drive-note",
      "drive-outbox", "drive-exit", "drive-article", "drive-wake", "drive-import",
    ].forEach((id) => { el[id.replace(/^drive-/, "").replace(/-(\w)/g, (m, c) => c.toUpperCase())] = document.getElementById(id); });
  }

  // ==========================================================================
  // SMALL HELPERS
  // ==========================================================================

  function mmss(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    if (m < 60) return m + ":" + String(r).padStart(2, "0");
    return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }

  /*
   * Say something on the one status line.
   *
   * Everything this app has to tell you has to fit here, be legible at a
   * glance, and never need a reply — because the alternative is a driver
   * reading a dialog.
   */
  function say(msg) {
    if (el.status) el.status.textContent = msg;
  }

  /*
   * A message that shows itself and then goes away: "+15s", "Note saved".
   *
   * Called flash() rather than note() because in this file a "note" is the
   * thing you dictate, and one word meaning two things is how the wrong one
   * gets called.
   */
  function flash(msg, ms) {
    if (!el.note) return;
    el.note.textContent = msg || "";
    el.note.classList.toggle("visible", !!msg);
    clearTimeout(flash._t);
    if (msg && ms) flash._t = setTimeout(() => flash(""), ms);
  }

  // ==========================================================================
  // THE PICKER
  // ==========================================================================

  /*
   * Every document, one per row, each row big enough to hit without aiming.
   * Sorted so the thing you were last reading is at the top, because that is
   * overwhelmingly what you want to carry on with.
   */
  function renderPicker() {
    const docs = FolioStore.listDocuments().slice();
    const last = lastPosition();

    docs.sort((a, b) => {
      if (last && a.id === last.docId) return -1;
      if (last && b.id === last.docId) return 1;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });

    if (!docs.length) {
      el.docList.innerHTML =
        '<p class="drive-empty">Nothing here yet.<br><br>' +
        'Folio keeps your pages in this browser, and this browser has never seen them. ' +
        'On the computer open Folio, go to Settings and export a backup, get the file onto ' +
        'this phone, then use <b>Import a backup</b> below. It carries your pages, your ' +
        'notes and your voice keys.</p>';
      return;
    }

    el.docList.innerHTML = docs.map((d) => {
      const blocks = blocksOf(d.id);
      const words = blocks ? FolioStore.countWordsInBlocks(blocks) : 0;
      // 155 words a minute is an unhurried narration speed; at 1.4x, which is
      // where most people settle, the real figure is lower. Deliberately the
      // pessimistic number, so a trip is never shorter than the estimate.
      const mins = Math.max(1, Math.round(words / 155));
      const resume = last && last.docId === d.id && last.time > 30
        ? ' · resumes at ' + mmss(last.time) : "";
      return (
        '<button class="drive-doc" data-id="' + d.id + '">' +
          '<span class="drive-doc-title">' + escapeHtml(d.icon ? d.icon + " " : "") + escapeHtml(d.title || "Untitled") + '</span>' +
          '<span class="drive-doc-meta">' + words.toLocaleString() + ' words · about ' + mins + ' min' + resume + '</span>' +
        '</button>'
      );
    }).join("");

    el.docList.querySelectorAll(".drive-doc").forEach((b) => {
      b.addEventListener("click", () => open(b.dataset.id));
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /*
   * A document's title, from the index rather than from getDocument().
   *
   * getDocument() hands back { meta, content } — reading `.title` off it gives
   * undefined, which is how every page came to be called "Untitled". It also
   * decompresses the entire page to do it, which is a lot of work to find a
   * name.
   */
  function titleOf(id) {
    const d = FolioStore.listDocuments().find((x) => x.id === id);
    return (d && d.title) || "Untitled";
  }

  function blocksOf(id) {
    const raw = FolioStore.readPage(id);
    if (!raw) return null;
    // Editor.js has been saved both as a bare array and as {blocks:[...]}
    // over the life of this app, so accept either.
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.blocks)) return raw.blocks;
    return null;
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Takes a backup file exported from Folio on another device and loads it in.
   *
   * WHY IT IS ON THIS SCREEN AT ALL:
   * Folio has no server. Everything lives in the browser's own storage, which
   * belongs to one browser on one device — so a phone opening Folio for the
   * first time has no pages, and more surprisingly no Speechify or Groq key
   * either, however complete the laptop is. Without this button the drive
   * screen on a new phone is an empty list with no way forward.
   *
   * Merge, not replace: importing must never be the thing that destroys notes
   * made on this phone earlier.
   */
  async function importBackup(file) {
    if (!file) return;
    flash("Reading the backup…", 4000);
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      flash("That file is not a Folio backup.", 5000);
      return;
    }
    if (!data || typeof data !== "object" || !data.folio_documents) {
      flash("That backup has no pages in it.", 5000);
      return;
    }
    try {
      const res = FolioStore.importAll(data, "merge");
      const gained = adoptCredentials(data);
      renderPicker();
      flash("Imported " + res.added + " page" + (res.added === 1 ? "" : "s") +
            (gained.length ? " and your " + gained.join(" and ") + " key" +
                             (gained.length === 1 ? "" : "s") : "") + ".", 4500);
    } catch (err) {
      /*
       * Safari gives an origin about five megabytes, and a long reading
       * history can exceed that. Saying which failure this is matters: "out of
       * room" is fixed by importing less, and nothing else is.
       */
      if (FolioStore.isQuotaError && FolioStore.isQuotaError(err)) {
        flash("This phone's browser ran out of room. Export a backup with fewer pages " +
              "and try again.", 9000);
      } else {
        flash("Import failed: " + (err && err.message ? err.message : "unknown"), 7000);
      }
      renderPicker();
    }
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Takes the voice keys out of a backup, but only where this phone has none.
   *
   * WHY IT IS SEPARATE FROM THE IMPORT:
   * importAll in merge mode deliberately copies pages and nothing else — it
   * will not touch settings, so that importing cannot overwrite how the device
   * you are standing at is set up. That is right for settings and wrong for
   * credentials: a phone that has just imported a library and cannot say a
   * word of it, or save a note about it, has not really imported anything. The
   * drive screen is useless without both keys.
   *
   * Only ever FILLS A GAP. A key already saved here wins, because that one was
   * chosen on this device and the backup's may be older or revoked.
   *
   * Found by a test: the first version of this import brought 46 pages across
   * and left the phone mute.
   */
  function adoptCredentials(data) {
    const WANTED = [
      ["folio_speechify_key", "Speechify"],
      ["folio_groq_key", "Groq"],
      ["folio_speechify_voice", null],     // which voice, not a credential
    ];
    const gained = [];
    WANTED.forEach(function (pair) {
      const key = pair[0], label = pair[1];
      const incoming = data[key];
      if (typeof incoming !== "string" || !incoming) return;
      try {
        if (localStorage.getItem(key)) return;      // this device already chose
        localStorage.setItem(key, incoming);
        if (label) gained.push(label);
      } catch { /* out of room; the pages matter more */ }
    });
    return gained;
  }

  // ==========================================================================
  // OPENING A DOCUMENT
  // ==========================================================================

  /*
   * WHAT THIS FUNCTION DOES:
   * Loads a document, works out how it will be cut up, and starts fetching its
   * audio. It does NOT start playing — that needs a real tap, for reasons the
   * play button's own comment explains.
   */
  function open(id) {
    const blocks = blocksOf(id);
    if (!blocks || !blocks.length) {
      flash("That page has no content.", 3000);
      return;
    }

    docId = id;
    docTitle = titleOf(id);

    /*
     * Render the document off screen using the READER's own converter.
     *
     * This is not decoration. The chunk a voice is billed for is identified by
     * its exact text, and that text comes from walking this HTML. Produce even
     * slightly different markup here and every chunk becomes a cache miss —
     * the same words, bought a second time. Using Reader.blocksToHtml is what
     * guarantees a document you have already listened to in the reader costs
     * nothing to take on a drive.
     */
    el.article.innerHTML = Reader.blocksToHtml(blocks);
    plan = Chunker.plan(el.article);
    nodes = Chunker.textNodes(el.article);

    if (!plan.chunks.length) {
      flash("Nothing in that page could be read aloud.", 3000);
      return;
    }

    // Make sure there is a read to file notes against before any are made.
    try { FolioStore.ensureReads(docId); } catch { /* notes still save */ }

    parts = new Array(plan.chunks.length);
    durations = new Array(plan.chunks.length).fill(0);
    ready = 0; stitched = 0; fetchFailed = null;

    el.title.textContent = docTitle;
    el.picker.classList.remove("active");
    el.player.classList.add("active");
    updateMediaMetadata();

    const resume = lastPosition();
    pendingSeek = (resume && resume.docId === docId) ? resume.time : 0;

    /*
     * The hopeful message goes up FIRST, so that anything fetchAll has to say
     * replaces it rather than being replaced by it. The other order meant the
     * one message that matters — that there is no Speechify key, so nothing
     * will ever play — was written and then immediately overwritten with
     * "Getting the audio ready…", which was a lie that never resolved.
     */
    say("Getting the audio ready…");
    startTicker();
    fetchAll();
  }

  function leave() {
    pause();
    releaseWakeLock();
    stopTicker();
    el.player.classList.remove("active");
    el.picker.classList.add("active");
    renderPicker();
  }

  // ==========================================================================
  // FETCHING AND JOINING THE AUDIO
  // ==========================================================================

  let pendingSeek = 0;        // where to jump to once there is a file to jump in

  /*
   * WHAT THIS FUNCTION DOES:
   * Walks the chunks in order, asking Speechify for each one, and keeps the
   * player topped up as they arrive.
   *
   * WHY IN ORDER, ONE AT A TIME:
   * The plan allows one request in flight, and anything we fetch out of order
   * cannot be played yet anyway — the file is built from the start, so chunk 9
   * is useless until chunks 1 to 8 are in hand. Sequential is both the fastest
   * useful order and the cheapest to reason about.
   */
  async function fetchAll() {
    if (fetching) return;
    if (typeof SpeechifyProvider === "undefined" || !SpeechifyProvider.hasKey()) {
      fetchFailed = "Add your Speechify key in Settings on the desktop app. The system " +
                    "voice cannot play while the screen is locked, so Drive needs Speechify.";
      say(fetchFailed);
      return;
    }
    fetching = true;
    const voiceId = SpeechifyProvider.currentVoiceId ? SpeechifyProvider.currentVoiceId() : null;
    const myDoc = docId;

    for (let i = 0; i < plan.chunks.length; i++) {
      if (docId !== myDoc) break;          // a different document was opened
      if (parts[i]) continue;
      try {
        const got = await SpeechifyProvider.fetchChunk(plan.chunks[i].text, voiceId);
        if (docId !== myDoc) break;
        if (!got || !got.blob) throw new Error("no audio came back");
        parts[i] = got.blob;
        durations[i] = await durationOf(got.blob);
      } catch (err) {
        /*
         * One failure is not the end of a drive. Everything before this point
         * still plays, so we stop fetching, say what happened, and leave the
         * door open — tapping play again retries from here.
         */
        fetchFailed = (err && err.message) ? err.message : "Could not fetch audio";
        break;
      }
      // How many chunks we have CONTIGUOUSLY from the start, which is all the
      // file can contain.
      while (ready < parts.length && parts[ready]) ready++;
      onMoreAudio();
    }

    fetching = false;
    if (ready === plan.chunks.length) {
      /*
       * The last rebuild is the important one: from here the file is complete
       * and will not change again, which is what makes the lock screen safe.
       *
       * It must NOT start playing. Preparation finishing is not a request to
       * play, and treating it as one meant the first tap on the play button
       * arrived at an already-playing element and PAUSED it — the button
       * appeared to do the opposite of what it says.
       */
      restitch(false);
    }
    updateStatus();
  }

  /*
   * How long a chunk's audio lasts.
   *
   * Needed because knowing WHERE IN THE DOCUMENT a given second of audio falls
   * is what lets a dictated note land on the right paragraph. Measuring it is
   * better than estimating from the character count: the same number of
   * characters can differ by a second or more depending on the words.
   *
   * decodeAudioData detaches the buffer it is given, so it gets a copy — and
   * the decoded result is dropped immediately, because only the duration is
   * wanted and holding the samples for a whole document would be hundreds of
   * megabytes.
   */
  async function durationOf(blob) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return estimateDuration(blob);
      if (!durationOf._ctx) durationOf._ctx = new Ctx();
      const buf = await blob.arrayBuffer();
      const decoded = await durationOf._ctx.decodeAudioData(buf.slice(0));
      return decoded.duration;
    } catch {
      return estimateDuration(blob);
    }
  }

  /*
   * Fallback when the browser will not decode: MP3 at a constant bitrate is
   * bytes divided by bytes-per-second. Speechify returns 48 kbit/s mono, so
   * 6000 bytes to the second. Only ever used to keep note anchoring roughly
   * honest if decoding is unavailable; playback never depends on it.
   */
  function estimateDuration(blob) {
    return blob.size / 6000;
  }

  function stitchedSeconds() {
    let t = 0;
    for (let i = 0; i < stitched; i++) t += durations[i] || 0;
    return t;
  }

  function startOfChunk(i) {
    let t = 0;
    for (let k = 0; k < i; k++) t += durations[k] || 0;
    return t;
  }

  /*
   * New audio has arrived. Decide whether to act on it now.
   *
   * The first time there is enough to be worth playing we build the file so the
   * play button has something to play. After that we leave it alone until
   * playback is close to running out, because every rebuild costs a small
   * audible gap and a gap you did not need is just a glitch.
   */
  function onMoreAudio() {
    if (!stitched && stitchedCandidateSeconds() >= MIN_SECONDS_BEFORE_PLAY) restitch(false);
    else if (!stitched && ready === plan.chunks.length) restitch(false);
    else maybeRestitch();
    updateStatus();
  }

  function stitchedCandidateSeconds() {
    let t = 0;
    for (let i = 0; i < ready; i++) t += durations[i] || 0;
    return t;
  }

  function maybeRestitch() {
    if (ready <= stitched) return;
    if (!audio || !audio.src) { restitch(false); return; }
    /*
     * NEVER REBUILD WHILE THE SCREEN IS OFF.
     *
     * Replacing the source is starting a new media load, and that is precisely
     * the operation a backgrounded or locked iPhone refuses. Doing it anyway
     * would turn a working read into silence for the rest of the trip. So if
     * the screen is off we leave the file alone and let it play out what it
     * has; the moment the screen comes back we top it up.
     */
    if (document.visibilityState !== "visible") return;

    const left = stitchedSeconds() - audio.currentTime;
    if (left < RESTITCH_WHEN_REMAINING_UNDER) restitch(false);
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Joins every chunk we have into one MP3 and hands it to the audio element,
   * keeping the current position and whether it was playing.
   *
   * HOW IT WORKS:
   * 1. Join the blobs. The earlier bytes are unchanged, so a position measured
   *    in the old file is still correct in the new one — that is what makes a
   *    seamless swap possible at all.
   * 2. Remember the clock, swap the source, put the clock back once the new
   *    file has a duration (setting currentTime before then is ignored).
   * 3. Resume if it was playing.
   */
  function restitch(autoplay) {
    if (!ready) return;
    /*
     * `autoplay` is needed as well as "was it playing", because the one case
     * that MUST resume is the one where it is not playing: the file ran out at
     * the end of what had been fetched, `ended` fired, and more has arrived
     * since. Reading the element's state there would see a paused player and
     * leave the trip in silence with the rest of the document in hand.
     */
    const resume = !!autoplay || !!(audio && !audio.paused && !audio.ended);
    const at = audio && audio.src ? audio.currentTime : pendingSeek;

    const blob = new Blob(parts.slice(0, ready), { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const old = objectUrl;
    objectUrl = url;
    stitched = ready;

    ensureAudio();

    const restore = function () {
      audio.removeEventListener("loadedmetadata", restore);
      const target = Math.min(at, Math.max(0, (audio.duration || 0) - 0.25));
      /*
       * Put the clock back, then CHECK that it went back.
       *
       * Safari accepts a currentTime set in the same turn as loadedmetadata
       * and then quietly ignores it, which on a resumed document means
       * starting again from the beginning — the one failure a listener
       * notices immediately and cannot work around. So it is applied, and
       * applied once more a beat later if it did not take.
       */
      const seek = () => { try { audio.currentTime = target; } catch { /* ignore */ } };
      if (target > 0.25) {
        seek();
        setTimeout(() => { if (Math.abs(audio.currentTime - target) > 1.5) seek(); }, 250);
      }
      audio.playbackRate = RATES[rateIdx];
      if (resume) audio.play().catch(() => { /* a tap will fix it */ });
      publishPosition();
      updateTimes();
    };
    audio.addEventListener("loadedmetadata", restore);
    audio.src = url;
    audio.load();

    /*
     * The old URL is revoked on a delay, not immediately.
     *
     * Revoking it in the same turn as the swap has the element still tearing
     * down the previous source while its backing blob is pulled away, which on
     * Safari has shown up as a decode error instead of a clean switch. A few
     * seconds of a stale object URL costs nothing — the blob's bytes are
     * shared with the new one anyway.
     */
    if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
    updateStatus();
  }

  // ==========================================================================
  // THE PLAYER
  // ==========================================================================

  /*
   * One audio element for the life of the page.
   *
   * It matters that this is never replaced. Permission to play audio without a
   * tap is granted to an ELEMENT, once the user has played that element
   * deliberately. Build a fresh element later and the permission does not come
   * with it — which would mean no resuming after a voice note, and no lock
   * screen.
   */
  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement("audio");
    audio.id = "drive-audio";
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    try { audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; } catch { /* ignore */ }
    document.body.appendChild(audio);

    audio.addEventListener("playing", function () {
      // Handlers registered before the element became the Now Playing item are
      // dropped by WebKit, so they are attached here — after playback has
      // actually begun — and re-attached whenever the screen comes back.
      wireMediaSession();
      updateMediaState();
      requestWakeLock();
      updatePlayButton();
    });
    audio.addEventListener("pause", function () {
      updateMediaState(); updatePlayButton(); releaseWakeLock();
    });
    audio.addEventListener("timeupdate", function () {
      updateTimes();
      rememberPosition();
    });
    audio.addEventListener("ended", function () {
      /*
       * The end of the FILE is not necessarily the end of the document — it
       * may just be as far as we have fetched. If there is more, build the
       * bigger file and carry on; if there genuinely is no more, say so.
       */
      if (ready > stitched) { restitch(true); return; }
      if (plan && ready < plan.chunks.length) {
        say(fetchFailed ? fetchFailed : "Waiting for the rest of the audio…");
        if (!fetching) fetchAll();
        return;
      }
      say("Finished. " + docTitle);
      updatePlayButton();
      releaseWakeLock();
    });
    return audio;
  }

  function play() {
    if (!stitched) {
      // Nothing to play yet. Say what is happening rather than doing nothing,
      // which is indistinguishable from a broken button.
      /*
       * A tap is also how you retry. Preparation gives up on the first error
       * rather than hammering a dead connection, so the button that looks like
       * "play" is deliberately the same button that means "try again".
       */
      say(fetchFailed || "Still fetching the first few minutes…");
      fetchFailed = null;
      if (!fetching) fetchAll();
      return;
    }
    ensureAudio();
    audio.playbackRate = RATES[rateIdx];
    audio.play().then(() => {
      updatePlayButton();
    }).catch((err) => {
      say("The phone would not start audio: " + (err && err.message ? err.message : "unknown"));
    });
  }

  function pause() {
    if (audio && !audio.paused) audio.pause();
    updatePlayButton();
  }

  function toggle() {
    if (!audio || audio.paused) play(); else pause();
  }

  function skip(seconds) {
    if (!audio || !audio.src) return;
    const max = Math.max(0, (audio.duration || 0) - 0.25);
    audio.currentTime = Math.min(max, Math.max(0, audio.currentTime + seconds));
    updateTimes();
    publishPosition();
    flash((seconds > 0 ? "+" : "−") + Math.abs(seconds) + "s", 900);
  }

  function setRate(idx) {
    rateIdx = Math.min(RATES.length - 1, Math.max(0, idx));
    if (audio) audio.playbackRate = RATES[rateIdx];
    el.rate.textContent = RATES[rateIdx] + "×";
    publishPosition();
    updateTimes();
  }

  // ==========================================================================
  // WHAT THE SCREEN SHOWS
  // ==========================================================================

  function updatePlayButton() {
    const playing = audio && !audio.paused && !audio.ended;
    el.play.classList.toggle("playing", !!playing);
    el.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function updateTimes() {
    if (!audio || !audio.src) return;
    const t = audio.currentTime;
    const total = totalSeconds();
    el.elapsed.textContent = mmss(t);
    // Remaining is in REAL time, so it accounts for the speed you chose — the
    // number you actually want is "how much longer will this take", not "how
    // many seconds of tape are left".
    el.remaining.textContent = "−" + mmss(Math.max(0, (total - t) / RATES[rateIdx]));
    el.progressFill.style.width = total ? (100 * t / total).toFixed(2) + "%" : "0%";
  }

  /*
   * How long the whole document is. Once everything is fetched this is just
   * the file's duration; before that it is what we have plus an estimate of
   * what is still coming, so the progress bar does not lurch when the file
   * grows.
   */
  function totalSeconds() {
    if (!plan || !plan.chunks.length) return 0;
    let known = 0, knownChars = 0;
    for (let i = 0; i < plan.chunks.length; i++) {
      if (durations[i]) { known += durations[i]; knownChars += plan.chunks[i].text.length; }
    }
    if (knownChars === 0) return 0;
    const allChars = plan.chunks.reduce((n, c) => n + c.text.length, 0);
    return known * (allChars / knownChars);
  }

  function updateStatus() {
    if (!plan) return;
    if (fetchFailed && ready === 0) { say(fetchFailed); return; }
    if (ready === plan.chunks.length && stitched === ready) {
      say("Whole document ready — safe to lock the screen.");
      return;
    }
    if (fetchFailed) {
      say("Buffered to " + mmss(stitchedSeconds()) + ". " + fetchFailed);
      return;
    }
    const pct = Math.round(100 * ready / plan.chunks.length);
    say("Buffered to " + mmss(stitchedSeconds()) + " (" + pct + "%) — keep the screen on until this says ready.");
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      maybeRestitch();
      if (micState === "recording") updateMicLabel();
    }, 1000);
  }
  function stopTicker() { if (ticker) clearInterval(ticker); ticker = null; }

  // ==========================================================================
  // THE LOCK SCREEN
  // ==========================================================================

  /*
   * Put this read on the lock screen and Control Centre, and accept the
   * buttons it offers back.
   *
   * Two things here were learned the hard way and are easy to undo by
   * accident:
   *
   *  - Handlers are registered AFTER playback starts. WebKit discards ones set
   *    before the element became the Now Playing item.
   *  - previoustrack and nexttrack are deliberately NOT set. iOS shows either
   *    track buttons or the fifteen-second skip pair, never both, and track
   *    buttons would be the wrong gesture for a document — so leaving them
   *    unset is what makes the skip buttons appear.
   */
  function wireMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    updateMediaMetadata();
    const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch { /* unsupported */ } };
    set("play", () => play());
    set("pause", () => pause());
    set("stop", () => pause());
    set("seekbackward", (d) => skip(-((d && d.seekOffset) || SKIP_SECONDS)));
    set("seekforward", (d) => skip((d && d.seekOffset) || SKIP_SECONDS));
    set("seekto", (d) => {
      if (!audio || !d || typeof d.seekTime !== "number") return;
      audio.currentTime = d.seekTime;
      publishPosition();
    });
    publishPosition();
  }

  function updateMediaMetadata() {
    if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: docTitle || "Folio",
        artist: "Folio — Drive",
        album: micState === "recording" ? "Recording a note…" : "Reading aloud",
      });
    } catch { /* ignore */ }
  }

  function updateMediaState() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState =
        (audio && !audio.paused && !audio.ended) ? "playing" : "paused";
    } catch { /* ignore */ }
  }

  /*
   * Tell the lock screen where we are, so its scrubber is not a lie. Guarded
   * hard because an out-of-range value throws, and a throw here would take the
   * whole timeupdate handler down with it.
   */
  function publishPosition() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch { /* ignore */ }
  }

  // ==========================================================================
  // KEEPING THE SCREEN AWAKE
  // ==========================================================================

  /*
   * A phone in a cradle that dims after thirty seconds means reaching for it
   * and waking it before every note. Holding a wake lock while reading is also
   * the simplest possible defence against every background-audio problem this
   * file works around: a screen that never sleeps never backgrounds the page.
   *
   * It is a request, not a guarantee — Low Power Mode refuses it — so nothing
   * here depends on it being granted.
   */
  async function requestWakeLock() {
    if (!el.wake || !el.wake.checked) return;
    if (wakeLock || !("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }

  // ==========================================================================
  // REMEMBERING YOUR PLACE
  // ==========================================================================

  function rememberPosition() {
    if (!docId || !audio) return;
    // Once a second is plenty, and localStorage writes are synchronous.
    const now = Date.now();
    if (rememberPosition._at && now - rememberPosition._at < 2000) return;
    rememberPosition._at = now;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ docId: docId, time: audio.currentTime }));
    } catch { /* a full disk must not stop playback */ }
  }

  function lastPosition() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch { return null; }
  }

  // ==========================================================================
  // VOICE NOTES — the big button
  // ==========================================================================

  /*
   * One button, two presses, exactly as the desktop reader works.
   *
   * First press: stop talking, remember which paragraph was being read, start
   * recording. Second press: stop recording, HOLD THE AUDIO SOMEWHERE SAFE,
   * start reading again immediately, and transcribe in the background.
   *
   * The order matters. Reading resumes before the transcript arrives because a
   * driver should not be sitting in silence waiting for a network round trip,
   * and the audio is written to disk before anything is attempted with it
   * because the one unacceptable outcome is losing what you said.
   */
  async function toggleMic() {
    if (micState === "working") return;
    if (micState === "recording") return stopNote();
    return startNote();
  }

  async function startNote() {
    if (typeof Voice === "undefined" || !Voice.hasKey()) {
      flash("Add your Groq key in Settings on the desktop to dictate.", 4000);
      return;
    }
    micResume = !!(audio && !audio.paused && !audio.ended);
    if (micResume) audio.pause();
    micAnchor = anchorHere();

    try {
      micHandle = await Voice.startRecording();
    } catch (err) {
      micHandle = null;
      flash(err && err.message ? err.message : "Could not start recording", 4000);
      if (micResume && audio) audio.play().catch(() => {});
      return;
    }
    micState = "recording";
    micStartedAt = Date.now();
    el.record.classList.add("recording");
    updateMicLabel();
    updateMediaMetadata();
    if (micTimer) clearInterval(micTimer);
    micTimer = setInterval(updateMicLabel, 250);
  }

  async function stopNote() {
    micState = "working";
    el.record.classList.remove("recording");
    el.record.classList.add("working");
    if (micTimer) { clearInterval(micTimer); micTimer = null; }
    el.recordLabel.textContent = "Saving…";

    const h = micHandle;
    const anchor = micAnchor;
    micHandle = null; micAnchor = null;

    let blob = null;
    try {
      blob = await Voice.stopRecordingRaw(h);
    } catch (err) {
      micIdle();
      if (micResume && audio) audio.play().catch(() => {});
      flash(err && err.message ? err.message : "Recording failed", 4000);
      return;
    }

    /*
     * ON DISK BEFORE ANYTHING ELSE.
     *
     * Transcription needs the network, and a car is exactly where the network
     * is worst. If the upload fails, or the phone reloads the page, or the
     * browser throws the tab away to reclaim memory, the only thing that
     * saves the thought is that the audio is already in IndexedDB. The
     * desktop reader keeps held recordings in memory and admits that a reload
     * loses them; on a drive that is not good enough.
     */
    const outboxId = await outboxPut({ docId: docId, blob: blob, anchor: anchor });

    micIdle();
    if (micResume && audio) audio.play().catch(() => {});

    flash("Note saved. Transcribing…", 2500);
    flushOutbox();
    void outboxId;
  }

  function micIdle() {
    micState = "idle";
    el.record.classList.remove("recording", "working");
    el.recordLabel.textContent = "Hold a thought";
    updateMediaMetadata();
  }

  function updateMicLabel() {
    if (micState !== "recording") return;
    const s = Math.floor((Date.now() - micStartedAt) / 1000);
    el.recordLabel.textContent = "Recording  " + mmss(s) + "  ·  tap to save";
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Works out which paragraph is being read right now, and describes it in a
   * way a highlight can be rebuilt from later.
   *
   * HOW IT WORKS:
   * 1. The clock says how many seconds in we are. Walking the measured chunk
   *    durations turns that into "we are inside chunk 7".
   * 2. Chunk 7 covers a known range of characters, so interpolating across it
   *    gives a character position accurate to a sentence or so.
   * 3. That character position belongs to exactly one paragraph, and that
   *    paragraph's text nodes are what a highlight is stored against.
   *
   * The quoted text is stored as well as the node indices, and it is the more
   * durable of the two: js/highlights.js falls back to searching for the text
   * when the indices no longer resolve, which is what happens if the document
   * is edited between the drive and reading the notes.
   */
  function anchorHere() {
    const fallback = { docId: docId, text: "", startNodeIndex: 0, startOffset: 0,
                       endNodeIndex: 0, endOffset: 0, audioTime: 0 };
    if (!audio || !plan) return fallback;

    const t = audio.currentTime || 0;
    let i = 0, acc = 0;
    while (i < durations.length - 1 && acc + (durations[i] || 0) <= t) { acc += durations[i] || 0; i++; }

    const chunk = plan.chunks[i];
    if (!chunk) return fallback;
    const dur = durations[i] || 1;
    const frac = Math.min(1, Math.max(0, (t - acc) / dur));
    const pos = Math.round(chunk.ds + frac * (chunk.de - chunk.ds));

    const block = Chunker.blockAt(plan.blocks, pos);
    if (!block || !block.el) return fallback;

    // Which text nodes belong to this paragraph, in the numbering a highlight
    // is stored against.
    let first = -1, last = -1;
    for (let k = 0; k < nodes.length; k++) {
      if (block.el.contains(nodes[k])) { if (first === -1) first = k; last = k; }
    }
    if (first === -1) return fallback;

    return {
      docId: docId,
      text: block.el.textContent || "",
      startNodeIndex: first,
      startOffset: 0,
      endNodeIndex: last,
      endOffset: (nodes[last].nodeValue || "").length,
      audioTime: t,
    };
  }

  /*
   * Write a finished note into the document: a highlight over the paragraph,
   * and a comment attached to it.
   *
   * Written straight to the store rather than through js/comments.js, which
   * reaches for a panel and an input box that this page deliberately does not
   * have. The record shapes are the ones those modules read back, so a note
   * made on a drive is indistinguishable from one typed at a desk.
   */
  function saveNote(text, anchor) {
    const id = anchor && anchor.docId;
    if (!id || !text || !text.trim()) return false;

    const read = (function () {
      try { return FolioStore.getCurrentRead(id); } catch { return null; }
    })();

    let highlightId = null;
    if (anchor.text && anchor.text.trim()) {
      try {
        const highlights = FolioStore.getHighlights(id);
        highlightId = FolioStore.generateId("hl");
        highlights.push({
          id: highlightId,
          color: (read && read.color) || "yellow",
          readId: read ? read.id : null,
          startNodeIndex: anchor.startNodeIndex,
          startOffset: anchor.startOffset,
          endNodeIndex: anchor.endNodeIndex,
          endOffset: anchor.endOffset,
          text: anchor.text,
          createdAt: new Date().toISOString(),
        });
        FolioStore.saveHighlights(id, highlights);
      } catch {
        // A note with no paragraph attached is still a note worth keeping.
        highlightId = null;
      }
    }

    const comments = FolioStore.getComments(id);
    comments.push({
      id: FolioStore.generateId("cm"),
      highlightId: highlightId,
      isGeneral: !highlightId,
      readId: read ? read.id : null,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Where in the read it was spoken. Costs a number and settles for ever
      // the question of where you were when you said it.
      driveAudioTime: anchor.audioTime || 0,
    });
    FolioStore.saveComments(id, comments);
    return true;
  }

  // ==========================================================================
  // THE OUTBOX — notes whose audio has not been transcribed yet
  // ==========================================================================

  /*
   * A tiny IndexedDB store holding recordings that still need uploading.
   *
   * localStorage cannot hold a Blob, and this app already knows what a full
   * localStorage feels like. IndexedDB holds binary, has room, and survives a
   * reload — which is the entire requirement.
   */
  const DB_NAME = "folio-drive";
  const STORE = "outbox";

  function db() {
    if (db._p) return db._p;
    db._p = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return db._p;
  }

  async function outboxPut(rec) {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, "readwrite");
        const r = tx.objectStore(STORE).add({
          docId: rec.docId, blob: rec.blob, anchor: rec.anchor,
          createdAt: new Date().toISOString(), tries: 0,
        });
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } catch (err) {
      /*
       * If the audio cannot even be stored, say so loudly and immediately.
       * Silence here would mean a thought lost without anyone knowing.
       */
      flash("Could not save the recording to this phone: " +
           (err && err.message ? err.message : "unknown"), 8000);
      return null;
    }
  }

  async function outboxAll() {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, "readonly");
        const r = tx.objectStore(STORE).getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
    } catch { return []; }
  }

  async function outboxDelete(id) {
    try {
      const d = await db();
      await new Promise((resolve) => {
        const tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = resolve; tx.onerror = resolve;
      });
    } catch { /* it will be retried and fail to delete again; harmless */ }
  }

  async function outboxBump(rec) {
    try {
      const d = await db();
      await new Promise((resolve) => {
        const tx = d.transaction(STORE, "readwrite");
        rec.tries = (rec.tries || 0) + 1;
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = resolve; tx.onerror = resolve;
      });
    } catch { /* ignore */ }
  }

  /*
   * Try to turn every held recording into a note. Runs after each recording,
   * when the network comes back, on a slow timer while anything is waiting,
   * and once at startup — because the thing most likely to be holding notes is
   * the drive you just finished.
   */
  let flushing = false;
  async function flushOutbox() {
    if (flushing) return;
    flushing = true;
    try {
      const all = await outboxAll();
      outboxCount = all.length;
      updateOutbox();
      for (const rec of all) {
        if (!navigator.onLine) break;
        try {
          const text = await Voice.transcribe(rec.blob);
          if (text && text.trim()) {
            saveNote(text, rec.anchor || { docId: rec.docId });
            await outboxDelete(rec.id);
            outboxCount = Math.max(0, outboxCount - 1);
            updateOutbox();
            flash("Note saved to “" + shortTitle(rec.anchor) + "”", 2500);
          } else {
            // Nothing was said. Keeping it forever would be a permanent
            // nag about an empty recording.
            await outboxDelete(rec.id);
            outboxCount = Math.max(0, outboxCount - 1);
            updateOutbox();
          }
        } catch (err) {
          const retryable = typeof Voice.isRetryable === "function" ? Voice.isRetryable(err) : true;
          if (retryable) {
            await outboxBump(rec);
            break;                 // the network is the problem; stop trying
          }
          /*
           * A failure that will never succeed — a rejected key, an empty
           * recording. Keep the audio rather than deleting it, but stop
           * counting it as pending work, and say what is wrong.
           */
          await outboxBump(rec);
          flash(err && err.message ? err.message : "Transcription failed", 6000);
          break;
        }
      }
    } finally {
      flushing = false;
      const all = await outboxAll();
      outboxCount = all.length;
      updateOutbox();
    }
  }

  function shortTitle(anchor) {
    const id = anchor && anchor.docId;
    if (!id) return docTitle || "this page";
    return titleOf(id);
  }

  function updateOutbox() {
    if (!el.outbox) return;
    el.outbox.classList.toggle("visible", outboxCount > 0);
    el.outbox.textContent = outboxCount === 1
      ? "1 note waiting to send"
      : outboxCount + " notes waiting to send";
  }

  // ==========================================================================
  // STARTUP
  // ==========================================================================

  function init() {
    grab();

    if (typeof FolioStore === "undefined") {
      document.body.innerHTML = "<p style='padding:2rem;color:#fff'>Folio could not load.</p>";
      return;
    }

    // Compaction is what keeps the browser's storage under its limit; the
    // desktop app runs it on open and so does this, because a drive may well
    // be the first thing to open Folio in a week.
    try { FolioStore.compactStorage(); } catch { /* not fatal */ }

    setRate(rateIdx);
    renderPicker();

    el.play.addEventListener("click", toggle);
    el.back.addEventListener("click", () => skip(-SKIP_SECONDS));
    el.fwd.addEventListener("click", () => skip(SKIP_SECONDS));
    el.slower.addEventListener("click", () => setRate(rateIdx - 1));
    el.faster.addEventListener("click", () => setRate(rateIdx + 1));
    el.record.addEventListener("click", toggleMic);
    el.exit.addEventListener("click", leave);
    if (el.import) {
      el.import.addEventListener("change", function () {
        const f = el.import.files && el.import.files[0];
        // Clear it so picking the same file twice still fires a change event.
        importBackup(f).finally(() => { el.import.value = ""; });
      });
    }

    /*
     * The screen coming back is the moment to put right everything a locked
     * phone would not allow: re-register the lock screen handlers WebKit
     * dropped, and top up the audio file if more has arrived.
     */
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      if (audio && audio.src) { wireMediaSession(); updateMediaState(); }
      maybeRestitch();
      if (!fetching && ready < (plan ? plan.chunks.length : 0) && !fetchFailed) fetchAll();
      flushOutbox();
    });

    window.addEventListener("online", flushOutbox);

    // Anything held from a previous trip goes out as soon as there is signal.
    flushOutbox();
    setInterval(function () { if (outboxCount > 0) flushOutbox(); }, 30000);

    /*
     * A recording in progress must not be lost to a stray swipe or a tapped
     * link. Nothing else on this page is worth warning about.
     */
    window.addEventListener("beforeunload", function (e) {
      if (micState !== "recording") return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });
  }

  return {
    init,
    // Exposed for the test suite and for poking at a live drive from the
    // console, which is the only debugger a phone really offers.
    _state: () => ({
      docId, docTitle, chunks: plan ? plan.chunks.length : 0,
      hasPlan: !!plan,
      ready, stitched, outboxCount, micState,
      rate: RATES[rateIdx],
      stitchedSeconds: stitchedSeconds(),
      totalSeconds: totalSeconds(),
    }),
    _anchorHere: anchorHere,
    _saveNote: saveNote,
    _flushOutbox: flushOutbox,
  };
})();

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", Drive.init);
  } else {
    Drive.init();
  }
}

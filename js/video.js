/*
 * =============================================================================
 * VIDEO.JS — YouTube embed with a live-synced transcript
 * =============================================================================
 * FILE OVERVIEW:
 * When a document contains a video block, this mounts a real YouTube player
 * above the transcript and keeps the two in step: the line currently being
 * spoken is highlighted as the video plays, clicking any line jumps the video
 * there, and pressing the dictate key attaches your comment to the line that
 * was just spoken.
 *
 * THE COMPONENTS:
 * 1. loadIframeApi() - pulls in YouTube's player API once, on demand
 * 2. mount()         - replaces the placeholder with a real player
 * 3. the sync loop   - currentTime -> which transcript line is active
 * 4. the clock seam  - lets the dictation flow treat the video as its clock
 *
 * THE FLOW:
 * The reader renders a placeholder div for the video block and normal
 * paragraphs for the transcript, each carrying its start time in `data-t`.
 * We build a sorted index of those times once, then poll the player and binary
 * search it. Only the active paragraph gets a class, so highlighting costs one
 * class swap per line rather than any DOM rebuilding.
 *
 * WHY THE IFRAME API AND NOT A PLAIN <iframe>:
 * A bare embed gives no way to read the playhead. The IFrame Player API is the
 * only route to getCurrentTime(), pauseVideo() and playVideo(), all three of
 * which this feature depends on.
 *
 * HOW IT REUSES READ-ALOUD:
 * This is the same shape as the speech engine, with a different clock. Rather
 * than duplicating the dictation flow, it registers itself with TTS as an
 * external clock: TTS then asks the video which paragraph is current, and
 * pauses and resumes the video instead of the synthesiser. Highlighting,
 * transcription, comment storage and the offline retry queue are all shared.
 * =============================================================================
 */

const Video = (function () {

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  // How often to check the playhead. 4x/sec is well inside a spoken line and
  // far cheaper than a per-frame loop for something this coarse.
  const POLL_MS = 250;

  // YouTube player states we care about (YT.PlayerState).
  const PLAYING = 1;

  // ==========================================================================
  // MODULE STATE
  // ==========================================================================

  let player = null;          // the YT.Player instance
  let mounted = false;
  let pollTimer = null;

  let segEls = [];            // paragraph elements carrying a data-t
  let segTimes = [];          // their start times, ascending — parallel array
  let activeIdx = -1;

  let apiPromise = null;
  let transcriptEl = null;   // the independently scrolling transcript
  let barEl = null;          // our on-page control bar
  let seeking = false;       // true while the user is dragging the scrubber

  /*
   * The speed ladder. Fixed, and matching what the embedded player actually
   * accepts — see the note above stepSpeed for why it stops at 2x and why
   * nothing here tries to discover the list at runtime.
   */
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

  /*
   * How far into a line you must be before Back restarts it rather than
   * stepping to the previous one. About a second and a half — long enough that
   * a Back pressed just after a line begins still takes you back, short enough
   * that mid-line always means "say that again".
   */
  const RESTART_GRACE_SEC = 1.5;

  /*
   * How far past the last transcribed line counts as "outside the transcript".
   * Beyond this the arrows seek by time rather than snapping back to the last
   * line, and a comment anchors to its moment rather than to that line.
   * Comfortably longer than one segment so a normal gap doesn't trip it.
   */
  const OUTSIDE_GRACE_SEC = 30;

  // ==========================================================================
  // IFRAME API LOADING
  // ==========================================================================

  /*
   * YouTube's API signals readiness through a single global callback, so this
   * chains onto any existing one rather than overwriting it, and resolves
   * immediately if the API is already present from a previous document.
   */
  function loadIframeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;

    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === "function") { try { prev(); } catch { /* ignore */ } }
        resolve(window.YT);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onerror = () => reject(new Error("Could not load the YouTube player"));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error("YouTube player timed out")), 20000);
    }).catch((err) => { apiPromise = null; throw err; });

    return apiPromise;
  }

  // ==========================================================================
  // MOUNTING
  // ==========================================================================

  /*
   * Called by the reader after it renders a document. Finds the placeholder
   * the reader emitted for the video block and turns it into a live player.
   * Does nothing (cheaply) on documents with no video.
   */
  async function attach() {
    detach();

    const holder = document.querySelector("#article .folio-video[data-video-id]");
    if (!holder) return;

    restructure(holder);
    indexSegments();

    let YT;
    try {
      YT = await loadIframeApi();
    } catch (err) {
      holder.innerHTML = '<div class="folio-video-error">' +
        escapeHtml(err.message || "Could not load the player") + "</div>";
      return;
    }

    const target = document.createElement("div");
    holder.insertBefore(target, holder.firstChild);

    const startAt = parseInt(holder.dataset.start || "0", 10) || 0;

    player = new YT.Player(target, {
      videoId: holder.dataset.videoId,
      playerVars: {
        start: startAt,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        // Our own bar drives playback, so YouTube's chrome is redundant and its
        // controls are the thing that steals keyboard focus.
        controls: 0,
        disablekb: 1,
      },
      events: {
        onReady: () => {
          mounted = true;
          rememberDuration();
          syncBar();
          startPolling();
        },
        onStateChange: (e) => {
          syncBar();
          if (e.data === PLAYING) startPolling(); else stopPolling(true);
        },
      },
    });

    initTranscriptClicks();
    initShortcuts();
    registerClock();

    // Two player bars stacked on one screen is noise — the video owns playback
    // here, so hide the read-aloud one. Dictation still works; it's routed
    // through the clock seam, not through that bar.
    const ttsBar = document.getElementById("tts-bar");
    if (ttsBar) ttsBar.classList.add("hidden-by-video");
  }

  /*
   * Video shortcuts. Space and the dictate key are handled by TTS (which routes
   * them to us through the clock seam); these are the extras. All bare-key and
   * skipped while typing, and — critically — they work because YouTube's own
   * chrome is off, so focus never leaves the document.
   */
  /*
   * A dictation just ended, so any transcript update held back while it was
   * running can now be drawn.
   */
  document.addEventListener("folio:dictation-end", () => {
    // After the save has settled, so the comment is on the page it lands on.
    setTimeout(flushDeferredRender, 0);
  });

  function initShortcuts() {
    if (document.body.dataset.videoKeys) return;
    document.body.dataset.videoKeys = "1";

    document.addEventListener("keydown", function (e) {
      if (!mounted) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          e.shiftKey ? nudge(-10) : hopLine(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          e.shiftKey ? nudge(10) : hopLine(1);
          break;
        case "ArrowUp":   e.preventDefault(); stepSpeed(1); break;
        case "ArrowDown": e.preventDefault(); stepSpeed(-1); break;
      }
    });
  }

  /*
   * Jump by transcript LINE, not by an arbitrary number of seconds — the same
   * choice made for reading, and for the same reason: a line is a unit of
   * meaning, a ten-second hop lands wherever it lands.
   *
   * Back has the music-player behaviour too. Mid-line it restarts the line
   * you're on; press it again and you go to the previous one. "Already at the
   * start" is decided by position rather than by timing a double-tap, so the
   * first press lands you exactly on the line start and the second therefore
   * reads as "already there".
   */
  function hopLine(dir) {
    if (!player) return;
    let t;
    try { t = player.getCurrentTime(); } catch { return; }

    /*
     * No transcript yet — the video is watchable while Gemini works, so the
     * arrows and the bar buttons have to do SOMETHING rather than silently
     * nothing. Fall back to a plain time seek until the lines arrive.
     */
    if (!segTimes.length) { nudge(dir < 0 ? -10 : 10); return; }

    let i = segmentAt(t);

    /*
     * OUTSIDE the transcript, seek by time instead of by line.
     *
     * A transcript can end before the video does — it gets truncated at the
     * output-token cap on a long video, or it is still streaming. Clamping to
     * the last line in that situation means pressing FORWARD seeks you
     * BACKWARD to wherever the transcript stopped, which traps you there and
     * makes the rest of the video unreachable. Falling back to a plain ±10s
     * nudge keeps you moving.
     */
    const pastEnd = i >= segTimes.length - 1 &&
                    t > segTimes[segTimes.length - 1] + OUTSIDE_GRACE_SEC;
    if (pastEnd) { nudge(dir < 0 ? -10 : 10); return; }

    if (i < 0) {
      // Before the first line — forward joins the transcript, back nudges.
      if (dir < 0) { nudge(-10); return; }
      i = -1;
    }

    if (dir < 0) {
      // Far enough into the line to mean "restart it"; otherwise step back.
      i = (t - segTimes[i] > RESTART_GRACE_SEC) ? i : i - 1;
      if (i < 0) { nudge(-10); return; }
    } else {
      i = i + 1;
      if (i > segTimes.length - 1) { nudge(10); return; }
    }

    const dur = videoDuration();
    if (dur && segTimes[i] > dur) { nudge(dir < 0 ? -10 : 10); return; }
    try { player.seekTo(segTimes[i], true); } catch { /* ignore */ }
    setActive(i);
  }

  function stepSpeed(dir) {
    if (!player) return;
    try {
      let i = SPEEDS.indexOf(player.getPlaybackRate());
      if (i === -1) i = SPEEDS.indexOf(1);
      i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
      player.setPlaybackRate(SPEEDS[i]);
      syncBar();
      if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(SPEEDS[i] + "×", 900);
    } catch { /* ignore */ }
  }



  /*
   * Rearrange what the reader emitted into a fixed player above an
   * independently scrolling transcript.
   *
   * Two problems this solves. The page used to scroll as a whole, so the video
   * drifted off the top of the viewport and got clipped. And a 16:9 player at
   * full column width is tall enough to leave no room for the transcript at
   * all.
   *
   * Nodes are MOVED, not recreated, so every existing text-node reference stays
   * valid — which matters because saved highlights are keyed to text-node
   * order. Document order is preserved too, so a TreeWalker sees exactly the
   * same sequence as before.
   */
  function restructure(holder) {
    const article = document.getElementById("article");
    if (!article || article.dataset.videoLayout) return;

    const wrap = document.createElement("div");
    wrap.className = "folio-video-wrap";

    const scroller = document.createElement("div");
    scroller.className = "folio-transcript";

    // Everything after the video becomes the scrolling transcript.
    const after = [];
    let seen = false;
    Array.from(article.childNodes).forEach((n) => {
      if (n === holder) { seen = true; return; }
      if (seen) after.push(n);
    });

    article.insertBefore(wrap, holder);
    wrap.appendChild(holder);
    wrap.appendChild(buildBar());
    after.forEach((n) => scroller.appendChild(n));
    article.appendChild(scroller);

    // A shield over the player: clicks toggle playback through the API instead
    // of landing inside the cross-origin iframe, which would move keyboard
    // focus there and silently kill every shortcut — including the dictate key.
    const shield = document.createElement("div");
    shield.className = "folio-video-shield";
    shield.title = "Click to play/pause";
    shield.addEventListener("click", (e) => { e.preventDefault(); togglePlay(); });
    holder.appendChild(shield);

    article.dataset.videoLayout = "1";
    transcriptEl = scroller;
  }

  function detach() {
    stopPolling(false);
    if (player && typeof player.destroy === "function") {
      try { player.destroy(); } catch { /* already gone */ }
    }
    player = null;
    mounted = false;
    segEls = [];
    segTimes = [];
    activeIdx = -1;
    transcriptEl = null;
    barEl = null;
    const ttsBar = document.getElementById("tts-bar");
    if (ttsBar) ttsBar.classList.remove("hidden-by-video");
    const art = document.getElementById("article");
    if (art) delete art.dataset.videoLayout;
    if (typeof TTS !== "undefined" && TTS.setExternalClock) TTS.setExternalClock(null);
  }

  // ==========================================================================
  // OUR OWN CONTROL BAR
  // ==========================================================================

  /*
   * YouTube's native chrome is switched off (controls: 0) and replaced with
   * this. Two reasons, both load-bearing:
   *
   *  - Clicking into a cross-origin iframe moves keyboard focus there, and from
   *    that point every page shortcut silently stops working — which is exactly
   *    why pressing Option did nothing after starting the video. Owning the
   *    controls means you never have to click inside the player.
   *  - The speed setting lived in YouTube's gear menu, which was effectively
   *    unreachable in this layout. Here it's a visible chip.
   */
  function buildBar() {
    const bar = document.createElement("div");
    bar.className = "folio-video-bar";
    bar.innerHTML =
      '<button class="fv-btn" data-act="back" title="Previous line (←)">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>' +
      '</button>' +
      '<button class="fv-btn fv-play" data-act="play" title="Play/pause (Space)">' +
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
      '</button>' +
      '<button class="fv-btn" data-act="fwd" title="Next line (→)">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>' +
      '</button>' +
      '<span class="fv-time">0:00</span>' +
      '<input class="fv-seek" type="range" min="0" max="1000" value="0" step="1" ' +
             'title="Drag to scrub" aria-label="Seek" />' +
      '<span class="fv-dur">0:00</span>' +
      '<button class="fv-speed" data-act="speed" title="Playback speed">1×</button>' +
      '<span class="fv-busy" hidden><span class="fv-busy-dot"></span>' +
        '<span class="fv-busy-text">Transcribing…</span></span>' +
      '<button class="fv-btn fv-retry" data-act="retry" title="Transcript incomplete — click to redo it">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
      '</button>' +
      '<button class="fv-btn" data-act="yt" title="Open on YouTube">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
      '</button>';

    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      e.preventDefault();
      switch (b.dataset.act) {
        case "play":  togglePlay(); break;
        case "back":  hopLine(-1); break;
        case "fwd":   hopLine(1); break;
        case "speed": cycleSpeed(); break;
        case "retry": retryTranscription(); break;
        case "yt":    openOnYouTube(); break;
      }
    });

    /*
     * Our own scrubber, because disabling YouTube's chrome to stop it stealing
     * keyboard focus also took its seek bar away. Driven as a 0-1000 range so
     * it works before the duration is known.
     *
     * `seeking` suppresses the poll's writes while you drag — otherwise the
     * thumb fights your finger, snapping back to the playhead 4 times a second.
     */
    const seek = bar.querySelector(".fv-seek");
    if (seek) {
      const toTime = () => {
        let dur = 0;
        try { dur = player.getDuration() || 0; } catch { return null; }
        return dur ? (Number(seek.value) / 1000) * dur : null;
      };
      seek.addEventListener("input", () => {
        seeking = true;
        const t = toTime();
        if (t != null) {
          const tm = bar.querySelector(".fv-time");
          if (tm && typeof Gemini !== "undefined") tm.textContent = Gemini.formatTime(t);
        }
      });
      const commit = () => {
        const t = toTime();
        if (t != null) { try { player.seekTo(t, true); } catch { /* ignore */ } }
        // Let the player settle before the poll takes the thumb back.
        setTimeout(() => { seeking = false; }, 120);
      };
      seek.addEventListener("change", commit);
      seek.addEventListener("mouseup", commit);
    }

    barEl = bar;
    return bar;
  }

  /*
   * PLAYBACK RATE: set it and move on. No probing, no readback.
   *
   * I tried to unlock 3x by setting a rate optimistically and reading it back
   * to see whether it stuck. That was broken twice over.
   *
   * First, the ceiling is real. Driving a live embed of a real video, playing:
   *
   *   advertised = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
   *   setPlaybackRate(2)   -> 2     accepted
   *   setPlaybackRate(2.5) -> 2     ignored
   *   setPlaybackRate(3)   -> 2     ignored
   *
   * An unsupported rate is silently ignored per the IFrame API contract, 3x on
   * youtube.com is a first-party feature the embed does not expose, and the
   * <video> element that could be driven past it is cross-origin. 2x is it.
   *
   * Second — and this is what actually broke playback — setPlaybackRate is
   * ASYNCHRONOUS. It posts a message into the iframe. getPlaybackRate() called
   * on the next line still returns the OLD rate, so every rate looked refused,
   * every rate got blacklisted, and after a couple of presses the ladder was
   * empty and the speed keys did nothing at all. The probe only appeared to
   * work when I measured it with a 1.5s wait between set and read.
   *
   * So: a fixed ladder, set directly, trusting the player. If YouTube ever
   * exposes more, add the rungs here.
   */

  function togglePlay() {
    if (!player) return;
    try {
      player.getPlayerState() === PLAYING ? player.pauseVideo() : player.playVideo();
    } catch { /* not ready */ }
  }

  function nudge(sec) {
    if (!player) return;
    try { player.seekTo(clampToVideo(player.getCurrentTime() + sec), true); } catch { /* ignore */ }
  }

  /*
   * Write the video's length into its block, once, the first time the player
   * knows it.
   *
   * Chunked transcription needs the length to plan its windows. Reading it
   * from the document means a retry or a resume can start immediately instead
   * of waiting around for a player that may not even be on screen yet.
   */
  function rememberDuration() {
    const docId = typeof Reader !== "undefined" ? Reader.getCurrentDocId() : null;
    const dur = Math.round(videoDuration());
    if (!docId || !dur) return;
    try {
      const doc = FolioStore.getDocument(docId);
      const blocks = (doc && doc.content && doc.content.blocks) || [];
      const vb = blocks.find((b) => b.type === "video");
      if (!vb || vb.data.duration === dur) return;
      vb.data.duration = dur;
      FolioStore.saveDocument(docId, { time: Date.now(), blocks: blocks });
    } catch { /* not worth breaking playback over */ }
  }

  /*
   * The lines this document already has, as segments.
   *
   * A resume used to re-transcribe the whole video from the beginning, so
   * every reload threw away all the work done so far and started again — the
   * exact opposite of what resuming is for, and expensive at pro rates.
   */
  function existingSegments(docId) {
    try {
      const doc = FolioStore.getDocument(docId);
      const blocks = (doc && doc.content && doc.content.blocks) || [];
      const el = document.createElement("div");
      return blocks
        .filter((b) => b.type === "paragraph" && b.data && b.data.t != null)
        .map((b) => {
          el.innerHTML = String(b.data.text == null ? "" : b.data.text);
          return { start: Number(b.data.t), text: el.textContent || "" };
        })
        .filter((s) => isFinite(s.start) && s.text.trim());
    } catch { return []; }
  }

  /* The length recorded in the document, if we have ever seen it. */
  function storedDuration(docId) {
    try {
      const doc = FolioStore.getDocument(docId);
      const blocks = (doc && doc.content && doc.content.blocks) || [];
      const vb = blocks.find((b) => b.type === "video");
      const d = vb && vb.data && Number(vb.data.duration);
      return d > 0 ? d : 0;
    } catch { return 0; }
  }

  /*
   * Wait briefly for the player to know the video's length.
   *
   * On a fresh import the transcription starts as the player is still coming
   * up, so asking immediately usually returns 0. A short poll is enough, and
   * giving up quietly is fine — the transcriber copes with an unknown length.
   */
  async function awaitDuration(ms) {
    const until = Date.now() + (ms || 0);
    for (;;) {
      const d = videoDuration();
      if (d) return d;
      if (Date.now() >= until) return 0;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /* The player's duration, or 0 when it isn't ready to say. */
  function videoDuration() {
    try {
      const d = player && player.getDuration();
      return d && isFinite(d) && d > 0 ? d : 0;
    } catch { return 0; }
  }

  // Never seek outside the video. A hallucinated transcript can carry
  // timestamps well past the end, and seeking there strands the playhead.
  function clampToVideo(t) {
    const dur = videoDuration();
    if (!isFinite(t) || t < 0) t = 0;
    return dur ? Math.min(t, Math.max(0, dur - 1)) : t;
  }

  /*
   * Drop transcript segments that start after the video ends.
   *
   * A model that falls into a repetition loop keeps marching the timestamps
   * forward, so a 52-minute video came back with lines stamped up to 1:21:01.
   * Those lines are not merely mislabelled, they are invented — there is no
   * video there for them to describe. Cut at the first one; the timestamps are
   * ascending, so everything after it is invented too.
   */
  function trimToDuration(segments) {
    const dur = videoDuration();
    if (!dur || !segments.length) return segments;
    const limit = dur + 5;          // a little slack for rounding
    const i = segments.findIndex((s) => s.start > limit);
    if (i === -1) return segments;
    if (typeof Gemini !== "undefined" && Gemini.log) {
      Gemini.log("trimmed", {
        duration: Math.round(dur), dropped: segments.length - i,
        firstBadTime: Math.round(segments[i].start),
        lastBadTime: Math.round(segments[segments.length - 1].start),
      });
    }
    return segments.slice(0, i);
  }

  function cycleSpeed() {
    if (!player) return;
    try {
      let i = SPEEDS.indexOf(player.getPlaybackRate());
      if (i === -1) i = SPEEDS.indexOf(1);
      const next = SPEEDS[(i + 1) % SPEEDS.length];
      player.setPlaybackRate(next);
      syncBar();
      if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(next + "×", 900);
    } catch { /* ignore */ }
  }

  /*
   * Redo the transcription for the document on screen.
   *
   * A transcript can end early — truncated at the output cap on a long video,
   * or failed outright — and until now there was no way back from that except
   * deleting the document and starting over, which would take your comments
   * with it. This re-runs it in place. Existing comments survive, and
   * timestamp-anchored ones get linked to lines when the new transcript lands.
   */
  function retryTranscription() {
    const docId = typeof Reader !== "undefined" ? Reader.getCurrentDocId() : null;
    const holder = document.querySelector("#article .folio-video[data-video-id]");
    if (!docId || !holder || typeof Gemini === "undefined") return;
    if (!Gemini.hasKey()) {
      notify("Add your Gemini API key in Settings → Video first.");
      return;
    }
    const parsed = Gemini.parseYouTube(
      "https://www.youtube.com/watch?v=" + holder.dataset.videoId);
    if (!parsed) return;
    notify("Redoing the transcript…");
    runTranscription(docId, parsed, "retry").catch((err) => {
      notify(err && err.message ? err.message : "Transcription failed");
    });
  }

  /*
   * Is the transcript plausibly finished? Used to decide whether to offer the
   * retry button. "Plausibly" because we can only compare the last line
   * against the video's duration — if the transcript stops more than a couple
   * of minutes short, it was cut off.
   */
  function transcriptLooksComplete() {
    if (!segTimes.length) return false;
    let dur = 0;
    try { dur = player && player.getDuration ? player.getDuration() : 0; } catch { /* ignore */ }
    if (!dur) return true;                       // can't tell — don't nag
    return segTimes[segTimes.length - 1] >= dur - 120;
  }

  /*
   * Show that a transcription is actually running.
   *
   * On a first import the "Transcribing…" placeholder block is the sign. On a
   * RETRY there is no placeholder — the old lines are still on screen — so
   * pressing retry looked like it did nothing at all for minutes. This is a
   * persistent indicator rather than a toast, because the run takes long
   * enough that any toast is long gone while you sit there wondering.
   */
  let busy = false;

  function setBusy(on, lines, upto) {
    busy = !!on;
    if (!barEl) return;
    const el = barEl.querySelector(".fv-busy");
    if (!el) return;
    el.hidden = !busy;
    if (busy) {
      const txt = el.querySelector(".fv-busy-text");
      if (txt) {
        txt.textContent = lines
          ? `Transcribing… ${lines} lines` +
            (upto != null && typeof Gemini !== "undefined"
              ? ` (${Gemini.formatTime(upto)})` : "")
          : "Transcribing…";
      }
    }
    updateRetryVisibility();
  }

  function updateRetryVisibility() {
    if (!barEl) return;
    const b = barEl.querySelector(".fv-retry");
    if (!b) return;
    // Same mechanism as the branch below — mixing `hidden` with `style.display`
    // leaves the button stuck once both have been touched.
    if (busy) { b.style.display = "none"; return; }
    const incomplete = !transcriptLooksComplete();
    b.style.display = incomplete ? "" : "none";
    b.title = segTimes.length
      ? "Transcript stops early — click to redo it"
      : "No transcript yet — click to generate it";
  }

  function openOnYouTube() {
    const holder = document.querySelector("#article .folio-video[data-video-id]");
    if (!holder) return;
    let t = 0;
    try { t = Math.floor(player.getCurrentTime()); } catch { /* ignore */ }
    window.open(`https://www.youtube.com/watch?v=${holder.dataset.videoId}&t=${t}`, "_blank", "noopener");
  }

  // Reflect real player state onto the bar rather than tracking it ourselves.
  function syncBar() {
    if (!barEl || !player) return;
    let state = -1, rate = 1, t = 0;
    try {
      state = player.getPlayerState();
      rate = player.getPlaybackRate();
      t = player.getCurrentTime();
    } catch { return; }

    const btn = barEl.querySelector(".fv-play");
    if (btn) {
      btn.innerHTML = state === PLAYING
        ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
        : '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
    const sp = barEl.querySelector(".fv-speed");
    if (sp) sp.textContent = (Math.round(rate * 100) / 100) + "×";
    const tm = barEl.querySelector(".fv-time");
    if (tm && typeof Gemini !== "undefined" && !seeking) tm.textContent = Gemini.formatTime(t);

    let dur = 0;
    try { dur = player.getDuration() || 0; } catch { /* ignore */ }
    const dl = barEl.querySelector(".fv-dur");
    if (dl && dur && typeof Gemini !== "undefined") dl.textContent = Gemini.formatTime(dur);
    const sk = barEl.querySelector(".fv-seek");
    if (sk && dur && !seeking) sk.value = String(Math.round((t / dur) * 1000));

    updateRetryVisibility();
  }

  // ==========================================================================
  // SEGMENT INDEX
  // ==========================================================================

  /*
   * Build parallel arrays of transcript paragraphs and their start times. Done
   * once per document so the sync loop is a binary search over numbers rather
   * than a DOM query every tick.
   */
  function indexSegments() {
    segEls = Array.from(document.querySelectorAll("#article [data-t]"));
    segTimes = segEls.map((el) => parseFloat(el.dataset.t) || 0);
    activeIdx = -1;
  }

  // Index of the last segment that has started by time t.
  function segmentAt(t) {
    if (!segTimes.length) return -1;
    let lo = 0, hi = segTimes.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segTimes[mid] <= t) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  // ==========================================================================
  // THE SYNC LOOP
  // ==========================================================================

  function startPolling() {
    stopPolling(false);
    pollTimer = setInterval(tick, POLL_MS);
    tick();
  }

  function stopPolling(keepHighlight) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!keepHighlight) clearActive();
  }

  function tick() {
    if (!player || typeof player.getCurrentTime !== "function") return;
    let t;
    try { t = player.getCurrentTime(); } catch { return; }
    syncBar();
    const i = segmentAt(t);
    if (i === activeIdx) return;
    setActive(i);
  }

  function setActive(i) {
    if (activeIdx >= 0 && segEls[activeIdx]) segEls[activeIdx].classList.remove("video-active-line");
    activeIdx = i;
    if (i < 0 || !segEls[i]) return;
    const el = segEls[i];
    el.classList.add("video-active-line");
    keepInView(el);
  }

  function clearActive() {
    if (activeIdx >= 0 && segEls[activeIdx]) segEls[activeIdx].classList.remove("video-active-line");
    activeIdx = -1;
  }

  /*
   * Scroll the TRANSCRIPT, never the window. Scrolling the page moved the
   * player out from under the viewport and clipped it; the transcript is its
   * own scroll container precisely so the video can stay put.
   */
  function keepInView(el) {
    const box = transcriptEl;
    if (!box) return;
    const br = box.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const top = er.top - br.top + box.scrollTop;
    const band = br.height;
    // Only move once the line has drifted out of the middle of the box.
    if (er.top < br.top + band * 0.2 || er.bottom > br.top + band * 0.8) {
      box.scrollTo({ top: Math.max(0, top - band * 0.35), behavior: "smooth" });
    }
  }

  // ==========================================================================
  // CLICK A LINE TO JUMP THERE
  // ==========================================================================

  function initTranscriptClicks() {
    const article = document.getElementById("article");
    if (!article || article.dataset.videoClicks) return;
    article.dataset.videoClicks = "1";

    article.addEventListener("click", function (e) {
      // Only the timestamp chip seeks — clicking the words themselves must stay
      // free for selecting text to comment on.
      const chip = e.target.closest(".video-ts");
      if (!chip) return;
      const el = chip.closest("[data-t]");
      if (!el || !player) return;
      e.preventDefault();
      const t = parseFloat(el.dataset.t) || 0;
      try { player.seekTo(t, true); player.playVideo(); } catch { /* not ready */ }
    });
  }

  // ==========================================================================
  // THE CLOCK SEAM — let the dictation flow treat the video as its clock
  // ==========================================================================

  /*
   * TTS already knows how to pause, highlight a block, record a comment and
   * resume. All it needs from us is: are you playing, which block is current,
   * and stop/start on request. Registering that interface means the whole
   * dictate-and-resume loop works over video with no duplicated logic.
   */
  function registerClock() {
    if (typeof TTS === "undefined" || !TTS.setExternalClock) return;
    TTS.setExternalClock({
      isActive: () => mounted,
      isPlaying: () => {
        if (!player || typeof player.getPlayerState !== "function") return false;
        try { return player.getPlayerState() === PLAYING; } catch { return false; }
      },
      pause: () => { try { player && player.pauseVideo(); } catch { /* ignore */ } },
      resume: () => { try { player && player.playVideo(); } catch { /* ignore */ } },
      currentBlockEl: () => {
        if (activeIdx < 0) return null;
        /*
         * Past the end of an incomplete transcript there is no correct line —
         * attaching to the last one would file the comment against text from
         * minutes earlier. Returning null makes it anchor to the timestamp
         * instead, so it can be linked properly once the transcript is
         * finished.
         */
        let t = null;
        try { t = player && player.getCurrentTime(); } catch { /* ignore */ }
        if (t != null && segTimes.length &&
            t > segTimes[segTimes.length - 1] + OUTSIDE_GRACE_SEC) {
          return null;
        }
        return segEls[activeIdx] || null;
      },
      // Where we are in the video, so a comment taken before the transcript
      // exists can still be anchored to a moment and matched up later.
      currentTime: () => {
        if (!player || typeof player.getCurrentTime !== "function") return null;
        try { return player.getCurrentTime(); } catch { return null; }
      },
    });
  }

  /*
   * Non-blocking notice. alert() halts the page and demands a click, which is
   * intolerable while you're watching something — it stops the video and
   * breaks your train of thought. Falls back to alert only if the toast
   * machinery isn't there at all.
   */
  function notify(msg) {
    const m = String(msg || "");
    if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(escapeHtml(m), 4000);
    else if (typeof console !== "undefined") console.warn("[folio]", m);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ==========================================================================
  // IMPORT — a URL becomes a document
  // ==========================================================================

  /*
   * Create a document from a YouTube link: the video block first, then the
   * transcript as ordinary paragraphs carrying their start times.
   *
   * The document is created and opened BEFORE transcription finishes, so the
   * video is watchable immediately while Gemini works — a long video takes
   * minutes, and staring at a spinner for that long is miserable. The
   * transcript is written in when it arrives.
   *
   * Transcript lines are plain paragraph blocks with an extra `t`. That means
   * highlights, comments, export, search and read-aloud all work on a
   * transcript with no special cases anywhere.
   */
  async function importUrl(rawUrl) {
    if (typeof Gemini === "undefined") throw new Error("Gemini module not loaded");

    const parsed = Gemini.parseYouTube(rawUrl);
    if (!parsed) throw new Error("That doesn't look like a YouTube link.");
    if (!Gemini.hasKey()) {
      throw new Error("Add your Gemini API key in Settings → Video first.");
    }

    const videoBlock = { type: "video", data: { provider: "youtube",
      videoId: parsed.videoId, url: parsed.url, start: parsed.start } };

    const meta = FolioStore.createDocument(
      "YouTube — " + parsed.videoId,
      { time: Date.now(), blocks: [videoBlock, waitingBlock()] },
      null
    );
    if (typeof SidebarUI !== "undefined") SidebarUI.renderPageTree();
    window.location.hash = `#/doc/${meta.id}`;

    return runTranscription(meta.id, parsed, "start");
  }

  function waitingBlock() {
    return { type: "paragraph", data: {
      text: "<i>Transcribing… lines will appear here as they arrive.</i>" } };
  }

  /*
   * Drive a transcription to completion, writing lines in as they stream.
   *
   * Marked as pending in settings for the whole run, so a reload can pick it up
   * again. Without that, refreshing mid-transcription left the document stuck
   * on "Transcribing…" forever — the fetch dies with the page and nothing
   * remembered that work was owed.
   */
  async function runTranscription(docId, parsed, reason) {
    reason = reason || "start";

    // Somebody else is already on it — another tab, or this page before a
    // reload that has not yet timed out.
    if (leaseHeld(docId)) {
      if (typeof Gemini !== "undefined" && Gemini.log) {
        Gemini.log("already-running", { doc: docId, why: reason });
      }
      notify("That transcript is already being generated.");
      return null;
    }

    markPending(docId, parsed.url, reason);
    const lease = setInterval(() => refreshLease(docId), LEASE_REFRESH_MS);
    setBusy(true);
    const knownDuration = storedDuration(docId) || await awaitDuration(8000);
    // Resuming or retrying keeps what is already there and fills the gaps.
    const already = reason === "start" ? [] : existingSegments(docId);
    const say = (m) => { if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(m, 2600); };

    let lastCount = 0;
    const write = (segments) => {
      segments = trimToDuration(segments);
      if (!segments.length) return;
      lastCount = segments.length;
      setBusy(true, segments.length, segments[segments.length - 1].start);
      notePendingProgress(docId, segments.length);
      writeBlocks(docId, buildBlocks(parsed, segments, true, knownDuration));
    };

    let segments;
    try {
      segments = await Gemini.transcribeYouTube(parsed.url, {
        onProgress: say,
        onSegments: write,
        docId: docId,
        reason: reason,
        // Chunking needs to know how long the video is. Without it the
        // transcriber walks forward blindly until two windows come back empty,
        // which works but wastes a request or two at the end.
        durationSec: knownDuration,
        existing: already,
      });
    } catch (err) {
      clearInterval(lease);
      clearPending(docId);
      setBusy(false);
      // Keep whatever streamed in rather than replacing it with an error.
      if (lastCount === 0) {
        writeBlocks(docId, [
          { type: "video", data: { provider: "youtube", videoId: parsed.videoId,
                                   url: parsed.url, start: parsed.start } },
          { type: "paragraph", data: { text: "<b>Transcription failed:</b> " +
              escapeHtml(err && err.message ? err.message : "unknown error") } },
        ]);
      }
      throw err;
    }

    clearInterval(lease);
    clearPending(docId);
    setBusy(false);
    segments = trimToDuration(segments);
    if (!segments.length) throw new Error("Transcript had no usable lines.");
    writeBlocks(docId, buildBlocks(parsed, segments, false, knownDuration));

    // Comments taken while the transcript was still generating were anchored
    // to a moment in the video rather than to a line, because no lines existed
    // yet. Now that they do, attach each one to the line that was on screen.
    reconcileTimedComments(docId, segments);

    // Now that we know what it's about, give it a real title.
    const first = segments.find((x) => !/^\[shows\]/.test(x.text)) || segments[0];
    const words = first.text.replace(/^\[shows\]\s*/, "").split(/\s+/).slice(0, 8).join(" ");
    if (words) FolioStore.updateDocument(docId, { title: words });
    if (typeof SidebarUI !== "undefined") SidebarUI.renderPageTree();

    say(`Transcript ready — ${segments.length} lines`);
    return docId;
  }

  function buildBlocks(parsed, segments, stillGoing, duration) {
    const vd = { provider: "youtube", videoId: parsed.videoId,
                 url: parsed.url, start: parsed.start };
    // Carried through deliberately: this block is rebuilt on every streaming
    // write, and without this the length recorded from the player was wiped
    // seconds after it was learned.
    if (duration > 0) vd.duration = Math.round(duration);
    const out = [{ type: "video", data: vd }];
    for (const s of segments) {
      out.push({ type: "paragraph", data: { text: escapeHtml(s.text), t: s.start } });
    }
    if (stillGoing) out.push(waitingBlock());
    return out;
  }

  /*
   * Attach any time-anchored comments to the transcript lines they belong to.
   *
   * While the transcript is generating you can still watch and talk, so those
   * comments are saved as page notes carrying the video position they were
   * spoken at. Once the lines arrive, each note's timestamp falls inside
   * exactly one line's window — so we highlight that line and re-point the
   * comment at it, and it becomes indistinguishable from one made afterwards.
   */
  function reconcileTimedComments(docId, segments) {
    if (typeof Comments === "undefined" || !Comments.listTimed) return;
    const timed = Comments.listTimed(docId);
    if (!timed.length || !segments.length) return;

    // Re-render first so the lines actually exist in the DOM to highlight.
    if (typeof Reader !== "undefined" && Reader.getCurrentDocId() === docId) {
      indexSegments();
    }

    let attached = 0;
    timed.forEach((c) => {
      const i = indexForTime(segments, c.videoTime);
      if (i < 0) return;
      const el = segEls[i];
      if (!el || typeof Highlights === "undefined" || !Highlights.createHighlightFromRange) return;

      const r = document.createRange();
      r.selectNodeContents(el);
      const hlId = Highlights.createHighlightFromRange(r, "yellow");
      if (!hlId) return;

      Comments.attachToHighlight(docId, c.id, hlId);
      attached++;
    });

    if (attached) {
      // Highlighting splits text nodes, so the offset index has to be rebuilt.
      indexSegments();
      if (typeof TTS !== "undefined" && TTS.toast) {
        TTS.toast(attached === 1
          ? "Linked 1 earlier note to its line"
          : `Linked ${attached} earlier notes to their lines`, 3000);
      }
    }
  }

  // Which segment's window contains this moment.
  function indexForTime(segments, t) {
    if (t == null) return -1;
    let best = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= t) best = i; else break;
    }
    return best;
  }

  // ── Pending registry, so a reload can resume ──────────────────────────────

  /*
   * ONE RUN PER DOCUMENT, ACROSS TABS AND RELOADS
   * =============================================
   * Nothing stopped a second transcription starting on a document that was
   * already being transcribed. A real log shows three runs on one document
   * overlapping for eleven minutes — each doing all nine windows — which put
   * six concurrent requests on a preview model, triggered rate limiting, and
   * meant four windows were abandoned after burning every retry. The work
   * could never converge because each new run competed with the last.
   *
   * The claim lives in the pending record so it is shared by every tab, and it
   * EXPIRES: a tab that is closed mid-run leaves a stale claim, and an
   * expiring lease is what lets the work be picked up again rather than
   * blocking the document forever. A live run refreshes it as it goes.
   */
  const LEASE_MS = 90000;
  const LEASE_REFRESH_MS = 30000;

  function leaseHeld(docId) {
    try {
      const st = FolioStore.getSettings();
      const rec = st.pendingTranscripts && st.pendingTranscripts[docId];
      return !!(rec && rec.leaseUntil && rec.leaseUntil > Date.now());
    } catch { return false; }
  }

  function refreshLease(docId) {
    try {
      const st = FolioStore.getSettings();
      const rec = st.pendingTranscripts && st.pendingTranscripts[docId];
      if (!rec) return;
      rec.leaseUntil = Date.now() + LEASE_MS;
      FolioStore.saveSettings(st);
    } catch { /* bookkeeping must never break a run */ }
  }

  function markPending(docId, url, reason) {
    const st = FolioStore.getSettings();
    st.pendingTranscripts = st.pendingTranscripts || {};
    const prev = st.pendingTranscripts[docId] || {};
    st.pendingTranscripts[docId] = {
      url: url,
      at: new Date().toISOString(),
      reason: reason || "start",
      // Counts only automatic resumes, so an interrupted run that can never
      // finish gives up instead of restarting on every single page load.
      resumes: reason === "resume" ? (prev.resumes || 0) + 1 : 0,
      lines: prev.lines || 0,
      leaseUntil: Date.now() + LEASE_MS,
    };
    FolioStore.saveSettings(st);
  }

  /*
   * Record how far a run got. Cheap enough at the flush rate the stream uses,
   * and it means a reload can say "resuming, you had 210 lines" instead of
   * silently starting over with no sign of what was lost.
   */
  function notePendingProgress(docId, lines) {
    try {
      const st = FolioStore.getSettings();
      const rec = st.pendingTranscripts && st.pendingTranscripts[docId];
      if (!rec) return;
      rec.lines = lines;
      rec.leaseUntil = Date.now() + LEASE_MS;   // still alive
      FolioStore.saveSettings(st);
    } catch { /* never let bookkeeping break the stream */ }
  }

  function clearPending(docId) {
    const st = FolioStore.getSettings();
    if (st.pendingTranscripts && st.pendingTranscripts[docId]) {
      delete st.pendingTranscripts[docId];
      FolioStore.saveSettings(st);
    }
  }

  /*
   * On load, restart anything that was interrupted.
   *
   * THE BUG THIS FIXES. The old test was "does the document have lines, and is
   * it still showing the Transcribing… placeholder?" — and if it had lines
   * without the placeholder, the pending record was thrown away. That is
   * exactly the state a RETRY is in: the previous, incomplete transcript is
   * still on screen, and no placeholder is ever inserted. So reloading during
   * a retry silently abandoned it, and the work was lost with no trace.
   *
   * A pending record now means one thing only: a run started and did not
   * finish. Every exit path from runTranscription clears it, success or
   * failure, so a surviving record is genuinely an interruption.
   *
   * WHAT A RELOAD ACTUALLY COSTS. Lines already streamed in are saved as they
   * arrive, so those survive. The HTTP request itself does not — it dies with
   * the page, and the tokens already spent on it are gone. Resuming starts a
   * fresh call. Gemini's clip offsets are too unreliable to restart from the
   * middle, so there is no way to pay only for the remainder.
   */
  const MAX_AUTO_RESUMES = 3;

  function resumePending() {
    if (typeof Gemini === "undefined" || !Gemini.hasKey()) return;
    const st = FolioStore.getSettings();
    const pend = st.pendingTranscripts || {};
    const ids = Object.keys(pend);
    if (!ids.length) return;

    ids.forEach((docId) => {
      const rec = pend[docId] || {};
      const doc = FolioStore.getDocument(docId);
      if (!doc) {
        Gemini.log("resume-skip", { doc: docId, why: "document is gone" });
        clearPending(docId);
        return;
      }

      /*
       * Give up rather than restarting forever. Something that has failed to
       * finish three times running will not finish on the fourth, and each
       * attempt costs real quota.
       */
      if ((rec.resumes || 0) >= MAX_AUTO_RESUMES) {
        Gemini.log("resume-gaveup", { doc: docId, resumes: rec.resumes,
                                      lines: rec.lines || 0 });
        clearPending(docId);
        notify("A transcript kept failing to finish — use ⟳ to try again.");
        return;
      }

      if (leaseHeld(docId)) {
        Gemini.log("resume-skip", { doc: docId, why: "another run holds it" });
        return;
      }

      const parsed = Gemini.parseYouTube(rec.url || "");
      if (!parsed) {
        Gemini.log("resume-skip", { doc: docId, why: "unreadable url" });
        clearPending(docId);
        return;
      }

      Gemini.log("resume", { doc: docId, video: parsed.videoId,
                             wasDoing: rec.reason || "start",
                             hadLines: rec.lines || 0,
                             attempt: (rec.resumes || 0) + 1 });

      const had = rec.lines ? ` — ${rec.lines} lines were saved` : "";
      if (typeof TTS !== "undefined" && TTS.toast) {
        TTS.toast("Resuming an interrupted transcription" + had + "…", 3600);
      }
      runTranscription(docId, parsed, "resume").catch((err) => {
        Gemini.log("resume-failed", { doc: docId,
                                      msg: (err && err.message) || "unknown" });
      });
    });
  }

  /*
   * Persist blocks and re-render if that document is the one on screen.
   *
   * THE RE-RENDER WAITS WHILE YOU ARE TALKING. A streaming transcript writes
   * every 1.5 seconds, every write re-rendered the document, and a re-render
   * tore down the dictation — so recording a voice note during a transcription
   * destroyed it within a second and a half. Storage is still updated on every
   * write, so nothing is lost if the page dies; only the DOM update is held
   * back, and it runs the moment the dictation finishes.
   */
  let deferredRenderDoc = null;

  function writeBlocks(docId, blocks) {
    FolioStore.updateDocument(docId, { content: { time: Date.now(), blocks: blocks } });
    if (typeof Reader === "undefined" || Reader.getCurrentDocId() !== docId) return;

    if (typeof TTS !== "undefined" && TTS.isDictating && TTS.isDictating()) {
      deferredRenderDoc = docId;
      return;
    }
    Reader.renderDocument(docId);
  }

  function flushDeferredRender() {
    const docId = deferredRenderDoc;
    deferredRenderDoc = null;
    if (!docId || typeof Reader === "undefined") return;
    if (Reader.getCurrentDocId() !== docId) return;
    Reader.renderDocument(docId);
  }

  /*
   * Ask for a URL and import it. Used by the sidebar button; kept here so the
   * whole YouTube path lives in one file.
   */
  async function promptImport(prefill) {
    const url = window.prompt("Paste a YouTube link:", prefill || "");
    if (!url) return;
    try {
      await importUrl(url);
    } catch (err) {
      notify(err && err.message ? err.message : "Could not import that video");
    }
  }

  return {
    notify,
    attach,
    detach,
    importUrl,
    resumePending,
    promptImport,
    hasVideo: () => mounted,
    // exported for tests
    _segmentAt: segmentAt,
    _indexSegments: indexSegments,
  };
})();

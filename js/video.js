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

  // Playback speeds our bar cycles through. YouTube supports these natively.
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

  /*
   * How far into a line you must be before Back restarts it rather than
   * stepping to the previous one. About a second and a half — long enough that
   * a Back pressed just after a line begins still takes you back, short enough
   * that mid-line always means "say that again".
   */
  const RESTART_GRACE_SEC = 1.5;

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
        onReady: () => { mounted = true; syncBar(); startPolling(); },
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
    if (i < 0) i = 0;

    if (dir < 0) {
      // Far enough into the line to mean "restart it"; otherwise step back.
      i = (t - segTimes[i] > RESTART_GRACE_SEC) ? i : i - 1;
    } else {
      i = i + 1;
    }
    i = Math.max(0, Math.min(segTimes.length - 1, i));

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
      '<button class="fv-speed" data-act="speed" title="Playback speed">1×</button>' +
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
        case "yt":    openOnYouTube(); break;
      }
    });

    barEl = bar;
    return bar;
  }

  function togglePlay() {
    if (!player) return;
    try {
      player.getPlayerState() === PLAYING ? player.pauseVideo() : player.playVideo();
    } catch { /* not ready */ }
  }

  function nudge(sec) {
    if (!player) return;
    try { player.seekTo(Math.max(0, player.getCurrentTime() + sec), true); } catch { /* ignore */ }
  }

  function cycleSpeed() {
    if (!player) return;
    try {
      const cur = player.getPlaybackRate();
      let i = SPEEDS.indexOf(cur);
      if (i === -1) i = SPEEDS.indexOf(1);
      const next = SPEEDS[(i + 1) % SPEEDS.length];
      player.setPlaybackRate(next);
      syncBar();
    } catch { /* ignore */ }
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
    if (tm && typeof Gemini !== "undefined") tm.textContent = Gemini.formatTime(t);
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
      currentBlockEl: () => (activeIdx >= 0 ? segEls[activeIdx] : null),
    });
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

    return runTranscription(meta.id, parsed);
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
  async function runTranscription(docId, parsed) {
    markPending(docId, parsed.url);
    const say = (m) => { if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(m, 2600); };

    let lastCount = 0;
    const write = (segments) => {
      if (!segments.length) return;
      lastCount = segments.length;
      writeBlocks(docId, buildBlocks(parsed, segments, true));
    };

    let segments;
    try {
      segments = await Gemini.transcribeYouTube(parsed.url, {
        onProgress: say,
        onSegments: write,
      });
    } catch (err) {
      clearPending(docId);
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

    clearPending(docId);
    writeBlocks(docId, buildBlocks(parsed, segments, false));

    // Now that we know what it's about, give it a real title.
    const first = segments.find((x) => !/^\[shows\]/.test(x.text)) || segments[0];
    const words = first.text.replace(/^\[shows\]\s*/, "").split(/\s+/).slice(0, 8).join(" ");
    if (words) FolioStore.updateDocument(docId, { title: words });
    if (typeof SidebarUI !== "undefined") SidebarUI.renderPageTree();

    say(`Transcript ready — ${segments.length} lines`);
    return docId;
  }

  function buildBlocks(parsed, segments, stillGoing) {
    const out = [{ type: "video", data: { provider: "youtube",
      videoId: parsed.videoId, url: parsed.url, start: parsed.start } }];
    for (const s of segments) {
      out.push({ type: "paragraph", data: { text: escapeHtml(s.text), t: s.start } });
    }
    if (stillGoing) out.push(waitingBlock());
    return out;
  }

  // ── Pending registry, so a reload can resume ──────────────────────────────

  function markPending(docId, url) {
    const st = FolioStore.getSettings();
    st.pendingTranscripts = st.pendingTranscripts || {};
    st.pendingTranscripts[docId] = { url: url, at: new Date().toISOString() };
    FolioStore.saveSettings(st);
  }

  function clearPending(docId) {
    const st = FolioStore.getSettings();
    if (st.pendingTranscripts && st.pendingTranscripts[docId]) {
      delete st.pendingTranscripts[docId];
      FolioStore.saveSettings(st);
    }
  }

  /*
   * On load, restart anything that was interrupted. Called once from init, and
   * only acts on documents that really are unfinished — a transcript that
   * completed just before the reload is left alone.
   */
  function resumePending() {
    if (typeof Gemini === "undefined" || !Gemini.hasKey()) return;
    const st = FolioStore.getSettings();
    const pend = st.pendingTranscripts || {};
    const ids = Object.keys(pend);
    if (!ids.length) return;

    ids.forEach((docId) => {
      const doc = FolioStore.getDocument(docId);
      if (!doc) { clearPending(docId); return; }

      const blocks = (doc.content && doc.content.blocks) || [];
      const hasLines = blocks.some((b) => b.data && b.data.t != null);
      const stillWaiting = blocks.some((b) => b.data && /Transcribing…/.test(b.data.text || ""));
      if (hasLines && !stillWaiting) { clearPending(docId); return; }

      const parsed = Gemini.parseYouTube(pend[docId].url);
      if (!parsed) { clearPending(docId); return; }

      if (typeof TTS !== "undefined" && TTS.toast) {
        TTS.toast("Resuming an interrupted transcription…", 3000);
      }
      runTranscription(docId, parsed).catch((err) => {
        console.error("[video] resume failed:", err);
      });
    });
  }

  // Persist blocks and re-render if that document is the one on screen.
  function writeBlocks(docId, blocks) {
    FolioStore.updateDocument(docId, { content: { time: Date.now(), blocks: blocks } });
    if (typeof Reader !== "undefined" && Reader.getCurrentDocId() === docId) {
      Reader.renderDocument(docId);
    }
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
      alert(err && err.message ? err.message : "Could not import that video");
    }
  }

  return {
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

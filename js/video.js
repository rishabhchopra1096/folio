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

    indexSegments();

    let YT;
    try {
      YT = await loadIframeApi();
    } catch (err) {
      holder.innerHTML = '<div class="folio-video-error">' +
        escapeHtml(err.message || "Could not load the player") + "</div>";
      return;
    }

    // The placeholder is replaced wholesale by the iframe, so give the API its
    // own child to take over and keep our wrapper intact for styling.
    const target = document.createElement("div");
    holder.innerHTML = "";
    holder.appendChild(target);

    const startAt = parseInt(holder.dataset.start || "0", 10) || 0;

    player = new YT.Player(target, {
      videoId: holder.dataset.videoId,
      playerVars: {
        start: startAt,
        rel: 0,             // don't suggest unrelated videos at the end
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: () => { mounted = true; startPolling(); },
        onStateChange: (e) => {
          // Poll only while playing; no need to burn timers on a paused video.
          if (e.data === PLAYING) startPolling(); else stopPolling(true);
        },
      },
    });

    initTranscriptClicks();
    registerClock();
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
    if (typeof TTS !== "undefined" && TTS.setExternalClock) TTS.setExternalClock(null);
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

  // Scroll only when the line has drifted out of a comfortable band, so the
  // page isn't yanked on every single line.
  function keepInView(el) {
    const r = el.getBoundingClientRect();
    const h = window.innerHeight;
    if (r.top < h * 0.25 || r.bottom > h * 0.85) {
      window.scrollBy({ top: r.top - h * 0.45, behavior: "smooth" });
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

    const title = "YouTube — " + parsed.videoId;
    const blocks = [
      { type: "video", data: { provider: "youtube", videoId: parsed.videoId,
                               url: parsed.url, start: parsed.start } },
      { type: "paragraph", data: { text: "<i>Transcribing… this can take a few minutes for a long video.</i>" } },
    ];

    const meta = FolioStore.createDocument(title, { time: Date.now(), blocks: blocks }, null);
    if (typeof SidebarUI !== "undefined") SidebarUI.renderPageTree();
    window.location.hash = `#/doc/${meta.id}`;

    const say = (m) => { if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(m, 3000); };

    let segments;
    try {
      segments = await Gemini.transcribeYouTube(parsed.url, { onProgress: say });
    } catch (err) {
      writeBlocks(meta.id, [
        blocks[0],
        { type: "paragraph", data: { text: "<b>Transcription failed:</b> " +
            escapeHtml(err && err.message ? err.message : "unknown error") } },
      ]);
      throw err;
    }

    if (!segments.length) {
      writeBlocks(meta.id, [blocks[0],
        { type: "paragraph", data: { text: "<i>No speech found in this video.</i>" } }]);
      say("No speech found");
      return meta.id;
    }

    const out = [blocks[0]];
    for (const s of segments) {
      out.push({ type: "paragraph", data: { text: escapeHtml(s.text), t: s.start } });
    }
    writeBlocks(meta.id, out);

    // Give it a better title now that we know what was said.
    const firstWords = segments[0].text.split(/\s+/).slice(0, 8).join(" ");
    FolioStore.updateDocument(meta.id, { title: firstWords || title });
    if (typeof SidebarUI !== "undefined") SidebarUI.renderPageTree();

    say(`Transcript ready — ${segments.length} segments`);
    return meta.id;
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
    promptImport,
    hasVideo: () => mounted,
    // exported for tests
    _segmentAt: segmentAt,
    _indexSegments: indexSegments,
  };
})();

/*
 * =============================================================================
 * TTS.JS — Read-Aloud with word-synced two-tier highlighting
 * =============================================================================
 * FILE OVERVIEW:
 * Reads the current document aloud and highlights along with it: the sentence
 * being read gets a soft tint, and the exact word being spoken gets a stronger
 * one. You can change speed on the fly, click any word to jump there, and when
 * you pause, the paragraph you stopped on is highlighted with the comment box
 * open — so you can dictate a reaction and keep going.
 *
 * THE COMPONENTS:
 * 1. buildIndex()      - walks the article DOM into a char-offset index
 * 2. makeChunks()      - groups sentences into speakable units
 * 3. Providers         - pluggable speech engines (WebSpeech now, cloud later)
 * 4. The player        - play/pause/seek/rate state machine
 * 5. paintHighlight()  - CSS Custom Highlight API painting
 *
 * THE FLOW:
 * On attach we walk #article once and build `docText` (the plain text of the
 * document) plus a `segments` table that maps any character offset in docText
 * back to a live DOM text node. Nothing in the DOM is modified. We then group
 * the text into chunks of a few sentences each. Playing means handing one
 * chunk's text to a provider; the provider calls us back with the character
 * offset of each word as it's spoken; we convert that offset into a DOM Range
 * and paint it.
 *
 * WHY IT'S BUILT THIS WAY (learned from a previous failed attempt):
 *
 *  - We NEVER wrap words in <span>. Folio stores highlights as indices into the
 *    flat list of text nodes under #article (see js/highlights.js). Wrapping
 *    each word would explode that list and silently reattach every saved
 *    highlight to the wrong text. The CSS Custom Highlight API paints ranges
 *    with zero DOM mutation, so saved highlights are untouched.
 *
 *  - We NEVER derive the playhead from a wall clock. The previous attempt did
 *    `pos + (Date.now() - t0)/1000 * rate`, which drifts the moment the rate
 *    changes. Here the engine tells us where it actually is.
 *
 *  - We address everything by CHARACTER OFFSET, never by word count. Speech
 *    engines normalize text ("$5" is spoken "five dollars"), so spoken-word
 *    indices diverge from document-word indices and the error compounds down
 *    the page. Character offsets always point at the original text.
 *
 *  - We only use LOCAL voices. A network voice was measured hanging for 14
 *    minutes and blocking the whole speechSynthesis queue, which is a single
 *    global FIFO. We also cancel() before every utterance for the same reason.
 * =============================================================================
 */

const TTS = (function () {

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  // Block tags we never read aloud. Reading code or image captions is noise.
  const SKIP_TAGS = new Set(["PRE", "FIGURE", "HR"]);

  // Target size of a synthesis chunk, in characters. Small enough that a
  // speed change (which restarts the current chunk) is barely noticeable.
  const CHUNK_CHARS = 400;

  // Speeds the rate chip cycles through.
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  // Keep the spoken word inside this vertical band of the viewport.
  const SCROLL_TOP_PAD = 0.25;
  const SCROLL_BOT_PAD = 0.75;

  /*
   * Speaking pace in words per minute at rate 1. Speech engines read at a
   * known, steady pace, and the rate multiplier scales it linearly — so the
   * time left is just (words remaining) / (WPM x rate). No measurement.
   *
   * An earlier version tried to measure the pace live and converge on it. That
   * was a mistake: each sample only covered a couple of seconds, so the
   * estimate chased noise and the displayed number bounced around by tens of
   * minutes. A constant is slightly less "accurate" in theory and dramatically
   * better in practice, because it only ever counts down.
   */
  const WPM_AT_1X = 175;

  // Shift+arrow seek distance, in seconds of listening at the current speed.
  const SEEK_SECONDS = 15;

  /*
   * How far into a sentence you must be before Back means "restart this
   * sentence" rather than "go to the previous one". A few characters is
   * enough: it only has to be larger than zero, since a Back press lands you
   * exactly on the sentence start and the next press should therefore step
   * back. Kept at a couple of words so a Back pressed a fraction too late —
   * just as a new sentence begins — still takes you to the previous one.
   */
  const RESTART_GRACE_CHARS = 12;

  // Hold Space longer than this and it starts dictation instead of being a
  // play/pause tap. Recording then LATCHES — you let go and keep talking, and
  // a later tap ends it. Long enough not to trigger on a normal tap, short
  // enough that the gesture feels immediate.
  const SPACE_HOLD_MS = 350;

  /*
   * Modern macOS voices worth defaulting to, best first. These are the
   * Premium/Enhanced downloads from System Settings → Accessibility → Spoken
   * Content → System voice (i) → Voice.
   *
   * Matched against the voice name with any "(Premium)"/"(English (UK))" style
   * suffix stripped, because Chrome's exposure of these names is inconsistent —
   * sometimes the tier is in the name, usually it isn't.
   */
  const PREFERRED_VOICES = [
    "Zoe", "Jamie", "Ava", "Evan", "Serena", "Allison",
    "Susan", "Tom", "Nathan", "Joelle", "Noelle", "Oliver", "Stephanie",
  ];

  // ==========================================================================
  // MODULE STATE
  // ==========================================================================

  let article = null;

  // The document index, rebuilt whenever a doc is rendered.
  let docText = "";
  let segments = [];    // [{ds, de, node, ns}]  char range -> DOM text node
  let blocks = [];      // [{ds, de, el}]        char range -> block element
  let sentences = [];   // [{ds, de}]            char ranges of sentences
  let chunks = [];      // [{ds, de, text}]      synthesis units

  // Playback state.
  let playing = false;
  let chunkIdx = 0;
  let spokenFrom = 0;      // doc offset where the current utterance began
  let curWord = null;      // {ds, de}
  let curSentence = null;  // {ds, de}
  let rate = 1;
  let handle = null;       // provider handle for the in-flight utterance
  let attachedDocId = null;

  // CSS Custom Highlight registries.
  let wordHL = null;
  let sentHL = null;
  let highlightsSupported = false;

  // Character offset of the start of each word, in document order. Lets us
  // answer "how many words are left from here" with a binary search, and
  // convert a seek-by-seconds into a seek-by-words.
  let wordStarts = [];
  let lastEtaPaint = 0;

  /*
   * An optional external clock — currently a YouTube player. When one is
   * registered and active, the dictate-and-resume loop drives IT instead of
   * the speech engine: pausing pauses the video, and the paragraph a comment
   * attaches to is the transcript line being spoken rather than the read-aloud
   * playhead. Everything downstream (highlighting, transcription, comment
   * storage, offline retry) is unchanged.
   */
  let externalClock = null;
  function setExternalClock(c) { externalClock = c; }
  function clockActive() { return !!(externalClock && externalClock.isActive()); }

  // ==========================================================================
  // DOCUMENT INDEX — walk the DOM once into a character-offset model
  // ==========================================================================

  /*
   * Produces three parallel views of the article:
   *   docText  - the plain text, which is what we hand to the speech engine
   *   segments - lets us turn any offset in docText back into a DOM position
   *   blocks   - lets us find the paragraph element containing an offset
   *
   * Blocks are separated in docText by a blank line so the engine pauses
   * between paragraphs. Those separator characters belong to no segment;
   * locate() clamps offsets that land in the gap.
   */
  function buildIndex(root) {
    docText = "";
    segments = [];
    blocks = [];

    for (const el of Array.from(root.children)) {
      if (SKIP_TAGS.has(el.tagName)) continue;

      const blockStart = docText.length;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.nodeValue;
        if (!t) continue;
        segments.push({ ds: docText.length, de: docText.length + t.length, node: node, ns: 0 });
        docText += t;
      }

      // Only record the block if it actually contributed text
      if (docText.length > blockStart) {
        blocks.push({ ds: blockStart, de: docText.length, el: el });
        docText += "\n\n";
      }
    }

    buildWordStarts();
  }

  /*
   * Turn a character offset in docText into {node, off} in the live DOM.
   *
   * `preferEnd` matters at segment boundaries. A segment's `de` is exclusive,
   * so an offset landing exactly on it can mean either "one past the last
   * character of this node" (correct for a range END) or "the first character
   * of the next node" (correct for a range START). Inline markup makes this
   * common: in "<b>entry point</b> for", the space starts exactly where the
   * bold node ends. Resolving a start that way points at nodeValue[length],
   * which is undefined.
   */
  function locate(pos, preferEnd) {
    if (!segments.length) return null;
    let lo = 0, hi = segments.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid];
      if (pos < s.ds) hi = mid - 1;
      else if (pos > s.de) lo = mid + 1;
      else { found = mid; break; }
    }

    if (found === null) {
      // Landed in a block separator — clamp to the nearest segment edge.
      const s = segments[Math.min(lo, segments.length - 1)];
      return { node: s.node, off: pos <= s.ds ? s.ns : s.ns + (s.de - s.ds) };
    }

    let s = segments[found];
    if (!preferEnd && pos === s.de &&
        found + 1 < segments.length && segments[found + 1].ds === pos) {
      s = segments[found + 1];
    }
    return { node: s.node, off: s.ns + (pos - s.ds) };
  }

  // Build a DOM Range spanning a character range of docText.
  function charToRange(ds, de) {
    const a = locate(ds, false);
    const b = locate(de, true);
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off);
      return r;
    } catch {
      return null;
    }
  }

  // Find the block element that contains a character offset.
  function blockAt(pos) {
    for (const b of blocks) {
      if (pos >= b.ds && pos <= b.de) return b;
    }
    return null;
  }

  // ==========================================================================
  // CHUNKING — group sentences into speakable units
  // ==========================================================================

  /*
   * Chunks never cross a block boundary, so a chunk seam always lands where a
   * pause belongs anyway. Within a block we accumulate whole sentences until
   * adding another would exceed CHUNK_CHARS.
   *
   * We record every sentence range separately too, because the sentence-level
   * highlight tier needs finer granularity than the chunk.
   */
  function makeChunks() {
    chunks = [];
    sentences = [];

    const canSegment = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
    const seg = canSegment ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;

    for (const b of blocks) {
      const text = docText.slice(b.ds, b.de);
      if (!text.trim()) continue;

      // Sentence ranges within this block, as absolute doc offsets.
      const sents = [];
      if (seg) {
        for (const s of seg.segment(text)) {
          if (!s.segment.trim()) continue;
          sents.push({ ds: b.ds + s.index, de: b.ds + s.index + s.segment.length });
        }
      } else {
        // Fallback for engines without Intl.Segmenter: split on . ! ?
        const re = /[^.!?]+[.!?]*\s*/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (!m[0].trim()) continue;
          sents.push({ ds: b.ds + m.index, de: b.ds + m.index + m[0].length });
        }
      }
      if (!sents.length) sents.push({ ds: b.ds, de: b.de });

      sentences.push.apply(sentences, sents);

      // Accumulate sentences into chunks
      let cs = null, ce = null;
      for (const s of sents) {
        if (cs === null) { cs = s.ds; ce = s.de; continue; }
        if (s.de - cs <= CHUNK_CHARS) { ce = s.de; }
        else { chunks.push({ ds: cs, de: ce }); cs = s.ds; ce = s.de; }
      }
      if (cs !== null) chunks.push({ ds: cs, de: ce });
    }

    chunks = chunks.map((c) => ({ ds: c.ds, de: c.de, text: docText.slice(c.ds, c.de) }));
  }

  // Binary-search the sentence containing a character offset.
  function sentenceAt(pos) {
    let lo = 0, hi = sentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sentences[mid];
      if (pos < s.ds) hi = mid - 1;
      else if (pos >= s.de) lo = mid + 1;
      else return s;
    }
    return null;
  }

  function chunkIndexAt(pos) {
    for (let i = 0; i < chunks.length; i++) {
      if (pos < chunks[i].de) return i;
    }
    return Math.max(0, chunks.length - 1);
  }

  // ==========================================================================
  // PROVIDERS — pluggable speech engines
  // ==========================================================================

  /*
   * A provider turns text into speech and reports, as it goes, the character
   * offset of the word currently being spoken — relative to the text it was
   * given. That single contract is what lets us swap engines later without
   * touching the player or the highlighting.
   *
   * speak(text, opts) returns a handle: { stop() }
   *   opts.rate    - playback multiplier
   *   opts.onWord  - (charIndex, charLength) as each word begins
   *   opts.onEnd   - the utterance finished naturally
   *   opts.onError - (message)
   */

  const WebSpeechProvider = {
    id: "webspeech",
    label: "System voice (free)",
    needsKey: false,

    available: function () {
      return typeof speechSynthesis !== "undefined";
    },

    /*
     * Only LOCAL voices are offered. A network voice ("Google US English") was
     * measured hanging indefinitely and blocking the global utterance queue,
     * which starves every subsequent utterance until something calls cancel().
     */
    /*
     * Rank voices best-first.
     *
     * The tier a macOS voice belongs to is NOT reliably in its name. Downloading
     * "Zoe (Premium)" in System Settings often shows up in Chrome as plain
     * "Zoe" — so matching on /premium/ alone silently leaves you on Samantha,
     * a 2009-era voice, even after downloading a good one. Hence an explicit
     * list of known-good modern voices, checked before any name heuristic.
     */
    voices: function () {
      if (!this.available()) return [];
      const rank = (v) => {
        const bare = v.name.replace(/\s*\(.*\)\s*$/, "").trim();
        const known = PREFERRED_VOICES.indexOf(bare);
        if (known !== -1) return known;                    // 0..n, best first
        if (/premium/i.test(v.name)) return 100;
        if (/enhanced/i.test(v.name)) return 200;
        if (bare === "Samantha") return 300;               // decent last resort
        return 400;
      };
      return speechSynthesis.getVoices()
        .filter((v) => v.localService && /^en/i.test(v.lang))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    },

    defaultVoice: function () {
      // voices() is already ranked best-first.
      return this.voices()[0] || null;
    },

    speak: function (text, opts) {
      // Always clear the queue first — a stuck utterance blocks everything
      // behind it, and this is the only reliable way to recover.
      speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.rate = Math.max(0.1, Math.min(10, opts.rate || 1));
      if (opts.voice) u.voice = opts.voice;

      let finished = false;

      u.onboundary = function (e) {
        // Chrome reports name 'word'; some engines omit it entirely.
        if (e.name && e.name !== "word") return;
        if (typeof e.charIndex !== "number") return;
        opts.onWord(e.charIndex, e.charLength || 0);
      };
      u.onend = function () {
        if (finished) return;
        finished = true;
        opts.onEnd();
      };
      u.onerror = function (e) {
        if (finished) return;
        finished = true;
        // 'interrupted'/'canceled' are what we get from our own cancel() calls.
        if (e.error === "interrupted" || e.error === "canceled") return;
        opts.onError(e.error || "speech error");
      };

      speechSynthesis.speak(u);

      return {
        stop: function () {
          finished = true;
          speechSynthesis.cancel();
        },
      };
    },
  };

  // Registry. Additional providers (hosted Kokoro, Speechify) slot in here and
  // only need to satisfy the speak() contract above.
  const providers = { webspeech: WebSpeechProvider };
  let providerId = "webspeech";
  function provider() { return providers[providerId] || WebSpeechProvider; }

  let selectedVoice = null;

  // ==========================================================================
  // HIGHLIGHT PAINTING — CSS Custom Highlight API, zero DOM mutation
  // ==========================================================================

  function initHighlights() {
    highlightsSupported = typeof CSS !== "undefined" && "highlights" in CSS
                          && typeof Highlight === "function";
    if (!highlightsSupported) return;
    wordHL = new Highlight();
    sentHL = new Highlight();
    CSS.highlights.set("tts-word", wordHL);
    CSS.highlights.set("tts-sentence", sentHL);
  }

  function paint() {
    if (!highlightsSupported) return;
    wordHL.clear();
    sentHL.clear();
    if (curSentence) {
      const r = charToRange(curSentence.ds, curSentence.de);
      if (r) sentHL.add(r);
    }
    if (curWord) {
      const r = charToRange(curWord.ds, curWord.de);
      if (r) wordHL.add(r);
    }
  }

  function clearPaint() {
    if (!highlightsSupported) return;
    wordHL.clear();
    sentHL.clear();
  }

  // Keep the spoken word in a comfortable band rather than yanking the page
  // on every single word.
  function maybeScroll() {
    if (!curWord) return;
    const r = charToRange(curWord.ds, curWord.de);
    if (!r) return;
    const rect = r.getBoundingClientRect();
    if (!rect || (!rect.top && !rect.height)) return;
    const h = window.innerHeight;
    if (rect.top < h * SCROLL_TOP_PAD || rect.bottom > h * SCROLL_BOT_PAD) {
      window.scrollBy({ top: rect.top - h * 0.4, behavior: "smooth" });
    }
  }

  // ==========================================================================
  // READING PACE & TIME REMAINING
  // ==========================================================================

  /*
   * Index the start offset of every word once, when the document is indexed.
   * "Words remaining" is then a binary search rather than a re-scan.
   */
  function buildWordStarts() {
    wordStarts = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(docText)) !== null) wordStarts.push(m.index);
  }

  // How many words sit at or after this character offset.
  function wordsRemainingFrom(pos) {
    if (!wordStarts.length) return 0;
    let lo = 0, hi = wordStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wordStarts[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return wordStarts.length - lo;
  }

  // Current position in the document, in characters.
  function currentOffset() {
    if (curWord) return curWord.ds;
    if (chunks[chunkIdx]) return chunks[chunkIdx].ds;
    return 0;
  }

  // Words remaining divided by the engine's words-per-minute at this rate.
  function remainingSeconds() {
    const words = wordsRemainingFrom(currentOffset());
    const wpm = WPM_AT_1X * (rate || 1);
    return wpm > 0 ? (words / wpm) * 60 : 0;
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 1) return "done";
    const totalMin = sec / 60;
    if (totalMin < 1) return "<1 min left";
    const m = Math.round(totalMin);
    if (m < 60) return m + " min left";
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m left` : `${h}h left`;
  }

  // Throttled during playback so it doesn't rewrite the DOM on every word.
  function updateEta(force) {
    if (!bar) return;
    const now = performance.now();
    if (!force && now - lastEtaPaint < 500) return;
    lastEtaPaint = now;
    const el = bar.querySelector("#tts-eta");
    if (!el) return;
    if (!chunks.length) { el.textContent = ""; return; }
    el.textContent = formatDuration(remainingSeconds());
  }

  // ==========================================================================
  // THE PLAYER
  // ==========================================================================

  /*
   * Speaks the chunk at `chunkIdx`, optionally starting partway in. The
   * `fromOffset` case is how a speed change resumes: because an utterance's
   * rate is fixed once it starts, changing speed means stopping and respeaking
   * the remainder of the current chunk at the new rate.
   */
  function speakChunk(fromOffset) {
    if (chunkIdx >= chunks.length) { stop(); return; }
    const c = chunks[chunkIdx];
    const start = typeof fromOffset === "number" ? Math.max(c.ds, fromOffset) : c.ds;
    const text = docText.slice(start, c.de);

    if (!text.trim()) { chunkIdx++; speakChunk(); return; }

    spokenFrom = start;

    handle = provider().speak(text, {
      rate: rate,
      voice: selectedVoice,
      onWord: function (charIndex, charLength) {
        const ds = spokenFrom + charIndex;
        // Some engines report charLength 0 — derive the end from the text.
        let de = charLength > 0 ? ds + charLength : wordEndFrom(ds);
        curWord = { ds: ds, de: de };
        curSentence = sentenceAt(ds) || curSentence;
        paint();
        maybeScroll();
        updateEta(false);
      },
      onEnd: function () {
        if (!playing) return;
        chunkIdx++;
        if (chunkIdx >= chunks.length) { stop(true); return; }
        speakChunk();
      },
      onError: function (msg) {
        playing = false;
        updateBar();
        console.error("[tts]", msg);
      },
    });
  }

  // Fallback when the engine doesn't give us a word length.
  function wordEndFrom(ds) {
    const m = /\S+/.exec(docText.slice(ds, ds + 60));
    return m ? ds + m.index + m[0].length : ds + 1;
  }

  function play() {
    if (!chunks.length) return;
    if (playing) return;
    playing = true;
    updateBar();
    updateEta(true);
    speakChunk(curWord ? curWord.ds : undefined);
  }

  function pause() {
    if (!playing) return;
    playing = false;
    if (handle) { handle.stop(); handle = null; }
    updateBar();
    updateEta(true);
    // Pausing is a signal that you have something to say about this passage.
    offerCommentOnPause();
  }

  function toggle() { playing ? pause() : play(); }

  function stop(reachedEnd) {
    playing = false;
    if (handle) { handle.stop(); handle = null; }
    if (reachedEnd) { chunkIdx = 0; curWord = null; curSentence = null; }
    clearPaint();
    updateBar();
    updateEta(true);
  }

  /*
   * Changing rate mid-flight: an utterance's rate is fixed once speaking
   * starts, so we stop and respeak the remainder of the current chunk from the
   * current word. Chunks are small, so the restart is barely perceptible.
   */
  function setRate(r) {
    rate = r;
    saveSettings();
    updateBar();
    // The estimate re-reads immediately because the measured pace is stored
    // normalized to rate 1 — no need to observe the new rate first.
    updateEta(true);
    if (!playing) return;
    if (handle) { handle.stop(); handle = null; }
    speakChunk(curWord ? curWord.ds : undefined);
  }

  function cycleRate(dir) {
    let i = RATES.indexOf(rate);
    if (i === -1) i = RATES.indexOf(1);
    i = Math.max(0, Math.min(RATES.length - 1, i + dir));
    setRate(RATES[i]);
  }

  /*
   * Sentence navigation, with the behaviour a music player has:
   *
   *   Back, mid-sentence  -> jump to the START of the sentence you're in
   *   Back, already there -> jump to the PREVIOUS sentence
   *   Forward             -> always the next sentence
   *
   * "Already there" is decided by position, not by timing a double-tap: if
   * you're within RESTART_GRACE_CHARS of the sentence start you're treated as
   * being at the start. That makes pressing Back twice do the obvious thing —
   * the first press lands you exactly at the start, so the second press
   * necessarily reads as "already there" — without depending on how fast you
   * press.
   */
  function jumpSentence(dir) {
    if (!sentences.length) return;
    const pos = currentOffset();

    let i = sentences.findIndex((s) => pos >= s.ds && pos < s.de);
    if (i === -1) {
      // Between sentences (a block separator) — take the next one that starts
      // at or after us, so Back still has something sensible to rewind to.
      i = sentences.findIndex((s) => s.ds >= pos);
      if (i === -1) i = sentences.length - 1;
    }

    if (dir < 0) {
      const intoSentence = pos - sentences[i].ds;
      // Far enough in to mean "restart this sentence"; otherwise step back.
      i = intoSentence > RESTART_GRACE_CHARS ? i : i - 1;
    } else {
      i = i + 1;
    }

    i = Math.max(0, Math.min(sentences.length - 1, i));
    seekToChar(sentences[i].ds);
  }

  /*
   * Seek by wall-clock listening time rather than by characters.
   *
   * "Back 15 seconds" means the last 15 seconds of YOUR time, so the distance
   * scales with the current speed: at 3x you covered three times as much text
   * in those 15 seconds, so we rewind three times as far. Re-hearing it then
   * takes 15 seconds again, which is what the gesture implies.
   */
  function seekSeconds(delta) {
    if (!chunks.length || !wordStarts.length) return;

    // How many words the engine gets through in `delta` seconds at this rate.
    const words = Math.round((WPM_AT_1X * (rate || 1) / 60) * delta);

    // Step that many entries through the word index rather than guessing at a
    // character distance, so we always land on a word boundary.
    let idx = wordStarts.length - wordsRemainingFrom(currentOffset());
    idx = Math.max(0, Math.min(wordStarts.length - 1, idx + words));

    seekToChar(wordStarts[idx]);
    toast((delta < 0 ? "◀ " : "▶ ") + Math.abs(delta) + "s", 900);
  }

  function seekToChar(pos) {
    chunkIdx = chunkIndexAt(pos);
    curWord = { ds: pos, de: wordEndFrom(pos) };
    curSentence = sentenceAt(pos);
    paint();
    updateEta(true);
    if (playing) {
      if (handle) { handle.stop(); handle = null; }
      speakChunk(pos);
    }
  }

  // ==========================================================================
  // PAUSE -> COMMENT
  // ==========================================================================

  /*
   * When you pause, highlight the paragraph you stopped on and open the
   * comment box on it — the same end state as selecting a paragraph and
   * pressing "c". This is the whole point of the feature: pausing usually
   * means you have a reaction.
   */
  /*
   * Highlight the paragraph containing the playhead and return its id.
   *
   * IMPORTANT: creating a highlight wraps text in <mark> elements, which
   * splits text nodes and invalidates every node reference in `segments`.
   * The text CONTENT is unchanged, so docText and all character offsets stay
   * valid — only the offset->node mapping goes stale. So we rebuild the index
   * afterwards and deliberately leave chunkIdx/curWord alone.
   */
  /*
   * The range a dictation should attach to.
   *
   * If you've selected text by hand, that selection is what you mean — you
   * went to the trouble of picking it. Only when there's no selection do we
   * fall back to the paragraph the playhead is in.
   */
  function dictationTargetRange() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      // Only honour selections inside the article — not the sidebar, the
      // comment box, or anywhere else on the page.
      if (article && article.contains(r.commonAncestorContainer) && r.toString().trim()) {
        return r.cloneRange();
      }
    }
    // A video's current transcript line stands in for the read-aloud playhead.
    if (clockActive()) {
      const el = externalClock.currentBlockEl();
      if (el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        return r;
      }
    }

    if (!curWord) return null;
    const b = blockAt(curWord.ds);
    if (!b) return null;
    const r = document.createRange();
    r.selectNodeContents(b.el);
    return r;
  }

  function highlightCurrentBlock() {
    if (typeof Highlights === "undefined" || !Highlights.createHighlightFromRange) return null;

    const range = dictationTargetRange();
    if (!range) return null;

    const id = Highlights.createHighlightFromRange(range, "yellow");
    if (id) {
      // Drop the selection now that it's been turned into a highlight —
      // otherwise the blue selection sits on top of the yellow one, and the
      // colour-swatch toolbar hangs around over the text you're commenting on.
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      if (Highlights.hideToolbar) Highlights.hideToolbar();
      buildIndex(article);   // remap offsets onto the new text nodes
      paint();               // repaint against the rebuilt mapping
    }
    return id;
  }

  function offerCommentOnPause() {
    if (!getSettings().ttsCommentOnPause) return;
    const id = highlightCurrentBlock();
    if (id && typeof Comments !== "undefined") {
      Comments.openPanelForHighlight(id);
    }
  }

  // ==========================================================================
  // DICTATE-AND-RESUME — the mic button in the player bar
  // ==========================================================================

  /*
   * One button, two presses. First press pauses the reading, highlights the
   * paragraph you're on, and starts recording. Second press stops, transcribes
   * via Groq Whisper, saves the result as a comment on that paragraph, and
   * picks the reading back up where it left off.
   *
   * The comments panel is deliberately NOT opened — the whole point is to keep
   * you in the flow of listening rather than pulling you into the UI.
   */
  let micState = "idle";       // 'idle' | 'recording' | 'transcribing'
  let micHandle = null;        // Voice module recording handle
  let micHighlightId = null;   // the paragraph this dictation belongs to
  let micResumeAfter = false;  // was it reading when the mic was pressed?

  async function toggleMic() {
    if (micState === "transcribing") return;
    if (micState === "recording") return finishDictation();
    return beginDictation();
  }

  /*
   * `resumeAfter` lets the caller state whether reading should pick back up
   * once the comment is saved. The hold-Space gesture pauses BEFORE dictation
   * starts (so the pause feels instant), which means by the time we get here
   * `playing` is already false and can't be used to infer intent.
   */
  async function beginDictation(resumeAfter) {
    if (typeof Voice === "undefined" || !Voice.hasKey()) {
      toast("Add your Groq API key in Settings → Voice to dictate", 3200);
      return;
    }

    /*
     * Whether to resume afterwards must come from the CALLER when it knows,
     * because hold-Space pauses on keydown — before this runs — so reading the
     * clock here would always see "already paused" and wrongly decide not to
     * resume. Only fall back to inspecting state when no answer was given.
     */
    if (clockActive()) {
      micResumeAfter = typeof resumeAfter === "boolean"
        ? resumeAfter
        : externalClock.isPlaying();
      if (externalClock.isPlaying()) externalClock.pause();
    } else {
      micResumeAfter = typeof resumeAfter === "boolean" ? resumeAfter : playing;
      if (playing) pauseForDictation();
    }

    micHighlightId = highlightCurrentBlock();

    try {
      micHandle = await Voice.startRecording();
      micState = "recording";
      updateMic();
      // Sticky: this has to stay up the whole time you're talking, because it
      // is the only place that says how to finish.
      toast('<span class="tts-rec-dot"></span>Recording — ' +
            '<kbd>D</kbd> or <kbd>Space</kbd> to save &nbsp;·&nbsp; ' +
            '<kbd>Esc</kbd> to discard', 0);
    } catch (err) {
      micHandle = null;
      micState = "idle";
      updateMic();
      toast(escapeForToast(err && err.message ? err.message : "Could not start recording"), 3200);
      if (micResumeAfter) resumeAfterDictation();
    }
  }

  /*
   * A dictation pause is not the same as a manual pause: we do NOT want
   * offerCommentOnPause() popping the panel open, because the mic flow is
   * handling the comment itself.
   */
  function pauseForDictation() {
    playing = false;
    if (handle) { handle.stop(); handle = null; }
    updateBar();
    updateEta(true);
  }

  async function finishDictation() {
    micState = "transcribing";
    updateMic();
    toast("Transcribing…", 0);

    const h = micHandle;
    micHandle = null;
    const targetHighlight = micHighlightId;

    /*
     * Stop and KEEP the audio first. If stopRecording() transcribes in the same
     * call, a dropped connection takes the recording down with it — the blob
     * goes out of scope and what you said is gone for good.
     *
     * The one-call form is kept as a fallback: js/*.js are cached separately by
     * the browser, so during a deploy you can briefly end up with a new tts.js
     * against an older voice.js. Better to lose the retry ability than to have
     * dictation stop working entirely.
     */
    const canHoldAudio = typeof Voice.stopRecordingRaw === "function" &&
                         typeof Voice.transcribe === "function";

    let blob = null;
    let text = "";

    if (!canHoldAudio) {
      try {
        text = await Voice.stopRecording(h);
      } catch (err) {
        micState = "idle";
        updateMic();
        toast(escapeForToast(err && err.message ? err.message : "Transcription failed"), 3200);
        discardDictationHighlight();
        if (micResumeAfter) resumeAfterDictation();
        return;
      }
      return saveDictation(text, targetHighlight);
    }

    try {
      blob = await Voice.stopRecordingRaw(h);
    } catch (err) {
      micState = "idle";
      updateMic();
      toast(escapeForToast(err && err.message ? err.message : "Recording failed"), 3200);
      discardDictationHighlight();
      if (micResumeAfter) resumeAfterDictation();
      return;
    }

    try {
      text = await Voice.transcribe(blob);
    } catch (err) {
      micState = "idle";
      updateMic();
      if (Voice.isRetryable && Voice.isRetryable(err)) {
        // Hold the audio and try again when the connection is back. The
        // highlight must SURVIVE — the comment is still coming for it.
        queueForRetry(blob, targetHighlight);
        micHighlightId = null;
      } else {
        toast(escapeForToast(err && err.message ? err.message : "Transcription failed"), 3600);
        discardDictationHighlight();
      }
      if (micResumeAfter) resumeAfterDictation();
      return;
    }

    return saveDictation(text, targetHighlight);
  }

  /*
   * Commit a finished transcript. Shared by the normal path and the
   * older-voice.js fallback. Every branch must end the sticky "Transcribing…"
   * toast, or it stays on screen forever.
   */
  function saveDictation(text, highlightId) {
    micState = "idle";
    updateMic();

    if (!text) {
      toast("Nothing recorded", 1800);
      discardDictationHighlight();
    } else if (typeof Comments !== "undefined" && Comments.addComment) {
      /*
       * Record WHERE IN THE VIDEO this was said — always, not just when there
       * is no highlight to hang it on.
       *
       * The moment is the only unambiguous anchor a video comment has. Line
       * text is not: a transcript that repeats itself matches the same words
       * in dozens of places, and the export then files notes under the wrong
       * one. Storing it costs a number and settles the question forever.
       */
      let at = null;
      if (clockActive() && externalClock.currentTime) at = externalClock.currentTime();
      Comments.addComment(highlightId, text, attachedDocId, at);
      const preview = text.length > 42 ? text.slice(0, 42) + "…" : text;
      // The toast renders HTML (for the <kbd> hints), so transcript text —
      // which comes back from the speech API — has to be escaped.
      toast("Saved: " + escapeForToast(preview), 2600);
    } else {
      toast("Could not save the comment", 2600);
      discardDictationHighlight();
    }

    micHighlightId = null;
    if (micResumeAfter) resumeAfterDictation();
  }

  function escapeForToast(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ==========================================================================
  // RETRY QUEUE — don't lose a recording to a dropped connection
  // ==========================================================================

  /*
   * A transcription that fails for a transient reason (no network, rate limit,
   * 5xx) keeps its audio here and is retried when the connection returns, when
   * the next dictation succeeds, or on a slow timer.
   *
   * The queue lives in memory only. Persisting audio would mean base64 in
   * localStorage — a 30-second clip is ~250KB encoded, against a budget that
   * already warns at 6MB — or IndexedDB, which this codebase deliberately
   * avoids. So a reload still loses anything pending, and the UI says so
   * rather than pretending otherwise.
   */
  let pending = [];          // [{ blob, highlightId, docId, tries }]
  let retryTimer = null;
  let retrying = false;

  function queueForRetry(blob, highlightId) {
    // Capture the moment NOW. By the time this uploads the video has moved on,
    // so asking the clock at retry time would stamp it with the wrong instant.
    let at = null;
    if (clockActive() && externalClock.currentTime) at = externalClock.currentTime();
    pending.push({ blob: blob, highlightId: highlightId, videoTime: at,
                   docId: attachedDocId, tries: 1 });
    updatePendingUI();
    toast('<span class="tts-rec-dot"></span>Offline — recording held, ' +
          'will retry when you reconnect', 4200);
    scheduleRetry(15000);
  }

  function scheduleRetry(ms) {
    if (retryTimer) clearTimeout(retryTimer);
    if (!pending.length) return;
    retryTimer = setTimeout(retryPending, ms);
  }

  async function retryPending() {
    if (retrying || !pending.length) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      scheduleRetry(20000);
      return;
    }
    retrying = true;

    const still = [];
    let saved = 0;
    for (const item of pending) {
      try {
        const text = await Voice.transcribe(item.blob);
        if (text && typeof Comments !== "undefined" && Comments.addComment) {
          // Attach to the doc it came from, not whatever is open now.
          Comments.addComment(item.highlightId, text, item.docId, item.videoTime);
          saved++;
        }
      } catch (err) {
        item.tries++;
        // Give up after enough attempts so a permanently broken item doesn't
        // retry forever — but only for retryable failures.
        if (item.tries <= 8 && Voice.isRetryable && Voice.isRetryable(err)) {
          still.push(item);
        } else {
          toast("Could not transcribe a held recording — it has been dropped", 4200);
        }
      }
    }

    pending = still;
    retrying = false;
    updatePendingUI();

    if (saved) {
      toast(saved === 1 ? "Held recording saved as a comment"
                        : saved + " held recordings saved", 3000);
    }
    if (pending.length) scheduleRetry(30000);
  }

  function updatePendingUI() {
    if (!bar) return;
    const btn = bar.querySelector("#tts-mic");
    if (!btn) return;
    btn.classList.toggle("has-pending", pending.length > 0);
    btn.dataset.pending = pending.length ? String(pending.length) : "";
  }

  function initRetry() {
    // The obvious trigger: the connection came back.
    window.addEventListener("online", function () {
      if (pending.length) { toast("Back online — retrying…", 2000); retryPending(); }
    });
    // And a slow safety net, since "online" can fire while the network is
    // still not actually usable.
    setInterval(function () { if (pending.length) retryPending(); }, 60000);
  }

  /*
   * Remove the highlight a dictation created, for any path where no comment
   * will ever be attached to it — cancelled, silent, or permanently failed.
   * Leaving it behind marks up the document with a passage the user never
   * actually annotated.
   *
   * NOT called when a failed transcription is queued for retry: that comment
   * is still coming, so the highlight has to survive to receive it.
   */
  function discardDictationHighlight() {
    const id = micHighlightId;
    micHighlightId = null;
    if (!id) return;
    if (typeof Highlights === "undefined" || !Highlights.removeHighlight) return;
    try {
      Highlights.removeHighlight(id);
      // removeHighlight unwraps the <mark>, which re-splits text nodes, so the
      // offset->node mapping has to be rebuilt exactly as it is after adding one.
      if (article) { buildIndex(article); paint(); }
    } catch (err) {
      console.error("[tts] could not remove dictation highlight:", err);
    }
  }

  function resumeAfterDictation() {
    if (clockActive()) externalClock.resume();
    else play();
  }

  function cancelDictation() {
    if (micState !== "recording") return;
    if (micHandle && typeof Voice !== "undefined") Voice.cancelRecording(micHandle);
    micHandle = null;
    micState = "idle";
    discardDictationHighlight();
    updateMic();
    hideToast();
    toast("Discarded", 1400);
    if (micResumeAfter) resumeAfterDictation();
  }

  function updateMic() {
    if (!bar) return;
    const btn = bar.querySelector("#tts-mic");
    if (!btn) return;
    btn.classList.toggle("recording", micState === "recording");
    btn.classList.toggle("transcribing", micState === "transcribing");
    btn.disabled = micState === "transcribing";
    btn.title = micState === "recording"
      ? "Done — save and resume (D, or tap Space)"
      : micState === "transcribing"
        ? "Transcribing…"
        : "Dictate a comment on this paragraph (D, or hold Space)";
  }

  // ==========================================================================
  // TOAST — brief, non-blocking status for the dictation loop
  // ==========================================================================

  let toastEl = null;
  let toastTimer = null;

  /*
   * Pass ms = 0 to make the toast stick until something clears it. Recording
   * uses that: the instruction for how to STOP needs to stay on screen the
   * whole time you're talking, since you're looking at the page and not the
   * player bar.
   */
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "tts-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = msg;
    toastEl.classList.add("visible");
    clearTimeout(toastTimer);
    if (ms === 0) return;                 // sticky
    toastTimer = setTimeout(() => toastEl.classList.remove("visible"), ms || 2200);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove("visible");
  }

  // ==========================================================================
  // PLAYER BAR UI
  // ==========================================================================

  let bar = null;

  function buildBar() {
    bar = document.getElementById("tts-bar");
    if (!bar) return;

    bar.querySelector("#tts-play").addEventListener("click", toggle);
    bar.querySelector("#tts-prev").addEventListener("click", () => jumpSentence(-1));
    bar.querySelector("#tts-next").addEventListener("click", () => jumpSentence(1));
    bar.querySelector("#tts-rate").addEventListener("click", () => {
      let i = RATES.indexOf(rate);
      setRate(RATES[(i + 1) % RATES.length]);
    });
    bar.querySelector("#tts-mic").addEventListener("click", toggleMic);
    const helpBtn = bar.querySelector("#tts-help-btn");
    if (helpBtn) helpBtn.addEventListener("click", toggleHelp);
    bar.querySelector("#tts-close").addEventListener("click", () => {
      cancelDictation();
      stop(true);
      hideBar();
    });

    const vsel = bar.querySelector("#tts-voice");
    vsel.addEventListener("change", () => {
      const v = provider().voices().find((x) => x.name === vsel.value);
      if (!v) return;
      selectedVoice = v;
      // Mark this as a deliberate choice so it survives future ranking changes.
      const s = FolioStore.getSettings();
      s.ttsVoicePicked = true;
      FolioStore.saveSettings(s);
      saveSettings();
      updateEta(true);
      if (playing) setRate(rate);
    });
  }

  function fillVoices() {
    if (!bar) return;
    const vsel = bar.querySelector("#tts-voice");
    const vs = provider().voices();
    vsel.innerHTML = "";
    vs.forEach((v) => {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = v.name.replace(/\s*\(English.*\)$/, "");
      vsel.appendChild(o);
    });
    if (selectedVoice) vsel.value = selectedVoice.name;
  }

  function showBar() { if (bar) bar.classList.add("visible"); }
  function hideBar() { if (bar) bar.classList.remove("visible"); }

  function updateBar() {
    if (!bar) return;
    const btn = bar.querySelector("#tts-play");
    btn.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    btn.title = playing ? "Pause (Space)" : "Play (Space)";
    bar.querySelector("#tts-rate").textContent = rate + "×";
    bar.classList.toggle("playing", playing);
  }

  // ==========================================================================
  // SETTINGS
  // ==========================================================================

  /*
   * ttsCommentOnPause now defaults OFF. It made sense when pausing was the
   * only way to signal "I have something to say", but hold-Space dictation
   * covers that directly — and having the panel spring open on every ordinary
   * pause fights the flow instead of helping it. Still available for anyone
   * who wants the old behaviour.
   */
  function getSettings() {
    const s = FolioStore.getSettings();
    if (s.ttsCommentOnPause === undefined) s.ttsCommentOnPause = false;
    return s;
  }

  function saveSettings() {
    const s = FolioStore.getSettings();
    s.ttsRate = rate;
    s.ttsVoice = selectedVoice ? selectedVoice.name : null;
    FolioStore.saveSettings(s);
  }

  /*
   * A stored voice only wins if the user actually chose it from the dropdown
   * (ttsVoicePicked). Otherwise it was just whatever happened to be best at
   * the time, and should be re-evaluated — so downloading a better voice
   * upgrades you automatically instead of leaving you stuck on Samantha
   * because her name got persisted weeks ago.
   */
  function loadSettings() {
    const s = getSettings();
    rate = s.ttsRate || 1;
    const vs = provider().voices();
    const stored = s.ttsVoice && vs.find((v) => v.name === s.ttsVoice);

    if (stored && s.ttsVoicePicked) {
      selectedVoice = stored;
    } else {
      selectedVoice = provider().defaultVoice() || stored || null;
    }
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /*
   * Called by the reader after it renders a document. Rebuilds the index from
   * scratch — the old one points at DOM nodes that no longer exist.
   */
  function attach(docId) {
    detach();
    attachedDocId = docId;
    article = document.getElementById("article");
    if (!article) return;
    buildIndex(article);
    makeChunks();
    chunkIdx = 0;
    curWord = null;
    curSentence = null;
    if (chunks.length) showBar();
    updateEta(true);
  }

  function detach() {
    cancelDictation();   // release the mic before the DOM goes away
    stop(true);
    hideBar();
    attachedDocId = null;
    docText = "";
    segments = [];
    blocks = [];
    sentences = [];
    chunks = [];
  }

  // Click a word to start reading from there.
  function initClickToSeek() {
    const art = document.getElementById("article");
    if (!art) return;
    art.addEventListener("dblclick", function (e) {
      if (!chunks.length) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      const pos = domToChar(r.startContainer, r.startOffset);
      if (pos === null) return;
      sel.removeAllRanges();
      seekToChar(pos);
      if (!playing) play();
    });
  }

  // Inverse of locate(): DOM position -> character offset in docText.
  function domToChar(node, off) {
    for (const s of segments) {
      if (s.node === node) return s.ds + (off - s.ns);
    }
    return null;
  }

  /*
   * Keyboard transport — one thumb on the spacebar, like a game controller.
   *
   *   Space (tap)    play / pause
   *   Space (hold)   pause and start dictating. Recording LATCHES, so let go
   *                  and keep talking; a later tap saves it and resumes.
   *   ← →            back / forward 15 seconds
   *   Shift + ← →    previous / next sentence
   *   ↑ ↓            faster / slower
   *   C  or  M       dictate (alias, for when a dedicated key is preferred)
   *   ?              show this list
   *   Esc            cancel dictation, or stop reading
   *
   * WHICH EDGE EACH ACTION FIRES ON, and why it has to be this way:
   *
   * A tap and a hold can't be told apart until the key comes back up, but
   * pause is the one action that must feel instantaneous. So:
   *
   *   - If we're PLAYING, keydown pauses immediately. Should the press turn
   *     out to be a hold, we're already in the state dictation wants.
   *   - If we're PAUSED, keydown does nothing and keyup starts playing. A real
   *     tap releases in well under 100ms, so this still feels instant, and it
   *     avoids the nonsense of a hold briefly starting playback before
   *     recording.
   *
   * Arrow keys only take over once ENGAGED (playing, or parked at a playhead),
   * so merely opening a document doesn't hijack normal page scrolling.
   *
   * Everything is bare-key — any Cmd/Ctrl/Alt press is handed to the browser
   * untouched — and these are page listeners, so nothing fires unless Folio
   * has focus.
   */

  let spaceDownAt = 0;
  let spaceHoldTimer = null;
  let spaceBecameDictation = false;
  let spaceWasPlaying = false;
  let spaceIsDown = false;

  /*
   * Keys that toggle dictation: press once to start, again to stop and save.
   * This is the alternative to hold-Space, kept alongside it so both styles are
   * available.
   *
   * NOTE: "c" is deliberately NOT in this set. highlights.js already binds "c"
   * to highlight-and-comment whenever the selection toolbar is showing
   * (js/highlights.js:575), and that handler has no idea this one exists — so
   * pressing "c" with text selected would fire both, creating a highlight AND
   * starting a recording. "d" is the primary key; "m" stays as an alias.
   */
  function isDictateKey(k) {
    return k === "d" || k === "D" || k === "m" || k === "M";
  }

  /*
   * Bare Option-tap as a dictation toggle.
   *
   * Option is reachable by the left thumb and, unlike Fn, it really is
   * delivered to the page. The complication is that it's a MODIFIER: its
   * keydown fires on the way into every combo, so acting on keydown would
   * start a recording on ⌥←, on ⌥-click, and on typing é.
   *
   * So we only act on keyUP, and only if the press was "bare" — nothing else
   * happened while Option was held. Any other key, any mouse press, any scroll
   * disqualifies it. Losing focus mid-press disqualifies it too, since the
   * keyup may never arrive.
   */
  let altDown = false;
  let altBare = false;

  function disqualifyAltTap() { altBare = false; }

  function initAltTap() {
    document.addEventListener("keydown", function (e) {
      if (e.key === "Alt") {
        if (!altDown) {
          altDown = true;
          // Only a candidate if Option is the ONLY modifier involved.
          altBare = !e.metaKey && !e.ctrlKey && !e.shiftKey;
        }
        return;
      }
      // Some other key went down while Option was held — it's a combo.
      if (altDown) disqualifyAltTap();
    }, true);

    document.addEventListener("keyup", function (e) {
      if (e.key !== "Alt") return;
      const wasBare = altBare;
      altDown = false;
      altBare = false;
      if (!wasBare) return;

      const readerActive = document.getElementById("view-reader");
      if (!readerActive || !readerActive.classList.contains("active")) return;
      if (!chunks.length && !clockActive()) return;
      if (isTypingTarget(e.target)) return;
      if (micState === "transcribing") return;

      toggleMic();
    }, true);

    // A mouse press or scroll while Option is held means it was a modifier.
    ["mousedown", "wheel", "contextmenu", "dragstart"].forEach(function (evt) {
      document.addEventListener(evt, function () {
        if (altDown) disqualifyAltTap();
      }, true);
    });

    // If the window loses focus while Option is down, the keyup never comes.
    window.addEventListener("blur", function () { altDown = false; altBare = false; });
  }

  function engaged() { return playing || !!curWord; }

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || t.isContentEditable;
  }

  function clearSpaceHold() {
    if (spaceHoldTimer) { clearTimeout(spaceHoldTimer); spaceHoldTimer = null; }
  }

  function initShortcuts() {
    document.addEventListener("keydown", function (e) {
      const readerActive = document.getElementById("view-reader");
      if (!readerActive || !readerActive.classList.contains("active")) return;
      if (!chunks.length && !clockActive()) return;
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const isSpace = e.code === "Space" || e.key === " ";
      const isMicKey = isDictateKey(e.key);

      // Mid-transcription: swallow transport keys so a stray tap can't start
      // playback underneath the pending save.
      if (micState === "transcribing") {
        if (isSpace || isMicKey) e.preventDefault();
        return;
      }

      // ── While recording, Space / C / M all mean "done" ──
      if (micState === "recording") {
        if (e.key === "Escape") { e.preventDefault(); cancelDictation(); return; }
        if (isSpace || isMicKey) {
          e.preventDefault();
          if (!e.repeat) finishDictation();
          return;
        }
        return;
      }

      if (isSpace) {
        e.preventDefault();
        if (e.repeat) return;          // OS key-repeat while held
        spaceIsDown = true;
        spaceDownAt = Date.now();
        spaceBecameDictation = false;
        spaceWasPlaying = clockActive() ? externalClock.isPlaying() : playing;

        // Pause now if we're playing — this is the latency-sensitive action.
        // On a video document the video is the thing that's playing.
        if (clockActive()) {
          if (externalClock.isPlaying()) externalClock.pause();
        } else if (playing) {
          pauseForDictation();
        }

        clearSpaceHold();
        spaceHoldTimer = setTimeout(function () {
          spaceHoldTimer = null;
          if (!spaceIsDown) return;
          spaceBecameDictation = true;
          beginDictation(spaceWasPlaying);
        }, SPACE_HOLD_MS);
        return;
      }

      if (isMicKey) {
        e.preventDefault();
        if (!e.repeat) toggleMic();
        return;
      }

      // On a video document the arrows and speed chip belong to the player,
      // which owns its own controls; don't drive the reader instead.
      if (clockActive()) {
        if (e.key === "Escape") { e.preventDefault(); externalClock.pause(); }
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
          if (!engaged()) return;
          e.preventDefault();
          e.shiftKey ? seekSeconds(-SEEK_SECONDS) : jumpSentence(-1);
          break;
        case "ArrowRight":
          if (!engaged()) return;
          e.preventDefault();
          e.shiftKey ? seekSeconds(SEEK_SECONDS) : jumpSentence(1);
          break;
        case "ArrowUp":
          if (!engaged()) return;
          e.preventDefault(); cycleRate(1); toast(rate + "×", 900); break;
        case "ArrowDown":
          if (!engaged()) return;
          e.preventDefault(); cycleRate(-1); toast(rate + "×", 900); break;
        case "[":
          e.preventDefault(); cycleRate(-1); toast(rate + "×", 900); break;
        case "]":
          e.preventDefault(); cycleRate(1); toast(rate + "×", 900); break;
        case "?":
          e.preventDefault(); toggleHelp(); break;
        case "Escape":
          if (playing) { e.preventDefault(); pause(); }
          break;
      }
    });

    /*
     * Space release decides what the press meant.
     *
     * If the hold timer already fired we're recording — do nothing, because
     * the recording is latched and the user wants to keep talking with their
     * hand off the key. Otherwise it was a tap: start playing if we were
     * paused, or complete the manual-pause behaviour if we were playing.
     */
    document.addEventListener("keyup", function (e) {
      const isSpace = e.code === "Space" || e.key === " ";
      if (!isSpace || !spaceIsDown) return;
      spaceIsDown = false;
      clearSpaceHold();

      if (spaceBecameDictation) return;   // latched; leave it recording

      if (clockActive()) {
        // Video document: keydown already paused it, so a tap either leaves it
        // paused or starts it again.
        if (!spaceWasPlaying) externalClock.resume();
        return;
      }

      if (spaceWasPlaying) {
        // keydown already paused us — finish the manual-pause semantics.
        offerCommentOnPause();
      } else {
        play();
      }
    });
  }

  // ==========================================================================
  // SHORTCUT HELP OVERLAY
  // ==========================================================================

  let helpEl = null;

  function toggleHelp() {
    if (helpEl && helpEl.classList.contains("visible")) {
      helpEl.classList.remove("visible");
      return;
    }
    if (!helpEl) {
      helpEl = document.createElement("div");
      helpEl.id = "tts-help";
      helpEl.innerHTML = `
        <div class="tts-help-card">
          <h3>Reading controls</h3>
          <dl>
            <dt><kbd>Space</kbd> <span class="tts-help-hint">tap</span></dt>
              <dd>Play / pause</dd>
            <dt><kbd>Space</kbd> <span class="tts-help-hint">hold</span></dt>
              <dd>Start dictating a comment</dd>
            <dt><span class="tts-help-hint">…then</span></dt>
              <dd><b>1.</b> Let go — it keeps recording, hands free<br>
                  <b>2.</b> Say what you think<br>
                  <b>3.</b> Tap <kbd>Space</kbd> to save it and carry on reading</dd>
            <dt><kbd>←</kbd></dt>
              <dd>Restart this sentence — press again for the previous one</dd>
            <dt><kbd>→</kbd></dt><dd>Next sentence</dd>
            <dt><kbd>⇧</kbd><kbd>←</kbd> <kbd>⇧</kbd><kbd>→</kbd></dt><dd>Back / forward 15 seconds</dd>
            <dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Faster / slower</dd>
            <dt><kbd>D</kbd> <span class="tts-help-hint">or</span> <kbd>⌥</kbd></dt>
              <dd>Dictate — tap to start, tap again to save. Same result as
                  hold-Space, without the holding. Option only counts as a
                  bare tap, so ⌥-combos still work normally.</dd>
            <dt><kbd>Esc</kbd></dt><dd>Cancel dictation / stop</dd>
            <dt><kbd>?</kbd></dt><dd>Close this</dd>
          </dl>
          <p class="tts-help-foot">
            Arrows take over playback once reading has started — before that they scroll normally.
            Nothing fires unless Folio has focus, so your other apps are untouched.
          </p>
        </div>`;
      helpEl.addEventListener("click", () => helpEl.classList.remove("visible"));
      document.body.appendChild(helpEl);
    }
    helpEl.classList.add("visible");
  }

  function init() {
    initHighlights();
    buildBar();

    // Voice lists populate asynchronously in Chrome.
    if (WebSpeechProvider.available()) {
      loadSettings();
      fillVoices();
      speechSynthesis.onvoiceschanged = function () { loadSettings(); fillVoices(); };
    }

    initClickToSeek();
    initShortcuts();
    initAltTap();
    initRetry();

    // Held recordings live in memory only, so a reload really does lose them.
    // Say so rather than letting them vanish silently.
    window.addEventListener("beforeunload", function (e) {
      if (!pending.length) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });
    updateBar();
    updateMic();

    // Stop speaking if the tab is hidden — otherwise it keeps talking in the
    // background with no visible highlight.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && playing) pause();
    });
  }

  return {
    init, attach, detach,
    play, pause, toggle, stop,
    setRate, cycleRate, seekToChar, jumpSentence,
    // Lets a video register itself as the clock the dictation loop drives.
    setExternalClock,
    // Providers reuse the player's status line.
    toast,
    isPlaying: () => playing,
    isSupported: () => WebSpeechProvider.available(),
  };
})();

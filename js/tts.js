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

  // Arrow-key seek distance, in seconds of listening at the current speed.
  const SEEK_SECONDS = 15;

  // Hold Space longer than this and it starts dictation instead of being a
  // play/pause tap. Recording then LATCHES — you let go and keep talking, and
  // a later tap ends it. Long enough not to trigger on a normal tap, short
  // enough that the gesture feels immediate.
  const SPACE_HOLD_MS = 350;

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
    voices: function () {
      if (!this.available()) return [];
      return speechSynthesis.getVoices()
        .filter((v) => v.localService && /^en/i.test(v.lang))
        .sort((a, b) => {
          // Surface Premium/Enhanced voices first — they're markedly better
          const score = (v) => (/premium/i.test(v.name) ? 0 : /enhanced/i.test(v.name) ? 1 : 2);
          return score(a) - score(b) || a.name.localeCompare(b.name);
        });
    },

    defaultVoice: function () {
      const vs = this.voices();
      return vs.find((v) => /premium/i.test(v.name))
          || vs.find((v) => /enhanced/i.test(v.name))
          || vs.find((v) => v.name === "Samantha")
          || vs[0] || null;
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

  function jumpSentence(dir) {
    const pos = curWord ? curWord.ds : 0;
    let i = sentences.findIndex((s) => pos >= s.ds && pos < s.de);
    if (i === -1) i = 0;
    i = Math.max(0, Math.min(sentences.length - 1, i + dir));
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
  function highlightCurrentBlock() {
    if (!curWord) return null;
    if (typeof Highlights === "undefined" || !Highlights.createHighlightFromRange) return null;

    const b = blockAt(curWord.ds);
    if (!b) return null;

    const r = document.createRange();
    r.selectNodeContents(b.el);

    const id = Highlights.createHighlightFromRange(r, "yellow");
    if (id) {
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

    micResumeAfter = typeof resumeAfter === "boolean" ? resumeAfter : playing;
    if (playing) pauseForDictation();

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
      if (micResumeAfter) play();
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

    let text = "";
    try {
      text = await Voice.stopRecording(h);
    } catch (err) {
      micState = "idle";
      updateMic();
      toast(escapeForToast(err && err.message ? err.message : "Transcription failed"), 3200);
      if (micResumeAfter) play();
      return;
    }

    micState = "idle";
    updateMic();

    // Every path below must end the sticky "Transcribing…" toast, or it hangs
    // on screen forever.
    if (!text) {
      toast("Nothing recorded", 1800);
    } else if (typeof Comments !== "undefined" && Comments.addComment) {
      Comments.addComment(micHighlightId, text);
      const preview = text.length > 42 ? text.slice(0, 42) + "…" : text;
      // The toast renders HTML (for the <kbd> hints), so transcript text —
      // which comes back from the speech API — has to be escaped.
      toast("Saved: " + escapeForToast(preview), 2600);
    } else {
      toast("Could not save the comment", 2600);
    }

    micHighlightId = null;
    if (micResumeAfter) play();
  }

  function escapeForToast(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function cancelDictation() {
    if (micState !== "recording") return;
    if (micHandle && typeof Voice !== "undefined") Voice.cancelRecording(micHandle);
    micHandle = null;
    micState = "idle";
    micHighlightId = null;
    updateMic();
    hideToast();
    toast("Discarded", 1400);
    if (micResumeAfter) play();
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

  function loadSettings() {
    const s = getSettings();
    rate = s.ttsRate || 1;
    const vs = provider().voices();
    selectedVoice = (s.ttsVoice && vs.find((v) => v.name === s.ttsVoice))
                 || provider().defaultVoice();
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
      if (!chunks.length) return;
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
        spaceWasPlaying = playing;

        // Pause now if we're playing — this is the latency-sensitive action.
        if (playing) pauseForDictation();

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

      switch (e.key) {
        case "ArrowLeft":
          if (!engaged()) return;
          e.preventDefault();
          e.shiftKey ? jumpSentence(-1) : seekSeconds(-SEEK_SECONDS);
          break;
        case "ArrowRight":
          if (!engaged()) return;
          e.preventDefault();
          e.shiftKey ? jumpSentence(1) : seekSeconds(SEEK_SECONDS);
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
            <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Back / forward 15 seconds</dd>
            <dt><kbd>⇧</kbd><kbd>←</kbd> <kbd>⇧</kbd><kbd>→</kbd></dt><dd>Previous / next sentence</dd>
            <dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Faster / slower</dd>
            <dt><kbd>D</kbd></dt>
              <dd>Dictate — tap to start, tap again to save. Same result as
                  hold-Space, without the holding.</dd>
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
    isPlaying: () => playing,
    isSupported: () => WebSpeechProvider.available(),
  };
})();

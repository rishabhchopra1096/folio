/*
 * =============================================================================
 * READALOUD.JS — read text selected in any other application
 * =============================================================================
 * WHAT THIS IS FOR:
 * Press the shortcut anywhere on the Mac, and whatever is selected appears here
 * and is read aloud. The capturing happens in electron/capture.js; this file is
 * everything after the text arrives.
 *
 * WHY THE TEXT IS SHOWN HERE RATHER THAN HIGHLIGHTED IN PLACE:
 * The capture gives us a string and, at best, the screen rectangle of the whole
 * selection. It does not give per-word coordinates or character offsets into
 * the source application's own layout, so painting a moving highlight inside
 * Notes.app or Chrome is not possible — not difficult, impossible.
 *
 * That turns out to be a gift. Because we render the text ourselves, the hard
 * problem Folio solves in js/tts.js — mapping a character offset back onto a
 * live DOM node — collapses into a lookup, since we built the DOM.
 *
 * THE RULE THIS FILE EXISTS TO OBEY:
 * The audio element and the thing painting the highlight live in the SAME
 * context, and the highlight is driven from the engine's own word callbacks.
 * The previous attempt at this feature put them in different processes and
 * dead-reckoned the playhead from wall-clock time; that is the single mistake
 * that made it never feel right.
 * =============================================================================
 */

const ReadAloud = (function () {

  // ==========================================================================
  // CHUNKING — the same rules as the document reader, on a plain string
  // ==========================================================================

  /*
   * Boundaries are decided by each sentence's own text, not by how much came
   * before it, so the same passage always splits the same way and therefore
   * hits the same cache entries. Identical reasoning to groupIntoChunks in
   * js/tts.js; the difference is only that sentences come from a string here
   * rather than from a rendered document.
   */
  const CHUNK_MIN_CHARS = 600;
  const CHUNK_MAX_CHARS = 1800;
  const BOUNDARY_EVERY = 4;

  function sentenceHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  function splitSentences(text) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      const out = [];
      for (const s of seg.segment(text)) {
        if (s.segment.trim()) out.push({ ds: s.index, de: s.index + s.segment.length });
      }
      if (out.length) return out;
    }
    // Engines without Intl.Segmenter still have to read something.
    const out = [];
    const re = /[^.!?]+[.!?]*\s*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].trim()) out.push({ ds: m.index, de: m.index + m[0].length });
    }
    return out.length ? out : [{ ds: 0, de: text.length }];
  }

  function chunkText(text) {
    const chunks = [];
    let cs = null, ce = null;

    for (const s of splitSentences(text)) {
      if (cs !== null && (s.de - cs) > CHUNK_MAX_CHARS) {
        chunks.push({ ds: cs, de: ce });
        cs = null;
      }
      if (cs === null) { cs = s.ds; ce = s.de; } else { ce = s.de; }

      const bigEnough = (ce - cs) >= CHUNK_MIN_CHARS;
      const isBoundary = (sentenceHash(text.slice(s.ds, s.de).trim()) % BOUNDARY_EVERY) === 0;
      if (bigEnough && isBoundary) { chunks.push({ ds: cs, de: ce }); cs = null; }
    }
    if (cs !== null) chunks.push({ ds: cs, de: ce });
    return chunks.map((c) => ({ ds: c.ds, de: c.de, text: text.slice(c.ds, c.de) }));
  }

  // ==========================================================================
  // STATE
  // ==========================================================================

  let view = null, body = null, meta = null, bar = null;
  let docText = "";
  let paras = [];            // [{ node, ds, de }] — offset ↔ DOM, trivially
  let chunks = [];
  let chunkIdx = 0;
  let handle = null;
  let playing = false;
  let rate = 1;
  let wordHL = null, sentHL = null;

  function el(id) { return document.getElementById(id); }

  function init() {
    view = el("view-readaloud");
    if (!view) return;
    body = el("readaloud-body");
    meta = el("readaloud-meta");
    bar = el("readaloud-bar");

    if (typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function") {
      wordHL = new Highlight();
      CSS.highlights.set("ra-word", wordHL);
      sentHL = new Highlight();
      CSS.highlights.set("ra-sentence", sentHL);
    }

    el("readaloud-play").addEventListener("click", toggle);
    el("readaloud-close").addEventListener("click", close);
    el("readaloud-rate").addEventListener("click", cycleRate);

    if (window.folio && window.folio.onReadSelection) {
      window.folio.onReadSelection(receive);
    }
  }

  // ==========================================================================
  // RECEIVING A SELECTION
  // ==========================================================================

  function receive(payload) {
    if (!view) return;
    stop();

    if (!payload || payload.error) {
      show();
      meta.textContent = "Couldn't read a selection";
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "readaloud-error";
      p.textContent = (payload && payload.error) || "Nothing was captured.";
      body.appendChild(p);
      bar.style.display = "none";
      return;
    }

    docText = String(payload.text || "").replace(/\r\n/g, "\n").trim();
    if (!docText) { receive({ error: "That selection was empty." }); return; }

    render(payload);
    chunks = chunkText(docText);
    chunkIdx = 0;
    show();
    play();                          // pressing the shortcut means "read it"
  }

  /*
   * Render the text and record where every paragraph starts.
   *
   * One text node per paragraph, so an offset resolves with a binary search and
   * a subtraction — no tree walking, no re-indexing after a highlight is
   * painted. This is the part that is easy only because we own the DOM.
   */
  function render(payload) {
    body.innerHTML = "";
    paras = [];

    const app = (payload.app || "").replace(/^com\.[^.]+\./, "");
    const words = docText.split(/\s+/).filter(Boolean).length;
    meta.textContent = (app ? app + " · " : "") + words.toLocaleString() + " words" +
                       (payload.method === "copy" ? " · via copy" : "");

    let at = 0;
    for (const block of docText.split(/\n\s*\n/)) {
      const trimmed = block.replace(/\s+$/, "");
      const start = docText.indexOf(trimmed, at);
      if (!trimmed) continue;
      const p = document.createElement("p");
      const node = document.createTextNode(trimmed);
      p.appendChild(node);
      body.appendChild(p);
      paras.push({ node: node, ds: start, de: start + trimmed.length });
      at = start + trimmed.length;
    }
    bar.style.display = "";
  }

  /* A document offset as a live DOM position. */
  function positionAt(offset) {
    let lo = 0, hi = paras.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = paras[mid];
      if (offset < p.ds) hi = mid - 1;
      else if (offset >= p.de) lo = mid + 1;
      else return { node: p.node, off: offset - p.ds };
    }
    return null;
  }

  function paint(ds, de) {
    if (!wordHL) return;
    wordHL.clear();
    const a = positionAt(ds), b = positionAt(Math.max(ds, de - 1));
    if (!a || !b) return;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off + 1);
      wordHL.add(r);
      const rect = a.node.parentElement && a.node.parentElement.getBoundingClientRect();
      if (rect && (rect.top < 60 || rect.bottom > window.innerHeight - 80)) {
        a.node.parentElement.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } catch { /* the range fell outside; the next word will correct it */ }
  }

  // ==========================================================================
  // PLAYBACK
  // ==========================================================================

  function engine() {
    if (typeof SpeechifyProvider !== "undefined" && SpeechifyProvider.available()) {
      return SpeechifyProvider;
    }
    return null;                     // caller falls back to the system voice
  }

  function speakChunk() {
    if (chunkIdx >= chunks.length) { stop(); return; }
    const c = chunks[chunkIdx];
    const next = chunks[chunkIdx + 1];

    const provider = engine();
    if (!provider) { speakWithSystemVoice(c); return; }

    handle = provider.speak(c.text, {
      rate: rate,
      voice: provider.defaultVoice(),
      next: next ? next.text : "",
      startOffset: 0,
      onWord: function (charIndex, charLength) {
        paint(c.ds + charIndex, c.ds + charIndex + (charLength || 1));
      },
      onEnd: function () {
        if (!playing) return;
        chunkIdx++;
        speakChunk();
      },
      onError: function (msg) {
        playing = false;
        updateBar();
        meta.textContent = msg;
      },
      onStatus: function (info) {
        if (info && info.phase === "preparing") {
          const s = (info.elapsedMs / 1000).toFixed(1);
          const exp = Math.max(1, Math.round(info.expectedMs / 100) / 10);
          el("readaloud-status").textContent = `Preparing ${s}s of ~${exp}s`;
        } else {
          el("readaloud-status").textContent = "";
        }
      },
    });
  }

  /* No Speechify key configured — read it anyway, with the free system voice. */
  function speakWithSystemVoice(c) {
    if (typeof speechSynthesis === "undefined") {
      meta.textContent = "No speech engine available.";
      playing = false; updateBar(); return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(c.text);
    u.rate = rate;
    u.onboundary = function (e) {
      if (typeof e.charIndex === "number") {
        paint(c.ds + e.charIndex, c.ds + e.charIndex + (e.charLength || 8));
      }
    };
    u.onend = function () { if (playing) { chunkIdx++; speakChunk(); } };
    handle = { stop: function () { speechSynthesis.cancel(); } };
    speechSynthesis.speak(u);
  }

  function play() {
    if (playing || !chunks.length) return;
    playing = true;
    updateBar();
    speakChunk();
  }

  function pause() {
    playing = false;
    if (handle) { handle.stop(); handle = null; }
    updateBar();
  }

  function toggle() { playing ? pause() : play(); }

  function stop() {
    playing = false;
    if (handle) { handle.stop(); handle = null; }
    if (wordHL) wordHL.clear();
    chunkIdx = 0;
    updateBar();
  }

  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  function cycleRate() {
    rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] || 1;
    // A network voice changes rate in place; the system voice cannot, so it
    // restarts the current chunk — the same trade js/tts.js already makes.
    if (handle && handle.setRate) handle.setRate(rate);
    else if (playing) { pause(); play(); }
    updateBar();
  }

  function updateBar() {
    const btn = el("readaloud-play");
    if (btn) btn.textContent = playing ? "Pause" : "Play";
    const r = el("readaloud-rate");
    if (r) r.textContent = rate + "×";
  }

  function show() { if (view) view.classList.add("active"); }

  function close() {
    stop();
    if (view) view.classList.remove("active");
  }

  return { init, receive, close, _chunkText: chunkText };
})();

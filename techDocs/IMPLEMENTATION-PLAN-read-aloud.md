# Read-Aloud for Folio — Implementation Plan

_Speechify Simba TTS with word-synced two-tier highlighting, real variable speed, and pause-to-comment._

---

## TL;DR

- **Variable speed is a non-problem if we build it right.** The WHATWG spec says `playbackRate` changes how fast `currentTime` *advances*, not what it *means*. Speech-mark milliseconds and `audio.currentTime * 1000` stay in the same units at every rate. **The fix is to never multiply by rate anywhere.** The last attempt's bug was writing `* rate`; the fix is deleting it, not correcting it.
- **Provider: Speechify Simba-3.2.** It's the only candidate that returns word-level timings *and* character offsets into the exact string we sent, at $6–10/1M chars (a 10k-word document ≈ **$0.55**). CORS verified open by live preflight — the browser calls it directly, no proxy.
- **Highlighting: CSS Custom Highlight API, never `<span>` wrapping.** Span-wrapping would silently reattach every saved highlight in every document to the wrong text (Folio keys highlights to text-node indices).
- **Address everything by character offset, never by word count.** TTS normalizes text ("$5" → "five dollars"), so spoken-word indices drift from DOM-word indices and the error compounds down the page. This was a real, separate bug in the last attempt.
- **Build Phase 0 first**: one live API call. No live Speechify call has *ever* been made across all prior research — response shape, latency, and the offset index-space are all unverified assumptions until it happens.

## Document map

| Section | What's in it |
|---|---|
| 1. What we're building | The UX, concretely |
| 2. Why the last attempt failed | Six root causes, and the rule each one produces |
| 3. Architecture | Data flow, core data structures |
| 4. The speed problem, solved | The one rule, with spec citation |
| 5. The offset problem, solved | Three-way ambiguity and the auto-detect probe |
| 6. Chunking & playback | 2,000-char cap, ping-pong elements, per-chunk timebases |
| 7. Highlighting | Two registries, the rAF loop |
| 8. Pause-to-comment | Reuse of the existing annotate path |
| 9. Files & module surface | What gets written |
| 10. Phased build | Phase 0 spike → Phase 4 polish |
| 11. Cost & risk | Money, and what could still go wrong |
| 12. Open questions | What only a live call can answer |

---

## 1. What we're building

Press play in reader mode. The document reads aloud in a premium voice. As it reads:

- The **current sentence** carries a soft background tint.
- The **current word** inside it carries a stronger tint.
- The page auto-scrolls to keep the current word comfortably in view.

You change speed on the fly — 0.75× when the material is dense, 2× when you're skimming, 3× when you're bored. The voice stays natural at every rate (no chipmunk), and the highlighting stays locked to the audio at every rate.

You hit pause. **The paragraph you stopped on is highlighted and the comment box opens on it**, exactly as if you'd selected it and pressed `c`. You dictate a comment with the mic button (already built), hit ⌘↵, and press play to continue.

Clicking any word starts reading from that word.

That last loop — pause, comment, resume — is the actual point. It turns a long document into a stream of verbatim reactions with almost no friction.

## 2. Why the last attempt failed, and the rule each failure produces

From `superwhisper-tts-postmortem.md` (code-level forensics of `superwhisper-clone`):

| # | Root cause | Evidence | **Rule it produces** |
|---|---|---|---|
| 1 | `setSpeed()` was a stub that stored a number and logged *"Speed adjustment requires audio reprocessing"* | `src/services/unrealSpeechTTS.js:786` | Speed must act on a **transport that supports it** — an `<audio>` element, not a PCM pipe. |
| 2 | Kokoro's `speed` input was a no-op — *"byte-identical audio at any speed value"* | commit `6d3c932` | Never ask the **synthesizer** for speed. Speed is a **playback** concern. |
| 3 | `AudioBufferSourceNode.playbackRate` resamples → pitch shift → the chipmunk | `reader-extension/content.js:110` | Use `HTMLMediaElement.playbackRate` (pitch-corrected), **never** Web Audio's. |
| 4 | Three incompatible unit scales for `speed` in one file; 1.5× arrived as `rate = 2.5` | `:313`, `:908`, `:465` | **One** rate variable, one unit (a plain multiplier), set in exactly one place. |
| 5 | Wall-clock dead reckoning: `sched.pos + (Date.now()-sched.t)/1000 * sched.rate`, computed in a **different process** from the audio element | `reader-extension/content.js:69` | **Never derive the playhead.** Read `audio.currentTime`. Never write `* rate`. |
| 6 | Cursor advanced by **TTS-spoken** word count, used to index the **DOM** word array; "Dr."→doctor, "$5"→five dollars makes it drift, compounding | `offscreen.js:139` → `content.js:72` | Address by **character offset into the source text**, never by word count. |

Plus the gut-punch: real word timestamps *were* fetched (`:985`) and then **discarded** (`textToSpeechService.js:620-624`). The correct data was in hand.

Two things in that codebase were right and we keep them: `read-aloud/highlighter.js` uses the CSS Custom Highlight API, and `read-aloud/index.html:309-320` has a correct `currentTime`-driven tick loop. They were just never combined with real timestamps.

## 3. Architecture

```
Reader renders #article
        │
        ▼
[1] Tokenize DOM  ─────────────► positionMap: charOffset → {textNode, nodeOffset}
        │                        docText: the full plain-text string
        ▼
[2] Chunk (Intl.Segmenter)  ───► chunks[]: ~1,200–1,800 chars, paragraph-aligned
        │
        ▼
[3] Synthesize on demand  ─────► POST /v1/audio/speech  (current chunk + 1 lookahead)
        │                        ← { audio_data: base64 mp3, speech_marks: {...} }
        ▼
[4] Play  ─────────────────────► <audio> A / <audio> B  ping-pong, both pre-unlocked
        │                        el.playbackRate = rate;  el.preservesPitch = true
        ▼
[5] rAF loop  ─────────────────► tMs = el.currentTime * 1000        ← media timebase
        │                        word = binarySearch(chunk.words, tMs)
        │                        sent = binarySearch(chunk.sentences, tMs)
        ▼
[6] Paint  ────────────────────► CSS.highlights "tts-word" + "tts-sentence"
                                 (zero DOM mutation)
```

### Core data structures

```js
// Built once per document render. Lets us convert any char offset in docText
// back into a live DOM position without having mutated the DOM.
positionMap = [
  { textStart, textEnd, node /* Text */, nodeStart }   // sorted by textStart
]

// One synthesis unit.
chunk = {
  index,
  text,           // the EXACT string sent to the API
  docStart,       // char offset of this chunk within docText
  status,         // 'pending' | 'loading' | 'ready' | 'error'
  audioUrl,       // blob: URL for the mp3
  words,          // [{ t0, t1, cs, ce }]  ms + char offsets, chunk-relative, sorted by t0
  sentences,      // [{ t0, t1, cs, ce }]
}
```

Note `words[].cs/ce` are **chunk-relative** char offsets, normalized into JS UTF-16 units by the index-space probe (§5). Converting to a document offset is `chunk.docStart + cs`.

**Per-chunk timebases.** Each chunk's marks are relative to its own audio. We deliberately do **not** build a global timeline — that would require summing durations and would accumulate float error across a long document.

## 4. The speed problem, solved

The WHATWG HTML spec, on the current playback position ([spec](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource)):

> "its current playback position must increase monotonically at the element's **`playbackRate` units of media time per unit time of the media timeline's clock**"

Read that carefully: `playbackRate` is a ratio of **media time to wall-clock time**. It changes how fast `currentTime` advances in real seconds. It does **not** change what `currentTime` means. `currentTime` is always a position in the media's own timeline.

Speech marks are also positions in the media's own timeline (ms from audio start).

**Therefore the two are in the same units at every playback rate, and sync is automatic.** The entire speed feature is:

```js
function setRate(r) {
  rate = r;
  elA.playbackRate = r;
  elB.playbackRate = r;   // keep the pre-buffered element in step
}
```

That is the whole thing. There is no compensation to apply. **If you ever find yourself writing `* rate` in the highlight path, that is the bug.**

Supporting facts (all verified in `tts-web-research-2026.md`):

- `preservesPitch` **defaults to `true`** and is Baseline since Dec 2023. The spec *requires* pitch correction. No chipmunk. We still set it explicitly for clarity.
- `AudioBufferSourceNode.playbackRate` **resamples** (changes pitch). Wrong tool. Do not use Web Audio for playback.
- Drive the loop with **`requestAnimationFrame`**, not `timeupdate` (spec floor is 4 Hz, explicitly non-deterministic — far too coarse for words) and not `TextTrack` `cuechange` (spec warns short cues get **skipped**; a word cue at 3× is ~65 ms).
- **Binary-search the word each frame** rather than incrementing a cursor. It's stateless, so it self-heals across seeks, stalls, hidden tabs, and rate changes — none of which need special handling.

## 5. The offset problem, solved

Speech marks give `start`/`end` character offsets into the string we sent. But **into which index space?** The prior research contradicts itself — `reference-listeninterrupt-architecture.md:164` says characters, `:392` says UTF-8 bytes — and never resolved it.

Measured against the user's real `sample_docs/md.md`:

| Index space | Length |
|---|---|
| UTF-8 bytes | 137,564 |
| JS UTF-16 code units (what `slice()` uses) | 135,874 |
| Unicode code points | 135,734 |

That document contains 201 `—`, 178 `→`, 119 `🎨` (surrogate pair), box-drawing glyphs, variation selectors, and flag emoji. **Guessing wrong drifts the highlight ~1,830 characters by the end of the document**, and gets worse as you read.

We cannot dodge this by matching on the word's `value` text, because of failure #6 — TTS normalizes, so `value` may be "five dollars" where the source says "$5".

**So we detect the index space empirically, once, on the first chunk:**

```js
// Take the last word mark of chunk 0. Its `end` should equal the chunk's
// length — in whichever index space the API is using.
function detectIndexSpace(text, marks) {
  const lastEnd = marks[marks.length - 1].end;
  const candidates = {
    utf16:     text.length,
    codepoint: [...text].length,
    utf8:      new TextEncoder().encode(text).length,
  };
  // Pick the closest match (allow small slack for trailing punctuation).
  let best = null, bestDelta = Infinity;
  for (const [space, len] of Object.entries(candidates)) {
    const d = Math.abs(len - lastEnd);
    if (d < bestDelta) { bestDelta = d; best = space; }
  }
  // Corroborate: slicing the FIRST word in this space must yield a
  // non-empty token with no surrounding whitespace.
  if (!plausibleToken(sliceIn(best, text, marks[0].start, marks[0].end))) {
    console.warn("[tts] index-space probe inconclusive, falling back to utf16");
    return "utf16";
  }
  return best;
}
```

Then every mark is converted to UTF-16 offsets once, at ingest, and the rest of the system only ever deals in UTF-16. Log the detected space so it's visible when debugging.

## 6. Chunking & playback

**The 2,000-character input cap on `/v1/audio/speech` makes chunking mandatory**, not an optimization.

- Group sentences with **`Intl.Segmenter`** (`granularity: 'sentence'`, Baseline 2024, gives a char `index`) into **~1,200–1,800-char** chunks.
- **Never split across a paragraph boundary** — a chunk seam is an audible ~30 ms gap in MP3, and putting seams at paragraph/sentence breaks makes them read as natural pauses.
- **Skip non-prose blocks**: `<pre>` (code) and `<figure>` (images). Reading code aloud is noise. Tables are debatable — skip in v1.
- **Ping-pong two `<audio>` elements**, both "unlocked" by a silent play during the initial user gesture (Safari's autoplay policy needs this).
- **One-chunk lookahead.** Synthesize chunk N+1 while N plays. Free-tier allows only 1 concurrent request, so don't fan out. Worst-case wasted spend if the user stops immediately ≈ $0.04.
- **Cache** by `sha256(text|voice|model|format)` in memory for the session. Do **not** reach for IndexedDB — `CLAUDE.md` explicitly says not to introduce it without discussion, and MP3 for a whole book would blow the localStorage budget. Session-scoped memory cache means re-reading a chunk (rewind) is free, which is the case that matters.

## 7. Highlighting

Two registries, zero DOM mutation:

```js
const wordHL = new Highlight();
const sentHL = new Highlight();
CSS.highlights.set("tts-word", wordHL);
CSS.highlights.set("tts-sentence", sentHL);
```

```css
::highlight(tts-sentence) { background: color-mix(in srgb, var(--accent) 14%, transparent); }
::highlight(tts-word)     { background: color-mix(in srgb, var(--accent) 40%, transparent);
                            color: var(--ink); }
```

`::highlight()` supports only a limited property set (color, background-color, text-decoration, text-shadow) — which is all we need. It paints *over* element backgrounds, so it composes correctly on top of existing `<mark class="hl-yellow">` highlights.

The tick:

```js
function tick() {
  if (!playing) return;
  const tMs = currentEl.currentTime * 1000;          // media timebase. No rate math.
  const wi = bsearch(chunk.words, tMs);
  const si = bsearch(chunk.sentences, tMs);
  if (wi !== lastWi || si !== lastSi) {
    wordHL.clear(); sentHL.clear();
    if (si >= 0) sentHL.add(rangeFor(chunk.sentences[si]));
    if (wi >= 0) wordHL.add(rangeFor(chunk.words[wi]));
    lastWi = wi; lastSi = si;
    maybeScroll(wi);
  }
  requestAnimationFrame(tick);
}
```

`rangeFor(mark)` converts `chunk.docStart + mark.cs/ce` through `positionMap` (binary search) into a DOM `Range`.

**Fallback:** if `!("highlights" in CSS)` — feature-detect and degrade to sentence-only highlighting via a single transient `<mark>` on the block, or disable highlighting and still read aloud. Never crash.

## 8. Pause-to-comment

On pause, find the block element containing the current word and route it into the existing annotate flow:

```js
function onPause() {
  const r = rangeFor(chunk.words[lastWi]);
  let el = r.startContainer;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  const block = el.closest("#article > *");
  if (!block) return;
  const blockRange = document.createRange();
  blockRange.selectNodeContents(block);
  Highlights.createHighlightAndCommentFromRange(blockRange, "yellow");
}
```

**Required refactor:** `js/highlights.js` currently drives `createHighlight()` off a module-level `pendingRange` set by the mouseup handler. Extract the body into `createHighlightFromRange(range, color)` and have both the mouseup path and this path call it. Small, and it makes the module cleaner regardless.

Make this behavior a setting (`ttsCommentOnPause`, default **on**) — pausing to answer the door shouldn't necessarily create a highlight.

## 9. Files & module surface

| File | Change |
|---|---|
| `js/tts.js` | **New.** Namespace `TTS`. The whole engine. |
| `js/highlights.js` | Extract `createHighlightFromRange(range, color)`; keep existing callers working. |
| `js/reader.js` | Call `TTS.attach(docId)` after render, `TTS.detach()` in `hide()`. |
| `js/settings.js` | Speechify key field (mirror the Groq one); voice picker; default rate; comment-on-pause toggle. |
| `index.html` / `index-electron.html` | Player bar markup; settings fields; `<script src="js/tts.js">` before `app.js`. |
| `css/highlights.css` | `::highlight(tts-*)` rules. |
| `css/components.css` | Player bar styling. |

```js
TTS.attach(docId)        // tokenize + chunk, don't synthesize yet
TTS.detach()             // stop, release audio, clear highlights
TTS.play() / .pause() / .toggle()
TTS.setRate(r)           // the ONLY place playbackRate is written
TTS.seekToChar(offset)   // click-a-word-to-start-here
TTS.nextSentence() / .prevSentence()
TTS.hasKey() / .setKey(k) / .clearKey()
```

**Player bar** (fixed bottom, reader mode only): ⏮ ⏯ ⏭ · speed chip · progress · voice · ✕.
**Keyboard**: `Space` play/pause, `←`/`→` sentence, `[`/`]` speed down/up, `Esc` stop.
Space must not fire while focus is in the comment textarea.

## 10. Phased build

### Phase 0 — Live API spike (do this FIRST, ~30 min)

**No live Speechify call has ever been made in any of this research.** Everything about the response is a doc-reading. Before writing the engine, run one real call with the user's key and record:

1. Exact response JSON (field names — `audio_data` vs `audio`, `speech_marks` shape, `type` values).
2. **Which index space** the offsets use — run the probe against a string containing `—`, `→`, `🎨`.
3. Latency (TTFB and total) from the user's actual location for a ~1,500-char chunk.
4. That `simba-3.2` + `geffen_32` is accepted, and what `/v1/voices` actually returns.
5. Whether marks are deterministic across two identical requests (affects cacheability).

Deliverable: a scratch HTML page + findings appended to `techDocs/`. **If the response shape differs from the docs, the plan changes — so this gates everything.**

### Phase 1 — Core reader (the risky half)
Tokenizer + positionMap · chunker · single-chunk synthesis · one `<audio>` · rAF loop · two-tier highlight. **Success test: a 3-paragraph document reads with correctly-synced word highlighting at 1×.**

### Phase 2 — Speed & navigation
`setRate` · sentence skip · click-a-word-to-jump · auto-scroll. **Success test: change speed mid-sentence at 0.75/1/1.5/2/3× — highlight stays locked, voice stays natural.** This is the test the old implementation failed.

### Phase 3 — Continuity
Ping-pong elements · one-chunk lookahead · cache · seamless chunk seams. **Success test: a 10k-word document reads start to finish without a gap or desync.**

### Phase 4 — The comment loop & polish
Pause→comment · player bar · settings (key, voice, rate, toggle) · keyboard shortcuts · error states · feature-detect fallback.

## 11. Cost & risk

**Cost.** $6–10 per 1M characters. A 10k-word document ≈ 55k chars ≈ **$0.55**. Rewinding and speed changes are **free** — billed per character *sent*, and cached audio is never re-sent. Lookahead waste is bounded at ~$0.04.

| Risk | Likelihood | Mitigation |
|---|---|---|
| Response shape differs from docs | Medium | Phase 0 gates everything |
| Offsets are UTF-8 bytes | ~50% | Auto-detect probe (§5); normalize at ingest |
| Latency too high to feel instant | Medium | 831 ms was measured *from India*; measure locally in Phase 0. Prefetch hides it after chunk 1. |
| Safari `preservesPitch` degrades at 3× | Low-Med | Test on-device; cap the speed chip if it sounds bad |
| Chunk seams audible | Low | Seams land on sentence breaks where a pause belongs |
| Only 8 of 949 voices support simba-3.2 | Confirmed | Hardcode the known-good list; verify via `/v1/voices` |

## 12. Open questions — only a live call answers these

1. Exact `speech_marks` field names and `type` discriminator values.
2. **The index space** (the single highest-impact unknown).
3. Real latency from the user's location.
4. Whether `/v1/audio/speech` returns marks by default or needs a flag.
5. Mark determinism across identical requests.
6. Behaviour on text containing emoji — are they skipped, or do they produce zero-duration marks?
7. Whether Electron's renderer needs anything different from the browser (probably not — same Chromium, and CORS already passes).

---

## Appendix — source documents in `techDocs/`

| File | What it is |
|---|---|
| `superwhisper-tts-postmortem.md` | Forensic post-mortem of the failed attempt, with file:line |
| `speechify-simba-findings.md` | Everything mined from the user's own rabbitwhole research |
| `tts-web-research-2026.md` | Web research: provider comparison, spec citations, chunking |
| `api-speechify-raw.md` | Raw Speechify API reference |
| `api-azure-speech-raw.md` | Fallback provider reference |
| `folio-integration-constraints.md` | Folio-specific constraints + live CORS/offset findings |
| `reference-listeninterrupt-architecture.md` | Copied from `rabbitwhole/listeninterrupt` |
| `reference-phase-1-reader.md` | Copied — the prior reader design |
| `reference-speechify-simba-stack-feasibility.md` | Copied |
| `reference-speechify-streaming-verdict.md` | Copied |

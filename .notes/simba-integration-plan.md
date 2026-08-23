# Simba 3.2 in Folio — integration plan

Written 24 August 2026, after running the live Phase 0 calls the earlier plan
demanded. Numbers here are measured, not quoted; the raw findings are in
[`techDocs/speechify-phase0-measured.md`](../techDocs/speechify-phase0-measured.md).

## TL;DR

- **Nothing about how Folio reads has to change.** `js/tts.js` already has a
  provider interface (`js/tts.js:357`) — `available / voices / defaultVoice /
  speak(text, opts) → {stop}`. Simba is a second object implementing it. Space
  to play, hold-Space to dictate, arrow-key sentence nav, pause-to-comment, the
  video external clock, the ETA — all sit *above* that seam and never learn a
  new provider exists.
- **Start-to-audio: ~1.3 s** with a small first chunk, **~0.85 s** if we add
  progressive playback later. Today's Web Speech is instant, so this is the one
  place the experience gets *worse*, and it is worth naming honestly.
- **Buffering is not a risk.** Audio arrives **6.6× faster than it plays**;
  2.2× headroom even at 3×. The only exposure is the first few seconds, and the
  fix is to request chunk 1 and chunk 2 concurrently at t=0.
- **Speed gets better, not worse.** Today `setRate` **stops and restarts the
  chunk** (`js/tts.js:650`) because Web Speech cannot change rate mid-utterance.
  With an `<audio>` element it is one assignment, mid-word, no gap, no cost, no
  re-request. Pitch correction is required by spec.
- **One measured trap: offsets are Unicode CODE POINTS**, not UTF-16. Getting
  this wrong drifts the highlight ~1,830 characters through the user's own
  `sample_docs/md.md`.
- **Cost ≈ $0.33–0.55 per 10,000-word document**, re-reads free.

## 1. Why the functionality does not change

This is the load-bearing part of the request, so it gets stated precisely.

`js/tts.js:357` defines `WebSpeechProvider` as a plain object:

```js
{ id, label, needsKey,
  available(), voices(), defaultVoice(),
  speak(text, opts) → { stop() } }
```

`opts` carries `{ rate, voice, onWord(charIndex, charLength), onEnd(), onError(msg) }`,
and `provider().speak(...)` is called from exactly **one** place —
`js/tts.js:582`, inside `speakChunk`. Everything else in that 1,782-line file
talks to `speakChunk`, not to a synthesiser.

So the whole integration is: **a second object with the same shape.** A
`SimbaProvider` that returns `{stop}` and calls `onWord` with character offsets
is indistinguishable from the system voice to every feature above it —
highlighting, the reading cursor, sentence navigation, dictation, the
pause-to-comment loop, the ETA, and `setExternalClock` for video.

### The one addition, and why it is additive

`setRate` today does this (`js/tts.js:650`):

```js
if (handle) { handle.stop(); handle = null; }
speakChunk(curWord ? curWord.ds : undefined);
```

Stop and restart from the current word. That is the only thing Web Speech
allows. An `<audio>` element can change rate in place.

**Add an optional `handle.setRate(r)`.** `setRate` calls it when present and
falls back to the existing stop-and-restart when absent:

```js
if (handle && handle.setRate) { handle.setRate(r); return; }
if (handle) { handle.stop(); handle = null; }
speakChunk(curWord ? curWord.ds : undefined);
```

Web Speech gets byte-identical behaviour. Simba gets seamless speed. No feature
regresses, which is the requirement.

## 2. The three requirements, answered with numbers

### "I don't want it taking too much time to start reading"

| approach | time to first sound |
|---|---|
| Web Speech (today) | ~instant |
| Simba, 150-char first chunk, accumulate-then-play | **~1.3–2.0 s** |
| Simba, progressive playback via MediaSource | **~0.85 s** |
| Simba via the batch endpoint | **12.5 s — disqualified** |

First audio is ~800 ms **regardless of chunk size** — it is a fixed floor. What
scales is the download of the whole chunk, which is what you wait for if you
play only complete chunks.

**Decision: ship accumulate-then-play with a small first chunk (Phase 1), and
treat MediaSource as a Phase 3 optimisation.** 1.3 s is acceptable; 12.5 s is
not; and MSE is the kind of complexity that should have to earn its place.

**Mitigation worth building in Phase 1:** start synthesising the first chunk the
moment reader mode opens a document, not when Play is pressed. The ~800 ms then
happens while the user is still looking at the page, and Play is instant. Cost
of a wasted first chunk if they never press play: **~$0.002**.

### "I don't want it to buffer"

Measured on a 1,500-char chunk: **6.6× realtime**. At 2× playback, 3.3× headroom;
at 3×, 2.2×. Once running, download always outruns playback.

The exposure is the cold start, and it is arithmetic rather than luck:

- chunk 1 = 150 chars → 9 s of speech, playable at ~2.0 s
- at 3× that is 3 s of wall-clock, so it ends at ~5.0 s
- chunk 2 = 600 chars needs 4.6 s

**So chunk 2 must be requested at t=0, concurrently with chunk 1**, not when
chunk 1 finishes downloading. With that, chunk 2 is ready at 4.6 s against a
5.0 s deadline. Tight at 3×, comfortable at 1–2×.

Rules that follow:
- Two chunks in flight at all times; three when rate ≥ 2×.
- Never let the rate chip jump straight to 3× within the first ~10 s of a cold
  start — clamp, or accept one stall and say so in the bar rather than silently
  freezing.

### "Increasing the speed sounds weird"

Two routes exist and both were measured:

| route | how | cost | ceiling | latency to apply |
|---|---|---|---|---|
| `playbackRate` on `<audio>` | time-stretch in the browser, pitch-corrected | free | none (3×+) | instant |
| SSML `<prosody rate="+100%">` | genuine re-synthesis | free (tags not billed) | **+100% = 2×** | ~850 ms + a new request |

`preservesPitch` defaults to true and pitch correction is required by the HTML
spec, so **there is no chipmunk on either route**. What differs is time-stretch
artefacts at high rates — smearing on consonants, slight warble on long vowels —
and that is a taste judgement.

**This is the one open question I cannot close by measurement.** A listening
test was generated with the real voice: the same sentence synthesised at 1× and
sped up in-browser, against the same sentence synthesised server-side at +50%
and +100%.

Design so the answer can go either way: `SimbaProvider` owns a
`rateStrategy` of `"client"` (default) or `"resynth"`. Nothing outside the
provider knows which is in use.

## 3. User stories

**Reading a long article.** Opens a document in reader mode; the first chunk is
already synthesising. Presses Space; audio starts immediately. The current
sentence carries a soft tint, the current word a stronger one, and the page
scrolls to keep the word in view. Reaches the end of a 10,000-word piece without
a gap, having spent about 40 cents.

**Speeding up mid-paragraph.** Two paragraphs into dense material, taps `]` to
go from 1× to 1.5×. **The voice changes pace mid-word without restarting the
sentence** — the thing that is impossible today. Highlighting stays locked
because speech-mark milliseconds and `currentTime` are the same units at every
rate.

**Reacting to a line.** Hears something worth noting, taps Option. Audio pauses,
the paragraph is highlighted, the comment box opens on it, they speak, ⌘↵,
Space to resume. **Unchanged from today** — that loop lives above the provider
seam.

**Re-reading yesterday's page.** Opens a document read before. Audio starts from
cache with no request and no charge, and the highlighting is identical because
the marks were cached with the audio rather than re-requested.

**Working offline, or out of credit.** Presses Play with no network. Gets a
clear line — "Simba unavailable, using the system voice" — and reading starts on
Web Speech. **The document always reads.**

**Listening to a video's transcript.** The external clock (`TTS.setExternalClock`)
still drives the video; Simba is not involved. **Unchanged.**

## 4. Edge cases, and what each one does

Grouped by what breaks. Every one of these needs a defined behaviour before
Phase 1 is done, because "undefined" here means silence with no explanation.

### Text and content

| case | behaviour |
|---|---|
| **Non-English document** | Only 8 voices, all `en-US`/`en-GB`. Detect and say so; offer Web Speech, which has other languages. Do not send it and get English phonetics. |
| **Code blocks** | Skip `<pre>`. Reading punctuation aloud is noise. |
| **Images / figures** | Skip. Read the caption if there is one. |
| **Tables** | Skip in v1. Say so in the bar rather than silently jumping. |
| **Emoji** | Measured: skipped, no marks emitted, no zero-duration entries. Nothing to do — but the highlight simply never lands on one. |
| **Astral characters generally** | **Convert code-point offsets to UTF-16 at ingest.** The measured failure is a one-character drift per preceding emoji, compounding to ~1,830 chars in the user's own sample. |
| **A single 5,000-char paragraph** | Chunker must split mid-paragraph rather than exceed the cap. Prefer a sentence boundary; fall back to a clause. |
| **Empty or whitespace-only document** | Play is disabled with a reason, not a silent no-op. |
| **A transcript document** (`data.t` blocks) | Video documents already use the external clock. Simba must not engage there. |

### Network and service

| case | behaviour |
|---|---|
| **No API key** | Web Speech, silently — that is today's behaviour and the default. Simba is opt-in via Settings. |
| **Bad key (401)** | Say "Speechify rejected the key", fall back, do **not** retry — it will never clear. |
| **Out of credit (402/429-billing)** | Show Speechify's own message. Fall back. Do not retry. This exact distinction was got wrong once with Gemini: an empty account reported as "rate limit, try later" sends you to wait for something that never clears. |
| **Rate limited (429)** | Back off and retry the current chunk; keep playing what is already buffered. |
| **5xx / model busy** | Retry with a short ladder, as `js/gemini.js` already does. Reuse that shape. |
| **Network drops mid-stream** | Finish the audio already downloaded, then surface the failure at that point rather than at the top of the page. |
| **Network drops before first audio** | Fall back to Web Speech for that chunk and carry on; do not strand the reader. |
| **Request slower than playback** (the buffering case) | Pause at the chunk seam with a visible "buffering" state. Never a silent freeze. |
| **Tab backgrounded** | `requestAnimationFrame` stops in hidden tabs. Audio keeps playing, highlighting freezes, then jumps on return. Binary-searching the mark each frame (rather than incrementing a cursor) makes this self-heal with no special case. |
| **Device sleep / resume** | Same self-healing path. |

### Interaction

| case | behaviour |
|---|---|
| **Rate changed while a chunk is mid-download** | Apply to the playing element now; the pending chunk inherits it on start. |
| **Rate changed during the very first chunk at 3×** | Clamp or accept a stall — see §2. Do not pretend. |
| **Seek by clicking a word** | Find the chunk containing that offset; if cached, seek within it; if not, synthesise it and drop the queue behind it. |
| **Pause, then edit the document, then resume** | Offsets are now stale. Invalidate the cache for that document on content change — the `time` stamp already exists (`js/editor.js` `storageTime`) and is exactly the right key. |
| **Dictating while reading** | `beginDictation` already pauses the clock (`js/tts.js:867`). Unchanged. |
| **Two tabs reading the same document** | Both synthesise; both pay. Acceptable, but log it. A cross-tab lease exists for transcription and could be reused if it becomes annoying. |
| **Switching provider mid-read** | Stop, keep the character position, resume with the new provider from that offset. |
| **Voice changed mid-document** | Invalidate cached audio for that document (marks belong to a voice); keep the position. |

### Cost and correctness

| case | behaviour |
|---|---|
| **Prefetched chunk never played** | Bounded waste, ~$0.002 per chunk. Cap lookahead at 2. |
| **User scrubs rapidly through a long document** | Debounce synthesis on seek — do not fire a request per scrub tick. |
| **Cached audio re-requested** | Must not happen. Marks are **not deterministic** — measured. A re-request returns different audio *and* different timings, so audio and marks must be cached and evicted as one unit. |
| **localStorage full** | Audio is far too big for localStorage. Cache in memory for the session; do not attempt to persist without a separate discussion — the project rule is that localStorage is the only store, and audio breaks that assumption. |

## 5. Phases

**Phase 0 — done.** Live calls made; findings in `techDocs/speechify-phase0-measured.md`.
The two that change the design: batch is 12.5 s (use streaming), and offsets are
code points (not UTF-16).

**Phase 1 — the provider.** `js/speechify.js` implementing the existing provider
shape: key in localStorage, streaming request, accumulate a chunk, play through
one `<audio>`, rAF loop reading `currentTime`, binary-search the marks, call
`onWord` with UTF-16-converted offsets. Settings entry for key and voice.
*Success test: a three-paragraph document reads with correct word highlighting
at 1×, and the identical document still reads on Web Speech when the key is
removed.*

**Phase 2 — speed and continuity.** `handle.setRate`; two chunks in flight;
concurrent first-two requests; cache keyed by (text, voice, model) holding audio
and marks together. *Success test: change speed mid-sentence across 0.75/1/1.5/2/3× —
highlight stays locked, no restart, no gap. A 10,000-word document reads end to
end without a stall.*

**Phase 3 — fast start and fallback polish.** Pre-synthesise chunk 1 on document
open; MediaSource progressive playback if 1.3 s still feels slow; the full error
matrix from §4 with a visible state for each. *Success test: every row in §4 has
an observed behaviour, not an assumed one.*

**Phase 4 — the rest.** Voice picker across the 8 voices, per-document cost
readout from `billable_characters_count`, and whatever the listening test says
about `rateStrategy`.

## 6. Open decisions

1. **Client-side speed or server-side re-synthesis above some rate?** Needs the
   listening test. Everything else is designed so this can flip late.
2. **Which of the 8 voices is the default?** Geffen was used throughout Phase 0
   with no complaint, but that was not a comparison. Worth generating one
   sentence in all 8 and picking.
3. **Does Simba become the default when a key is present, or stay opt-in?**
   Recommendation: opt-in for the first week, then default — the fallback path
   only gets exercised if it is not the only path.
4. **Is 1.3 s to start acceptable**, or does Phase 3's MediaSource work move
   into Phase 1?

## 7. Security

The key must live in `localStorage` beside `folio_groq_key` and
`folio_gemini_key`, entered through Settings, and **must never be written into a
file in this repo** — it is public, and `sk_…` is exactly what secret scanners
match. Every commit in this project runs a scan for `AIzaSy…` / `gsk_…`; that
pattern list needs `sk_[A-Za-z0-9]{30,}` added.

**The key used for Phase 0 was pasted into a chat transcript and should be
rotated** before this ships.

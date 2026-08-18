# Superwhisper-clone TTS — Post-Mortem
_What was built, why it failed, and the anti-patterns to avoid._

> Source repo: `/Users/rishabhchopra/Documents/GitHub/superwhisper-clone`
> Every claim below cites `file:line`. Where I could not find code for something, I say so explicitly.

## TL;DR

- **There were two unrelated TTS systems, not one.** (A) an Electron app on the **UnrealSpeech** cloud API with a **Web Speech API** fallback, which never had word highlighting at all; and (B) a later **Kokoro-82M ONNX** (local, WebGPU) "read-aloud" lineage that went through **six rewrites in four days** chasing speed and highlight-sync bugs.
- **Speed failed three different ways, each in its own subsystem** — a `setSpeed()` that is a documented no-op stub (`src/services/unrealSpeechTTS.js:786`), a Kokoro `speed` model input that is silently ignored by the model (author's own commit `6d3c932`: _"byte-identical audio at any speed value"_), and a Web Audio `AudioBufferSourceNode.playbackRate` that **resamples** and therefore pitch-shifts (`content.js:110` @ `0ea459d`). Three symptoms, three separate causes — that's why it never felt fixed.
- **Word sync failed two ways, both structural.** A **wall-clock dead-reckoning estimate of the media clock, computed in a different process from the audio element** (`reader-extension/content.js:69`), and a **word-index space mismatch** where TTS-spoken word counts were used to index into a DOM word array, so the error **compounded monotonically** across the document (`reader-extension/offscreen.js:139` → `content.js:72`).
- **Yes, it really did synthesize the whole document in one blocking call** — in the Electron path. `src/main.js:2330-2385` makes one `await` for the entire text; `src/services/unrealSpeechTTS.js:351` does `await response.arrayBuffer()` even on the endpoint literally named `/stream`. The author's own budgeting math (`src/main.js:3063-3069`) assumes **1.35s of synthesis per 1,000 characters** and just widens the timeout instead of chunking.
- **Verdict: the final `read-aloud/index.html` is architecturally correct and worth reading before you build anything.** It puts audio and highlighter in one context and drives the highlight from `audio.currentTime`. Everything before it failed for reasons that were *forced by architecture*, not by tuning. The single most expensive mistake in the whole history was **separating the audio clock from the highlighter across a process boundary.**

---

## What was built

### System A — the Electron app (UnrealSpeech + Web Speech). No highlighting, ever.

**Capture.** `src/menuBar.js:445-474` fires an AppleScript that sends `Cmd+C`, reads the clipboard, and restores it. This yields *text only* — no screen coordinates, no character offsets. In-place highlighting is therefore structurally impossible on this path, as the author's own notes state at `.notes/tts-rethink.md:39`.

**Provider selection.** `src/services/textToSpeechService.js:148-179` picks between `unrealspeech` and `webspeech`. Note line 167: **text longer than 3,000 characters silently falls back to the OS Web Speech voice** — a different voice *and* a different speed contract, chosen invisibly by document length.

**Synthesis.** `src/services/unrealSpeechTTS.js:211-231` (`selectEndpoint`) routes the **whole text** to one of `/stream` (≤1,000 chars), `/speech` (≤3,000), or `/synthesisTasks` (≤500,000). There is no chunking anywhere in this path. For a real document you land on `/synthesisTasks`, which is an **async batch job with a polling loop** (`src/services/unrealSpeechTTS.js:1072`).

**Playback.** `src/services/unrealSpeechTTS.js:608-660` decodes MP3 via `fluent-ffmpeg` (line 16) and pipes raw PCM into `node-speaker` (line 13) **in the Electron main process**. This choice is the root of every broken transport control — a PCM pipe has no `currentTime`, no `playbackRate`, and no seek.

**UI.** `src/ttsControls.html` is a 300×65 floating pill: rewind/play/stop/forward/speed/time/progress (lines 300-335). There is **no text display and no highlight surface of any kind** — the widest element is a 60px truncated label (`src/ttsControls.html:188-198`, truncated to 8 characters at `src/ttsControlsRenderer.js:586-589`).

**The renderer has its own second audio engine.** `src/ttsControlsRenderer.js:15` creates `new Audio()` and `loadAudioData()` (line 311) blobs the whole buffer into it. So the app has *two* playback paths — the Node speaker and the renderer `<audio>` — plus three independent progress clocks (detailed below).

### System B — the "read-aloud" lineage (local Kokoro-82M). Six rewrites in four days.

Provider throughout: **`onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`** via **HeadTTS**, voice `af_bella`, `en-us`, WebGPU `fp32` with WASM `q4` fallback (`read-aloud/index.html:173-185`; identical config at `reader-extension/offscreen.js:30-44`). The model variant is the *timestamped* one, so **real per-word timings were available** as `d.wtimes` / `d.words`.

| # | Commit | Date | What changed | What broke |
|---|---|---|---|---|
| 1 | `9d6f88a` | 07-10 | Chrome extension, in-page `<audio>` + `playbackRate`, rAF on `currentTime` | No audio at all on strict-CSP sites (`media-src 'self'`) |
| 2 | `0ea459d` | 07-10 | Switched to Web Audio `AudioBufferSourceNode` to beat CSP | **Chipmunk.** Resampling pitch-shifts |
| 3 | `94ac407` | 07-10 | Use Kokoro's own `speed` model input instead | **Model ignores it.** Also: only applied to the *next* sentence |
| 4 | `f0accb2` | 07-11 | "log applied speed in offscreen console" | The debugging commit that proved #3 was a no-op |
| 5 | `6d3c932` | 07-11 | Move playback to the offscreen document to get `<audio>` back | Pitch fixed — **but highlighting died** (rAF doesn't fire in an unpainted offscreen doc) |
| 6 | `070124c` | 07-11 | Send a wall-clock-anchored "schedule"; page interpolates | **Introduced the desync.** |
| 7 | `9504ef2`, `4a99e0d` | 07-13 | "fix highlight drift", "fix highlight lag" | Chasing the compounding word-index bug |
| 8 | `d5293fd` | 07-13 | Abandon the extension; standalone `read-aloud/` page | **Correct at last** — one context, one clock |

Two more copies of the same engine also exist: `src/stage/stage.js` (an Electron "Stage" window) and `tts-reader/` (a dev harness). Both repeat the word-index bug.

---

## Root cause #1 — Speed control

There is no single speed bug. There are **four**, and the user hit different ones depending on which code path ran.

### 1a. The Electron `setSpeed()` is a stub that does nothing

```js
// src/services/unrealSpeechTTS.js:786-796
setSpeed(speed) {
    console.log('🔊 Setting playback speed to:', speed);
    this.playbackSpeed = Math.max(0.5, Math.min(2.0, speed));
    if (this.isPlaying && this.audioBuffer) {
        // In a full implementation, we'd use ffmpeg to adjust playback speed
        console.log('Speed adjustment requires audio reprocessing - stored for next playback');
    }
}
```

It stores a number and logs a sentence. **That is the entire implementation.** This is the direct cause of _"sometimes it used to not even manipulate it at all."_ The same file has matching stubs: `seek()` **restarts from the beginning** (`:769-780`, _"In a full implementation, we'd extract audio from the seek position"_) and `resume()` **also restarts from the beginning** (`:755-762`, _"For basic resume, we'll restart from the beginning"_).

The reason these are stubs is the playback engine choice: piping PCM into `node-speaker` (`:608-660`) gives you a fire-and-forget byte stream with no transport surface at all.

### 1b. Kokoro's `speed` input is silently ignored by the model

Attempt #3 (`94ac407`) routed speed into the model itself. Commit `6d3c932`'s body records the result verbatim:

> [!WARNING]
> **CORRECTION (2026-08-18): this claim is false.** Later investigation ran the
> Kokoro ONNX model directly at speed 0.5 / 1.0 / 1.5 / 2.0 and got four
> different SHA-256 hashes, with output durations scaling exactly
> inverse-linearly. The `speed` input works. The commit message below recorded a
> real symptom but misattributed it — the bug was in the caller, not the model.
> Everything else in this section still stands. See `tts-local-2026.md`.

> **"Kokoro's model ignores its speed input (byte-identical audio at any speed value)"**

and the code comment left behind says the same: `reader-extension/offscreen.js:98` — `headtts.synthesize({ input: text }); // speed is a model no-op; handled at playback`.

Worse, even if it *had* worked, commit `94ac407`'s own body admits: _"A speed change applies to the next synthesized sentence."_ With `BUFFER_AHEAD = 2` (`reader-extension/offscreen.js:133`), pressing "+" would do nothing for **three sentences**. That is a third, independent flavour of _"I couldn't control the speed."_

### 1c. Web Audio `AudioBufferSourceNode.playbackRate` — the chipmunk

```js
// reader-extension/content.js:108-110 @ commit 0ea459d
source = audioCtx.createBufferSource();
source.buffer = chunk.buffer;
source.playbackRate.value = rate;
```

`AudioBufferSourceNode.playbackRate` is a **resampling** rate, not a time-stretch. It replays the same samples faster, so duration *and* pitch both change — a tape-speed effect. At 1.5× the voice rises about 7 semitones. This was knowingly shipped; the file header at `content.js:14-15` of that revision says:

> _"Tradeoff: playbackRate resamples, so speeding up shifts pitch (no built-in pitch preservation in Web Audio)."_

**This is the precise cause of _"it used to artificially manipulate it and it used to sound weird."_** The contrast matters for the rebuild: `HTMLMediaElement.playbackRate` (an `<audio>`/`<video>` element) performs a real WSOLA-style time-stretch and `preservesPitch` defaults to `true` — it is *not* the same API and does not have this problem.

### 1d. Speed units are interpreted on three incompatible scales in one file

UnrealSpeech's `Speed` parameter is **−1.0 to 1.0** (0 = normal), as documented at `src/services/unrealSpeechTTS.js:1249`. But:

- `:313`, `:404`, `:1277` send `Speed: options.speed || ttsSettings.speed || 0` — the **raw multiplier**, unconverted. A UI value of `1.25` is sent as `Speed: 1.25`, which is out of range.
- `:908`, `:1014` send `Speed: options.speed ? (options.speed - 1.0).toString() : '0'` — **converted correctly**. Same variable, same file, different scale.
- `:1248-1254` `convertSpeedToRate()` assumes the −1..1 scale and is fed the multiplier anyway at `:465`. So `1.5×` becomes Web Speech `rate = 2.5` and `2.0×` becomes `rate = 3.0`.

### 1e. Web Speech API: rate is immutable after speaking starts

`src/renderer.js:516` sets `utterance.rate = rate || 1.0` at construction. `SpeechSynthesisUtterance.rate` **cannot be changed once `speak()` has begun** — you must cancel and re-synthesize. On this path a mid-playback speed change is architecturally impossible, and it receives the mis-scaled 2.5–3.0 values from 1d, which macOS voices clamp or garble.

### 1f. Bonus: the speed UI itself was broken in the Electron pill

- `src/ttsControlsRenderer.js:522-533` — one button, six discrete steps `[0.5, 0.8, 1.0, 1.25, 1.5, 2.0]`, wrapping **forward only**. Going 1.25 → 1.0 takes five presses.
- `src/ttsControlsRenderer.js:357-359` — the API-side speed is explicitly discarded: `// Note: data.speed is the generation speed ... const playbackSpeed = this.speed; // Default is 1.25x`.
- `src/ttsControlsRenderer.js:634` — `this.currentSpeedIndex = this.speedOptions.indexOf(this.speed)` returns **−1** for any saved speed not in the array; the next `cycleSpeed()` then computes `(-1 + 1) % 6 = 0` and **jumps to 0.5×**.
- `src/ttsControlsRenderer.js:100-104` — the `ratechange` handler writes `this.speed` but never updates `currentSpeedIndex`, so the two desynchronize whenever the media load algorithm resets `playbackRate` to `defaultPlaybackRate`.
- Range limits disagree across the codebase: 0.5–2.0 (`textToSpeechService.js:246`), 0.5–3.0 (`read-aloud/index.html:166`), 0.5–4.0 (`src/stage/stage.js:327`).

---

## Root cause #2 — Word highlight desync

First, the scope correction: **the Electron app never had word highlighting at all.** `src/ttsControls.html` has no text surface. And the timestamps were *paid for and thrown away* — `src/services/unrealSpeechTTS.js:910` requests `TimestampType: 'word'`, `:985` fetches them into the return value, and then `src/services/textToSpeechService.js:620-624` returns only `{ buffer, duration, provider }`, **dropping `timestamps` on the floor**. `src/main.js:2403-2408` never forwards them. The `speakWithTimestamps()` WebSocket path with `onWordCallback` (`:1262`) is reachable only via `options.realTimeTimestamps`, which nothing in the repo ever sets — **dead code**.

So the desync the user experienced was in System B. It had two independent causes, both fatal.

### Fault A — a wall-clock estimate of the media clock, computed in another process

The confession is in the code comment at `reader-extension/offscreen.js:172-176`:

> _"The offscreen document is never painted, so requestAnimationFrame does NOT fire here — that's why word highlighting stopped. Instead of ticking, hand the PAGE a time-anchored schedule for the current chunk (word timings + a **wall-clock anchor** + rate); the visible content script runs its own rAF and **interpolates**."_

Producer side:
```js
// reader-extension/offscreen.js:181
post("ra-sched", { wordOffset: c.wordOffset, wtimes: c.wtimes,
                   t: Date.now(), pos: S.audio.currentTime, rate: S.rate });
```
Consumer side:
```js
// reader-extension/content.js:69
const pos = sched.pos + (Date.now() - sched.t) / 1000 * sched.rate; // seconds into the chunk
```

**This is the bug.** After the initial anchor, `audio.currentTime` is never read again — the highlight position is *dead-reckoned from the system wall clock*. Why it drifts, and why it drifts **worse the faster you go**:

1. **IPC latency is uncompensated and rate-multiplied.** `sched.t` is stamped in the offscreen document, then the message hops offscreen → background router → content script. The page treats a 5–50ms-old timestamp as "now". At `rate = 3.0` a 50ms hop is instantly **150ms of media time** — roughly one whole word of error at every single re-anchor.
2. **`rate` is the *requested* rate, not the *achieved* one.** The browser's time-stretcher does not deliver exactly 3.0×. Every fractional discrepancy integrates linearly over the chunk.
3. **`Date.now()` is the non-monotonic wall clock.** It is subject to NTP correction and, critically, it **does not stop when the audio stalls** on a decode or buffer underrun. `performance.now()` would at least have been monotonic; neither is the media clock.
4. **Re-anchoring is rare.** It happens only on chunk start (`offscreen.js:169`), resume (`:189`), and rate change (`:193`). Within a sentence the estimate free-runs with zero correction — which is exactly what commit `4a99e0d` ("fix highlight lag") was chasing.

**Contrast with what was correct.** The very first version, `9d6f88a`, and the final `read-aloud/index.html:311-317` both do the right thing:
```js
const ms = currentAudio.currentTime * 1000;   // the media's OWN timebase
let i = chunk.wtimes.length - 1;
while (i > 0 && chunk.wtimes[i] > ms) i--;
highlighter.setActiveWord(activeDomIndex(chunk, i));
```
`currentTime` is expressed in the media timebase and is **immune to `playbackRate` by definition**, so this needs no rate term at all. The `wtimes` from Kokoro are generated at `speed: 1.0` (`read-aloud/index.html:192`), which is the same timebase — so the comparison is valid at any playback rate, for free. The offscreen architecture *forced* the estimate by putting the clock out of reach.

### Fault B — TTS word indices used to address a DOM word array

The two word lists are built independently and then conflated:

```js
// reader-extension/content.js:112  — DOM word space, one entry per /\S+/ on screen
wordRanges.push(wr); parts.push(m[0]);

// reader-extension/offscreen.js:139 — TTS word space, advanced by what Kokoro SPOKE
for (const p of parts) { S.chunks.push({ ...p, wordOffset: wordCursor }); wordCursor += p.words.length; }

// reader-extension/content.js:72   — TTS index used to subscript the DOM array
setActiveWord(sched.wordOffset + k);
```

These spaces are not the same. Kokoro's phonemizer expands `"Dr."` → *doctor*, `"$5"` → *five dollars*, `"1990"` → *nineteen ninety*, drops standalone punctuation tokens, and can split hyphenates. **Every single mismatch permanently shifts `wordCursor`**, and because `wordCursor` is initialized once for the whole document (`offscreen.js:131`) and only ever accumulates, **the error compounds monotonically**: perfect on sentence one, a full sentence behind by the end. No amount of timing precision can fix an index that is simply pointing at the wrong word.

The identical bug is present in `src/stage/stage.js:227` (`localWordBase += unit.words.length`, then `setActiveWord(wordBase + i)` at `:237`) and in the original `9d6f88a` extension (`domCursor += (c.words || []).length`). `src/stage/stage.js:153-160` is arguably worse — it derives `domOffsets` by counting `\S+` in the **raw source text** while the highlighter indexes the **rendered DOM**, a *third* word space, so the anchors can be wrong from word one.

**How the final version fixed it** (`read-aloud/index.html:238-248`): `buildSentences()` derives sentences *from the highlighter's own word array*, so a chunk's `domOffset` **is** a true DOM index by construction. The code comment at `:233-237` explains it well. This is the right idea and worth stealing.

---

## Other problems found

**Three progress clocks fighting over one progress bar.** In the Electron app the same field is written by:
1. `src/ttsControlsRenderer.js:88-92` — the `timeupdate` event, `this.currentTime = this.audioElement.currentTime`. **Correct.**
2. `src/ttsControlsRenderer.js:591-601` — a 100ms `setInterval` doing `this.currentTime += 0.1`. **A wall clock that ignores `playbackRate` entirely.** At 2× it counts at half the real rate; at 0.5× it double-counts.
3. `src/services/textToSpeechService.js:289-297` — a *second* 100ms interval in the **main process**, with the apologetic comment `// Fallback: estimate based on elapsed time`, forwarded over IPC by `src/main.js:504-507` into `ttsControlsRenderer.js:189-191`.

Since `timeupdate` fires only ~4Hz while the intervals fire at 10Hz, the bar visibly rubber-bands.

**Progress may be permanently frozen at zero anyway.** `this.currentPosition` in `unrealSpeechTTS.js` is only ever assigned `0` (`:63`, `:720`, `:828`) or a seek target (`:771`) — **it is never advanced during playback**. `getCurrentTime()` (`:803`) returns it, and `textToSpeechService.js:292-293` *prefers* `getCurrentTime()` when it exists, which it does (`:377`, `:582`, `:1353`). So on the UnrealSpeech path the progress reading is a constant.

**Duration is a characters-per-second guess, with two different constants.** `unrealSpeechTTS.js:979` uses `text.length / 10` (10 chars/sec); `:1126` uses `(text.length / 850) * 60` (≈14.2 chars/sec). A **42% disagreement** between two endpoints in the same file, feeding the cache, the IPC payload (`main.js:2406`), and the main-process end-of-playback check (`textToSpeechService.js:310`).

**External pause is a lie.** `main.js:488-493` sends `tts-paused`; `ttsControlsRenderer.js:398-403` `pauseTTS()` flips the UI state and stops progress tracking but **never calls `this.audioElement.pause()`**. The pill says paused; the audio keeps playing. Same for `resumeTTS()` (`:405-410`).

**`produce()` is fire-and-forget with no `.catch()`.** `read-aloud/index.html:281` calls `produce()` unawaited. A rejection means `producerDone` is never set (`:274`), so `playFromChunk` spins forever in its 30ms polling loop (`:288-291`). Silent hang with the UI showing "playing".

**Highlight can freeze or vanish silently.** `read-aloud/index.html:260` falls back to `ttsCount = (d.words || []).length || 1`; with `ttsCount === 1`, `activeDomIndex` (`:306`) computes `frac = 0` always, so the highlight **sticks on the chunk's first word** for the chunk's whole duration. And if `d.wtimes` is empty, `startTick` starts at `i = -1` (`:314`), producing a negative index that `highlighter.js:92` silently rejects — the highlight just stops.

**Blob URLs leak in the standalone app.** `read-aloud/index.html:213` creates object URLs that are **never revoked**. The extension got this right (`offscreen.js:116`); the standalone regressed.

**A decode gap at every sentence boundary.** `read-aloud/index.html:293-298` constructs a fresh `new Audio()` per chunk and starts it from the previous chunk's `onended`. That serializes decode-then-start latency into an audible gap between every sentence — and at 2–3× the sentences get shorter while the gap stays constant, so the stutter becomes proportionally far more obvious. This likely contributed to "sounds weird" independently of the pitch issue.

**Code blocks are read aloud.** `read-aloud/highlighter.js:57` skips only `SCRIPT`, `STYLE`, `NOSCRIPT`. `<pre><code>` is walked and spoken.

**Dead API.** `src/ttsControlsRenderer.js:644` calls `require('electron').remote`, removed in Electron 14. Optional-chained, so it silently no-ops and window position is never saved.

**Even `/stream` isn't streamed.** `src/services/unrealSpeechTTS.js:351` — `const arrayBuffer = await response.arrayBuffer();` drains the entire response before anything plays. `:1412` is blunter: `// For now, concatenate all chunks and play`.

---

## ANTI-PATTERNS — do not repeat these

1. **Never put the audio element and the highlighter in different execution contexts.** This single decision (`6d3c932`) forced every subsequent failure: rAF died, which forced wall-clock extrapolation, which caused the desync, which triggered two more "fix drift" commits. If the highlighter cannot synchronously read `audio.currentTime` every frame, the architecture is already wrong.

2. **Never drive a highlight from `Date.now()`, `performance.now()`, or an accumulating `setInterval`.** `reader-extension/content.js:69` and `src/ttsControlsRenderer.js:597` and `src/services/textToSpeechService.js:296` are three instances of the same mistake. A wall clock does not slow down when `playbackRate` changes and does not pause when audio stalls. **Read `audio.currentTime` every frame.** It is in the media timebase, it is free, and it is exactly correct at every rate.

3. **Never use `AudioBufferSourceNode.playbackRate` for user-facing speed.** It resamples: pitch shifts with speed. Use `HTMLMediaElement.playbackRate` with `preservesPitch = true` (a real WSOLA time-stretch), or an explicit time-stretch library. These two APIs share a name and do completely different things.

4. **Never index one word list with another list's indices.** `wordCursor += p.words.length` (TTS space) used as `wordRanges[wordOffset + k]` (DOM space) compounds error across the document. Derive spoken chunks *from* the on-screen word array so the offset is a true DOM index by construction (as `read-aloud/index.html:238-248` finally does), or carry an explicit alignment map. Never assume the TTS tokenizer agrees with `/\S+/`.

5. **Never trust a TTS engine's own `speed` parameter without verifying the bytes change.** Kokoro accepted `speed` and returned byte-identical audio. Three commits and two days were spent before `f0accb2` ("log applied speed") proved it. Verify with a byte-length or hash diff on day one.

6. **Never estimate word positions from a characters-per-second heuristic** (`unrealSpeechTTS.js:979`, `:1126`) when the API returns real timestamps. It drifts by construction, and having two different constants in one file guarantees inconsistency.

7. **Never fetch real timestamps and then discard them.** `unrealSpeechTTS.js:985` fetched them; `textToSpeechService.js:620-624` dropped them. The app paid the API cost for the exact data that would have made highlighting work, on every single request.

8. **Never synthesize the whole document in one blocking call.** `main.js:2385` awaits the entire text. When your own timeout math (`main.js:3063-3069`) says 1.35s per 1,000 characters, chunk by sentence and stream — don't widen the timeout. A progressive timeout system is a smell that you're papering over an architectural problem.

9. **Never let more than one clock write the same UI value.** Three writers to one progress bar (`timeupdate`, renderer interval, main-process IPC interval) guarantees the visible rubber-banding. Pick one source of truth.

10. **Never ship transport controls whose implementations are `console.log` stubs.** `setSpeed()` (`:786`), `seek()` (`:769`), `resume()` (`:755`) all no-op or restart from zero, each with a `// In a full implementation...` comment. A control that visibly exists but does nothing is worse than an absent control — it makes the user believe the feature is broken rather than missing.

11. **Never choose a playback engine with no transport surface.** Piping PCM into `node-speaker` (`:608-660`) is *why* anti-pattern 10 exists — you cannot implement seek or rate on a fire-and-forget byte stream. Choose the engine that exposes `currentTime` / `playbackRate` / `pause()` first; everything else follows.

12. **Never let one variable carry three different unit scales.** `options.speed` is a multiplier at `:908`, a −1..1 API value at `:313`, and is fed to a converter that assumes −1..1 at `:465`. Name units in the variable (`speedMultiplier` vs `apiSpeedOffset`) and convert exactly once, at the boundary.

13. **Never make speed a single forward-wrapping button.** `ttsControlsRenderer.js:522-533` requires five presses to go 1.25 → 1.0. And never let `indexOf()` return `-1` into modular arithmetic (`:634`) — it silently jumps to the slowest setting.

14. **Never apply a rate change only to the next buffered chunk.** With `BUFFER_AHEAD = 2` that's a multi-second delay before the user hears any response to their input, which reads as "the control is broken."

15. **Never fire-and-forget an async producer** (`read-aloud/index.html:281`). Without a `.catch()`, a rejection leaves the consumer polling forever and the UI claiming to play.

16. **Never regress a cleanup you already got right.** The extension revoked blob URLs (`offscreen.js:116`); the standalone rewrite (`index.html:213`) did not.

---

## What WAS worth keeping

**`read-aloud/highlighter.js` — genuinely good, take it as-is.** It uses the **CSS Custom Highlight API** (`:27-34`), holding DOM `Range` objects in named `Highlight` registries styled via `::highlight()`. **Nothing is inserted into the DOM**, so there is no reflow, no wrapper-span explosion, and no interference with page scripts — the classic `<span class="hl">` approach cannot claim any of that. `extractWords()` (`:54-85`) builds one `Range` per word with a `TreeWalker` and also records each word's containing block for a paragraph wash. It is a clean, provider-agnostic paint layer that knows nothing about audio, exactly as its header claims (`:8-10`). `wordIndexAtPoint()` (`:127-134`) gives double-click-to-jump nearly for free.

**The final `read-aloud/index.html` tick loop** (`:309-320`) is the correct pattern: read `currentTime`, binary-search `wtimes`, set the word. It needs no rate term. Copy this shape.

**`buildSentences()`** (`:238-248`) — deriving sentence chunks from the highlighter's own word array so `domOffset` is a true DOM index. This is the correct structural fix for Fault B, and the comment explaining *why* is worth preserving.

**Scroll-only-near-the-edges** (`highlighter.js:106-113`) — only `scrollIntoView` when the active word is within 80px of the top or 140px of the bottom. Avoids per-word scroll jitter. Small, but it's the difference between pleasant and nauseating.

**Sentence-first streaming with a bounded look-ahead** (`read-aloud/index.html:249-275`, `BUFFER_AHEAD = 2`). The right shape — synthesize sentence 1, start playing, keep two ahead. The Electron path should have done this from the start.

**The WebGPU-vs-WASM RTF probe** (`reader-extension/offscreen.js:57-70`) — times a warm-up synthesis and computes a real-time factor, flagging `RTF ≥ 0.6` as a silent WASM fallback. It catches a genuinely invisible performance cliff (`dtypeWebgpu: "fp32"` at `:41` exists because the WebGPU EP doesn't support q8 and would silently fall back). Good instinct: **measure the backend you actually got, don't trust the one you asked for.**

**`ttsCacheManager.js`** — a real, wired, SHA-256-keyed on-disk MP3 cache (`:68-83` key, `:91` read, wired at `textToSpeechService.js:587` and `:610`). One caveat: it only writes when both `buffer` *and* `duration` are truthy (`:605`), and `duration` is the bogus estimate — so cache writes are hostage to a heuristic. Fix the condition and the cache is sound. Note the read-aloud lineage has **no caching at all** (`read-aloud/index.html:279` resets `chunks = []` every run), so every replay re-synthesizes.

**`.notes/tts-rethink.md`** — the author's own root-cause table at `:33-43` is accurate, and the "word-timing table" framing at `:47-66` is the right mental model: one per-word record of `{text, charRange, screenRect, audioStart, audioEnd}`, against which karaoke, click-to-jump, seek, and the progress bar are all just queries. The provider analysis in `.notes/tts-provider-comparison.md` (the "karaoke gate" at `:124` — native word timestamps, no forced alignment) is the correct selection criterion.

---

## Gaps — what I did not do

- **I did not run any of this code.** No audio was played, no drift was measured. Every conclusion is from source reading plus the author's own commit messages and code comments. The pitch-shift and drift claims rest on documented API semantics and the author's recorded observations, not on my own measurement.
- **Files I did not read in full:** `src/main.js` (103,673 bytes — I read the TTS IPC handler at `:2265-2439` and grepped the rest for TTS symbols); `src/services/unrealSpeechTTS.js` (1,546 lines — I read `:200-310`, `:440-500`, `:755-815`, `:900-1000`, `:1240-1260` and grepped the remainder); `src/services/ttsCacheManager.js` (read only the key-generation and read paths); `tts-reader/harness.html`, `tts-reader/harness-kokoro.html`, `reader-extension/dev-test.html`, `reader-extension/background.js` (dev harnesses and a message router — I confirmed via grep that they repeat the same patterns but did not audit them line by line); `techDocs/geminiTTS.md` and `techDocs/kokoro.md` (85KB and 14KB of provider research, not post-mortem material).
- **I did not read the `.history/` directory**, which may contain additional intermediate versions.
- **I did not verify the HeadTTS vendor library's behaviour** — specifically whether `d.wtimes` is reliably populated by the timestamped Kokoro model, or how often `ttsCount !== domCount` in practice. The severity of the residual proportional-mapping estimate in the final version depends on that frequency, which I could not measure without running it.
- **I did not measure actual IPC latency** in the extension, so the "5–50ms" figure in Fault A is a reasoned estimate of Chrome extension message-passing overhead, not a measurement. The *direction* of the error (uncompensated, rate-multiplied) is certain from the code; the magnitude is not.
- **I assumed rather than verified** that the user's complaints map primarily to the Kokoro read-aloud lineage for the highlighting symptoms and to the Electron/UnrealSpeech path for the "whole document at once" symptom. That mapping is inferred from which system had which capability, not from user testimony about which build they were running.

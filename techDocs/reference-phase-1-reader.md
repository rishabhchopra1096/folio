# Phase 1 — The Reader (Simba streaming + AVAudioEngine, no cloud)

**Implementation-ready tech doc.** Turns `ARCHITECTURE.md` §2/§4/§5 + the Phase-1 plan into buildable code.

## TL;DR

- **Scope:** paste a doc → play → lock the phone → hear it read (Speechify Simba-3.2), with word-accurate **seek** ("back 15s / back N s / previous paragraph / forward"), gapless across paragraphs, **zero re-charge on rewind**, and lock-screen transport. No gate, no cloud, no LLM. Commands come from **on-screen buttons** (voice is Phase 2).
- **Streaming contract is now DOC-CONFIRMED (was inferred in ARCHITECTURE §2):** `POST /v1/audio/stream/with-timestamps` returns **SSE** with `event: speech.chunk` (`data:{ "audio": <base64>, "speech_marks": [...] }`) and a terminal `event: speech.done` (`data:{ "billable_characters_count", "audio_duration_ms" }`). The audio field is **`audio`** (streaming) — note the **batch** endpoint uses **`audio_data`**. Still run one live curl before coding to confirm runtime + TTFB (VERIFY-FIRST §8).
- **`text_normalization` differs by endpoint:** default **`true` in batch, `false` in streaming**, and it is **nested under `options`**. Set `options.text_normalization: true` explicitly for natural reading; char anchors stay on the original span.
- **Apple correction:** `scheduleSegment(_:startingFrame:…)` takes an **`AVAudioFile`, not a buffer** (the ARCHITECTURE shorthand `scheduleSegment(buffer, …)` is imprecise). Persist each paragraph's PCM as an `AVAudioFile` on disk (that IS the disk cache) and seek frame-accurately with `scheduleSegment`. In-memory buffer path is the alternative (slice a sub-buffer + `scheduleBuffer`).
- **Player model:** one `AVAudioEngine` → one `AVAudioPlayerNode` → mixer → output. Gapless chaining = schedule paragraph p **and** p+1 back-to-back; completion handler advances state + triggers prefetch. Playhead = `originGlobalMs + player.playerTime(…).sampleTime/sampleRate`, where `originGlobalMs` resets only on `stop()+play()` (seek/initial), not on gapless advance.
- **Platform:** the player, seek, playhead, `AVAudioSession`, `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`, and the SSE→PCM→cache pipeline must live in a **native Swift Expo module** — audio bytes never cross the JS bridge; only marks (tiny JSON) + events do. RN/TS owns ingestion, prefetch policy, UI, highlighting.
- **DECISION FLAGGED:** for a Phase-1 **reader-only** build, prefer `AVAudioSession` **`.playback`** (full-quality A2DP on AirPods, no mic permission, normal pause-in-background) over `.playAndRecord`. Phase 2 migrates to `.playAndRecord` when the mic gate lands. Rationale + the one-category-swap cost in §6.

## Document Map

- **§1 Architecture split** — what's native Swift vs RN/TS, and the bridge surface.
- **§2 Streaming client** — the exact request, the SSE parser, PCM assembly, speech-mark handling.
- **§3 Cache** — data structures, disk key, memory LRU, prefetch policy.
- **§4 Player + playhead + seek** — engine wiring, gapless chaining, the global timeline, frame-accurate seek.
- **§5 The four nav commands** — seek math, `wordIndexAtTime` binary-search floor.
- **§6 Lock-screen** — session category decision, Now Playing + Remote Command wiring, the "audio must flow" rule (and when it does/doesn't apply).
- **§7 Ingestion** — paragraph chunking, plain-text rule, `text_normalization`, char offsets.
- **§8 Gotchas + VERIFY-FIRST list** — the step-0 curl and everything to confirm before coding.
- **§9 Sources.**

---

## 1. Architecture split (native Swift module vs RN/TS)

**The core of Phase 1 cannot be pure React Native.** `AVAudioEngine` PCM scheduling, frame-accurate `scheduleSegment` seek, `playerTime`-based playhead tracking, `AVAudioSession` fine control (both auto-config/auto-deactivation flags — needed in Phase 2), and `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` have **no RN equivalent**. `expo-audio` (already in the stack) is a high-level player with no PCM-buffer scheduling or sample-accurate seek. So Phase 1 ships a **native Swift module**.

The stack (`../locked-screen-spike/package.json`) is **Expo SDK 56, RN 0.85.3, `expo-dev-client`** — custom native modules build fine (dev-client, **not** Expo Go). Build the reader as an **Expo local module** (Expo Modules API, Swift).

**Why the SSE client + PCM assembly + cache also go native:** RN's `fetch` can't reliably stream a response body; `react-native-sse` (XHR-based) can read the SSE text, but you'd then ship **base64 PCM across the JS bridge** — slow and memory-churny for ~48 KB/s of audio. Do it in Swift with `URLSession.bytes(for:)`; keep audio bytes on the native side; return only marks + progress events to JS.

| Layer | Lives in | Why |
|---|---|---|
| SSE streaming client, base64→PCM assembly, disk+memory cache | **Native Swift** | Audio bytes never cross the bridge; `URLSession.bytes` streams cleanly |
| `AVAudioEngine`/`AVAudioPlayerNode`, seek, playhead | **Native Swift** | No RN API exists |
| `AVAudioSession`, `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter` | **Native Swift** | RN transport libs (e.g. `react-native-track-player`) assume they own the player — conflicts with our custom engine |
| Doc ingestion + paragraph chunking | **RN/TS** (or native) | Pure string work; keep near the paste UI. The side that **sends** to the API must store the exact string — see §7 |
| Prefetch policy, orchestration | **RN/TS** | Calls `synthesize(index)` into the module |
| UI, on-screen nav buttons, word highlighting | **RN/TS** | Consumes `onWordBoundary` events |

**Bridge surface (Expo module API):**

```ts
// ReaderEngine.ts — the TS face of the native module
export interface WordMark { startTimeMs: number; endTimeMs: number; startChar: number; endChar: number; value: string }
export interface Paragraph { index: number; text: string; charOffsetInDoc: number }

ReaderEngine.configureSession(opts: { category: 'playback' | 'playAndRecord' }): void
ReaderEngine.loadDocument(paragraphs: Paragraph[]): Promise<void>   // stores exact strings, computes cache keys
ReaderEngine.synthesize(index: number): Promise<{ durationMs: number; wordCount: number }>  // stream+cache one ¶ (or prefetch calls it)
ReaderEngine.play(): void
ReaderEngine.pause(): void
ReaderEngine.seekToGlobalMs(ms: number): void
ReaderEngine.goBack(seconds: number): void        // default 15
ReaderEngine.previousParagraph(): void
ReaderEngine.goForward(seconds: number): void     // default 15
ReaderEngine.getPlayheadMs(): number

// Events (native → JS)
onWordBoundary: { globalMs, paragraphIndex, wordIndex, startChar, endChar }  // drives highlighting
onParagraphChanged: { index }
onStateChange: { state: 'idle'|'playing'|'paused'|'buffering' }
onSynthProgress: { index, receivedMs }
onSynthError: { index, message }
```

---

## 2. Speechify Simba-3.2 streaming-with-timestamps client

### 2.1 The request (DOC-CONFIRMED against live Speechify docs, Aug 2026)

```
POST https://api.speechify.ai/v1/audio/stream/with-timestamps
Authorization: Bearer <SPEECHIFY_API_KEY>
Content-Type: application/json
Accept: text/event-stream
```

```jsonc
{
  "input": "<the paragraph, EXACT plain text — no SSML>",
  "voice_id": "geffen_32",              // simba-3.2 voice allow-list (VERIFY it's on the list, §8)
  "model": "simba-3.2",                 // default is simba-3.0; set 3.2 explicitly
  "output_format": "pcm_24000",         // streaming accepts pcm_8000..pcm_48000 (PCM-only)
  "language": "en-US",                  // ISO 639-1 + region
  "options": { "text_normalization": true }  // NESTED. Streaming default is FALSE — set true for "$5"→"five dollars"
}
```

Notes that bite (all confirmed live):
- **`input` required, `voice_id` required.** `input` is one complete string per request (no streaming-text-IN — that was the July verdict; irrelevant here, we synthesize a fixed paragraph).
- **`text_normalization` is under `options`, defaults `false` in streaming** (it defaults `true` in the **batch** `/v1/audio/speech`). Set it `true`. Char anchors in the marks still point at the **original** span ("$5"), so highlighting stays right — VERIFY §8.6.
- **Streaming `output_format` is PCM-only** (`pcm_8000, pcm_16000, pcm_22050, pcm_24000, pcm_44100, pcm_48000`). Use `pcm_24000` (24 kHz; our prior curl testing measured PCM ~130 ms/request faster than mp3 — see `speechify-streaming-verdict.md`).
- **Character limit ~20,000 per streaming request** — our ~800-char paragraph target is far under it; the limit only constrains how aggressively you may *merge*.
- **PCM byte layout is NOT explicitly documented.** Assume **16-bit signed little-endian, mono** → 24000 × 2 × 1 = **48000 bytes/s**. VERIFY §8.3.

### 2.2 The SSE response (DOC-CONFIRMED — resolves ARCHITECTURE §2 "OPEN")

```
event: speech.chunk
data: {"audio":"SUQzBAAAAAAA...","speech_marks":[ ... ]}

event: speech.chunk
data: {"speech_marks":[ ... ]}          ← a chunk may carry marks-only …

event: speech.chunk
data: {"audio":"//uQx..."}              ← … or audio-only

event: speech.done
data: {"billable_characters_count":40,"audio_duration_ms":4350}
```

- Field names: **`audio`** = base64 audio bytes; **`speech_marks`** = array of marks. (ARCHITECTURE §2 inferred `audio_data`/`speech_marks`; the streaming field is **`audio`** — `audio_data` is the *batch* field. Fix your parser accordingly.)
- **No `[DONE]` sentinel.** `speech.done` is terminal.
- **Rule (ARCHITECTURE §2 gotcha 6):** speech-mark times are **absolute ms from synth start**. **Concatenate audio strictly in arrival order; pool all marks into one array.** Which chunk a mark arrives on is meaningless.

### 2.3 Speech-mark shape (DOC-CONFIRMED)

```ts
type NestedChunk = {
  start_time: number   // ms, absolute from synth start
  end_time: number     // ms
  start: number        // character index into the ORIGINAL input text
  end: number          // character index
  value: string        // the word/segment text
}
type SpeechMarks = NestedChunk & { chunks: NestedChunk[] }  // sentence/¶ parent; words in `chunks`
```

The **batch** response additionally carries a `type` field on each mark (e.g. word/sentence) and returns `speech_marks` as a single nested object; **streaming** delivers `speech_marks` as flat arrays across chunks. **VERIFY §8.7** whether streaming words arrive flat (word-level) or nested with sentence parents — it changes one line of the parser (flatten `chunks` vs use as-is). Our parser flattens defensively.

### 2.4 Swift: streaming client + SSE parser + PCM assembly

```swift
// ReaderStreamClient.swift
// Streams ONE paragraph from Speechify's /v1/audio/stream/with-timestamps,
// parses the SSE frames, concatenates PCM in arrival order, pools speech marks,
// and returns (pcmData, words, durationMs). Audio never leaves Swift.

import AVFoundation

struct WordMark {                       // paragraph-LOCAL times/indices (globalized later, §4)
    let startTimeMs: Int; let endTimeMs: Int
    let startChar: Int;   let endChar: Int
    let value: String
}

struct SynthResult { let pcm: Data; let words: [WordMark]; let durationMs: Int }

enum SpeechifyError: Error { case http(Int), badEvent, terminated }

final class ReaderStreamClient {
    private let apiKey: String
    private let host = URL(string: "https://api.speechify.ai/v1/audio/stream/with-timestamps")!
    init(apiKey: String) { self.apiKey = apiKey }

    func synthesize(text: String, voiceId: String, model: String,
                    outputFormat: String, language: String) async throws -> SynthResult {
        // --- Build the request ---
        var req = URLRequest(url: host)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "input": text,                       // EXACT string — must equal Paragraph.text (§7)
            "voice_id": voiceId, "model": model,
            "output_format": outputFormat, "language": language,
            "options": ["text_normalization": true]
        ])

        // --- Open the byte stream (iOS 15+) ---
        let (bytes, response) = try await URLSession.shared.bytes(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { throw SpeechifyError.http((response as? HTTPURLResponse)?.statusCode ?? -1) }

        // --- Parse SSE line-by-line: accumulate an event's `event:`/`data:` until a blank line ---
        var pcm = Data(); var words: [WordMark] = []; var durationMs = 0
        var eventName = ""; var dataBuf = ""

        func flushFrame() throws {
            guard !dataBuf.isEmpty else { return }
            let json = try JSONSerialization.jsonObject(with: Data(dataBuf.utf8)) as? [String: Any] ?? [:]
            switch eventName {
            case "speech.chunk":
                if let b64 = json["audio"] as? String, let audio = Data(base64Encoded: b64) {
                    pcm.append(audio)                                  // ARRIVAL ORDER — gotcha 6
                }
                if let marks = json["speech_marks"] as? [[String: Any]] {
                    words.append(contentsOf: flatten(marks))          // pool + flatten (§2.3)
                }
            case "speech.done":
                durationMs = json["audio_duration_ms"] as? Int ?? durationMs
            default: break                                            // ignore unknown events
            }
            eventName = ""; dataBuf = ""
        }

        for try await line in bytes.lines {
            if line.isEmpty { try flushFrame(); continue }             // blank line = end of frame
            if line.hasPrefix("event:") { eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
            else if line.hasPrefix("data:") {
                let piece = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                dataBuf += (dataBuf.isEmpty ? "" : "\n") + piece       // multi-line data: concatenated
            }
            if eventName == "speech.done" { /* terminal; loop ends when stream closes */ }
        }
        try flushFrame()                                               // flush trailing frame if no final blank line
        if durationMs == 0 { durationMs = pcmDurationMs(pcm) }         // fallback from frame count
        return SynthResult(pcm: pcm, words: words, durationMs: durationMs)
    }

    // A streaming word mark may be flat (word-level) or a sentence with `chunks`. Flatten to words.
    private func flatten(_ marks: [[String: Any]]) -> [WordMark] {
        var out: [WordMark] = []
        for m in marks {
            if let chunks = m["chunks"] as? [[String: Any]], !chunks.isEmpty {
                out.append(contentsOf: flatten(chunks))               // descend into words
            } else {
                out.append(WordMark(
                    startTimeMs: Int(m["start_time"] as? Double ?? 0),
                    endTimeMs:   Int(m["end_time"]   as? Double ?? 0),
                    startChar:   m["start"] as? Int ?? 0,
                    endChar:     m["end"]   as? Int ?? 0,
                    value:       m["value"] as? String ?? ""))
            }
        }
        return out
    }
    // 16-bit mono @ 24 kHz → ms. VERIFY the 16-bit/mono assumption (§8.3).
    private func pcmDurationMs(_ d: Data) -> Int { Int(Double(d.count) / (24000.0 * 2.0) * 1000.0) }
}
```

**First-audio latency lever (optional, add after MVP):** the code above assembles the whole paragraph before playing (TTFB ≈ full-paragraph synth). ARCHITECTURE §2 says "stream the current ¶ for fast first-audio." To do that, schedule the incoming PCM **incrementally** on the player node as `speech.chunk`s arrive (slice each into an `AVAudioPCMBuffer`, `scheduleBuffer`), while also accumulating to the file for later seeking. Build **synth-to-file-then-play first** (simpler, immediately seekable); add incremental play only if the measured TTFB (§8.2) is too slow. Prefetched paragraphs never need incremental play.

---

## 3. Per-paragraph cache (rewind = $0)

**Speechify bills per character sent to the API; replaying cached audio is zero calls = zero charge** (ARCHITECTURE §2). The only re-charge risk is eviction + re-synth on rewind — killed by a **persistent disk cache**.

### 3.1 Data structures

```swift
struct ParagraphAudio {
    let index: Int
    let text: String            // EXACT string sent to the API — marks index into THIS 1:1 (§7)
    let charOffsetInDoc: Int     // Σ of prior paragraph lengths (+ separators) — for Phase-3 note anchoring
    let fileURL: URL             // cached CAF on disk == the audio == the seek source (§4)
    let durationMs: Int          // from speech.done.audio_duration_ms (or PCM frame count)
    let words: [WordMark]        // paragraph-LOCAL marks (globalized at play time)
    let cacheKey: String         // sha256(text|voice|model|format)
    var buffer: AVAudioPCMBuffer?  // optional memory LRU copy (nil if evicted)
}
```

Marks for the **whole doc** stay in memory (tiny JSON). **Audio** lives on disk always, and optionally in a memory LRU.

### 3.2 Disk key + layout

```swift
// cacheKey = sha256("<text>|<voiceId>|<model>|<outputFormat>")  — any of the four changing = a new synth
import CryptoKit
func cacheKey(_ text: String, _ voice: String, _ model: String, _ fmt: String) -> String {
    let s = "\(text)|\(voice)|\(model)|\(fmt)"
    return SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}
// Files (Caches dir — OK to be purged; a purge just costs a re-synth, never a crash):
//   <Caches>/paragraphs/<cacheKey>.caf    → the AVAudioFile (audio)
//   <Caches>/paragraphs/<cacheKey>.json   → { durationMs, words:[...] }  (so rewind loads without a network call)
```

Include `text` **in the key** (not just paragraph index) so an edited paste re-synthesizes only changed paragraphs and a rewind to an *unchanged* one is a pure disk hit → **$0**.

### 3.3 Memory LRU + prefetch policy

- **Memory LRU:** `NSCache<NSString, AVAudioPCMBuffer>` capped at ~20 paragraphs (`countLimit`) — NSCache auto-evicts under memory pressure. `ParagraphAudio` meta + marks are never evicted (kept in a `[Int: ParagraphAudio]` dict).
- **Prefetch 2-3 ¶ ahead:** when playback enters paragraph `p` (paragraph-changed completion handler, §4), ensure `p+1, p+2` (and optionally `p+3`) are synthesized. For each: **disk-hit → load; miss → stream+cache** on a background `Task`. Never block playback.
- **Never synthesize the whole doc up front** (cost + latency). Synthesize the current paragraph on play, then keep the 2-3-ahead window warm.

```swift
func ensurePrefetched(around p: Int, ahead: Int = 2) {
    for i in (p+1)...(p+ahead) where i < paragraphs.count {
        if diskHit(paragraphs[i].cacheKey) { loadFromDisk(i) }        // $0
        else { Task.detached { try? await self.synthesizeAndCache(i) } } // one paid synth, then cached forever
    }
}
```

---

## 4. Player: AVAudioEngine + AVAudioPlayerNode, playhead, frame-accurate seek

### 4.1 Engine wiring

```swift
// One engine, one player node → mixer → output. Single I/O graph.
let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: nil)  // nil = adopt from scheduled files/buffers
try engine.start()
```

### 4.2 Persist PCM as an `AVAudioFile` (this doubles as the disk cache)

**Apple correction:** `scheduleSegment(_ file: AVAudioFile, startingFrame:frameCount:at:completionHandler:)` takes an **`AVAudioFile`**, not a buffer. So write each paragraph's PCM to a CAF file; that file is both the cache entry **and** the frame-accurate seek source.

```swift
// Convert raw 16-bit LE mono PCM → Float32 buffer in the file's processingFormat → write a .caf
func writeCaf(pcm: Data, to url: URL) throws {
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 24000, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false ]
    let file = try AVAudioFile(forWriting: url, settings: settings)   // processingFormat = Float32 @ 24k
    let frames = AVAudioFrameCount(pcm.count / 2)                     // 2 bytes/sample, mono
    let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)!
    buf.frameLength = frames
    pcm.withUnsafeBytes { raw in
        let i16 = raw.bindMemory(to: Int16.self)
        let dst = buf.floatChannelData![0]
        for n in 0..<Int(frames) { dst[n] = Float(Int16(littleEndian: i16[n])) / 32768.0 }
    }
    try file.write(from: buf)
}
```

*(Memory-only alternative — Design 2: keep the Float32 `AVAudioPCMBuffer` in the LRU and, to seek, build a sub-buffer copying frames `[seekFrame..<frameLength]` then `scheduleBuffer`. Same math, no file. Use it as the fast path; the file path above is primary because it reuses the disk cache and gives `scheduleSegment` for free.)*

### 4.3 The global timeline

```swift
// docStartMs[p] = Σ durations of paragraphs < p. Build once as paragraphs synthesize.
var docStartMs: [Int] = []       // docStartMs[0] = 0; docStartMs[p] = docStartMs[p-1] + durationMs[p-1]
// Global word list for seeking/highlighting: word.globalStartMs = docStartMs[p] + word.startTimeMs
struct GlobalWord { let paragraph: Int; let wordIndex: Int; let globalStartMs: Int
                    let startChar: Int; let endChar: Int }
var globalWords: [GlobalWord] = []   // sorted ascending by globalStartMs (naturally, in doc order)
```

Use the **decoded PCM frame count** (`file.length`) for frame math and `audio_duration_ms` as a cross-check — they should agree; if they diverge, trust the file length (that's what actually plays).

### 4.4 Gapless paragraph chaining

Schedule paragraph `p` **and** `p+1` back-to-back on the same node; they play seamlessly. The completion handler of `p` advances the "current paragraph" pointer, fires `onParagraphChanged`, and schedules the paragraph after next + prefetch.

```swift
func scheduleParagraphFromTop(_ p: Int) {
    guard let pa = paragraphs[p], let file = try? AVAudioFile(forReading: pa.fileURL) else { return }
    player.scheduleSegment(file, startingFrame: 0,
                           frameCount: AVAudioFrameCount(file.length), at: nil) { [weak self] in
        // Called on the render thread when p FINISHES. Advance + keep the pipeline full.
        DispatchQueue.main.async {
            self?.currentParagraph = p + 1
            self?.emit(.paragraphChanged(p + 1))
            self?.ensurePrefetched(around: p + 1)
            if let np = self?.currentParagraph, self?.isScheduled(np + 1) == false {
                self?.scheduleParagraphFromTop(np + 1)   // keep one paragraph queued ahead
            }
        }
    }
}
```

**`originGlobalMs`** = the global time corresponding to `sampleTime == 0` of the current `play()` session. Because all segments are scheduled **doc-contiguous from their tops**, `global = originGlobalMs + localElapsed` holds continuously across paragraph boundaries. Reset `originGlobalMs` **only** on `stop()+play()` (initial play and every seek), never on gapless advance.

### 4.5 Playhead

```swift
var originGlobalMs = 0            // set on play()/seek

func globalPlayheadMs() -> Int {
    guard let nodeTime = player.lastRenderTime,
          let pt = player.playerTime(forNodeTime: nodeTime) else { return originGlobalMs }
    let elapsedMs = Int(Double(pt.sampleTime) / pt.sampleRate * 1000.0)   // since play() session start
    return originGlobalMs + max(0, elapsedMs)
}
```

Emit `onWordBoundary` by resolving `wordIndexAtTime(globalPlayheadMs())` on a lightweight timer (e.g. a `CADisplayLink` throttled to ~30 Hz, or a 100 ms timer) and pushing the char range to JS for highlighting. Now Playing elapsed does **not** need per-frame updates (iOS extrapolates from rate+timestamp — §6).

### 4.6 Frame-accurate seek (the primitive all nav commands call)

```swift
func seekToGlobalMs(_ target: Int, snapToWord: Bool = true) {
    let clamped = max(0, min(target, synthesizedFrontierMs()))
    let t = snapToWord ? wordFloorGlobalMs(clamped) : clamped   // snap to word boundary (skips leading silence)
    let p = paragraphIndex(forGlobalMs: t)                       // last p with docStartMs[p] <= t
    let localMs = t - docStartMs[p]
    let seekFrame = AVAudioFramePosition(Double(localMs) * 24000.0 / 1000.0)

    player.stop()                                               // clears the schedule
    originGlobalMs = t                                          // sampleTime restarts at 0 → origin = t
    if let file = try? AVAudioFile(forReading: paragraphs[p]!.fileURL) {
        player.scheduleSegment(file, startingFrame: seekFrame,
                               frameCount: AVAudioFrameCount(file.length - seekFrame),
                               at: nil, completionHandler: chainAfter(p))
    }
    if isSynthesized(p + 1) { scheduleParagraphFromTop(p + 1) }  // keep gapless
    currentParagraph = p
    player.play()
    emit(.paragraphChanged(p))
    updateNowPlayingElapsed(t)
}
```

---

## 5. The four nav commands as seek math

All four resolve a **target global ms**, then call `seekToGlobalMs`. In Phase 1 they're wired to on-screen buttons (and, in §6, to lock-screen remote commands).

### 5.1 `wordIndexAtTime` — binary-search FLOOR (never a range test)

Marks have **gaps** (silence between words) — resolve "word at time t" as the **last word with `globalStartMs ≤ t`** (ARCHITECTURE §2 gotcha 2).

```swift
func wordFloorIndex(_ t: Int) -> Int {                      // globalWords sorted ascending
    var lo = 0, hi = globalWords.count - 1, ans = 0
    while lo <= hi {
        let mid = (lo + hi) / 2
        if globalWords[mid].globalStartMs <= t { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
}
func wordFloorGlobalMs(_ t: Int) -> Int { globalWords.isEmpty ? t : globalWords[wordFloorIndex(t)].globalStartMs }
```

### 5.2 The commands

```swift
let H = globalPlayheadMs()

// (a) "go back" (bare = 15s) and "go back N seconds"
func goBack(seconds: Int = 15) { seekToGlobalMs(max(0, H - seconds * 1000)) }   // floor→word inside seek

// (b) "previous paragraph" — music-player "previous track" feel, ~1.2s threshold
func previousParagraph() {
    let p = currentParagraph
    let intoParagraph = H - docStartMs[p]
    if intoParagraph > 1200 { seekToGlobalMs(firstWordGlobalMs(p)) }             // restart current ¶
    else { let prev = max(0, p - 1); seekToGlobalMs(firstWordGlobalMs(prev)) }   // jump to previous ¶
}

// (c) "go forward" (bare = 15s) and "go forward N seconds" — clamped to synthesized frontier
func goForward(seconds: Int = 15) { seekToGlobalMs(min(synthesizedFrontierMs(), H + seconds * 1000)) }
```

- `firstWordGlobalMs(p)` = `globalWords` for paragraph `p`, first entry — snapping past the **leading silence** (first word `start_time ≠ 0`, ARCHITECTURE §2 gotcha 1). Restarting at `docStartMs[p]` would replay ~100-300 ms of silence; snap to the first word instead.
- `synthesizedFrontierMs()` = `docStartMs[last synthesized p] + durationMs[last]`. **Forward must never seek into un-synthesized audio** — if the user forwards past the frontier, clamp and let prefetch catch up (or kick a synth for the next paragraph, then seek on completion).
- All commands land on a **word boundary** because `seekToGlobalMs(snapToWord: true)` floors the target. This satisfies "hear it seek precisely (word-boundary)."

---

## 6. Lock-screen playback

### 6.1 DECISION: session category for a reader-only Phase 1

**ARCHITECTURE §5 (and the brief) specify `.playAndRecord` + `.spokenAudio`.** That is correct **for Phase 2**, where an always-on mic gate must coexist with playback without a category swap. **For Phase 1 there is no mic**, and `.playAndRecord` has real costs on a reader:

- On Bluetooth, a record-capable category forces **HFP (call-quality, ~16 kHz, mono)** instead of **A2DP (hi-fi)** — TTS **audibly degrades on AirPods** (ARCHITECTURE §5). `.playback` keeps A2DP.
- `.playAndRecord` triggers the **mic-permission prompt** and the **orange mic dot** for a feature that records nothing in Phase 1.
- The "audio must keep flowing or iOS suspends you" rule (§6.4) is a Phase-2, hold-the-mic-tap concern; a pure `.playback` app pauses in the background normally (like Podcasts).

**Recommendation:** Phase 1 uses **`.playback` + mode `.spokenAudio`**. Phase 2 migrates to `.playAndRecord` when the gate lands — **one** category swap, done once at Phase-2 engine setup (not per-interrupt), so it doesn't reintroduce route thrash. If you'd rather pay the BT-quality tax now to avoid that single future swap, use `.playAndRecord` — but for the Phase-1 definition-of-done ("hear it read… on EarPods/AirPods"), `.playback` sounds better. Flagging for sign-off.

```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playback, mode: .spokenAudio, options: [.allowBluetoothA2DP])
try session.setActive(true)
// Phase 2 will instead: .playAndRecord, .spokenAudio, [.allowBluetoothHFP, .bluetoothHighQualityRecording]
// (iOS 26 renamed .allowBluetooth → .allowBluetoothHFP — guard #if compiler(>=6.2), ARCHITECTURE §5)
```

`Info.plist` (via `app.json` `ios.infoPlist`): `UIBackgroundModes: ["audio"]`. (Drop `voip` — that was for CallKit, which ARCHITECTURE §5 rejects. Add `NSMicrophoneUsageDescription` only when Phase 2 needs the mic.)

### 6.2 Now Playing info

```swift
import MediaPlayer
func updateNowPlaying(title: String, totalMs: Int, elapsedMs: Int, rate: Float) {
    var info: [String: Any] = [
        MPMediaItemPropertyTitle: title,
        MPMediaItemPropertyArtist: "listeninterrupt",
        MPMediaItemPropertyPlaybackDuration: Double(totalMs) / 1000.0,       // Σ paragraph durations
        MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(elapsedMs) / 1000.0,
        MPNowPlayingInfoPropertyPlaybackRate: rate ]                          // 1.0 playing, 0.0 paused
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
}
```

Update elapsed + rate on **play/pause/seek** only — iOS extrapolates the scrubber from `rate`, `elapsed`, and the update timestamp. No per-frame updates needed.

### 6.3 Remote command center → the four commands

```swift
let cc = MPRemoteCommandCenter.shared()
cc.playCommand.addTarget  { _ in self.play();  return .success }
cc.pauseCommand.addTarget { _ in self.pause(); return .success }
cc.togglePlayPauseCommand.addTarget { _ in self.togglePlayPause(); return .success }

cc.skipBackwardCommand.preferredIntervals = [15]                 // lock-screen back button
cc.skipBackwardCommand.addTarget { ev in
    self.goBack(seconds: Int((ev as! MPSkipIntervalCommandEvent).interval)); return .success }
cc.skipForwardCommand.preferredIntervals = [15]
cc.skipForwardCommand.addTarget { ev in
    self.goForward(seconds: Int((ev as! MPSkipIntervalCommandEvent).interval)); return .success }

cc.previousTrackCommand.addTarget { _ in self.previousParagraph(); return .success }   // ¶ nav
cc.nextTrackCommand.addTarget     { _ in self.nextParagraph();     return .success }

cc.changePlaybackPositionCommand.addTarget { ev in                // scrubber → exact playhead
    self.seekToGlobalMs(Int((ev as! MPChangePlaybackPositionCommandEvent).positionTime * 1000)); return .success }
```

This maps **all four nav commands** to lock-screen affordances: skip-back/forward = ±15 s, previous/next-track = paragraph nav, scrubber = arbitrary seek.

### 6.4 The "audio must keep flowing" rule — when it applies

For **Phase 1 `.playback`**, pausing is normal media behavior: the app stays alive in the background-audio state (Now Playing shows paused), like Podcasts. The **"audio must never stop or iOS suspends you in seconds"** rule (ARCHITECTURE §5) is specifically about **Phase 2** holding an **always-on mic tap under `.playAndRecord`** — there, pausing *both* TTS and the mic tap gets you suspended, so the tap must keep running. Don't prematurely import that constraint into Phase 1; note it for the Phase-2 doc.

---

## 7. Document ingestion → paragraph chunks aligned with TTS

**The cardinal rule: the string you SEND is the string marks index into.** Store it verbatim as `Paragraph.text`; `marks[i].start/end` are character offsets into exactly that string (ARCHITECTURE §2 gotcha 3).

### 7.1 Chunking

```ts
function chunkIntoParagraphs(raw: string): Paragraph[] {
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const merged = mergeHeadings(blocks);       // a short, punctuation-less line + next block → one unit
  const units = merged.flatMap(splitIfLong);  // split > ~800 chars at sentence boundaries (never mid-sentence)
  let offset = 0;
  return units.map((text, index) => {
    const p: Paragraph = { index, text, charOffsetInDoc: offset };
    offset += text.length + 2;                 // +2 for the "\n\n" separator we split on
    return p;
  });
}
```

- **Merge headings:** a heading synthesized alone ("Chapter 3") gets bad prosody and wastes a cache unit — merge it with the following paragraph so it reads as one breath (ARCHITECTURE §2 caching strategy: "merge headings").
- **Split > ~800 chars** at sentence boundaries into sub-paragraphs (still each a cache unit) — smaller units = lower first-audio latency and finer prefetch granularity. Stay well under the **20,000-char** streaming hard limit.
- **`charOffsetInDoc`** (prefix sum) gives each paragraph a doc-global char base. Phase 1 only stores it; Phase 3 uses it for note anchoring (byte/char offset → paragraph). Compute it the same way you serialize the doc so it round-trips.

### 7.2 Plain text, not SSML

Send **plain text**. SSML would require entity-escaping (`&`→`&amp;`, `<`→`&lt;`), which **shifts character indices** so `marks[i].start/end` no longer line up with your stored string. Phase 1 needs no SSML — send the raw paragraph.

### 7.3 `text_normalization` and char anchors

With `options.text_normalization: true`, "$5" is *spoken* as "five dollars" but the mark's `start/end` still point at the **original "$5" span** in your string (docs confirm start/end index the original text). So highlighting stays correct and Phase-3 anchoring stays on the real span. Keep it on for natural reading. **VERIFY §8.6** on live audio.

---

## 8. Gotchas + VERIFY-FIRST list

### 8.1 Gotchas (baked into the code above)

1. **Leading silence** — first word `start_time ≠ 0`. Snap seeks/paragraph-restarts to the first word's `globalStartMs`, not `docStartMs[p]` (§5).
2. **Marks have gaps** — resolve "word at t" with FLOOR/`≤`, never `start ≤ t ≤ end` (§5.1).
3. **Send plain text** — SSML escaping shifts char indices (§7.2).
4. **`text_normalization`** — streaming default **`false`**, batch default **`true`**, and **nested under `options`**. Set `true`; anchors stay on the original span (§2.1, §7.3).
5. **Per-¶ synth resets times + char indices** — offset by `docStartMs[p]` (time) and `charOffsetInDoc` (chars) for doc-global position (§4.3, §7.1).
6. **Streaming marks are absolute ms from synth start; concatenate audio in arrival order; pool marks** — a mark's arrival chunk is meaningless (§2.4).
7. **Field-name split:** streaming SSE audio field is **`audio`**; **batch** is **`audio_data`**. Don't copy a batch parser (§2.2).
8. **`scheduleSegment` takes an `AVAudioFile`, not a buffer** — persist PCM as a file for frame-accurate seek; sub-buffer slice is the memory-only alternative (§4.2).
9. **`playerTime.sampleTime` resets per `play()` session** and continues across gaplessly-scheduled segments — set `originGlobalMs` on `stop()+play()` only (§4.4-4.5).
10. **Bluetooth A2DP↔HFP:** a record-capable category degrades AirPods audio — Phase-1 reader-only prefers `.playback` (§6.1).
11. **Forward past the synthesized frontier** — clamp; never seek into un-synthesized audio (§5.2).

### 8.2 VERIFY-FIRST (do these **before** writing the parser — the brief's "first build step")

**Step 0 — one live SSE call, log a raw event:**
```bash
curl -N -X POST https://api.speechify.ai/v1/audio/stream/with-timestamps \
  -H "Authorization: Bearer $SPEECHIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input":"Testing streaming with timestamps. It costs $5 at 3pm, café.","voice_id":"geffen_32","model":"simba-3.2","output_format":"pcm_24000","language":"en-US","options":{"text_normalization":true}}'
```

Then confirm, against the raw bytes:

| # | Verify | Why it matters | Doc status |
|---|---|---|---|
| 8.2.1 | Event names `speech.chunk` / `speech.done`; body fields **`audio`** (base64) + **`speech_marks`**; terminal `{billable_characters_count, audio_duration_ms}`; a chunk may be marks-only / audio-only | The whole parser | **Doc-confirmed** — confirm **runtime** (history of docs≠plugin in this stack) |
| 8.2.2 | **TTFB** — time to first `speech.chunk` carrying audio, from your region | Decides synth-to-file vs incremental-play (§2.4) | **UNKNOWN** — no number published |
| 8.2.3 | **PCM layout** of `pcm_24000`: 16-bit signed LE, mono? (decode ~1 s, expect **48000 bytes/s**) | Buffer decode + `pcmDurationMs` + seekFrame math | **UNKNOWN** — bit depth/channels not documented |
| 8.2.4 | `geffen_32` is on the **simba-3.2 voice allow-list** (`GET /v1/voices`, or the 2-curl test in `speechify-streaming-verdict.md` §5) | Wrong voice = 400/silent | **UNKNOWN** — verdict doc couldn't confirm |
| 8.2.5 | **byte-vs-char:** are `start`/`end` UTF-16 code units, Unicode scalars, or bytes? (test with "café — 5€") | Highlighting substring + Phase-3 note anchoring on non-ASCII | **UNKNOWN** |
| 8.2.6 | With `options.text_normalization:true`, do marks' `start/end` still point at the **original** "$5"/"3pm" span (not the expanded words)? | Highlighting correctness | **Doc-implied**, confirm on audio |
| 8.2.7 | Streaming word marks arrive **flat** (word-level) vs **nested** with sentence parents (`chunks`) | One line of the parser's `flatten` (§2.4) | **UNKNOWN** (batch nests; streaming likely flat) |

---

## 9. Sources

**Speechify (live, Aug 2026):**
- [Speech Marks guide — struct + streaming SSE (`speech.chunk`/`speech.done`, `audio`/`speech_marks`)](https://docs.speechify.ai/build/guides/text-to-speech/speech-marks)
- [Stream with timestamps — endpoint, request body, `options.text_normalization` default false](https://docs.speechify.ai/build/api-reference/v1/audio/stream/with-timestamps)
- [Streaming TTS guide — `/v1/audio/stream` (raw audio), Bearer auth, 20k char limit](https://docs.speechify.ai/build/streaming-tts-guide)
- [Create Speech (batch) — `output_format` values, `audio_data`, `options.text_normalization` default true, `type` field](https://docs.speechify.ai/build/api-reference/v1/audio/speech)
- [Changelog: simba-3.0/3.2 streaming model](https://docs.speechify.ai/tts/changelog/2026/5/9)
- Prior findings: `../techDocs/speechify-streaming-verdict.md` (July 2026: `/v1/audio/stream` is audio-only; hosts `api.speechify.ai` vs legacy `api.sws.speechify.com`; `pcm_24000` ~130 ms faster), `../techDocs/simba-stack-feasibility.md` (pricing: Free 50k chars, Starter $10/1M).

**Apple (verified):**
- [`AVAudioPlayerNode.scheduleSegment(_:startingFrame:frameCount:at:completionHandler:)` — first param is `AVAudioFile`](https://developer.apple.com/documentation/avfaudio/avaudioplayernode/schedulesegment(_:startingframe:framecount:at:completionhandler:))
- [`AVAudioPlayerNode.scheduleBuffer` — `AVAudioPCMBuffer`, plays whole buffer](https://developer.apple.com/documentation/avfaudio/avaudioplayernode)
- `AVAudioPlayerNode.playerTime(forNodeTime:)` / `lastRenderTime` (playhead); `AVAudioSession` category/mode; `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter` (Apple Developer Documentation).

**Project:** `listeninterrupt/ARCHITECTURE.md` §2/§4/§5, `DEVELOPMENT-PLAN.md` Phase 1, `../locked-screen-spike/` (Expo SDK 56, RN 0.85.3, dev-client).

---

## What I did NOT do / gaps (from the research agent)

- **No live curl run.** The SSE shape is confirmed from **live Speechify docs** (which upgrades ARCHITECTURE §2's "inferred" `audio_data`/`speech_marks` to doc-confirmed `audio`/`speech_marks`), but the step-0 curl was NOT executed (no API key; avoid spending Speechify credits per the credit-tracking memory). The 7 VERIFY items in §8.2 remain runtime-unconfirmed; TTFB, PCM bit-depth, `geffen_32` availability, and byte-vs-char are genuine UNKNOWNs.
- **Apple doc pages are JS-rendered** and didn't return body text to WebFetch; the `scheduleSegment` signature (file, not buffer) is confirmed via a secondary source + header text, unambiguous, but Apple's rendered page wasn't read directly.
- **Category decision (§6.1) is a flagged recommendation, not a locked call** — it pushes back on the brief's `.playAndRecord` for the reader-only phase (grounded in ARCHITECTURE §5's own A2DP/HFP fact); needs sign-off since it trades a future one-time category swap for Phase-1 audio quality.
- **Incremental first-paragraph playback** (the TTFB lever) is described but not fully coded — build synth-to-file first and add it only if measured TTFB (8.2.2) demands it.

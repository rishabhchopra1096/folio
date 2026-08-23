# Speechify Simba 3.2 — Phase 0, measured live

The implementation plan said this, and it was right:

> **No live Speechify call has ever been made in any of this research.** Everything
> about the response is a doc-reading. — `IMPLEMENTATION-PLAN-read-aloud.md:297`

They have now been made. Every number below came out of a real request on
24 August 2026, from this machine, against `simba-3.2` / `geffen_32`. **Two
findings change the architecture in the existing plan.**

## TL;DR

- **The batch endpoint is unusable for reading aloud. 12.5 seconds** to get a
  1,500-character chunk. The plan is built on `/v1/audio/speech`; it has to move
  to the streaming endpoint.
- **Streaming delivers first audio in ~800 ms**, and that figure barely moves
  with chunk size — it is a fixed floor, not proportional to text.
- **Buffering is a non-risk once started: audio arrives 6.6× faster than it
  plays.** Even at 3× playback there is 2.2× headroom.
- **Speech-mark offsets are UNICODE CODE POINTS.** Not UTF-16, not UTF-8. This
  was the plan's "single highest-impact unknown" and prior research contradicted
  itself. `text.slice(start, end)` is wrong and silently drifts one character
  per preceding emoji.
- **Marks are not deterministic.** The same request twice returns different
  audio *and* different timings. Cache the pair together; never re-request and
  assume alignment.
- **Speed: both routes work.** Client-side `playbackRate` is instant and free;
  server-side SSML `rate` is real re-synthesis, measured 2.12× at `+100%`, and
  the tags are not billed. The ceiling is +100%, so 3× is client-side only.
- **8 voices** support simba-3.2, confirmed against `/v1/voices` (988 total).

## 1. Latency — the finding that changes the design

| endpoint | text | first audio | complete |
|---|---|---|---|
| `/v1/audio/speech` (batch) | 1,500 ch | — (nothing until done) | **12,514 ms** |
| `/v1/audio/stream/with-timestamps` | 1,500 ch | **854 ms** | 11,119 ms |
| `/v1/audio/stream/with-timestamps` | 300 ch | **830 ms** | 2,838 ms |

Batch median over three runs was 12,514 ms (11,360 / 12,514 / 12,552). Nothing
is playable until the whole file lands, so batch means **twelve seconds of
silence** before a 1,500-character chunk starts. That fails the requirement
outright.

### First audio does not care how much text you send

| chars | first audio | fully downloaded | spoken length |
|---|---|---|---|
| 80 | 984 ms | 1,328 ms | 4 s |
| 150 | 1,038 ms | 1,957 ms | 9 s |
| 300 | 830 ms | 2,838 ms | 16 s |
| 600 | 836 ms | 4,623 ms | 30 s |
| 1,200 | 1,085 ms | 9,214 ms | 61 s |

**First audio sits at ~800–1,050 ms whatever you ask for.** That is the network
plus model floor. What scales is the *complete* time.

This decides how fast reading can start:

- **Play progressively (MediaSource):** start at **~850 ms**, any chunk size.
- **Accumulate the chunk, then play:** start at the *complete* time — so a small
  first chunk matters enormously. 80 chars → **1.3 s**; 300 chars → 2.8 s.

### No cold start

Four consecutive calls: 822 / 817 / 807 / 798 ms. There is no warm-up penalty to
hide, and no benefit to a keep-alive ping.

### Audio format is not a lever

300 chars, first audio: `pcm` 789 ms · `wav` 790 ms · `ogg` 810 ms · `aac` 836 ms
· `mp3` 886 ms. A ~100 ms spread. **Use mp3** — it is an order of magnitude
smaller than PCM and plays in an `<audio>` element without help. This also
settles the contradiction prior research left open about PCM being faster: it
is, by about a tenth of a second, which does not pay for the size.

## 2. Buffering — measured, and it is not a risk

For the 1,500-character chunk:

```
first audio 984 ms | fully downloaded 11,009 ms | spoken length 73 s
REALTIME FACTOR: audio arrives 6.6x faster than it plays
   headroom at 1x: 6.6x    at 2x: 3.3x    at 3x: 2.2x
```

Anything above 1.0 means playback can never catch the download. **In steady
state there is no buffering at any speed the UI offers.**

The risk is confined to the *start*, and it is a real one. Worked through at 3×:

- Chunk 1 = 80 chars → 4 s of speech, which at 3× lasts **1.33 s**.
- It becomes playable at 1.3 s, so it finishes at **2.6 s**.
- Chunk 2 = 600 chars needs 4.6 s to download.

Requesting chunk 2 only after chunk 1 arrives gives a **2-second gap**. So:
**fire chunk 1 and chunk 2 concurrently at t=0**, and keep two chunks in flight
whenever rate ≥ 2×. Then chunk 2 is ready at 4.6 s against chunk 1 ending at
2.6 s — still short at 3×, which is why chunk 1 should be ~150–300 chars rather
than 80, and why the rate chip should not jump straight to 3× on a cold start.

## 3. The offset index space — CODE POINTS

The decisive test isolates words *after* an astral character, because before one
every index space agrees. Input: `"Alpha 🎨 bravo charlie delta echo."`
(utf16 34, codepoints 33, utf8 36).

```
  [ 0, 5)  value="Alpha"    utf16="Alpha"      codepoint="Alpha"
  [ 8,13)  value="bravo"    utf16=" brav"      codepoint="bravo"
  [14,21)  value="charlie"  utf16=" charli"    codepoint="charlie"
  [22,27)  value="delta"    utf16=" delt"      codepoint="delta"
  [28,33)  value="echo."    utf16=" echo"      codepoint="echo."

  every mark matches its value in UTF-16 slice:    false
  every mark matches its value in codepoint slice: true
```

**Verdict: Unicode code points.** Every mark round-trips exactly through
`[...text].slice(start, end).join("")` and every one is wrong through
`text.slice(start, end)`.

Note how the UTF-16 slice fails: it is off by exactly one, and it looks
*almost* right — `" brav"` instead of `"bravo"`. On a document with 119 emoji
(the user's own `sample_docs/md.md`) the drift reaches ~1,830 characters by the
end. **This is the bug that would have shipped**, and the earlier
"probe by comparing the last offset to the length" heuristic in the plan happens
to give the right answer here but proves nothing on text with no astral
characters.

**Rule: convert every mark to UTF-16 once at ingest, then never think about it
again.** Build the code-point array once per chunk; converting is an index
lookup, not a re-scan.

### Emoji themselves get no mark

In `"The cost — $5 — rose 20% → 'twice'. Emoji: 🎨 done."` there were 13 word
marks, **none** containing an emoji, and **zero** zero-duration marks. Emoji are
skipped silently rather than producing empty marks. Nothing to defend against —
but it means a highlight cannot land on an emoji, which is correct behaviour
anyway.

## 4. Response shapes

Batch `/v1/audio/speech` — top-level keys:
`audio_data`, `audio_format`, `billable_characters_count`, `speech_marks`.

`speech_marks` is an **object**, not an array, with keys
`chunks, end, end_time, start, start_time, type, value`. The outer object is the
whole utterance; `chunks` holds the word-level marks:

```json
{ "end": 3, "end_time": 213, "start": 0, "start_time": 0,
  "type": "word", "value": "The" }
```

Streaming `/v1/audio/stream/with-timestamps` — SSE `data:` events with fields
`type, audio, speech_marks, billable_characters_count, audio_duration_ms`.

**The field-name split is real and is the documented parser trap:** batch says
`audio_data`, streaming says `audio`. Handle both.

The stream is *chatty* — 2,798 audio events for 1,500 characters, ~1.1 MB of
base64. Each event is a small mp3 fragment. `billable_characters_count` and
`audio_duration_ms` arrive alongside, so cost and progress are free to track.

There is no `x-speechify-billable-characters-count` response header; the count
is in the body.

## 5. Marks are not deterministic

Two byte-identical requests:

```
speech marks identical: false
audio bytes identical:  false
```

The model samples. **Consequence: cache the audio and its marks as one unit,
keyed by (text, voice, model).** Never re-request audio for text you already
have marks for, and never re-request marks for audio you already have — they
will not line up.

This makes the cache *more* important, not less: it is the only thing
guaranteeing that a re-read of the same paragraph highlights identically.

## 6. Speed — both routes, measured

Same 300-character sample, voice Geffen:

| how | request | spoken length | effective rate | billed chars |
|---|---|---|---|---|
| plain, 1× | 3,981 ms | 17,160 ms | 1.00× | 300 |
| SSML `rate="+50%"` | 3,652 ms | 10,504 ms | **1.63×** | 300 |
| SSML `rate="+100%"` | 3,099 ms | 8,111 ms | **2.12×** | 300 |
| SSML `rate="-25%"` | 4,104 ms | 21,542 ms | **0.80×** | 300 |

Three things worth keeping:

1. **SSML tags are not billed.** 300 chars sent, 300 chars billed, markup and
   all. Server-side speed is free of surcharge.
2. **The stream endpoint accepts SSML too** (HTTP 200), so this is not a
   batch-only escape hatch.
3. **`+100%` is the documented ceiling** (`api-speechify-raw.md:217`, range
   −83%…+100%), so **3× is only reachable client-side**.

### Which to use

**Client-side `playbackRate`, by default.** It is instantaneous, free, needs no
new request, and the existing plan's §4 spec argument holds: `playbackRate`
changes how fast `currentTime` advances, not what it means, so speech marks stay
in the same units and sync is automatic. `preservesPitch` defaults to true and
is required by spec, so there is no chipmunk.

**What I cannot settle from here is whether it *sounds* good to you at 2×–3×.**
Pitch correction is guaranteed; the artefacts of time-stretching are a matter of
taste and of the browser's stretching algorithm. A listening test was generated
(`speechify-speed-test.html`) with the same sentence three ways: synthesised at
1× and sped up in-browser, versus synthesised server-side at +50% and +100%.
**That comparison is the input to the decision below.**

If client-side is acceptable → speed is a one-line feature.
If it is not, above some rate → re-synthesise at that rate, accepting ~850 ms
before audio resumes and a hard 2× ceiling. Design the module so the rate
setter can switch strategies without anything else changing.

## 7. Voices

988 voices total; **8 support simba-3.2**:

| id | name | gender | locale |
|---|---|---|---|
| `beatrice_32` | Beatrice | female | en-GB |
| `dominic_32` | Dominic | male | en-US |
| `edmund_32` | Edmund | male | en-GB |
| `geffen_32` | Geffen | female | en-US |
| `harper_32` | Harper | female | en-US |
| `hugh_32` | Hugh | male | en-GB |
| `imogen_32` | Imogen | female | en-GB |
| `wyatt_32` | Wyatt | male | en-US |

English only, US and GB. **A non-English document has no simba-3.2 voice** —
that is an edge case the UI has to name rather than fail on.

## 8. What this changes in the existing plan

| plan said | measurement says |
|---|---|
| §3 flow uses `POST /v1/audio/speech` | **Must be `/v1/audio/stream/with-timestamps`.** Batch is 12.5 s. |
| §5 probe auto-detects the index space, "falling back to utf16" | **It is code points.** Keep the probe as an assertion, but the fallback should be codepoint, and a mismatch should be loud. |
| §6 chunks of 1,200–1,800 chars | Right for steady state, **wrong for the first chunk** — that one wants ~150–300 chars, because without progressive playback the start cost is the *complete* time. |
| §11 "latency 831 ms measured from India" | Confirmed locally: ~800 ms to first audio. The 12.5 s batch figure is the one that was never measured. |
| §3 one-chunk lookahead | **Two in flight at rate ≥ 2×**, and chunk 2 requested at t=0 rather than after chunk 1 lands. |
| §12 Q4 "does batch return marks by default" | Yes, unflagged, on both endpoints. |
| §12 Q5 determinism | **No.** Cache the pair. |
| §12 Q6 emoji | Skipped, no marks, no zero-duration entries. |

## 9. Cost, from the meter rather than the price list

`billable_characters_count` is returned per request and counts the characters
**sent**, with SSML markup excluded. At the documented $6–10 / 1M characters:

- a 10,000-word document ≈ 55,000 chars ≈ **$0.33–0.55** for a full read
- re-reading from cache: **$0**
- changing speed client-side: **$0**
- changing speed server-side: a fresh charge for the re-synthesised chunk only

## Reproducing this

The probes live in the session scratchpad (`speechify-phase0.js`, `phase0b.js`,
`phase0c.js`, `phase0d.js`) and read the key from `SPEECHIFY_API_KEY`.

**The key is never written to a file in this repo, and must not be.** This repo
is public and `sk_…` keys are exactly what secret scanners look for. It belongs
in `localStorage` alongside `folio_groq_key` and `folio_gemini_key`, entered
through Settings. The key used for these measurements was pasted into a chat
transcript, so **it should be rotated** at the Speechify dashboard before it
goes anywhere near production.

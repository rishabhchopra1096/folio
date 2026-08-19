# Why the transcripts are bad, and what actually fixes it

Research done because two consecutive videos came back with large stretches of
invented content. Everything below is measured, not assumed.

## TL;DR

- **Gemini full-video transcription hallucinates badly.** Two confirmed cases:
  28 minutes fabricated on a 52:37 video, ~14 minutes on a 35:58 video.
- **YouTube's own auto-captions are excellent** — 746 cues, 99.8% coverage,
  accurate — and the caption endpoint even allows CORS from our origin.
- **But we cannot get them in the web app.** YouTube serves a bot-gated page to
  datacenter IPs (measured on Vercel: no caption tracks at all), and plain
  fetches from anywhere land in an experiment that returns 0 bytes.
- **Chunking fixes the hallucination.** The same window that fabricated 14
  minutes came back 94–99% unique with no loop when requested as a clip.
- **The loop detector missed the second loop** because the repeated lines varied
  by their NUMBERS. Collapsing digit runs before comparing catches it.

## Measurements

### 1. The loop is real and large

| video | length | transcript claims | fabricated |
|---|---|---|---|
| TJgg3eMUp7M | 52:37 | up to 1:21:01 | ~28 min |
| w9b-bIKGp4U | 35:58 (2158s) | looped from ~10:31 | ~14 min |

The second one loops *inside* the video's duration, so the duration backstop
cannot catch it, and it varies by number every cycle, so verbatim matching
cannot either.

### 2. YouTube's captions are what we actually want

`yt-dlp` on this machine, video w9b-bIKGp4U:

```
caption cues: 746
first cue 3.9s, last cue 2153.8s  -> 99.8% coverage of a 2158s video
distinct cues: 616 / 746 (82.6% unique)
```

Spot-checked at 10:31, 20:07 and 24:31 — the moments Gemini invented a battle
loop — and the real content is completely different. Free, instant, accurate.

### 3. Why we still cannot use them in the browser

| attempt | result |
|---|---|
| `timedtext` URL scraped from the watch page | HTTP 200, **0 bytes** |
| same URL, various headers / `hl` / `bpctr` | 0 bytes — always `exp=xpe` |
| unsigned `timedtext?v=…&lang=en` | 0 bytes |
| InnerTube WEB / MWEB player endpoint | `UNPLAYABLE`, 0 tracks |
| InnerTube ANDROID / IOS | HTTP 400 |
| **yt-dlp's own URL, plain curl** | **HTTP 200, 452 KB** |
| watch page fetched **from Vercel** | **no `captionTracks` at all** |

Two conclusions. The caption data itself is reachable from a browser — the
endpoint returned `access-control-allow-origin: https://folio-six-sigma.vercel.app`
— so CORS is not the obstacle. The obstacle is *obtaining a working signed URL*,
which currently needs yt-dlp's maintained workarounds and a residential IP.
A Vercel function cannot do it: YouTube bot-gates the page for cloud IPs.

That leaves captions viable **only in the Electron build**, which runs on the
user's own machine and IP.

### 4. Chunking fixes the hallucination

Window 600–1200s of w9b-bIKGp4U — precisely where the real run went wrong:

| request | segments | unique | longest repeat streak | time |
|---|---|---|---|---|
| whole video, temp 0 (what shipped) | — | — | ~14 min fabricated | 551s |
| clip 600–1200, temp 0.0 | 146 | 94% | 2 | 69s |
| clip 600–1200, temp 0.4 | 121 | 99% | 1 | 34s |

Two effects, both worth having: a bounded context stops the model drifting into
a cycle, and non-greedy decoding (temperature above 0) further reduces
repetition — greedy decoding is the textbook cause of degenerate loops. The
0.4 run was also **twice as fast**.

### 5. Timestamps: the clip must be told where it sits

The first chunked attempt returned every timestamp between 0 and 56 for a 600s
window — useless for anchoring a comment. The cause was the prompt, not the
model. Two phrasings over the same 300s window:

| phrasing | segments | range | monotonic | verdict |
|---|---|---|---|---|
| "seconds from the start of this clip" | 51 | 0.0–398 | yes | overshoots the window ✗ |
| **"this clip begins at 600s; use whole-video seconds"** | 47 | **600.0–875.0** | yes | correct ✓ |

Telling the model where the clip sits in the whole video is load bearing. The
old prompt asked for "seconds from video start" while giving no offset, so the
model had no way to comply.

### 6. Accuracy, scored against the ground truth

The 600–900s window, compared with YouTube's own captions for the same window:

```
precision  96%   (Gemini's vocabulary that appears in the real captions)
recall     95%   (real caption vocabulary Gemini recovered)
unique    100%   (no repetition at all)
timestamps: all inside the window
```

Near caption quality, from the model, in the browser, with no backend.

## Decisions

1. **Chunk the video** rather than asking for it in one request.
2. **Temperature off 0.**
3. **Detect loops on digit-collapsed text**, so a cycle that only varies by its
   numbers is visible. Plus a deliberately brutal saturation check (3 or fewer
   distinct lines in 40) as a backstop.
4. **Keep the detector biased against false positives.** This user's material is
   Pokemon grinding, which genuinely repeats stock phrases — and once digits are
   collapsed those look identical. Chunking already bounds the damage a missed
   loop can do, so the detector should never cut a real transcript short.
5. Captions via yt-dlp remain the best answer **for the Electron build**, and
   are worth doing there later. Not possible in the web app.

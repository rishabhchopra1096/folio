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

---

# Part 2: is it a document you can read INSTEAD of watching?

That is a different and harder target than "an accurate transcript", and the
answer for what shipped is **no**.

## The evidence

The 600–900s window of a Pokemon playthrough, from the shipped prompt:

```
total lines : 47
[shows]     : 0   (0%)
spoken      : 47
words       : 649  (130/min — roughly raw speech rate)
```

**Zero visual lines across five minutes of a video whose content is almost
entirely visual.** A reader gets "219 experience and now level 14" and "I
learned poison sting" with no idea what was fought, what was chosen, or what
happened. One line is garbled speech recognition that means nothing without the
picture.

This is an over-correction I introduced. The fabricated stretches lived in the
'[shows]' lines, so the prompt was changed to stop transcribing on-screen text
verbatim — and the model responded by dropping visual description altogether.
Hallucination was traded for emptiness.

## The tension to manage

More visual detail and less invention pull against each other, and both ends
have now been observed:

| prompt | visual detail | invention |
|---|---|---|
| "read on-screen text exactly" | high | ~14 min fabricated |
| "describe briefly, omit what you cannot read" | **zero** | none |

The resolution is not a midpoint on that axis. It is to ask for a different
KIND of line: describe what is HAPPENING (state, action, outcome) rather than
quote what is WRITTEN. A model at one frame per second can see that a menu was
opened and a Pokemon was healed; it cannot read the dialogue box reliably.

## What "readable instead of watchable" requires

1. **Visual coverage** — a description whenever what is on screen meaningfully
   changes, not just when the narrator pauses.
2. **Self-containment** — no unresolved "this guy", "over here", "that one".
   If the narrator says it, a nearby line must have already named it.
3. **Faithfulness** — describe what is genuinely visible; never quote text that
   cannot be read.
4. **Still timestamped per line** — comment anchoring and video sync depend on
   it, so this stays a sequence of timestamped lines, not prose sections.

## How the candidates are scored

- `visual%` — share of lines describing the screen
- `maxVisualGap` — longest stretch of video with no visual line at all
- `words/min` — density; a document should be richer than raw speech
- `vague` — count of unresolved deictic phrases
- `unique%` — repetition, digit-collapsed
- `inRange` — timestamps still land inside their window

---

# Part 3: making it a narrative you can read instead of watching

## What the models actually do

One 5-minute window, words written per minute of video. The speech itself runs
at about **146 wpm**, so anything below that is dropping what was said, never
mind what was shown.

| model | prompt | media detail | wpm | max blind gap |
|---|---|---|---|---|
| 2.5-flash | old (shipped) | default | 105 | 41s |
| 3.5-flash | dense narrative | HIGH | 76 | 15s |
| 3.7-flash | dense narrative | HIGH | 94 | 15s |
| 2.5-flash | dense narrative | HIGH | 156 | 30s |
| 3.1-pro | dense narrative | default | 164 | 45s |
| **3.1-pro** | **dense narrative** | **HIGH** | **262** | **15s** |

Two findings worth keeping:

**Every flash model summarises, however it is asked.** Prompt changes moved
them between 76 and 156 wpm and no further. Only pro writes an account dense
enough to stand in for watching.

**`mediaResolution` was never set, and it is the biggest single lever.** Same
model, same prompt, default vs HIGH: 164 → 262 wpm, and the longest stretch
with nothing described drops from 45s to 15s.

## Supplying the real speech transcript helps fidelity

Handing the model YouTube's own captions alongside the video, so it does not
have to do speech recognition at all:

| | wpm | speech recall |
|---|---|---|
| 3.1-pro, HIGH detail, blind | 262 | 79% |
| 3.1-pro, HIGH detail, **+ captions** | 206 | **85%** |

Captions trade a little density for noticeably better fidelity, and they fix
garbled speech recognition. Not shippable in the web app — see Part 1 for why
the captions cannot be obtained there — but the right thing to do in Electron.

## What shipped, measured end to end

Through the real code, first 10 minutes of the video that failed:

```
model=gemini-3.1-pro-preview   95s for 10 minutes of video (2 windows, 2 at a time)
lines=39  words=1780  wpm=178  maxGap=30s  unique=100%  monotonic=true
speech recall=71%   half the vocabulary is visual description
```

Against the 105 wpm and 41s blind gaps of what it replaces.

## Cost, honestly

Per 5-minute window: ~87k input tokens, ~1.5k output, ~4k thinking. A
36-minute video is about 7 windows:

| | per 36-min video |
|---|---|
| old: 2.5-flash, default detail | ~$0.35 |
| new: 3.1-pro, HIGH detail | **~$1.20** |

Roughly three and a half times the cost, for the difference between a document
that works and one that does not. The model is overridable in localStorage
(`folio_gemini_model`) for anyone who would rather pay less.

## Known weakness

`gemini-3.1-pro-preview` is a preview model and runs out of capacity: a live
run lost a whole five-minute window to a 503. Windows now retry with backoff
(4s, 12s, 30s) rather than leaving a hole. That retry path has NOT been
exercised live — the repeat run got no 503s.

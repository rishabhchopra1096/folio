# The Pokémon transcript: what actually went wrong

Two independent bugs, one of which is much worse than reported.

## TL;DR

- The transcript is not "cut off at 11:49" — **Gemini fell into a verbatim
  repetition loop at ~7:42 and fabricated 28 minutes of transcript past the end
  of the video.** Video is 52:37; the transcript runs to 1:21:01.
- Comment timestamps in the export are wrong because the export matches a
  comment to the **first line whose text matches** — and the looped text
  matches ~83 identical lines. The panel (20:14, 25:32) is right; the export
  (6:50) is wrong.
- Navigation was already fixed in `021574b` and is deployed. If it is still
  stuck, it is because the page has not been reloaded since.

## Evidence

From the user's own export + screenshot, no inference needed:

| Fact | Value |
|---|---|
| Video duration (screenshot) | 52:37 = 3157s |
| Last transcript timestamp | 1:21:01 = 4861s |
| Fabricated tail | 1704s ≈ 28 min past the end |
| Loop starts | ~7:42 |
| Cycle length | 9 segments, ~53s apparent |
| Approx. fabricated cycles | ~83 |

The repeating cycle, verbatim:

```
All right, Nidoran was caught.
[shows] 'New Pokédex data will be added for Nidoran♂!' …
Excellent. No nickname. So actually, I need to catch two of these …
So I'm actually going to catch this one as well.
[shows] The player selects 'FIGHT' and then 'GUST'.
Wow, critical hit. All right.
I'll do one more Gust here …
I might die.
[shows] The player selects 'Poké Ball'.
```

This also explains the 551s transcription time measured earlier — most of it
was the model spinning in this loop.

## Root causes

**1. No loop detection.** `transcribeYouTube` streams JSONL and pushes every
line. A degenerate model loop is emitted faithfully for as long as it lasts.

**2. No duration sanity check.** Nothing compares a segment's start against the
video length, so timestamps 28 minutes past the end were accepted.

**3. `exportTranscript` anchors comments by text, first match wins**
(`js/comments.js:848`). Correct for a normal transcript, catastrophic when the
same sentence appears 83 times.

**4. `addComment` throws away `videoTime` whenever a highlight exists**
(`js/comments.js:490`, `&& !highlightId`). `tts.js:1001` passes the moment in;
it is discarded. So a comment made *after* the transcript arrived has no
timestamp at all, and the export has nothing to anchor to but text.

The two comments in question survived only because they were dictated *before*
the transcript reached them — so they kept a `videoTime`, which is why the panel
shows the truth while the export does not.

## Fixes

| # | File | Change |
|---|---|---|
| 1 | `js/gemini.js` | Detect a verbatim cycle (ordered mirror run ≥ 18, wrap-aware) → stop the stream, keep everything before the loop |
| 2 | `js/video.js` | Drop segments past the video duration; clamp every seek to it |
| 3 | `js/comments.js` | Anchor comments by `videoTime`; text match only as fallback |
| 4 | `js/comments.js` | Always store `videoTime`, highlight or not |
| 5 | `js/tts.js` | Always capture the moment; carry it through the offline retry queue |
| 6 | `js/comments.js` | Show the comment's own timestamp in the export |

## Detector design

A naive "consecutive repeated text" streak false-positives badly on this exact
content — a Pokémon video legitimately repeats "Wow, critical hit." many times.
So the detector requires an **ordered** mirror: segment *n* repeats earlier
segment *j*, *n+1* repeats *j+1*, and so on, with a wrap when the cycle
restarts. Genuine speech does not repeat 18 sentences in the same order.

Threshold 18 fires late in the third cycle of a 9-segment loop — early enough
to save ~80 cycles of generation, conservative enough not to cut a song chorus.

Nothing is deleted: the transcript is truncated at the point the loop began,
which makes it "incomplete", which is exactly the state the Retry button
already handles.

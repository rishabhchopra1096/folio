# Video implementation audit

Triggered by: "it takes so long, then it vanishes, then it's not synced well,
sometimes the entire transcript is not there, and it keeps reloading the page."

Method: read the whole path end to end rather than patching symptoms. Findings
are numbered, located, and tied to the symptom that reported them.

---

## F1 — The YouTube player is destroyed and rebuilt every 1.5 seconds
**Severity: critical. Explains "keeps reloading", "not synced", "vanishes".**

`js/video.js:131` `attach()` starts with an unconditional `detach()`, then
constructs `new YT.Player(...)` with `playerVars.start = startAt`.

`js/reader.js:202` calls `Video.attach()` on every `renderDocument()`.

`js/video.js` `writeBlocks()` calls `Reader.renderDocument()` on every
streaming write, and the stream flushes **every 1500ms**
(`js/gemini.js` `flush()` throttle).

So while a transcript streams in, roughly every 1.5 seconds:

1. the player is torn down,
2. a new iframe is created and reloaded from YouTube,
3. playback resets to `start` (normally 0),
4. `segTimes` is rebuilt from scratch,
5. scroll position and the whole article DOM are replaced.

This is almost certainly the entirety of "it keeps reloading the page". It also
makes sync meaningless while transcribing, because the playhead keeps being
reset, and it makes the video unwatchable during the very period the user most
wants to watch it.

**Fix direction:** `attach()` must be idempotent. If a player already exists
for the same video id and the holder is still in the DOM, re-index the
transcript and leave the player alone. Better still, do not re-render the whole
document for a streaming append at all — append the new paragraphs.

---

## F2 — A full document re-render for an append
**Severity: high. Contributes to F1 and to scroll/selection loss.**

Streaming appends lines to the end of a transcript, but the implementation
rewrites every block and re-renders the entire document each time. Consequences
beyond F1: text selection is lost mid-gesture, highlights are re-applied
(`Highlights.applyHighlights`), and the TTS index is rebuilt
(`js/reader.js:196`), all several hundred times over a long video.

**Fix direction:** render appended lines incrementally; full re-render only
when the document actually changes shape.

---

## F3 — Latency is per-request, so 5-minute windows doubled the wait
**Severity: high. Explains "takes so long".**

Measured from the user's own log, time to first response byte:

| configuration | median |
|---|---|
| flash, 600s windows | ~57s |
| pro, 300s windows | ~110s |

The cost is dominated by per-request video processing, not by window length.
Halving the window from 600s to 300s therefore doubled the number of requests
without halving each one. A 44-minute video went from 5 requests to 9.

Whole-video totals from the log: **6m51s** (flash, 600s windows, clean run)
versus **11m01s** (pro, 300s windows, though that run was also fighting two
duplicate runs — see F4).

**Fix direction:** verify quality holds at 600s windows and go back to them;
consider a lower thinking level (the log shows 3k–15k thinking tokens per
window, which is pure latency).

---

## F4 — Duplicate concurrent runs (fixed, listed for completeness)
Three runs on one document overlapped for 11 minutes, each doing all windows.
Fixed by a shared, expiring lease. Was a major contributor to both the slowness
and the rate limiting.

## F5 — Out-of-credit reported as a rate limit (fixed, listed for completeness)
`429` is returned both for real rate limits and for "prepayment credits are
depleted". The real message was discarded and the failure retried. Fixed.

## F6 — Thinking tokens consumed the output budget (fixed)
`maxOutputTokens` was 16,384; two windows spent 15.7k of it thinking and wrote
five lines. Raised to 65,536.

---

---

## Cleared — suspected and checked, NOT bugs

Recording these so they are not re-investigated:

- **`restructure()` bailing on re-render.** `article.dataset.videoLayout`
  survives `innerHTML` replacement, which looked like it would make every
  render after the first skip the video layout entirely. It does not:
  `detach()` deletes the flag (`js/video.js:371`), and `attach()` calls
  `detach()` first.
- **Accumulating listeners.** `initShortcuts()` guards on
  `document.body.dataset.videoKeys` and `initTranscriptClicks()` on
  `article.dataset.videoClicks`, so neither stacks up across renders.
- **Click-to-seek delegation.** Bound once to `#article`, which survives
  `innerHTML` replacement, so delegation keeps working.

---

## Fixed in this pass

**F1 and F2.** Streaming writes now persist to storage and then APPEND the new
lines to the live transcript, instead of re-rendering the document. The player
is never touched, so playback, scroll position, text selection and the active
line all survive. Completion appends too, so the video is not reloaded at the
moment the transcript finishes. A full render remains as the fallback when
there is no live layout to append into.

Model output is appended with `createTextNode`, not `innerHTML` — it is not
our markup and must not be treated as such.

## Still to audit

- [ ] transcript click-to-seek and the active-line sync loop
- [ ] `restructure()` and what it does on repeat calls
- [ ] the TTS clock seam and dictation interaction
- [ ] comment anchoring against a transcript that is still growing
- [ ] error and empty states the user actually sees
- [ ] keyboard handling and focus

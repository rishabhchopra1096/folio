# Video transcription: what we know, and what to do next

Written after a day of chasing this in the wrong places, and after producing 36
working narrative files outside Folio. Everything in "What we measured" is a
number I actually took, not a belief.

## TL;DR

- **The captions are the clock.** The model cannot tell the time in a video;
  given the captions' timings to copy, it becomes accurate. 563s → 16s error.
- **Caption-free is not viable.** Bounding the error with short windows works
  structurally, but a 64,000-token fixed cost per request makes it 2–6× more
  expensive for an error bound still measured in minutes.
- **Folio cannot fetch captions itself.** Three independent routes tested and
  closed. They have to be handed to it.
- **So: build transcript INTAKE first** (paste + import). It is small, unblocks
  the 36 files that already exist, and every later phase depends on it anyway.
- **Then a local helper** makes the intake automatic without a server, a third
  party, or credentials.

## What we measured

| Question | Method | Result |
|---|---|---|
| Can the model timestamp a long video? | whole video, one request, event markers with known times | **No.** 42 min compressed into 0–20:15; a 38:49 scene placed at 0:30; median error **563s** |
| Do the captions fix it? | same request, captions supplied, "copy a timestamp" rule | **Yes.** Median error **16s**, 100% of timestamps copied, full coverage |
| Does it hold at scale? | 36 videos, 26.4 hours | 3,384 entries, coverage **97% min / 99% median**, no gaps > 3 min |
| Is `startOffset` honoured? | request 30:00–40:00, check for late-only markers | **Yes** — genuine late content, no early markers |
| Is `endOffset` honoured? | token count for a 10-min window | **Yes** — 222k, not the ~739k a 42-min video costs |
| Was the density quota causing invention? | with and without the words-per-minute target | **No.** Removing it made grounding slightly worse; output runs *below* the real speech rate |
| What does a request cost? | 3 window sizes, same video | **64,094 tokens fixed + 65.9 per second of video** (three points, one line) |
| Can a browser fetch captions? | iframe player caption module | **No.** `tracklist=[]`, `track.is_servable=false` |
| Can a server fetch them? | yt-dlp on Vercel | **No.** "Sign in to confirm you're not a bot" |
| Can this machine? | yt-dlp locally | **Yes** — used 36+ times today |

### One measurement that failed

An attempt to measure how timestamp error scales with window size returned
errors *larger than the window*, which is impossible when the model only
received that window. The aligner was matching narrative prose against raw ASR
on 4–5 rare words against 170 candidate positions, and spurious matches
dominated — only 4 of 18 lines could be placed at all. **It is not evidence of
anything** and no decision here rests on it.

The bound itself does not need measuring: a model that only sees seconds
[a, b], and whose out-of-range timestamps are discarded, cannot place content
outside [a, b]. That is arithmetic. The open question was only how much
*better* than the bound it does — and the cost model settles the matter before
that question needs an answer.

## Why caption-free loses

The 64k fixed cost per request is the whole story. Halving the window does not
halve the error for free — it nearly doubles the price:

| window | requests for 42 min | cost | error bound |
|---|---|---|---|
| whole video | 1 | $0.12 | none — measured 563s |
| 600s | 5 | $0.26 | 10 minutes |
| 300s | 9 | $0.38 | 5 minutes |
| 120s | 22 | $0.79 | 2 minutes |
| **whole video + captions** | **1** | **$0.16** | **measured 16s** |

An anchor that can be five minutes out is useless for attaching a comment to
what was being said. Captions win on both axes at once, which is rare enough
to be worth trusting.

---

# The plan

## Phase 1 — Transcript intake (do this first)

**Why first:** it is the smallest piece, it unblocks the 36 files that already
exist, and every other phase produces a transcript that has to enter Folio
through it.

Folio can already render timed transcript blocks — a paragraph block carrying
`data.t` drives the sync, the click-to-seek and the comment anchoring. What is
missing is any way to *create* those blocks from text. `markdownToBlocks`
produces none.

Build:
- A parser for `**[MM:SS]** text` and `[MM:SS] text` lines → paragraph blocks
  with `data.t`, attached to a video block.
- Two ways in: paste into a box on the video page, and import a `.md` file.
- Accept YouTube's own transcript format too (`0:15\ntext`), since that is
  what the "Show transcript" panel copies.

**Cost:** none. **Risk:** low. **Test:** round-trip one of the 36 files and
confirm the timestamps drive sync and anchoring.

## Phase 2 — Rework generation around the captions

Replace the current chunk-and-hope generator with what the batch script does:

- One request, whole video, no offsets.
- Captions supplied with their timings; every `start` must be **copied** from
  them, never invented.
- **Validate**: discard any timestamp not present in the caption list. This is
  not belt-and-braces — episode 32 produced two invented timestamps past the
  end of the captions, and the check caught them.
- **Top-up loop**: if coverage < 95%, request the uncovered stretch with the
  video windowed to it. Long videos silently stop early — episode 28 covered 56
  of 134 minutes on the first attempt and reported `STOP`, not `MAX_TOKENS`.
  Windowing is safe *here* only because the clock comes from the captions.
- Thinking low; it is faster, cheaper and denser than thinking on.

**Cost:** ~$0.16 per 45-minute video. **Test that would have caught this bug on
day one:** pick 5 events with known times, assert each lands within 60s.

## Phase 3 — A local helper, so intake is automatic

The web app runs in a browser on a residential connection but cannot read
youtube.com. This machine can. Folio already ships an Electron build with a
main process that makes privileged network calls.

Have it expose `http://127.0.0.1:<port>/captions?v=<id>` with permissive CORS.
The web app tries it and falls back to the paste box when it is not running.
Browsers exempt `localhost` from mixed-content blocking, so an https page may
call it.

**Why this over the alternatives:**
- No credentials. The cookies route would work and puts a Google session on a
  host; the blast radius if it leaks is the whole account.
- No third party. Transcript APIs exist and maintain residential proxy pools;
  they cost money and add a dependency to a personal tool.
- No datacenter IP, which is the thing that is actually blocked.

**Risk:** only helps while the helper runs — hence the paste fallback.

## Phase 4 — Optional: move generation into the helper

If the helper is running anyway, it can own the whole job: fetch captions, call
Gemini, run top-ups, write the document. That removes, rather than fixes:

- runs dying when the tab closes (the pending registry, the resume logic)
- duplicate concurrent runs (the cross-tab lease)
- the API key living in the browser
- failures that need you present to retry

**Tradeoff:** Folio's video feature becomes good only with the helper running.
Worth doing only if the helper earns its keep in Phase 3.

## Phase 5 — Delete what the old design needed

Once the clock is real, several things exist only to paper over its absence:

- chunk planning and `startOffset`/`endOffset` as the *primary* mechanism —
  keep windowing solely for top-ups
- the duration backstop that drops lines past the end of the video
- most of the repetition-loop machinery — worth keeping the cheap
  digit-collapsed check, but it was built to catch a failure mode that the
  captions largely remove

Deleting these is the point. Each was a patch on a broken foundation.

## What I would not do

- **Cookies on a server.** Works. Not worth your account.
- **A cloud function fetching captions.** Measured: bot-gated, even via yt-dlp.
- **Shrinking windows to buy accuracy.** The cost model says no.
- **More prompt engineering against the timestamp problem.** A day of it moved
  nothing; supplying the clock moved everything.

## The lesson worth keeping

Every check I wrote passed while the feature was broken, because I was
verifying the wrong property — that timestamps fell *within the requested
range*, and that words *overlapped the captions*. A confabulating model
satisfies both. The check that mattered was "does the event at 38:49 appear at
38:49", it cost one cheap test, and it would have ended this on the first
morning.

---

# Phases 4 and 5 — done

## The fallback is gone

Captions are now required. Without them `transcribeYouTube` refuses, says why,
and points at the helper or at Import. It no longer produces a document.

That is a deliberate refusal, not a missing feature. A caption-free run reads
perfectly well and anchors every comment 563 seconds out — a plausible wrong
answer, which is exactly what cost a day of chasing symptoms instead of causes.
An honest failure you can act on beats a convincing one you cannot see.

Deleted with it, because every one of them existed to make guessed timestamps
survivable rather than to make the guesses right:

| gone | what it was for |
|---|---|
| `planWindows`, `windowCovered`, `CHUNK_SEC`, `MAX_WINDOWS`, `CONCURRENCY` | splitting a video into windows so drift was bounded |
| `transcribeWindow`, `parseJsonlLine`, `promptFor` | the streamed per-window request |
| `newLoopWatch`, `loopKey`, `LOOP_*` | catching a model that repeated itself |
| `trimToDuration` | dropping lines stamped past the end of the video |
| `normalizeSegments`, `toSeconds`, `dedupeSorted` | coercing free-form timestamps into numbers |
| `describeError`, `MEDIA_RESOLUTION` | supporting machinery |

`js/gemini.js` 1300 → 531 lines. Two whole test suites went with the code they
covered — the repetition-loop detector and the streaming path — which is why
the assertion count falls; nothing living lost coverage.

## Lease released on unload

A tab that died mid-run held its claim for the full ninety seconds, so a reload
showed "Transcribing…" and refused to restart, reporting that another run held
the document when that run had died with the page. The claim is now dropped on
pagehide and beforeunload, scoped to claims that page owns — releasing all of
them would free one another tab was actively running.

## Still open

- **Generation still runs in the browser.** Closing the tab mid-run loses the
  request; the work is re-done, not lost. Moving it into the helper would fix
  that and would delete the pending registry and the lease as well. It also
  makes the helper mandatory for transcription, which is a real trade.
- **The helper must be started by hand.** A launch agent is written but not
  installed; something that runs at every boot should be a deliberate choice.

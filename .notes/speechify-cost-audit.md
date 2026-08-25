# Speechify cost + UX audit

**Goal:** find every path that spends money it needn't, and every use case that
isn't coded for. Reading start-to-finish is the easy case; everything else is
where the bill and the experience actually live.

**Method:** read the implementation one file at a time, fully, recording what
each read establishes BEFORE opening the next. Then enumerate real usage
patterns and walk each one through the code that would actually run.

**Status: IN PROGRESS**

## Read log

- [ ] `js/speechify.js` — the provider (in chunks)
- [ ] `js/tts.js` — chunking, playback, lifecycle (targeted)
- [ ] `js/reader.js` — document render/teardown

## Findings

_(filled in between reads)_

### Read 1 — `js/speechify.js:300-479` (errors, queue, retry, disk open)

- `MAX_CONCURRENT = 1` (`:365`) is right; queue is FIFO with no priority.
- **LEAK A — a stopped run still pays.** `enqueue` (`:380`) pushes a job and
  `pump` runs it regardless of whether the caller has since aborted. Press play
  then stop within the ~1s wait and the request still fires and bills. The
  AbortSignal is passed to `fetch` *inside* `synthesize`, but by then the
  request has already been issued.
- **LEAK B — retry ignores abort.** `synthesizeWithRetry` (`:399`) checks
  `AbortError` only on the throw path. During `await sleep(waitMs)` — up to 10s
  on the last rung — nothing checks abort, so stopping mid-wait still fires a
  fresh request afterwards.
- FIFO with no priority means a *lookahead* queued earlier blocks the chunk you
  are actually waiting to hear. Needs confirming against how prefetch is called.
- `DISK_BUDGET_BYTES = 250MB` (`:441`) is a fixed number, never checked against
  the browser's real quota. Failure is handled (`disk-write-failed`) so this
  degrades rather than breaks.
- Terminal vs retryable classification (`:311-334`) looks correct: 401/403 and
  402/credit are terminal; 429 and 5xx retry.

### Read 2 — `js/speechify.js:545-719` (cache, prefetch, timing, split)

- Disk-before-network in `acquire` (`:605-618`) is correct, and `inFlight`
  (`:595`) correctly shares a request rather than duplicating it.
- **No cost penalty from splitting.** Measured earlier: an 80-char head billed
  79 and a 236-char tail billed 235 — 314 for a 316-char chunk. Splitting costs
  an extra *request*, never extra *characters*.
- **LEAK C — a prefetch can never be cancelled.** `prefetch` (`:629`) calls
  `acquire(text, voiceId, undefined)` — no signal. Navigating away or closing
  the player mid-prefetch still completes and bills. It does land in the disk
  cache, so it is only wasted if you never return to that chunk.
- **BUG D — the "Preparing ~1.5s" estimate trains itself into a lie.**
  `recordFirstAudio` is called for segment 0 on *every* start including cache
  hits, which take ~20ms. After a few re-reads the median collapses toward zero
  and the bar promises a wait it cannot honour on a cold chunk. I wrote a
  comment about not timing later segments for exactly this reason and then let
  cached first segments through anyway.
- **BUG E — evicting memory can revoke a URL that is still playing.**
  `remember` (`:573`) revokes the object URL of whatever it drops. Nothing
  checks whether that entry is the one currently attached to the `<audio>`
  element. At `CACHE_MAX = 32` this needs 32 distinct chunks in one session —
  reachable by seeking around a long document.

### Read 3 — `js/speechify.js:760-909` (segment choice, playback)

- **LEAK F — THE BIG ONE. The disk cache is bypassed on exactly the path it
  exists for.** `:766` decides whether to split by asking `cache.has(...)` —
  **memory only**. After a reload memory is empty, so every chunk is split into
  a head and a tail, and those are looked up under *their own* keys. The disk
  holds the WHOLE chunk under a different key, so both halves miss and are
  synthesised and billed again.

  Meaning: **a reload still costs money**, which is the opposite of what I told
  the user. The disk cache only helps within a session, where memory would have
  answered anyway.

  Fix: decide split-vs-whole after checking disk, not just memory. The choice
  has to become async; `speak()` can still return its handle synchronously.

- **LEAK G — every segment is requested the moment `speak()` is called**
  (`:802`), including the tail. Stop after the head and the tail is still
  fetched and billed.
- Seeking is correctly confined to the first played segment (`:878`) and
  `firstSeg`/`skippedChars` (`:774-781`) mean skipped-over segments are never
  requested. That part is right.
- `tick()` (`:843`) binary-searches every frame — stateless, self-healing. Good.
- `beginStatus` (`:814`) suppresses the indicator below 200ms, so a cache hit
  shows nothing. Good — but see BUG D, the estimate itself is still poisoned.

### Read 4 — `js/tts.js` lifecycle (`:1539-1579`, `:732-790`, `:602-720`)

- `detach()` runs on **every re-render** (`:1559` says so explicitly) and calls
  `stop(true)` → `handle.stop()`. The audio cache is module-scope in
  speechify.js, so it survives a re-render. Chunk boundaries are rebuilt by
  `makeChunks()` but identical text yields identical keys, so a re-render costs
  nothing. Good.
- Pause → resume goes through `speakChunk(curWord.ds)`, which for a seekable
  engine sends the whole chunk and seeks. Cache hit. **The pause-to-comment loop
  is free.** Good.

### How bad is LEAK F, precisely

Traced rather than assumed:

- **Chunk you START on** (after reload, or after any jump): memory is empty →
  `alreadyHave` false → split → head and tail looked up under their own keys →
  disk holds the *whole* chunk → both miss → **billed again**.
- **Chunks reached by playing onward**: they arrive via `prefetch(opts.next)`,
  which requests the WHOLE chunk text → disk hit → **free**. Correct.

So the leak is not every chunk — it is **every chunk you jump to or start on**.
Which is exactly the behaviour the user described: hopping around a document.
Reading straight through after a reload costs one chunk; hopping costs one per
hop.

## User stories, each traced through the code that would run

| # | What you do | What actually happens | Verdict |
|---|---|---|---|
| 1 | Read start to finish | chunk 1 split (2 req), rest arrive via `prefetch(next)` as whole chunks | **Correct.** Pay once. |
| 2 | Pause, dictate a comment, resume | resume → `speakChunk(curWord.ds)` → whole chunk → cache hit | **Free.** Correct. |
| 3 | Skip a sentence inside a chunk | seek in audio already held | **Free.** Correct. |
| 4 | Skip across a chunk boundary | next chunk was prefetched | Free if adjacent; see #5 if you jump further |
| 5 | Double-click a word far down the page | cold chunk → `alreadyHave` false → split → **both halves miss disk** | **LEAK F. Re-billed even though the whole chunk is on disk.** |
| 6 | Reload and carry on | first chunk re-billed (LEAK F); later chunks free | **Partly broken.** |
| 7 | Same document tomorrow | same as #6 | **Partly broken.** |
| 8 | Change speed | `playbackRate` | **Free.** Correct. |
| 9 | Change voice mid-read | new keys, resynthesise | Correct — timings belong to a voice. Old audio lingers in the budget. |
| 10 | Edit the document, then read | changed chunk re-billed **and** every later chunk if the boundary shifts | **Uncosted. Can re-bill a whole document for a one-word edit.** |
| 11 | Two tabs on the same document | 2 concurrent → 429 storm → retries | **Not handled.** |
| 12 | Close the tab mid-synthesis | request completes server-side, billed, nothing stored | Unavoidable; bounded |
| 13 | Skim: play 5s, jump, play 5s, jump | each jump buys head **and** tail of a fresh chunk, you hear ~5s of ~40s | **Worst case. Pays for ~8× what is heard.** |
| 14 | Rewind and re-hear a paragraph | cache hit | **Free.** Correct. |
| 15 | Very long document | 250MB LRU; md.md ≈ 40MB | Fine |
| 16 | Transcript/video document | external clock; Simba not involved | Correct |
| 17 | Switch document while playing | `detach` → `stop` → abort; but an in-flight **prefetch has no signal** | **LEAK C. Completes and bills.** |
| 18 | Stop within the first second | queued job runs anyway; retry ignores abort | **LEAKS A + B.** |

## What to fix, in order of money

1. **LEAK F — check disk before deciding to split.** Directly contradicts what
   the user was told about reloads. Every jump to a cold chunk re-buys it.
2. **#13 skim waste — do not buy the tail until the head is actually playing.**
   A jump that is immediately abandoned should cost a head, not a whole chunk.
3. **LEAKS A/B/C — honour abort** in the queue, between retries, and for
   prefetches.
4. **BUG D — stop poisoning the wait estimate** with cache hits.
5. **BUG E — never revoke an object URL that is currently attached.**
6. **#10 — chunk on block boundaries** so an edit invalidates one chunk, not the
   tail of the document. Bigger change; flagged, not done here.
7. **#11 — two tabs.** A cross-tab lease already exists for transcription and
   could be reused. Flagged, not done here.

## Fixed in this pass

| # | Was | Now |
|---|---|---|
| **F** | Split decided on memory alone, so a reload or a jump re-bought a chunk sitting on disk | `diskHas()` consulted first; the whole chunk replays free |
| **G** | Head and tail both bought the instant `speak()` was called | Tail bought only once the head is audibly playing — an abandoned jump costs a head |
| **A** | A queued job ran even if its caller had stopped | `pump()` drops aborted jobs before spending anything |
| **B** | A retry wait ignored abort; stopping mid-wait still fired | `sleep(ms, signal)` rejects on abort |
| **C** | Prefetches were uncancellable | Own `AbortController`; `TTS.stop()` calls `cancelPrefetch()` |
| **D** | Cache hits (~20ms) trained the "~1.5s" estimate towards zero | Only genuine synthesis is timed |
| **E** | Eviction could revoke the URL of currently-playing audio | `inUse` set; in-use URLs are never revoked |
| **gap** | Raising chunks 400→1200 left a 2.3s hole between head and tail | Head scales with rate (220 at 1×, 560 at 3×), verified to out-speak the tail's download at 1/1.5/2/3× |

## Deliberately NOT fixed — and why

- **#10 chunk boundaries shift when the document is edited.** Chunks are built
  to a character budget, so inserting a word early can re-align every later
  boundary and re-bill a whole document. The fix is to chunk on block
  boundaries, which changes `makeChunks` in js/tts.js and affects the local
  voice too. Worth doing; too big to bolt onto this pass.
- **#11 two tabs.** Both would synthesise and both would 429 each other, since
  the concurrency limit is per account, not per tab. A cross-tab lease already
  exists for transcription (`js/video.js`) and could be reused.
- **#12 closing the tab mid-request.** Server-side work is already done and
  billed; nothing can be cached because the page is gone. Bounded and
  unavoidable.

---

## Correction to this audit, and the chunking fix

**I overstated #10.** The audit said an edit "can re-align every later boundary
and re-bill a whole document" ($1.09). That was wrong: `js/tts.js:278` already
guaranteed chunks never cross a block, and the loop resets per block, so a
cascade could never leave the edited paragraph. Measured over 96 random
single-word edits on `sample_docs/md.md`:

| | median | p90 | worst |
|---|---|---|---|
| before | 1 chunk ($0.0092) | 2 | **8 chunks ($0.058)** |
| after | 1 chunk | 1 | **2 chunks ($0.021)** |

A one-cent problem in 99% of blocks, six cents in the worst. Real, but nothing
like what I claimed.

**Measuring it surfaced something much larger.** Because chunks stopped at every
paragraph and the median paragraph is 93 characters, `CHUNK_CHARS = 1200` was
almost never reached: `md.md` produced **545 chunks with a median size of 105**.
For a network voice that is 545 separate requests, each paying a flat ~0.8s
floor, only one allowed in flight, against a sustained limit that 21 requests in
17 seconds is enough to trip.

So `makeChunks` was replaced with a grouping pass that does two things:

- **Chunks may span consecutive paragraphs**, up to a cap. Same characters
  billed; **545 requests become 144**. The paragraph break travels inside the
  text, so the voice still pauses there.
- **Boundaries are decided by the sentence's own text** (FNV-1a hash, 1-in-4),
  not by how much came before it. Position plays no part, so an edit cannot
  move a boundary downstream of itself.

Tuned by measurement, not taste — MIN 600 / MAX 1800 / 1-in-4 was the setting
where chunk count and edit-stability were both good; larger minimums degenerate
toward the old cumulative behaviour and the worst case climbs back to 11.

`TTS.debugChunks()` exposes the split, because chunk count *is* the number of
requests a full read will make.

**Still not fixed:** two tabs will 429 each other (the limit is per account, not
per tab). A cross-tab lease exists in `js/video.js` and could be reused.

# Ask mode — double-tap Option to ask the lesson a question

Planned 21 August 2026. Research only; nothing is built yet.

## TL;DR

- **The Vercel chat SDK cannot be used here.** Its chat layer is React-only, its
  packages are ESM on npm, and every documented path assumes a bundler. Folio
  has zero dependencies, 23 plain `<script>` tags and no build step. Full
  reasoning in [`techDocs/vercel-ai-sdk.md`](../techDocs/vercel-ai-sdk.md).
- **What replaces it is smaller than the SDK's own setup step:** one `fetch` to
  the endpoint transcription already uses. Shapes in
  [`techDocs/gemini-chat-rest.md`](../techDocs/gemini-chat-rest.md).
- **The hard part is not the AI — it is the Option key**, which already toggles
  dictation on a single bare tap (`js/tts.js:1532`). A double-tap gesture
  collides with it head-on. The fix is *retroactive reinterpretation*, which
  adds no latency to the existing gesture. This is the one design decision worth
  arguing about.
- **Ask mode is not a second recorder.** It is the same recording machinery with
  a different destination for the transcribed text. That keeps the change small.
- **Cost is a non-issue: ~$0.0025 per question** on a median lesson, measured
  against the 36 real transcripts. The entire transcript fits in every request,
  so there is no retrieval layer to build.
- **Read-aloud needs a genuinely new TTS entry point.** `TTS` today can only
  speak the attached document; there is no "speak this text" API. Small, but not
  free — and `speechSynthesis` is a single global queue, which is a real hazard.
- Build in three phases, gesture **second** — Phase 1 proves the chat path with
  a typed question, so the riskiest piece lands on working foundations.

## Document map

- **The gesture problem** — why double-tap Option is the hard part, and the fix.
- **Architecture** — the new module, storage, and where it plugs in.
- **What Gemini is told** — the context, and why the whole transcript goes.
- **The panel** — Notes and Chat as two tabs.
- **Read-aloud and auto-resume** — the later setting, and what it needs first.
- **Phases** — what to build, in what order, with tests.
- **Risks** — what I expect to get wrong.
- **Decisions taken** — calls I made, and how to reverse them.

---

## The gesture problem

This is the part to get right; everything else is ordinary work.

### What Option does today

A **single bare Option tap already toggles dictation**. The handler is at
`js/tts.js:1505–1544`, and its logic is careful for good reason: Option is a
modifier, so its keydown fires on the way into `⌥←`, `⌥`-click and typing `é`.
The existing code therefore acts only on **keyup**, and only if the press was
"bare" — no other key, no mouse press, no scroll, no focus loss in between.

That is a well-built gesture, and it is the daily-driver for voice notes. **Any
design that makes it slower is a regression**, no matter how good ask mode is.

### Why the obvious approach is wrong

The obvious way to detect a double-tap is to wait: on the first tap, start a
~300ms timer, and only fire the single-tap action if no second tap arrives.

**This taxes every voice note with 300ms of dead air.** You press Option, and
nothing happens for a third of a second before recording begins. On the gesture
used dozens of times per lesson, to enable a gesture used a few times. Wrong
trade.

### The fix: reinterpret, don't wait

Let tap 1 do exactly what it does today — start recording **instantly**. Then,
if a second tap arrives within the window, *reinterpret* the first:

```
tap 1  → beginDictation()            (unchanged, instant)
tap 2  → if it lands within 350ms AND tap 1 STARTED a recording
           AND that recording is still younger than 350ms
         → discard the recording, enter ask mode
         → otherwise, behave exactly as today
```

**Discarding is safe by construction.** The audio being thrown away is under
350ms long — it is the sound of two Option taps. Nothing a person could say
fits in it. This is categorically different from the bug that destroyed real
voice notes earlier, where `detach()` cancelled recordings of *arbitrary*
length; here the discard is bounded by the same window that identified the
gesture.

The critical qualifier is **"tap 1 started a recording."** If tap 1 *stopped* a
real note that was mid-flight, tap 2 must not reach back and destroy it — it
just starts a fresh dictation, as today. One rule prevents the only case where
this gesture could lose real work:

> Only ever reinterpret a tap that began a recording. Never one that ended one.

### Ending the question

Once in ask mode, a **single** Option tap means "I'm done asking" — as
specified. `Escape` cancels without sending. Space is left alone so it keeps
meaning play/pause.

A third rapid tap must not re-enter ask mode recursively, so entering ask mode
records its own tap kind and the double-tap detector ignores it.

### The window

350ms. Fast enough that a deliberate double-tap is comfortable, short enough
that two intentional separate voice notes can't collide — you cannot begin,
speak and end a note inside a third of a second. Worth making a named constant
so it can be tuned from one place.

---

## Architecture

### New: `js/chat.js`

One more IIFE exporting a `Chat` namespace, following the existing pattern
(`CLAUDE.md`: IIFE + `return { … }`). Loaded by a `<script>` tag in **both**
`index.html` and `index-electron.html` — the DOM contract is shared, and
forgetting the second file is a standing trap in this repo.

```
Chat.init()
Chat.ask(question, { docId, videoTime })   → appends user turn, streams answer
Chat.list(docId)                           → the conversation
Chat.remove(docId, id)                     → delete a turn
Chat.retry(docId, id)                      → re-ask a failed turn
Chat.exportChat(docId)                     → markdown, matching Comments.exportTranscript
Chat.isBusy()
```

### Storage: `folio_chat_{docId}`

Per-document, alongside `folio_comments_{docId}` and `folio_highlights_{docId}`.
Per-document is right because **the transcript is the context** — a conversation
about lesson 12 has no meaning attached to lesson 13.

```jsonc
{
  "id": "ch_1787…",
  "role": "user" | "model",
  "text": "…",
  "t": 988,                    // video seconds when asked — same idea as comments
  "createdAt": "2026-08-21T…",
  "status": "done" | "streaming" | "error",
  "error": null,               // Google's own message when status is error
  "usage": { "in": 4213, "out": 380 }
}
```

`t` matters more than it looks. It makes each turn **clickable to seek**, the
same way timed comments already are (`Comments.listTimed`), so a conversation
doubles as a set of bookmarks into the lesson.

`status` is kept per message rather than as one global "loading" flag, so a
failed answer stays visible and retryable in place instead of vanishing into a
toast. That was a specific complaint about transcription: *"it takes so long,
then it vanishes."*

### Where it hooks into dictation

**Ask mode reuses the recorder wholesale.** `beginDictation` / `finishDictation`
(`js/tts.js:855` and `:915`) already handle pausing the clock, capturing audio,
holding the blob safely, transcribing through Groq, and retrying. None of that
should be duplicated.

The only difference is **where the transcribed text goes**. Today
`saveDictation` (`js/tts.js:991`) calls `Comments.addComment`. Ask mode routes
the same text to `Chat.ask` instead.

So the change is one flag — call it `micIntent`, `"note"` or `"question"` —
pinned at the same moment `micDocId` is pinned (`js/tts.js:883`) and read at
`saveDictation`. Everything between is untouched.

This is the single most important structural decision in the plan: **ask mode
adds a destination, not a pipeline.**

---

## What Gemini is told

### The whole transcript goes, every turn

Measured against the 36 real lesson transcripts:

| transcript | tokens in | cost per question |
|---|---|---|
| smallest (1,058 words) | ~1,375 | ~$0.0017 |
| **median (3,147 words)** | **~4,091** | **~$0.0025** |
| largest (12,857 words) | ~16,714 | ~$0.0063 |

**100 questions on a median lesson: about $0.25.** A ten-turn conversation
resending full history each time: about $0.036.

The consequence is worth stating outright, because it deletes work: **there is
no reason to build retrieval, chunking, or embeddings.** Send the whole thing.
Any design here that reaches for a vector store is solving a cost problem that
does not exist.

### The request

- `systemInstruction`: answer questions about this lesson; ground answers in the
  transcript; when the transcript doesn't cover it, say so and answer from
  general knowledge **while marking which is which**; cite timestamps as
  `[MM:SS]` when pointing at a moment.
- `contents`: the transcript and the question as the first user turn, then prior
  turns, then the new question. Roles are `user` / `model`.
- `thinkingLevel: "low"` — measured faster, cheaper *and* denser than thinking
  on, the same finding that settled transcription.

### Where the user is, right now

The current playhead goes into the prompt. It is what makes the obvious
question — *"wait, what did he just say?"* — actually answerable. Without it the
model has no idea which of 3,000 words "just" refers to.

Marking the current position inside the transcript (a `← you are here` line)
costs nothing and gives the model an anchor to reason about "before this" and
"after this". Answers should be allowed to reference later material but should
flag it, since the user may not have watched it yet.

### Truncation

`maxOutputTokens` around 1,200 — roughly 900 words, generous for a spoken
question. **Check `finishReason`**: `MAX_TOKENS` means the answer was cut
mid-sentence and must be shown as truncated, not presented as complete.

---

## The panel

`#comments-panel` (`index.html:352`) gains a tab strip under its header:

```
┌──────────────────────────────┐
│ Notes            + Note  ×   │   ← existing header
├──────────────────────────────┤
│  ▸ Notes  │  Chat            │   ← new tab strip
├──────────────────────────────┤
│                              │
│   #comments-list             │
│         or  #chat-list       │
│                              │
├──────────────────────────────┤
│  [ composer ]          Save  │
└──────────────────────────────┘
```

- `#chat-list` is a sibling of `#comments-list`; the tab toggles which is shown.
- The composer stays shared, and its submit routes on the active tab: Notes →
  `Comments.addComment`, Chat → `Chat.ask`. This is why **Phase 1 can ship
  without the gesture** — a typed question exercises the whole chat path.
- A count on each tab (`Notes 7 · Chat 3`) so the other tab's contents aren't
  invisible.
- Entering ask mode by voice **auto-switches to the Chat tab**, so the answer
  appears where the user is already looking.
- Export gains the chat, matching the existing markdown export.

Chat turns render as alternating blocks with the timestamp as a seek link. The
model's answer renders through `marked` (already vendored) so `[MM:SS]`
references, lists and emphasis survive.

---

## Read-aloud and auto-resume

Specified as a later setting; here is what it will need, so Phase 1 and 2 don't
paint it into a corner.

### The resume half is already built

`micResumeAfter` (`js/tts.js:841`) exists precisely for this: it remembers
whether reading was in progress when the mic opened, and resumes afterwards. It
already handles both clocks — the document reader and a registered video via
`setExternalClock`.

**Ask mode gets that behaviour for free** by going through `beginDictation`.
Answer arrives → playback resumes. The user's "I can play the video again with
space bar" is the *setting off* case; the setting on case is the existing
default path.

### The read-aloud half needs new API

This is the one place where the plan needs something that doesn't exist.

`TTS` speaks the **attached document's chunks**. `play` / `pause` / `toggle`
operate on that; there is no public "speak this arbitrary string" entry. The
machinery is there — `WebSpeechProvider` wraps `SpeechSynthesisUtterance` at
`js/tts.js:404–431` — but it isn't reachable from outside.

So: add `TTS.speakAside(text, onDone)`. Small, but two hazards make it worth
care rather than a one-liner:

1. **`speechSynthesis` is a single global queue.** The file's own header comment
   at `js/tts.js:46` warns about blocking it. Speaking an answer while the
   document is mid-sentence must stop the document first, then speak, then
   resume — not interleave.
2. **Answers contain timestamps, markdown and code.** Reading `[16:27]` aloud as
   "bracket sixteen colon twenty-seven bracket" is unpleasant. The text needs a
   spoken-form pass: timestamps → "sixteen twenty-seven", strip `#`/`*`/`` ` ``,
   skip code blocks.

### The settings

Two booleans in `folio_settings`, both defaulting **off** so nothing changes for
anyone who doesn't want it:

- `askReadAloud` — speak the answer when it arrives.
- `askAutoResume` — resume the lesson once the answer finishes.

`askAutoResume` should only be reachable when `askReadAloud` is on; resuming the
video the instant a written answer appears would bury it.

---

## Phases

### Phase 1 — the chat path, typed

Everything except the gesture: `js/chat.js`, `folio_chat_{docId}`, the tab
strip, streaming into the panel, error and retry states, export.

Ships useful on its own — you can ask questions by typing. More importantly it
**proves the Gemini call, the context assembly and the panel** before any of the
risky key handling is touched.

*Test:* browser test in the existing harness (`test/browser/`) — seed a document
with a transcript, type a question, assert the request body has correct roles
and contains the transcript, assert the answer renders and persists across a
reload. Mock the Gemini response; one live call at the end to confirm the real
shape.

### Phase 2 — the gesture

Double-tap detection in `js/tts.js`, `micIntent`, routing at `saveDictation`,
auto-switch to the Chat tab.

*Test:* this is where a unit test earns its keep, because the failure mode is
destroying voice notes. Assert, with synthetic key events:
- one bare tap still starts dictation, with **no added delay**
- two taps within 350ms enter ask mode and discard only the sub-350ms recording
- two taps where the first *stopped* a real note do **not** destroy it
- `⌥←`, `⌥`-click and a blur mid-press still disqualify, as today
- a third rapid tap does not re-enter ask mode

### Phase 3 — read-aloud and auto-resume

`TTS.speakAside`, the spoken-form pass, the two settings, wiring to
`micResumeAfter`.

*Test:* mostly manual — this is feel, not logic. The spoken-form conversion is
worth unit tests on its own since it's pure string work.

---

## Risks

**The gesture is the whole risk.** Everything else is ordinary.

| risk | why it worries me | mitigation |
|---|---|---|
| Double-tap destroys a real voice note | Exactly this class of bug already happened once, and it was the angriest moment of the project | The "never reinterpret a stop" rule, plus a test written specifically for it |
| Added latency on single-tap | Would degrade the most-used gesture to enable a rare one | Reinterpretation instead of debouncing — tap 1 stays instant |
| `speechSynthesis` queue conflicts | Single global queue; the file already warns about blocking it | Stop before speaking; Phase 3 only |
| Two API keys, two failure modes | Groq for speech, Gemini for the answer. Missing either fails mid-gesture, after the user has already spoken | Check both **before** recording starts, as `beginDictation` already does for Groq (`js/tts.js:856`) |
| Ask mode during transcription | Option is currently ignored while `micState === "transcribing"` (`js/tts.js:1530`). Being locked out mid-flow was a real complaint | Decide deliberately in Phase 2; leaning toward allowing it, since the two pipelines no longer share a destination |
| Long transcripts | 12,857 words is fine; a 3-hour lecture would not be | Only trim when the request would exceed a threshold, and say so in the UI rather than silently |

### The verification trap, again

The lesson from transcription applies directly. Every check written then passed
while the feature was broken, because they verified the wrong property.

For ask mode the tempting-but-useless checks are *"a response came back"* and
*"the answer mentions words from the transcript"* — both satisfied by an answer
that is confidently wrong. **The check that matters is asking a question whose
answer is only in the transcript, and confirming the specific fact comes back
right.** One cheap test, written in Phase 1, not after.

---

## Decisions taken

Calls made rather than blocking on; all reversible.

**The Chat tab is the record — Q+A does not also create a note.** The brief said
"recorded as a note", which could mean either. Writing every exchange into Notes
would flood the notes list, which is curated by hand. Instead each answer gets a
**"Save to notes"** action, so promotion is deliberate. Reversible: flipping to
auto-save is one call in `Chat.ask`.

**One conversation per document, not per moment.** A single thread that carries
context reads better than fragments, and each turn keeps its own timestamp
anyway, so nothing is lost.

**Streaming in Phase 1, not later.** ~30 lines, and it directly addresses "it
takes so long, then it vanishes." A four-second wait with nothing on screen is
the failure mode being designed away.

**No new dependency.** No React, no bundler, no SDK. `js/chat.js` is a plain
IIFE like every other file.

---

## What this plan does not cover

- **Tool use / agentic behaviour** — the model can't seek the video or open
  another lesson. Out of scope.
- **Cross-lesson questions** — "what did episode 3 say about this?" would need
  the other transcripts in context. Cheap enough to be possible later; not now.
- **Images or frames** — questions about what's *on screen* would need
  screenshots. The video is not sent; the transcript is.
- **Sharing or sync** — chats are localStorage, like everything else, and do not
  go to Notion.
- **A per-question cost display** — `usageMetadata` is stored, so this is easy
  to add if it turns out to matter.

## What I did not verify

- **The multi-turn `contents`/role shape has not been called from this
  codebase.** It's from Google's reference, and Folio's shipped requests use a
  single-turn `contents` with no `role` field at all (`js/gemini.js:399`). The
  first real call in Phase 1 must confirm it, since a wrong role is a 400.
- **`interactions`, the newer API** with server-side history, is documented but
  untested here. Not adopted; the cost table says there's no need.
- **Whether `speechSynthesis` can be interrupted cleanly mid-document and
  resumed at the right word** — assumed workable because pause/resume already
  exist, but not proven for the aside case.
- **I did not read all of `js/comments.js` or `js/video.js`** — only their public
  APIs and the panel DOM. Phase 1 will need a closer read of the panel's render
  and resize logic before adding a tab strip.

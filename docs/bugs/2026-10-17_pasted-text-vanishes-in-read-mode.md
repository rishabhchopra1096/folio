# Pasted text showed in edit mode and vanished in read mode

## TL;DR

- **Reported 17 October 2026**, in his words: *"did something got fucked? Cause now when i paste the text, it's visible in edit mode, but vanishes in view mode?"*
- **Nothing he pasted was ever lost.** The text reached storage correctly; the reader drew the revision from *before* the paste. A reload would have shown it.
- **Not caused by the export work shipped the same day.** A probe reproduced it on the previous day's code and again on code from 4 September, six weeks older.
- **The cause: `route()` in `js/app.js` called the async `Editor.hide()` without awaiting it**, then read the storage that `hide()` was still in the middle of writing.
- **A second, worse fault was found while diagnosing it, and that one did lose work.** Going from one page's editor straight into another's never flushed at all, so the last second of typing in the first page was destroyed — gone from storage, not merely undrawn.
- **Then the same sentence came back, and the screenshot carried the real answer:** "Save failed", in grey 12px type in the corner. The browser's storage was full, nothing had been written, and closing the editor destroyed the only copy.
- **A failed save now refuses to close the page**, says so in a band across the top, and the warning that should have come first — wired to image paste only, so typing never triggered it — now runs after every save.
- **All of it covered by 46 new browser assertions** across three probes, with 21 mutations caught. Two defects in the banner were found only by rendering it and looking.

## Document map

**Symptom and first question** is what he saw and whether today's work caused it · **The two faults** is what was actually wrong in each case · **Why the fix goes where it goes** explains the one non-obvious placement decision · **What the fix could have broken** is the three regressions checked for deliberately · **The mutation that escaped** is the guard that could not be proven and why it was kept anyway · **Lessons** is what to carry forward.

## Symptom, and the first question to answer

**The first job was not fixing it but establishing whether the export change shipped hours earlier had caused it, because that governs whether to revert.**

Today's three commits touched `js/comments.js` and test files only. The render and save path — `reader.js`, `editor.js`, `store.js`, `sidebar.js` — had no commits at all. That is suggestive, not proof, so a probe was written and run against three versions of the code:

| Version of `js/` | Result |
|---|---|
| Today, after the export work | reproduced |
| `8cc6fd2`, yesterday | reproduced, identically |
| `d7da98c`, 4 September | reproduced, identically |

**So the bug was six weeks old and had simply not been hit in this exact way before.** Pasting a large block and switching straight to read mode is a newer habit than the code.

## The two faults

**Fault one — the reader drew before the save landed.**

`Editor.hide()` is an `async` function. It flushes the editor to storage with `await persistContent()`, which itself awaits Editor.js's own `save()`. `route()` called it like this:

```js
Editor.hide();                   // async — returns a pending promise
showView(viewReader);
Reader.renderDocument(docId);    // reads localStorage NOW
```

The render ran in the same synchronous turn, before the flush had written anything, so it drew the stored revision from before the paste. The probe reports this as two separate facts — `drawn=false saved=true` — because that pair is the entire diagnosis: **storage was right and only the drawing was early.**

**Fault two — moving between editors destroyed unsaved work.**

`route()`'s edit branch never called `hide()` at all, and `openEditor()` disposes of the previous instance with a bare `editorInstance.destroy()` and no flush. So clicking a second page in the sidebar while the first page's auto-save was still pending threw that work away permanently. The probe reports `kept=false` for this one: it was gone from storage, so no reload would bring it back.

## Why the fix goes where it goes

**The flush had to be added in `route()` and not in `openEditor()`, and the reason is a trap worth remembering.**

`openEditor()` sets `currentDocId` to the *new* document before destroying the old instance:

```js
function openEditor(docId) {
  ...
  currentDocId = docId;        // reassigned here
  ...
  if (editorInstance) { editorInstance.destroy(); editorInstance = null; }
```

A flush added inside `openEditor` would therefore have run with the new document's id and the old document's content, **writing page A's text into page B** — turning a data-loss bug into a data-corruption bug. The probe asserts this explicitly (`leaked-into-other=false`) so a future refactor cannot reintroduce it quietly.

## What the fix could have broken

**Making a router async is the kind of change that fixes one thing and breaks three, so each was checked rather than reasoned about.**

| Risk | Checked by | Result |
|---|---|---|
| A superseded navigation paints over a newer one | `routerace`, three attempts | Cannot happen; see below |
| Deleting the page being edited resurrects it, because the flush writes a document that no longer exists | `pastevanishes` case 6 | Refused by the staleness guard |
| The same, for a page whose stored revision time is `0`, where that guard cannot tell "deleted" from "unchanged" by comparing times | `pastevanishes` case 6b | Also refused |

**The resurrection check mattered most.** Flushing on the way out means the flush now runs on the path where a page has just been deleted, which is a worse bug than the one being fixed. `persistContent()` refuses it because `storageTime()` of a missing key is `0` and cannot match a real `loadedTime` — and the `time: 0` edge, where the two *do* match, was tested separately rather than assumed.

## The mutation that escaped

**The ticket guard added to `route()` could not be made to fail, so it is recorded as unproven insurance rather than counted as tested.**

Making `route()` async means two navigations can be in flight at once, so each call takes a number and gives up after an await if a newer call has started. Three attempts were made to catch its removal and all three passed with it disabled — the last wrapped the editor's `save()` to take 600 ms and navigated again 50 ms into that window, which is as deep inside the race as a test can reach.

**The reason is structural.** Every branch of `route()` has exactly one await and it is the same call. A second navigation arriving mid-flush finds the editor still alive, because the teardown happens *after* that await, so it takes the slow path too — and its own timer started later, so it resolves later. A later call cannot overtake an earlier one.

The guard stays, because it costs three lines and the failure it prevents is silent and nasty. But the honest status is written both in `js/app.js` where it lives and in `routerace.probe.html`, and the assertions that remain there describe the outcome a person sees rather than claiming to prove the mechanism.

## The second report, and the bug underneath both

**The fixes above were live when the same sentence came back: *"still same problem, content vanishes when i press view button"* — and this time a screenshot came with it, carrying the answer nobody had read.**

In the corner of the topbar, in grey 12px type, were the words **"Save failed"**. localStorage was full. Nothing had been written. The reader drew exactly what was stored, which was nothing. And `hide()` destroyed the Editor.js instance on its way out, so the only copy of the writing went with it.

**Every part of that chain behaved as designed, which is why none of it was caught.** `writeJSON` was a bare `localStorage.setItem` with no error handling, so a full disk surfaced as a thrown exception that `persistContent` caught and turned into the string `"failed"`. That string reached a label in a corner. Nothing else happened.

| What was wrong | What it does now |
|---|---|
| A write failure was indistinguishable from any other error | `writeJSON` tags a quota failure before rethrowing, so the message can be specific |
| `hide()` destroyed an editor it could not save | It refuses, leaving the instance, the content and the document id standing |
| `route()` drew an empty reader over unsaved work | It abandons the navigation and keeps the editor up |
| The only notice was a corner label | A band across the top, saying what happened, that the writing is safe, and what to do |
| The early warning was wired to image paste only | It runs after every successful save |
| The warning compared against a guessed limit | It decides by TRYING a 256KB write, since the limit is 10MB here and 5MB elsewhere |

**The warning's wiring was the real failure.** `checkStorageQuota()` existed, read sensibly, and was called from exactly one place: the image-paste handler. Filling the storage by typing and pasting text never ran it once. The first theory — that its 6MB threshold sat above a 5MB wall — was wrong, and measuring disproved it: this Chrome refuses at 10MB, so 6MB was perfectly reachable. **The measurement is kept in the probe because it is what disproved the first explanation.**

**Two things were only ever found by rendering the banner and looking at it.** It sat on top of the topbar, hiding the view, comments and theme buttons for as long as it was up — so the message about not being able to save also took away the controls. And it said "Storage holds 0.0MB" for a failure that had nothing to do with space, which is self-contradictory and costs the rest of the sentence its credibility. Neither was visible to any assertion.

## Lessons

- **"It vanished" is two bugs wearing one sentence**, and they need opposite responses. Text that never reached storage is lost and urgent; text that reached storage and was drawn late is a timing bug and nothing is gone. Report which one it is before proposing anything — the probe here prints `drawn` and `saved` as separate facts for exactly that reason.
- **When something breaks right after a change, prove the change caused it.** Reasoning from "my commits only touched one file" is suggestive; running the same probe against three older versions of the code is evidence. It took one worktree and four minutes and it ruled out a revert.
- **An unawaited async call is invisible until something downstream reads what it was writing.** Nothing throws, nothing logs, and the code reads correctly.
- **A function that reassigns its own identity before tearing down the old state is a trap for any cleanup added later.** `openEditor` sets `currentDocId` before the destroy, so the obvious place to add the flush was the wrong place, and the wrong version would have corrupted rather than lost.
- **Fixing a race can open one.** Check the fix's own new failure modes in the same pass, and if a guard cannot be made to fail, say so where it lives instead of letting it look tested.
- **Read the screenshot before the code.** The second report carried the diagnosis in plain sight — "Save failed" — and the first round of work was spent on a real but different bug because the screenshot had not arrived yet. When a fix does not take, ask for the screen before theorising again.
- **An error path that ends in a corner label is an error path with no ending.** Anything the user must act on to avoid losing work has to be impossible to miss, and "impossible to miss" is a size and a position, not a wording.
- **A warning is only as good as its call sites.** This one was correct, well written, and wired to a single rare event. Before trusting any guard, grep for where it is actually invoked — the logic being right is the easy half.
- **Never hardcode a browser limit.** localStorage is 10MB in current Chrome and 5MB in older ones and elsewhere. Any threshold expressed as a number is wrong on some browser; trying a write is right on all of them.
- **Fill it properly or you are not testing it.** Three attempts were needed: large chunks leave most of a chunk free, and filling after the edit lets the auto-save land while there is still room. Both versions passed while testing nothing.
- **Render the thing and look at it.** Two real defects in the banner — covering the controls, and quoting a number that contradicted its own sentence — survived twenty-two passing assertions and died in one screenshot.

## What the storage actually held, and what was done about it

**Read out of his own Chrome profile rather than asked for: 10.00 MB, which is exactly Chrome's ceiling for one origin.**

| Where it went | |
|---|---|
| Pages | 7.49 MB across 76 documents |
| Comments | 1.22 MB |
| Highlights | 0.88 MB |
| Everything else | 0.41 MB |
| Feedback screenshots | 0.00 MB |

**The suspicion that the feedback box's screenshots had filled it was wrong**, and worth recording as wrong: they came to nothing, because the bytes are dropped once a note has been written out. There were no images anywhere in the storage. It was 76 documents of ordinary writing, several of them long video transcripts — the largest a 984 KB Pokémon GO walkthrough.

**The fix is compression, chosen over the alternatives on measured numbers.** Editor.js stores blocks as JSON, which is repeated field names and punctuation wrapped around prose, and that compresses by about 84% — his largest page goes from 977 KB to 157 KB. Across all 76 that is close to six megabytes back without deleting a single page.

- **lz-string rather than `CompressionStream`**, which is faster and built in, because it is *synchronous*. Every module reads from `FolioStore` expecting an answer immediately; the async option turns every one of those reads into a promise, which is a rewrite of the whole app to save milliseconds nobody would notice.
- **Vendored rather than loaded from a CDN.** A page that cannot be decompressed cannot be read at all, so this must not depend on the network.
- **Pages only.** Comments and highlights are read on every render and came to 2.1 MB between them. Compressing the pages alone solves the problem with the smallest surface.
- **IndexedDB was the other real option** and would lift the ceiling to hundreds of megabytes. It is the right destination and it was deliberately not taken tonight: it makes every read asynchronous, and `CLAUDE.md` says not to introduce it without discussing it first.

**The change broke saving, and only the browser probes noticed.** Two places in `js/editor.js` read `folio_doc_<id>` straight out of localStorage and `JSON.parse`d it. Against a compressed page that throws — and because the staleness check treats a throw as "time 0", every save then decided the page had been rewritten by somebody else and refused to write. The backup export had the same fault more quietly: it fell through to copying the compressed blob verbatim, so backups kept restoring into Folio but stopped being readable by a person or any other tool.

**The lesson generalises: a storage format change breaks every reader that bypassed the storage layer**, and those readers are invisible until something throws. The grep that finds them takes a minute and should be the first step, not the debugging.

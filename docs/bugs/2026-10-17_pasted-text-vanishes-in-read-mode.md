# Pasted text showed in edit mode and vanished in read mode

## TL;DR

- **Reported 17 October 2026**, in his words: *"did something got fucked? Cause now when i paste the text, it's visible in edit mode, but vanishes in view mode?"*
- **Nothing he pasted was ever lost.** The text reached storage correctly; the reader drew the revision from *before* the paste. A reload would have shown it.
- **Not caused by the export work shipped the same day.** A probe reproduced it on the previous day's code and again on code from 4 September, six weeks older.
- **The cause: `route()` in `js/app.js` called the async `Editor.hide()` without awaiting it**, then read the storage that `hide()` was still in the middle of writing.
- **A second, worse fault was found while diagnosing it, and that one did lose work.** Going from one page's editor straight into another's never flushed at all, so the last second of typing in the first page was destroyed — gone from storage, not merely undrawn.
- **Both fixed, live, and covered by 24 new browser assertions** across two probes. One mutation escaped and is written down as unproven rather than counted as tested.

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

## Lessons

- **"It vanished" is two bugs wearing one sentence**, and they need opposite responses. Text that never reached storage is lost and urgent; text that reached storage and was drawn late is a timing bug and nothing is gone. Report which one it is before proposing anything — the probe here prints `drawn` and `saved` as separate facts for exactly that reason.
- **When something breaks right after a change, prove the change caused it.** Reasoning from "my commits only touched one file" is suggestive; running the same probe against three older versions of the code is evidence. It took one worktree and four minutes and it ruled out a revert.
- **An unawaited async call is invisible until something downstream reads what it was writing.** Nothing throws, nothing logs, and the code reads correctly.
- **A function that reassigns its own identity before tearing down the old state is a trap for any cleanup added later.** `openEditor` sets `currentDocId` before the destroy, so the obvious place to add the flush was the wrong place, and the wrong version would have corrupted rather than lost.
- **Fixing a race can open one.** Check the fix's own new failure modes in the same pass, and if a guard cannot be made to fail, say so where it lives instead of letting it look tested.

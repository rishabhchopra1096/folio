# Re-reads — grouping comments and highlights by the time you read

## TL;DR

- **The feature:** when you revisit a document months later, you press "Start new read"
  once, and from then on every comment and highlight you make belongs to that read.
  Exports can then give you just this read's thinking, without the old notes mixed in.
- **Everything stays visible.** Old comments are never hidden. Each one carries a small
  label saying which read it came from, so re-reading the document and re-reading your
  past reactions are the same activity.
- **Each read gets its own colour.** Read 1 is yellow, Read 2 green, Read 3 blue, Read 4
  pink, then it cycles. New highlights take the current read's colour by default, so you
  can see at a glance which pass marked what. The four colour swatches still work as a
  manual override.
- **Export asks which read**, and one of the choices is every read in a single file with
  a heading per read. Nothing is ever silently dropped from an export.
- **Every exported comment says when you thought it** — `**MY THOUGHT ON MAR 2, 2026:**`
  — and they come out oldest first, so a passage you have commented on twice reads as a
  progression. A comment copied into a later read keeps the date of the original thought,
  not the day it was copied.
- **Old documents are migrated, not stranded.** Anything you wrote before this feature
  existed becomes "Read 1" automatically, dated from your earliest note.
- **The one subtle rule:** a comment written in Read 2 about a highlight made in Read 1
  keeps its quote in the export. Filtering highlights naively by read would strip the
  quote and turn the comment into an orphan.
- **A read can be named and deleted**, from a manager behind the read name in the bar.
  Deleting never destroys writing — the comments and highlights move to the neighbouring
  read, and the dialog says so before you press it.
- **A comment can be moved or copied between reads.** Move is for the mistake of
  forgetting to press the button; copy is for a thought that is true in both passes, and
  leaves the comment in each.

## Document map

**The data model** says what gets stored and where · **Migration** explains how existing
documents join the scheme without losing anything · **The inclusion rule** is the one
piece of logic that is easy to get wrong and worth reading carefully · **The UI** covers
the bar in the comments panel, the per-comment labels and the colours · **Naming and
deleting a read** covers the manager behind the bar, and why deleting never destroys
writing · **Moving and copying a comment** covers the two verbs and when the highlight
follows · **Export** covers the chooser and the file shapes · **Every exported thought says when
you had it** is the dated label, added after he read a real export · **When a read begins**
answers a question the first design got wrong · **How this was verified** lists the three
test layers and the two faults they caught · **Files changed** is the map of the work ·
**What I did not do** is the honest gap list.

## The data model

**A read is a record of one pass through a document, and comments and highlights point
at it by id.**

A new localStorage key per document, `folio_reads_{docId}`, holds an array in the order
the reads happened:

```js
{ id: "rd_...", n: 1, color: "yellow", startedAt: "2026-03-09T…" }
```

`n` is the read's number, used for its label ("Read 1"). `color` is one of the four
existing highlight colours. The current read is always the last entry in the array —
there is no "active" flag to get out of sync.

Comments gain a `readId` field alongside their existing `{id, highlightId, isGeneral, text,
createdAt}`. Highlights gain the same field. Neither changes shape otherwise, so every
existing reader of those objects keeps working.

## Migration

**A document that already has notes gets a Read 1 built around them, so nothing becomes
ungrouped.**

The first time a document is opened after this ships, `ensureReads(docId)` runs. If the
document has no reads list yet, it creates one read, numbered 1, coloured yellow, dated
from the earliest `createdAt` found among the existing comments and highlights (falling
back to now when there are none). It then stamps every comment and highlight that has no
`readId` with that read's id, and saves all three keys.

This matters because the export filters by `readId`. Without the backfill, every note
written before today would match no read and quietly vanish from exports — the exact
failure this feature is supposed to prevent.

## The inclusion rule

**A highlight belongs in a read's export if the read made it OR if one of the read's
comments is about it.**

The naive rule — keep only the highlights whose `readId` matches — breaks the main use
case. Re-reading a passage you marked months ago and adding a fresh thought about it
produces a Read 2 comment attached to a Read 1 highlight. Under the naive rule that
highlight is filtered out, the comment loses its quote, and all three export formats
then classify it as a note whose passage was deleted.

So the filter is:

```
comments  = all comments whose readId === target
highlights = all highlights where readId === target
             OR id is referenced by one of those comments
```

The consolidated "every read" export skips filtering entirely.

## The UI

**The comments panel gains a bar under its header that names the current read and offers
to start a new one.**

The bar shows a coloured dot, the read's label and the month it started — "Read 2 ·
October 2026" — with a "New read" button on the right. It sits under the existing header
rather than adding a fourth button to it, because starting a read happens once per
revisit while the other buttons are used constantly, and because the bar also has to
report which read you are in.

Each comment in the list gains a small chip showing its read, coloured to match. Comments
from the current read are not chipped — only older ones are, so the panel does not label
the obvious.

**Colour follows the read.** A highlight created during Read 2 defaults to Read 2's
colour. The four swatches in the selection toolbar still set a colour explicitly, because
removing a working feature to make room for a new one is not an improvement. `readId`,
not colour, is what the export trusts.

## Naming and deleting a read

**Clicking the read's name in the bar opens a manager listing every read on the document.**

Each row shows the read, what is in it, a field for a name of your own, and Delete.
Renaming and deleting apply to any read rather than only the current one, so they need a
list to hang off; putting them on the bar would both crowd a strip that already has a
button and leave no way to touch an older read at all.

**A named read keeps its number** — "Read 2 · Close reading" — because the number is the
only thing that says which pass came first, and in a list of five reads that ordering is
most of what you are looking for. An empty name simply falls back to the number.

**Deleting a read never deletes what you wrote.** Its comments and highlights move to the
read before it, or forward to the next one when deleting the first. The confirm dialog
names the counts and the destination before you press it. Deleting a read is a filing
decision — you started one by accident, or two passes turned out to be one — and losing
writing as a side effect of that would be unrecoverable from an action that does not
sound like one.

**The last read cannot be deleted.** Every comment points at a read, so with none left
they point at nothing, and the migration would not rebuild one because they already carry
a `readId` — they would vanish from every per-read export. The button is disabled with
the reason in its tooltip rather than hidden.

## Moving and copying a comment

**Each comment has a "Reads" action offering both verbs, one per read.**

**Move** is for the mistake: you open something you read months ago, start reading, and
write three comments before remembering to press "New read". Without this they are stuck
in the old read for good, and the feature has failed for exactly the session that needed
it. A move takes the comment's highlight along, because the mark was made at the wrong
time too — unless another read still has a comment about that same passage, in which case
the mark stays where it was made rather than quietly relabelling history.

**Copy** is for a thought that is true in both passes. "Never understood this properly"
written in March is still true in October, and an October export that left it out would
be missing something you still think. The copy gets its own id, is dated today, and
records `copiedFrom` so the panel can mark it — otherwise you find what looks like the
same sentence twice with no way to tell whether you repeated yourself. A copy never moves
the highlight: the original comment still points at it.

**Two buttons per read rather than a mode switch**, because a mode is a thing you can
misread — press Copy believing you are in Move and the mistake is silent until an export
looks wrong.

## Export

**The existing "which kind of export" question is followed by a "which read" question,
and that second question includes a consolidated option.**

The kind chooser is unchanged: the full document with comments inline, or a digest of just
the highlighted passages. The new read chooser lists every read newest first, each with
its comment count, plus "All reads, in one file".

The read chooser is skipped when a document has only one read, since there would be
nothing to choose.

File names carry the read so two exports of the same document do not collide:
`Title-highlights-read-2-2026-10-14.md`. The consolidated export uses `all-reads`.

Inside a consolidated file, each read becomes a `## Read N · October 2026` section.

## Every exported thought says when you had it

**Added 2026-10-15, after Rishabh read an export and found it unreadable.** His words:

> *"the comments are very weird, they just use an arrow after 'quoted highlight'.. I want
> them to say something like: MY THOUGHT ON SEP 5 (or whatever date the comment was
> recorded on), so that when i export whether multiple reads, or single reads, we know how
> my thoughts changed over time."*

**He was right, and the fault was worse than cosmetic.** The export put a bare arrow in
front of every comment:

```
- "Clarity about what matters"
  → Seemed obvious when I first read it.
  → Six months on I think it is really about saying no.
```

Two sentences, no dates, in whatever order storage happened to hold them. The entire
purpose of keeping reads apart is to see what a passage did to you then and what it does
to you now — and this file could not tell you which was which, or even which came first.
The reads feature was working and its output was throwing the answer away.

It now reads:

```
- "Clarity about what matters"
  **MY THOUGHT ON MAR 2, 2026:** Seemed obvious when I first read it.
  **MY THOUGHT ON SEP 5, 2026:** Six months on I think it is really about saying no.
```

**Three decisions inside that change are worth stating, because none was in what he
asked for.**

**The year is always there**, although he wrote "SEP 5". The comments panel shows a bare
"Sep 5" and should — the panel is about now. An export is kept and read at an unknown
distance, and a file holding one read from 2024 and another from 2026 with both labelled
"SEP 5" would be worse than no date at all.

**The thoughts are sorted oldest first.** Dating them is only half of showing how they
changed; in storage order the column under a quote is a pile rather than a progression.
This is the half of his request that was not in his sentence.

**A copied comment is dated by the ORIGINAL thought, not by the day it was copied.** A
copy is a new record holding an old sentence, so dating it `createdAt` would file
something written in March under September — corrupting the exact comparison the label
exists to support. Copies now carry an `originalCreatedAt`, and the label marks them
`(copied)` so two identical dated lines under different reads read as deliberate rather
than as a bug. **This is the subtle one**: the naive implementation looks completely
correct and is wrong only in the case the feature is for.

**All three export shapes changed, not just the one he was looking at.** The digest, the
whole-document export and the video transcript all used different labels — an arrow, a
bare `COMMENT`, and a bare `💬`. They now share one label, so one reading habit works on
any of them. In the transcript the date sits beside the video position, because *when you
thought it* and *where in the video you were* are two different facts and a note made on
a second watch is the reason to print both.

## When a read begins

**The moment you open a document, not the moment you open the comments panel.**

`js/reader.js:187` calls `FolioStore.ensureReads(docId)` as part of rendering a document.
This was not the first design — reads were created lazily, the first time the comments
panel drew itself — and the browser probe caught it immediately: open a document, ask the
store what reads it has, get an empty array. A document that has been opened has been
read, so that is the honest moment for the record to exist. It is also where the one-time
migration of a pre-reads document runs.

## How this was verified

**Three layers, and the middle one found a real fault.**

| Layer | What it covers | Result |
|-------|----------------|--------|
| `test/reads.selftest.js` | The real store's migration, numbering, colours, deletion and backup; renaming, deleting, moving and copying; the inclusion rule; all four export shapes | 67 assertions, all passing |
| Mutation proof | Twenty-two rules broken one at a time to confirm the assertions notice | All 22 caught; suite back to 67/0 after restore |
| `test/browser/reads.probe.html` | The real app in headless Chrome, seeded with a pre-reads document | 25 assertions, all passing |
| `test/browser/readsedit.probe.html` | Naming, deleting, moving and copying through the real UI | 30 assertions, all passing |
| Screenshots | `tools/shoot-reads.sh` renders the panel so it can be looked at | 3 rounds; one real fault found and fixed |

**The mutation proof is the part worth trusting.** Breaking the inclusion rule to the
naive version — keep only this read's highlights — failed three assertions, which is the
evidence that those assertions are actually guarding the rule rather than passing by luck.

**The browser probe found a second fault, and it is the kind only a browser can find.**
Moving a comment restamps its highlight's colour in storage, and the handler called
`applyHighlights` to repaint the page. That does nothing: `applyHighlights` deliberately
skips text already inside a mark, so that calling it twice cannot nest marks — which
means it refuses to touch precisely the marks that need changing. The page kept showing
the old read's colour while storage said otherwise. `Highlights.syncHighlightColors`
exists for this, and the probe asserts the colour ON THE PAGE rather than in storage,
which is the only reason it was caught.

**Two test fixtures were wrong before the code was.** One claimed to test a passage
shared between two reads but moved both comments into the same read, leaving nothing in
any other read; the other asserted a hardcoded read id that an earlier case had
legitimately changed. Both failed, correctly, and the fixtures were what needed fixing —
noted here because a fixture that is quietly adjusted to match the code proves nothing.

**The designer pass found one real fault.** The read's colour dot used the same
translucent class as the highlight marks, and at 10px on a cream strip a 40%-alpha fill
reads as a grey smudge — useless as a colour key. The dot now has opaque siblings of
those colours (`css/highlights.css`), and the second and third rounds confirmed all four
colours are legible in both the light and dark themes.

## Files changed

| File | What changed |
|------|--------------|
| `js/store.js` | Reads CRUD, `ensureReads` migration, deletion and backup wiring |
| `js/highlights.js` | Stamp `readId` on new highlights, default colour from the read |
| `js/comments.js` | Stamp `readId` on new comments, read bar, read chips, export filtering and chooser |
| `index.html` | Read bar markup in the comments panel |
| `index-electron.html` | The same markup, kept in sync |
| `css/highlights.css` | Read bar, chips, the reads manager and the move/copy picker |
| `js/highlights.js` | `syncHighlightColors` — repaint marks after a highlight changes read |

## What I did not do

**The honest gap list.**

- **Nobody has used this on a device.** Every assertion passes and the screenshots look
  right, but the status of this work is BUILT, not DONE. Only using it moves it.
- **Reads still cannot be MERGED.** Renaming and deleting now exist, and deleting
  effectively merges a read into its neighbour, but there is no way to merge two reads
  that are not next to each other without deleting everything between them.
- **The colours cycle after four reads**, so Read 5 looks exactly like Read 1 on the page
  and in the panel. The read NUMBER still distinguishes them everywhere, and the export
  filters on `readId` rather than colour, so nothing is actually wrong — it is only the
  visual shorthand that runs out.
- **Comments move and copy one at a time.** If you forgot to press "New read" and wrote
  six comments, that is six trips through the picker. A way to move several at once is
  the obvious next thing.
- **Highlights cannot be moved or copied on their own.** A highlight only changes read as
  a side effect of moving the comment attached to it, so a highlight you made in the wrong
  read with nothing written about it is stuck there.
- **A copy and its original drift apart.** Editing one does not change the other, which is
  probably right — they are in different reads and may want different wording — but
  nothing says so in the interface.
- **The Electron panel got the markup but was not run.** `index-electron.html` has the
  same read bar and loads the same JavaScript, so it should behave identically, but I
  tested in the browser only.
- **No Android or iOS anything** — Folio is a web and macOS app, so this is not a gap,
  but worth saying rather than leaving implied.
- **I did not test what happens with a very large number of reads** (dozens). The read
  chooser lists every one of them in a modal, which will get tall and start scrolling.
- **The read chooser's comment counts are comments only.** A read in which you only
  highlighted and never commented shows "0 comments", which undersells it.

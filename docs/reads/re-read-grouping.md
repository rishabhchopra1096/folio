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
- **Old documents are migrated, not stranded.** Anything you wrote before this feature
  existed becomes "Read 1" automatically, dated from your earliest note.
- **The one subtle rule:** a comment written in Read 2 about a highlight made in Read 1
  keeps its quote in the export. Filtering highlights naively by read would strip the
  quote and turn the comment into an orphan.

## Document map

**The data model** says what gets stored and where · **Migration** explains how existing
documents join the scheme without losing anything · **The inclusion rule** is the one
piece of logic that is easy to get wrong and worth reading carefully · **The UI** covers
the bar in the comments panel, the per-comment labels and the colours · **Export**
covers the chooser and the file shapes · **Files changed** is the map of the work ·
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
| `test/reads.selftest.js` | The real store's migration, numbering, colours, deletion and backup; the inclusion rule; all four export shapes | 36 assertions, all passing |
| Mutation proof | Ten rules broken one at a time to confirm the assertions notice | All 10 caught; suite back to 36/0 after restore |
| `test/browser/reads.probe.html` | The real app in headless Chrome, seeded with a pre-reads document | 25 assertions, all passing |
| Screenshots | `tools/shoot-reads.sh` renders the panel so it can be looked at | 3 rounds; one real fault found and fixed |

**The mutation proof is the part worth trusting.** Breaking the inclusion rule to the
naive version — keep only this read's highlights — failed three assertions, which is the
evidence that those assertions are actually guarding the rule rather than passing by luck.

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
| `css/highlights.css` | Read bar and read chip styles |

## What I did not do

**The honest gap list.**

- **Nobody has used this on a device.** Every assertion passes and the screenshots look
  right, but the status of this work is BUILT, not DONE. Only using it moves it.
- **Reads cannot be renamed, deleted or merged.** A read started by accident is there for
  good. That is a deliberate omission for a first version — it keeps the data model to
  append-only, which is what makes it impossible to orphan a comment — but it will be the
  first thing to want.
- **The colours cycle after four reads**, so Read 5 looks exactly like Read 1 on the page
  and in the panel. The read NUMBER still distinguishes them everywhere, and the export
  filters on `readId` rather than colour, so nothing is actually wrong — it is only the
  visual shorthand that runs out.
- **I did not add a way to move a comment between reads.** If you forget to press
  "New read" and write three comments before noticing, they belong to the old read and
  there is no way to reassign them.
- **The Electron panel got the markup but was not run.** `index-electron.html` has the
  same read bar and loads the same JavaScript, so it should behave identically, but I
  tested in the browser only.
- **No Android or iOS anything** — Folio is a web and macOS app, so this is not a gap,
  but worth saying rather than leaving implied.
- **I did not test what happens with a very large number of reads** (dozens). The read
  chooser lists every one of them in a modal, which will get tall and start scrolling.
- **The read chooser's comment counts are comments only.** A read in which you only
  highlighted and never commented shows "0 comments", which undersells it.

# Notion exports with inline images

*Started 29 October 2026. Asked for: "just making them visible in folio so that I
can view them and comment while viewing them will be enough."*

## TL;DR

- **A Notion export is a folder**: one `.md` file, and a sibling subfolder holding
  the pictures. The markdown points at them with relative paths like
  `My%20Page%20abc123/Untitled.png`.
- **Folio was dropping every one of them, silently.** The markdown converter only
  accepted `http(s):` and `data:` sources, so a relative path returned `null` and
  the picture vanished with no error (`js/markdown.js:206`).
- **Drawing pictures already worked.** Folio has had an image block and a reader
  case for it since pasted screenshots were added. Nothing new was needed there.
- **So the work was two things**: read the dropped folder (not just the one file),
  and let the converter resolve a relative path against the files that came with it.
- **The pictures are stored inside the page, as data URLs** — the same way a pasted
  screenshot already is. This is the quick route, chosen deliberately.
- **MEASURED AGAINST THE REAL EXPORTS AFTERWARDS, and the quick route does not fit
  the big ones.** Every path matched — 118 of 118 in one export, 59 of 59 in another
  — but that export is 12.71MB of pictures, about 17.4MB once base64 has added its
  third, against a 10.00MB ceiling for the whole app. Small exports work today; the
  big ones need the pictures out of the page. See **What the real exports measured**.

## Document map

- **How a Notion export is laid out** — what the files and paths actually look like.
- **What happens when you drop the folder** — the path a picture takes to the screen.
- **Matching a path to a file** — why three keys are tried, and not one.
- **The storage ceiling** — the 10MB limit, what fills it, and what happens when it does.
- **What the real exports measured** — four of his own exports, run through the matcher.
- **What saving a page of pictures cost** — the typing freeze this uncovered, and the fix.
- **What was changed** — every file touched, and why.
- **What this does NOT do** — the honest gap list.

## How a Notion export is laid out

**One markdown file, one subfolder of pictures beside it, and URL-encoded relative
paths between them.** Unzipped, a single exported page looks like this:

```
Export/
  Reading the Market 24f8e1c0b3f5801aa9f1/      ← subfolder, name ends in the page id
    Untitled.png
    Screenshot 2026-10-02 at 11.04.13.png
  Reading the Market 24f8e1c0b3f5801aa9f1.md    ← the page
```

Inside the `.md`, each picture is an ordinary markdown image whose path is relative
to the markdown file's own directory, with spaces percent-encoded:

```markdown
![](Reading%20the%20Market%2024f8e1c0b3f5801aa9f1/Untitled.png)
```

Two details matter. The path is **encoded**, so it has to be decoded before it can
be matched against a real filename. And it is relative **to the markdown file**, not
to whatever folder you happened to drag in — which is why matching tries more than
one key.

## What happens when you drop the folder

**The drop is read as a tree, the pictures are turned into data URLs first, and only
then is the markdown converted.** The order is forced by the fact that reading a
file is asynchronous and the markdown converter is synchronous, which is worth
keeping: the converter stays a pure function that the Node tests can call.

1. **Collect the entries synchronously.** `webkitGetAsEntry()` has to be called
   while the drop event is still being handled; the item list is emptied the moment
   the handler returns. So the entries are grabbed first and walked afterwards.
2. **Walk the tree** for `.md`/`.markdown`/`.txt` files and picture files, keeping
   each one's path relative to the dropped folder.
3. **Find which pictures the markdown actually asks for** (`FolioMarkdown.imageRefs`),
   so an export folder holding fifty unused files only costs the ones in use.
4. **Compress each one** through the same `compressImage` a pasted screenshot goes
   through — untouched under 500KB, otherwise resized to 1800px and JPEG-encoded.
5. **Convert the markdown**, handing the converter a lookup function. A relative
   path now resolves; anything it cannot find is still refused.
6. **Create the page.** If storage is full the page is deleted again rather than
   left in the sidebar with nothing in it.

## Matching a path to a file

**Three keys are tried in order — full path, path relative to the markdown file,
then bare filename — because the right one depends on which folder got dragged.**

Drag the outer `Export/` folder and the walk sees `Export/Reading the Market …/Untitled.png`,
while the markdown asks for `Reading the Market …/Untitled.png`. Drag the inner folder
instead and the two agree. Neither is wrong, and asking someone to drag a particular
level of a folder tree is the kind of instruction nobody reads.

So every file is registered under all three keys, and a lookup walks from most
specific to least. The bare filename is last because it is the one that can collide:
two subfolders can both hold `Untitled.png`. It is still better than the alternative,
which is a missing picture.

## The storage ceiling

**Chrome allows this origin 10.00MB of ordinary storage in total, and a page with
its pictures inside it can fill that on its own.** This already happened once, on
17 October, when saving stopped working across the whole app — the reason
`js/store.js` now compresses pages at all.

Pictures make it worse than prose does, in two ways. A data URL is base64, which is
a third larger than the bytes it carries. And those bytes are already compressed
(PNG, JPEG), so lz-string gains almost nothing on them — the compression that
rescued text does not rescue pictures.

Rough usable budget: **3 to 4MB of original picture bytes across the entire app.**
A page with half a dozen diagrams is comfortable. A page with twenty screenshots
is not.

What happens when it does not fit: the import stops, the half-made page is removed,
and the message says storage is full rather than failing quietly. Nothing already
saved is touched.

**The replacement, when this becomes annoying:** keep the bytes in IndexedDB and
store only a short reference in the page. Folio already does exactly this for
read-aloud audio (`js/speechify.js:748` onwards — blob store, durable-storage
request, oldest-first eviction, degrades in private mode), with a 250MB budget
instead of 10MB. That was costed at about half a day and deliberately deferred.

## What the real exports measured

**Every relative path matched a real file, and the biggest export is too big to fit
in a page.** Both halves of that were measured rather than reasoned about, by running
the real matcher and the real converter over four exports already sitting in
`~/Downloads`:

| Export | Pictures | Paths matched | On disk | As base64 in a page |
|---|---|---|---|---|
| The Complete BrighterDay Experience | 118 | **118 of 118** | 12.71MB | ~17.4MB |
| The Complete Brighter Day Experience Proposal | 59 | **59 of 59** | 6.82MB | ~9.3MB |
| Phase 1 + Phase 2 Testing | 6 | **6 of 6** | 3.43MB | ~4.7MB |
| Customer Research | 4 | **4 of 4** | 2.41MB | ~3.3MB |

**The matching is settled.** Two different folder shapes appear in those four — a
subfolder named after the page with the Notion id on the end, and one named after the
page without it — and both resolve. The `.DS_Store` and any CSV are ignored by the
extension filter.

**The sizes are not.** The ceiling is 10.00MB for everything Folio stores, and his
76 existing pages of prose already use part of it. So of those four, the two small
ones fit and the two large ones cannot.

**And the existing compressor cannot rescue them**, which was worth checking rather
than assuming. Measured over those 118 files: median 98KB, largest 342KB, **not one
of them over the 500KB threshold where `compressImage` engages**, and already only
768×1376 — so the import leaves every one of them exactly as it found it, correctly.
There is no tuning of that threshold that makes 12.71MB fit in 10MB; it would only
trade the ceiling for blurred screenshots.

**The conclusion, plainly: pictures have to leave the page for his main documents to
open.** That is the IndexedDB route costed below, and it is no longer a later nicety.

## What saving a page of pictures cost

**Putting pictures in a page made every save of that page freeze the editor for about
a second, and the fix was to stop compressing what cannot compress.**

This was not in the plan; it turned up when the cost of the quick route was measured
instead of assumed. `js/store.js` compresses page content, and it has to — a megabyte
of prose becomes 20KB, which is why saving works at all. But lz-string is synchronous,
and a data URL is base64 of bytes a JPEG encoder already squeezed, so there is nothing
left to find:

| Page | Saved | Cost, on every save |
|---|---|---|
| 1MB of prose | 1056KB | 258ms |
| 200KB prose + a 500KB picture | 220KB | 353ms |
| 200KB prose + a 2MB picture | 422KB | 1318ms |
| 20KB prose + six 300KB pictures | 204KB | 1188ms |

Those bottom three run each time typing pauses. Over a second of blocked main thread
to win about 2% of the budget, and a keystroke landing inside that second is dropped.

**The fix:** a page whose bytes are mostly picture is stored uncompressed. The share
is measured, not guessed from the presence of the words `data:image/`, because a long
document with one screenshot in it should still be compressed and a document *about*
data URLs certainly should. The scan costs 1.8ms on a 2.9MB page; a page with no
picture at all is rejected by one `indexOf` in half a millisecond.

Three mutations prove the rule: never firing, always firing, and firing on a bare
substring match each break the test.

## What was changed

| File | Why |
|---|---|
| `js/markdown.js` | Optional `resolveImage` lookup; `imageRefs()` to list what a document asks for |
| `js/folder-import.js` | New. Walks a dropped folder, keys the assets, builds the data URLs |
| `js/editor.js` | Exports `compressImage` so there is one compressor, not two |
| `js/sidebar.js` | The drop handler reads folders; single `.md` files behave exactly as before |
| `js/app.js` | The welcome dropzone calls the same import path instead of its own copy |
| `index.html`, `index-electron.html` | Load the new module |
| `test/notion-folder-import.selftest.js` | New. Path keying and resolution |
| `test/markdown-import.selftest.js` | Relative paths resolve; unresolvable ones stay refused |

## What this does NOT do

- **Pictures are not stored outside the page**, so the 10MB ceiling above applies.
  This was the explicit choice: working today, better later.
- **Dropping a `.zip` straight from Notion does not work.** It has to be unzipped
  first. Folio has no zip library and adding one was not worth it today.
- **Subpages come in flat.** A Notion export of a page with children has several
  `.md` files; each becomes its own top-level page rather than nesting under its
  parent. The folder hierarchy is not mapped to Folio's `parentId`.
- **A comment cannot be attached to a picture.** Comments anchor to highlighted
  text, so pictures are visible while you comment, which is what was asked for,
  but the picture itself is not a comment target.
- **Safari's drop may not give a folder.** `webkitGetAsEntry` is the API this uses;
  it works in Chrome and in the Electron panel. Dropping loose files still works
  everywhere.
- **Not tried on a real export yet** at the time of writing — see the progress note
  at the end for what has actually been run.

## What was actually run

**Three layers, and the numbers each produced.** Nothing below is a claim about code
that was not executed.

- **`bash test/run-all.sh` — 35 suites, 1102 assertions, 0 failed.** Includes the two
  new suites: relative-path resolution in the converter, and the compression rule.
- **`bash test/browser/run.sh notionfolder` — 27 assertions, 0 failed.** The real app
  in headless Chrome, handed a folder-shaped drop with real `File` objects. It asserts
  what jsdom structurally cannot: that `naturalWidth > 0` — the browser decoded the
  pixels — in the editor AND in read mode, which are separate renderers.
- **The other probes that touch what was changed** — `editorsaves` (13), `compaction`
  (18), `storagefull` (22), `import` (18) — all 0 failed.
- **Mutation proofs.** Six, each confirmed to fail the suite and then restored: the
  compression rule never firing / always firing / matching a bare substring; the
  markdown-directory key dropped from the path matching; percent-decoding removed; and
  the lookup allowed to return any source at all.
- **The real exports.** Four of his own, run through the real matcher and the real
  converter — the table above.

**One test caught a real bug while being written**: the sidebar's one-line forwarder
to the converter took a single argument, so the picture lookup was silently dropped
and every relative path resolved correctly inside the converter and arrived as
nothing. Routing the assertion through the sidebar's name rather than the converter's
is what exposed it.

**One probe assertion was too weak and was strengthened.** "Dragging the outer folder
still finds the pictures" passed through the bare-filename fallback, so it proved
nothing about the key it was named after. A decoy `Untitled.png` in a second folder
— the commonest filename in any export — now makes it fail when that key is removed.

## Progress

- 29 Oct: read the existing import, converter, image block and store. Wrote the plan.
- 29 Oct: built it. Converter takes a lookup; new `js/folder-import.js` walks the drop;
  both drop handlers share one path; `compressImage` exported rather than duplicated.
- 29 Oct: found and fixed a pre-existing double import — the welcome dropzone and the
  document-level handler both ran, so a file dropped on the welcome screen made two
  pages. `stopPropagation` in `js/app.js`, with a probe assertion on it.
- 29 Oct: measured the save cost, found the typing freeze, and stopped compressing
  picture-dominated pages.
- 29 Oct: measured four real exports. Paths: perfect. Sizes: the two big ones do not
  fit, and cannot be made to fit by compressing harder. Raised with him.

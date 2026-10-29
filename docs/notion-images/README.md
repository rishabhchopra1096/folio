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
- **MEASURED AGAINST THE REAL EXPORTS, and the quick route did not fit the big ones.**
  Every path matched — 118 of 118 in one export, 59 of 59 in another — but that export
  is 12.71MB of pictures, about 17.4MB once base64 has added its third, against a
  10.00MB ceiling for the whole app. See **What the real exports measured**.
- **SO THE PICTURES WERE MOVED OUT OF THE PAGE.** They are blobs in IndexedDB now
  (`js/images.js`, 250MB budget) and a page holds a 36-character reference instead.
  A document of 120 screenshots and 12MB imports, saves as a 5KB page, and draws —
  proven in a real browser, not reasoned about. See **Pictures live outside the page**.
- **Pasted screenshots take the same route**, because they were eating the same 10MB
  budget. Pages that already hold pasted pictures are untouched and still render.

## Document map

- **How a Notion export is laid out** — what the files and paths actually look like.
- **What happens when you drop the folder** — the path a picture takes to the screen.
- **Matching a path to a file** — why three keys are tried, and not one.
- **The storage ceiling** — the 10MB limit, what fills it, and what happens when it does.
- **How big a picture is on the page** — the height cap, his call, and the unit that lied.
- **Pictures live outside the page** — the store, the two data shapes, and the lifecycle.
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

## Pictures live outside the page

**A picture is a blob in IndexedDB and a page holds its name.** That is the whole
change, and it is what makes a 12MB document openable.

**The two shapes a page can hold, both permanent:**

```
{ type: "image", data: { ref: "img_a3f2c1...", caption: "..." } }   in the store
{ type: "image", data: { url: "data:image/...", caption: "..." } }  in the page
```

Everything written from now on is the first. Every page written before today is the
second, **and no page is migrated** — both renderers accept either, so nothing has to
be opened to be rescued and nothing can be broken by a migration that goes wrong.

**Why it looks like `js/speechify.js`.** That file already solved this for read-aloud
audio: a blob store, a request for durable storage, eviction oldest-first, and a
graceful collapse to nothing in private browsing. Copying a shape that has been in use
for weeks is worth more than a cleverer one invented today.

**The name is a hash of the bytes**, so the same screenshot in two places costs once.
That is not a micro-optimisation on a Notion export — a before-and-after pair, or a
diagram referred to twice, genuinely stores once — and the hash is free because a
stable name was needed anyway.

**Resolution happens after render, in both views.** Editor.js requires `render()` to
return a node synchronously and the reader builds its HTML in one string; reading a
blob is asynchronous. So the `<img>` goes out with `data-folio-ref` and no `src`, and
`FolioImages.attach` fills it. A reference that is not in this browser — a page opened
elsewhere, storage cleared — leaves a short note where the picture would be, because an
`<img>` with no `src` collapses to nothing and a broken one shows the torn-paper icon,
and neither tells anybody what happened.

**Three things delete pictures, in order of reliability:**

1. **Deleting a page** releases the pictures recorded against it.
2. **The collector**, on idle at startup, deletes anything no page refers to. It
   refuses to delete at all if it cannot read the pages, because an empty reference set
   from a failed read is indistinguishable from a store full of orphans — and it leaves
   alone anything written in the last ten minutes, so an import in flight is safe.
3. **The sweep**, after an import, holds the store under 250MB oldest-used first.

**One optimisation measured and deliberately NOT made.** A picture goes File → data
URL (through the shared compressor) → Blob, which round-trips through base64 for no
reason on the common case where the compressor leaves the file alone — which is all
118 of his. Timed before changing anything: 12ms of CPU across 118 pictures, plus a
22MB string and one `fetch` each. Skipping it would mean a second path through the
compressor and a second place that knows the 500KB threshold, to save 12ms. Left as
it is.

**The race that the probe caught.** Claiming 120 pictures for a page was 240 separate
IndexedDB transactions, fire-and-forget. It finished, but slowly enough that a page
deleted immediately afterwards ran its cleanup while a few pictures were still
unclaimed — and an unclaimed picture is one that cleanup cannot find. Measured: 119 of
120 released, one left behind. It is one transaction now, and awaited.

## How big a picture is on the page

**Capped in height, at his call, because everything that arrives here is
portrait.** A phone screenshot from a Notion export and a 9:16 illustration from
the story outlines are both about a screen tall at the full column width, so a
document with a picture after every section read as a screen of picture, a screen
of prose, a screen of picture — and the writing stopped being the spine of it.

Shown to him both ways before anything in `css/` was touched, rendered from his
own story outline rather than from a mock-up. His answer: *"Smaller, so two beats
fit a screen."*

`--picture-max-height: 520px` in `css/variables.css`, used by the editor and the
reader so the two can never disagree. The number was chosen by looking: at that
size a phone screenshot is still legible down to the words on its buttons, and
two sections fit in one screen instead of one. A landscape picture at this column
width is around 340px tall, so it never reaches the cap and nothing about it
changes.

**The trap this walked into first.** The candidate was staged as `62vh`, and the
screenshot came back identical to the uncapped one. `vh` is measured against the
viewport, and the screenshot harness renders the app in a deliberately 5200px-tall
iframe so the whole article is captured — 62% of which is larger than any picture
in the document. The cap was real; the unit made it unreachable. **A styling
candidate staged inside the shot harness has to avoid viewport units, or it is
being measured against the harness rather than the app.**

## What was changed

| File | Why |
|---|---|
| `js/markdown.js` | Optional `resolveImage` lookup; `imageRefs()` to list what a document asks for |
| `js/folder-import.js` | New. Walks a dropped folder, keys the assets, builds the data URLs |
| `js/editor.js` | Exports `compressImage` so there is one compressor, not two |
| `js/sidebar.js` | The drop handler reads folders; single `.md` files behave exactly as before |
| `js/app.js` | The welcome dropzone calls the same import path instead of its own copy |
| `index.html`, `index-electron.html` | Load the new module |
| `js/images.js` | New. The picture store: blobs in IndexedDB, references in pages |
| `js/reader.js` | Draws a reference; also escapes attributes, which it did not |
| `css/editor.css` | A note where a missing picture would be; the height cap in both views |
| `css/variables.css` | `--picture-max-height`, so the editor and the reader cannot disagree |
| `test/notion-folder-import.selftest.js` | New. Path keying and resolution |
| `test/picture-pages-skip-compression.selftest.js` | New. Prose still compresses, pictures do not |
| `test/browser/notionfolder.probe.html` | New. 63 assertions in a real browser |
| `test/markdown-import.selftest.js` | Relative paths resolve; unresolvable ones stay refused |

## What this does NOT do

- **Pages written before today still hold their pictures inline**, so those pages
  still count against the 10MB ceiling. They render exactly as they always did;
  nothing was migrated, on purpose. Moving them out would free real space and is
  worth doing deliberately rather than as a side effect of this.
- **Pictures are per browser.** They are in IndexedDB, so a page opened in a
  different browser, or after storage is cleared, shows a note where each picture
  was rather than the picture. Nothing syncs them.
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
- **The markdown export still drops images entirely.** It did before this too — an
  image block falls through to the default case and produces an empty string — so
  nothing was made worse, but nothing was fixed either. Doing it properly means
  writing the picture files out beside the markdown.
- **Not dragged in by hand from a real folder.** The matcher has been run over four
  real exports on disk and the drop has been driven in a real browser with real File
  objects, but a human dragging a folder from Finder is the one step no test here
  performs.

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
- **Every other probe that touches what changed**, after the picture store landed:
  `import` 18, `editorsaves` 13, `compaction` 18, `storagefull` 22, `pastevanishes`
  17, `staleeditor` 8, `readsedit` 30, `highlightcomment` 12 — all 0 failed.

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
- 29 Oct: pushed the folder import live and verified by hashing the served files.
- 29 Oct: his call — build the picture store now. Did: `js/images.js`, both renderers
  taught to resolve a reference, deletion and a collector, and pasted screenshots on
  the same route. A 120-picture, 12MB document now imports and draws.
- 29 Oct: the probe caught the claim race (119 of 120 released on delete) and the fact
  that two of its own assertions were being carried by the grace period rather than by
  what they claimed to test. Both fixed, both now fail when the code is broken.
- 29 Oct: imported his two brighter-day story outlines — 65 real illustrations, 36.64MB,
  which as base64 would have been 50.20MB. Both pages, every picture drawn. Checked the
  folders first: the mapping from "Picture for beat N" to D3-NN.png was already perfect
  in both, 37 of 37 and 28 of 28, so nothing needed reorganising — only linking.
- 29 Oct: showed him the result at two picture sizes and capped the height at his answer.

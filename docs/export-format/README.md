# Telling a thought apart from the thing it is about

## TL;DR

- **An export used to print the document twice.** Every note carried the whole highlighted passage verbatim, and that passage was already on the page a line above. In one real export that came to 10,873 characters of quoted passage against 9,834 characters of actual thinking — the quotes were longer than the thoughts, and 18.5% of the file was the document repeated.
- **That duplication, not a quiet label, was why a reader could not tell note from document.** Both copies were the document. Making the label louder would not have fixed anything.
- **The quote wrapper was already broken on most notes.** 14 of 22 highlighted passages contained a straight double quote of their own, so `on "<passage>"` closed early. One passage began with a quote mark, producing `on ""What's your marketing plan?" ...`.
- **A note is now a fenced block.** Every line carries `> `, so no line of a note can be read as prose and the note ends at the first line without one. The passage is named by its opening words, not reprinted. A line at the top of the file explains the convention and counts the notes.
- **Three things were decided rather than assumed**, and all three went to him as a question: keep the full quote when the passage has been deleted, keep the paragraph breaks he types, and print a short passage whole rather than shortening it to nearly its own length.
- **Proved by 53 new assertions across two suites, 13 mutations all caught, and a render check through the app's own markdown library** — because "the file has a `>` on every line" and "a reader sees a note as a note" are different claims.
- **Status: BUILT.** The code is live and the suites are green. Nobody has exported a real document through it and read the result on his own machine yet.

## Document map

**What was wrong** is the three measured faults and how they were found · **What it looks like now** is the before and after · **The three decisions** is what he chose and why each alternative was worse · **Where the rules live** names the five helpers and what each guarantees · **What is proved and how** covers the suites, the mutations and the render check · **What this did NOT change** lists the export shapes left alone and why · **Still open** is the honest gap list.

---

## What was wrong

**The complaint named a symptom; measuring the file found three separate causes, and the one the complaint pointed at was not among them.**

The report was: *"I think this will confuse an AI on what's the actual text, and what's the comment."* The obvious reading is that the label was not loud enough. It was perfectly loud. A real export of 22 notes was parsed apart and measured, and this is what it actually held:

| What was measured | What it came to |
|---|---|
| Characters of quoted passage | 10,873 |
| Characters of his own thinking | 9,834 |
| Quoted passage as a share of the file | 18.5% |
| Quotes found verbatim elsewhere in the same file | 20 of 22 |
| Quotes containing a straight double quote of their own | 14 of 22 |
| Longest single quoted passage | 1,502 characters, spanning five paragraphs |

**Fault one — the passage was printed twice.** A highlight is by definition text that is already on the page. Quoting it in full therefore duplicates it, and one note reproduced five paragraphs that appear immediately below it. This is the actual source of the confusion: when a note is mostly a second copy of the document, there is no reading of the file in which it is the commentary.

**Fault two — the wrapper closed early.** `on "<passage>"` works only for a passage with no quotes in it, and most of his passages had some. The worst case began with one, so the file said `on ""What's your marketing plan?" →` — an empty string followed by loose prose.

**Fault three — nothing marked the end.** A note was a plain markdown paragraph. The document simply resumed afterwards, with no boundary of any kind, so the end of a note could only be guessed from where the voice changed.

## What it looks like now

**Before** — one line, holding the whole passage, with the thought after a colon:

```
**MY THOUGHT ON OCT 16, 2026** on "The kid who opens the app for the third time has the
same experience as the kid who opened it for the first time. Nothing has accumulated.
Nothing has changed. Nothing is pulling them forward.": Exactly, she needs to
understand this pain along with the North Star Matrix when we pitch.
```

**After** — a fenced block, the passage named rather than reprinted:

```
The kid who opens the app for the third time has the same experience as the kid who
opened it for the first time. Nothing has accumulated. Nothing has changed.

> **MY THOUGHT ON OCT 16, 2026**
> *on the highlighted passage “The kid who opens the app for the third time has the
> same experience as the kid…”*
>
> Exactly, she needs to understand this pain along with the North Star Matrix when
> we pitch.

Nothing is pulling them forward.
```

And one line under the file's own heading, which is the cheapest part of the whole change:

```
_**How to read this file.** The prose is the document. Every indented block headed
**MY THOUGHT ON** is a note I wrote in the margin on the date shown — my own
commentary, not part of the document. There are 22 such notes below._
```

**The count in that sentence is deliberate.** It makes a note lost in a copy-paste detectable: the file states how many it contains, so a reader can check rather than assume.

## The three decisions

**Each of these had a defensible alternative, so each was asked rather than decided quietly.**

**A deleted passage keeps its full quote.** When a passage is still in the document, the note only needs enough of it to be found by eye, because the passage is sitting directly above. When the passage has been edited out, the note holds the *only* surviving copy of what was being read — so shortening it there would destroy the record. The alternative, one rule with no exceptions, is simpler to explain and quietly loses information in the one case where the quote is load-bearing.

**The paragraph breaks he types survive.** Every export used to collapse a note to a single line, which turned his longest thought — 1,566 characters covering several distinct points — into one wall of text. A blank line in the note is now a blank *quoted* line in the file. A single newline is still collapsed, because that is a soft wrap and markdown treats it the same way.

**A short passage prints whole.** Under about a hundred characters there is nothing to save by trimming, and a trimmed version would be nearly as long as the original while being less precise. Above that, roughly ninety characters of opening words, cut at a word boundary.

## Where the rules live

**All five helpers sit together in `js/comments.js`, above the export sections, each with the fault it exists to prevent written above it.**

| Helper | What it guarantees |
|---|---|
| `curlyQuote` | Typographic quotes, so the straight quotes inside a passage cannot close the wrapper. It is decoration; the real boundary is the fence on every line. |
| `passageLocator` | A passage over about a hundred characters is cut at a word boundary with an ellipsis. Under it, printed whole. Never longer than its budget, however long the passage. |
| `thoughtParagraphs` | Blank lines become paragraphs; single newlines collapse as soft wraps. |
| `thoughtBlock` | The fence itself: `> ` on every line including the blank ones, an optional indent so a note can hang off a transcript line, and an optional glyph. |
| `readingLegend` | The sentence at the top, with the count. Returns nothing when there are no notes, because announcing a convention that never appears is a small lie. |

**One shape now covers both interleaved exports.** A page of prose and a video transcript both mix the same two kinds of writing, so they get the same fence and the same legend. The transcript's note keeps its speech bubble and its position in the video, and carries no passage locator — a note on a video is anchored by its moment, not by quoted text.

## What is proved, and how

**Every assertion was made to fail before it was trusted.**

| Layer | Count |
|---|---|
| `test/thought-fencing.selftest.js` — the bytes an export writes | 33 assertions |
| `test/thought-fence-renders.selftest.js` — what a reader actually sees | 20 assertions |
| Every jsdom suite, after updating four that were pinned to the old shape | 990 assertions, 0 failed |
| Every browser probe, including `exporttext` rewritten for the new contract | 294 assertions, 0 failed |
| Mutations applied to the real code, each caught | 13 of 13 |

**The render suite exists because the byte-level one cannot answer the question that matters.** Two shapes the export produces are not obviously legal markdown: a transcript note sits directly under its line with no blank line between, and a note's paragraphs are separated by a *quoted* blank line. The first relies on a block quote being allowed to interrupt a paragraph; the second on a quoted blank line not ending the quote. Both are true, and both were run through the app's own `vendor/marked.min.js` rather than taken on trust.

**Two of the suites were wrong before the code was.** The render suite's first version rendered markdown strings typed into the test, which made it a description of how markdown behaves rather than a test of this code — the export could have been broken in any way and every assertion would still have passed. And one mutation, *"a deleted passage shortened like any other,"* escaped every suite on the first run: the fixture's deleted passage was 101 characters, which the locator prints whole anyway, so the mutation produced byte-identical output. The fixture is now long enough that keeping it in full and shortening it look different.

## What this did NOT change

**The digest export was left alone deliberately.** It is a bullet list of quoted passages with the notes hanging off them and no document body at all, so there is nothing for a note to be confused with. Its orphan list did gain paragraph breaks, to match the rest of it.

**The label and the date are untouched.** `MY THOUGHT ON <DATE>`, the year always included, oldest first, a copied thought dated by the original and marked `(copied)` — all of that was decided on 15 October and none of it moved.

**The file name is unchanged**, so a re-export lands beside the old one rather than replacing it.

## Still open

- **Nobody has used it.** The code is live and every suite is green, but no real document has been exported through the new format on his own machine and read. That is the only check that counts, and it is his.
- **A passage containing a curly quote of its own would look slightly odd**, because the wrapper is also curly. Nothing breaks — the fence on every line is what carries the meaning — but the quotation marks would read as mismatched. No real document has hit this.
- **A note whose highlight RECORD was deleted still looks like a page-level note**, because with the highlight gone there is no passage text left anywhere to quote. This is unchanged from before and there is nothing to be done about it; it is written down so it is not rediscovered as a bug.
- **The locator and the label render on one line**, not two, because markdown joins them inside the blockquote's first paragraph. It reads well — "MY THOUGHT ON OCT 16, 2026 on the highlighted passage “…”" — but it was not what the samples showed him, and if he wants them on separate lines it is one extra quoted blank line.
- **The samples of his real export are kept out of git.** This repository is public and that document names a client, her son, dollar figures, and a sales strategy written on the assumption she will not read it. `docs/export-format/samples/` is in `.gitignore`; the files are on disk for local comparison and go no further.

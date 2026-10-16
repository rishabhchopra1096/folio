/*
 * =============================================================================
 * THOUGHT-FENCING.SELFTEST.JS — a note can never be mistaken for the document
 * =============================================================================
 * WHAT THIS SUITE PROVES, AND THE COMPLAINT THAT CAUSED IT:
 *
 * On 16 October 2026 a real export came back looking like this:
 *
 *   **MY THOUGHT ON OCT 16, 2026** on "<the entire paragraph, again>": <note>
 *
 * and the report was: "I think this will confuse an AI on what's the actual
 * text, and what's the comment."
 *
 * The obvious reading is that the LABEL was too quiet. Measuring the actual
 * file said otherwise. Three separate faults, and the label was none of them:
 *
 *   1. THE PASSAGE WAS PRINTED TWICE. A highlight is text that is already on
 *      the page, so quoting it in full duplicates it. In his file: 10,873
 *      characters of quote against 9,834 characters of his own thinking — the
 *      quotes were LONGER than the thoughts — 18.5% of the file was the
 *      document repeated, and 20 of 22 quotes were found verbatim elsewhere in
 *      the same file. That duplication IS the confusion: both copies are the
 *      document, so neither reads as the comment.
 *   2. THE QUOTE WRAPPER CLOSED EARLY. 14 of his 22 passages contain a
 *      straight double quote of their own. One passage BEGAN with one,
 *      producing `on ""What's your marketing plan?" ...`.
 *   3. NOTHING MARKED THE END OF A NOTE. It was a plain markdown paragraph,
 *      so the document simply resumed afterwards with no boundary.
 *
 * So each PART below pins one of those, plus the two things he chose when
 * asked: keep the paragraph breaks he types, and keep the FULL quote when the
 * passage has been deleted from the document.
 *
 *   PART A — THE FENCE. Every line of a note carries "> ", so no line can be
 *            read as document prose, and a note ends at the first line without
 *            one. This is the fault that cannot be fixed by a louder label.
 *   PART B — NO DUPLICATION. The tail of a long passage appears exactly once
 *            in the file: in the document, not also inside the note.
 *   PART C — THE LOCATOR. A short passage prints whole; a long one is cut at a
 *            word boundary with an ellipsis; the wrapper is curly so the
 *            straight quotes inside a passage cannot close it.
 *   PART D — THE LEGEND. The file explains its own convention before the first
 *            note, counts the notes so a lost one is detectable, and says
 *            nothing at all when there are no notes.
 *   PART E — PARAGRAPHS. A blank line the user typed survives the export; a
 *            soft wrap inside a paragraph still collapses.
 *   PART F — A DELETED PASSAGE. With the passage gone the note holds the only
 *            record of what was being read, so the quote is kept IN FULL and
 *            labelled as no longer present.
 *
 * WHY THE FIXTURE LOOKS LIKE THIS:
 * The passages below are modelled on the ones that actually failed in his
 * file — one long enough to be shortened, one containing its own double
 * quotes, one short enough to print whole. A fixture of tidy short sentences
 * would pass with every fault above still in the code.
 * =============================================================================
 */

const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const PANEL = `<div id="comments-panel"><div class="comments-header"></div>
  <div id="comments-read-bar" hidden><span id="comments-read-dot"></span>
  <span id="comments-read-label"></span><button id="comments-new-read"></button></div>
  <div id="comments-list"></div><textarea id="comment-input"></textarea>
  <button id="comment-submit"></button><button id="comment-cancel"></button>
  <button id="comments-close"></button><button id="comments-export"></button>
  <button id="comments-new-note"></button><button id="comment-mic-btn"></button>
  <div id="comments-resize"></div></div>`;

const dom = new JSDOM(`<!doctype html><body>${PANEL}</body>`, { url: "https://x.test" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.navigator = dom.window.navigator;
/* Without this the export finds NODE's URL, whose createObjectURL rejects the
 * fake Blob below. */
global.URL = dom.window.URL;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log("  ✓ " + n))
    : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : "")));
};

const WHEN = "2026-10-16T11:00:00Z";
const DOC = "doc_fence";
const EMPTY_DOC = "doc_fence_nonotes";

/*
 * THE PASSAGES, each chosen for the fault it exposes.
 *
 * LONG is over a hundred characters, so its locator must be cut — and its TAIL
 * is what Part B counts, because the HEAD legitimately appears in the locator.
 * QUOTED carries its own straight double quotes, which is what broke the old
 * wrapper on 14 of his 22 notes. SHORT is under the hundred-character floor,
 * so it must print whole rather than being shortened to nearly its own length.
 */
const LONG = "Brighter Day has a magical first moment and no second moment. " +
             "A kid spins the globe, watches a video, and then what? " +
             "The globe is a destination with no journey.";
const LONG_TAIL = "The globe is a destination with no journey.";
const QUOTED = 'The consultant asks "what would make the product market itself?" ' +
               'and then waits for the silence to finish doing its work.';
const SHORT = 'She said "it works" and meant it.';

const Store = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");
global.FolioStore = Store;

localStorage.setItem("folio_documents", JSON.stringify([
  { id: DOC, title: "First Principles", icon: "", parentId: null, order: 0,
    createdAt: WHEN, updatedAt: WHEN },
  { id: EMPTY_DOC, title: "Nothing Marked", icon: "", parentId: null, order: 1,
    createdAt: WHEN, updatedAt: WHEN },
]));
localStorage.setItem("folio_doc_" + DOC, JSON.stringify({ time: 1, blocks: [
  { type: "paragraph", data: { text: LONG } },
  { type: "paragraph", data: { text: QUOTED } },
  { type: "paragraph", data: { text: SHORT } },
]}));
localStorage.setItem("folio_doc_" + EMPTY_DOC, JSON.stringify({ time: 1, blocks: [
  { type: "paragraph", data: { text: "A page nobody has written on." } },
]}));
localStorage.setItem("folio_highlights_" + DOC, JSON.stringify([
  { id: "hl_long",  text: LONG,   color: "yellow", createdAt: WHEN },
  { id: "hl_quote", text: QUOTED, color: "green",  createdAt: WHEN },
  { id: "hl_short", text: SHORT,  color: "blue",   createdAt: WHEN },
  /*
   * A passage that was marked and has since been EDITED OUT of the document.
   * The highlight record survives in storage; its text is nowhere in the
   * blocks above. This is the only path on which a note still holds the one
   * remaining copy of what was being read, which is why that quote is kept in
   * full rather than shortened.
   *
   * It is NOT the same as a comment whose highlight record was itself deleted
   * — that one has no text left to quote and correctly joins the page-level
   * notes. The first version of this fixture used that case and so never ran
   * the code it was written to test.
   */
  /*
   * WELL over the hundred-character floor, on purpose. The first version of
   * this passage was 101 characters, which the locator prints whole anyway —
   * so a mutation that shortened a deleted passage like any other produced
   * byte-identical output and escaped every assertion. The fixture has to be
   * long enough that keeping it in full and shortening it look different.
   */
  { id: "hl_cut", color: "orange", createdAt: WHEN,
    text: "A sentence that used to be in this document and has since been cut out of it " +
          "entirely by a later edit, which is the whole reason the note about it now holds " +
          "the only surviving copy of what was actually being read at the time." },
]));
localStorage.setItem("folio_comments_" + DOC, JSON.stringify([
  { id: "c_long",  highlightId: "hl_long",
    text: "This is exactly why there is a need for a story.", createdAt: WHEN },
  { id: "c_quote", highlightId: "hl_quote",
    text: "Again, one of the things I already mentioned about the framing.", createdAt: WHEN },
  { id: "c_short", highlightId: "hl_short",
    text: "She already feels this.", createdAt: WHEN },
  /* Two real paragraphs, separated by a blank line — Part E. */
  { id: "c_paras", highlightId: "hl_long",
    text: "Perfect. It is a perfect bridge.\n\nAll of the answers have one answer: " +
          "they need to be in a story they live in.", createdAt: WHEN },
  /* A soft wrap, which must still collapse — the other half of Part E. */
  { id: "c_wrap",  highlightId: "hl_short",
    text: "One sentence that happens to be\nwrapped across two lines.", createdAt: WHEN },
  /* A note about the whole page: no passage at all, which is NOT the same as a
   * passage that was deleted. */
  { id: "c_page",  highlightId: null, isGeneral: true,
    text: "Worth re-reading before the meeting.", createdAt: WHEN },
  /* The passage this was about is gone from the document — Part F. */
  { id: "c_gone",  highlightId: "hl_cut",
    text: "The paragraph this was about has since been cut.", createdAt: WHEN },
]));
localStorage.setItem("folio_comments_" + EMPTY_DOC, JSON.stringify([]));
Store.ensureReads(DOC);
Store.ensureReads(EMPTY_DOC);

global.Reader = { getCurrentDocId: () => DOC };
global.Highlights = { applyHighlights: () => {}, syncHighlightColors: () => {} };
global.Gemini = { formatTime: (s) => String(s) };
global.SidebarUI = { blockToMarkdown: (b) => (b && b.data && b.data.text) || "" };

let captured = "";
global.Blob = class { constructor(parts) { captured = parts[0]; } };
dom.window.URL.createObjectURL = () => "blob:x";
dom.window.URL.revokeObjectURL = () => {};
const realCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (tag === "a") el.click = () => {};
  return el;
};

const commentsSrc = fs.readFileSync(REPO + "/js/comments.js", "utf8")
  .replace("  return {\n    init,",
    "  return {\n    __run: (kind, docId, readId) => runExport(kind, docId, readId),\n    init,");
const C = eval(commentsSrc + "; Comments;");
const run = (kind, docId, readId) => { captured = ""; C.__run(kind, docId, readId); return captured; };

const full = run("full", DOC, null);
const lines = full.split("\n");
const LEGEND_RE = /^_\*\*How to read this file/;
/* Lines belonging to a note, which is every fenced line. The legend names the
 * label while explaining it and is front matter rather than a note, so it is
 * correctly unfenced and excluded here. */
const fenced = lines.filter((l) => /^\s*>/.test(l));
const headers = lines.filter((l) => /^\s*> \*\*MY THOUGHT/.test(l));

/* ===========================================================================
 * PART A — THE FENCE
 * ===========================================================================
 */
console.log("\nPART A — a note cannot be read as the document");

ok("every note is headed by a fenced, dated label",
   headers.length === 7,
   headers.length + " headers for 7 notes:\n    " + headers.join("\n    "));

ok("...and no header sits unfenced at the document's own level",
   !lines.some((l) => /^\*\*MY THOUGHT/.test(l)),
   lines.find((l) => /^\*\*MY THOUGHT/.test(l)) || "");

/*
 * THE ASSERTION THAT MATTERS MOST. Walk the file, and for every fenced line
 * check that the note it belongs to began with a header. If any note's text
 * were emitted unfenced it would land outside a note and be read as prose.
 */
let noteLineCount = 0, strayText = null, inNote = false;
lines.forEach((l) => {
  if (LEGEND_RE.test(l)) return;
  if (/^\s*>/.test(l)) {
    if (/^\s*> \*\*MY THOUGHT/.test(l)) inNote = true;
    else if (!inNote) strayText = l;
    noteLineCount++;
  } else if (l.trim() === "") {
    /* A blank line ends the blockquote, which is exactly how the note's end is
     * detectable without a closing marker. */
    inNote = false;
  } else {
    inNote = false;
  }
});
ok("...and every fenced line belongs to a note that opened with a header",
   strayText === null, strayText || "");

ok("the thought's own words are fenced too, not left bare after the label",
   fenced.some((l) => /This is exactly why there is a need for a story/.test(l)),
   lines.find((l) => /need for a story/.test(l)) || "not found at all");

ok("...for every single note, with no exceptions",
   ["This is exactly why there is a need for a story",
    "Again, one of the things I already mentioned",
    "She already feels this",
    "It is a perfect bridge",
    "wrapped across two lines",
    "Worth re-reading before the meeting",
    "has since been cut"].every((t) =>
      lines.filter((l) => l.includes(t)).every((l) => /^\s*>/.test(l)) &&
      lines.some((l) => l.includes(t))),
   "a note's text was emitted outside the fence");

ok("a note ends at the first unfenced line, so the document resumes cleanly",
   /^> This is exactly why there is a need for a story\.\n\n/m.test(full) ||
   /^> This is exactly why there is a need for a story\.\n$/m.test(full),
   lines.slice(lines.findIndex((l) => /need for a story/.test(l)),
              lines.findIndex((l) => /need for a story/.test(l)) + 3).join(" ⏎ "));

ok("the document's own paragraphs stay unfenced",
   lines.some((l) => l === LONG) && lines.some((l) => l === QUOTED),
   "a document paragraph was swallowed into a note");

/* ===========================================================================
 * PART B — NO DUPLICATION
 * ===========================================================================
 */
console.log("\nPART B — the passage is not printed twice");

const tailCount = full.split(LONG_TAIL).length - 1;
ok("the tail of a long passage appears exactly once — in the document",
   tailCount === 1,
   "found " + tailCount + " times; it used to be printed again inside the note");

ok("...so the note is shorter than the passage it is about",
   !full.includes("> *on the highlighted passage “" + LONG + "”*"),
   "the whole passage is still being reprinted inside the note");

/*
 * The guarantee behind the complaint, stated as a bound rather than a ratio.
 *
 * The first version of this assertion compared total quote characters against
 * total thought characters — which is what was measured in HIS file, where the
 * quotes came to 10,873 characters against 9,834 of his own thinking. But in a
 * fixture the ratio is a property of how long the fixture's notes are, not of
 * the code: these notes are one-liners and his were paragraphs, so it flipped
 * for a reason that has nothing to do with the behaviour under test. It
 * passed, and it would have gone on passing with the shortening removed as
 * soon as someone lengthened a fixture note.
 *
 * What the CODE actually promises is a ceiling on every locator, whatever the
 * passage's length. That is what is pinned here.
 */
const quotedPassages = lines
  .filter((l) => /on the highlighted passage/.test(l))
  .map((l) => (l.match(/\u201C(.*)\u201D/) || ["", ""])[1]);
ok("...and no locator exceeds its budget, however long the passage",
   quotedPassages.length === 5 && quotedPassages.every((q) => q.length <= 95),
   quotedPassages.map((q) => q.length + " chars").join(", ") || "no locators found");
ok("...so a passage three times the budget is still named in one short line",
   LONG.length > 150 &&
   quotedPassages.some((q) => LONG.indexOf(q.replace("\u2026", "")) === 0 && q.length < LONG.length / 1.5),
   "the " + LONG.length + "-character passage was not shortened enough");

/* ===========================================================================
 * PART C — THE LOCATOR
 * ===========================================================================
 */
console.log("\nPART C — how much of the passage a note still quotes");

const locators = lines.filter((l) => /on the highlighted passage/.test(l));

ok("a long passage is shortened, with an ellipsis saying so",
   locators.some((l) => l.includes("Brighter Day has a magical first moment") &&
                        l.includes("…")),
   locators.join("\n    ") || "no locator lines at all");

ok("...cut at a word boundary, never mid-word",
   locators.filter((l) => l.includes("…")).every((l) => {
     const m = l.match(/“(.*)…”/);
     if (!m) return false;
     /* The cut text must end where a word ends in the original passage: the
      * next character there is a space, or the passage ended. */
     const src = [LONG, QUOTED].find((p) => p.indexOf(m[1]) === 0);
     return !!src && (src.length === m[1].length || src[m[1].length] === " ");
   }),
   locators.filter((l) => l.includes("…")).join("\n    "));

ok("a short passage is printed whole, because shortening would gain nothing",
   locators.some((l) => l.includes("“" + SHORT + "”") && !l.includes("…")),
   locators.join("\n    "));

/*
 * THE WRAPPER. This is fault 2, and it is the one that looked fine until
 * measured: 14 of his 22 passages contain a straight double quote, and
 * `on "<passage>"` closed on the first of them.
 */
ok("the wrapper is curly, so a straight quote inside a passage cannot close it",
   locators.every((l) => /“.*”\*$/.test(l)),
   locators.find((l) => !/“.*”\*$/.test(l)) || "");

ok("...and a passage that contains its own quotes survives intact",
   locators.some((l) => l.includes('"what would make the product market itself?"')) ||
   locators.some((l) => l.includes('She said "it works" and meant it.')),
   locators.join("\n    "));

ok("the old straight-quote form is gone from the file entirely",
   !/\*\* on "/.test(full) && !/on "[^“]/.test(full),
   lines.find((l) => /on "/.test(l)) || "");

/* ===========================================================================
 * PART D — THE LEGEND
 * ===========================================================================
 */
console.log("\nPART D — the file explains itself before the first note");

const legend = lines.find((l) => LEGEND_RE.test(l)) || "";

ok("there is a legend at the top of the file", !!legend, "(none)");

ok("...and it appears before the first note, not after",
   !!legend && lines.indexOf(legend) < lines.findIndex((l) => /MY THOUGHT/.test(l) && !LEGEND_RE.test(l)),
   "legend at " + lines.indexOf(legend) + ", first note at " +
   lines.findIndex((l) => /MY THOUGHT/.test(l) && !LEGEND_RE.test(l)));

ok("...and it names the label a reader is about to meet",
   /MY THOUGHT ON/.test(legend), legend);

ok("...and says the notes are not part of the document",
   /not part of the document/.test(legend), legend);

ok("...and counts them, so a note lost in a copy-paste is detectable",
   /There are 7 such notes below/.test(legend), legend);

/*
 * A file with no notes needs no explanation. Announcing a convention that
 * never appears would be a small lie, and it is the kind that erodes trust in
 * everything else the header says.
 */
const noNotes = run("full", EMPTY_DOC, null);
ok("a document with no notes gets no legend at all",
   !/How to read this file/.test(noNotes),
   noNotes.split("\n").slice(0, 6).join(" ⏎ "));
ok("...and still exports its text",
   noNotes.includes("A page nobody has written on."),
   noNotes.slice(0, 120));

/* ===========================================================================
 * PART E — PARAGRAPHS
 * ===========================================================================
 */
console.log("\nPART E — the breaks you typed survive");

ok("a blank line in a note becomes a new fenced paragraph",
   /^> Perfect\. It is a perfect bridge\.\n>\n> All of the answers have one answer/m.test(full),
   lines.filter((l) => /perfect bridge|answers have one/.test(l)).join(" ⏎ ") || "not found");

ok("...separated by a FENCED blank line, so the fence is never broken mid-note",
   !/^> Perfect\. It is a perfect bridge\.\n\n/m.test(full),
   "the blank line between paragraphs was left unfenced, ending the note early");

ok("a soft wrap inside one paragraph still collapses",
   /^> One sentence that happens to be wrapped across two lines\.$/m.test(full),
   lines.find((l) => /happens to be/.test(l)) || "not found");

/* ===========================================================================
 * PART F — A PASSAGE THAT IS GONE
 * ===========================================================================
 */
console.log("\nPART F — when the passage has been deleted");

ok("a note whose passage is gone says so",
   /on a passage no longer in the document/.test(full),
   lines.find((l) => /no longer in the document/.test(l)) || "not found");

/*
 * The DISTINCTION, asserted directly. A live passage of this length is
 * shortened; a deleted one of this length is not. Without this the two
 * branches can be collapsed into one and nothing notices — which is exactly
 * what happened: the mutation "a deleted passage shortened like any other"
 * escaped every suite until this ran.
 */
const goneLine = lines.find((l) => /no longer in the document/.test(l)) || "";
const goneQuote = (goneLine.match(/\u201C(.*)\u201D/) || ["", ""])[1];
ok("...in full means IN FULL \u2014 no ellipsis, unlike a passage still present",
   goneQuote.length > 150 && !goneQuote.includes("\u2026"),
   goneQuote.length + " chars" + (goneQuote.includes("\u2026") ? ", and shortened" : ""));
ok("...while a live passage of that same length IS shortened",
   quotedPassages.length > 0 && quotedPassages.every((q) => q.length <= 95) &&
   goneQuote.length > 95,
   "live locators: " + quotedPassages.map((q) => q.length).join(",") +
   "; deleted: " + goneQuote.length);

ok("...and keeps the FULL quote, because nothing else records it now",
   /^> \*on a passage no longer in the document: “.*”\*$/m.test(full),
   lines.find((l) => /no longer in the document/.test(l)) || "not found");

ok("...and the note itself is not lost",
   full.includes("has since been cut"),
   "a note was dropped when its passage was");

/*
 * A page-level note is NOT the same thing and must not claim a passage. These
 * two land in the same section of the file and the obvious implementation
 * treats them alike, which would put "on a passage no longer in the document"
 * on a note that never had one.
 */
const pageIdx = lines.findIndex((l) => /Worth re-reading before the meeting/.test(l));
ok("a page-level note claims no passage, deleted or otherwise",
   pageIdx > 0 && !/passage/.test(lines[pageIdx - 1]) && !/passage/.test(lines[pageIdx - 2] || ""),
   lines.slice(Math.max(0, pageIdx - 2), pageIdx + 1).join(" ⏎ "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

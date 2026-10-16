/*
 * =============================================================================
 * THOUGHT-FENCE-RENDERS.SELFTEST.JS — the fence survives an actual renderer
 * =============================================================================
 * WHAT THIS SUITE PROVES, AND WHY IT IS SEPARATE FROM THE OTHER ONE:
 *
 * thought-fencing.selftest.js checks the BYTES an export writes. This one
 * takes those same bytes and puts them through a real markdown renderer,
 * because "the file contains a > on every line" and "a reader sees the note as
 * a note" are two different claims and only the second one matters.
 *
 * Two of the shapes the export produces are not obviously legal markdown, and
 * both are load-bearing:
 *
 *   1. IN A TRANSCRIPT A NOTE SITS DIRECTLY UNDER ITS LINE, with no blank line
 *      between them. CommonMark does allow a block quote to interrupt a
 *      paragraph — but "the specification allows it" is a claim worth testing
 *      rather than trusting. If it did not, every note in a video export would
 *      render as part of the sentence above it, which is precisely the
 *      confusion this whole change exists to remove.
 *   2. A NOTE'S PARAGRAPHS ARE SEPARATED BY A QUOTED BLANK LINE — ">" rather
 *      than an empty line. An empty line would END the block quote and split
 *      one note into two, leaving the second half looking like a fresh note
 *      with no date at all.
 *
 * IT RENDERS THE REAL EXPORT, NOT A HAND-WRITTEN SAMPLE. The first version of
 * this file rendered markdown strings typed into the test, which made it a
 * description of how markdown behaves rather than a test of this code: the
 * export could have been broken in any way at all and every assertion would
 * still have passed. It now runs the actual export and renders whatever comes
 * out, so breaking the export breaks this suite.
 *
 * It uses the SAME markdown library the app itself ships
 * (vendor/marked.min.js), so a verdict here is about the renderer the user
 * will actually meet.
 *
 * The rule behind this file: a mechanism that exists is not a mechanism that
 * is sufficient. Reading the specification tells you how it should work;
 * running it tells you whether it does.
 * =============================================================================
 */

const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const marked = require(REPO + "/vendor/marked.min.js");
const render = (s) => marked.parse(s);

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
global.URL = dom.window.URL;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log("  ✓ " + n))
    : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : "")));
};

const WHEN = "2026-10-16T11:00:00Z";
const TEXT_DOC = "doc_rend_text";
const VID_DOC = "doc_rend_vid";

/*
 * The passage is long and carries its own straight double quotes — the two
 * properties that broke the old format. The note on it has TWO paragraphs, so
 * the quoted-blank-line question above is actually exercised.
 */
const PASSAGE = 'Brighter Day has a magical first moment and no second moment. ' +
                'A kid spins the globe, watches a video, and then "what?" — the globe ' +
                'is a destination with no journey, and the passport a container with ' +
                'no reason to fill it.';
const BEFORE = "She is not price-sensitive. She is vision-sensitive.";
const AFTER = "She's currently discouraged because kids aren't posting much.";

const Store = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");
global.FolioStore = Store;

localStorage.setItem("folio_documents", JSON.stringify([
  { id: TEXT_DOC, title: "First Principles", icon: "", parentId: null, order: 0,
    createdAt: WHEN, updatedAt: WHEN },
  { id: VID_DOC, title: "A Playthrough", icon: "", parentId: null, order: 1,
    createdAt: WHEN, updatedAt: WHEN },
]));
localStorage.setItem("folio_doc_" + TEXT_DOC, JSON.stringify({ time: 1, blocks: [
  { type: "paragraph", data: { text: BEFORE } },
  { type: "paragraph", data: { text: PASSAGE } },
  { type: "paragraph", data: { text: AFTER } },
]}));
localStorage.setItem("folio_highlights_" + TEXT_DOC, JSON.stringify([
  { id: "hl_1", text: PASSAGE, color: "yellow", createdAt: WHEN },
]));
localStorage.setItem("folio_comments_" + TEXT_DOC, JSON.stringify([
  { id: "c_1", highlightId: "hl_1", createdAt: WHEN,
    text: "Perfect. It is a perfect bridge.\n\nAll of the answers have one answer: " +
          "they need to be in a story they live in." },
]));

/* The video case: a note that will sit directly under its transcript line. */
localStorage.setItem("folio_doc_" + VID_DOC, JSON.stringify({ time: 1, blocks: [
  { type: "video", data: { videoId: "abc", url: "https://youtu.be/abc" } },
  { type: "paragraph", data: { text: "Excellent. No nickname, so I need two of these.", t: 1214 } },
  { type: "paragraph", data: { text: "So I'm going to catch this one as well.", t: 1223 } },
]}));
localStorage.setItem("folio_highlights_" + VID_DOC, JSON.stringify([]));
localStorage.setItem("folio_comments_" + VID_DOC, JSON.stringify([
  { id: "c_v", highlightId: null, videoTime: 1214, createdAt: WHEN,
    text: "There are different game mechanics here.\n\nEvery time I spot one I will say so." },
]));
Store.ensureReads(TEXT_DOC);
Store.ensureReads(VID_DOC);

global.Reader = { getCurrentDocId: () => TEXT_DOC };
global.Highlights = { applyHighlights: () => {}, syncHighlightColors: () => {} };
global.Gemini = { formatTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` };
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
const run = (kind, docId) => { captured = ""; C.__run(kind, docId, null); return captured; };

/* The bytes the export really wrote, then the HTML a reader really sees. */
const textMd = run("full", TEXT_DOC);
const textHtml = render(textMd);
const vidMd = run("full", VID_DOC);
const vidHtml = render(vidMd);

/*
 * Markdown renderers escape text on the way into HTML — marked turns an
 * apostrophe into "&#39;" and a double quote into "&quot;" — so a raw
 * substring search for a sentence containing either finds nothing and reads as
 * "the sentence is missing". The first version of this suite failed for
 * exactly that reason and the failure message blamed the export, which was
 * innocent. Everything is compared after undoing the escaping.
 */
const plain = (html) => String(html)
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const inQuotes = (html) => {
  /* Everything that fell inside a blockquote, concatenated. */
  const parts = [];
  const re = /<blockquote>([\s\S]*?)<\/blockquote>/g;
  let m;
  while ((m = re.exec(html))) parts.push(m[1]);
  return plain(parts.join("\n"));
};

/* ===========================================================================
 * PART A — a text document: the note renders as a note, the prose as prose
 * ===========================================================================
 */
console.log("\nPART A — a page of prose with a note in it");

ok("the note renders as a blockquote at all",
   /<blockquote>/.test(textHtml),
   textHtml.replace(/\n/g, " ").slice(0, 200));

ok("...and there is exactly one, for the one note",
   (textHtml.match(/<blockquote>/g) || []).length === 1,
   (textHtml.match(/<blockquote>/g) || []).length + " blockquotes for 1 note");

const quoted = inQuotes(textHtml);

ok("the note's own words are inside it",
   /perfect bridge/.test(quoted) && /one answer/.test(quoted),
   quoted.replace(/\n/g, " ").slice(0, 300));

ok("the dated label is inside it",
   /MY THOUGHT ON OCT 16, 2026/.test(quoted),
   quoted.replace(/\n/g, " ").slice(0, 200));

/*
 * THE ONE THAT MATTERS. The document's paragraphs must land OUTSIDE the note.
 * This is the rendered form of the original complaint: if the prose and the
 * commentary end up in the same box, nothing downstream can tell them apart.
 */
ok("the document's paragraph BEFORE the note stays outside it",
   !quoted.includes(BEFORE) && plain(textHtml).includes(BEFORE),
   "the paragraph above was swallowed into the note");

ok("the document's paragraph AFTER the note stays outside it",
   !quoted.includes(AFTER) && plain(textHtml).includes(AFTER),
   "the paragraph below was swallowed into the note");

ok("the highlighted passage itself stays outside it",
   !quoted.includes("destination with no journey") &&
   plain(textHtml).includes("destination with no journey"),
   "the passage was pulled into the note it is referred to by");

/*
 * Two paragraphs in one note have to stay in ONE box. A plain blank line
 * between them would close the blockquote and the second half would render as
 * a separate, undated note.
 */
ok("two paragraphs of one note stay in that single box",
   /perfect bridge[\s\S]*one answer/.test(quoted),
   quoted.replace(/\n/g, " ").slice(0, 300));

ok("...rendered as two paragraphs, not run into one",
   (quoted.match(/<p>/g) || []).length >= 3,
   (quoted.match(/<p>/g) || []).length + " paragraphs inside the note");

ok("the locator renders as the passage's opening words, shortened",
   /…/.test(quoted) && /Brighter Day has a magical first moment/.test(quoted),
   quoted.replace(/\n/g, " ").slice(0, 300));

ok("...and the straight quotes inside that passage did not break it",
   !/<\/?blockquote>[^<]*journey/.test(quoted),
   "the locator leaked out of its own line");

/* ===========================================================================
 * PART B — a transcript: the note is glued to its line with no blank between
 * ===========================================================================
 */
console.log("\nPART B — a video transcript, where a note has no blank line above it");

ok("the export really did put the note straight under its line",
   /\*\*\[20:14\]\*\* [^\n]*\n {2}> 💬/.test(vidMd),
   vidMd.split("\n").slice(0, 14).join(" ⏎ "));

ok("...and it STILL renders as a blockquote",
   /<blockquote>/.test(vidHtml),
   vidHtml.replace(/\n/g, " ").slice(0, 250));

const vQuoted = inQuotes(vidHtml);

ok("...with the note's words inside",
   /different game mechanics/.test(vQuoted),
   vQuoted.replace(/\n/g, " ").slice(0, 250));

ok("...and the transcript line itself left outside",
   !vQuoted.includes("No nickname") && plain(vidHtml).includes("No nickname"),
   "the spoken line was swallowed into the note");

ok("...and the NEXT transcript line outside too, so the note closed",
   !vQuoted.includes("catch this one as well") &&
   plain(vidHtml).includes("catch this one as well"),
   "the note never closed and ate the rest of the transcript");

ok("a transcript note keeps its two paragraphs in one box as well",
   /different game mechanics[\s\S]*Every time I spot one/.test(vQuoted),
   vQuoted.replace(/\n/g, " ").slice(0, 300));

ok("the header carries both the date and the moment in the video",
   /MY THOUGHT ON OCT 16, 2026/.test(vQuoted) && /\[20:14\]/.test(vQuoted),
   vQuoted.replace(/\n/g, " ").slice(0, 250));

/* ===========================================================================
 * PART C — the legend renders as readable prose, not as a note
 * ===========================================================================
 */
console.log("\nPART C — the legend at the top");

ok("the legend renders outside any blockquote",
   /How to read this file/.test(textHtml) && !/How to read this file/.test(quoted),
   "the legend was rendered as if it were itself a note");

ok("...and its emphasis survives, so it reads as front matter",
   /<em>[\s\S]*How to read this file[\s\S]*<\/em>/.test(textHtml),
   textHtml.split("\n").slice(0, 8).join(" ⏎ "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

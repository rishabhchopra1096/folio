/*
 * =============================================================================
 * THOUGHT-DATES.SELFTEST.JS — every exported comment says when you thought it
 * =============================================================================
 * WHAT THIS SUITE PROVES:
 * You read something in March and wrote a note. You read it again in September
 * and wrote another note on the same passage. When you export, the file has to
 * tell you which is which — otherwise it is two opinions in a pile, and the
 * whole reason for keeping reads separate has quietly evaporated.
 *
 *   PART A — the label itself: "MY THOUGHT ON SEP 5, 2026", including the year,
 *            and what happens to a record with no date at all.
 *   PART B — ORDER. Dating the thoughts is only half of showing how they
 *            changed; they have to come out oldest first. In storage order the
 *            column under a quote is a pile, not a progression.
 *   PART C — THE COPY. A comment copied into a later read is a NEW record
 *            holding an OLD thought. Dating it by the day it was copied files
 *            a sentence written in March under September, which corrupts the
 *            exact comparison this feature exists to support. This is the
 *            assertion most worth having, because the naive version — use
 *            createdAt — looks completely correct and is wrong only in the
 *            case the feature is for.
 *   PART D — all three export shapes carry the label, not just the one that
 *            was complained about.
 *
 * WHY IT RUNS THE REAL EXPORTS:
 * Nothing here checks a formatting helper in isolation. Every assertion reads
 * the actual bytes the real runExport would have written to a file.
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
/*
 * The export reaches `URL` through the scope chain, and without this it finds
 * NODE's URL — whose createObjectURL rejects the fake Blob below. Aliasing it
 * to the window's means patching dom.window.URL further down patches the same
 * object the module will actually call.
 */
global.URL = dom.window.URL;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log("  ✓ " + n))
    : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : "")));
};

const DOC = "doc_td";
const MARCH = "2026-03-02T11:00:00Z";
const SEPT  = "2026-09-05T11:00:00Z";

const Store = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");
global.FolioStore = Store;

/*
 * A document with ONE passage carrying TWO thoughts months apart — the exact
 * shape the feature exists for — plus a page-level note and an orphan.
 */
localStorage.setItem("folio_documents", JSON.stringify([
  { id: DOC, title: "Deep Work", icon: "", parentId: null, order: 0,
    createdAt: MARCH, updatedAt: SEPT }]));
localStorage.setItem("folio_doc_" + DOC, JSON.stringify({ time: 1, blocks: [
  { type: "paragraph", data: { text: "Clarity about what matters provides clarity about what does not." } },
]}));
localStorage.setItem("folio_highlights_" + DOC, JSON.stringify([
  { id: "hl_1", text: "Clarity about what matters", color: "yellow", createdAt: MARCH },
]));
/*
 * Deliberately stored NEWEST FIRST. If the export simply walked storage order
 * the September thought would print above the March one, and the file would
 * say your thinking ran backwards. Part B is the reason for this ordering.
 */
localStorage.setItem("folio_comments_" + DOC, JSON.stringify([
  { id: "c_sept",  highlightId: "hl_1", text: "Now I think it is about saying no.", createdAt: SEPT },
  { id: "c_march", highlightId: "hl_1", text: "Struck me as obvious the first time.", createdAt: MARCH },
  { id: "c_gen",   highlightId: null, isGeneral: true, text: "Worth re-reading yearly.", createdAt: MARCH },
  { id: "c_orph",  highlightId: "hl_gone", text: "The passage this was about is gone.", createdAt: SEPT },
]));
Store.ensureReads(DOC);

global.Reader = { getCurrentDocId: () => DOC };
global.Highlights = { applyHighlights: () => {}, syncHighlightColors: () => {} };
global.Gemini = { formatTime: (s) => String(s) };
global.SidebarUI = { blockToMarkdown: (b) => (b && b.data && b.data.text) || "" };

// Capture the file an export writes instead of downloading it.
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
    "  return {\n    __run: (kind, readId) => runExport(kind, \"" + DOC + "\", readId),\n    init,");
const C = eval(commentsSrc + "; Comments;");
const run = (kind, readId) => { captured = ""; C.__run(kind, readId); return captured; };

/* ===========================================================================
 * PART A — the label
 * ===========================================================================
 */
console.log("\nPART A — what the label says");

const digest = run("digest", null);

ok("a comment is introduced by a dated label, not a bare arrow",
   /\*\*MY THOUGHT ON MAR 2, 2026:\*\* Struck me as obvious the first time\./.test(digest),
   digest.split("\n").find((l) => /obvious the first time/.test(l)) || "line not found");

ok("the old bare arrow is gone entirely",
   !/^\s*→ /m.test(digest),
   digest.split("\n").find((l) => /^\s*→ /.test(l)) || "");

/*
 * THE YEAR. The panel shows a bare "Sep 5" because the panel is about now. An
 * export is kept and read at an unknown distance; a file holding one read from
 * 2024 and another from 2026 with both labelled "SEP 5" is worse than useless.
 */
ok("the year is in the label, which the panel's own date does not bother with",
   /MY THOUGHT ON SEP 5, 2026/.test(digest),
   digest.split("\n").find((l) => /Now I think it is about saying no/.test(l)));

ok("a page-level note is dated too",
   /\*\*MY THOUGHT ON MAR 2, 2026:\*\* Worth re-reading yearly\./.test(digest),
   digest.split("\n").find((l) => /re-reading yearly/.test(l)));

ok("a note whose passage was deleted is dated too",
   /\*\*MY THOUGHT ON SEP 5, 2026:\*\* The passage this was about is gone\./.test(digest),
   digest.split("\n").find((l) => /passage this was about/.test(l)));

ok("the quoted passage itself is untouched",
   digest.includes('- "Clarity about what matters"'),
   digest.split("\n").find((l) => /^- "/.test(l)));

/* ===========================================================================
 * PART B — the order
 * ===========================================================================
 */
console.log("\nPART B — oldest thought first");

const iMarch = digest.indexOf("Struck me as obvious");
const iSept = digest.indexOf("Now I think it is about saying no");
ok("March is printed above September, although storage holds them the other way",
   iMarch !== -1 && iSept !== -1 && iMarch < iSept,
   "march at " + iMarch + ", september at " + iSept);

/* ===========================================================================
 * PART C — a copied thought keeps the date it was actually had
 * ===========================================================================
 */
console.log("\nPART C — the copy");

const reads = Store.getReads(DOC);
const read1 = reads[reads.length - 1];
Store.startNewRead(DOC);
const read2 = Store.getReads(DOC)[1];

// Move the March comment into Read 1 explicitly, then copy it into Read 2.
Store.setCommentRead(DOC, "c_march", read1.id);
const copied = Store.copyCommentToRead(DOC, "c_march", read2.id);
ok("the copy was made", copied.ok === true, JSON.stringify(copied));

const copy = Store.getComments(DOC).find((c) => c.id === copied.id);
ok("the copy's own createdAt is TODAY, as it must be — it is a new record",
   new Date(copy.createdAt).getFullYear() === new Date().getFullYear() &&
   copy.createdAt !== MARCH,
   copy.createdAt);
ok("...but it remembers when the thought was actually had",
   copy.originalCreatedAt === MARCH, String(copy.originalCreatedAt));

/*
 * THE ASSERTION THIS PART IS FOR. The naive version of this feature dates
 * every comment by createdAt, which is correct for everything except a copy —
 * and a copy is precisely a thought carried from one read to another, which is
 * the case the whole re-reading feature is about.
 */
const afterCopy = run("digest", null);
ok("the copy is dated MARCH in the export, not today",
   /\*\*MY THOUGHT ON MAR 2, 2026 \(copied\):\*\* Struck me as obvious/.test(afterCopy),
   afterCopy.split("\n").filter((l) => /obvious the first time/.test(l)).join(" || "));

const todayStamp = new Date().toLocaleDateString("en-US",
  { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
ok("...so today's date appears nowhere against that sentence",
   !afterCopy.split("\n").some((l) =>
     /obvious the first time/.test(l) && l.includes(todayStamp)),
   "a copied thought was filed under " + todayStamp);

ok("the copy says it is a copy, so two identical dated lines read as deliberate",
   /\(copied\)/.test(afterCopy));

/* A copy of a copy must still point at the original thought, not the middle one. */
const reads3 = Store.getReads(DOC);
Store.startNewRead(DOC);
const read3 = Store.getReads(DOC)[2];
const second = Store.copyCommentToRead(DOC, copied.id, read3.id);
const copy2 = Store.getComments(DOC).find((c) => c.id === second.id);
ok("a copy of a copy still carries the ORIGINAL date",
   copy2.originalCreatedAt === MARCH, String(copy2.originalCreatedAt));

/*
 * TWO WAYS A DATE CAN BE ABSENT, and they take different code paths.
 *
 * The first version of this test only covered a MISSING createdAt, which exits
 * early on a null check — so it passed with the invalid-date guard removed
 * entirely, and the mutation walked straight through it. A field holding
 * something that is not a date at all is the case that guard is actually for,
 * and it is the realistic one: a hand-edited backup, a half-finished import.
 */
const undated = Store.getComments(DOC);
undated.push({ id: "c_nodate", highlightId: "hl_1", text: "No date on this one.", readId: read3.id });
undated.push({ id: "c_baddate", highlightId: "hl_1", text: "A date that is not one.",
               createdAt: "sometime last spring", readId: read3.id });
Store.saveComments(DOC, undated);
const withUndated = run("digest", null);
ok("a comment with no date says so rather than inventing one",
   /\*\*MY THOUGHT:\*\* No date on this one\./.test(withUndated),
   withUndated.split("\n").find((l) => /No date on this one/.test(l)));
ok("a comment whose date will not parse also says so",
   /\*\*MY THOUGHT:\*\* A date that is not one\./.test(withUndated),
   withUndated.split("\n").find((l) => /A date that is not one/.test(l)));
ok("...and no NaN or Invalid Date leaks into the file",
   !/NaN|Invalid Date/.test(withUndated),
   withUndated.split("\n").find((l) => /NaN|Invalid Date/.test(l)) || "");

/* ===========================================================================
 * PART D — every export shape, not just the one that was complained about
 * ===========================================================================
 */
console.log("\nPART D — all three export shapes");

const full = run("full", null);
/*
 * The shape changed again on 2026-10-16. A note is now a fenced block, headed
 * by the dated label, with the passage named on its own line and the thought
 * beneath it — because the old one-line form held the whole passage verbatim
 * and so printed the document twice. The label and the date are unchanged;
 * only the fencing and the length of the quoted passage moved.
 */
/* A consolidated export tags each header with its read, so the line may carry
 * a "[Read 1]" after the label — anchor the start, not the end. */
ok("the whole-document export dates each comment",
   /^> \*\*MY THOUGHT ON MAR 2, 2026[^*]*\*\*/m.test(full),
   full.split("\n").find((l) => /^> \*\*MY THOUGHT/.test(l)) || "no header line");
ok("...and the old bare COMMENT prefix is gone",
   !/^COMMENT /m.test(full),
   full.split("\n").find((l) => /^COMMENT /.test(l)) || "");
ok("...and it still names the passage a note was about",
   /^> \*on the highlighted passage \u201CClarity about what matters\u201D\*$/m.test(full),
   full.split("\n").find((l) => /highlighted passage/.test(l)) || "no locator line");
/*
 * The passage is no longer reprinted inside quotation marks that its own
 * quotes can close. This is the fault that cost 14 of his 22 notes: `on
 * "<passage>"` closed early on every passage containing a double quote.
 */
ok("...without the straight-quote wrapper a passage can close itself",
   !/on "/.test(full),
   full.split("\n").find((l) => /on "/.test(l)) || "");
/* The legend is excluded on purpose: it NAMES the label while explaining the
 * convention, and it is a line of the file's own front matter rather than a
 * note, so it is correctly unfenced. Every actual note line must be fenced. */
const noteLines = full.split("\n")
  .filter((l) => /MY THOUGHT|highlighted passage/.test(l))
  .filter((l) => !/^_\*\*How to read/.test(l));
ok("...and every line of a note is fenced, so none can read as document text",
   noteLines.length > 0 && noteLines.every((l) => /^\s*>/.test(l)),
   noteLines.find((l) => !/^\s*>/.test(l)) || "(no note lines found at all)");
ok("...and the file explains the convention before the first note",
   /How to read this file/.test(full),
   full.split("\n").slice(0, 8).join(" | "));

/*
 * The transcript export, which also carries a position in the video.
 *
 * THE COMMENT NEEDS A videoTime OR IT NEVER REACHES A LINE. Transcript
 * comments are placed by when they were SPOKEN, not by matching text, so the
 * first version of this fixture produced no comment lines at all — and the
 * assertion below passed on the label in the general-notes section instead,
 * while the per-line label could be deleted without failing anything.
 */
localStorage.setItem("folio_doc_" + DOC, JSON.stringify({ time: 1, blocks: [
  { type: "video", data: { videoId: "abc", title: "A talk" } },
  { type: "paragraph", data: { text: "Clarity about what matters", t: 65 } },
]}));
const forVideo = Store.getComments(DOC);
forVideo.push({ id: "c_vid", highlightId: null, text: "Said at this exact moment.",
                createdAt: SEPT, videoTime: 70, readId: read3.id });
Store.saveComments(DOC, forVideo);

const tr = run("full", null);
const vidLine = tr.split("\n").find((l) => /Said at this exact moment/.test(l));
/*
 * In a transcript the note is still a fenced block, so the thought and its
 * header are now two separate lines: the header carries the glyph, the date
 * and the moment in the video, and the thought sits quoted beneath it.
 */
const vidHead = tr.split("\n").find((l) => /💬/.test(l));
ok("the transcript really put the comment on a line", !!vidLine && /^\s*>/.test(vidLine),
   vidLine || "no comment line at all");
ok("...and its header is dated",
   !!vidHead && /💬 \*\*MY THOUGHT ON SEP 5, 2026\*\*/.test(vidHead),
   vidHead || "no header line");
ok("...and keeps the position in the video, which is a different fact from the date",
   !!vidHead && /\[70\]/.test(vidHead), vidHead || "no header line");
ok("...and the two facts sit in that one header, not on the thought's own line",
   !!vidLine && !/MY THOUGHT|\[70\]/.test(vidLine), vidLine || "no comment line");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

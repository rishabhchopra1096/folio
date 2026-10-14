/*
 * =============================================================================
 * READS.SELFTEST.JS — re-reading a document, and exporting one read at a time
 * =============================================================================
 * WHAT THIS SUITE PROVES:
 * You read a document in March and wrote some comments. You come back in
 * October and read it again, with new thoughts. A "read" is the record of one
 * such pass, and this suite proves three things about them:
 *
 *   PART A — the real store creates and migrates reads correctly, including
 *            adopting notes written before reads existed.
 *   PART B — the inclusion rule: a comment written THIS read about a passage
 *            highlighted in an EARLIER one keeps its quote in the export. This
 *            is the single assertion most worth having, because the naive
 *            filter (keep only this read's highlights) breaks exactly the case
 *            the feature is for, and breaks it silently.
 *   PART C — the export shapes: one read on its own, and every read in one
 *            consolidated file.
 *
 * WHY PART A USES THE REAL STORE:
 * The migration's whole job is to put a readId onto data that a FIXTURE would
 * never lack. Testing it against a hand-written stub would prove nothing — the
 * stub would simply have the field. So Part A evaluates js/store.js itself over
 * a real localStorage, seeded with records shaped like the ones already in the
 * app (no readId, which is the entire point).
 * =============================================================================
 */

const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

// The comments panel's markup, trimmed to the ids the module wires up. The read
// bar is included because renderComments now keeps it in step with the list.
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
global.URL = dom.window.URL;
global.navigator = dom.window.navigator;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log("  ✓ " + n))
    : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : "")));
};

/* ===========================================================================
 * PART A — the real store: migration, numbering, colours, deletion, backup
 * ===========================================================================
 * Everything here runs against js/store.js itself.
 */
console.log("\nPART A — the store");

const storeSrc = fs.readFileSync(REPO + "/js/store.js", "utf8");
const Store = eval(storeSrc + "; FolioStore;");

const DOC = "doc_march";

/*
 * Seed the document the way the app would have left it BEFORE reads existed:
 * comments and highlights with no readId at all. March dates, deliberately, so
 * the migration has an earliest timestamp to find that is not today.
 */
localStorage.setItem("folio_documents", JSON.stringify([
  { id: DOC, title: "The Pragmatic Programmer", parentId: null, order: 0 },
]));
localStorage.setItem("folio_highlights_" + DOC, JSON.stringify([
  { id: "hl_old", text: "Don't repeat yourself.", color: "yellow",
    createdAt: "2026-03-10T09:00:00Z" },
]));
localStorage.setItem("folio_comments_" + DOC, JSON.stringify([
  { id: "cm_old", highlightId: "hl_old", text: "Obvious in hindsight.",
    createdAt: "2026-03-10T09:05:00Z" },
  { id: "cm_oldnote", highlightId: null, isGeneral: true, text: "Worth a second pass.",
    createdAt: "2026-03-09T20:00:00Z" },
]));

const reads1 = Store.ensureReads(DOC);
ok("migration creates exactly one read", reads1.length === 1, "got " + reads1.length);
ok("that read is numbered 1", reads1[0] && reads1[0].n === 1, JSON.stringify(reads1[0]));
ok("that read takes the first colour", reads1[0] && reads1[0].color === "yellow",
   reads1[0] && reads1[0].color);

/*
 * The date matters more than it looks. Read 1 happened in March; the code first
 * ran today. Dating it "now" would relabel a six-month-old reading as today's
 * and make the panel lie about when you read the thing.
 */
ok("Read 1 is dated from the OLDEST existing note, not from now",
   reads1[0] && reads1[0].startedAt === "2026-03-09T20:00:00Z",
   reads1[0] && reads1[0].startedAt);

const migratedComments = Store.getComments(DOC);
const migratedHighlights = Store.getHighlights(DOC);
ok("every pre-existing comment was adopted into Read 1",
   migratedComments.length === 2 && migratedComments.every((c) => c.readId === reads1[0].id),
   JSON.stringify(migratedComments.map((c) => c.readId)));
ok("every pre-existing highlight was adopted into Read 1",
   migratedHighlights.length === 1 && migratedHighlights[0].readId === reads1[0].id,
   JSON.stringify(migratedHighlights.map((h) => h.readId)));

// Idempotence: opening the document again must not invent a second read.
const reads1again = Store.ensureReads(DOC);
ok("running the migration twice does not add a read",
   reads1again.length === 1 && reads1again[0].id === reads1[0].id);

// --- starting a new read ---
const read2 = Store.startNewRead(DOC);
ok("a new read is numbered one past the last", read2.n === 2, "n=" + read2.n);
ok("a new read takes the next colour", read2.color === "green", read2.color);
ok("the current read is the one just started",
   Store.getCurrentRead(DOC).id === read2.id);
ok("the earlier read is still there",
   Store.getReads(DOC).length === 2 && Store.getReads(DOC)[0].id === reads1[0].id);
ok("readLabel names a read for the panel and the export headings",
   Store.readLabel(read2) === "Read 2", Store.readLabel(read2));

/*
 * Colour cycling. Four colours exist, so a fifth read has to reuse one. Proven
 * rather than assumed, because the obvious off-by-one here would hand Read 5
 * the SECOND colour and make it indistinguishable from Read 2 instead of from
 * Read 1 — a subtler and more confusing collision.
 */
Store.startNewRead(DOC);                      // Read 3 — blue
Store.startNewRead(DOC);                      // Read 4 — pink
const read5 = Store.startNewRead(DOC);        // Read 5 — back to yellow
ok("the colours cycle, so a fifth read looks like the first, not the second",
   read5.color === "yellow", read5.color);

// --- the backup must carry reads, or a restore produces orphaned notes ---
const backup = Store.exportAll();
ok("a full backup includes the reads key",
   backup["folio_reads_" + DOC] !== undefined);

/*
 * A merge-import of a document we do not have must bring its reads along.
 * Without this, restored notes point at reads that do not exist AND the
 * migration will not rebuild them, because the notes already carry a readId —
 * so every one of them would vanish from every per-read export.
 */
const DOC2 = "doc_restored";
const incoming = {
  folio_documents: [{ id: DOC2, title: "Restored", parentId: null, order: 1 }],
  ["folio_reads_" + DOC2]: [
    { id: "rd_restored", n: 1, color: "yellow", startedAt: "2026-02-01T00:00:00Z" },
  ],
  ["folio_comments_" + DOC2]: [
    { id: "cm_r", highlightId: null, isGeneral: true, readId: "rd_restored",
      text: "From the backup.", createdAt: "2026-02-01T00:00:00Z" },
  ],
};
Store.importAll(incoming, "merge");
ok("a merge-import restores a document's reads alongside its comments",
   Store.getReads(DOC2).length === 1 && Store.getReads(DOC2)[0].id === "rd_restored",
   JSON.stringify(Store.getReads(DOC2)));

// --- deletion must not leave the reads key behind ---
Store.deleteDocument(DOC2);
ok("deleting a document removes its reads key",
   localStorage.getItem("folio_reads_" + DOC2) === null);

/* ===========================================================================
 * PART B & C — the inclusion rule, and the export shapes
 * ===========================================================================
 * These run against js/comments.js. The store is stubbed here because what is
 * under test is the FILTER and the FORMATTING, and a stub lets the fixture
 * state the exact awkward case in one place.
 */
console.log("\nPARTS B & C — the inclusion rule and the exports");

const READ1 = { id: "rd_1", n: 1, color: "yellow", startedAt: "2026-03-09T20:00:00Z" };
const READ2 = { id: "rd_2", n: 2, color: "green", startedAt: "2026-10-14T10:00:00Z" };
const READS = [READ1, READ2];

const blocks = [
  { type: "paragraph", data: { text: "Don't repeat yourself." } },
  { type: "paragraph", data: { text: "Make it work, then make it right." } },
];

/*
 * THE FIXTURE THAT MATTERS — hl_old is a passage marked during Read 1, and
 * cm_new is a comment written during Read 2 ABOUT THAT SAME PASSAGE. That is
 * what re-reading actually produces, and it is the case a naive filter drops.
 */
const highlights = [
  { id: "hl_old", readId: READ1.id, color: "yellow", text: "Don't repeat yourself.",
    createdAt: "2026-03-10T09:00:00Z" },
  { id: "hl_new", readId: READ2.id, color: "green",
    text: "Make it work, then make it right.", createdAt: "2026-10-14T10:05:00Z" },
];
const comments = [
  { id: "cm_old", readId: READ1.id, highlightId: "hl_old",
    text: "Obvious in hindsight.", createdAt: "2026-03-10T09:05:00Z" },
  { id: "cm_new", readId: READ2.id, highlightId: "hl_old",
    text: "Six months on I think this is overstated.", createdAt: "2026-10-14T10:06:00Z" },
  { id: "cm_new2", readId: READ2.id, highlightId: "hl_new",
    text: "This is the one that stuck.", createdAt: "2026-10-14T10:07:00Z" },
  { id: "cm_note2", readId: READ2.id, highlightId: null, isGeneral: true,
    text: "Better the second time.", createdAt: "2026-10-14T10:08:00Z" },
];

global.FolioStore = {
  getSettings: () => ({}), saveSettings: () => {},
  getDocument: () => ({ meta: { title: "The Pragmatic Programmer" }, content: { blocks } }),
  getHighlights: () => highlights,
  getComments: () => comments,
  saveComments: () => {}, saveHighlights: () => {},
  generateId: (p) => p + "_x",
  // The reads half, mirroring the real store's contract.
  getReads: () => READS,
  ensureReads: () => READS,
  getCurrentRead: () => READ2,
  saveReads: () => {},
  startNewRead: () => READ2,
  readLabel: (r) => (r ? "Read " + r.n : "Read"),
  READ_COLORS: ["yellow", "green", "blue", "pink"],
};
global.Reader = { getCurrentDocId: () => "doc_pp" };
global.Voice = { hasKey: () => false };
global.Gemini = { formatTime: (s) => String(s) };
global.SidebarUI = {
  blockToMarkdown: (b) => (b && b.data && b.data.text) || "",
};

// Capture the file an export writes instead of downloading it.
let captured = "", capturedName = "";
global.Blob = class { constructor(parts) { captured = parts[0]; } };
dom.window.URL.createObjectURL = () => "blob:x";
dom.window.URL.revokeObjectURL = () => {};
const realCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (tag === "a") {
    el.click = () => {};
    // The download attribute is where the read tag in the file name shows up.
    Object.defineProperty(el, "download", {
      set(v) { capturedName = v; }, get() { return capturedName; },
    });
  }
  return el;
};

/*
 * Reach runExport directly with a read id. exportAnnotations() asks the user
 * two questions through modals; a test should say what it means instead of
 * driving dialogs.
 */
const commentsSrc = fs.readFileSync(REPO + "/js/comments.js", "utf8")
  .replace("  return {\n    init,",
    "  return {\n    __run: (kind, readId) => runExport(kind, \"doc_pp\", readId),\n    init,");
const C = eval(commentsSrc + "; Comments;");

const run = (kind, readId) => { captured = ""; capturedName = ""; C.__run(kind, readId); return captured; };

// ---- PART B: the inclusion rule -------------------------------------------
const digest2 = run("digest", READ2.id);

ok("B1 a comment written this read about an EARLIER read's highlight keeps its quote",
   digest2.includes("Don't repeat yourself."),
   "the quote is missing — the highlight was filtered out from under its comment");
ok("B2 ...and is NOT filed as a note whose highlight was removed",
   !digest2.includes("Notes whose highlight was removed"),
   "the comment was orphaned by the filter");
ok("B3 this read's own comment is present",
   digest2.includes("Six months on I think this is overstated."));
ok("B4 the earlier read's comment is left out",
   !digest2.includes("Obvious in hindsight."),
   "an old comment leaked into a single-read export");
ok("B5 this read's general note is present",
   digest2.includes("Better the second time."));
ok("B6 the file says which read it covers",
   digest2.includes("Read 2"), "no read named in the header");
ok("B7 the file name carries the read",
   /read-2/.test(capturedName), capturedName);

// The mirror case: Read 1's export must not pick up Read 2's thoughts.
const digest1 = run("digest", READ1.id);
ok("B8 the first read's export holds its own comment",
   digest1.includes("Obvious in hindsight."));
ok("B9 ...and none of the second read's",
   !digest1.includes("Six months on") && !digest1.includes("This is the one that stuck."),
   "a later comment leaked backwards into an earlier read");
ok("B10 ...and not the second read's highlight either",
   !digest1.includes("Make it work, then make it right."),
   "a highlight made during a later read appeared in an earlier read's export");

// ---- PART C: the consolidated export --------------------------------------
const digestAll = run("digest", null);
ok("C1 the consolidated digest has a section per read",
   digestAll.includes("## Read 1") && digestAll.includes("## Read 2"),
   "missing a per-read heading");
ok("C2 the sections are oldest first, so the file reads as a history",
   digestAll.indexOf("## Read 1") < digestAll.indexOf("## Read 2"));
ok("C3 it holds every comment from both reads",
   digestAll.includes("Obvious in hindsight.") &&
   digestAll.includes("Six months on I think this is overstated.") &&
   digestAll.includes("This is the one that stuck.") &&
   digestAll.includes("Better the second time."));
ok("C4 sub-headings drop a level so they nest under the read heading",
   !/^## General notes/m.test(digestAll),
   "a sub-heading stayed at ## and now competes with the read headings");
ok("C5 the file name says it covers every read",
   /all-reads/.test(capturedName), capturedName);

// ---- PART C: the full-document export -------------------------------------
const fullAll = run("full", null);
ok("C6 a multi-read full export tags each comment with its read",
   fullAll.includes("[Read 1]") && fullAll.includes("[Read 2]"),
   "comments are not labelled, so you cannot tell the reads apart");
ok("C7 the document itself is still there, once",
   (fullAll.match(/Don't repeat yourself\./g) || []).length >= 1);

const full2 = run("full", READ2.id);
ok("C8 a single-read full export does NOT tag comments",
   !full2.includes("[Read 2]"),
   "a one-read file labels every line with the only read it contains");
ok("C9 ...and leaves the earlier read's comments out",
   !full2.includes("Obvious in hindsight."));
ok("C10 ...while keeping the quote its comment refers to",
   full2.includes('COMMENT on "Don\'t repeat yourself."'),
   "the Read 1 highlight was dropped, so the Read 2 comment lost its context");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

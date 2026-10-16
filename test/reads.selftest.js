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
 * PART A2 — naming a read, deleting one, moving and copying a comment
 * ===========================================================================
 * Still the real store. A fresh document, because Part A left its one above
 * with five reads and no notes in most of them.
 */
console.log("\nPART A2 — renaming, deleting, moving, copying");

const D2 = "doc_edits";
localStorage.setItem("folio_documents", JSON.stringify([
  { id: D2, title: "Edits", parentId: null, order: 0 },
]));
localStorage.setItem("folio_highlights_" + D2, JSON.stringify([
  { id: "hx1", text: "A passage.", color: "yellow", createdAt: "2026-04-01T09:00:00Z" },
]));
localStorage.setItem("folio_comments_" + D2, JSON.stringify([
  { id: "cx1", highlightId: "hx1", text: "First thought.", createdAt: "2026-04-01T09:01:00Z" },
]));
localStorage.removeItem("folio_reads_" + D2);

const r1 = Store.ensureReads(D2)[0];
const r2 = Store.startNewRead(D2);

// ---- naming ----
Store.renameRead(D2, r1.id, "  The skim  ");
const named = Store.getReads(D2)[0];
ok("a read takes a name, trimmed", named.name === "The skim", JSON.stringify(named.name));
ok("the label keeps the number alongside the name",
   Store.readLabel(named) === "Read 1 · The skim", Store.readLabel(named));
Store.renameRead(D2, r1.id, "   ");
ok("an all-whitespace name clears it rather than storing blanks",
   Store.getReads(D2)[0].name === undefined,
   JSON.stringify(Store.getReads(D2)[0].name));
ok("...and the label falls back to the number",
   Store.readLabel(Store.getReads(D2)[0]) === "Read 1");
Store.renameRead(D2, r1.id, "The skim");

// ---- moving a comment ----
let res = Store.setCommentRead(D2, "cx1", r2.id);
ok("a comment can be filed under another read", res.ok && !res.noop);
ok("...and it really moved",
   Store.getComments(D2).find((c) => c.id === "cx1").readId === r2.id);

/*
 * The highlight follows a move when nothing else holds it. The case this is
 * for is forgetting to press "New read": the mark was made at the wrong time
 * too, and leaving it behind puts a Read 2 comment under a yellow Read 1 mark.
 */
ok("its highlight came with it, since no other read refers to that passage",
   res.movedHighlight === true && Store.getHighlights(D2)[0].readId === r2.id,
   JSON.stringify({ moved: res.movedHighlight, at: Store.getHighlights(D2)[0].readId }));
ok("...and the mark was recoloured to the new read",
   Store.getHighlights(D2)[0].color === r2.color, Store.getHighlights(D2)[0].color);

ok("moving a comment to the read it is already in does nothing",
   Store.setCommentRead(D2, "cx1", r2.id).noop === true);

/*
 * The exception: a passage that ANOTHER read still has something to say about
 * must stay put. Dragging it forward would leave the comment left behind
 * pointing at a mark now labelled as someone else's reading.
 *
 * The fixture has to leave a comment BEHIND for this to be the real case —
 * an earlier version of this test moved the only two comments that referred
 * to the passage into the same read, which left nothing in any other read and
 * so was not the shared case at all. It failed, correctly, and the fixture was
 * what was wrong.
 */
Store.setCommentRead(D2, "cx1", r1.id);   // put it back under Read 1
const hlsA = Store.getHighlights(D2);
hlsA[0].readId = r1.id; hlsA[0].color = "yellow";
Store.saveHighlights(D2, hlsA);

// A SECOND Read 1 comment about the same passage, which will stay behind.
const cs2 = Store.getComments(D2);
cs2.push({ id: "cx_stays", highlightId: "hx1", readId: r1.id, text: "Also about this.",
           createdAt: "2026-04-01T09:02:00Z" });
Store.saveComments(D2, cs2);

res = Store.setCommentRead(D2, "cx1", r2.id);
ok("a passage another read still refers to does NOT follow a move",
   res.ok && res.movedHighlight === false, JSON.stringify(res));
ok("...so the comment left behind keeps its mark",
   Store.getHighlights(D2)[0].readId === r1.id,
   Store.getHighlights(D2)[0].readId);

// ---- copying a comment ----
Store.setCommentRead(D2, "cx1", r1.id);    // back under Read 1 again
const before = Store.getComments(D2).length;
// Captured so the copy can be checked for changing nothing about the mark.
const highlightReadBeforeCopy = Store.getHighlights(D2)[0].readId;
const highlightColorBeforeCopy = Store.getHighlights(D2)[0].color;
const copy = Store.copyCommentToRead(D2, "cx1", r2.id);
ok("a comment can be copied into another read", copy.ok && !!copy.id, JSON.stringify(copy));

const after = Store.getComments(D2);
ok("...which ADDS a comment rather than moving one", after.length === before + 1,
   before + " -> " + after.length);
ok("the original stays where it was",
   after.find((c) => c.id === "cx1").readId === r1.id);

const made = after.find((c) => c.id === copy.id);
ok("the copy is under the read you chose", made.readId === r2.id);
ok("the copy says the same thing", made.text === "First thought.", made.text);
ok("the copy points at the same passage", made.highlightId === "hx1");
ok("the copy records where it came from",
   !!made.copiedFrom && made.copiedFrom.commentId === "cx1" && made.copiedFrom.readId === r1.id,
   JSON.stringify(made.copiedFrom));
ok("the copy has its own id", made.id !== "cx1");

/*
 * A copy must not drag the highlight anywhere, whatever read it happens to be
 * in. The original comment is still pointing at that passage, so moving the
 * mark would break the one left behind.
 *
 * Compared against the value captured BEFORE the copy rather than against a
 * hardcoded read: an earlier version asserted a specific id and failed because
 * a previous case in this file had legitimately moved it. The rule is "the copy
 * changed nothing", so that is what is measured.
 */
ok("copying leaves the highlight exactly where it was",
   Store.getHighlights(D2)[0].readId === highlightReadBeforeCopy,
   highlightReadBeforeCopy + " -> " + Store.getHighlights(D2)[0].readId);
ok("...and does not recolour it either",
   Store.getHighlights(D2)[0].color === highlightColorBeforeCopy,
   highlightColorBeforeCopy + " -> " + Store.getHighlights(D2)[0].color);

ok("copying into the read it is already in is refused",
   Store.copyCommentToRead(D2, "cx1", r1.id).ok === false);

// ---- deleting a read ----
const beforeDelete = Store.getComments(D2).length;
const del = Store.deleteRead(D2, r2.id);
ok("a read can be deleted", del.ok, JSON.stringify(del));
ok("it is gone from the list",
   Store.getReads(D2).length === 1 && Store.getReads(D2)[0].id === r1.id);
ok("NOTHING written during it was deleted",
   Store.getComments(D2).length === beforeDelete,
   beforeDelete + " -> " + Store.getComments(D2).length);
ok("its comments moved into the neighbouring read",
   Store.getComments(D2).every((c) => c.readId === r1.id),
   JSON.stringify(Store.getComments(D2).map((c) => c.readId)));
ok("the caller is told how many moved, so it can say so",
   typeof del.movedComments === "number" && del.movedComments > 0,
   String(del.movedComments));

/*
 * The last read cannot go. Every comment points at a read; with none left they
 * point at nothing, and the migration will not rebuild one because they
 * already carry a readId — so they would vanish from every per-read export.
 */
const lastGo = Store.deleteRead(D2, r1.id);
ok("the only read cannot be deleted", lastGo.ok === false && lastGo.reason === "last",
   JSON.stringify(lastGo));
ok("...and it is still there", Store.getReads(D2).length === 1);

// Deleting the FIRST read hands its notes forward instead of backward.
const r3 = Store.startNewRead(D2);
const firstGo = Store.deleteRead(D2, r1.id);
ok("deleting the first read moves its notes FORWARD to the next one",
   firstGo.ok && firstGo.into.id === r3.id, JSON.stringify(firstGo.into && firstGo.into.id));
ok("...and nothing was lost doing it",
   Store.getComments(D2).length === beforeDelete &&
   Store.getComments(D2).every((c) => c.readId === r3.id));

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
/*
 * The prefix here used to be a bare "COMMENT", then "MY THOUGHT ON <DATE>" on
 * one line with the whole passage quoted after it. Since 2026-10-16 a note is
 * a fenced block and the passage is named on its own line — short passages
 * like this one in full, long ones shortened to their opening words. See the
 * long note in js/comments.js above thoughtBlock for why.
 *
 * What this assertion is actually about is unchanged: a single-read export
 * must keep the PASSAGE from an earlier read when this read's comment refers
 * to it.
 */
ok("C10 ...while keeping the quote its comment refers to",
   /\*\*MY THOUGHT ON [A-Z]{3} \d+, \d{4}\*\*\n> \*on the highlighted passage \u201CDon't repeat yourself\.\u201D\*/.test(full2),
   "the Read 1 highlight was dropped, so the Read 2 comment lost its context");
/*
 * A short passage is printed WHOLE — under about a hundred characters there is
 * nothing to save by trimming, and a trimmed version would be nearly as long
 * while being less precise. So no ellipsis on this one.
 */
ok("C10b ...in full, because it is short enough that shortening would gain nothing",
   full2.includes("\u201CDon't repeat yourself.\u201D") &&
   !/Don't repeat\u2026/.test(full2),
   "a 22-character passage was shortened anyway");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

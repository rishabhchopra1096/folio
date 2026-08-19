/* Redoing a transcript with a better engine must keep the notes.

   The hazard: a note's anchor is a highlight, a highlight is a range into the
   transcript text, and Highlights.removeHighlight DELETES the comments
   attached to a highlight along with it. Clear highlights before detaching the
   notes and the notes go with them. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const PANEL = `<div id="comments-panel"><div class="comments-header"></div>
  <div id="comments-list"></div><textarea id="comment-input"></textarea>
  <button id="comment-submit"></button><button id="comment-cancel"></button>
  <button id="comments-close"></button><button id="comments-export"></button>
  <button id="comments-new-note"></button><button id="comment-mic-btn"></button>
  <div id="comments-resize"></div></div>`;
const dom = new JSDOM(`<!doctype html><body>${PANEL}</body>`, { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
global.Gemini = { formatTime: (s) => String(s) };
global.Voice = { hasKey: () => false };

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

const vsrc = fs.readFileSync(REPO + "/js/video.js", "utf8");
const hsrc = fs.readFileSync(REPO + "/js/highlights.js", "utf8");

console.log("\n=== the button is there when you need it ===");
ok("retry is always shown on a video document",
   /b\.style\.display = "";\s*\n\s*b\.title = !segTimes\.length/.test(vsrc));
ok("it no longer hides itself when the transcript looks complete",
   !/const incomplete = !transcriptLooksComplete\(\);\s*\n\s*b\.style\.display = incomplete/.test(vsrc));
ok("and it says what it will do to a complete one", /your notes are kept/.test(vsrc));

console.log("\n=== a redo actually redoes ===");
ok("only an interrupted run fills gaps",
   /const already = reason === "resume" \? existingSegments\(docId\) : \[\]/.test(vsrc));
ok("the hand-asked redo uses its own reason", /runTranscription\(docId, parsed, "redo"\)/.test(vsrc));
// Keeping the old lines would mark every window covered and change nothing.
ok("and why keeping them would be useless is recorded",
   /skip\s*\n?\s*\* every window as "already covered"/.test(vsrc));

console.log("\n=== the ordering hazard ===");
ok("removeHighlight really does delete attached comments",
   /Also remove associated comments[\s\S]{0,200}c\.highlightId !== highlightId/.test(hsrc));
ok("so the redo path does NOT use it",
   !/removeHighlight\(/.test(vsrc.slice(vsrc.indexOf("function clearHighlightsForRedo"),
                                        vsrc.indexOf("function confirmRedo"))));
ok("it clears the records directly instead",
   /FolioStore\.saveHighlights\(docId, \[\]\)/.test(vsrc));
const pinAt = vsrc.indexOf("const { pinned, stranded } = pinNoteMoments(docId)");
const clearAt = vsrc.indexOf("clearHighlightsForRedo(docId)", pinAt);
ok("notes are pinned BEFORE highlights are cleared", pinAt > -1 && clearAt > pinAt,
   `pin@${pinAt} clear@${clearAt}`);
ok("and the reason is written down where it can be seen",
   /deletes the comments\s*\n?\s*\* attached to a highlight/.test(vsrc));

console.log("\n=== a note keeps its moment across the rewrite ===");
const comments = [
  { id: "c1", highlightId: "hl1", text: "dictated with a timestamp", videoTime: 615 },
  { id: "c2", highlightId: "hl2", text: "older note, no timestamp" },
  { id: "c3", highlightId: null, isGeneral: true, text: "a general note" },
];
global.FolioStore = {
  getSettings: () => ({}), saveSettings: () => {},
  getDocument: () => ({ meta: { title: "v" }, content: { blocks: [] } }),
  getHighlights: () => [], saveHighlights: () => {},
  getComments: () => comments, saveComments: () => {},
  generateId: (p) => p + "_x",
};
global.Reader = { getCurrentDocId: () => "doc_v" };
const csrc = fs.readFileSync(REPO + "/js/comments.js", "utf8")
  .replace("  return {\n    init,", "  return {\n    __unanchor: unanchor,\n    init,");
const C = eval(csrc + "; Comments;");

ok("a note with a timestamp detaches cleanly", C.__unanchor("doc_v", "c1"));
ok("its highlight link is gone", comments[0].highlightId === null);
ok("its moment survives", comments[0].videoTime === 615);
ok("and it is not mislabelled as a general note", comments[0].isGeneral === false);

// A note with no timestamp of its own is given one read off its line.
ok("a note given a moment detaches too", C.__unanchor("doc_v", "c2", 930));
ok("and takes that moment", comments[1].videoTime === 930);

ok("a note with NO moment at all is left alone rather than stranded",
   C.__unanchor("doc_v", "c3") === false);
ok("so it keeps whatever it had", comments[2].isGeneral === true);

console.log("\n=== reading a moment off the line, for older notes ===");
ok("the highlight's line is consulted when there is no timestamp",
   /mark\[data-highlight-id=/.test(vsrc) && /closest\("\[data-t\]"\)/.test(vsrc));
ok("a note that cannot be given a moment is counted, not silently dropped",
   /stranded\+\+/.test(vsrc));
ok("and you are told about it", /no timestamp and will show as unlinked/.test(vsrc));

console.log("\n=== you are asked first ===");
ok("a redo is confirmed", /function confirmRedo/.test(vsrc));
ok("the message says the transcript is replaced", /The current transcript is replaced/.test(vsrc));
ok("and how many notes are kept", /notes are kept/.test(vsrc));
ok("cancelling does nothing", /cancel\.addEventListener\("click", close\)/.test(vsrc));
ok("the redo is logged", /Gemini\.log\("redo"/.test(vsrc));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

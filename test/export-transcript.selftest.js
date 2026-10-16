/* Transcript export: the full transcript with comments under the lines they
   belong to, and general notes at the top. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const { readsStub } = require("./fixtures/reads-stub.js");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const PANEL = `<div id="comments-panel"><div class="comments-header"></div>
  <div id="comments-list"></div><textarea id="comment-input"></textarea>
  <button id="comment-submit"></button><button id="comment-cancel"></button>
  <button id="comments-close"></button><button id="comments-export"></button>
  <button id="comments-new-note"></button><button id="comment-mic-btn"></button>
  <div id="comments-resize"></div></div>`;
const dom = new JSDOM(`<!doctype html><body>${PANEL}</body>`, { url:"https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
global.Gemini = { formatTime:(s)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}` };
global.Voice = { hasKey:()=>false };

const blocks = [
  { type:"video", data:{ videoId:"AP8nlJcjw4I", url:"https://www.youtube.com/watch?v=AP8nlJcjw4I" } },
  { type:"paragraph", data:{ text:"Welcome to the playthrough.", t:0 } },
  { type:"paragraph", data:{ text:"[shows] Pokedex reads 0 / 151.", t:65 } },
  { type:"paragraph", data:{ text:"Time to pick a starter.", t:130 } },
];
const highlights = [
  { id:"hl_a", text:"[shows] Pokedex reads 0 / 151." },
  { id:"hl_b", text:"Time to pick a starter." },
];
const comments = [
  { id:"c1", highlightId:null, isGeneral:true, text:"Ok, that's cool.", createdAt:"2026-08-19T09:59:00Z" },
  { id:"c2", highlightId:"hl_a", text:"Counter starts at zero — good baseline.", createdAt:"2026-08-19T10:00:30Z" },
  { id:"c3", highlightId:"hl_b", text:"This is the\nreal decision point.", createdAt:"2026-08-19T10:01:30Z" },
  { id:"c4", highlightId:"hl_gone", text:"Orphan comment.", createdAt:"2026-08-19T10:02:00Z" },
  /*
   * A note with a REAL paragraph break in it — a blank line, not a soft wrap.
   * c3 above has a single newline, which is a soft wrap and is still collapsed
   * into one line, so it does not exercise the paragraph-keeping code at all.
   * Without this fixture a mutation that threw the breaks away would pass.
   */
  { id:"c5", highlightId:"hl_b",
    text:"Two separate points here.\n\nThe second one needs its own paragraph.",
    createdAt:"2026-08-19T10:03:00Z" },
];

global.FolioStore = {
  // Reads: comments now record which pass through the document they were
  // written during, so the comments module asks the store about them.
  ...readsStub(),
  getSettings:()=>({}), saveSettings:()=>{},
  getDocument:()=>({ meta:{title:"Pokémon Red 100%"}, content:{blocks} }),
  getHighlights:()=>highlights, getComments:()=>comments,
  saveComments:()=>{}, generateId:(p)=>p+"_x",
};
global.Reader = { getCurrentDocId:()=>"doc_v" };

let captured = "";
global.Blob = class { constructor(parts){ captured = parts[0]; } };
dom.window.URL.createObjectURL = () => "blob:x";
dom.window.URL.revokeObjectURL = () => {};
const realCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (tag === "a") el.click = () => {};
  return el;
};

// Expose the exporter without running init().
const src = fs.readFileSync(REPO+"/js/comments.js","utf8")
  /*
   * Reach the FULL export directly. exportAnnotations() now asks which of the
   * two exports is wanted, and a test should say which one it means rather than
   * depend on whichever happens to be the default.
   */
  .replace("  return {\n    init,", "  return {\n    __export: () => runExport(\"full\"),\n    init,");
const C = eval(src + "; Comments;");
C.__export();

const out = captured || "";
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

console.log("\n--- exported markdown ---\n" + out + "\n-------------------------");

console.log("\n=== header ===");
ok("document title",   /^# Pokémon Red 100%/m.test(out));
ok("video URL",        /youtube\.com\/watch\?v=AP8nlJcjw4I/.test(out));
ok("Notes section",    /## Notes/.test(out));
/*
 * THE EXPECTED SHAPE CHANGED ON 2026-10-15, deliberately.
 *
 * Every export used to introduce a comment with a bare arrow or a bare
 * "COMMENT", neither of which said WHEN the thought was had — which is the
 * one thing an export of a re-read document has to carry. The label is now
 * "MY THOUGHT ON <DATE>", and these assertions pin the date as well as the
 * text, so a regression that dropped the label could not pass by matching
 * the sentence alone.
 */
/*
 * The shape changed deliberately on 2026-10-16: a note is no longer a single
 * line but a fenced block, with the label on its own header line and the text
 * quoted beneath it. Both halves are pinned below.
 */
ok("general note, dated",
   /^> \*\*MY THOUGHT ON AUG 19, 2026\*\*$/m.test(out),
   (out.split("\n").find((l) => /MY THOUGHT/.test(l)) || "header not found"));
ok("...with its text fenced beneath, not run onto the label",
   /^> Ok, that's cool\.$/m.test(out),
   (out.split("\n").find((l) => /Ok, that's cool/.test(l)) || "text line not found"));
ok("Transcript section", /## Transcript/.test(out));

console.log("\n=== the WHOLE transcript is present, not just commented lines ===");
ok("0:00 line", /\*\*\[0:00\]\*\* Welcome to the playthrough\./.test(out));
ok("1:05 line", /\*\*\[1:05\]\*\* \[shows\] Pokedex reads 0 \/ 151\./.test(out));
ok("2:10 line", /\*\*\[2:10\]\*\* Time to pick a starter\./.test(out));

console.log("\n=== comments sit under their own line ===");
const iL=out.indexOf("[1:05]"), iC=out.indexOf("Counter starts at zero"), iN=out.indexOf("[2:10]");
ok("after its line",  iC>iL, `${iL} -> ${iC}`);
ok("before the next", iC<iN, `${iC} -> ${iN}`);
ok("marked as a comment, and dated",
   /^ {2}> 💬 \*\*MY THOUGHT ON AUG 19, 2026\*\*$/m.test(out),
   (out.split("\n").find((l) => /💬/.test(l)) || "header not found"));
ok("...with the note itself on its own fenced line",
   /^ {2}> Counter starts at zero/m.test(out),
   (out.split("\n").find((l) => /Counter starts at zero/.test(l)) || "text line not found"));
ok("second comment is its own fenced block",
   /^ {2}> This is the real decision point\.$/m.test(out),
   (out.split("\n").find((l) => /real decision point/.test(l)) || "text line not found"));

console.log("\n=== a note keeps the paragraphs you typed ===");
/*
 * Why this matters: every export used to collapse a note to one line, so his
 * longest thought — several distinct points — came out as one wall of text.
 * A blank line in the note is now a blank QUOTED line in the file, which is
 * what keeps the paragraphs apart inside the one blockquote.
 */
ok("the first paragraph is fenced",
   /^ {2}> Two separate points here\.$/m.test(out),
   (out.split("\n").find((l) => /Two separate points/.test(l)) || "not found"));
ok("the second paragraph is fenced too, not glued to the first",
   /^ {2}> The second one needs its own paragraph\.$/m.test(out),
   (out.split("\n").find((l) => /second one needs/.test(l)) || "not found"));
ok("...separated by a quoted blank line, so markdown keeps them apart",
   /^ {2}> Two separate points here\.\n {2}>\n {2}> The second one needs its own paragraph\.$/m.test(out),
   "the two paragraphs ran together");
ok("...and every line of the note carries the fence, so none can read as transcript",
   out.split("\n").filter((l) => /Two separate points|second one needs/.test(l))
      .every((l) => /^\s*>/.test(l)),
   "a line of a note was left unfenced");

console.log("\n=== robustness ===");
/* A SINGLE newline is a soft wrap, not a paragraph, and is still collapsed —
 * the same way markdown itself treats one. Only a blank line starts a new
 * paragraph (asserted above). */
ok("a soft wrap inside a paragraph is still collapsed", !/decision\n/.test(out));
ok("orphan comment not lost", /Orphan comment\./.test(out));
ok("[shows] prefix preserved", /\[shows\]/.test(out));
ok("no raw HTML leaked", !/<[a-z]/i.test(out), (out.match(/<[a-z][^>]*>/i)||[""])[0]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

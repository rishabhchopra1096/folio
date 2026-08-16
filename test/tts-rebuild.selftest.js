/*
 * Tests the assumption the dictate-and-resume loop rests on:
 *
 *   Highlighting a paragraph wraps its text in <mark> elements, which SPLITS
 *   text nodes and invalidates every node reference in the index. But the text
 *   CONTENT is unchanged — so after rebuilding the index, docText must be
 *   byte-identical and every character offset must still resolve to the same
 *   character.
 *
 * If that doesn't hold, the playhead jumps the moment you dictate a comment,
 * and every subsequent word highlight is wrong.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const HTML = `
<div id="article">
  <h1>Heading — with a dash</h1>
  <p>First paragraph has <b>bold</b> and <i>italic</i> and plain text.</p>
  <p>Dr. Chen paid $5 on 2026 — that was cheap 🎨 indeed. Second sentence.</p>
  <p>Third paragraph, entirely plain.</p>
</div>`;

const dom = new JSDOM(`<!doctype html><body>${HTML}</body>`);
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined;
global.speechSynthesis = undefined;

const store = { docs: {}, hl: {}, cm: {}, settings: {} };
global.FolioStore = {
  getSettings: () => JSON.parse(JSON.stringify(store.settings)),
  saveSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
  generateId: (p) => p + "_" + Math.random().toString(36).slice(2, 8),
  getHighlights: () => store.hlArr || (store.hlArr = []),
  saveHighlights: (_d, h) => { store.hlArr = h; },
  getComments: () => store.cmArr || (store.cmArr = []),
  saveComments: (_d, c) => { store.cmArr = c; },
};
global.Reader = { getCurrentDocId: () => "doc_test" };

// Load Highlights (it needs a few DOM elements to exist).
["highlight-toolbar", "highlight-popover"].forEach((id) => {
  const d = dom.window.document.createElement("div");
  d.id = id;
  dom.window.document.body.appendChild(d);
});
const hlSrc = fs.readFileSync(path.join(REPO, "js/highlights.js"), "utf8");
const Highlights = eval(hlSrc + "; Highlights;");
global.Highlights = Highlights;
global.Comments = undefined;

// Load TTS with internals exposed.
const ttsSrc = fs.readFileSync(path.join(REPO, "js/tts.js"), "utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get docText(){return docText;}, get segments(){return segments;}, " +
  "locate, charToRange, blockAt, highlightCurrentBlock, " +
  "setCur: (p)=>{curWord={ds:p,de:p+4};} }),\n    init, attach, detach,"
);
const TTS = eval(ttsSrc + "; TTS;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

TTS.attach("doc_test");
const I = TTS.__i();

const before = I.docText;
const beforeLen = before.length;
console.log("\ndocText before highlight:", beforeLen, "chars");

// Snapshot what every offset resolves to, before we mutate anything.
const snapshot = [];
for (let i = 0; i < beforeLen; i++) {
  if (before[i] === "\n") continue;
  snapshot.push([i, before[i]]);
}

console.log("\n=== highlight the paragraph containing the playhead ===");
const dollarAt = before.indexOf("$5");
I.setCur(dollarAt);
const id = I.highlightCurrentBlock();
ok("highlight created", !!id, String(id));
ok("a <mark> now exists in the DOM",
   dom.window.document.querySelectorAll("mark[data-highlight-id]").length > 0);
ok("the marked text is the right paragraph",
   Array.from(dom.window.document.querySelectorAll("mark[data-highlight-id]"))
     .map(m => m.textContent).join("").includes("Dr. Chen"));

console.log("\n=== docText survives the DOM mutation ===");
const after = I.docText;
ok("docText length unchanged", after.length === beforeLen,
   `${beforeLen} -> ${after.length}`);
ok("docText content identical", after === before,
   after === before ? "" : "content diverged");

console.log("\n=== every offset still resolves to the same character ===");
let bad = [];
for (const [i, ch] of snapshot) {
  const loc = I.locate(i, false);
  if (!loc) { bad.push([i, ch, "(no location)"]); continue; }
  const got = loc.node.nodeValue[loc.off];
  if (got !== ch) bad.push([i, JSON.stringify(ch), JSON.stringify(got)]);
  if (bad.length > 5) break;
}
ok("all offsets round-trip after rebuild", bad.length === 0,
   bad.slice(0, 4).map(b => `@${b[0]} want ${b[1]} got ${b[2]}`).join("; "));

console.log("\n=== ranges still resolve to the right text ===");
function checkRange(needle) {
  const at = I.docText.indexOf(needle);
  const r = at === -1 ? null : I.charToRange(at, at + needle.length);
  ok(`"${needle}" range correct`, r && r.toString() === needle,
     r ? JSON.stringify(r.toString()) : "not found");
}
checkRange("$5");                    // inside the newly highlighted paragraph
checkRange("Dr. Chen");              // ditto
checkRange("🎨");                    // surrogate pair inside the highlight
checkRange("Second sentence.");      // ditto
checkRange("bold");                  // untouched paragraph, inline markup
checkRange("Third paragraph");       // untouched paragraph

console.log("\n=== blockAt still finds the right paragraph ===");
const b = I.blockAt(dollarAt);
ok("blockAt returns the Dr. Chen paragraph",
   b && b.el.textContent.includes("Dr. Chen"), b ? b.el.textContent.slice(0, 26) : "null");

console.log("\n=== highlighting a SECOND paragraph also survives ===");
const thirdAt = I.docText.indexOf("Third paragraph");
I.setCur(thirdAt);
const id2 = I.highlightCurrentBlock();
ok("second highlight created", !!id2);
ok("docText still identical", I.docText === before,
   I.docText.length + " vs " + beforeLen);
let bad2 = [];
for (const [i, ch] of snapshot) {
  const loc = I.locate(i, false);
  const got = loc && loc.node.nodeValue[loc.off];
  if (got !== ch) { bad2.push(i); if (bad2.length > 3) break; }
}
ok("offsets still round-trip after two highlights", bad2.length === 0,
   "first bad offsets: " + bad2.join(","));

console.log("\n=== stored highlights remain resolvable ===");
ok("two highlights persisted", (store.hlArr || []).length === 2,
   String((store.hlArr || []).length));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

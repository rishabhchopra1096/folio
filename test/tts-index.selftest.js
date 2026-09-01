/*
 * Verifies the read-aloud document index in a real DOM (jsdom).
 *
 * The risky claim in js/tts.js is: "any character offset in docText can be
 * mapped back to the exact DOM position it came from." Everything downstream
 * (word highlighting, sentence highlighting, pause-to-comment) is built on it,
 * so it gets tested directly rather than assumed.
 *
 * The fixture deliberately includes the things that broke the previous
 * implementation: inline markup splitting a paragraph into several text nodes,
 * an em-dash, an emoji (surrogate pair), a <pre> block that must be skipped,
 * and existing <mark> highlights.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const HTML = `
<div id="article">
  <h1>A.2 — LoginScreen</h1>
  <p>LoginScreen is the <b>entry point</b> for both kids and parents. It has two tabs.</p>
  <p>Dr. Chen paid $5 on 2026 — that was cheap 🎨 indeed. A second sentence here.</p>
  <pre><code>const skipMe = true;</code></pre>
  <ul><li>First item</li><li>Second <i>italic</i> item</li></ul>
  <p>Text with an <mark class="hl-yellow" data-highlight-id="hl_1">existing highlight</mark> inside it.</p>
  <figure class="folio-image"><img src="x"><figcaption>skip me too</figcaption></figure>
  <p>Final paragraph.</p>
</div>`;

const dom = new JSDOM(`<!doctype html><body>${HTML}</body>`);
const { window } = dom;

// Minimal globals tts.js touches.
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.CSS = undefined;               // force the no-Highlight-API path
global.speechSynthesis = undefined;   // no engine in Node
global.FolioStore = { getSettings: () => ({}), saveSettings: () => {} };

// Load tts.js and grab the module. It's an IIFE assigned to `const TTS`, so
// eval it in a scope where we can capture the binding.
const src = fs.readFileSync(path.join(REPO, "js/tts.js"), "utf8");
const TTS = eval(src + "; TTS;");

let pass = 0, fail = 0;
const ok  = (name, cond, extra) => { cond ? (pass++, console.log("  ✓ " + name))
                                          : (fail++, console.log("  ✗ " + name + (extra ? "  → " + extra : ""))); };

console.log("\n=== attach() builds an index without throwing ===");
let threw = null;
try { TTS.attach("doc_test"); } catch (e) { threw = e; }
ok("attach() did not throw", !threw, threw && threw.stack.split("\n")[0]);

// Reach inside via a re-eval that exposes internals for assertions.
const probeSrc = src
  .replace("return {\n    init, attach, detach,", "return {\n    __internals: () => ({ docText, segments, blocks, sentences, chunks, locate, charToRange, blockAt }),\n    init, attach, detach,");
const TTS2 = eval(probeSrc + "; TTS;");
TTS2.attach("doc_test");
const I = TTS2.__internals();

console.log("\n=== index shape ===");
ok("docText is non-empty", I.docText.length > 0, "len=" + I.docText.length);
ok("segments built", I.segments.length > 0, "n=" + I.segments.length);
ok("blocks built", I.blocks.length > 0, "n=" + I.blocks.length);
ok("chunks built", I.chunks.length > 0, "n=" + I.chunks.length);
ok("sentences built", I.sentences.length > 0, "n=" + I.sentences.length);

console.log("\n=== skipped blocks ===");
ok("<pre> content excluded", !I.docText.includes("const skipMe"), "docText leaked code");
ok("<figure> caption excluded", !I.docText.includes("skip me too"), "docText leaked figcaption");

console.log("\n=== text preserved across inline markup ===");
ok("bold text included", I.docText.includes("entry point"));
ok("italic text included", I.docText.includes("italic"));
ok("existing <mark> text included", I.docText.includes("existing highlight"));

console.log("\n=== ROUND TRIP: every offset maps back to the right character ===");
// The core invariant. For each offset, locate() must return the DOM text node
// and offset whose character equals docText[i].
let mismatches = [];
for (let i = 0; i < I.docText.length; i++) {
  const ch = I.docText[i];
  if (ch === "\n") continue;            // block separators belong to no segment
  const loc = I.locate(i);
  if (!loc) { mismatches.push([i, ch, "(no location)"]); continue; }
  const got = loc.node.nodeValue[loc.off];
  if (got !== ch) mismatches.push([i, JSON.stringify(ch), JSON.stringify(got)]);
  if (mismatches.length > 5) break;
}
ok("all offsets round-trip to the correct character", mismatches.length === 0,
   mismatches.slice(0, 5).map(m => `@${m[0]} want ${m[1]} got ${m[2]}`).join("; "));

console.log("\n=== charToRange produces the exact substring ===");
function checkRange(needle) {
  const at = I.docText.indexOf(needle);
  if (at === -1) { ok(`found "${needle}" in docText`, false); return; }
  const r = I.charToRange(at, at + needle.length);
  ok(`range for "${needle}" === the text`, r && r.toString() === needle,
     r ? JSON.stringify(r.toString()) : "null range");
}
checkRange("LoginScreen");
checkRange("entry point");          // spans into a <b>
checkRange("$5");                   // the normalization trap
checkRange("—");                    // em-dash
checkRange("🎨");                   // surrogate pair
checkRange("existing highlight");   // inside an existing <mark>
checkRange("Final paragraph.");

console.log("\n=== surrogate pair handled as UTF-16 ===");
const emojiAt = I.docText.indexOf("🎨");
ok("emoji occupies 2 UTF-16 units", "🎨".length === 2);
const rEmoji = I.charToRange(emojiAt, emojiAt + 2);
ok("2-unit range yields the whole emoji", rEmoji && rEmoji.toString() === "🎨",
   rEmoji ? JSON.stringify(rEmoji.toString()) : "null");

console.log("\n=== blockAt() finds the containing paragraph ===");
const dollarAt = I.docText.indexOf("$5");
const b = I.blockAt(dollarAt);
ok("blockAt returns a block", !!b);
ok("block is the right <p>", b && b.el.tagName === "P" && b.el.textContent.includes("Dr. Chen"),
   b ? b.el.tagName + ": " + b.el.textContent.slice(0, 30) : "null");

console.log("\n=== a list item is its own block ===");
/*
 * THE REPORTED BUG. Blocks were the article's top-level children, so an entire
 * <ul> was one block — and pausing to comment on a bullet highlighted the whole
 * list instead of the line being read.
 */
{
  const listBlocks = I.blocks.filter((b) => b.el.tagName === "LI");
  ok("both bullets are blocks in their own right", listBlocks.length === 2,
     "LI blocks=" + listBlocks.length);
  ok("the <ul> itself is NOT a block",
     !I.blocks.some((b) => b.el.tagName === "UL" || b.el.tagName === "OL"),
     I.blocks.map((b) => b.el.tagName).join(","));

  const firstAt = I.docText.indexOf("First item");
  const secondAt = I.docText.indexOf("Second");
  ok("both items are in the text", firstAt !== -1 && secondAt !== -1);

  const b1 = I.blockAt(firstAt);
  ok("a character in the first bullet resolves to that bullet",
     b1 && b1.el.tagName === "LI", b1 ? b1.el.tagName : "null");
  ok("and its block covers ONLY that bullet",
     b1 && I.docText.slice(b1.ds, b1.de).trim() === "First item",
     b1 ? JSON.stringify(I.docText.slice(b1.ds, b1.de)) : "null");

  const b2 = I.blockAt(secondAt);
  ok("the second bullet is a different block", b1 && b2 && b1.el !== b2.el);
  ok("it spans the whole item including inline markup",
     b2 && I.docText.slice(b2.ds, b2.de).trim() === "Second italic item",
     b2 ? JSON.stringify(I.docText.slice(b2.ds, b2.de)) : "null");
}

console.log("\n=== skipped containers stay skipped ===");
{
  ok("nothing from <pre> is in the text", I.docText.indexOf("skipMe") === -1);
  ok("nothing from <figure> is either", I.docText.indexOf("skip me too") === -1,
     "figcaption leaked despite FIGURE being skipped");
}

console.log("\n=== chunking ===");
ok("no chunk exceeds the backstop", I.chunks.every(c => c.text.length <= 2000),
   "max=" + Math.max(...I.chunks.map(c => c.text.length)));
ok("chunk text matches its own doc range",
   I.chunks.every(c => c.text === I.docText.slice(c.ds, c.de)));

/*
 * A chunk MAY now span consecutive paragraphs, and that is deliberate: stopping
 * at every one produced 545 tiny chunks on a real document, and for a network
 * voice each is a separate request paying a flat latency floor.
 *
 * What still has to hold is the reason the old rule existed — a seam must land
 * where a pause belongs. That is a SENTENCE boundary, which is a stronger and
 * more honest statement of the intent than "inside one block".
 */
ok("every chunk starts exactly where a sentence starts",
   I.chunks.every(c => I.sentences.some(s => s.ds === c.ds)),
   "offending=" + JSON.stringify(I.chunks.filter(c => !I.sentences.some(s => s.ds === c.ds))
     .map(c => c.ds).slice(0, 5)));
ok("every chunk ends exactly where a sentence ends",
   I.chunks.every(c => I.sentences.some(s => s.de === c.de)),
   "offending=" + JSON.stringify(I.chunks.filter(c => !I.sentences.some(s => s.de === c.de))
     .map(c => c.de).slice(0, 5)));
ok("chunks together cover every sentence, none dropped",
   I.sentences.every(s => I.chunks.some(c => s.ds >= c.ds && s.de <= c.de)));
ok("chunks are ordered and non-overlapping",
   I.chunks.every((c, i) => i === 0 || c.ds >= I.chunks[i - 1].de));

console.log("\n=== sentence splitting ===");
const twoSent = I.sentences.filter(s => I.docText.slice(s.ds, s.de).includes("second sentence"));
ok("second sentence detected separately", twoSent.length === 1,
   "matches=" + twoSent.length);
ok("sentence ranges match their text",
   I.sentences.every(s => I.docText.slice(s.ds, s.de).length === s.de - s.ds));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

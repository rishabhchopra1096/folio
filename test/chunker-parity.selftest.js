/*
 * Proves js/chunker.js cuts a document in EXACTLY the same places js/tts.js does.
 *
 * WHY THIS TEST IS THE WHOLE POINT:
 * A piece of synthesised audio is cached under a key derived from its exact
 * text. The reader (js/tts.js) and the drive player (js/drive.js, via
 * js/chunker.js) both read the same documents, so if they disagree about where
 * a chunk begins by even one character, every chunk after that point is a
 * cache MISS — the audio is bought again, and the user pays twice for the same
 * words. The two implementations are deliberately separate files, so the only
 * thing keeping them honest is this test.
 *
 * It compares the three things that matter, in order of how badly a mismatch
 * would hurt:
 *   - the chunk texts, character for character   (money)
 *   - the sentence ranges                        (sentence skip, note anchors)
 *   - docText and the block ranges               (everything else)
 *
 * MUTATION PROOF: change CHUNK_MIN_CHARS, BOUNDARY_EVERY or the hash in either
 * file and the chunk-text comparison fails. Verified by doing exactly that —
 * see the run recorded in docs/drive-mode/README.md.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

/*
 * A fixture big enough to actually produce several chunks (the minimum chunk is
 * 600 characters, so a short fixture would never exercise a boundary at all),
 * and awkward enough to catch the things that have broken this code before:
 * inline markup splitting a paragraph into several text nodes, an abbreviation
 * Intl.Segmenter must not treat as a sentence end, a surrogate pair, a <pre>
 * that must be skipped, nested lists, a table, and an existing <mark>.
 */
const PARA = [
  "LoginScreen is the <b>entry point</b> for both kids and parents, and it has two tabs that behave quite differently once you look closely at what each of them submits.",
  "Dr. Chen paid $5 on 2026 — that was cheap 🎨 indeed. A second sentence follows it here, deliberately, so the segmenter has to make a real decision about the abbreviation.",
  "The parent tab collects an email address and a password, validates both against the rules in the shared validator, and only then calls through to the authentication service.",
  "The kid tab collects a nickname and a four digit code instead. It never sees an email address at all, which is the entire reason the two tabs cannot share a single form component.",
  "Everything below this point exists to give the chunker enough material to find more than one boundary, because a fixture that produces a single chunk proves almost nothing.",
  "A sentence whose hash lands on a boundary closes the chunk it is in. A sentence whose hash does not simply extends it. That rule is what this test is really pinning down.",
  "The eighth paragraph repeats the structure of the fourth on purpose: identical prose in two places must still produce two chunks with identical text, so the cache can serve both.",
  "A further paragraph, long enough that the accumulated character count crosses the maximum backstop at least once and forces a close that the hash did not ask for on its own.",
  "Reading aloud is not the same problem as rendering. The renderer can afford to treat the article as a tree; the voice needs one flat string, and the mapping between them is where the bugs live.",
  "Consider what happens when a paragraph is split into three text nodes by inline markup. The string must come out seamless, and every offset in it must still point back at the right node.",
  "A chunk that ends mid-sentence would make the voice pause in the wrong place, which is why the grouping only ever closes on a sentence that has already finished.",
  "There is a second reason to prefer fewer, larger requests: a plan that allows one request in flight at a time turns every extra chunk into an extra stall before the next words arrive.",
  "The cost of getting this wrong is not abstract. It is a bill, and a silence while the listener waits for audio that has already been paid for once and is being paid for again.",
  "Enough prose now exists that the boundary rule fires several times, which is the only way to be confident the two implementations agree about more than a trivial case.",
  "One more paragraph for good measure, because the maximum backstop at eighteen hundred characters needs a long enough run to be reached at all in a fixture of ordinary sentences.",
  "And a last one, which closes the fixture and leaves the final partial chunk to be flushed by the tail of the grouping loop rather than by any boundary decision.",
];

const HTML = `
<div id="article">
  <h1>A.2 — LoginScreen</h1>
  ${PARA.map((p) => `<p>${p}</p>`).join("\n  ")}
  <pre><code>const skipMe = true;</code></pre>
  <ul><li>First item with enough words in it to matter</li><li>Second <i>italic</i> item, also reasonably wordy</li></ul>
  <blockquote>A quoted passage that is its own block and must be read as one.</blockquote>
  <table><tr><td>Cell one</td><td>Cell two</td></tr></table>
  <p>Text with an <mark class="hl-yellow" data-highlight-id="hl_1">existing highlight</mark> inside it, which must not change the text one bit.</p>
  <figure class="folio-image"><img src="x"><figcaption>skip me too</figcaption></figure>
  <p>Final paragraph, after the skipped figure.</p>
</div>`;

const dom = new JSDOM(`<!doctype html><body>${HTML}</body>`);
const { window } = dom;

// Minimal globals both files touch.
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.CSS = undefined;               // force the no-Highlight-API path
global.speechSynthesis = undefined;   // no engine in Node
global.FolioStore = { getSettings: () => ({}), saveSettings: () => {} };

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? (pass++, console.log("  ✓ " + name))
       : (fail++, console.log("  ✗ " + name + (extra ? "  → " + extra : "")));
};

// --------------------------------------------------------------------------
// The reader's answer, reached through the same probe the other tts suites use.
// --------------------------------------------------------------------------
const ttsSrc = fs.readFileSync(path.join(REPO, "js/tts.js"), "utf8");
const probeSrc = ttsSrc.replace(
  "return {\n    init, attach, detach,",
  "return {\n    __internals: () => ({ docText, segments, blocks, sentences, chunks }),\n    init, attach, detach,"
);
const TTS = eval(probeSrc + "; TTS;");
TTS.attach("doc_parity");
const reader = TTS.__internals();

// --------------------------------------------------------------------------
// The chunker's answer.
// --------------------------------------------------------------------------
const Chunker = require(path.join(REPO, "js/chunker.js"));
const drive = Chunker.plan(window.document.getElementById("article"));

console.log("\n=== both implementations produced something ===");
ok("the reader built chunks", reader.chunks.length > 0, "n=" + reader.chunks.length);
ok("the chunker built chunks", drive.chunks.length > 0, "n=" + drive.chunks.length);
ok("the fixture is big enough to have several chunks", drive.chunks.length >= 3,
   "n=" + drive.chunks.length + " — a 1-chunk fixture would not test boundaries");

console.log("\n=== docText is identical ===");
ok("same length", reader.docText.length === drive.docText.length,
   "reader=" + reader.docText.length + " chunker=" + drive.docText.length);
ok("same characters", reader.docText === drive.docText,
   firstDiff(reader.docText, drive.docText));

console.log("\n=== blocks are identical ===");
ok("same count", reader.blocks.length === drive.blocks.length,
   "reader=" + reader.blocks.length + " chunker=" + drive.blocks.length);
ok("same ranges", sameRanges(reader.blocks, drive.blocks), rangeDiff(reader.blocks, drive.blocks));
ok("same elements", reader.blocks.every((b, i) => drive.blocks[i] && drive.blocks[i].el === b.el),
   "a block resolved to a different DOM element");

console.log("\n=== sentences are identical ===");
ok("same count", reader.sentences.length === drive.sentences.length,
   "reader=" + reader.sentences.length + " chunker=" + drive.sentences.length);
ok("same ranges", sameRanges(reader.sentences, drive.sentences),
   rangeDiff(reader.sentences, drive.sentences));

console.log("\n=== chunks are identical — this is the one that costs money ===");
ok("same count", reader.chunks.length === drive.chunks.length,
   "reader=" + reader.chunks.length + " chunker=" + drive.chunks.length);
ok("same ranges", sameRanges(reader.chunks, drive.chunks), rangeDiff(reader.chunks, drive.chunks));

const texts = reader.chunks.map((c) => c.text);
const driveTexts = drive.chunks.map((c) => c.text);
let textMismatch = null;
for (let i = 0; i < Math.max(texts.length, driveTexts.length); i++) {
  if (texts[i] !== driveTexts[i]) {
    textMismatch = "chunk " + i + ": " + firstDiff(texts[i] || "", driveTexts[i] || "");
    break;
  }
}
ok("every chunk's text matches character for character", textMismatch === null, textMismatch);

console.log("\n=== the constants agree ===");
const readerConst = (name) => {
  const m = ttsSrc.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\d+)"));
  return m ? Number(m[1]) : null;
};
ok("CHUNK_MIN_CHARS", readerConst("CHUNK_MIN_CHARS") === Chunker.CHUNK_MIN_CHARS,
   "tts=" + readerConst("CHUNK_MIN_CHARS") + " chunker=" + Chunker.CHUNK_MIN_CHARS);
ok("CHUNK_MAX_CHARS", readerConst("CHUNK_MAX_CHARS") === Chunker.CHUNK_MAX_CHARS,
   "tts=" + readerConst("CHUNK_MAX_CHARS") + " chunker=" + Chunker.CHUNK_MAX_CHARS);
ok("BOUNDARY_EVERY", readerConst("BOUNDARY_EVERY") === Chunker.BOUNDARY_EVERY,
   "tts=" + readerConst("BOUNDARY_EVERY") + " chunker=" + Chunker.BOUNDARY_EVERY);

console.log("\n=== text nodes are counted the way highlights.js counts them ===");
/*
 * A note dictated on the drive writes a highlight, and a highlight's position
 * is stored as "the Nth text node in the article". js/highlights.js counts with
 * a bare TreeWalker over text nodes — no filter — so Chunker.textNodes must do
 * the same, INCLUDING the nodes that are skipped for speech. If it filtered
 * them out, every index would be short and notes would land on the wrong line.
 */
const hlSrc = fs.readFileSync(path.join(REPO, "js/highlights.js"), "utf8");
ok("highlights.js still uses an unfiltered SHOW_TEXT walker",
   /createTreeWalker\(root, NodeFilter\.SHOW_TEXT\)\s*;/.test(hlSrc),
   "if this changed, Chunker.textNodes must change with it");
const nodes = Chunker.textNodes(window.document.getElementById("article"));
const inPre = nodes.some((n) => n.nodeValue.includes("const skipMe"));
ok("counts text inside <pre>, which speech skips", inPre,
   "found " + nodes.length + " nodes but none inside the <pre>");
const inFigcaption = nodes.some((n) => n.nodeValue.includes("skip me too"));
ok("counts a figcaption, which speech skips", inFigcaption);
ok("docText does NOT contain the skipped <pre>", !drive.docText.includes("const skipMe"));
ok("docText does NOT contain the skipped figcaption", !drive.docText.includes("skip me too"));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function sameRanges(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.ds === b[i].ds && x.de === b[i].de);
}
function rangeDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x || !y) return "index " + i + ": one side ran out";
    if (x.ds !== y.ds || x.de !== y.de) {
      return "index " + i + ": reader [" + x.ds + "," + x.de + ") chunker [" + y.ds + "," + y.de + ")";
    }
  }
  return "";
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return "first differs at " + i + ": " + JSON.stringify(a.slice(Math.max(0, i - 20), i + 20)) +
             " vs " + JSON.stringify(b.slice(Math.max(0, i - 20), i + 20));
    }
  }
  return a.length === b.length ? "" : "same prefix, lengths differ (" + a.length + " vs " + b.length + ")";
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

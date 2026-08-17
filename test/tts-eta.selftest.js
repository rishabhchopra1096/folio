/*
 * Tests the time-remaining estimate in js/tts.js.
 *
 * The estimate is simply (words remaining) / (WPM x rate). The properties that
 * matter are that it counts DOWN monotonically as you advance and scales
 * inversely with speed — an earlier measured-pace version failed both, which is
 * why they're pinned here.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

// 30 paragraphs of known word counts.
const paras = [];
for (let i = 0; i < 30; i++) {
  paras.push(`<p>This is paragraph number ${i} of the test document. ` +
             `It contains a couple of sentences so the chunker has something to work with. ` +
             `Here is one more sentence to pad the length out a little further.</p>`);
}
const dom = new JSDOM(`<!doctype html><body><div id="article">${paras.join("")}</div></body>`);

global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined;
global.speechSynthesis = undefined;

const store = { settings: {} };
global.FolioStore = {
  getSettings: () => JSON.parse(JSON.stringify(store.settings)),
  saveSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
};

const src = fs.readFileSync(path.join(REPO, "js/tts.js"), "utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get docText(){return docText;}, get wordStarts(){return wordStarts;}, " +
  "remainingSeconds, formatDuration, wordsRemainingFrom, currentOffset, " +
  "setCur: (p)=>{curWord={ds:p,de:p+4};}, setRate: (r)=>{rate=r;}, WPM_AT_1X }),\n    init, attach, detach,"
);
const TTS = eval(src + "; TTS;");
TTS.attach("d");
const I = TTS.__i();

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

const totalWords = I.wordStarts.length;
console.log("\ndocText:", I.docText.length, "chars,", totalWords, "words indexed");

console.log("\n=== word index ===");
const naive = I.docText.split(/\s+/).filter(Boolean).length;
ok("word count matches a naive split", totalWords === naive, `${totalWords} vs ${naive}`);
ok("word starts are strictly increasing",
   I.wordStarts.every((v, i) => i === 0 || v > I.wordStarts[i - 1]));
ok("every word start is a non-space char",
   I.wordStarts.every((p) => /\S/.test(I.docText[p])));

console.log("\n=== formatDuration ===");
ok('0.5s -> "done"',         I.formatDuration(0.5) === "done",         I.formatDuration(0.5));
ok('20s -> "<1 min left"',   I.formatDuration(20) === "<1 min left",  I.formatDuration(20));
ok('300s -> "5 min left"',   I.formatDuration(300) === "5 min left",  I.formatDuration(300));
ok('3600s -> "1h left"',     I.formatDuration(3600) === "1h left",    I.formatDuration(3600));
ok('4500s -> "1h 15m left"', I.formatDuration(4500) === "1h 15m left",I.formatDuration(4500));

console.log("\n=== the estimate is exactly words / (WPM x rate) ===");
I.setRate(1); I.setCur(0);
const expected = (totalWords / I.WPM_AT_1X) * 60;
ok("matches the formula at offset 0", approx(I.remainingSeconds(), expected, 0.001),
   `${I.remainingSeconds().toFixed(2)} vs ${expected.toFixed(2)}`);

console.log("\n=== MONOTONIC: never increases as you advance ===");
// This is the property the previous measured-pace version violated 1977 times.
I.setRate(1);
let prev = Infinity, increases = 0, worst = 0;
for (const p of I.wordStarts) {
  I.setCur(p);
  const s = I.remainingSeconds();
  if (s > prev + 1e-9) { increases++; worst = Math.max(worst, s - prev); }
  prev = s;
}
ok("zero increases across every word in the document", increases === 0,
   `${increases} increases, worst +${worst.toFixed(2)}s`);

console.log("\n=== displayed minutes never tick upward ===");
I.setRate(1);
let prevMin = Infinity, upTicks = 0;
for (const p of I.wordStarts) {
  I.setCur(p);
  const m = Math.round(I.remainingSeconds() / 60);
  if (m > prevMin) upTicks++;
  prevMin = m;
}
ok("zero upward minute ticks", upTicks === 0, String(upTicks));

console.log("\n=== scales inversely with rate ===");
I.setCur(0);
I.setRate(1);    const t1 = I.remainingSeconds();
I.setRate(2);    const t2 = I.remainingSeconds();
I.setRate(3);    const t3 = I.remainingSeconds();
I.setRate(0.75); const t075 = I.remainingSeconds();
ok("2x is exactly half of 1x",     approx(t2, t1 / 2, 1e-9),   `${t2.toFixed(3)} vs ${(t1/2).toFixed(3)}`);
ok("3x is exactly a third of 1x",  approx(t3, t1 / 3, 1e-9),   `${t3.toFixed(3)} vs ${(t1/3).toFixed(3)}`);
ok("0.75x is exactly 1/0.75 of 1x",approx(t075, t1 / 0.75, 1e-9));

console.log("\n=== rate change is instantaneous, no warm-up ===");
// Same position, two rates, read back-to-back: the ratio must be exact with no
// convergence period.
I.setCur(Math.floor(I.docText.length / 2));
I.setRate(1);   const h1 = I.remainingSeconds();
I.setRate(2);   const h2 = I.remainingSeconds();
I.setRate(1);   const h3 = I.remainingSeconds();
ok("halving then restoring returns the same value", approx(h1, h3, 1e-9),
   `${h1.toFixed(3)} vs ${h3.toFixed(3)}`);
ok("2x reading is half immediately", approx(h2, h1 / 2, 1e-9));

console.log("\n=== boundaries ===");
I.setRate(1);
I.setCur(0);
ok("at the start, all words remain", I.wordsRemainingFrom(0) === totalWords,
   `${I.wordsRemainingFrom(0)} vs ${totalWords}`);
I.setCur(I.docText.length);
ok("past the end, zero remain", I.wordsRemainingFrom(I.docText.length) === 0,
   String(I.wordsRemainingFrom(I.docText.length)));
ok('past the end reads "done"', I.formatDuration(I.remainingSeconds()) === "done",
   I.formatDuration(I.remainingSeconds()));
I.setCur(I.wordStarts[totalWords - 1]);
ok("on the last word, exactly one remains", I.wordsRemainingFrom(I.wordStarts[totalWords-1]) === 1,
   String(I.wordsRemainingFrom(I.wordStarts[totalWords-1])));

console.log("\n=== halfway through is roughly half the time ===");
I.setRate(1);
I.setCur(I.wordStarts[Math.floor(totalWords / 2)]);
const half = I.remainingSeconds();
I.setCur(0);
const full = I.remainingSeconds();
ok("midpoint is ~half", approx(half, full / 2, full * 0.02),
   `${half.toFixed(1)} vs ${(full/2).toFixed(1)}`);

console.log("\n=== no leftover measurement state persisted ===");
ok("nothing written to settings by estimating",
   !store.settings.ttsCpsByVoice, JSON.stringify(store.settings));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

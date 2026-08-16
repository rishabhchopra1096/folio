/*
 * Tests the time-remaining estimator in js/tts.js.
 *
 * The estimate must (a) shrink as you move through the document, (b) halve
 * when you double the speed, and (c) converge on the voice's real pace rather
 * than the seeded guess.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

// ~6000 characters of prose across 30 paragraphs.
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
global.performance = { now: () => fakeNow };
let fakeNow = 0;

const store = { settings: {} };
global.FolioStore = {
  getSettings: () => JSON.parse(JSON.stringify(store.settings)),
  saveSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
};

const src = fs.readFileSync(path.join(REPO, "js/tts.js"), "utf8");
const probeSrc = src.replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ docText, chunks, remainingSeconds, formatDuration, " +
  "startMeasure, updateMeasure, currentOffset, get cps(){return cpsAt1x;}, " +
  "setCur: (p)=>{curWord={ds:p,de:p+4};}, setRate: (r)=>{rate=r;}, " +
  "setVoice: (v)=>{selectedVoice=v;} }),\n    init, attach, detach,"
);
const TTS = eval(probeSrc + "; TTS;");
TTS.attach("d");
const I = TTS.__i();

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\ndocText length:", I.docText.length, " chunks:", I.chunks.length);

console.log("\n=== formatDuration ===");
ok('0.5s -> "done"',        I.formatDuration(0.5) === "done",        I.formatDuration(0.5));
ok('20s -> "<1 min left"',  I.formatDuration(20) === "<1 min left",  I.formatDuration(20));
ok('300s -> "5 min left"',  I.formatDuration(300) === "5 min left",  I.formatDuration(300));
ok('3600s -> "1h left"',    I.formatDuration(3600) === "1h left",    I.formatDuration(3600));
ok('4500s -> "1h 15m left"',I.formatDuration(4500) === "1h 15m left",I.formatDuration(4500));

console.log("\n=== estimate shrinks as you advance ===");
I.setRate(1);
I.setCur(0);
const atStart = I.remainingSeconds();
I.setCur(Math.floor(I.docText.length / 2));
const atHalf = I.remainingSeconds();
I.setCur(I.docText.length - 10);
const atEnd = I.remainingSeconds();
ok("start > half > end", atStart > atHalf && atHalf > atEnd,
   `${atStart.toFixed(1)} / ${atHalf.toFixed(1)} / ${atEnd.toFixed(1)}`);
ok("halfway is ~half of start", approx(atHalf, atStart / 2, atStart * 0.02),
   `half=${atHalf.toFixed(1)} vs start/2=${(atStart/2).toFixed(1)}`);

console.log("\n=== estimate scales inversely with rate ===");
I.setCur(0);
I.setRate(1);   const t1 = I.remainingSeconds();
I.setRate(2);   const t2 = I.remainingSeconds();
I.setRate(3);   const t3 = I.remainingSeconds();
I.setRate(0.75);const t075 = I.remainingSeconds();
ok("2x is half of 1x",    approx(t2, t1 / 2, 0.01),    `${t2.toFixed(2)} vs ${(t1/2).toFixed(2)}`);
ok("3x is a third of 1x", approx(t3, t1 / 3, 0.01),    `${t3.toFixed(2)} vs ${(t1/3).toFixed(2)}`);
ok("0.75x is slower",     t075 > t1,                    `${t075.toFixed(2)} vs ${t1.toFixed(2)}`);

console.log("\n=== pace measurement converges on the real voice speed ===");
I.setVoice({ name: "TestVoice" });
I.setRate(1);
const seeded = I.cps;
// Simulate a voice that really does 25 chars/sec at 1x.
const TRUE_CPS = 25;
fakeNow = 0;
I.startMeasure(0);
let off = 0;
for (let step = 0; step < 40; step++) {
  off += 50;                       // 50 characters consumed...
  fakeNow += (50 / TRUE_CPS) * 1000; // ...in the time a 25 cps voice would take
  I.updateMeasure(off);
}
ok("seed was the default 15.5", approx(seeded, 15.5, 0.01), String(seeded));
ok("converged near the true 25 cps", approx(I.cps, TRUE_CPS, 1.0), I.cps.toFixed(2));

console.log("\n=== measured pace persists per voice ===");
ok("saved under the voice name",
   store.settings.ttsCpsByVoice && approx(store.settings.ttsCpsByVoice.TestVoice, TRUE_CPS, 1.0),
   JSON.stringify(store.settings.ttsCpsByVoice));

console.log("\n=== a faster measured pace shortens the estimate ===");
I.setCur(0); I.setRate(1);
const afterLearning = I.remainingSeconds();
ok("estimate dropped vs the 15.5 seed", afterLearning < t1,
   `${afterLearning.toFixed(1)} vs ${t1.toFixed(1)}`);
ok("matches chars/trueCps", approx(afterLearning, I.docText.length / TRUE_CPS, I.docText.length * 0.03),
   `${afterLearning.toFixed(1)} vs ${(I.docText.length/TRUE_CPS).toFixed(1)}`);

console.log("\n=== short windows are ignored ===");
const before = I.cps;
fakeNow = 0; I.startMeasure(0);
fakeNow = 500;               // only 0.5s — below MEASURE_MIN_SECONDS
I.updateMeasure(9999);       // absurd pace that must not be absorbed
ok("sub-1.5s window ignored", approx(I.cps, before, 0.001), `${before} -> ${I.cps}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

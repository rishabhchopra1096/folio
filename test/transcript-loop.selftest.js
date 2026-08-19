/* The repetition-loop detector, and the duration backstop behind it.

   Grounded in a real failure: a 52:37 Pokemon video came back with transcript
   lines stamped up to 1:21:01 — 28 minutes of invented content — because the
   model fell into a 9-segment verbatim cycle at ~7:42 and rode it to the token
   cap. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
const Gemini = eval(fs.readFileSync(REPO + "/js/gemini.js", "utf8") + "; Gemini;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

/* The cycle that actually happened, verbatim. */
const CYCLE = [
  "All right, Nidoran was caught.",
  "[shows] 'New Pokédex data will be added for Nidoran♂!' The Pokédex entry is displayed.",
  "Excellent. No nickname. So actually, I need to catch two of these because I'm going to use one on my team.",
  "So I'm actually going to catch this one as well.",
  "[shows] The player selects 'FIGHT' and then 'GUST'.",
  "Wow, critical hit. All right.",
  "I'll do one more Gust here. Hopefully that doesn't critical and kill him.",
  "I might die.",
  "[shows] The player selects 'Poké Ball'.",
];

// Feed a watcher and report where (if anywhere) it called a loop.
function run(texts) {
  const w = Gemini._newLoopWatch();
  for (let i = 0; i < texts.length; i++) {
    if (w.note(texts[i])) return { fired: true, at: w.startedAt, i: i };
  }
  return { fired: false, at: -1, i: -1 };
}

console.log("\n=== it catches the loop that actually happened ===");
const real = [
  "Welcome back everybody to more Pokémon Red.",
  "Did a lot in the last episode.",
  "So the first thing I'm going to do is buy some Poké Balls.",
].concat(Array.from({ length: 20 }, () => CYCLE).flat());
const r = run(real);
ok("fires on the repeated cycle", r.fired);
ok("keeps the genuine opening", r.at >= 3, "cut at " + r.at);
ok("cuts at the first repeat, not later", r.at === 3 + CYCLE.length,
   "cut at " + r.at + ", expected " + (3 + CYCLE.length));
ok("stops within three cycles, not twenty",
   r.i < 3 + CYCLE.length * 3, "fired at segment " + r.i);

console.log("\n=== a single pass through the same lines is NOT a loop ===");
ok("one pass is fine", !run(["intro"].concat(CYCLE)).fired);
ok("two passes still under threshold is fine",
   Gemini._LOOP_RUN > CYCLE.length,
   "threshold " + Gemini._LOOP_RUN + " vs cycle " + CYCLE.length);

console.log("\n=== it does NOT fire on genuine repetition ===");
/* This is the trap. The naive test — "how many segments in a row have I seen
   before?" — false positives on exactly this content, because a Pokemon
   playthrough really does say these things over and over. What makes the real
   loop different is that the lines repeat IN THE SAME ORDER. */
const stock = ["Wow, critical hit. All right.", "I might die.",
               "[shows] The player selects 'Poké Ball'.", "All right, Nidoran was caught."];
const organic = [];
for (let i = 0; i < 60; i++) {
  organic.push(stock[i % stock.length]);
  organic.push("Now something genuinely new happens, number " + i + ".");
}
ok("stock phrases interleaved with new lines never fire", !run(organic).fired);

/* Genuinely aperiodic order, via a small LCG. (An earlier version of this test
   used (i*7+3)%4, which is itself a strict 4-cycle — so the detector fired and
   was right to. The test was wrong, not the detector.)

   Use mulberry32, not a textbook LCG: `seed * 1103515245` exceeds 2^53 in
   JavaScript, so the low bits are lost and the sequence collapses to a
   constant — which fed the detector 200 identical lines and fired it, exactly
   as it should have. Also the test's fault, not the code's. */
const shuffled = [];
let seed = 12345;
const rnd = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0);
};
for (let i = 0; i < 200; i++) shuffled.push(stock[rnd() % stock.length]);
ok("the same few lines in genuinely VARYING order never fire", !run(shuffled).fired);

/* But a fixed rotation with nothing new ever said IS a loop, and should fire —
   that is a model stuck, not a person talking. */
const rotation = [];
for (let i = 0; i < 40; i++) rotation.push(stock[i % stock.length]);
ok("a strict rotation with nothing new does fire", run(rotation).fired);

// A chorus repeated with a verse between it is legitimate.
const chorus = ["line one of the chorus", "line two of the chorus",
                "line three of the chorus", "line four of the chorus",
                "line five of the chorus", "line six of the chorus"];
const song = [].concat(
  ["verse one a", "verse one b", "verse one c"], chorus,
  ["verse two a", "verse two b", "verse two c"], chorus,
  ["verse three a", "verse three b"], chorus);
ok("a repeated chorus is not a loop", !run(song).fired);

console.log("\n=== the detector is wrap-aware ===");
/* Without wrap handling the run resets every time the cycle restarts, so it
   can never exceed the cycle length and a short cycle is never caught. */
const shortCycle = ["aaa", "bbb", "ccc"];
const shortLoop = Array.from({ length: 30 }, () => shortCycle).flat();
const sr = run(shortLoop);
ok("a 3-segment cycle is still caught", sr.fired,
   "a run capped at cycle length would never reach " + Gemini._LOOP_RUN);
ok("and it cuts at the first repeat", sr.at === shortCycle.length, "cut at " + sr.at);

console.log("\n=== blank and odd input don't confuse it ===");
ok("all-blank never fires", !run(["", "  ", "", "   ", ""]).fired);
ok("case and spacing differences still count as repeats",
   run(["x"].concat(Array.from({ length: 30 },
     (_, i) => i % 2 ? "HELLO   THERE" : "hello there")).map(String)).fired);

console.log("\n=== the stream actually stops when it fires ===");
const gsrc = fs.readFileSync(REPO + "/js/gemini.js", "utf8");
ok("detector is wired into the parse loop", /if \(loop\.note\(seg\.text\)\)/.test(gsrc));
ok("it breaks out of the read loop", /if \(loopedAt >= 0\) break;/.test(gsrc));
ok("the repeated tail is trimmed off", /segments\.length = Math\.max\(0, loopedAt\)/.test(gsrc));
ok("the download is cancelled, not left running", /await reader\.cancel\(\)/.test(gsrc));
ok("the trailing partial line is NOT re-added after trimming",
   /loopedAt >= 0 \? null : parseJsonlLine\(textBuf\)/.test(gsrc));
ok("the user is told why it stopped", /began repeating itself/.test(gsrc));

console.log("\n=== duration backstop in video.js ===");
const vsrc = fs.readFileSync(REPO + "/js/video.js", "utf8");
const trimSrc = vsrc.match(/function trimToDuration\(segments\) \{[\s\S]*?\n  \}/)[0];
let DUR = 3157;                                  // the real video: 52:37
const trimToDuration = eval(
  "(function(){ function videoDuration(){ return DUR; } " + trimSrc + " return trimToDuration; })()");

const segs = [{ start: 0 }, { start: 462 }, { start: 3100 }, { start: 3200 }, { start: 4861 }];
ok("drops lines stamped past the end", trimToDuration(segs).length === 3,
   JSON.stringify(trimToDuration(segs)));
ok("keeps the last real line", trimToDuration(segs).slice(-1)[0].start === 3100);
ok("allows a little slack for rounding",
   trimToDuration([{ start: 3157 }, { start: 3159 }]).length === 2);

DUR = 0;                                          // player not ready yet
ok("changes nothing when the duration is unknown",
   trimToDuration(segs).length === segs.length);
DUR = 3157;
ok("an empty transcript stays empty", trimToDuration([]).length === 0);
ok("an entirely-invented transcript trims to nothing",
   trimToDuration([{ start: 4000 }, { start: 4861 }]).length === 0);

console.log("\n=== seeks are clamped to the video ===");
ok("clampToVideo exists", /function clampToVideo/.test(vsrc));
ok("nudge goes through it", /player\.seekTo\(clampToVideo\(/.test(vsrc));
ok("a line past the end falls back to a time nudge",
   /if \(dur && segTimes\[i\] > dur\)/.test(vsrc));
ok("the streaming write trims too", /segments = trimToDuration\(segments\);/.test(vsrc));

console.log("\n=== the speed probe that broke playback is gone ===");
ok("no refused-rate blacklist", !/refusedSpeeds/.test(vsrc));
ok("no immediate readback after set", !/Math\.abs\(got - rate\)/.test(vsrc));
ok("no runtime ladder discovery", !/getAvailablePlaybackRates/.test(vsrc));
ok("the ladder is a plain constant", /const SPEEDS = \[0\.75, 1, 1\.25, 1\.5, 1\.75, 2\];/.test(vsrc));
ok("the measurement is still recorded for whoever tries next",
   /setPlaybackRate\(3\)\s*->\s*2\s*ignored/.test(vsrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

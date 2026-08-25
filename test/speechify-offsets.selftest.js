/*
 * The bug this pins: speech-mark offsets are UNICODE CODE POINTS, and every
 * instinct in JavaScript says to use them with slice(), which is UTF-16.
 *
 * The marks below are not invented. They are the exact response the live API
 * gave for this exact string on 24 Aug 2026 (techDocs/speechify-phase0-measured.md).
 * Read straight through slice() they yield " brav" where the word is "bravo" —
 * off by one per preceding astral character, compounding down the page. On the
 * user's own sample_docs/md.md, which holds 119 emoji, the drift reaches ~1,830
 * characters by the end.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.Audio = function () { return {}; };
global.fetch = () => Promise.reject(new Error("no network in unit tests"));
global.atob = (b) => Buffer.from(b, "base64").toString("binary");
global.Blob = dom.window.Blob;
global.URL = dom.window.URL;

const S = eval(fs.readFileSync(REPO + "/js/speechify.js", "utf8") + "; SpeechifyProvider;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

/* ── The real string and the real marks it produced ───────────────────────── */
const TEXT = "Alpha 🎨 bravo charlie. Delta echo foxtrot golf.";
const LIVE_MARKS = [
  { start: 0,  end: 5,  start_time: 0,    end_time: 597,  value: "Alpha" },
  { start: 8,  end: 13, start_time: 597,  end_time: 1024, value: "bravo" },
  { start: 14, end: 22, start_time: 1024, end_time: 1963, value: "charlie." },
  { start: 23, end: 28, start_time: 1963, end_time: 2432, value: "Delta" },
  { start: 29, end: 33, start_time: 2432, end_time: 2816, value: "echo" },
  { start: 34, end: 41, start_time: 2816, end_time: 3413, value: "foxtrot" },
  { start: 42, end: 47, start_time: 3413, end_time: 4100, value: "golf." },
];

console.log("\n=== the naive reading is wrong, and that is the whole point ===");
{
  const naive = LIVE_MARKS.map((m) => TEXT.slice(m.start, m.end));
  // Only "Alpha" precedes the emoji, so only "Alpha" survives a naive read.
  ok("slice() is right only for the word before the emoji",
     naive[0] === LIVE_MARKS[0].value, JSON.stringify(naive[0]));
  ok("and wrong for every single word after it",
     naive.slice(1).every((v, i) => v !== LIVE_MARKS[i + 1].value),
     JSON.stringify(naive));
  ok("and it is wrong in the sneaky way — plausible, not empty",
     TEXT.slice(8, 13) === " brav", JSON.stringify(TEXT.slice(8, 13)));
}

console.log("\n=== the conversion fixes every one of them ===");
{
  const map = S._codePointToUtf16Map(TEXT);
  const got = LIVE_MARKS.map((m) => TEXT.slice(map[m.start], map[m.end]));
  ok("every mark now yields exactly the word the API named",
     got.every((v, i) => v === LIVE_MARKS[i].value), JSON.stringify(got));
  ok("the map has one entry per code point, plus an end sentinel",
     map.length === [...TEXT].length + 1, `${map.length} vs ${[...TEXT].length + 1}`);
  ok("the sentinel is the full UTF-16 length",
     map[map.length - 1] === TEXT.length, `${map[map.length - 1]} vs ${TEXT.length}`);
  ok("offsets before the emoji are unchanged (which is why a naive test passes)",
     map[0] === 0 && map[5] === 5);
  ok("offsets after it are shifted by exactly one surrogate",
     map[8] === 9 && map[13] === 14, `${map[8]}, ${map[13]}`);
}

console.log("\n=== plain ASCII must be a no-op, not a shift ===");
{
  const plain = "The quick brown fox jumps.";
  const map = S._codePointToUtf16Map(plain);
  ok("every index maps to itself",
     [...plain].every((_, i) => map[i] === i));
}

console.log("\n=== several astral characters accumulate ===");
{
  const t = "a 🎨 b 🚀 c 🎉 d";
  const map = S._codePointToUtf16Map(t);
  const cps = [...t];
  ok("the last real character still round-trips",
     t.slice(map[cps.length - 1], map[cps.length]) === cps[cps.length - 1],
     JSON.stringify(t.slice(map[cps.length - 1], map[cps.length])));
  ok("total drift equals the number of surrogate pairs",
     map[cps.length] - cps.length === 3, String(map[cps.length] - cps.length));
}

console.log("\n=== splitting a chunk so sound starts sooner ===");
{
  const short = "Just one short sentence.";
  ok("short text is not split at all", S._splitHead(short).length === 1);

  const long = "The first sentence is here and it is a reasonable length. "
    + "The second sentence follows it directly. "
    + "A third sentence continues the paragraph well past the head budget. "
    + "And a fourth keeps going for good measure.";
  const parts = S._splitHead(long);
  ok("long text splits in two", parts.length === 2, String(parts.length));
  ok("the halves reassemble exactly", parts.join("") === long);
  ok("the head is small enough to arrive quickly",
     parts[0].length <= 180, String(parts[0].length));
  ok("the head is not so small it is pointless",
     parts[0].length >= 30, String(parts[0].length));
  ok("the seam lands after a sentence, where a pause belongs",
     /[.!?]["')\]]?\s*$/.test(parts[0]), JSON.stringify(parts[0].slice(-14)));

  const noPunct = "word ".repeat(80);
  const p2 = S._splitHead(noPunct);
  ok("text with no sentence end still splits, on a space",
     p2.length === 2 && p2.join("") === noPunct && /\s$/.test(p2[0]),
     JSON.stringify(p2[0].slice(-8)));
}

console.log("\n=== finding the spoken word at a moment ===");
{
  const marks = LIVE_MARKS.map((m) => ({ t0: m.start_time, t1: m.end_time, cs: 0, ce: 0 }));
  ok("before the first word, nothing is current", S._markAt(marks, -1) === -1);
  ok("at exactly zero, the first word is current", S._markAt(marks, 0) === 0);
  ok("mid-word picks that word", S._markAt(marks, 800) === 1, String(S._markAt(marks, 800)));
  ok("on a boundary picks the word that is starting",
     S._markAt(marks, 1024) === 2, String(S._markAt(marks, 1024)));
  ok("past the end stays on the last word",
     S._markAt(marks, 99999) === marks.length - 1);
  ok("an empty mark list does not throw", S._markAt([], 500) === -1);

  /*
   * Searched fresh rather than advanced, so a seek backwards is not a special
   * case — it simply returns the right answer on the next frame.
   */
  ok("seeking backwards needs no special handling",
     S._markAt(marks, 3500) === 6 && S._markAt(marks, 700) === 1);
}

console.log("\n=== the provider satisfies the interface tts.js calls ===");
{
  ["id", "label", "needsKey", "available", "voices", "defaultVoice", "speak"]
    .forEach((k) => ok(`has ${k}`, S[k] !== undefined));
  ok("it is not available without a key", S.available() === false);
  ok("all eight simba-3.2 voices are offered", S.voices().length === 8,
     String(S.voices().length));
  ok("voices carry the fields the settings list reads",
     S.voices().every((v) => v.id && v.name && v.lang));
  ok("a default voice is always available", !!S.defaultVoice());
}

console.log("\n=== the key never leaks into the module ===");
{
  const src = fs.readFileSync(REPO + "/js/speechify.js", "utf8");
  ok("no API key is hardcoded", !/sk_[A-Za-z0-9]{20,}/.test(src));
  ok("the key is read from localStorage", /folio_speechify_key/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

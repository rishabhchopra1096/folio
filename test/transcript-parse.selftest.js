/* Transcript intake: turning timestamped text into lines Folio can anchor to.

   Folio could already RENDER a timed transcript — a paragraph block carrying
   data.t drives sync, click-to-seek and comment anchoring — but had no way to
   CREATE those blocks from text. That gap is why a transcript with real
   timings could not be brought in, and why the model was left inventing
   timestamps it demonstrably cannot work out. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const NARR = "/Users/rishabhchopra/Documents/GitHub/youtube-storyboard-extractor/narratives";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
global.Gemini = { formatTime: (s) => String(s) };
global.FolioStore = { getSettings: () => ({}), saveSettings: () => {} };
global.Reader = { getCurrentDocId: () => null };
const Video = eval(fs.readFileSync(REPO + "/js/video.js", "utf8") + "; Video;");
const P = Video.parseTranscript;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

console.log("\n=== the shape Folio and the batch script write ===");
let r = P("**[0:06]** The intro plays.\n\n**[1:30]** The player enters a building.");
ok("two lines", r.length === 2, JSON.stringify(r));
ok("0:06 -> 6s", r[0].t === 6);
ok("1:30 -> 90s", r[1].t === 90);
ok("text kept without the marker", r[0].text === "The intro plays.", r[0].text);

console.log("\n=== the same without markdown ===");
r = P("[0:06] one\n[1:30] two");
ok("still parses", r.length === 2 && r[0].t === 6 && r[1].t === 90);

console.log("\n=== hours ===");
r = P("[1:02:03] late in a long video");
ok("1:02:03 -> 3723s", r[0].t === 3723, String(r[0] && r[0].t));

console.log("\n=== YouTube's \"Show transcript\" panel copy ===");
/* The panel writes the timestamp straight into its accessibility label, so
   "0:03" + "3 seconds" + text arrives as one run of characters. */
r = P("0:033 seconds[Music]\n0:1010 secondswelcome back to more Pokemon Red\n" +
      "1:041 minute, 4 secondsthe passengers are restless");
ok("three cues", r.length === 3, JSON.stringify(r.map((x) => x.t)));
ok("0:03 read correctly", r[0].t === 3, String(r[0].t));
ok("0:10 read correctly", r[1].t === 10, String(r[1].t));
ok("1:04 read correctly, past the 'minute' label", r[2].t === 64, String(r[2].t));
ok("the duration label is stripped from the text",
   r[1].text === "welcome back to more Pokemon Red", r[1].text);
ok("bracketed sound cues survive", r[0].text === "[Music]", r[0].text);

console.log("\n=== a timestamp on its own line, text below ===");
r = P("0:15\nThe player opens the menu.\nIt shows six slots.\n\n0:30\nNext thing.");
ok("two entries", r.length === 2, JSON.stringify(r.map((x) => x.t)));
ok("wrapped lines are joined", r[0].text === "The player opens the menu. It shows six slots.", r[0].text);

console.log("\n=== tidying ===");
r = P("# A heading\nsome preamble\n\n[0:10] real content");
ok("text before the first timestamp is dropped", r.length === 1 && r[0].text === "real content");
r = P("[2:00] later\n[1:00] earlier");
ok("out-of-order input is sorted", r[0].t === 60 && r[1].t === 120);
r = P("[1:00] first half\n[1:00] second half");
ok("a repeated timestamp merges", r.length === 1 && /first half second half/.test(r[0].text));
ok("empty input is empty", P("").length === 0 && P(null).length === 0);
ok("text with no timestamps yields nothing", P("just some prose\nand more").length === 0);

console.log("\n=== every one of the 36 real narrative files ===");
const files = fs.readdirSync(NARR).filter((f) => f.endsWith(".md")).sort();
ok("all 36 present", files.length === 36, String(files.length));
let totalLines = 0, worst = null;
for (const f of files) {
  const raw = fs.readFileSync(path.join(NARR, f), "utf8");
  const segs = P(raw);
  totalLines += segs.length;
  const mono = segs.every((s, i) => i === 0 || s.t >= segs[i - 1].t);
  const sane = segs.every((s) => s.text.length > 20 && !/^\*\*/.test(s.text));
  if (!segs.length || !mono || !sane) worst = f + " (" + segs.length + " lines)";
}
ok("every file parses to lines, in order, with clean text", !worst, worst || "");
ok("total lines match what was generated", totalLines > 3000, String(totalLines));

// The header must not become a transcript line.
const one = P(fs.readFileSync(path.join(NARR, files[0]), "utf8"));
ok("the title and metadata are not treated as content",
   !one.some((s) => /^Episode \d|watch\]|entries ·/.test(s.text)),
   (one.find((s) => /Episode \d|watch\]/.test(s.text)) || {}).text || "");
ok("first line starts at the video's first moment", one[0].t < 60, String(one[0].t));

console.log("\n=== real captions, straight from yt-dlp, round-trip ===");
/* Proves the parser handles the OTHER end of the pipeline too: a caption file
   rendered as text and read back must keep its timings exactly. */
const capFile = fs.readdirSync("/tmp").find((f) => /^cap_.*\.en\.json3$/.test(f));
if (capFile) {
  const cap = JSON.parse(fs.readFileSync("/tmp/" + capFile, "utf8"));
  const cues = [];
  for (const e of cap.events || []) {
    if (!e.segs) continue;
    const t = Math.round((e.tStartMs || 0) / 1000);
    const txt = e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (txt && txt !== "[Music]") cues.push({ t, txt });
  }
  const asText = cues.map((c) => {
    const m = Math.floor(c.t / 60), s = c.t % 60;
    return `[${m}:${String(s).padStart(2, "0")}] ${c.txt}`;
  }).join("\n");
  const back = P(asText);
  const expected = [];
  for (const c of cues) {
    const last = expected[expected.length - 1];
    if (last && last.t === c.t) { last.txt += " " + c.txt; continue; }
    expected.push({ t: c.t, txt: c.txt });
  }
  ok("caption count survives the round trip", back.length === expected.length,
     `${back.length} vs ${expected.length}`);
  ok("every timestamp is preserved exactly",
     back.every((b, i) => b.t === expected[i].t));
} else {
  ok("caption fixture available", false, "no /tmp/cap_*.en.json3");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

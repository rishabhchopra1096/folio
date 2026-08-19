/* Where a comment lands in the exported transcript.

   The regression this pins: the export used to find a comment's line by
   matching the highlight's TEXT and taking the first line that matched. On a
   transcript where the model looped, the same sentence appears dozens of
   times, so notes recorded at 20:14 and 25:32 were both filed under the copy
   at 6:50 — while the comments panel, which reads videoTime, showed the truth.

   A comment now goes where it was SPOKEN. */
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
global.Gemini = { formatTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` };
global.Voice = { hasKey: () => false };

/* The looping line, exactly as it came back — at three different timestamps. */
const LOOP = "Excellent. No nickname. So actually, I need to catch two of these.";
const blocks = [
  { type: "video", data: { videoId: "TJgg3eMUp7M", url: "https://www.youtube.com/watch?v=TJgg3eMUp7M" } },
  { type: "paragraph", data: { text: "Welcome back everybody to more Pokémon Red.", t: 10 } },
  { type: "paragraph", data: { text: LOOP, t: 410 } },    // 6:50  — first copy
  { type: "paragraph", data: { text: "So I'm actually going to catch this one as well.", t: 419 } },
  { type: "paragraph", data: { text: LOOP, t: 1214 } },   // 20:14 — where one note belongs
  { type: "paragraph", data: { text: "So I'm actually going to catch this one as well.", t: 1223 } },
  { type: "paragraph", data: { text: LOOP, t: 1532 } },   // 25:32 — where the other belongs
];
const highlights = [
  { id: "hl_1", text: LOOP },
  { id: "hl_2", text: LOOP },
  { id: "hl_plain", text: "Welcome back everybody to more Pokémon Red." },
];
const comments = [
  { id: "c_mech", highlightId: "hl_1", videoTime: 1214,
    text: "There are different game mechanics. Every time I spot one I'll talk about it.",
    createdAt: "2026-08-19T10:00:00Z" },
  { id: "c_grind", highlightId: "hl_2", videoTime: 1532,
    text: "Another game mechanic is the grind. What is our grind?",
    createdAt: "2026-08-19T10:05:00Z" },
  // No timestamp — must still fall back to matching on text.
  { id: "c_old", highlightId: "hl_plain",
    text: "An older note with no timestamp.", createdAt: "2026-08-19T09:00:00Z" },
  // Recorded before the transcript existed, never attached to a highlight.
  { id: "c_pending", highlightId: null, isGeneral: true, videoTime: 419,
    text: "Dictated while the transcript was still streaming.", createdAt: "2026-08-19T09:30:00Z" },
];

global.FolioStore = {
  getSettings: () => ({}), saveSettings: () => {},
  getDocument: () => ({ meta: { title: "Pokémon Red" }, content: { blocks } }),
  getHighlights: () => highlights, getComments: () => comments,
  saveComments: () => {}, generateId: (p) => p + "_x",
};
global.Reader = { getCurrentDocId: () => "doc_v" };

let captured = "";
global.Blob = class { constructor(parts) { captured = parts[0]; } };
dom.window.URL.createObjectURL = () => "blob:x";
dom.window.URL.revokeObjectURL = () => {};
const realCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (tag === "a") el.click = () => {};
  return el;
};

const src = fs.readFileSync(REPO + "/js/comments.js", "utf8")
  .replace("  return {\n    init,", "  return {\n    __export: exportAnnotations,\n    init,");
const C = eval(src + "; Comments;");
C.__export();
const out = captured || "";

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

// Where does a given string sit relative to the three copies of the loop line?
const at = (s) => out.indexOf(s);
const i650 = at("**[6:50]**"), i2014 = at("**[20:14]**"), i2532 = at("**[25:32]**");

console.log("\n=== the transcript itself ===");
ok("all three copies of the looping line are present",
   i650 > -1 && i2014 > -1 && i2532 > -1, `${i650} ${i2014} ${i2532}`);
ok("they are in ascending order", i650 < i2014 && i2014 < i2532);

console.log("\n=== a note lands where it was SPOKEN, not on the first text match ===");
const iMech = at("There are different game mechanics");
const iGrind = at("Another game mechanic is the grind");
ok("the 20:14 note is after the 20:14 line", iMech > i2014, `${i2014} -> ${iMech}`);
ok("the 20:14 note is NOT filed under 6:50", iMech > i650 && iMech > i2014);
ok("the 20:14 note is before the 25:32 line", iMech < i2532, `${iMech} -> ${i2532}`);
ok("the 25:32 note is after the 25:32 line", iGrind > i2532, `${i2532} -> ${iGrind}`);

console.log("\n=== each note carries its own timestamp ===");
ok("the 20:14 note is stamped", /> 💬 \[20:14\] There are different game mechanics/.test(out));
ok("the 25:32 note is stamped", /> 💬 \[25:32\] Another game mechanic/.test(out));

console.log("\n=== a note taken before the transcript existed still lands ===");
const iPend = at("Dictated while the transcript was still streaming");
ok("placed on the line playing at the time", iPend > at("**[6:59]**"), String(iPend));
ok("and not left in the Notes pile",
   iPend > at("## Transcript"), `notes end ${at("## Transcript")}, note at ${iPend}`);

console.log("\n=== untimestamped notes still work by text ===");
ok("older note without a timestamp survives", /An older note with no timestamp/.test(out));
ok("it sits under its own line", at("An older note") > at("**[0:10]**"));
ok("and carries no invented stamp", !/💬 \[[\d:]+\] An older note/.test(out));

console.log("\n=== nothing is silently dropped ===");
comments.forEach((c) => {
  const head = c.text.slice(0, 22);
  ok("kept: " + head, out.indexOf(head) !== -1);
});

console.log("\n=== the moment is stored in the first place ===");
const csrc = fs.readFileSync(REPO + "/js/comments.js", "utf8");
ok("videoTime is no longer discarded when a highlight exists",
   !/isFinite\(videoTime\) && !highlightId/.test(csrc));
ok("it is stored whenever it is known",
   /typeof videoTime === "number" && isFinite\(videoTime\)\) \{/.test(csrc));
const tsrc = fs.readFileSync(REPO + "/js/tts.js", "utf8");
ok("the dictation path always asks the clock",
   !/if \(!highlightId && clockActive\(\)/.test(tsrc));
ok("the offline queue captures the moment at record time",
   /pending\.push\(\{ blob: blob, highlightId: highlightId, videoTime: at,/.test(tsrc));
ok("and passes it on when it finally uploads",
   /addComment\(item\.highlightId, text, item\.docId, item\.videoTime\)/.test(tsrc));
ok("reconciliation still only claims unattached notes", /!c\.highlightId\)/.test(csrc));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

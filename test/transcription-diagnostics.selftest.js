/* Transcription diagnostics: the log, the progress indicator, and resuming a
   run that a reload interrupted.

   The bug this pins: resumePending() decided a run was finished by asking "does
   the document have lines, and is the Transcribing… placeholder gone?" On a
   RETRY both are true — the old incomplete transcript is still on screen and no
   placeholder is ever inserted — so reloading during a retry threw the pending
   record away and abandoned the work silently. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

const gsrc = fs.readFileSync(REPO + "/js/gemini.js", "utf8");
const Gemini = eval(gsrc + "; Gemini;");

console.log("\n=== the log records, persists and stays bounded ===");
Gemini.clearLog();
ok("starts empty", Gemini.getLog().length === 0);
Gemini.log("request", { run: "r1", video: "abc", why: "retry" });
Gemini.log("done", { run: "r1", kept: 210, finish: "MAX_TOKENS" });
let entries = Gemini.getLog();
ok("records what happened", entries.length === 2, String(entries.length));
ok("keeps the event name", entries[0].ev === "request");
ok("keeps the fields", entries[1].kept === 210 && entries[1].finish === "MAX_TOKENS");
ok("stamps each entry", /^\d{4}-\d{2}-\d{2}T/.test(entries[0].t), entries[0].t);

ok("it is in localStorage, so it survives a reload",
   (localStorage.getItem("folio_gemini_log") || "").indexOf("MAX_TOKENS") !== -1);
// Prove it: a fresh module instance over the same storage sees the history.
const Gemini2 = eval(gsrc + "; Gemini;");
ok("a fresh page load can still read it", Gemini2.getLog().length === 2);

for (let i = 0; i < 600; i++) Gemini.log("progress", { run: "r2", segments: i });
const big = Gemini.getLog();
ok("ring-buffers rather than growing forever", big.length <= 400, String(big.length));
ok("keeps the NEWEST entries", big[big.length - 1].segments === 599);
ok("stays inside a sane byte budget",
   (localStorage.getItem("folio_gemini_log") || "").length <= 120000,
   String((localStorage.getItem("folio_gemini_log") || "").length));

console.log("\n=== the log never contains the API key ===");
// Assembled at runtime so this file never contains a literal that looks like
// a real Google key — the repo is public and gets secret-scanned.
const FAKE_KEY = "AIza" + "Sy" + "N0TAREALKEY".repeat(2) + "0123456789";
Gemini.setKey(FAKE_KEY);
Gemini.clearLog();
Gemini.log("request", { run: "r3", video: "abc" });
const dump = localStorage.getItem("folio_gemini_log") || "";
ok("no key in the log", dump.indexOf("AIzaSy") === -1);
ok("nothing logs a request body", !/JSON\.stringify\(body\)/.test(gsrc.split("function log(")[0]));
ok("the key header is never logged", !/log\([^)]*x-goog-api-key/.test(gsrc));
Gemini.clearKey();

console.log("\n=== formatted output is readable ===");
Gemini.clearLog();
Gemini.log("request", { run: "r4", video: "TJgg3eMUp7M", why: "retry" });
Gemini.log("loop", { run: "r4", detectedAt: 120, keeping: 84, discarding: 36 });
const txt = Gemini.formatLog();
ok("mentions the event", /request/.test(txt) && /loop/.test(txt));
ok("mentions the fields", /video=TJgg3eMUp7M/.test(txt) && /discarding=36/.test(txt));
ok("one entry per line", txt.split("\n").length === 2, String(txt.split("\n").length));
Gemini.clearLog();
ok("says so when empty", /No transcription activity/.test(Gemini.formatLog()));

console.log("\n=== every way a run can end is distinguishable ===");
[["request", "a run started"], ["http", "the HTTP response"], ["chunkdone", "each window"],
 ["chunkfailed", "a window that failed"],
 ["httperror", "a rejected request"], ["neterror", "a dead connection"],
 ["firstline", "time to first line"], ["progress", "where it got to"],
 ["finishreason", "why the model stopped"], ["loop", "a repetition loop"],
 ["trimmed", "lines past the end of the video"], ["streambroke", "a broken stream"],
 ["aborted", "an abandoned request"], ["done", "a completed run"],
 ["empty", "a run that produced nothing"], ["blocked", "a safety block"],
 ["resume", "a resumed run"], ["resume-gaveup", "giving up on a doomed run"],
].forEach(([ev, what]) => {
  const inG = new RegExp('log\\("' + ev + '"').test(gsrc);
  const inV = new RegExp('log\\("' + ev + '"').test(fs.readFileSync(REPO + "/js/video.js", "utf8"));
  ok("logs " + what + " (" + ev + ")", inG || inV);
});
ok("token usage is captured, so MAX_TOKENS is explainable",
   /outputTokens: usage \? usage\.candidatesTokenCount/.test(gsrc));
ok("per-window cost is visible", /promptTokens: usage \? usage\.promptTokenCount/.test(gsrc));
ok("thinking tokens too", /thoughtTokens/.test(gsrc));

console.log("\n=== a reload during a RETRY resumes instead of abandoning ===");
const vsrc = fs.readFileSync(REPO + "/js/video.js", "utf8");
ok("the heuristic that caused this is gone",
   !/const hasLines = blocks\.some/.test(vsrc));
ok("and it is not simply renamed", !/stillWaiting/.test(vsrc));

/* Behavioural: drive resumePending() with a document in the exact retry state.

   The stubs are declared as LOCALS inside harness(), not on globalThis. A
   direct eval sees the enclosing function scope, so video.js binds to these.
   Putting them on globalThis does not work here: this file already holds a
   module-scope `const Gemini`, which would shadow the global and hand video.js
   the real module — whose hasKey() is false, so resumePending returned
   immediately and every assertion below "passed" without running anything. */
function harness(pendingRec, doc) {
  const calls = [];
  const settings = { pendingTranscripts: pendingRec ? { doc_v: pendingRec } : {} };
  const FolioStore = {
    getSettings: () => settings,
    saveSettings: (s) => { Object.assign(settings, s); },
    getDocument: () => doc,
    updateDocument: () => {}, saveDocument: () => {},
    getComments: () => [], saveComments: () => {},
    getHighlights: () => [], generateId: (p) => p + "_x",
  };
  const Reader = { getCurrentDocId: () => "doc_v", render: () => {} };
  const TTS = { toast: () => {} };
  const SidebarUI = { renderPageTree: () => {} };
  const Comments = { listTimed: () => [], attachToHighlight: () => {} };
  const Gemini = {
    hasKey: () => true,
    parseYouTube: (u) => (u ? { videoId: "TJgg3eMUp7M", url: u, start: 0 } : null),
    formatTime: (s) => String(s),
    log: (ev, f) => calls.push({ ev, f }),
    // Never resolves: we only care THAT a run was started.
    transcribeYouTube: (url, opts) => {
      calls.push({ ev: "__started", f: { reason: opts && opts.reason } });
      return new Promise(() => {});
    },
  };
  // Referenced so a linter cannot call them unused; eval binds to them.
  void FolioStore; void Reader; void TTS; void SidebarUI; void Comments; void Gemini;
  const V = eval(vsrc + "; Video;");
  V.resumePending();
  return { calls, settings };
}

const retryState = { url: "https://www.youtube.com/watch?v=TJgg3eMUp7M",
                     reason: "retry", resumes: 0, lines: 210 };
// A document that already HAS lines and no placeholder — the retry case.
const docWithLines = { meta: { title: "x" }, content: { blocks: [
  { type: "video", data: { videoId: "TJgg3eMUp7M", duration: 2158 } },
  { type: "paragraph", data: { text: "A real transcribed line.", t: 0 } },
  { type: "paragraph", data: { text: "Another one.", t: 9 } },
]}};

let h = harness(retryState, docWithLines);
ok("a retry interrupted by a reload IS resumed",
   h.calls.some((c) => c.ev === "__started"), JSON.stringify(h.calls.map((c) => c.ev)));
ok("and it is marked as a resume",
   h.calls.some((c) => c.ev === "__started" && c.f.reason === "resume"));
ok("the resume is logged", h.calls.some((c) => c.ev === "resume"));
ok("the pending record is kept, not deleted",
   !!h.settings.pendingTranscripts.doc_v);
ok("how many lines were saved is recorded",
   h.calls.some((c) => c.ev === "resume" && c.f.hadLines === 210));

console.log("\n=== but it gives up rather than looping forever ===");
h = harness(Object.assign({}, retryState, { resumes: 3 }), docWithLines);
ok("a run that keeps failing is abandoned",
   !h.calls.some((c) => c.ev === "__started"));
ok("giving up is logged", h.calls.some((c) => c.ev === "resume-gaveup"));
ok("and the record is cleared", !h.settings.pendingTranscripts.doc_v);

h = harness(retryState, null);
ok("a deleted document does not resume", !h.calls.some((c) => c.ev === "__started"));
ok("and its record is cleared", !h.settings.pendingTranscripts.doc_v);

h = harness(null, docWithLines);
ok("nothing pending means nothing happens", h.calls.length === 0);

console.log("\n=== resume attempts are counted, not infinite ===");
ok("a cap exists", /MAX_AUTO_RESUMES/.test(vsrc));
ok("only automatic resumes increment it",
   /reason === "resume" \? \(prev\.resumes \|\| 0\) \+ 1 : 0/.test(vsrc));

console.log("\n=== retry shows a progress indicator ===");
ok("there is a persistent busy element", /class="fv-busy"/.test(vsrc));
ok("it is shown when a run starts", /setBusy\(true\)/.test(vsrc));
ok("it reports how far along it is", /setBusy\(true, segments\.length/.test(vsrc));
ok("cleared when the run succeeds", /clearPending\(docId\);\n    setBusy\(false\);/.test(vsrc));
ok("cleared when the run fails too",
   /clearPending\(docId\);\n      setBusy\(false\);/.test(vsrc));
ok("the retry button hides while busy", /if \(busy\) \{ b\.style\.display = "none"; return; \}/.test(vsrc));
const csrc = fs.readFileSync(REPO + "/css/highlights.css", "utf8");
ok("the indicator is styled", /\.fv-busy \{/.test(csrc));
ok("and respects reduced motion", /prefers-reduced-motion[\s\S]{0,120}fv-busy-dot/.test(csrc));

console.log("\n=== the log is reachable without DevTools ===");
["index.html", "index-electron.html"].forEach((f) => {
  const h2 = fs.readFileSync(REPO + "/" + f, "utf8");
  ok(f + " has the log controls", /gemini-log-copy-btn/.test(h2));
  ok(f + " has save and clear too",
     /gemini-log-save-btn/.test(h2) && /gemini-log-clear-btn/.test(h2));
});
const ssrc = fs.readFileSync(REPO + "/js/settings.js", "utf8");
ok("settings wires them up", /initGeminiLog\(\);/.test(ssrc));
ok("copy falls back to a file when the clipboard is blocked",
   /catch \{[\s\S]{0,200}downloadText\(text/.test(ssrc));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

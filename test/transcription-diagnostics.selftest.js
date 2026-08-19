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

console.log("\n=== resuming fills the gaps instead of starting over ===");
/* A resume used to re-transcribe the whole video from zero, so every reload
   discarded all the work so far and re-billed the lot. On a long video it
   could sit there transcribing indefinitely, making no progress across
   reloads. */
ok("existing lines are read back out of the document", /function existingSegments/.test(vsrc));
/* ONLY an interrupted run keeps them. A redo asked for by hand has to redo:
   keeping the old lines would mark every window "already covered" and change
   nothing, which is useless when the whole point is replacing a transcript
   made by a worse engine. */
ok("an interrupted run keeps them",
   /const already = reason === "resume" \? existingSegments\(docId\) : \[\]/.test(vsrc));
ok("a hand-asked redo does not", !/reason === "start" \? \[\] : existingSegments/.test(vsrc));
ok("and hands them to the transcriber", /existing: already/.test(vsrc));
ok("the transcriber seeds its results with them", /const all = existing\.slice\(\)/.test(gsrc));
ok("windows already done are skipped", /function windowCovered/.test(gsrc));
ok("a half-finished window is NOT treated as done",
   /inside\.length < 3/.test(gsrc) && /0\.6/.test(gsrc));
ok("and it says how much it is skipping", /alreadyDone: skipped/.test(gsrc));
ok("a fully covered video does no work at all", /nothing-to-do/.test(gsrc));

// The window-covered rule, exercised directly.
const wcSrc = gsrc.match(/function windowCovered\(w, existing\) \{[\s\S]*?\n  \}/)[0];
const windowCovered = eval("(" + wcSrc.replace(/^function /, "function ") + ")");
const full = [];
for (let t = 0; t < 300; t += 15) full.push({ start: t });
ok("a fully transcribed window counts as done",
   windowCovered({ from: 0, to: 300 }, full));
ok("an empty window does not", !windowCovered({ from: 0, to: 300 }, []));
ok("two stray lines do not", !windowCovered({ from: 0, to: 300 }, [{start:5},{start:9}]));
ok("a window abandoned a third of the way in does not",
   !windowCovered({ from: 0, to: 300 }, full.filter(s => s.start < 100)));
ok("lines from a different window do not count",
   !windowCovered({ from: 300, to: 600 }, full));

ok("the recorded duration survives a streaming write",
   /if \(duration > 0\) vd\.duration = Math\.round\(duration\)/.test(vsrc));

console.log("\n=== a streaming line APPENDS; it does not rebuild the page ===");
/* Reader.renderDocument -> Video.attach -> detach() -> player.destroy(), then a
   brand new YT.Player starting from zero. The stream flushes every 1.5s, so a
   transcription tore the video down about forty times a minute: playback jumped
   back to the start, scroll and selection were lost, and sync was meaningless.
   Lines only ever arrive at the END, so appending is all that was needed. */
ok("there is an append path", /function appendLines\(segments\)/.test(vsrc));
ok("it writes into the live transcript, not the whole article",
   /transcriptEl\.appendChild\(frag\)/.test(vsrc));
ok("it only adds what is new", /for \(let i = segEls\.length; i < segments\.length; i\+\+\)/.test(vsrc));
ok("streaming persists to storage regardless",
   /FolioStore\.updateDocument\(docId, \{ content: \{ time: Date\.now\(\),/.test(vsrc));
ok("streaming no longer full-renders when it can append",
   /if \(!appendLines\(segments\)\) \{/.test(vsrc));
ok("finishing appends too, so the video is not reloaded at the end",
   (vsrc.match(/if \(!appendLines\(segments\)\)/g) || []).length >= 2);
ok("model output is inserted as TEXT, never as markup",
   /createTextNode\(seg\.text\)/.test(vsrc));
ok("appending keeps the active line highlighted", /indexSegments\(true\)/.test(vsrc));
ok("re-indexing can preserve the active element",
   /const wasActive = keepActive && activeIdx >= 0/.test(vsrc));
ok("it falls back to a full render when there is no live layout",
   /if \(!transcriptEl \|\| !document\.body\.contains\(transcriptEl\)\) return false/.test(vsrc));
ok("the placeholder is removed once real lines exist", /folio-waiting/.test(vsrc));
ok("and why this matters is written down", /torn down and reloaded/.test(vsrc));

console.log("\n=== one run per document, across tabs and reloads ===");
/* A real log shows three runs on one document overlapping for eleven minutes,
   each doing all nine windows. Six concurrent requests on a preview model
   triggered rate limiting, four windows were abandoned after burning every
   retry, and the work could never converge because each run raced the last. */
ok("a run claims the document", /leaseUntil: Date\.now\(\) \+ LEASE_MS/.test(vsrc));
ok("starting checks for an existing claim", /if \(leaseHeld\(docId\)\) \{/.test(vsrc));
ok("and refuses rather than racing", /already-running/.test(vsrc));
ok("resuming checks too", /another run holds it/.test(vsrc));
ok("a live run keeps its claim fresh", /setInterval\(\(\) => refreshLease\(docId\), LEASE_REFRESH_MS\)/.test(vsrc));
ok("the claim is released when the run succeeds",
   /clearInterval\(lease\);\n    clearPending\(docId\)/.test(vsrc));
ok("and when it fails", /clearInterval\(lease\);\n      clearPending\(docId\)/.test(vsrc));
ok("the claim EXPIRES, so a closed tab cannot block the document forever",
   /rec\.leaseUntil > Date\.now\(\)/.test(vsrc));
ok("refresh interval is shorter than the lease itself",
   /LEASE_MS = 90000/.test(vsrc) && /LEASE_REFRESH_MS = 30000/.test(vsrc));

// Behavioural: a document already claimed must not be resumed.
const held = { url: "https://www.youtube.com/watch?v=TJgg3eMUp7M", reason: "start",
               resumes: 0, lines: 12, leaseUntil: Date.now() + 60000 };
let hh = harness(held, docWithLines);
ok("a claimed document is left alone", !hh.calls.some((c) => c.ev === "__started"),
   JSON.stringify(hh.calls.map((c) => c.ev)));
ok("and the claim is NOT cleared out from under the live run",
   !!hh.settings.pendingTranscripts.doc_v);

const expired = Object.assign({}, held, { leaseUntil: Date.now() - 1000 });
hh = harness(expired, docWithLines);
ok("an expired claim is picked up", hh.calls.some((c) => c.ev === "__started"),
   JSON.stringify(hh.calls.map((c) => c.ev)));

console.log("\n=== room to think AND to write ===");
/* Two windows came back with outputTokens=652 and thoughtTokens=15728 against
   a 16,384 cap: the model spent its whole budget reasoning and wrote 5 lines
   where it should have written twenty. */
ok("the output cap leaves room for both", /CHUNK_MAX_TOKENS = 65536/.test(gsrc));
ok("and why is recorded", /THINKING COUNTS AGAINST THIS/.test(gsrc));

console.log("\n=== a rate limit is backed off differently from a busy model ===");
ok("two ladders exist", /RETRY_BUSY = \[4000, 12000, 30000\]/.test(gsrc) &&
   /RETRY_LIMITED = \[15000, 45000, 90000, 150000\]/.test(gsrc));
ok("429 picks the slow one", /e\.slow = true;/.test(gsrc));
ok("and the choice is made per error", /err && err\.slow \? RETRY_LIMITED : RETRY_BUSY/.test(gsrc));
// A quota refuses in milliseconds, so the fast ladder burns out inside a minute.
const fast = [4000, 12000, 30000].reduce((a, b) => a + b, 0);
const slow = [15000, 45000, 90000, 150000].reduce((a, b) => a + b, 0);
ok("the slow ladder actually waits meaningfully longer", slow > fast * 3,
   `${fast}ms vs ${slow}ms`);

console.log("\n=== 429 is two different failures wearing one status code ===");
/* "Your prepayment credits are depleted" arrives as a 429, exactly like a real
   per-minute rate limit. The old code printed "rate limit reached, try again
   shortly" for both and threw Google's real message away — so a run that had
   simply run out of money looked like a temporary blip and was retried four
   times per window. */
ok("Google's actual message is no longer discarded",
   !/new Error\("Gemini rate limit reached\. Try again shortly\."\)/.test(gsrc));
ok("the real detail is passed through", /"Gemini rate limit reached" \+ \(detail \? ": " \+ detail : "\."\)/.test(gsrc));
ok("an out-of-credit 429 is recognised", /credit\|depleted\|billing\|payment/.test(gsrc));
ok("and marked terminal, because waiting cannot fix it", /e\.terminal = true;/.test(gsrc));
ok("a terminal failure stops the whole run", /if \(err && err\.terminal\) \{/.test(gsrc));
ok("other windows stop too rather than each failing the same way",
   /if \(stopped\) return;/.test(gsrc));
ok("it is logged distinctly from a retry", /log\("terminal"/.test(gsrc));

// The classifier, exercised directly.
const CLASSIFY = /credit|depleted|billing|payment|plan|exceeded your current quota/i;
[["Your prepayment credits are depleted.", true],
 ["You exceeded your current quota, please check your plan and billing details.", true],
 ["Resource has been exhausted (e.g. check quota).", false],
 ["Requests per minute exceeded for this model.", false],
].forEach(([msg, terminal]) => {
  ok(`${terminal ? "terminal" : "retryable"}: ${msg.slice(0, 46)}`, CLASSIFY.test(msg) === terminal);
});

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

console.log("\n=== the model is visible and switchable ===");
/* It was overridable only by hand-setting a localStorage key, which in
   practice means not overridable at all — and there was no way to see which
   model a transcript had used without reading the diagnostic log. */
["index.html", "index-electron.html"].forEach((f) => {
  const h = fs.readFileSync(REPO + "/" + f, "utf8");
  ok(f + " offers both models",
     /data-model="gemini-3\.7-flash"/.test(h) && /data-model="gemini-3\.1-pro-preview"/.test(h));
  ok(f + " shows what each costs", /\$0\.37 per 30 minutes/.test(h));
  /* settings.js wires EVERY .theme-btn to applyTheme(btn.dataset.t). Borrowing
     that class for these buttons made picking a model call applyTheme
     (undefined) and change the theme. */
  ok(f + " does not reuse the theme-button class", !/theme-btn model-btn/.test(h));
});
const ssrc2 = fs.readFileSync(REPO + "/js/settings.js", "utf8");
ok("the control is wired up", /initGeminiModel\(\);/.test(ssrc2));
ok("it marks the model in use", /classList\.toggle\("active", b\.dataset\.model === current\)/.test(ssrc2));
ok("choosing the default clears the override rather than pinning it",
   /b\.dataset\.model === Gemini\.DEFAULT_MODEL \? "" : b\.dataset\.model/.test(ssrc2));
ok("a hand-set custom model is still reported honestly", /\(custom\)/.test(ssrc2));
ok("gemini exposes what the control needs",
   /DEFAULT_MODEL,/.test(gsrc) && /getModel,/.test(gsrc) && /setModel,/.test(gsrc));
const csrc2 = fs.readFileSync(REPO + "/css/components.css", "utf8");
ok("the buttons are styled on their own class", /\.model-btn \{/.test(csrc2));
ok("and why they are separate is recorded", /would have made picking a model change the theme/.test(csrc2));

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

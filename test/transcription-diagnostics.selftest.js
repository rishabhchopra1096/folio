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
const vsrc = fs.readFileSync(REPO + "/js/video.js", "utf8");
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
/* The event list shrank with the code. A caption-grounded run is one request
   plus any top-up passes, so there are no per-window, per-chunk or streaming
   events left to log — and nothing that only mattered when timestamps were
   guesses, such as repetition loops or lines stamped past the end. */
[["request", "a run started"], ["pass", "each pass, with what it added"],
 ["done", "a completed run"], ["refused", "a run refused for want of captions"],
 ["httperror", "a rejected request"], ["neterror", "a dead connection"],
 ["resume", "a resumed run"], ["resume-gaveup", "giving up on a doomed run"],
 ["already-running", "a document already being transcribed"],
 ["import", "a transcript brought in by hand"], ["redo", "a redo asked for"],
].forEach(([ev, what]) => {
  const re = new RegExp('log\\("' + ev + '"');
  ok("logs " + what + " (" + ev + ")", re.test(gsrc) || re.test(vsrc));
});
ok("token usage is recorded per pass, so cost is explainable",
   /inTok: u\.promptTokenCount, outTok: u\.candidatesTokenCount/.test(gsrc));
ok("and how far each pass got", /covered: Math\.round\(lastCovered\(\)\)/.test(gsrc));
/* Events that only existed to explain guessed timestamps are gone with them. */
["loop", "trimmed", "chunkdone", "chunkfailed", "streambroke", "firstline"].forEach((ev) => {
  ok("no longer logs " + ev + ", because it cannot happen",
     !new RegExp('log\\("' + ev + '"').test(gsrc));
});


console.log("\n=== a reload during a RETRY resumes instead of abandoning ===");
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
function harness(pendingRec, doc, cues) {
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
      calls.push({ ev: "__started", f: { reason: opts && opts.reason,
                                         cues: (opts && opts.cues || []).length } });
      return new Promise(() => {});
    },
  };
  /*
   * A unit test must not touch the network. runTranscription now asks the
   * local helper for captions, and without this stub it made a REAL request
   * to 127.0.0.1:8787 — so the suite passed on a machine with no helper
   * running and hung on one that had it, which is the worst kind of flake.
   * Answer as though the helper is absent; the caption path has its own tests.
   */
  /*
   * A unit test must not touch the network. Without this the suite really did
   * request 127.0.0.1:8787, so it passed where no helper was running and hung
   * where one was — green in the place least like the one that matters.
   *
   * Pass `cues` to pretend the helper answered; omit it to pretend it is not
   * there. Both outcomes matter now, because a run with no captions REFUSES
   * rather than guessing.
   */
  const fetch = () => cues
    ? Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, cues,
        duration: 2158, title: "stub" }) })
    : Promise.reject(new Error("helper not running (stubbed)"));

  // Referenced so a linter cannot call them unused; eval binds to them.
  void FolioStore; void Reader; void TTS; void SidebarUI; void Comments; void Gemini;
  void fetch;
  const V = eval(vsrc + "; Video;");
  /*
   * An interrupted run only resumes on the document you actually have open —
   * otherwise opening a plain text page could start some other document's
   * transcription and paint its progress over what you were reading.
   *
   * The scenario under test is a RELOAD DURING A RETRY, which by definition
   * happens while you are on that document, so the URL has to say so. The
   * harness never modelled the URL before, and defaulted to no document at all.
   */
  global.window.location.hash = "#/doc/doc_v";
  V.resumePending();
  /* runTranscription now asks the local helper for captions first, so the
     Gemini call lands a few microtasks later than it once did. Drain them
     before asserting, or the check races the code it is checking. */
  return { calls, settings, settle: () => new Promise((r) => setTimeout(r, 60)) };
}

const retryState = { url: "https://www.youtube.com/watch?v=TJgg3eMUp7M",
                     reason: "retry", resumes: 0, lines: 210 };
// A document that already HAS lines and no placeholder — the retry case.
const docWithLines = { meta: { title: "x" }, content: { blocks: [
  { type: "video", data: { videoId: "TJgg3eMUp7M", duration: 2158 } },
  { type: "paragraph", data: { text: "A real transcribed line.", t: 0 } },
  { type: "paragraph", data: { text: "Another one.", t: 9 } },
]}};

(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 60));
  let h = harness(retryState, docWithLines); await settle();
  /* With no captions to be had, a resume must REFUSE rather than produce a
     document that reads well and anchors every comment 563 seconds out. */
  ok("the resume is attempted and logged", h.calls.some((c) => c.ev === "resume"));
  ok("but nothing is sent to Gemini without captions",
     !h.calls.some((c) => c.ev === "__started"), JSON.stringify(h.calls.map((c) => c.ev)));
  ok("and the failure is recorded rather than swallowed",
     h.calls.some((c) => c.ev === "resume-failed"));

  /* Helper answering: the same resume goes through. */
  const withCues = [{ t: 0, text: "one" }, { t: 15, text: "two" }, { t: 30, text: "three" }];
  let hc = harness(retryState, docWithLines, withCues); await settle();
  ok("with captions available, a reload DOES resume",
     hc.calls.some((c) => c.ev === "__started"), JSON.stringify(hc.calls.map((c) => c.ev)));
  ok("it is marked as a resume",
     hc.calls.some((c) => c.ev === "__started" && c.f.reason === "resume"));
  ok("and the captions are handed over",
     hc.calls.some((c) => c.ev === "__started" && c.f.cues === withCues.length));
  ok("the pending record is kept while it runs",
     !!hc.settings.pendingTranscripts.doc_v);
  ok("how many lines were saved is recorded",
     h.calls.some((c) => c.ev === "resume" && c.f.hadLines === 210));

  console.log("\n=== but it gives up rather than looping forever ===");
  h = harness(Object.assign({}, retryState, { resumes: 3 }), docWithLines); await settle();
  ok("a run that keeps failing is abandoned",
     !h.calls.some((c) => c.ev === "__started"));
  ok("giving up is logged", h.calls.some((c) => c.ev === "resume-gaveup"));
  ok("and the record is cleared", !h.settings.pendingTranscripts.doc_v);

  h = harness(retryState, null); await settle();
  ok("a deleted document does not resume", !h.calls.some((c) => c.ev === "__started"));
  ok("and its record is cleared", !h.settings.pendingTranscripts.doc_v);

  h = harness(null, docWithLines); await settle();
  ok("nothing pending means nothing happens", h.calls.length === 0);

  /* The gap-filling machinery is gone. A caption-grounded run regenerates
     against the real clock and its own top-up loop finishes anything that
     stopped short, so there is nothing to stitch together from a prior run. */

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
})();

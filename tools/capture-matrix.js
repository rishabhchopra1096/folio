/*
 * Automated selection-capture compatibility matrix.
 *
 * Drives each app itself instead of asking a human to select text by hand:
 * opens a scratch file WE created, sends ⌘A, and asks selection-hook what it
 * sees. Reports which mechanism answered — the accessibility API or the
 * clipboard fallback — because that is the thing the whole design turns on.
 *
 * SAFETY: it only ever opens files under a temp directory it makes itself. It
 * sends ⌘A and ⌘W and nothing else — never a keystroke that could modify a
 * document. Apps already running are left running; windows it opened are the
 * only ones it closes.
 */
const SelectionHook = require("selection-hook");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const METHOD = Object.fromEntries(
  Object.entries(SelectionHook.SelectionMethod).map(([k, v]) => [v, k]));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "folio-capture-"));
const SAMPLE = "The quick brown fox jumps over the lazy dog. " +
  "This paragraph exists only so that something is selectable. " +
  "It is deliberately long enough to be unmistakable when captured.";

const txt = path.join(DIR, "sample.txt");
fs.writeFileSync(txt, SAMPLE);

/* An HTML file, so browsers have something local to open. */
const html = path.join(DIR, "sample.html");
fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><body><p>${SAMPLE}</p></body>`);

/* A PDF, for the PDFKit path. textutil→cupsfilter is on every Mac. */
let pdf = null;
try {
  const rtf = path.join(DIR, "sample.rtf");
  execFileSync("textutil", ["-convert", "rtf", "-output", rtf, txt]);
  pdf = path.join(DIR, "sample.pdf");
  execFileSync("/usr/sbin/cupsfilter", [rtf], { stdio: ["ignore", fs.openSync(pdf, "w"), "ignore"] });
  if (!fs.statSync(pdf).size) pdf = null;
} catch { pdf = null; }

const osa = (script) => execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);

const TARGETS = [
  { app: "TextEdit",           file: txt,  note: "native Cocoa text" },
  { app: "Safari",             file: html, note: "WebKit" },
  { app: "Google Chrome",      file: html, note: "Chromium — the 2s AX debounce case" },
  { app: "Cursor",             file: txt,  note: "Electron — same debounce" },
  { app: "Visual Studio Code", file: txt,  note: "Electron" },
  { app: "Sublime Text",       file: txt,  note: "custom-drawn text" },
  { app: "Preview",            file: pdf,  note: "PDFKit" },
];

const hook = new SelectionHook();
if (!hook.macIsProcessTrusted()) {
  console.log("Accessibility not granted to this process — cannot run.");
  process.exit(1);
}
hook.start({ debug: false, enableClipboard: true, selectionPassiveMode: true });

const results = [];

for (const t of TARGETS) {
  if (!t.file) { results.push({ ...t, status: "skipped (no test file)" }); continue; }

  // Wipe the pasteboard first, so anything stale shows up as stale.
  try { execFileSync("pbcopy", { input: "" }); } catch { /* fine */ }

  let opened = false;
  try {
    execFileSync("open", ["-a", t.app, t.file], { stdio: "ignore" });
    opened = true;
  } catch {
    results.push({ ...t, status: "not installed" });
    continue;
  }

  /* Electron and Chromium need the accessibility tree switched on, and that is
     debounced by two seconds in their own source. Wait it out so the AX path
     gets a fair test rather than an unfairly cold one. */
  sleep(3500);

  let sel = null, err = null;
  try {
    osa(`tell application "System Events" to keystroke "a" using command down`);
    sleep(600);
    sel = hook.getCurrentSelection();
  } catch (e) { err = e.message; }

  /*
   * VERIFY THE CONTENT, never just that something came back.
   *
   * The clipboard fallback happily returns whatever was on the pasteboard
   * before — so a stale copy from a previous app reads as a successful capture.
   * The first run of this matrix reported three false positives that way, all
   * carrying the same 1,044 characters from an earlier test. A capture only
   * counts if it contains a phrase unique to the file we just opened.
   */
  const text = (sel && sel.text) || "";
  const isReal = text.indexOf("quick brown fox") !== -1;

  results.push({
    ...t,
    status: err ? "error: " + err.slice(0, 40)
          : !text.trim() ? "nothing"
          : isReal ? "captured"
          : "STALE",
    reported: sel && sel.programName,
    method: sel ? (METHOD[sel.method] || sel.method) : null,
    chars: sel && sel.text ? sel.text.length : 0,
    coords: !!(sel && sel.startTop && sel.startTop.x !== SelectionHook.INVALID_COORDINATE),
  });

  // Close only the window we opened.
  if (opened) {
    try { osa(`tell application "System Events" to keystroke "w" using command down`); } catch { /* fine */ }
    sleep(500);
  }
}

try { hook.stop(); } catch { /* stop can hang; never block exit on it */ }

console.log("\n  SELECTION CAPTURE — automated matrix\n");
console.log("  " + "app".padEnd(20) + "result".padEnd(12) + "method".padEnd(11) +
            "chars".padEnd(7) + "coords  note");
console.log("  " + "-".repeat(88));
for (const r of results) {
  console.log("  " + r.app.padEnd(20) +
    String(r.status).slice(0, 11).padEnd(12) +
    String(r.method || "-").padEnd(11) +
    String(r.chars || "-").padEnd(7) +
    (r.coords ? "yes" : "-").padEnd(8) + r.note);
}

const stale = results.filter((r) => r.status === "STALE");
if (stale.length) {
  console.log("\n  STALE means the clipboard fallback returned older pasteboard");
  console.log("  content rather than the selection — a false positive, not a capture.");
}

const got = results.filter((r) => r.status === "captured");
console.log("\n  captured in " + got.length + " of " + results.length + " apps");
const ax = got.filter((r) => r.method === "AXAPI").length;
console.log("  via accessibility API: " + ax + "   via clipboard fallback: " +
            got.filter((r) => r.method === "CLIPBOARD").length);
console.log("  reporting coordinates: " + got.filter((r) => r.coords).length);

fs.rmSync(DIR, { recursive: true, force: true });
console.log("\n  scratch files removed\n");
process.exit(0);

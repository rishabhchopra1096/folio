/*
 * STEP 1 of the global-reader plan: find out what selection capture actually
 * returns, per application, before any UI is built on top of it.
 *
 * This is the part most likely to disappoint, so it gets tested first and
 * reported honestly. It samples the current selection every couple of seconds;
 * you just select text in one app after another.
 *
 * Nothing is synthesised and nothing is billed — this only reads selections.
 */
const SelectionHook = require("selection-hook");

const SAMPLE_MS = 2000;
const RUN_MS = Number(process.argv[2] || 120) * 1000;

const METHOD = Object.fromEntries(
  Object.entries(SelectionHook.SelectionMethod).map(([k, v]) => [v, k]));

const hook = new SelectionHook();

if (!hook.macIsProcessTrusted()) {
  console.log("\nAccessibility is NOT granted to this process.");
  console.log("Grant it to your terminal in System Settings → Privacy & Security →");
  console.log("Accessibility, then run this again.\n");
  process.exit(1);
}

/*
 * Passive mode: no automatic popups, we ask when we want to — which is the
 * shape a hotkey has. Clipboard fallback on, because AX alone fails in Chrome
 * and Electron apps for the first two seconds and never works in some others.
 */
hook.start({
  debug: false,
  enableClipboard: true,
  selectionPassiveMode: true,
});

const seen = new Map();          // "app | method" -> sample
let samples = 0;

console.log("\n  Select some text in an app, and leave it selected.");
console.log("  Then switch to another app and select something there.");
console.log(`  Sampling every ${SAMPLE_MS / 1000}s for ${RUN_MS / 1000}s.\n`);
console.log("  " + "app".padEnd(22) + "method".padEnd(12) + "chars  coords  preview");
console.log("  " + "-".repeat(74));

const timer = setInterval(function () {
  samples++;
  let sel = null;
  try {
    sel = hook.getCurrentSelection();
  } catch (err) {
    console.log("  (getCurrentSelection threw: " + err.message + ")");
    return;
  }
  if (!sel || !sel.text || !sel.text.trim()) return;

  const app = (sel.programName || "?").slice(0, 21);
  const method = METHOD[sel.method] || String(sel.method);
  const key = app + " | " + method;
  if (seen.has(key)) return;             // one line per app+method pair

  /* Coordinates decide whether the reading window can appear beside the
     selection or has to live at a fixed screen edge. */
  const hasCoords = !!(sel.startTop &&
    sel.startTop.x !== SelectionHook.INVALID_COORDINATE &&
    sel.startTop.x !== undefined);

  const preview = sel.text.replace(/\s+/g, " ").trim().slice(0, 26);
  seen.set(key, { app, method, chars: sel.text.length, hasCoords });

  console.log("  " + app.padEnd(22) + method.padEnd(12) +
              String(sel.text.length).padStart(5) + "  " +
              (hasCoords ? "yes " : "no  ").padEnd(7) + '"' + preview + '"');
}, SAMPLE_MS);

setTimeout(function () {
  clearInterval(timer);
  try { hook.stop(); } catch { /* stop can hang; do not block exit on it */ }

  console.log("\n  " + "=".repeat(74));
  console.log("  COMPATIBILITY SUMMARY\n");

  if (!seen.size) {
    console.log("  Nothing captured at all in " + samples + " samples.");
    console.log("  Either no text stayed selected, or capture is not working.");
  } else {
    const byApp = new Map();
    for (const s of seen.values()) {
      if (!byApp.has(s.app)) byApp.set(s.app, []);
      byApp.get(s.app).push(s);
    }
    for (const [app, list] of byApp) {
      const methods = list.map((x) => x.method).join(" + ");
      const coords = list.some((x) => x.hasCoords) ? "with coordinates" : "no coordinates";
      console.log("  " + app.padEnd(22) + methods.padEnd(20) + coords);
    }
    const ax = [...seen.values()].filter((s) => s.method === "AXAPI").length;
    const cb = [...seen.values()].filter((s) => s.method === "CLIPBOARD").length;
    console.log("\n  reached by Accessibility: " + ax);
    console.log("  reached by clipboard fallback: " + cb);
    console.log("  apps covered: " + byApp.size);
  }
  console.log();
  process.exit(0);
}, RUN_MS);

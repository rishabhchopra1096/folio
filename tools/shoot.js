/*
 * =============================================================================
 * SHOOT.JS — screenshots of a staged page, taken when the page says it is ready
 * =============================================================================
 * WHAT THIS DOES:
 * Launches headless Chrome, points it at one of the test/browser/*.shot.html
 * pages, waits for that page to declare itself ready, and saves a PNG.
 *
 * WHY IT IS NOT JUST `chrome --screenshot`:
 * Two things the simple form cannot do, and both of them produced a misleading
 * picture before this existed.
 *
 * 1. IT CANNOT WAIT FOR THE RIGHT MOMENT. `--virtual-time-budget` races the
 *    clock forward so every setTimeout fires at once, but it does not wait for
 *    work that is neither a timer nor a network request. Decoding audio is
 *    exactly that, so the first screenshot of the drive player was taken
 *    half-prepared: a progress bar at zero and a status line still saying it
 *    was fetching. The picture looked like a bug that was not there. Here the
 *    PAGE decides when it is ready, by setting window.__shotReady, and the
 *    shot is taken then.
 *
 * 2. IT CANNOT CHOOSE A COLOUR SCHEME. Headless Chrome always reports a light
 *    preference, so a dark-first design could never be photographed in the
 *    mode it was designed for — which for a thing used while driving at night
 *    is the mode that matters. Emulation.setEmulatedMedia fixes that.
 *
 * Usage:
 *   node tools/shoot.js <page.shot.html> <out.png> [query] [dark|light] [WxH]
 *
 * NODE_PATH must point at a node_modules containing `ws` (Folio itself ships
 * no dependencies). test/run-all.sh finds one the same way.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PAGE = process.argv[2];
const OUT = process.argv[3];
const QUERY = process.argv[4] || "";
const SCHEME = process.argv[5] || "dark";
const SIZE = (process.argv[6] || "393x852").split("x").map(Number);

if (!PAGE || !OUT) {
  console.error("usage: node tools/shoot.js <page.shot.html> <out.png> [query] [dark|light] [WxH]");
  process.exit(2);
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9456 + Math.floor(Math.random() * 300);
const PROFILE = fs.mkdtempSync(path.join(require("os").tmpdir(), "folio-shoot-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
  "--hide-scrollbars",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + PROFILE,
  "about:blank",
], { stdio: "ignore" });

function httpGet(p, method) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method: method || "GET" },
      (x) => { let b = ""; x.on("data", (d) => (b += d)); x.on("end", () => res(b)); });
    r.on("error", rej);
    r.end();
  });
}

(async () => {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      target = JSON.parse(await httpGet("/json/new?about:blank", "PUT"));
      break;
    } catch { await sleep(250); }
  }
  if (!target) { console.error("could not reach Chrome's debugger"); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on("open", r));
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.id !== id) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable", {});
  await send("Runtime.enable", {});
  // The phone, in points, at retina density — the layout is written against
  // exactly this, so any other size would be a picture of something he will
  // never see.
  /*
   * mobile:false on purpose. Mobile emulation applies a page scale derived
   * from a viewport meta the WRAPPER page does not have, and the first shots
   * came out at 80% — a picture of a layout at a size no phone renders. The
   * page being photographed is inside an iframe that carries its own viewport
   * meta, so the wrapper only has to be exactly the right number of pixels.
   */
  await send("Emulation.setDeviceMetricsOverride", {
    width: SIZE[0], height: SIZE[1], deviceScaleFactor: 2, mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: SCHEME }],
  });

  const url = "http://localhost:8810/" + PAGE + QUERY;
  await send("Page.navigate", { url });

  // WAIT FOR THE PAGE TO SAY IT IS READY, not for a guess at how long it takes.
  let ready = false, why = "";
  for (let i = 0; i < 160; i++) {          // up to ~40s
    await sleep(250);
    try {
      const r = await send("Runtime.evaluate", {
        expression: "JSON.stringify({ ready: !!window.__shotReady, why: window.__shotWhy || '' })",
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value || "{}");
      if (v.ready) { ready = true; why = v.why; break; }
      why = v.why;
    } catch { /* the page is still navigating */ }
  }
  if (!ready) {
    console.error("TIMED OUT waiting for window.__shotReady" + (why ? " — last state: " + why : ""));
  }
  // One more frame so any CSS transition kicked off by the final state settles.
  await sleep(400);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));

  ws.close();
  chrome.kill();
  /*
   * Best effort. Chrome is still flushing its profile as we exit, so deleting
   * it can fail with ENOTEMPTY — and a temp directory left behind must never
   * fail a screenshot that was already taken successfully.
   */
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* it is in /tmp */ }
  console.log((ready ? "wrote " : "wrote (NOT READY — treat with suspicion) ") + OUT +
              "  [" + SCHEME + ", " + SIZE[0] + "x" + SIZE[1] + "]");
  process.exit(ready ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  try { chrome.kill(); } catch { /* already gone */ }
  process.exit(1);
});

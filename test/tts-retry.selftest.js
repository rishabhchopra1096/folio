/*
 * Tests that a dictation survives a dropped connection.
 *
 * Previously the audio blob lived inside stopRecording(), so a failed upload
 * took the recording with it — the user lost what they'd said. These assertions
 * pin the recovery path.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const BAR = `<div id="tts-bar">
  <button id="tts-prev"></button><button id="tts-play"></button><button id="tts-next"></button>
  <button id="tts-rate"></button><select id="tts-voice"></select><span id="tts-eta"></span>
  <button id="tts-mic"></button><button id="tts-help-btn"></button><button id="tts-close"></button></div>`;
const dom = new JSDOM(
  `<!doctype html><body><div id="view-reader" class="active"><div id="article">` +
  `<p>First paragraph here with some words.</p><p>Second paragraph also here.</p>` +
  `</div></div>${BAR}</body>`, { pretendToBeVisual: true });

global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined; global.Highlight = undefined;
global.navigator = dom.window.navigator;

global.speechSynthesis = { cancel(){}, speak(){}, getVoices: () => [
  { name: "TestVoice", lang: "en-US", localService: true }], onvoiceschanged: null };
global.SpeechSynthesisUtterance = function (t) { this.text = t; };

// ── Fake Voice with a controllable network
const net = { up: false, calls: 0, blobsSeen: [] };
const FAKE_BLOB = { size: 5000, type: "audio/webm", __id: "blob-1" };
global.Voice = {
  hasKey: () => true,
  startRecording: async () => ({ id: 1 }),
  stopRecordingRaw: async () => FAKE_BLOB,
  transcribe: async (blob) => {
    net.calls++; net.blobsSeen.push(blob);
    if (!net.up) throw new Error("Network error contacting Groq: Failed to fetch");
    return "the thought I spoke";
  },
  isRetryable: (err) => {
    const m = (err && err.message || "").toLowerCase();
    if (m.includes("rejected the key")) return false;
    if (m.includes("no audio")) return false;
    return m.includes("network error") || m.includes("rate limit");
  },
  cancelRecording: () => {},
};

const savedComments = [];
global.Comments = {
  addComment: (hlId, text, docId) => { savedComments.push({ hlId, text, docId }); return "cm"; },
  openPanelForHighlight: () => {},
};
global.Highlights = { createHighlightFromRange: () => "hl_1" };
const store = { settings: {} };
global.FolioStore = {
  getSettings: () => JSON.parse(JSON.stringify(store.settings)),
  saveSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
  generateId: (p) => p + "_x", getHighlights: () => [], saveHighlights: () => {},
  getComments: () => [], saveComments: () => {},
};
global.Reader = { getCurrentDocId: () => "doc_CURRENT" };

const src = fs.readFileSync(REPO + "/js/tts.js", "utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get pending(){return pending;}, get micState(){return micState;}, " +
  "retryPending, queueForRetry, finishDictation, " +
  "arm: (hl) => { micHandle = {id:1}; micHighlightId = hl; micState='recording'; micResumeAfter=false; } }),\n" +
  "    init, attach, detach,");
const TTS = eval(src + "; TTS;");

let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

TTS.init();
TTS.attach("doc_A");
const I = TTS.__i();

(async function(){
  console.log("\n=== connection is DOWN when you finish speaking ===");
  net.up = false;
  I.arm("hl_offline");
  await I.finishDictation();
  await sleep(60);
  ok("transcription was attempted", net.calls === 1, "calls=" + net.calls);
  ok("nothing saved yet", savedComments.length === 0, JSON.stringify(savedComments));
  ok("the recording is HELD, not discarded", I.pending.length === 1,
     "pending=" + I.pending.length);
  ok("the actual audio blob is retained",
     I.pending[0] && I.pending[0].blob === FAKE_BLOB, "blob missing");
  ok("badge shows the count",
     dom.window.document.getElementById("tts-mic").dataset.pending === "1",
     dom.window.document.getElementById("tts-mic").dataset.pending);

  console.log("\n=== retry while still offline keeps holding it ===");
  await I.retryPending(); await sleep(40);
  ok("still held", I.pending.length === 1, "pending=" + I.pending.length);
  ok("still nothing saved", savedComments.length === 0);

  console.log("\n=== connection returns ===");
  net.up = true;
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await sleep(120);
  ok("queue drained", I.pending.length === 0, "pending=" + I.pending.length);
  ok("the comment was saved", savedComments.length === 1, JSON.stringify(savedComments));
  ok("with the spoken text", savedComments[0].text === "the thought I spoke",
     savedComments[0].text);
  ok("attached to the right highlight", savedComments[0].hlId === "hl_offline",
     savedComments[0].hlId);
  ok("badge cleared",
     !dom.window.document.getElementById("tts-mic").dataset.pending,
     dom.window.document.getElementById("tts-mic").dataset.pending);

  console.log("\n=== a retry files against the ORIGINATING document ===");
  // This was a real bug: Comments.addComment defaulted to whatever doc is open,
  // so a retry after switching documents misfiled the comment.
  savedComments.length = 0;
  net.up = false;
  TTS.attach("doc_A");
  I.arm("hl_docA");
  await I.finishDictation(); await sleep(60);
  ok("held while offline", I.pending.length === 1);
  TTS.attach("doc_B");                    // user moves to another document
  net.up = true;
  await I.retryPending(); await sleep(80);
  ok("saved once", savedComments.length === 1, JSON.stringify(savedComments));
  ok("filed against doc_A, not doc_B", savedComments[0].docId === "doc_A",
     "docId=" + savedComments[0].docId);

  console.log("\n=== a non-retryable failure is NOT queued ===");
  savedComments.length = 0;
  const realTranscribe = global.Voice.transcribe;
  global.Voice.transcribe = async () => { throw new Error("Groq rejected the key. Check it in Settings → Voice."); };
  TTS.attach("doc_C");
  I.arm("hl_badkey");
  await I.finishDictation(); await sleep(60);
  ok("bad key is not held for retry", I.pending.length === 0, "pending=" + I.pending.length);
  global.Voice.transcribe = realTranscribe;

  console.log("\n=== several held recordings all drain ===");
  net.up = false;
  TTS.attach("doc_D");
  for (const hl of ["h1","h2","h3"]) { I.arm(hl); await I.finishDictation(); await sleep(30); }
  ok("three held", I.pending.length === 3, "pending=" + I.pending.length);
  savedComments.length = 0;
  net.up = true;
  await I.retryPending(); await sleep(150);
  ok("all three saved", savedComments.length === 3, "saved=" + savedComments.length);
  ok("queue empty", I.pending.length === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail?1:0);
})();

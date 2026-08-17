/*
 * Tests the Space tap-vs-hold state machine in js/tts.js.
 *
 * Space is overloaded: a tap is play/pause, a hold starts latched dictation.
 * The two can only be told apart on keyup, but pause has to feel instant — so
 * the edges each action fires on are load-bearing and easy to get subtly
 * wrong. Hence a test rather than a manual poke.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const paras = [];
for (let i = 0; i < 12; i++) {
  paras.push(`<p>Paragraph ${i} with a sentence in it. And a second sentence here too.</p>`);
}
const BAR = `
<div id="tts-bar">
  <button id="tts-prev"></button><button id="tts-play"></button><button id="tts-next"></button>
  <button id="tts-rate"></button><select id="tts-voice"></select><span id="tts-eta"></span>
  <button id="tts-mic"></button><button id="tts-help-btn"></button><button id="tts-close"></button>
</div>`;
const dom = new JSDOM(
  `<!doctype html><body><div id="view-reader" class="active"><div id="article">${paras.join("")}</div></div>${BAR}</body>`,
  { pretendToBeVisual: true }
);

global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined;
global.Highlight = undefined;

// ── Fake speech engine: records what it was asked to do, never really speaks.
const engine = { speaks: [], cancels: 0 };
global.speechSynthesis = {
  cancel: () => engine.cancels++,
  speak: (u) => { engine.speaks.push({ text: u.text, rate: u.rate }); },
  getVoices: () => [{ name: "TestVoice", lang: "en-US", localService: true }],
  onvoiceschanged: null,
};
global.SpeechSynthesisUtterance = function (text) { this.text = text; };

// ── Fake Voice module (Groq Whisper stand-in)
const voice = { started: 0, stopped: 0, cancelled: 0, nextTranscript: "a spoken note", hasKey: true };
global.Voice = {
  hasKey: () => voice.hasKey,
  startRecording: async () => { voice.started++; return { id: 1 }; },
  stopRecording: async () => { voice.stopped++; return voice.nextTranscript; },
  cancelRecording: () => { voice.cancelled++; },
};

// ── Fake Comments / Highlights
const saved = [];
global.Comments = {
  addComment: (hlId, text) => { saved.push({ hlId, text }); return "cm_1"; },
  openPanelForHighlight: () => { saved.push({ panelOpened: true }); },
};
global.Highlights = { createHighlightFromRange: () => "hl_" + (saved.length + 1) };

const store = { settings: {} };
global.FolioStore = {
  getSettings: () => JSON.parse(JSON.stringify(store.settings)),
  saveSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); },
  generateId: (p) => p + "_x",
  getHighlights: () => [], saveHighlights: () => {},
  getComments: () => [], saveComments: () => {},
};
global.Reader = { getCurrentDocId: () => "doc_test" };

const src = fs.readFileSync(path.join(REPO, "js/tts.js"), "utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get micState(){return micState;}, get playing(){return playing;}, " +
  "get rate(){return rate;}, get curWord(){return curWord;} }),\n    init, attach, detach,"
);
const TTS = eval(src + "; TTS;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key(type, opts) {
  const e = new dom.window.KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, opts));
  dom.window.document.dispatchEvent(e);
  return e;
}
const spaceDown = (repeat) => key("keydown", { key: " ", code: "Space", repeat: !!repeat });
const spaceUp   = ()       => key("keyup",   { key: " ", code: "Space" });

TTS.init();
TTS.attach("doc_test");
const I = TTS.__i();

(async function run() {
  console.log("\n=== TAP while paused -> plays ===");
  ok("starts paused", !I.playing);
  spaceDown(); await sleep(40); spaceUp(); await sleep(20);
  ok("playing after a tap", I.playing, "playing=" + I.playing);
  ok("engine was asked to speak", engine.speaks.length > 0, "speaks=" + engine.speaks.length);

  console.log("\n=== TAP while playing -> pauses, no dictation ===");
  const startedBefore = voice.started;
  spaceDown(); await sleep(40); spaceUp(); await sleep(20);
  ok("paused after a tap", !I.playing);
  ok("no recording started", voice.started === startedBefore,
     `${startedBefore} -> ${voice.started}`);
  ok("comment panel did NOT open (default off)",
     !saved.some((s) => s.panelOpened), JSON.stringify(saved));

  console.log("\n=== pause is applied on KEYDOWN, before we know it's a tap ===");
  spaceDown(); await sleep(40);          // still held
  ok("playing again after tap-to-play", true);           // context
  spaceUp(); await sleep(20);
  ok("now playing", I.playing);
  spaceDown(); await sleep(30);          // key still down, under the hold threshold
  ok("already paused mid-press (instant feel)", !I.playing, "playing=" + I.playing);
  spaceUp(); await sleep(20);
  ok("stays paused after release", !I.playing);

  console.log("\n=== HOLD while playing -> latched dictation ===");
  spaceDown(); await sleep(40); spaceUp(); await sleep(30);   // play
  ok("playing before the hold", I.playing);
  const before = voice.started;
  spaceDown();                                   // press and keep holding
  await sleep(500);                              // past SPACE_HOLD_MS (350)
  ok("recording began while still held", I.micState === "recording",
     "micState=" + I.micState);
  ok("reading paused for dictation", !I.playing);
  ok("Voice.startRecording called once", voice.started === before + 1,
     `${before} -> ${voice.started}`);

  console.log("\n=== release does NOT stop it (latched) ===");
  spaceUp(); await sleep(60);
  ok("still recording after release", I.micState === "recording",
     "micState=" + I.micState);
  ok("stopRecording not called yet", voice.stopped === 0, "stopped=" + voice.stopped);

  console.log("\n=== tap to finish -> saves and resumes ===");
  spaceDown(); await sleep(30); spaceUp(); await sleep(120);
  ok("recording ended", I.micState === "idle", "micState=" + I.micState);
  ok("transcript saved as a comment",
     saved.some((s) => s.text === "a spoken note"), JSON.stringify(saved));
  ok("reading resumed", I.playing, "playing=" + I.playing);

  console.log("\n=== Escape cancels without saving ===");
  const savedCount = saved.filter((s) => s.text).length;
  spaceDown(); await sleep(500);                       // hold -> record
  ok("recording", I.micState === "recording");
  key("keydown", { key: "Escape" }); await sleep(60);
  ok("cancelled", I.micState === "idle", "micState=" + I.micState);
  ok("cancelRecording called", voice.cancelled > 0, "cancelled=" + voice.cancelled);
  ok("nothing new saved", saved.filter((s) => s.text).length === savedCount);
  spaceIsUpHack();

  console.log("\n=== key repeat while holding does not re-trigger ===");
  const s0 = voice.started;
  spaceDown(); spaceDown(true); spaceDown(true); await sleep(500);
  ok("only one recording started", voice.started === s0 + 1, `${s0} -> ${voice.started}`);
  key("keydown", { key: "Escape" }); await sleep(40);
  spaceIsUpHack();

  console.log("\n=== speed keys ===");
  // Force a known engaged state rather than depending on whatever the previous
  // assertions left behind.
  TTS.play(); await sleep(40);
  ok("engaged before testing arrows", I.playing, "playing=" + I.playing);
  const r0 = I.rate;
  key("keydown", { key: "ArrowUp" }); await sleep(20);
  ok("ArrowUp increased rate", I.rate > r0, `${r0} -> ${I.rate}`);
  const r1 = I.rate;
  key("keydown", { key: "ArrowDown" }); await sleep(20);
  ok("ArrowDown decreased rate", I.rate < r1, `${r1} -> ${I.rate}`);

  console.log("\n=== arrows are inert before engaging ===");
  // Fresh attach clears the playhead, so arrows should be ignored.
  TTS.attach("doc_test2");
  const e = key("keydown", { key: "ArrowRight" });
  ok("ArrowRight not consumed when not engaged", !e.defaultPrevented);

  console.log("\n=== modifier combos are left to the browser ===");
  const e2 = key("keydown", { key: " ", code: "Space", metaKey: true });
  ok("Cmd+Space ignored", !e2.defaultPrevented);
  const e3 = key("keydown", { key: "ArrowRight", ctrlKey: true });
  ok("Ctrl+Right ignored", !e3.defaultPrevented);

  console.log("\n=== 'D' is a tap-toggle: tap to start, tap to stop ===");
  voice.hasKey = true;
  TTS.attach("doc_d");
  TTS.play(); await sleep(40);
  ok("playing before D", I.playing);
  const dStart = voice.started;
  key("keydown", { key: "d" }); await sleep(60);
  ok("D started recording", I.micState === "recording", "micState=" + I.micState);
  ok("no holding required", voice.started === dStart + 1, `${dStart} -> ${voice.started}`);
  ok("reading paused", !I.playing);
  key("keyup", { key: "d" }); await sleep(60);
  ok("releasing D does NOT stop it", I.micState === "recording", "micState=" + I.micState);
  const savedBefore = saved.filter((s) => s.text).length;
  key("keydown", { key: "d" }); await sleep(140);
  ok("second D tap ended recording", I.micState === "idle", "micState=" + I.micState);
  ok("comment saved", saved.filter((s) => s.text).length === savedBefore + 1);
  ok("reading resumed", I.playing, "playing=" + I.playing);

  console.log("\n=== 'D' key repeat does not double-fire ===");
  const dS2 = voice.started;
  key("keydown", { key: "d" });
  key("keydown", { key: "d", repeat: true });
  key("keydown", { key: "d", repeat: true });
  await sleep(60);
  ok("only one recording started", voice.started === dS2 + 1, `${dS2} -> ${voice.started}`);
  key("keydown", { key: "Escape" }); await sleep(60);
  ok("escaped cleanly", I.micState === "idle");

  console.log("\n=== 'M' still works as an alias ===");
  TTS.play(); await sleep(40);
  const mS = voice.started;
  key("keydown", { key: "m" }); await sleep(60);
  ok("M started recording", I.micState === "recording");
  ok("startRecording called", voice.started === mS + 1);
  key("keydown", { key: "Escape" }); await sleep(60);

  console.log("\n=== 'C' no longer triggers dictation (belongs to highlights.js) ===");
  TTS.play(); await sleep(40);
  const cS = voice.started;
  const eC = key("keydown", { key: "c" }); await sleep(60);
  ok("C did NOT start a recording", voice.started === cS, `${cS} -> ${voice.started}`);
  ok("C was not consumed by the TTS handler", !eC.defaultPrevented);
  ok("still just playing", I.playing && I.micState === "idle",
     `playing=${I.playing} micState=${I.micState}`);

  console.log("\n=== both styles reach the same state ===");
  // hold-Space and D must leave micState identical.
  TTS.play(); await sleep(40);
  spaceDown(); await sleep(500);
  const viaSpace = I.micState;
  key("keydown", { key: "Escape" }); await sleep(50); spaceUp();
  TTS.play(); await sleep(40);
  key("keydown", { key: "d" }); await sleep(60);
  const viaD = I.micState;
  key("keydown", { key: "Escape" }); await sleep(50);
  ok("hold-Space and D produce the same state", viaSpace === viaD && viaD === "recording",
     `space=${viaSpace} d=${viaD}`);


  console.log("\n=== bare Option tap toggles dictation ===");
  voice.hasKey = true;
  TTS.attach("doc_alt");
  TTS.play(); await sleep(40);
  const aS = voice.started;
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("bare Option started recording", I.micState === "recording", "micState=" + I.micState);
  ok("startRecording called once", voice.started === aS + 1, `${aS} -> ${voice.started}`);
  const savedA = saved.filter(s => s.text).length;
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(140);
  ok("second Option tap saved and stopped", I.micState === "idle", "micState=" + I.micState);
  ok("comment saved", saved.filter(s => s.text).length === savedA + 1);

  console.log("\n=== Option COMBOS must not trigger it ===");
  TTS.play(); await sleep(40);
  const cS2 = voice.started;

  // Option + ArrowLeft (word-wise cursor movement)
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  key("keydown", { key: "ArrowLeft", altKey: true });
  key("keyup",   { key: "ArrowLeft", altKey: true });
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("Option+ArrowLeft did NOT record", voice.started === cS2, `${cS2} -> ${voice.started}`);

  // Option + e  (typing an accent)
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  key("keydown", { key: "e", altKey: true });
  key("keyup",   { key: "e", altKey: true });
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("Option+e did NOT record", voice.started === cS2, `${cS2} -> ${voice.started}`);

  // Option + click
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  dom.window.document.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("Option+click did NOT record", voice.started === cS2, `${cS2} -> ${voice.started}`);

  // Option + scroll
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  dom.window.document.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true }));
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("Option+scroll did NOT record", voice.started === cS2, `${cS2} -> ${voice.started}`);

  // Cmd+Option (a real chord)
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true, metaKey: true });
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false, metaKey: true });
  await sleep(60);
  ok("Cmd+Option did NOT record", voice.started === cS2, `${cS2} -> ${voice.started}`);

  console.log("\n=== losing focus mid-press does not leave it armed ===");
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  dom.window.dispatchEvent(new dom.window.Event("blur"));
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("blurred Option press did NOT record", voice.started === cS2, `${cS2} -> ${voice.started}`);

  console.log("\n=== Option still works right after a disqualified press ===");
  const rS = voice.started;
  key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  key("keyup",   { key: "Alt", code: "AltLeft", altKey: false });
  await sleep(60);
  ok("recovers on the next bare tap", voice.started === rS + 1, `${rS} -> ${voice.started}`);
  key("keydown", { key: "Escape" }); await sleep(60);

  console.log("\n=== no dictation without a Groq key ===");
  voice.hasKey = false;
  TTS.attach("doc_test3");
  spaceDown(); await sleep(40); spaceUp(); await sleep(30);  // play
  const s1 = voice.started;
  spaceDown(); await sleep(500);
  ok("no recording attempted", voice.started === s1, `${s1} -> ${voice.started}`);
  ok("state stayed idle", I.micState === "idle", "micState=" + I.micState);
  spaceIsUpHack();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

// Releasing space after an Escape-cancel, so later presses start clean.
function spaceIsUpHack() { spaceUp(); }

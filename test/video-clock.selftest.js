/*
 * Tests that on a video document the dictate key drives the VIDEO, not the
 * reader — which is the fix for "I pressed Option and nothing happened".
 * The real cause was iframe focus theft; this covers the routing half.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const BAR = `<div id="tts-bar">
  <button id="tts-prev"></button><button id="tts-play"></button><button id="tts-next"></button>
  <button id="tts-rate"></button><select id="tts-engine"></select><select id="tts-voice"></select>
  <span id="tts-eta"></span><button id="tts-mic"></button>
  <button id="tts-help-btn"></button><button id="tts-close"></button></div>`;
const dom = new JSDOM(
  `<!doctype html><body><div id="view-reader" class="active"><div id="article">` +
  `<p id="l1" data-t="0">First line spoken.</p>` +
  `<p id="l2" data-t="10">Second line spoken.</p></div></div>${BAR}</body>`,
  { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined; global.Highlight = undefined; global.navigator = dom.window.navigator;
global.speechSynthesis = { cancel(){}, speak(){}, getVoices:()=>[{name:"V",lang:"en-US",localService:true}], onvoiceschanged:null };
global.SpeechSynthesisUtterance = function(t){ this.text=t; };

const voice = { started:0 };
global.Voice = {
  hasKey: ()=>true,
  startRecording: async()=>{ voice.started++; return {id:1}; },
  stopRecordingRaw: async()=>({size:5000,type:"audio/webm"}),
  transcribe: async()=>"a spoken note",
  isRetryable: ()=>false, cancelRecording: ()=>{},
};
const hl = { created:[], removed:[] };
global.Highlights = {
  createHighlightFromRange: (r)=>{ const id="hl_"+(hl.created.length+1); hl.created.push({id, text:r.toString().trim()}); return id; },
  removeHighlight: (id)=>hl.removed.push(id), hideToolbar: ()=>{},
};
const saved = [];
global.Comments = { addComment:(h,t,d)=>{saved.push({h,t,d}); return "cm";}, openPanelForHighlight:()=>{} };
const store={settings:{}};
global.FolioStore = { getSettings:()=>JSON.parse(JSON.stringify(store.settings)),
  saveSettings:(s)=>{store.settings=JSON.parse(JSON.stringify(s));},
  generateId:(p)=>p+"_x", getHighlights:()=>[], saveHighlights:()=>{},
  getComments:()=>[], saveComments:()=>{} };
global.Reader = { getCurrentDocId: ()=>"doc_vid" };

const src = fs.readFileSync(REPO+"/js/tts.js","utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get micState(){return micState;}, get playing(){return playing;}, "+
  "get micResumeAfter(){return micResumeAfter;} }),\n    init, attach, detach,");
const TTS = eval(src+"; TTS;");

// ── A fake video acting as the external clock.
const vid = { playing:false, pauses:0, resumes:0, activeLine:"l1" };
const clock = {
  isActive: ()=>true,
  isPlaying: ()=>vid.playing,
  pause: ()=>{ vid.playing=false; vid.pauses++; },
  resume: ()=>{ vid.playing=true; vid.resumes++; },
  currentBlockEl: ()=>dom.window.document.getElementById(vid.activeLine),
};

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const key=(type,opts)=>dom.window.document.dispatchEvent(
  new dom.window.KeyboardEvent(type, Object.assign({bubbles:true,cancelable:true},opts)));
const alt=()=>{ key("keydown",{key:"Alt",code:"AltLeft",altKey:true});
                key("keyup",{key:"Alt",code:"AltLeft",altKey:false}); };

TTS.init();
TTS.attach("doc_vid");
TTS.setExternalClock(clock);
const I = TTS.__i();

(async()=>{
  console.log("\n=== Option while the VIDEO is playing ===");
  vid.playing = true; vid.activeLine = "l2";
  hl.created.length = 0;
  alt(); await sleep(60);
  ok("recording started", I.micState==="recording", I.micState);
  ok("the VIDEO was paused", vid.pauses===1 && !vid.playing, `pauses=${vid.pauses} playing=${vid.playing}`);
  ok("reader playback was NOT started", !I.playing, "playing="+I.playing);
  ok("highlight went on the line being spoken",
     hl.created.length===1 && hl.created[0].text==="Second line spoken.",
     JSON.stringify(hl.created));

  console.log("\n=== finishing resumes the VIDEO, not the reader ===");
  alt(); await sleep(140);
  ok("recording ended", I.micState==="idle", I.micState);
  ok("comment saved", saved.length===1, JSON.stringify(saved));
  ok("the VIDEO resumed", vid.resumes===1 && vid.playing, `resumes=${vid.resumes}`);
  ok("reader still not playing", !I.playing);

  console.log("\n=== the highlight follows the playhead ===");
  vid.activeLine = "l1"; hl.created.length = 0; saved.length = 0;
  alt(); await sleep(60);
  ok("now attaches to the first line",
     hl.created[0] && hl.created[0].text==="First line spoken.", JSON.stringify(hl.created));
  alt(); await sleep(140);

  console.log("\n=== Option while the video is PAUSED does not auto-resume ===");
  vid.playing = false; const r0 = vid.resumes;
  alt(); await sleep(60);
  ok("records", I.micState==="recording");
  alt(); await sleep(140);
  ok("stays paused afterwards", vid.resumes===r0 && !vid.playing,
     `resumes ${r0}->${vid.resumes}`);

  console.log("\n=== a Space TAP toggles the video, not the reader ===");
  vid.playing = true; const p0 = vid.pauses;
  key("keydown",{key:" ",code:"Space"}); await sleep(40);
  key("keyup",{key:" ",code:"Space"}); await sleep(40);
  ok("video paused by the tap", vid.pauses===p0+1 && !vid.playing, `pauses=${vid.pauses}`);
  ok("reader never started", !I.playing, "playing="+I.playing);
  const r1 = vid.resumes;
  key("keydown",{key:" ",code:"Space"}); await sleep(40);
  key("keyup",{key:" ",code:"Space"}); await sleep(40);
  ok("second tap resumes the video", vid.resumes===r1+1 && vid.playing, `resumes=${vid.resumes}`);

  console.log("\n=== HOLDING Space dictates, and resumes the video after ===");
  vid.playing = true; const p1 = vid.pauses, r2 = vid.resumes;
  saved.length = 0;
  key("keydown",{key:" ",code:"Space"});
  await sleep(500);                       // past the hold threshold
  ok("hold started recording", I.micState==="recording", I.micState);
  ok("video paused for it", vid.pauses===p1+1 && !vid.playing);
  key("keyup",{key:" ",code:"Space"}); await sleep(60);
  ok("still recording after release (latched)", I.micState==="recording");
  key("keydown",{key:" ",code:"Space"}); await sleep(140);
  ok("saved", saved.length===1, JSON.stringify(saved));
  ok("video resumed", vid.resumes===r2+1 && vid.playing, `resumes=${vid.resumes}`);

  console.log("\n=== with no clock registered, everything reverts to the reader ===");
  TTS.setExternalClock(null);
  const p2 = vid.pauses;
  key("keydown",{key:" ",code:"Space"}); await sleep(40);
  key("keyup",{key:" ",code:"Space"}); await sleep(40);
  ok("video untouched", vid.pauses===p2, `pauses=${vid.pauses}`);
  ok("reader took over", I.playing, "playing="+I.playing);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail?1:0);
})();

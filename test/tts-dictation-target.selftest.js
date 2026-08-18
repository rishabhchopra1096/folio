/*
 * Two behaviours:
 *   1. A dictation attaches to text you SELECTED by hand, if there is one —
 *      falling back to the playhead's paragraph only when there isn't.
 *      Playback pauses either way, and resumes afterwards.
 *   2. A dictation that produces no comment takes its highlight with it,
 *      instead of leaving the document marked up for nothing.
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
  `<p id="p1">Alpha paragraph with several words in it here.</p>` +
  `<p id="p2">Bravo paragraph is the second one entirely.</p>` +
  `</div></div>${BAR}</body>`, { pretendToBeVisual: true });

global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined; global.Highlight = undefined; global.navigator = dom.window.navigator;
global.speechSynthesis = { cancel(){}, speak(){}, getVoices:()=>[{name:"V",lang:"en-US",localService:true}], onvoiceschanged:null };
global.SpeechSynthesisUtterance = function(t){ this.text=t; };

const voice = { hasKey:true, started:0, transcript:"a note" };
global.Voice = {
  hasKey: ()=>voice.hasKey,
  startRecording: async()=>{ voice.started++; return {id:1}; },
  stopRecordingRaw: async()=>({size:5000,type:"audio/webm"}),
  transcribe: async()=>{ if (voice.transcript === null) throw new Error("Groq rejected the key."); return voice.transcript; },
  isRetryable: (e)=> (e.message||"").toLowerCase().includes("network"),
  cancelRecording: ()=>{},
};

// Highlights stub that records the exact TEXT each highlight covers.
const hl = { created: [], removed: [] };
global.Highlights = {
  createHighlightFromRange: (range) => {
    const id = "hl_" + (hl.created.length + 1);
    hl.created.push({ id, text: range.toString().trim() });
    return id;
  },
  removeHighlight: (id) => { hl.removed.push(id); },
  hideToolbar: () => {},
};
const saved = [];
global.Comments = { addComment:(h,t,d)=>{ saved.push({h,t,d}); return "cm"; }, openPanelForHighlight:()=>{} };
const store={settings:{}};
global.FolioStore = { getSettings:()=>JSON.parse(JSON.stringify(store.settings)),
  saveSettings:(s)=>{store.settings=JSON.parse(JSON.stringify(s));},
  generateId:(p)=>p+"_x", getHighlights:()=>[], saveHighlights:()=>{},
  getComments:()=>[], saveComments:()=>{} };
global.Reader = { getCurrentDocId: ()=>"doc_1" };

const src = fs.readFileSync(REPO+"/js/tts.js","utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get micState(){return micState;}, get playing(){return playing;}, "+
  "get micHighlightId(){return micHighlightId;}, dictationTargetRange, beginDictation, "+
  "finishDictation, cancelDictation, get docText(){return docText;}, "+
  "setCur:(p)=>{curWord={ds:p,de:p+4};} }),\n    init, attach, detach,");
const TTS = eval(src+"; TTS;");

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

function selectText(elId, from, to) {
  const el = dom.window.document.getElementById(elId);
  const tn = el.firstChild;
  const r = dom.window.document.createRange();
  r.setStart(tn, from); r.setEnd(tn, to);
  const s = dom.window.getSelection();
  s.removeAllRanges(); s.addRange(r);
  return r.toString();
}

TTS.init(); TTS.attach("doc_1");
const I = TTS.__i();

(async function(){
  console.log("\n=== NO selection: attaches to the playhead's paragraph ===");
  const p2at = I.docText.indexOf("Bravo");
  I.setCur(p2at + 4);
  dom.window.getSelection().removeAllRanges();
  TTS.play(); await sleep(30);
  ok("playing", I.playing);
  hl.created.length = 0;
  await I.beginDictation(); await sleep(50);
  ok("recording", I.micState === "recording", I.micState);
  ok("paused for dictation", !I.playing);
  ok("highlighted the whole paragraph 2",
     hl.created.length===1 && hl.created[0].text.startsWith("Bravo paragraph"),
     JSON.stringify(hl.created));
  await I.finishDictation(); await sleep(80);
  ok("resumed after saving", I.playing, "playing="+I.playing);

  console.log("\n=== WITH a manual selection: attaches to the SELECTION ===");
  hl.created.length = 0; saved.length = 0;
  I.setCur(p2at + 4);                       // playhead is in paragraph 2 …
  const selText = selectText("p1", 0, 15);  // … but the user selected from paragraph 1
  ok("selection made", selText === "Alpha paragraph", JSON.stringify(selText));
  TTS.play(); await sleep(30);
  ok("playing before Option", I.playing);
  await I.beginDictation(); await sleep(50);
  ok("PAUSED even though a selection was used", !I.playing, "playing="+I.playing);
  ok("highlight covers the SELECTION, not the playhead paragraph",
     hl.created.length===1 && hl.created[0].text === "Alpha paragraph",
     JSON.stringify(hl.created));
  ok("selection cleared afterwards",
     dom.window.getSelection().isCollapsed || dom.window.getSelection().rangeCount===0,
     "rangeCount="+dom.window.getSelection().rangeCount);
  await I.finishDictation(); await sleep(80);
  ok("comment saved", saved.length===1, JSON.stringify(saved));
  ok("RESUMED after commenting on a selection", I.playing, "playing="+I.playing);

  console.log("\n=== a selection outside the article is ignored ===");
  hl.created.length = 0;
  const outside = dom.window.document.createRange();
  outside.selectNodeContents(dom.window.document.getElementById("tts-bar"));
  const s = dom.window.getSelection(); s.removeAllRanges(); s.addRange(outside);
  I.setCur(p2at + 4);
  await I.beginDictation(); await sleep(50);
  ok("fell back to the playhead paragraph",
     hl.created.length===1 && hl.created[0].text.startsWith("Bravo"),
     JSON.stringify(hl.created));
  I.cancelDictation(); await sleep(40);

  console.log("\n=== CANCEL removes the highlight ===");
  hl.created.length = 0; hl.removed.length = 0;
  dom.window.getSelection().removeAllRanges();
  I.setCur(p2at + 4);
  await I.beginDictation(); await sleep(50);
  const madeId = hl.created[0].id;
  ok("a highlight was created", !!madeId, madeId);
  I.cancelDictation(); await sleep(40);
  ok("cancelling REMOVED that highlight", hl.removed.includes(madeId),
     "removed=" + JSON.stringify(hl.removed));
  ok("no stale reference kept", I.micHighlightId === null, String(I.micHighlightId));

  console.log("\n=== silence removes the highlight too ===");
  hl.created.length=0; hl.removed.length=0; voice.transcript = "";
  await I.beginDictation(); await sleep(50);
  const silentId = hl.created[0].id;
  await I.finishDictation(); await sleep(80);
  ok("empty transcript removed its highlight", hl.removed.includes(silentId),
     JSON.stringify(hl.removed));

  console.log("\n=== a permanent failure removes it; a retryable one KEEPS it ===");
  hl.created.length=0; hl.removed.length=0; voice.transcript = null;   // throws non-retryable
  await I.beginDictation(); await sleep(50);
  const badId = hl.created[0].id;
  await I.finishDictation(); await sleep(80);
  ok("bad-key failure removed the highlight", hl.removed.includes(badId),
     JSON.stringify(hl.removed));

  hl.created.length=0; hl.removed.length=0;
  global.Voice.transcribe = async()=>{ throw new Error("Network error contacting Groq"); };
  await I.beginDictation(); await sleep(50);
  const queuedId = hl.created[0].id;
  await I.finishDictation(); await sleep(80);
  ok("queued-for-retry KEPT its highlight (the comment is still coming)",
     !hl.removed.includes(queuedId), JSON.stringify(hl.removed));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail?1:0);
})();

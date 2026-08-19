/*
 * A comment made BEFORE the transcript exists is anchored to a moment in the
 * video, and gets re-pointed at the right line once the transcript arrives.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const PANEL = `<div id="comments-panel"><div class="comments-header"></div>
  <div id="comments-list"></div><textarea id="comment-input"></textarea>
  <button id="comment-submit"></button><button id="comment-cancel"></button>
  <button id="comments-close"></button><button id="comments-export"></button>
  <button id="comments-new-note"></button><button id="comment-mic-btn"></button>
  <div id="comments-resize"></div></div>`;
const dom = new JSDOM(`<!doctype html><body>
  <div id="view-reader" class="active"><div id="article"></div></div>${PANEL}</body>`,
  { url:"https://x.test", pretendToBeVisual:true });
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
global.Gemini = { formatTime:(s)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`,
                  parseYouTube:()=>({videoId:"AP8nlJcjw4I",url:"u",start:0}), hasKey:()=>true };
global.TTS = { setExternalClock:()=>{}, toast:()=>{} };

const store = { comments: [], settings: {} };
global.FolioStore = {
  getSettings:()=>JSON.parse(JSON.stringify(store.settings)),
  saveSettings:(s)=>{store.settings=JSON.parse(JSON.stringify(s));},
  getComments:()=>store.comments,
  saveComments:(_d,c)=>{store.comments=c;},
  getHighlights:()=>[], saveHighlights:()=>{},
  generateId:(p)=>p+"_"+Math.random().toString(36).slice(2,7),
  getDocument:()=>({meta:{title:"v"},content:{blocks:[]}}), updateDocument:()=>{},
};
global.Reader = { getCurrentDocId:()=>"doc_v", renderDocument:()=>{} };

const madeHighlights = [];
global.Highlights = {
  createHighlightFromRange: (r) => {
    const id = "hl_" + (madeHighlights.length+1);
    madeHighlights.push({ id, text: r.toString().trim() });
    return id;
  },
  removeHighlight:()=>{}, hideToolbar:()=>{},
};

const csrc = fs.readFileSync(REPO+"/js/comments.js","utf8");
const Comments = eval(csrc + "; Comments;");
global.Comments = Comments;
/* Inject test hooks on a stable anchor, and ASSERT the injection landed —
   anchoring on the first exported name meant that renaming or adding an export
   silently disabled the hooks, and the test then failed much later with a
   confusing "not a function". */
const HOOK = "  return {\n    __reconcile: reconcileTimedComments, __indexForTime: indexForTime,\n";
const rawV = fs.readFileSync(REPO+"/js/video.js","utf8");
const marker = "  return {\n";
const lastReturn = rawV.lastIndexOf(marker);
if (lastReturn === -1) { console.error("could not find the Video export block"); process.exit(1); }
const vsrc = rawV.slice(0, lastReturn) + HOOK + rawV.slice(lastReturn + marker.length);
const Video = eval(vsrc + "; Video;");
if (typeof Video.__indexForTime !== "function" || typeof Video.__reconcile !== "function") {
  console.error("test hooks failed to inject — the export block shape changed");
  process.exit(1);
}

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

console.log("\n=== a comment with no line records WHERE in the video it was said ===");
Comments.addComment(null, "Great point here.", "doc_v", 72.4);
Comments.addComment(null, "And this bit.",     "doc_v", 137.0);
Comments.addComment(null, "Just a plain note", "doc_v");        // no time
ok("three comments stored", store.comments.length===3, String(store.comments.length));
ok("timed ones carry videoTime",
   store.comments[0].videoTime===72.4 && store.comments[1].videoTime===137,
   JSON.stringify(store.comments.map(c=>c.videoTime)));
ok("the untimed one does not", store.comments[2].videoTime===undefined);
ok("all start as general notes", store.comments.every(c=>c.isGeneral && !c.highlightId));

console.log("\n=== listTimed finds only the ones awaiting a line ===");
const timed = Comments.listTimed("doc_v");
ok("two awaiting", timed.length===2, String(timed.length));
ok("plain note excluded", !timed.some(c=>c.text==="Just a plain note"));

console.log("\n=== which line contains a given moment ===");
const segs = [ {start:0,text:"Zero."}, {start:65,text:"Sixty-five."},
               {start:130,text:"One thirty."}, {start:200,text:"Two hundred."} ];
const at = (t)=>Video.__indexForTime(segs, t);
ok("t=0    -> line 0", at(0)===0,   String(at(0)));
ok("t=72.4 -> line 1", at(72.4)===1, String(at(72.4)));
ok("t=137  -> line 2", at(137)===2,  String(at(137)));
ok("t=999  -> last",   at(999)===3,  String(at(999)));
ok("t=null -> none",   at(null)===-1, String(at(null)));

console.log("\n=== once the transcript lands, they attach to the right lines ===");
document.getElementById("article").innerHTML =
  segs.map(s=>`<p data-t="${s.start}">${s.text}</p>`).join("");
Video.__reconcile("doc_v", segs);

const c0 = store.comments.find(c=>c.text==="Great point here.");
const c1 = store.comments.find(c=>c.text==="And this bit.");
const c2 = store.comments.find(c=>c.text==="Just a plain note");
ok("first comment now has a highlight", !!c0.highlightId, String(c0.highlightId));
ok("second comment now has a highlight", !!c1.highlightId, String(c1.highlightId));
ok("no longer general", !c0.isGeneral && !c1.isGeneral);
ok("the untimed note is untouched", !c2.highlightId && c2.isGeneral);

console.log("\n=== each landed on the line whose window contains its moment ===");
const h0 = madeHighlights.find(h=>h.id===c0.highlightId);
const h1 = madeHighlights.find(h=>h.id===c1.highlightId);
ok("72.4s -> the 1:05 line", h0 && h0.text==="Sixty-five.", h0 && h0.text);
ok("137s  -> the 2:10 line", h1 && h1.text==="One thirty.", h1 && h1.text);

console.log("\n=== reconciling twice doesn't duplicate ===");
const before = madeHighlights.length;
Video.__reconcile("doc_v", segs);
ok("no new highlights created", madeHighlights.length===before,
   `${before} -> ${madeHighlights.length}`);
ok("nothing left awaiting", Comments.listTimed("doc_v").length===0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

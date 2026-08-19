/* Tests video-block rendering and the transcript sync index. No network. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM(`<!doctype html><body>
  <div id="progress-bar"></div><div id="progress-bar-wrap"></div>
  <div id="progress-ring-wrap"><svg><circle id="ring-fill"/></svg><span id="ring-pct"></span></div>
  <div id="view-reader" class="active"><div id="article"></div></div>
</body>`, { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;

const Gemini = eval(fs.readFileSync(REPO+"/js/gemini.js","utf8") + "; Gemini;");
global.Gemini = Gemini;

// Reader needs a store; only blocksToHtml is under test here.
global.FolioStore = { getDocument:()=>null, getSettings:()=>({}), saveSettings:()=>{},
                      countWordsInBlocks:()=>0, updateDocument:()=>{}, createDocument:()=>({id:"d"}) };
const Reader = eval(fs.readFileSync(REPO+"/js/reader.js","utf8") + "; Reader;");
global.Reader = Reader;
global.TTS = { setExternalClock: ()=>{}, toast: ()=>{} };
const Video = eval(fs.readFileSync(REPO+"/js/video.js","utf8") + "; Video;");

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

console.log("\n=== video block renders a placeholder ===");
let html = Reader.blocksToHtml([{type:"video",data:{videoId:"jNQXAC9IVRw",start:12}}]);
ok("emits .folio-video", /class="folio-video"/.test(html), html.slice(0,90));
ok("carries the video id", /data-video-id="jNQXAC9IVRw"/.test(html));
ok("carries the start time", /data-start="12"/.test(html));
ok("shows a loading state", /Loading player/.test(html));

console.log("\n=== a bogus video id is refused (no injection) ===");
[`"><script>alert(1)</script>`, "short", "", "../../etc/passwd"].forEach(bad => {
  const h = Reader.blocksToHtml([{type:"video",data:{videoId:bad}}]);
  ok("rejects " + JSON.stringify(bad).slice(0,24), h === "", h.slice(0,60));
});

console.log("\n=== transcript paragraphs ===");
html = Reader.blocksToHtml([{type:"paragraph",data:{text:"Hello there.",t:65}}]);
ok("carries data-t", /data-t="65"/.test(html), html);
ok("has a timestamp chip", /class="video-ts"/.test(html));
ok("chip is formatted 1:05", />1:05</.test(html), html);
ok("keeps the text", /Hello there\./.test(html));

html = Reader.blocksToHtml([{type:"paragraph",data:{text:"Ordinary."}}]);
ok("a plain paragraph is untouched", html === "<p>Ordinary.</p>", html);

console.log("\n=== segment index + lookup ===");
document.getElementById("article").innerHTML = Reader.blocksToHtml([
  {type:"video",data:{videoId:"jNQXAC9IVRw"}},
  {type:"paragraph",data:{text:"Zero.",  t:0}},
  {type:"paragraph",data:{text:"Ten.",   t:10}},
  {type:"paragraph",data:{text:"Twenty.",t:20}},
  {type:"paragraph",data:{text:"Thirty.",t:30}},
]);
Video._indexSegments();
const at = (t)=>Video._segmentAt(t);
ok("t=0 -> first line",      at(0)===0,  String(at(0)));
ok("t=5 -> still first",     at(5)===0,  String(at(5)));
ok("t=10 -> second exactly", at(10)===1, String(at(10)));
ok("t=19.9 -> second",       at(19.9)===1, String(at(19.9)));
ok("t=20 -> third",          at(20)===2, String(at(20)));
ok("t=999 -> last",          at(999)===3, String(at(999)));
ok("t=-1 -> none",           at(-1)===-1, String(at(-1)));

console.log("\n=== lookup is monotonic across the whole timeline ===");
let mono = true, prev = -1;
for (let t=0; t<=35; t+=0.25) { const i=at(t); if (i<prev) { mono=false; break; } prev=i; }
ok("index never goes backwards as time advances", mono);

console.log("\n=== empty transcript is safe ===");
document.getElementById("article").innerHTML = "<p>no timestamps here</p>";
Video._indexSegments();
ok("no segments found", Video._segmentAt(5) === -1, String(Video._segmentAt(5)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

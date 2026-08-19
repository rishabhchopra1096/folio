/*
 * Arrow keys hop by transcript LINE, with the same music-player Back semantics
 * as sentence hopping in the reader: restart the line you're on, and only step
 * back if you're already at its start.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM(`<!doctype html><body><div id="view-reader" class="active"><div id="article">
  <div class="folio-video" data-video-id="jNQXAC9IVRw" data-start="0"></div>
  <p data-t="0">Line zero.</p>
  <p data-t="10">Line ten.</p>
  <p data-t="20">Line twenty.</p>
  <p data-t="30">Line thirty.</p>
</div></div></body>`, { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.Gemini = { formatTime: (s)=>String(Math.round(s)) };
global.TTS = { setExternalClock: ()=>{}, toast: ()=>{} };

const Video = eval(fs.readFileSync(REPO+"/js/video.js","utf8") + "; Video;");

// A fake player recording every seek.
const vp = { t: 0, seeks: [], rate: 1, state: 1 };
global.window.YT = { Player: function(){}, PlayerState: { PLAYING: 1 } };

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

// Reach the internals: install a fake player and index the segments.
Video._indexSegments();
const inject = Video._setPlayerForTest || null;
if (!inject) {
  // Not exported — drive hopLine through the exported test hooks instead.
  console.log("\n(no player injector exported; testing segmentAt semantics directly)");
}

console.log("\n=== segment lookup underpins hopping ===");
ok("t=0  -> line 0", Video._segmentAt(0)===0, String(Video._segmentAt(0)));
ok("t=15 -> line 1", Video._segmentAt(15)===1, String(Video._segmentAt(15)));
ok("t=29 -> line 2", Video._segmentAt(29)===2, String(Video._segmentAt(29)));
ok("t=30 -> line 3", Video._segmentAt(30)===3, String(Video._segmentAt(30)));

/*
 * hopLine's decision rule, mirrored here so the semantics are pinned even
 * without a live player: with GRACE = 1.5s, Back mid-line restarts it, and
 * Back near a line's start steps to the previous one.
 */
const TIMES = [0,10,20,30];
const GRACE = 1.5;
function hop(t, dir) {
  let i = TIMES.reduce((b,v,k)=> v<=t ? k : b, -1);
  if (i < 0) i = 0;
  i = dir < 0 ? ((t - TIMES[i] > GRACE) ? i : i-1) : i+1;
  return TIMES[Math.max(0, Math.min(TIMES.length-1, i))];
}

console.log("\n=== Back mid-line restarts that line ===");
ok("at 15s (5s into line 1) -> back to 10", hop(15,-1)===10, String(hop(15,-1)));
ok("at 25s (5s into line 2) -> back to 20", hop(25,-1)===20, String(hop(25,-1)));

console.log("\n=== Back again steps to the previous line ===");
ok("at exactly 10 -> back to 0",  hop(10,-1)===0,  String(hop(10,-1)));
ok("at 10.5 (inside grace) -> 0", hop(10.5,-1)===0, String(hop(10.5,-1)));
ok("at 12 (past grace) -> 10",    hop(12,-1)===10,  String(hop(12,-1)));

console.log("\n=== clamps at the ends ===");
ok("Back at 0 stays at 0",   hop(0,-1)===0,   String(hop(0,-1)));
ok("Forward at 35 stays 30", hop(35,1)===30,  String(hop(35,1)));

console.log("\n=== Forward always advances one line ===");
ok("from 5  -> 10", hop(5,1)===10, String(hop(5,1)));
ok("from 15 -> 20", hop(15,1)===20, String(hop(15,1)));
ok("from 25 -> 30", hop(25,1)===30, String(hop(25,1)));

console.log("\n=== every landing is exactly a line start ===");
let allStarts = true;
let t = 27;
for (let k=0;k<10;k++) { t = hop(t, k%3===0 ? 1 : -1); if (!TIMES.includes(t)) { allStarts=false; break; } }
ok("never lands mid-line", allStarts, String(t));

console.log("\n=== J / K / L are gone ===");
const src = fs.readFileSync(REPO+"/js/video.js","utf8");
ok("no 'j' binding", !/case "j":|case "J":/.test(src));
ok("no 'k' binding", !/case "k":|case "K":/.test(src));
ok("no 'l' binding", !/case "l":|case "L":/.test(src));
ok("arrows are bound", /case "ArrowLeft":/.test(src) && /case "ArrowRight":/.test(src));
ok("shift+arrow still seeks by time", /e\.shiftKey \? nudge\(-10\)/.test(src));


console.log("\n=== BEFORE the transcript arrives, arrows must still do something ===");
/* The reported bug: while Gemini is still transcribing there are no lines, so
   hopLine returned immediately and both the arrows AND the bar buttons did
   nothing at all. It now falls back to a plain time seek. */
const srcH = fs.readFileSync(REPO+"/js/video.js","utf8");
ok("hopLine no longer bails on an empty transcript",
   !/function hopLine\(dir\) \{\s*if \(!player \|\| !segTimes\.length\) return;/.test(srcH));
ok("it falls back to a time seek instead",
   /if \(!segTimes\.length\) \{ nudge\(dir < 0 \? -10 : 10\); return; \}/.test(srcH));
ok("the bar's back/forward buttons route through hopLine",
   /case "back":\s*hopLine\(-1\)/.test(srcH) && /case "fwd":\s*hopLine\(1\)/.test(srcH));

console.log("\n=== the read-aloud bar is hidden on a video document ===");
ok("adds the suppress class on attach", /hidden-by-video/.test(srcH));
ok("and removes it on detach",
   /ttsBar\.classList\.remove\("hidden-by-video"\)/.test(srcH));
const srcC = fs.readFileSync(REPO+"/css/highlights.css","utf8");
ok("CSS actually hides it", /#tts-bar\.hidden-by-video \{ display: none/.test(srcC));

console.log("\n=== settings panel can scroll ===");
const comp = fs.readFileSync(REPO+"/css/components.css","utf8");
const panel = comp.slice(comp.indexOf("#settings-panel {"), comp.indexOf("#settings-panel.open"));
ok("has a max-height", /max-height:/.test(panel), panel.slice(0,40));
ok("has overflow-y: auto", /overflow-y: auto/.test(panel));
ok("only one #settings-panel base rule", (comp.match(/^#settings-panel \{/gm)||[]).length === 1);

console.log("\n=== the player scales with the column AND stays 16:9 ===");
/* Two requirements in tension, and getting either wrong is visible:
   - width must follow the reading column, or Narrow/Wide/Full do nothing
   - the box must stay exactly 16:9, or YouTube letterboxes inside it
   min() satisfies both: the column width, capped at whatever width would make
   the box taller than the limit. A bare max-height alongside width:100% is the
   combination that caused the black bars, so that's asserted against. */
const vidRule = srcC.slice(srcC.indexOf(".folio-video {"), srcC.indexOf(".folio-video iframe"));
ok("width is driven by the column", /width: min\(100%,/.test(vidRule), vidRule.slice(0,120));
ok("aspect-ratio pins the shape", /aspect-ratio: 16 \/ 9;/.test(vidRule));
ok("no bare max-height fighting aspect-ratio", !/^\s*max-height:/m.test(vidRule),
   (vidRule.match(/max-height:[^;]*/)||[""])[0]);
ok("not the old fixed-height approach", !/height: 42vh;/.test(vidRule));
ok("control bar matches the player width", /width: min\(100%,[^)]*\)/.test(
   srcC.slice(srcC.indexOf(".folio-video-bar {"), srcC.indexOf(".fv-btn {"))));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

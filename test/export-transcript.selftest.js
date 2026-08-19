/* Transcript export: the full transcript with comments under the lines they
   belong to, and general notes at the top. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const PANEL = `<div id="comments-panel"><div class="comments-header"></div>
  <div id="comments-list"></div><textarea id="comment-input"></textarea>
  <button id="comment-submit"></button><button id="comment-cancel"></button>
  <button id="comments-close"></button><button id="comments-export"></button>
  <button id="comments-new-note"></button><button id="comment-mic-btn"></button>
  <div id="comments-resize"></div></div>`;
const dom = new JSDOM(`<!doctype html><body>${PANEL}</body>`, { url:"https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
global.Gemini = { formatTime:(s)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}` };
global.Voice = { hasKey:()=>false };

const blocks = [
  { type:"video", data:{ videoId:"AP8nlJcjw4I", url:"https://www.youtube.com/watch?v=AP8nlJcjw4I" } },
  { type:"paragraph", data:{ text:"Welcome to the playthrough.", t:0 } },
  { type:"paragraph", data:{ text:"[shows] Pokedex reads 0 / 151.", t:65 } },
  { type:"paragraph", data:{ text:"Time to pick a starter.", t:130 } },
];
const highlights = [
  { id:"hl_a", text:"[shows] Pokedex reads 0 / 151." },
  { id:"hl_b", text:"Time to pick a starter." },
];
const comments = [
  { id:"c1", highlightId:null, isGeneral:true, text:"Ok, that's cool.", createdAt:"2026-08-19T09:59:00Z" },
  { id:"c2", highlightId:"hl_a", text:"Counter starts at zero — good baseline.", createdAt:"2026-08-19T10:00:30Z" },
  { id:"c3", highlightId:"hl_b", text:"This is the\nreal decision point.", createdAt:"2026-08-19T10:01:30Z" },
  { id:"c4", highlightId:"hl_gone", text:"Orphan comment.", createdAt:"2026-08-19T10:02:00Z" },
];

global.FolioStore = {
  getSettings:()=>({}), saveSettings:()=>{},
  getDocument:()=>({ meta:{title:"Pokémon Red 100%"}, content:{blocks} }),
  getHighlights:()=>highlights, getComments:()=>comments,
  saveComments:()=>{}, generateId:(p)=>p+"_x",
};
global.Reader = { getCurrentDocId:()=>"doc_v" };

let captured = "";
global.Blob = class { constructor(parts){ captured = parts[0]; } };
dom.window.URL.createObjectURL = () => "blob:x";
dom.window.URL.revokeObjectURL = () => {};
const realCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (tag === "a") el.click = () => {};
  return el;
};

// Expose the exporter without running init().
const src = fs.readFileSync(REPO+"/js/comments.js","utf8")
  .replace("  return {\n    init,", "  return {\n    __export: exportAnnotations,\n    init,");
const C = eval(src + "; Comments;");
C.__export();

const out = captured || "";
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

console.log("\n--- exported markdown ---\n" + out + "\n-------------------------");

console.log("\n=== header ===");
ok("document title",   /^# Pokémon Red 100%/m.test(out));
ok("video URL",        /youtube\.com\/watch\?v=AP8nlJcjw4I/.test(out));
ok("Notes section",    /## Notes/.test(out));
ok("general note",     /- Ok, that's cool\./.test(out));
ok("Transcript section", /## Transcript/.test(out));

console.log("\n=== the WHOLE transcript is present, not just commented lines ===");
ok("0:00 line", /\*\*\[0:00\]\*\* Welcome to the playthrough\./.test(out));
ok("1:05 line", /\*\*\[1:05\]\*\* \[shows\] Pokedex reads 0 \/ 151\./.test(out));
ok("2:10 line", /\*\*\[2:10\]\*\* Time to pick a starter\./.test(out));

console.log("\n=== comments sit under their own line ===");
const iL=out.indexOf("[1:05]"), iC=out.indexOf("Counter starts at zero"), iN=out.indexOf("[2:10]");
ok("after its line",  iC>iL, `${iL} -> ${iC}`);
ok("before the next", iC<iN, `${iC} -> ${iN}`);
ok("marked as a comment", /> 💬 Counter starts at zero/.test(out));
ok("second comment on its own line", /> 💬 This is the real decision point\./.test(out));

console.log("\n=== robustness ===");
ok("multi-line comment flattened", !/decision\n/.test(out));
ok("orphan comment not lost", /Orphan comment\./.test(out));
ok("[shows] prefix preserved", /\[shows\]/.test(out));
ok("no raw HTML leaked", !/<[a-z]/i.test(out), (out.match(/<[a-z][^>]*>/i)||[""])[0]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

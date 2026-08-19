(async()=>{
/* Tests the streaming JSONL parser and the pending/resume registry. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;
global.TextDecoder = require("util").TextDecoder;
const Gemini = eval(fs.readFileSync(REPO+"/js/gemini.js","utf8") + "; Gemini;");

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

// Build an SSE stream that delivers text in awkward pieces, the way a real
// stream does — split mid-line, mid-JSON, mid-SSE-frame.
function sse(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return { getReader: () => ({ read: async () => i >= chunks.length
      ? { done: true } : { done: false, value: enc.encode(chunks[i++]) } }) };
}
function frame(text, finish) {
  const o = { candidates: [{ content: { parts: [{ text }] } }] };
  if (finish) o.candidates[0].finishReason = finish;
  return "data: " + JSON.stringify(o) + "\n\n";
}

Gemini.setKey("AIzaTEST");

console.log("\n=== lines arrive progressively, split awkwardly ===");
const pushes = [];
global.fetch = async () => ({ ok:true, body: sse([
  frame('{"start": 0, "text": "First line."}\n{"start": 5, '),
  frame('"text": "Second line."}\n'),
  frame('{"start": 10, "text": "Third line."}\n{"start": 15, "text": "Fourth."}', "STOP"),
])});
let segs = await Gemini.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", {
  onSegments: (s) => pushes.push(s.length),
});
ok("all four segments recovered", segs.length===4, JSON.stringify(segs.map(s=>s.start)));
ok("JSON split across chunks reassembled", segs[1].text==="Second line.", segs[1].text);
ok("final line with no trailing newline kept", segs[3].text==="Fourth.", segs[3].text);
ok("onSegments was called during the stream", pushes.length>0, JSON.stringify(pushes));

console.log("\n=== malformed lines cost one line, not the transcript ===");
global.fetch = async () => ({ ok:true, body: sse([
  frame('{"start": 0, "text": "Good one."}\n'),
  frame('not json at all\n'),
  frame('{"start": 5, "text": ""}\n'),          // empty text -> dropped
  frame('{"text": "no start"}\n'),               // missing start -> dropped
  frame('```json\n'),                            // stray fence -> dropped
  frame('{"start": 10, "text": "Good two."}\n', "STOP"),
])});
segs = await Gemini.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", {});
ok("only the two valid lines survive", segs.length===2, JSON.stringify(segs.map(s=>s.text)));

console.log("\n=== out-of-order and duplicate lines are normalised ===");
global.fetch = async () => ({ ok:true, body: sse([
  frame('{"start": 10, "text": "Later."}\n{"start": 2, "text": "Earlier."}\n'),
  frame('{"start": 10, "text": "Later but longer text."}\n', "STOP"),
])});
segs = await Gemini.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", {});
ok("sorted ascending", segs[0].text==="Earlier.", JSON.stringify(segs.map(s=>s.start)));
ok("duplicate start collapsed to the fuller text",
   segs.length===2 && segs[1].text==="Later but longer text.", JSON.stringify(segs));

console.log("\n=== a truncated stream keeps what arrived ===");
const notes=[];
global.fetch = async () => ({ ok:true, body: sse([
  frame('{"start": 0, "text": "Partial transcript."}\n', "MAX_TOKENS"),
])});
segs = await Gemini.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", { onProgress:(m)=>notes.push(m) });
ok("partial result returned rather than thrown away", segs.length===1, JSON.stringify(segs));
ok("and it says so", notes.some(m=>/cut short/i.test(m)), JSON.stringify(notes));

console.log("\n=== an empty stream is an error ===");
global.fetch = async () => ({ ok:true, body: sse([frame("", "STOP")]) });
let threw=false;
try { await Gemini.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", {}); }
catch(e){ threw=/no transcript/i.test(e.message); }
ok("throws a clear error", threw);

console.log("\n=== [shows] lines survive intact ===");
global.fetch = async () => ({ ok:true, body: sse([
  frame('{"start": 3, "text": "[shows] Pokedex reads 0 / 151."}\n', "STOP"),
])});
segs = await Gemini.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", {});
ok("visual line preserved with its prefix",
   segs[0].text==="[shows] Pokedex reads 0 / 151.", segs[0].text);

console.log("\n=== the prompt asks for visuals and JSONL ===");
const src = fs.readFileSync(REPO+"/js/gemini.js","utf8");
ok("asks for what is SHOWN", /what is SHOWN/.test(src));
ok("asks to read numbers exactly", /read them exactly/.test(src));
ok("specifies one object per line", /ONE JSON object per line/.test(src));
ok("no longer says 'spoken audio' only", !/Transcribe the spoken audio of this video/.test(src));
ok("thinking is disabled", /thinkingBudget: 0/.test(src));
ok("sends mime_type on the file part", /mime_type: "video\/mp4"/.test(src));
ok("uses the streaming endpoint", /streamGenerateContent\?alt=sse/.test(src));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
})();

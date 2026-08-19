/* Tests the pure logic in js/gemini.js: URL parsing and segment normalisation.
   No network, no API key. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.URL = dom.window.URL;
const Gemini = eval(fs.readFileSync("/Users/rishabhchopra/Documents/GitHub/folio/js/gemini.js","utf8") + "; Gemini;");

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const ID="dQw4w9WgXcQ";

console.log("\n=== URL shapes people actually paste ===");
[
  ["watch",             `https://www.youtube.com/watch?v=${ID}`],
  ["no www",            `https://youtube.com/watch?v=${ID}`],
  ["mobile",            `https://m.youtube.com/watch?v=${ID}`],
  ["short link",        `https://youtu.be/${ID}`],
  ["embed",             `https://www.youtube.com/embed/${ID}`],
  ["shorts",            `https://www.youtube.com/shorts/${ID}`],
  ["live",              `https://www.youtube.com/live/${ID}`],
  ["with playlist",     `https://www.youtube.com/watch?v=${ID}&list=PLabc&index=2`],
  ["with tracking",     `https://www.youtube.com/watch?v=${ID}&si=xyz&feature=share`],
  ["no protocol",       `youtube.com/watch?v=${ID}`],
  ["whitespace",        `   https://youtu.be/${ID}   `],
].forEach(([label, url]) => {
  const r = Gemini.parseYouTube(url);
  ok(label, r && r.videoId === ID, r ? r.videoId : "null");
});

console.log("\n=== start-time parameter ===");
ok("?t=90 -> 90s",       Gemini.parseYouTube(`https://youtu.be/${ID}?t=90`).start === 90);
ok("?t=1m30s -> 90s",    Gemini.parseYouTube(`https://youtu.be/${ID}?t=1m30s`).start === 90);
ok("?t=1h2m3s -> 3723s", Gemini.parseYouTube(`https://youtu.be/${ID}?t=1h2m3s`).start === 3723);
ok("no t -> 0",          Gemini.parseYouTube(`https://youtu.be/${ID}`).start === 0);

console.log("\n=== rejects non-YouTube ===");
[
  ["vimeo", "https://vimeo.com/123456"],
  ["plain text", "just some words"],
  ["bare domain", "https://youtube.com/"],
  ["bad id length", "https://youtu.be/short"],
  ["empty", ""],
  ["null", null],
  ["lookalike domain", "https://notyoutube.com.evil.test/watch?v="+ID],
].forEach(([label, url]) => ok("rejects " + label, Gemini.parseYouTube(url) === null,
                               JSON.stringify(Gemini.parseYouTube(url))));

console.log("\n=== segment normalisation ===");
const N = Gemini._normalizeSegments;
let segs = N('[{"start":0,"text":"One."},{"start":5.5,"text":"Two."}]');
ok("plain array parsed", segs.length===2 && segs[1].start===5.5, JSON.stringify(segs));

segs = N('```json\n[{"start":1,"text":"Fenced."}]\n```');
ok("code fences stripped", segs.length===1 && segs[0].text==="Fenced.", JSON.stringify(segs));

segs = N('{"segments":[{"start":2,"text":"Wrapped."}]}');
ok("wrapped object accepted", segs.length===1 && segs[0].text==="Wrapped.");

segs = N('[{"start":"1:30","text":"Clock format."}]');
ok('"1:30" -> 90s', segs[0].start===90, String(segs[0].start));
segs = N('[{"start":"01:02:03","text":"Long."}]');
ok('"01:02:03" -> 3723s', segs[0].start===3723, String(segs[0].start));

segs = N('[{"start":10,"text":"Later."},{"start":1,"text":"Earlier."}]');
ok("re-sorted by time", segs[0].text==="Earlier.", JSON.stringify(segs.map(s=>s.text)));

segs = N('[{"start":5,"text":"Short"},{"start":5,"text":"A longer version here"}]');
ok("duplicate starts collapsed, longer kept",
   segs.length===1 && segs[0].text==="A longer version here", JSON.stringify(segs));

segs = N('[{"start":0,"text":"Good."},{"start":1,"text":"  "},{"text":"no start"},{"start":2}]');
ok("unusable segments dropped, good one kept",
   segs.length===1 && segs[0].text==="Good.", JSON.stringify(segs));

let threw=false; try { N("not json at all"); } catch(e){ threw = /valid JSON/.test(e.message); }
ok("bad JSON throws a clear error", threw);
threw=false; try { N('{"foo":1}'); } catch(e){ threw = /list of segments/.test(e.message); }
ok("wrong shape throws a clear error", threw);
ok("empty array is allowed", N("[]").length===0);

console.log("\n=== timestamp formatting ===");
ok("0 -> 0:00",      Gemini.formatTime(0)==="0:00", Gemini.formatTime(0));
ok("65 -> 1:05",     Gemini.formatTime(65)==="1:05", Gemini.formatTime(65));
ok("3723 -> 1:02:03",Gemini.formatTime(3723)==="1:02:03", Gemini.formatTime(3723));
ok("fractional floors", Gemini.formatTime(9.9)==="0:09", Gemini.formatTime(9.9));

console.log("\n=== key storage ===");
ok("starts empty", !Gemini.hasKey());
Gemini.setKey("  AIzaTEST  ");
ok("trimmed on save", Gemini.getKey()==="AIzaTEST", Gemini.getKey());
Gemini.clearKey();
ok("cleared", !Gemini.hasKey());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

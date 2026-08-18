/*
 * Tests sentence navigation.
 *
 * Back has music-player semantics: restart the current sentence, and only step
 * to the previous one if you're already at the start. The decision is made on
 * POSITION, not on timing a double-tap, so these assertions drive it purely by
 * moving the playhead.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const HTML = `<div id="article">
  <p>Alpha one two three four. Bravo five six seven eight. Charlie nine ten eleven.</p>
  <p>Delta twelve thirteen fourteen. Echo fifteen sixteen seventeen.</p>
</div>`;
const dom = new JSDOM(`<!doctype html><body><div id="view-reader" class="active">${HTML}</div></body>`);
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined; global.Highlight = undefined;
global.speechSynthesis = { cancel(){}, speak(){}, getVoices: () => [
  {name:"V",lang:"en-US",localService:true}], onvoiceschanged:null };
global.SpeechSynthesisUtterance = function(t){ this.text = t; };
const store = { settings:{} };
global.FolioStore = { getSettings:()=>JSON.parse(JSON.stringify(store.settings)),
                      saveSettings:(s)=>{store.settings=JSON.parse(JSON.stringify(s));} };

const src = fs.readFileSync(REPO + "/js/tts.js","utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ get docText(){return docText;}, get sentences(){return sentences;}, " +
  "jumpSentence, currentOffset, get curWord(){return curWord;}, " +
  "setCur:(p)=>{curWord={ds:p,de:p+3};} }),\n    init, attach, detach,");
const TTS = eval(src + "; TTS;");
TTS.attach("d");
const I = TTS.__i();

let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const sentText = (s) => I.docText.slice(s.ds, s.de).trim();
const at = () => {
  const p = I.currentOffset();
  const s = I.sentences.find(x => p >= x.ds && p < x.de);
  return s ? `"${sentText(s).slice(0,18)}" +${p - s.ds}` : `(gap @${p})`;
};

console.log("\nsentences found:", I.sentences.length);
I.sentences.forEach((s,i)=>console.log(`  [${i}] "${sentText(s)}"`));

const S = I.sentences;
ok("five sentences detected", S.length === 5, String(S.length));

console.log("\n=== Back mid-sentence restarts THAT sentence ===");
I.setCur(S[2].ds + 20);                       // well into "Charlie…"
ok("start: inside sentence 2", I.currentOffset() === S[2].ds + 20, at());
I.jumpSentence(-1);
ok("landed on start of sentence 2 (not sentence 1)",
   I.currentOffset() === S[2].ds, at());

console.log("\n=== Back again goes to the PREVIOUS sentence ===");
I.jumpSentence(-1);
ok("now at start of sentence 1", I.currentOffset() === S[1].ds, at());

console.log("\n=== a third Back keeps stepping back ===");
I.jumpSentence(-1);
ok("now at start of sentence 0", I.currentOffset() === S[0].ds, at());

console.log("\n=== Back at the very first sentence clamps ===");
I.jumpSentence(-1);
ok("stays at sentence 0", I.currentOffset() === S[0].ds, at());

console.log("\n=== Forward always advances one sentence ===");
I.setCur(S[0].ds + 5);
I.jumpSentence(1);
ok("from mid-sentence 0 -> sentence 1", I.currentOffset() === S[1].ds, at());
I.jumpSentence(1);
ok("-> sentence 2", I.currentOffset() === S[2].ds, at());

console.log("\n=== Forward clamps at the last sentence ===");
I.setCur(S[S.length-1].ds + 3);
I.jumpSentence(1);
ok("stays on the last sentence", I.currentOffset() === S[S.length-1].ds, at());

console.log("\n=== the grace window ===");
// Just inside the grace window counts as "at the start" -> steps back.
I.setCur(S[3].ds + 3);
I.jumpSentence(-1);
ok("3 chars in is treated as at-the-start -> previous",
   I.currentOffset() === S[2].ds, at());
// Beyond the grace window -> restart current.
I.setCur(S[3].ds + 25);
I.jumpSentence(-1);
ok("25 chars in restarts the sentence", I.currentOffset() === S[3].ds, at());

console.log("\n=== hopping crosses paragraph boundaries ===");
// Sentence 2 is the last of paragraph 1; sentence 3 is the first of paragraph 2.
I.setCur(S[2].ds + 5);
I.jumpSentence(1);
ok("forward crosses into the next paragraph", I.currentOffset() === S[3].ds, at());
I.setCur(S[3].ds + 20);
I.jumpSentence(-1);
ok("back restarts first sentence of paragraph 2", I.currentOffset() === S[3].ds, at());
I.jumpSentence(-1);
ok("back again crosses into the previous paragraph", I.currentOffset() === S[2].ds, at());

console.log("\n=== a position in a block separator still resolves ===");
I.setCur(S[2].de + 1);                        // in the "\n\n" gap
I.jumpSentence(-1);
ok("resolves without throwing", typeof I.currentOffset() === "number", at());

console.log("\n=== every landing is exactly a sentence start ===");
let allStarts = true;
for (let k = 0; k < 12; k++) {
  I.jumpSentence(k % 3 === 0 ? 1 : -1);
  if (!S.some(s => s.ds === I.currentOffset())) { allStarts = false; break; }
}
ok("never lands mid-sentence", allStarts, at());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

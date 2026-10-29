/*
 * Tests that scrolling by hand is not fought while the voice is reading.
 *
 * THE BUG THIS PINS DOWN. maybeScroll() used to re-centre the page on every
 * word the engine reported — three or four times a second — so a reader who
 * scrolled away got a few hundred milliseconds of freedom before being dragged
 * back to the playhead. "Anytime i try to scroll, it takes me back to focus on
 * current paragraph" (30 October 2026).
 *
 * HOW THE VIEWPORT IS FAKED. Nothing here is a real layout. `wordTop` is where
 * we pretend the spoken word currently sits, Range#getBoundingClientRect is
 * stubbed to report it, and window.scrollBy records the request instead of
 * performing it. That is enough, because the thing under test is the DECISION
 * to scroll, not the scrolling.
 *
 * The word rect is driven directly rather than by actually speaking, because
 * the engine's word callbacks are the one part of this that a headless test
 * cannot produce.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const HTML = `<div id="article">
  <p>Alpha one two three four. Bravo five six seven eight. Charlie nine ten eleven.</p>
  <p>Delta twelve thirteen fourteen. Echo fifteen sixteen seventeen.</p>
</div>`;
const dom = new JSDOM(
  `<!doctype html><body>` +
  `<div id="view-reader" class="active">${HTML}</div>` +
  `<div id="tts-bar">` +
  `  <button id="tts-prev"></button><button id="tts-play"></button>` +
  `  <button id="tts-next"></button><button id="tts-rate"></button>` +
  `  <select id="tts-voice"></select><span id="tts-eta"></span>` +
  `  <button id="tts-mic"></button><button id="tts-close"></button>` +
  `</div>` +
  `<button id="tts-follow"></button>` +
  `</body>`);

global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined; global.Highlight = undefined;
global.speechSynthesis = { cancel(){}, speak(){}, getVoices: () => [
  {name:"V",lang:"en-US",localService:true}], onvoiceschanged:null };
global.SpeechSynthesisUtterance = function(t){ this.text = t; };
const store = { settings:{} };
global.FolioStore = { getSettings:()=>JSON.parse(JSON.stringify(store.settings)),
                      saveSettings:(s)=>{store.settings=JSON.parse(JSON.stringify(s));} };

// ── The fake viewport ──
const H = 800;                 // viewport height; the band is 25%-75%, so 200-600
Object.defineProperty(dom.window, "innerHeight", { value: H, writable: true });

let wordTop = 300;             // where we pretend the spoken word is
let scrolls = [];              // every scroll the player asked for
dom.window.scrollBy = (opt) => { scrolls.push(opt.top); };
dom.window.Range.prototype.getBoundingClientRect = function () {
  return { top: wordTop, bottom: wordTop + 20, height: 20, left: 0, right: 10 };
};

const src = fs.readFileSync(REPO + "/js/tts.js","utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __i: () => ({ maybeScroll, handOffScroll, followNow, " +
  "get following(){return following;}, " +
  "setCur:(p)=>{curWord={ds:p,de:p+3};}, " +
  "setPlaying:(v)=>{playing=v;} }),\n    init, attach, detach,");
const TTS = eval(src + "; TTS;");
TTS.init();
TTS.attach("d");
const I = TTS.__i();

let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const chip = () => document.getElementById("tts-follow").classList.contains("visible");

// Reading has started, and the word has drifted below the band.
I.setCur(10);
I.setPlaying(true);

console.log("\n=== while following, a word out of the band scrolls ===");
wordTop = 700;                 // past the 75% line
scrolls = [];
I.maybeScroll();
ok("scrolled to bring the word back", scrolls.length === 1, JSON.stringify(scrolls));
ok("following is still on", I.following === true);
ok("no Follow chip while it is following", !chip());

console.log("\n=== a scroll gesture hands the page over ===");
I.handOffScroll();
ok("following is off", I.following === false);
ok("the Follow chip appears", chip());

console.log("\n=== and then it STOPS scrolling, however far the word drifts ===");
scrolls = [];
for (let i = 0; i < 40; i++) { wordTop = 700 + i * 100; I.maybeScroll(); }
ok("forty words out of the band caused no scroll at all",
   scrolls.length === 0, JSON.stringify(scrolls));
ok("still not following", I.following === false);

console.log("\n=== a word still off screen does not resume following ===");
wordTop = H + 50;              // below the fold entirely
I.maybeScroll();
ok("off-screen word leaves it handed over", I.following === false);

console.log("\n=== scrolling back to the voice resumes following, silently ===");
scrolls = [];
wordTop = 400;                 // inside the band (200-600)
I.maybeScroll();
ok("following is back on", I.following === true);
ok("the chip goes away", !chip());
ok("and resuming did not scroll", scrolls.length === 0, JSON.stringify(scrolls));

console.log("\n=== A SMALL SCROLL IS NOT UNDONE ===");
/*
 * The regression that the first version of this fix shipped with. Hand over
 * while the word is in the band, which is what a twenty-pixel nudge leaves
 * behind, and a one-step resume rule turns the hand-off into a no-op.
 */
wordTop = 400;                 // in the band, as it was before the nudge
I.handOffScroll();
ok("handed over", I.following === false);
scrolls = [];
for (let i = 0; i < 10; i++) I.maybeScroll();
ok("ten word boundaries later it is STILL handed over",
   I.following === false, "resumed on a word that never left the band");
ok("and nothing scrolled", scrolls.length === 0, JSON.stringify(scrolls));

console.log("\n=== once the word drifts off, a return does resume ===");
wordTop = 700;                 // out of the band: arms the return
I.maybeScroll();
ok("drifting out does not resume by itself", I.following === false);
wordTop = 400;                 // back in the band
I.maybeScroll();
ok("now it resumes", I.following === true);

console.log("\n=== the Follow chip jumps back and resumes ===");
I.handOffScroll();
scrolls = [];
wordTop = 2000;                // far below
I.followNow();
ok("following is on again", I.following === true);
ok("and it scrolled to the word", scrolls.length === 1, JSON.stringify(scrolls));
ok("chip hidden again", !chip());

console.log("\n=== a deliberate seek re-enables following ===");
I.handOffScroll();
ok("handed over", I.following === false);
TTS.jumpSentence(1);
ok("Next sentence takes control back", I.following === true);

console.log("\n=== stopping starts the next read off following again ===");
I.handOffScroll();
ok("handed over before the stop", I.following === false);
TTS.stop(true);                // also clears curWord, so engaged() is false
ok("stop reset it to following", I.following === true);
ok("and cleared the chip", !chip());

console.log("\n=== nothing being read: a gesture is not a hand-off ===");
I.handOffScroll();
ok("a scroll with nothing to follow changes nothing", I.following === true);
ok("and shows no chip", !chip());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

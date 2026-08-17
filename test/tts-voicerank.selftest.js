/* Verifies voice ranking picks a downloaded Premium voice over Samantha even
   when Chrome exposes it as a bare name with no tier suffix. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const dom = new JSDOM('<!doctype html><body><div id="article"><p>Hello there friend.</p></div></body>');
global.window = dom.window; global.document = dom.window.document;
global.Node = dom.window.Node; global.NodeFilter = dom.window.NodeFilter;
global.CSS = undefined;
const store = { settings: {} };
global.FolioStore = { getSettings: () => JSON.parse(JSON.stringify(store.settings)),
                      saveSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); } };
let VOICES = [];
global.speechSynthesis = { getVoices: () => VOICES, cancel(){}, speak(){}, onvoiceschanged: null };

const src = fs.readFileSync("/Users/rishabhchopra/Documents/GitHub/folio/js/tts.js","utf8").replace(
  "return {\n    init, attach, detach,",
  "return {\n    __p: () => providers.webspeech, __load: loadSettings, get __sel(){return selectedVoice;},\n    init, attach, detach,");
const TTS = eval(src + "; TTS;");
const P = TTS.__p();

let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};
const V = (name, lang="en-US", local=true) => ({ name, lang, localService: local });

console.log("\n=== bare 'Zoe' (no tier suffix) beats Samantha ===");
VOICES = [V("Samantha"), V("Albert"), V("Zoe"), V("Daniel","en-GB")];
ok("Zoe ranked first", P.voices()[0].name === "Zoe", P.voices().map(v=>v.name).join(","));
ok("defaultVoice is Zoe", P.defaultVoice().name === "Zoe", P.defaultVoice().name);

console.log("\n=== suffixed '(Premium)' also works ===");
VOICES = [V("Samantha"), V("Jamie (Premium)","en-GB")];
ok("Jamie (Premium) first", P.voices()[0].name === "Jamie (Premium)", P.voices()[0].name);

console.log("\n=== Zoe outranks Jamie (list order) ===");
VOICES = [V("Jamie","en-GB"), V("Zoe")];
ok("Zoe before Jamie", P.voices()[0].name === "Zoe", P.voices().map(v=>v.name).join(","));

console.log("\n=== unknown Premium still beats plain voices ===");
VOICES = [V("Albert"), V("Karen","en-AU"), V("Mystery (Premium)")];
ok("Premium first", P.voices()[0].name === "Mystery (Premium)", P.voices()[0].name);

console.log("\n=== Samantha wins only when nothing better exists ===");
VOICES = [V("Albert"), V("Samantha"), V("Bad News")];
ok("Samantha first", P.voices()[0].name === "Samantha", P.voices()[0].name);

console.log("\n=== network voices excluded (they can hang the queue) ===");
VOICES = [V("Google US English","en-US",false), V("Samantha")];
ok("only local offered", P.voices().length === 1 && P.voices()[0].name === "Samantha",
   P.voices().map(v=>v.name).join(","));

console.log("\n=== a previously auto-selected voice is UPGRADED ===");
VOICES = [V("Samantha"), V("Zoe")];
store.settings = { ttsVoice: "Samantha" };          // saved, but never user-picked
TTS.__load();
ok("upgraded to Zoe", TTS.__sel.name === "Zoe", TTS.__sel.name);

console.log("\n=== a deliberately chosen voice is RESPECTED ===");
store.settings = { ttsVoice: "Samantha", ttsVoicePicked: true };
TTS.__load();
ok("kept Samantha", TTS.__sel.name === "Samantha", TTS.__sel.name);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

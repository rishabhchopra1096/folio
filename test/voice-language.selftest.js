/*
 * Dictation must not guess the language.
 *
 * Whisper detects the language when you do not name one, and on a short or
 * accented clip it gets it wrong — a dictated comment would come back in
 * another language entirely. This pins the parameter that stops it.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.FormData = dom.window.FormData;
global.Blob = dom.window.Blob;
global.navigator = dom.window.navigator;

const FolioStore = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");
global.FolioStore = FolioStore;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

/* Capture the form Groq would have received. */
let sentForm = null;
global.fetch = function (url, opts) {
  sentForm = opts.body;
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ text: "hello" }),
  });
};

const Voice = eval(fs.readFileSync(REPO + "/js/voice.js", "utf8") + "; Voice;");

const clip = new Blob([new Uint8Array(64)], { type: "audio/webm" });
const fieldsOf = (form) => {
  const out = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "(blob)";
  return out;
};

(async () => {
  console.log("\n=== the language is stated, not guessed ===");
  localStorage.clear();
  Voice.setKey("gsk_testkeytestkeytestkeytestkey");   // after clearing, not before
  await Voice.transcribe(clip);
  let f = fieldsOf(sentForm);
  ok("a language is sent at all", "language" in f, JSON.stringify(f));
  ok("and it defaults to English", f.language === "en", f.language);
  ok("the model is still sent", !!f.model, JSON.stringify(f));
  ok("as is the audio", f.file === "(blob)");

  console.log("\n=== it can still be changed ===");
  const s = FolioStore.getSettings();
  s.voiceLanguage = "hi";
  FolioStore.saveSettings(s);
  sentForm = null;
  await Voice.transcribe(clip);
  ok("an explicit language is honoured", fieldsOf(sentForm).language === "hi",
     fieldsOf(sentForm).language);

  console.log("\n=== an empty setting means detect, not send nothing ===");
  const s2 = FolioStore.getSettings();
  s2.voiceLanguage = "";
  FolioStore.saveSettings(s2);
  sentForm = null;
  await Voice.transcribe(clip);
  ok("the field is omitted entirely rather than sent empty",
     !("language" in fieldsOf(sentForm)), JSON.stringify(fieldsOf(sentForm)));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

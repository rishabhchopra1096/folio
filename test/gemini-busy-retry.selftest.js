/* A busy model must not lose the run.

   "This model is currently experiencing high demand" is a 503 that clears in
   seconds. The retry ladder that handled it lived in the caption-free path,
   and was deleted along with it — so the first 503 killed the whole
   transcription. This is the test that would have caught that. */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = dom.window.localStorage; global.URL = dom.window.URL;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

const gsrc = fs.readFileSync(REPO + "/js/gemini.js", "utf8");
const CUES = [{ t: 0, text: "one" }, { t: 15, text: "two" }, { t: 30, text: "three" }];

/* A reply the parser will accept, using timestamps from the cue list. */
const goodBody = {
  candidates: [{ finishReason: "STOP", content: { parts: [{ text:
    CUES.map((c) => JSON.stringify({ start: c.t, text: "line at " + c.t })).join("\n") }] } }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
};
const reply = (status, body) => Promise.resolve({
  ok: status === 200, status, json: () => Promise.resolve(body),
});

function load(fetchImpl) {
  const G = eval(gsrc + "; Gemini;");
  global.fetch = fetchImpl;
  G.setKey("test-key");
  G.clearLog();
  return G;
}

(async () => {
  console.log("\n=== a 503 is retried, not fatal ===");
  let calls = 0;
  const G = load(() => {
    calls++;
    return calls === 1
      ? reply(503, { error: { message: "This model is currently experiencing high demand." } })
      : reply(200, goodBody);
  });
  const t0 = Date.now();
  let segs = null, err = null;
  try {
    segs = await G.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ",
      { cues: CUES, durationSec: 45 });
  } catch (e) { err = e; }
  const took = Date.now() - t0;

  ok("the run survives a 503", !err && !!segs, err && err.message);
  ok("it tried again", calls === 2, "fetch calls: " + calls);
  ok("it waited before retrying", took >= 3500, took + "ms");
  ok("and produced the lines", segs && segs.length === 3, segs && String(segs.length));
  const evs = G.getLog().map((e) => e.ev);
  ok("the retry is in the log", evs.includes("retry"), evs.join(","));
  ok("so is the failure that caused it", evs.includes("httperror"));

  console.log("\n=== an empty account is NOT retried ===");
  let calls2 = 0;
  const G2 = load(() => {
    calls2++;
    return reply(429, { error: { message: "Your prepayment credits are depleted." } });
  });
  let err2 = null;
  try {
    await G2.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ", { cues: CUES, durationSec: 45 });
  } catch (e) { err2 = e; }
  ok("it fails", !!err2);
  ok("immediately, without burning the ladder", calls2 === 1, "fetch calls: " + calls2);
  ok("and says what is actually wrong", /credits are depleted/.test(err2.message), err2.message);
  ok("marked terminal", err2.terminal === true);

  console.log("\n=== the ladders are distinct ===");
  /* A quota refuses in milliseconds and keeps refusing, so seconds of backoff
     just burn the attempts; a busy model clears far sooner. */
  const busy = JSON.parse(gsrc.match(/RETRY_BUSY = (\[[^\]]*\])/)[1]);
  const limited = JSON.parse(gsrc.match(/RETRY_LIMITED = (\[[^\]]*\])/)[1]);
  ok("a busy model is retried quickly", busy[0] <= 5000, String(busy[0]));
  ok("a rate limit waits much longer",
     limited.reduce((a, b) => a + b, 0) > busy.reduce((a, b) => a + b, 0) * 3,
     `${busy.reduce((a,b)=>a+b,0)}ms vs ${limited.reduce((a,b)=>a+b,0)}ms`);
  ok("a 429 that is not billing picks the slow ladder", /e\.slow = true/.test(gsrc));

  console.log("\n=== a failed TOP-UP keeps what was already written ===");
  let calls3 = 0;
  const G3 = load(() => {
    calls3++;
    // First pass succeeds but covers only the start; every later attempt 503s.
    if (calls3 === 1) {
      return reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text:
        JSON.stringify({ start: 0, text: "only the beginning" }) }] } }],
        usageMetadata: {} });
    }
    return reply(503, { error: { message: "high demand" } });
  });
  const many = [];
  for (let t = 0; t <= 600; t += 15) many.push({ t, text: "cue " + t });
  let segs3 = null, err3 = null;
  try {
    segs3 = await G3.transcribeYouTube("https://youtu.be/dQw4w9WgXcQ",
      { cues: many, durationSec: 600 });
  } catch (e) { err3 = e; }
  ok("the partial document is returned rather than thrown away",
     !err3 && segs3 && segs3.length >= 1, err3 && err3.message);
  ok("and the abandoned top-up is logged",
     G3.getLog().map((e) => e.ev).includes("topup-failed"),
     G3.getLog().map((e) => e.ev).join(","));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

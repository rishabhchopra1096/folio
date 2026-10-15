/*
 * =============================================================================
 * FEEDBACK.SELFTEST.JS — the feedback box: numbering, sending, and storing
 * =============================================================================
 * WHAT THIS SUITE PROVES:
 * You hit a bug while reading, write it down in the box at the bottom left, and
 * press one button. Three things have to hold for that to be worth anything:
 *
 *   PART A — the store hands out a permanent number that is never reused, and
 *            forgets picture bytes once they have been written out.
 *   PART B — THE ORDER. The note is SENT to a file before it is stored. This is
 *            the single assertion most worth having: a screenshot can easily
 *            push localStorage over its quota, and if storing came first a
 *            full quota would throw and the feedback would be gone — which is
 *            exactly the failure the box exists to prevent.
 *   PART C — the bundle that reaches disk carries the picture BYTES, and the
 *            copy left in the browser does not. Get this backwards and either
 *            the screenshots never arrive, or the box slowly eats the storage
 *            the documents live in.
 *
 * WHY THE FIXTURE IS READ OUT OF index.html:
 * The markup is not written out here. It is sliced from the real page, so a
 * suite cannot keep passing against a card that no longer exists in the app.
 * Writing the fixture by hand is how a component gets proved while the feature
 * is broken.
 *
 * WHAT THIS SUITE CANNOT DO:
 * jsdom has no canvas, so the shrinking of a real pasted image is NOT tested
 * here — it is tested in test/browser/feedback.probe.html against real Chrome.
 * The shots used below are shaped exactly as pictureFromBlob returns them.
 * =============================================================================
 */

const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

/* ── The fixture, sliced out of the real page ── */
const page = fs.readFileSync(REPO + "/index.html", "utf8");
const from = page.indexOf('<div id="feedback-box">');
const to = page.indexOf("<!-- ════", from);          // the next banner comment
if (from === -1 || to === -1) {
  console.log("  ✗ could not find #feedback-box in index.html");
  console.log("\n0 passed, 1 failed");
  process.exit(1);
}
const BOX = page.slice(from, to);

const dom = new JSDOM(`<!doctype html><html data-theme="default"><body>${BOX}</body></html>`,
                      { url: "https://folio.test/#/doc/doc_a" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.navigator = dom.window.navigator;
global.location = dom.window.location;
global.Image = dom.window.Image;

/*
 * A Blob that remembers what it was given, and a URL that hands back a fake
 * link. jsdom implements neither createObjectURL nor a real download, and
 * standing in for them is also what lets Part B make the download FAIL on
 * purpose.
 */
let sentPayloads = [];
let breakDownload = false;
global.Blob = class FakeBlob {
  constructor(parts, opts) { this.parts = parts; this.type = (opts || {}).type; }
};
global.URL = {
  createObjectURL(blob) {
    if (breakDownload) throw new Error("download refused");
    sentPayloads.push(JSON.parse(blob.parts[0]));
    return "blob:fake";
  },
  revokeObjectURL() {},
};

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log("  ✓ " + n))
    : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : "")));
};

/* The real modules, evaluated over the real localStorage. */
const Store = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");
global.FolioStore = Store;
const Box = eval(
  fs.readFileSync(REPO + "/js/feedback.js", "utf8").replace(/^const Feedback/m, "var Feedback") +
  "; Feedback;");

/* A shot shaped exactly as pictureFromBlob returns one. */
const shot = (tag) => ({
  name: "screenshot", type: "image/png", w: 1200, h: 800,
  bytes: "data:image/png;base64,AAAA" + tag, sent: false,
});

/* ===========================================================================
 * PART A — the store: permanent numbers, and forgetting bytes
 * ===========================================================================
 */
console.log("\nPART A — numbering and pruning");

ok("an empty Folio has no notes", Store.getFeedback().length === 0);

ok("the first number handed out is 1", Store.nextFeedbackNumber() === 1);
ok("the next is 2, not 1 again", Store.nextFeedbackNumber() === 2);

/*
 * The counter is the thing that makes "FB-3" mean one note for ever. If it is
 * lost — a cleared key, a half-restored backup — it must not start handing out
 * numbers that are already in use.
 */
Store.saveFeedback([{ id: "fb_x", n: 9, kind: "bug", text: "already here", shots: [], status: "open" }]);
localStorage.removeItem("folio_feedback_seq");
ok("a lost counter is reseeded from the highest number in use",
   Store.nextFeedbackNumber() === 10, String(Store.nextFeedbackNumber()));

const pruned = Store.pruneFeedbackBytes({ shots: [shot("a"), shot("b")] });
ok("pruning drops every picture's bytes",
   pruned.shots.every((s) => s.bytes === null));
ok("...but remembers that a picture was there",
   pruned.shots.every((s) => s.sent === true && s.w === 1200));
ok("pruning a note with no pictures does not throw",
   Store.pruneFeedbackBytes({ shots: [] }).shots.length === 0);

/* A backup has to carry the notes, or restoring a browser loses them all. */
Store.saveFeedback([{ id: "fb_y", n: 1, kind: "idea", text: "keep me", shots: [], status: "open" }]);
ok("the backup export sweeps the notes up with everything else",
   Array.isArray(Store.exportAll().folio_feedback) &&
   Store.exportAll().folio_feedback[0].text === "keep me");

/* ===========================================================================
 * PART B — THE ORDER: sent before stored
 * ===========================================================================
 * Each case resets the world first, so a case cannot pass on a leftover.
 */
console.log("\nPART B — the order things happen in");

const reset = () => {
  localStorage.clear();
  sentPayloads = [];
  breakDownload = false;
  Box._setDraft(null);
};

reset();
Box._setDraft({ kind: "bug", text: "", shots: [] });
let r = Box.submit();
ok("an empty note is refused", r.ok === false && r.reason === "empty", JSON.stringify(r));
ok("...and nothing was sent", sentPayloads.length === 0);
ok("...and nothing was stored", Store.getFeedback().length === 0);

reset();
Box._setDraft({ kind: "idea", text: "", shots: [shot("pic")] });
r = Box.submit();
ok("a note with only a picture and no words is accepted", r.ok === true, JSON.stringify(r));

reset();
Box._setDraft({ kind: "bug", text: "  the mic does nothing  ", shots: [] });
r = Box.submit();
const stored = Store.getFeedback();
ok("saving stores exactly one note", stored.length === 1, String(stored.length));
ok("the words are kept trimmed but otherwise untouched",
   stored[0].text === "the mic does nothing", JSON.stringify(stored[0].text));
ok("it is open, and dated", stored[0].status === "open" && !!stored[0].createdAt);
ok("it carries the number it was given", stored[0].n === r.n && r.n === 1, String(stored[0].n));
ok("it records that it was sent", !!stored[0].sentAt);
ok("one bundle reached a file", sentPayloads.length === 1, String(sentPayloads.length));

/*
 * THE ASSERTION THIS WHOLE SUITE IS FOR.
 *
 * Break the download and the note must still be stored, marked as NOT sent, so
 * it is visible and can be retried. If the code sent after storing, this would
 * be the ordinary path and would prove nothing; because it sends first, this is
 * the case that proves the failure is survivable in the right direction.
 */
reset();
breakDownload = true;
Box._setDraft({ kind: "bug", text: "written while the disk was full", shots: [] });
r = Box.submit();
ok("a failed send still stores the note", Store.getFeedback().length === 1);
ok("...marked as not sent, so it can be seen and retried",
   Store.getFeedback()[0].sentAt === null, String(Store.getFeedback()[0].sentAt));
ok("...and the words survived", Store.getFeedback()[0].text === "written while the disk was full");

/*
 * The other direction: storing fails and the note must ALREADY be on disk.
 * This is the quota case, which is a real possibility with pictures involved.
 */
reset();
const realSave = Store.saveFeedback;
Store.saveFeedback = function () { throw new Error("QuotaExceededError"); };
Box._setDraft({ kind: "bug", text: "the one that could not be kept", shots: [shot("q")] });
/*
 * Wrapped, so that a version which stored BEFORE sending reports a clean
 * failure here rather than throwing out of the suite and taking every later
 * assertion with it. A crash is a failure too, but a crash hides whatever else
 * was wrong.
 */
try { r = Box.submit(); } catch (err) { r = { ok: false, threw: err.message }; }
ok("a note that cannot be stored was already sent", sentPayloads.length === 1,
   String(sentPayloads.length));
ok("...and the sent copy has the words",
   !!sentPayloads[0] &&
   sentPayloads[0].items[0].text === "the one that could not be kept",
   sentPayloads.length ? "wrong words" : "nothing was sent at all");
ok("...and saving still reports success rather than throwing at the user",
   r.ok === true, JSON.stringify(r));
Store.saveFeedback = realSave;

/* ===========================================================================
 * PART C — bytes go out, bytes do not stay
 * ===========================================================================
 */
console.log("\nPART C — where the picture ends up");

reset();
Box._setDraft({ kind: "bug", text: "look at this", shots: [shot("zz")] });
Box.submit();

ok("the bundle that was sent carries the picture's bytes",
   !!sentPayloads[0] &&
   sentPayloads[0].items[0].shots[0].bytes === "data:image/png;base64,AAAAzz",
   sentPayloads.length
     ? JSON.stringify(sentPayloads[0].items[0].shots[0].bytes)
     : "nothing was sent at all");
ok("the copy left in the browser does NOT carry them",
   Store.getFeedback()[0].shots[0].bytes === null,
   JSON.stringify(Store.getFeedback()[0].shots[0].bytes));
ok("...but still says a picture was there",
   Store.getFeedback()[0].shots[0].sent === true &&
   Store.getFeedback()[0].shots[0].w === 1200);

/* The bundle is cumulative: the newest file is a complete list of the words. */
Box._setDraft({ kind: "idea", text: "and this", shots: [] });
Box.submit();
ok("the next bundle contains BOTH notes",
   !!sentPayloads[1] && sentPayloads[1].items.length === 2,
   sentPayloads[1] ? String(sentPayloads[1].items.length) : "no second bundle");
ok("...the older one without its bytes, the newer one with none to carry",
   !!sentPayloads[1] && sentPayloads[1].items[0].shots[0].bytes === null);

const bundle = Box.buildBundle(Store.getFeedback());
ok("the bundle says what it is, so the tool can refuse a stranger",
   bundle.kind === "folio-feedback" && bundle.version === 1);
ok("...and when it was written", !!bundle.exportedAt);

/* ===========================================================================
 * PART D — the list: context, status, deletion
 * ===========================================================================
 */
console.log("\nPART D — context, status and deletion");

reset();
const ctx = Box.captureContext();
ok("the note records which mode you were in", ctx.mode === "read", ctx.mode);
ok("...and which theme", ctx.theme === "default", ctx.theme);
ok("...and whether this is the panel or the web", ctx.app === "web", ctx.app);
ok("...and the viewport, for a layout complaint", /^\d+x\d+$/.test(ctx.viewport), ctx.viewport);

Box._setDraft({ kind: "bug", text: "first", shots: [] });
const a = Box.submit();
Box._setDraft({ kind: "bug", text: "second", shots: [] });
const b = Box.submit();
ok("numbers go up across notes", a.n === 1 && b.n === 2, a.n + "," + b.n);

ok("a note can be marked done", Box.setStatus(b.id, "done") === true &&
   Store.getFeedback().find((f) => f.id === b.id).status === "done");
ok("...and reopened", Box.setStatus(b.id, "open") === true &&
   Store.getFeedback().find((f) => f.id === b.id).status === "open");
ok("marking a note that does not exist is refused, not a crash",
   Box.setStatus("fb_nope", "done") === false);

/*
 * The number must NOT be reused after a delete. Reusing it would mean "FB-2"
 * silently pointing at a different complaint than it did yesterday, which is
 * worse than a gap in the numbers.
 */
ok("a note can be deleted", Box.removeNote(b.id) === true &&
   Store.getFeedback().length === 1);
Box._setDraft({ kind: "bug", text: "third" , shots: [] });
const c = Box.submit();
ok("the deleted note's number is NOT handed out again",
   c.n === 3, "got FB-" + c.n + ", expected FB-3");
ok("deleting something absent is refused, not a crash",
   Box.removeNote("fb_nope") === false);

/* Re-sending exists for a cleared Downloads folder, and must mark things sent. */
reset();
breakDownload = true;
Box._setDraft({ kind: "bug", text: "never reached a file", shots: [] });
Box.submit();
ok("the note is sitting unsent", Store.getFeedback()[0].sentAt === null);
breakDownload = false;
const re = Box.resendAll();
ok("sending again works", re.ok === true && re.count === 1, JSON.stringify(re));
ok("...and the note is no longer unsent", !!Store.getFeedback()[0].sentAt);
reset();
ok("sending again with nothing to send is refused politely",
   Box.resendAll().reason === "empty");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

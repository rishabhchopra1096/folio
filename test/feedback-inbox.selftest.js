/*
 * =============================================================================
 * FEEDBACK-INBOX.SELFTEST.JS — filing the notes into the bible
 * =============================================================================
 * WHAT THIS SUITE PROVES:
 * The feedback box writes a JSON bundle into Downloads. This is about the tool
 * that reads those bundles and turns them into docs/feedback/folio/BIBLE.md —
 * the half that makes "fix what I asked for" mean something.
 *
 *   PART A — a bundle is read, the row lands in the bible with the user's words
 *            verbatim, and the screenshot lands on disk beside it.
 *   PART B — THE MERGE. A picture's bytes travel in only ONE bundle, because
 *            the box drops them straight after sending. So the tool has to read
 *            every bundle and keep the bytes from whichever one still has them.
 *            This is the assertion most worth having: get it wrong and the
 *            words arrive while the pictures silently do not.
 *   PART C — running it twice files nothing twice, because an id must appear in
 *            the bible exactly once, and the numbers must never be renumbered.
 *
 * WHY THE BUNDLES ARE PRODUCED BY THE REAL MODULE:
 * Nothing here hand-writes a bundle. js/feedback.js is evaluated and its own
 * submit() is called, and what gets written to disk is exactly the bytes it
 * passed to the Blob it tried to download. A hand-written fixture would prove
 * the tool can read a file I invented — which is how a feature gets declared
 * working while the real shape never flows through it.
 *
 * The one constant below is a real 1x1 PNG, used because jsdom has no canvas.
 * The shrinking of a genuine screenshot is proven in the browser probe; what
 * matters here is that a data URL is decoded to real bytes with the right
 * extension, and a 1x1 PNG exercises that exactly.
 * =============================================================================
 */

const { JSDOM } = require("jsdom");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

/* A real, valid 1x1 PNG. Decodes to actual bytes with a real PNG signature. */
const PNG_1PX = "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+6TU4AAAAAElFTkSuQmCC";

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? (pass++, console.log("  ✓ " + n))
    : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : "")));
};

/* ── A scratch world: a fake Downloads folder and a fake flow folder ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "folio-inbox-"));
const DOWNLOADS = path.join(tmp, "Downloads");
const FLOW = path.join(tmp, "flow");
fs.mkdirSync(DOWNLOADS, { recursive: true });

/* ── The real widget, over a real localStorage, capturing what it sends ── */
const page = fs.readFileSync(REPO + "/index.html", "utf8");
const from = page.indexOf('<div id="feedback-box">');
const to = page.indexOf("<!-- ════", from);
const BOX = page.slice(from, to);

const dom = new JSDOM(`<!doctype html><html data-theme="night"><body>${BOX}</body></html>`,
                      { url: "https://folio.test/#/doc/doc_a/edit" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.navigator = dom.window.navigator;
global.location = dom.window.location;
global.Image = dom.window.Image;

/*
 * Every bundle the box tries to download is written into the fake Downloads
 * folder under the name the box chose, so the files on disk are the files the
 * browser would have saved. A counter keeps the names distinct, because two
 * saves inside the same second would otherwise collide — which the real
 * browser resolves with a "(1)" suffix and this cannot.
 */
let seq = 0;
const written = [];
global.Blob = class FakeBlob {
  constructor(parts, opts) { this.parts = parts; this.type = (opts || {}).type; }
};
global.URL = {
  createObjectURL(blob) {
    seq++;
    const name = "folio-feedback-2026-10-15T10-0" + seq + "-00.json";
    fs.writeFileSync(path.join(DOWNLOADS, name), blob.parts[0]);
    written.push(name);
    return "blob:fake";
  },
  revokeObjectURL() {},
};

const Store = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");
global.FolioStore = Store;
const Box = eval(
  fs.readFileSync(REPO + "/js/feedback.js", "utf8").replace(/^const Feedback/m, "var Feedback") +
  "; Feedback;");

// Seed a document so the note carries real context, as a real one would.
Store.saveFeedback([]);
localStorage.setItem("folio_documents", JSON.stringify([
  { id: "doc_a", title: "On Reading Twice", icon: "", parentId: null, order: 0,
    createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" }]));
Store.ensureReads("doc_a");
global.Reader = { getCurrentDocId: () => "doc_a" };

const run = (args) => execFileSync("node",
  [REPO + "/tools/feedback-inbox.js", "--dir", DOWNLOADS, "--flow", FLOW].concat(args || []),
  { encoding: "utf8" });

/* ===========================================================================
 * PART A — one note, with a picture, reaching the bible
 * ===========================================================================
 */
console.log("\nPART A — a note reaches the bible");

const FIRST = "The highlight colour is wrong.\nIt should be orange, not blue.";
Box._setDraft({
  kind: "bug", text: FIRST,
  shots: [{ name: "grab", type: "image/png", w: 1800, h: 1125, bytes: PNG_1PX, sent: false }],
});
Box.submit();
ok("the box wrote a bundle into the fake Downloads folder", written.length === 1,
   JSON.stringify(written));

let out = run();
const bible = () => fs.readFileSync(path.join(FLOW, "BIBLE.md"), "utf8");

ok("the tool says what it filed", /filed FB-1 \(bug\)/.test(out), out.trim().split("\n")[0]);
ok("a bible was created", fs.existsSync(path.join(FLOW, "BIBLE.md")));
ok("it has the id the user saw in Folio", /\| FB-1 \|/.test(bible()));

/*
 * VERBATIM, and that includes the line break. A markdown table cannot hold a
 * real newline, so it becomes <br> — joining the lines with a space instead
 * would quietly reshape his words, and this column exists to preserve them.
 */
ok("his words are kept exactly, with the line break preserved as <br>",
   bible().includes("The highlight colour is wrong.<br>It should be orange, not blue."),
   bible().split("\n").find((l) => l.startsWith("| FB-1")));

ok("the row records which document it came from",
   /On Reading Twice/.test(bible()));
ok("...and which mode he was in", /edit/.test(bible().split("| FB-1")[1].split("\n")[0]));
ok("...and the theme, since it was not the default",
   /night/.test(bible().split("| FB-1")[1].split("\n")[0]));
ok("...and which read he was on",
   /Read 1/.test(bible().split("| FB-1")[1].split("\n")[0]),
   bible().split("| FB-1")[1].split("\n")[0]);
ok("the row starts at OPEN, never at anything that reads as progress",
   /\| FB-1 \| bug \| OPEN \|/.test(bible()));

const img = path.join(FLOW, "images", "FB-1_1.png");
ok("the screenshot was written out, named after its note", fs.existsSync(img));
const bytes = fs.readFileSync(img);
ok("...and it is a real PNG, not a base64 string in a file",
   bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG",
   bytes.toString("hex", 0, 8));
ok("...and the bible links to it", /\[1\]\(images\/FB-1_1\.png\)/.test(bible()));

ok("the bible explains that DONE is his to set, not mine",
   /Only ever set by him|only ever set by him/i.test(bible()));

/* ===========================================================================
 * PART B — THE MERGE: bytes live in exactly one bundle
 * ===========================================================================
 */
console.log("\nPART B — taking each picture from the bundle that still has it");

/*
 * A second note, with its own picture. The bundle for it contains note 1 with
 * `bytes: null`, because the box pruned them after the first send. So if the
 * tool only read the newest bundle, note 1's picture would be lost — and
 * nothing about the words would look wrong.
 */
Box._setDraft({
  kind: "idea", text: "Let me export one read at a time.",
  shots: [{ name: "grab2", type: "image/jpeg", w: 900, h: 600,
            bytes: "data:image/jpeg;base64," + PNG_1PX.split(",")[1], sent: false }],
});
Box.submit();

const latest = JSON.parse(fs.readFileSync(path.join(DOWNLOADS, written[1]), "utf8"));
ok("the newest bundle really has lost note 1's bytes",
   latest.items[0].shots[0].bytes === null,
   JSON.stringify(latest.items[0].shots[0].bytes));
ok("...while still carrying note 2's", !!latest.items[1].shots[0].bytes);

out = run();
ok("the second note is filed", /filed FB-2 \(idea\)/.test(out), out.trim());
ok("...with its own picture, under its own name",
   fs.existsSync(path.join(FLOW, "images", "FB-2_1.jpg")));
ok("an idea is filed as an idea, not as a bug", /\| FB-2 \| idea \|/.test(bible()));

/*
 * THE ASSERTION THIS PART EXISTS FOR, and it has to be made in a FRESH flow
 * folder.
 *
 * Checking that FB-1_1.png is still in the folder above proves nothing: it was
 * written during Part A's run and nothing deletes it, so that check passes
 * even with the merge rule removed entirely. It was written that way first and
 * the mutation walked straight through it.
 *
 * So this files both bundles into a folder that has never been filed into. Now
 * the only way note 1's picture can appear is if the tool went back to the
 * OLDER bundle for the bytes the newer one had already dropped.
 */
const FRESH = path.join(tmp, "flow-fresh");
execFileSync("node", [REPO + "/tools/feedback-inbox.js", "--dir", DOWNLOADS,
                      "--flow", FRESH], { encoding: "utf8" });
ok("filing both bundles at once still finds note 1's picture",
   fs.existsSync(path.join(FRESH, "images", "FB-1_1.png")),
   "images present: " + JSON.stringify(
     fs.existsSync(path.join(FRESH, "images")) ? fs.readdirSync(path.join(FRESH, "images")) : []));
ok("...and note 2's", fs.existsSync(path.join(FRESH, "images", "FB-2_1.jpg")));
const sizeOf = (f) => {
  try { return fs.statSync(path.join(FRESH, "images", f)).size; } catch { return 0; }
};
ok("...and both pictures are real bytes, not empty files",
   sizeOf("FB-1_1.png") > 20 && sizeOf("FB-2_1.jpg") > 20,
   sizeOf("FB-1_1.png") + " and " + sizeOf("FB-2_1.jpg") + " bytes");

/* ===========================================================================
 * PART C — running it again, and the things it must refuse
 * ===========================================================================
 */
console.log("\nPART C — safe to run twice, and hard to confuse");

const before = bible();
out = run();
ok("running again files nothing new", /0 new note\(s\) filed/.test(out), out.trim());
ok("...and does not touch the bible", bible() === before);
ok("...and says plainly that everything was already filed",
   /already filed/.test(out));

ok("--list reports without changing anything",
   /FB-1 \[bug\]/.test(run(["--list"])) && bible() === before);

/* A stranger's JSON in Downloads must be skipped, not parsed hopefully. */
fs.writeFileSync(path.join(DOWNLOADS, "folio-feedback-not-ours.json"),
                 JSON.stringify({ kind: "something-else", items: [{ id: "x" }] }));
out = run();
ok("a JSON file that is not a Folio bundle is skipped, loudly",
   /not a Folio feedback bundle/.test(out), out.trim());
ok("...and nothing from it reached the bible", !/\| x \|/.test(bible()));

fs.writeFileSync(path.join(DOWNLOADS, "folio-feedback-broken.json"), "{ not json");
out = run();
ok("a corrupt file is skipped with its reason, not a crash",
   /would not parse/.test(out), out.trim());

/*
 * Two browsers can both hand out FB-3, because the counter lives per origin —
 * the live site and a localhost port are separate Folios. An id that means two
 * different things is worse than an id that does not match what he saw, so the
 * second one is suffixed and the clash is announced.
 */
fs.writeFileSync(path.join(DOWNLOADS, "folio-feedback-2026-10-15T11-00-00.json"),
  JSON.stringify({
    kind: "folio-feedback", version: 1, exportedAt: "2026-10-15T11:00:00.000Z",
    origin: "http://localhost:8000/",
    items: [{ id: "fb_other_browser", n: 1, kind: "bug", text: "same number, other Folio",
              shots: [], context: { mode: "read" }, createdAt: "2026-10-15T11:00:00.000Z",
              sentAt: "2026-10-15T11:00:00.000Z", status: "open" }],
  }));
out = run();
ok("a clashing number is announced rather than silently reused",
   /already belongs to another note/.test(out), out.trim());
ok("...and filed under a suffixed id", /\| FB-1b \|/.test(bible()));
ok("...leaving the original FB-1 exactly where it was",
   bible().includes("The highlight colour is wrong.<br>It should be orange, not blue."));

/* An empty Downloads folder must say so, and say what to do about it. */
const emptyDir = path.join(tmp, "empty");
fs.mkdirSync(emptyDir, { recursive: true });
out = execFileSync("node", [REPO + "/tools/feedback-inbox.js", "--dir", emptyDir,
                            "--flow", path.join(tmp, "flow2")], { encoding: "utf8" });
ok("an empty folder is reported, not treated as success",
   /no feedback bundles/.test(out), out.trim());
ok("...and names the recovery, rather than leaving a dead end",
   /Send all again/.test(out), out.trim());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

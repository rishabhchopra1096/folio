/*
 * =============================================================================
 * PICTURE-PAGES-SKIP-COMPRESSION.SELFTEST.JS
 * =============================================================================
 * WHAT THIS GUARDS, AND WHY IT IS NOT AN OPTIMISATION TEST.
 *
 * js/store.js compresses page content, and it has to: a megabyte of prose
 * comes back as 20KB, which is the difference between an app that saves and
 * one that refuses. lz-string is synchronous, which is fine at prose speeds.
 *
 * Then pictures arrived in pages — a Notion export brings its screenshots in
 * with it — and both halves of that bargain inverted. A data URL is base64 of
 * bytes a PNG or JPEG encoder already squeezed, so there is nothing left to
 * win, and the attempt blocks the main thread. Measured with this app's own
 * compressor: a page of 200KB prose plus one 2MB screenshot cost 1318ms to
 * save and recovered 422KB, and that ran on every debounced save — over a
 * second of frozen editor each time typing paused, for about 2% of the budget.
 *
 * So this is not "is it faster". It is: does a page full of pictures still get
 * SAVED and READ BACK correctly while skipping a step that cost more than it
 * returned, and does a page of prose still get the compression it depends on.
 * Breaking the second one would quietly bring back the 17 October failure
 * where storage filled and nothing could be written at all.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.LZString = require(REPO + "/vendor/lz-string.min.js");

const S = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

const LZ_MARK = "\u0001LZ:";
const isCompressed = (id) => String(localStorage.getItem("folio_doc_" + id) || "").indexOf(LZ_MARK) === 0;

/*
 * Base64 of random bytes, which is what an already-compressed picture looks
 * like to a text compressor. Using repeated characters here would make the
 * test pass for the wrong reason — a run of "AAAA" compresses beautifully and
 * a real JPEG does not.
 */
function pictureUrl(kb) {
  const bytes = require("crypto").randomBytes(kb * 1024);
  return "data:image/jpeg;base64," + bytes.toString("base64");
}
const prose = (kb) =>
  "The market opened quietly and the tape told a different story. "
    .repeat(Math.round((kb * 1024) / 62));

function page(blocks) { return { time: Date.now(), blocks }; }

console.log("\n=== prose is still compressed, which is what makes saving work ===");
{
  const doc = S.createDocument("A long read", page([
    { type: "paragraph", data: { text: prose(300) } },
  ]), null);

  ok("it was stored compressed", isCompressed(doc.id));

  const raw = localStorage.getItem("folio_doc_" + doc.id);
  const plain = JSON.stringify(page([{ type: "paragraph", data: { text: prose(300) } }]));
  ok("and compressed by a lot — this is the whole point of it",
     raw.length * 2 < plain.length * 0.3,
     (raw.length * 2) + " vs " + plain.length);

  const back = S.getDocument(doc.id);
  ok("it reads back word for word",
     back.content.blocks[0].data.text === prose(300));
}

console.log("\n=== a page that is mostly pictures is stored as it is ===");
{
  const url = pictureUrl(700);
  const doc = S.createDocument("An export", page([
    { type: "paragraph", data: { text: "Opening prose." } },
    { type: "image", data: { url, caption: "a screenshot" } },
  ]), null);

  ok("it was NOT put through the compressor", !isCompressed(doc.id));

  /* The only thing that actually matters: it survives the round trip. */
  const back = S.getDocument(doc.id);
  const img = back.content.blocks.find((b) => b.type === "image");
  ok("the picture reads back byte for byte", img && img.data.url === url,
     img ? "length " + img.data.url.length + " of " + url.length : "no image block");
  ok("its caption too", img && img.data.caption === "a screenshot");
  ok("and the prose beside it", /Opening prose/.test(back.content.blocks[0].data.text));
}

console.log("\n=== a long document with ONE screenshot in it is still compressed ===");
/*
 * The mixed case is the one a single flag would get wrong. Here the bytes are
 * overwhelmingly prose, the compressor earns its keep, and skipping it would
 * throw away most of the storage budget this app runs on.
 */
{
  const doc = S.createDocument("Mostly writing", page([
    { type: "paragraph", data: { text: prose(1200) } },
    { type: "image", data: { url: pictureUrl(60), caption: "" } },
  ]), null);
  ok("it was compressed", isCompressed(doc.id));
  const back = S.getDocument(doc.id);
  ok("and still reads back whole",
     back.content.blocks[0].data.text === prose(1200) &&
     /^data:image\/jpeg;base64,/.test(back.content.blocks[1].data.url));
}

console.log("\n=== a small page with a pasted screenshot behaves as it always did ===");
/*
 * Below the size floor the compressor is quick enough that the question never
 * arises, so nothing changes for the pages that already exist — a pasted
 * screenshot has been going into a page for months.
 */
{
  const doc = S.createDocument("One paste", page([
    { type: "image", data: { url: pictureUrl(40), caption: "" } },
  ]), null);
  const back = S.getDocument(doc.id);
  ok("it reads back either way", /^data:image\/jpeg;base64,/.test(back.content.blocks[0].data.url));
}

console.log("\n=== both formats sit side by side and both are readable ===");
/*
 * This is the property that makes the change safe to land on storage that
 * already has compressed pages in it: the marker says which is which, so a
 * mixture is normal rather than a migration.
 */
{
  const ids = S.listDocuments().map((d) => d.id);
  const compressed = ids.filter(isCompressed).length;
  ok("storage holds some of each", compressed > 0 && compressed < ids.length,
     compressed + " compressed of " + ids.length);
  ok("every page in storage can be read",
     ids.every((id) => {
       const doc = S.getDocument(id);
       return doc && Array.isArray(doc.content.blocks) && doc.content.blocks.length > 0;
     }));
}

console.log("\n=== compacting storage leaves picture pages alone too ===");
/*
 * compactStorage() exists to squeeze pages written before compression landed,
 * and it runs when the disk is FULL. It shares packValue with the save path,
 * so it has to make the same judgement — otherwise the recovery path would be
 * the one place that spends two seconds a page to gain nothing.
 */
{
  const result = S.compactStorage();
  ok("it ran", result && result.ran !== false, JSON.stringify(result));
  const ids = S.listDocuments().map((d) => d.id);
  ok("no page became unreadable",
     ids.every((id) => {
       const doc = S.getDocument(id);
       return doc && doc.content.blocks.length > 0;
     }));
  ok("the picture-heavy page is still uncompressed after a compaction",
     ids.some((id) => !isCompressed(id)));
}

console.log("\n=== the share is measured, not assumed from the word 'image' ===");
/*
 * A page can mention "data:image/" in its prose — a tutorial about data URLs
 * is a real document — without being made of pictures. A substring check would
 * stop compressing it and give up 84% of its size for nothing.
 */
{
  const text = ("Write it as data:image/png;base64,AAAA and the browser draws it inline. ")
    .repeat(6000);
  const doc = S.createDocument("Writing about data URLs", page([
    { type: "paragraph", data: { text } },
  ]), null);
  ok("prose that merely talks about data URLs is still compressed",
     isCompressed(doc.id));
  ok("and reads back intact", S.getDocument(doc.id).content.blocks[0].data.text === text);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

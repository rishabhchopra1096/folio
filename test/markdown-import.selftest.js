/*
 * Pasted markdown must arrive looking like markdown.
 *
 * THE BUG THIS PINS: marked emits semantic HTML — <strong>, <em>, <del> —
 * while Editor.js keeps only what its enabled inline tools declare. Read out of
 * the bundle: Bold is `sanitize(){return{b:{}}}`, Italic is `{i:{}}`, and the
 * string "strong" does not appear in it at all. So every **bold** in a pasted
 * document was silently deleted on the way in, and had been since the feature
 * shipped.
 *
 * Two more went with it: a standalone image became an empty paragraph, because
 * marked wraps a lone image in a PARAGRAPH and the image branch was therefore
 * unreachable; and a blockquote containing anything other than a paragraph lost
 * that content outright.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM(
  "<!doctype html><body><div id='sidebar'></div><div id='sidebar-pages'></div>" +
  "<input id='sidebar-search-input'><div id='search-results'></div>" +
  "<input id='file-input'></body>", { url: "https://x.test" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

const g = {};
(new Function("window", "globalThis", "module", "exports",
  fs.readFileSync(REPO + "/vendor/marked.min.js", "utf8"))).call(g, g, g, undefined, undefined);
global.marked = g.marked || globalThis.marked;

global.FolioStore = {
  getTopLevelDocuments: () => [], getChildDocuments: () => [], listDocuments: () => [],
  createDocument: () => ({ id: "x" }), getDocument: () => null,
  getSettings: () => ({}), saveSettings() {}, searchDocuments: () => [],
};
/*
 * The converter lives in js/markdown.js; the sidebar only forwards to it. Both
 * are loaded and the SIDEBAR's name is the one called below, so this one test
 * covers the converter and the fact that the drag-and-drop path still reaches
 * it. (The drive screen's "paste a page" box calls FolioMarkdown.toBlocks
 * directly — same function, proven by the same assertions.)
 */
global.FolioMarkdown = eval(fs.readFileSync(REPO + "/js/markdown.js", "utf8") + "; FolioMarkdown;");
const S = eval(fs.readFileSync(REPO + "/js/sidebar.js", "utf8") + "; SidebarUI;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

const first = (md) => S.markdownToBlocks(md).blocks[0];
const textOf = (b) => (b && (b.data.text ?? "")) || "";

console.log("\n=== emphasis reaches the editor in tags it keeps ===");
{
  ok("bold becomes <b>, not <strong>",
     textOf(first("This is **bold** text.")) === "This is <b>bold</b> text.",
     textOf(first("This is **bold** text.")));
  ok("italic becomes <i>, not <em>",
     /<i>italic<\/i>/.test(textOf(first("This is *italic* text."))),
     textOf(first("This is *italic* text.")));
  ok("underscore italic too", /<i>/.test(textOf(first("This is _italic_ text."))));
  ok("bold and italic together survive both",
     /<b>/.test(textOf(first("***both***"))) && /<i>/.test(textOf(first("***both***"))),
     textOf(first("***both***")));

  /*
   * This used to grep the source for the string "<strong>", which stopped
   * meaning anything the moment the converter moved into js/markdown.js — it
   * then read a file whose only "<strong>" is in a delete-confirmation dialog.
   *
   * So assert the behaviour instead, over EVERY block type rather than the
   * first paragraph: a tag Editor.js will not keep must not reach any of them.
   */
  const everywhere = S.markdownToBlocks([
    "# A **bold** heading",
    "",
    "A **bold** paragraph with *italic* and ~~struck~~ words.",
    "",
    "- a **bold** bullet",
    "- an *italic* bullet",
    "",
    "> a **bold** quote",
    "",
    "| a | b |",
    "| - | - |",
    "| **bold** cell | *italic* cell |",
  ].join("\n"));
  const allHtml = JSON.stringify(everywhere.blocks);
  ok("no tag Editor.js discards reaches any block",
     !/<(strong|em|del|s)>/.test(allHtml),
     (allHtml.match(/<(strong|em|del|s)>/g) || []).join(" "));
  ok("...and the emphasis is still there, in tags it keeps",
     (allHtml.match(/<b>/g) || []).length >= 4 && /<i>/.test(allHtml),
     (allHtml.match(/<b>/g) || []).length + " <b>");
}

console.log("\n=== tags no tool keeps are unwrapped, not swallowed ===");
{
  const t = textOf(first("This is ~~gone~~ now."));
  ok("strikethrough keeps its words", t.includes("gone"), t);
  ok("and drops only the tag", !/<del|<s>/.test(t), t);
}

console.log("\n=== things that were already fine stay fine ===");
{
  ok("inline code", /<code>npm<\/code>/.test(textOf(first("Use `npm` now."))));
  ok("links", /<a href="https:\/\/x.com">/.test(textOf(first("[d](https://x.com)"))));
  ok("headings", first("## Sub").type === "header");
  ok("fenced code is left literal", first("```\n**not bold**\n```").data.code === "**not bold**");
}

console.log("\n=== a standalone image is an image, not an empty paragraph ===");
{
  const b = first("![alt](https://x.com/i.png)");
  ok("it becomes an image block", b && b.type === "image", b && b.type);
  ok("with the right source", b && b.data.url === "https://x.com/i.png");
  ok("and keeps the alt text as a caption", b && b.data.caption === "alt");

  const bad = first("![alt](javascript:alert(1))");
  ok("a non-http source is refused rather than rendered",
     !bad || bad.type !== "image", bad && bad.type);
}

console.log("\n=== a blockquote keeps everything inside it ===");
{
  const q = first("> A **strong** quote.");
  ok("bold survives inside a quote", /<b>strong<\/b>/.test(textOf(q)), textOf(q));

  const multi = first("> First line.\n> Second line.");
  ok("line breaks become <br>, not spaces",
     textOf(multi).includes("<br>"), textOf(multi));

  /*
   * The 74-bold bug: a quote holding a list used to lose the list entirely,
   * because children that were not paragraphs were filtered out.
   */
  const withList = first("> Intro paragraph.\n>\n> - first item\n> - second item");
  ok("a list inside a quote is kept", textOf(withList).includes("first item"),
     textOf(withList));
  ok("and so is the paragraph beside it",
     textOf(withList).includes("Intro paragraph"), textOf(withList));

  const withHeading = first("> ## A heading\n>\n> and text");
  ok("a heading inside a quote is kept",
     textOf(withHeading).includes("A heading"), textOf(withHeading));
}

console.log("\n=== nested lists flatten without leaking raw markdown ===");
{
  const b = first("- outer\n  - inner\n- second");
  const items = b.data.items;
  ok("every item is present", items.length === 3, JSON.stringify(items));
  ok("the parent item is just its own words", items[0] === "outer", items[0]);
  ok("no literal '- ' leaks into the text",
     !items.some((i) => /^\s*-\s/.test(i) || i.includes("\n")), JSON.stringify(items));
  ok("depth is still visible", items[1].startsWith("·"), items[1]);

  const deep = first("- a\n  - b\n    - c").data.items;
  ok("depth accumulates", deep[2].startsWith("· ·"), deep[2]);
}

console.log("\n=== against the user's own document ===");
{
  const path = REPO + "/sample_docs/md.md";
  if (!fs.existsSync(path)) {
    console.log("  (sample_docs/md.md not present — skipped)");
  } else {
    const md = fs.readFileSync(path, "utf8");

    // What marked itself decides is bold, rendering the document its own way.
    const truthBold = (marked.parse(md).match(/<strong>/g) || []).length;
    const blocks = S.markdownToBlocks(md).blocks;
    const joined = blocks.map((b) => b.data.text ??
      JSON.stringify(b.data.items || b.data.content || "")).join(" ");
    const keptBold = (joined.match(/<b>/g) || []).length;
    ok(`every one of the ${truthBold} bold spans survives`,
       keptBold === truthBold, `${keptBold} of ${truthBold}`);

    // And no words go missing on the way in.
    const a = dom.window.document.createElement("div");
    a.innerHTML = marked.parse(md);
    const truthWords = a.textContent.split(/\s+/).filter(Boolean).length;

    const mine = blocks.map((b) => {
      const d = b.data;
      if (b.type === "code") return d.code || "";
      if (b.type === "list") return (d.items || []).join(" ");
      if (b.type === "checklist") return (d.items || []).map((i) => i.text).join(" ");
      if (b.type === "table") return (d.content || []).flat().join(" ");
      return d.text || "";
    }).join(" ");
    const c = dom.window.document.createElement("div");
    c.innerHTML = mine;
    const mineWords = c.textContent.split(/\s+/).filter(Boolean).length;

    ok(`words survive: ${mineWords} of ${truthWords}`,
       truthWords - mineWords <= 2, `${truthWords - mineWords} missing`);
  }
}

console.log("\n=== a relative image path resolves when the files came with it ===");
/*
 * A Notion export writes its pictures as relative, percent-encoded paths.
 * Those used to be refused outright, so every picture in an exported document
 * vanished with no error. The converter now takes a lookup — supplied by
 * whoever read the folder — and these assertions are what keep the refusal
 * narrow instead of removing it.
 */
{
  const REL = "Reading%20the%20Market%2024f8e1c0/Untitled.png";
  const md = `![a diagram](${REL})`;
  const TINY = "data:image/png;base64,iVBORw0KGgo=";

  const without = S.markdownToBlocks(md).blocks[0];
  ok("with no lookup it is still refused, as before",
     !without || without.type !== "image", without && without.type);

  const resolver = { resolveImage: (href) => (href === REL ? TINY : null) };
  const withIt = S.markdownToBlocks(md, resolver).blocks[0];
  ok("with a lookup it becomes an image block",
     withIt && withIt.type === "image", withIt && withIt.type);
  ok("pointing at what the lookup returned",
     withIt && withIt.data.url === TINY);
  ok("and the alt text is still the caption",
     withIt && withIt.data.caption === "a diagram", withIt && withIt.data.caption);

  const unknown = S.markdownToBlocks("![](Other/missing.png)", resolver).blocks[0];
  ok("a path the lookup cannot find is refused, not rendered empty",
     !unknown || unknown.type !== "image", unknown && unknown.type);

  /*
   * THE ONE THAT MATTERS. An importer must not be able to widen what the
   * converter will render, or the protocol check above becomes decorative.
   */
  const evil = S.markdownToBlocks(md, { resolveImage: () => "javascript:alert(1)" }).blocks[0];
  ok("a lookup cannot smuggle in a javascript: source",
     !evil || evil.type !== "image", evil && evil.data && evil.data.url);

  const thrower = S.markdownToBlocks(md, { resolveImage: () => { throw new Error("boom"); } });
  ok("a lookup that throws loses the picture, not the document",
     Array.isArray(thrower.blocks));

  const inline = S.markdownToBlocks(`Text with ![](${REL}) inside.`, resolver).blocks[0];
  ok("a picture mid-sentence still leaves the sentence alone",
     inline && inline.type === "paragraph", inline && inline.type);
}

console.log("\n=== imageRefs lists what a document asks for ===");
{
  const refs = FolioMarkdown.imageRefs(
    "# Title\n\n![](pics/one.png)\n\nSome text ![](pics/two.png) here.\n\n" +
    "![](https://x.com/remote.png)\n\n```\n![](pics/incode.png)\n```\n\n![](pics/one.png)\n"
  );
  ok("it finds the relative ones", refs.includes("pics/one.png") && refs.includes("pics/two.png"),
     JSON.stringify(refs));
  ok("it leaves http sources alone — nothing to resolve",
     !refs.some((r) => /^https?:/.test(r)), JSON.stringify(refs));
  ok("a path inside a code fence is not a picture to go and fetch",
     !refs.includes("pics/incode.png"), JSON.stringify(refs));
  ok("the same picture twice is asked for once", refs.filter((r) => r === "pics/one.png").length === 1);

  const inTable = FolioMarkdown.imageRefs("| a | b |\n|---|---|\n| ![](t/cell.png) | x |");
  ok("a picture inside a table cell is found too", inTable.includes("t/cell.png"),
     JSON.stringify(inTable));

  const inList = FolioMarkdown.imageRefs("- item ![](l/bullet.png)\n");
  ok("and inside a list item", inList.includes("l/bullet.png"), JSON.stringify(inList));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

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

  const src = fs.readFileSync(REPO + "/js/sidebar.js", "utf8");
  ok("no <strong> is ever emitted", !/<strong>/.test(src) || /strong.*->.*b/.test(src));
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

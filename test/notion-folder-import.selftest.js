/*
 * =============================================================================
 * NOTION-FOLDER-IMPORT.SELFTEST.JS — does a relative path find its picture?
 * =============================================================================
 * WHAT THIS GUARDS:
 * A Notion export points at its pictures with relative, percent-encoded paths,
 * and the folder the paths are relative to is the MARKDOWN FILE'S folder — not
 * whichever level of the tree happened to get dragged onto Folio. So the same
 * export produces two different-looking matches depending on how it was
 * dropped, and the matching has to survive both.
 *
 * That is the part with no obvious right answer and therefore the part worth
 * testing. Walking a dropped folder needs a browser's DataTransfer and is left
 * to the real app; everything below is string work and runs in plain Node.
 */
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const FFI = require(REPO + "/js/folder-import.js");
const { pathsFor, indexAssets, decodePath, titleFor, baseOf, dirOf } = FFI._internals;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

/* Enough of a File for the matcher, which only ever stores and returns it. */
const file = (name) => ({ name, type: "image/png", size: 1024 });

console.log("\n=== a percent-encoded path becomes a real filename ===");
{
  ok("spaces come back",
     decodePath("Reading%20the%20Market%2024f8e1c0/Untitled.png") ===
     "Reading the Market 24f8e1c0/Untitled.png",
     decodePath("Reading%20the%20Market%2024f8e1c0/Untitled.png"));
  ok("a leading ./ means nothing", decodePath("./pics/a.png") === "pics/a.png");
  ok("a leading / means nothing either", decodePath("/pics/a.png") === "pics/a.png");
  ok("windows separators are separators", decodePath("pics\\a.png") === "pics/a.png");
  ok("a fragment is not part of the filename", decodePath("pics/a.png#x") === "pics/a.png");
  ok("nor is a query", decodePath("pics/a.png?v=2") === "pics/a.png");
  /*
   * A stray % is not valid encoding and decodeURIComponent throws on it. The
   * path has to survive that rather than taking the import down with it.
   */
  ok("a path that is not valid encoding survives as written",
     decodePath("pics/100%.png") === "pics/100%.png", decodePath("pics/100%.png"));
  ok("an empty path is empty", decodePath("") === "" && decodePath(null) === "");
}

console.log("\n=== the pieces of a path ===");
{
  ok("a directory keeps its trailing slash", dirOf("Export/Page.md") === "Export/");
  ok("a file at the root has no directory", dirOf("Page.md") === "");
  ok("a basename is the last piece", baseOf("Export/pics/a.png") === "a.png");
  ok("a basename of a bare name is itself", baseOf("a.png") === "a.png");
}

console.log("\n=== three candidate keys, most specific first ===");
{
  const nested = pathsFor("Page%20abc/img.png", "Export/Page.md");
  ok("first: joined to the markdown's own folder",
     nested[0] === "Export/Page abc/img.png", JSON.stringify(nested));
  ok("second: the path exactly as the markdown wrote it",
     nested[1] === "Page abc/img.png", JSON.stringify(nested));
  ok("last: the bare filename, which is the one that can collide",
     nested[2] === "img.png", JSON.stringify(nested));

  /*
   * When the markdown sits at the root of the drop, the first two keys are the
   * same string. Returning it twice would make the fallback order meaningless.
   */
  const flat = pathsFor("pics/img.png", "Page.md");
  ok("duplicate keys collapse", flat.length === 2, JSON.stringify(flat));
  ok("and the order still runs specific to general",
     flat[0] === "pics/img.png" && flat[1] === "img.png", JSON.stringify(flat));
}

console.log("\n=== dragging the OUTER folder still finds the pictures ===");
/*
 * The walk saw `Export/Reading the Market 24f8e1c0/Untitled.png`; the markdown
 * asked for `Reading%20the%20Market%2024f8e1c0/Untitled.png`. Only the first
 * candidate key matches, and it is the reason that key exists.
 */
{
  /*
   * A DECOY GOES FIRST, deliberately. "Untitled.png" is the commonest filename
   * in any Notion export, so a second folder holding one is the normal case,
   * not a contrived one — and it is registered first so the bare-filename
   * fallback would return the WRONG file. Without the decoy this test passes
   * through that fallback and proves nothing about the key it is named after.
   */
  const assets = indexAssets([
    { path: "Export/Some Other Page 9bc1/Untitled.png", file: file("DECOY") },
    { path: "Export/Reading the Market 24f8e1c0/Untitled.png", file: file("RIGHT") },
    { path: "Export/Reading the Market 24f8e1c0.md", file: file("Reading the Market 24f8e1c0.md") },
  ]);
  const found = assets.find("Reading%20the%20Market%2024f8e1c0/Untitled.png",
                            "Export/Reading the Market 24f8e1c0.md");
  ok("the picture is found", !!found, "not found");
  ok("and it is this page's picture, not the other page's",
     found && found.name === "RIGHT", found && found.name);

  /* And the other page's reference still finds the other page's picture. */
  const other = assets.find("Some%20Other%20Page%209bc1/Untitled.png",
                            "Export/Reading the Market 24f8e1c0.md");
  ok("each page gets its own", other && other.name === "DECOY", other && other.name);
}

console.log("\n=== dragging the INNER folder finds them too ===");
{
  const assets = indexAssets([
    { path: "Reading the Market 24f8e1c0/Untitled.png", file: file("Untitled.png") },
  ]);
  ok("the path as written matches directly",
     !!assets.find("Reading%20the%20Market%2024f8e1c0/Untitled.png",
                   "Reading the Market 24f8e1c0.md"));
}

console.log("\n=== the bare-filename fallback, and its limits ===");
{
  const assets = indexAssets([
    { path: "somewhere/else/entirely/Untitled.png", file: file("Untitled.png") },
  ]);
  ok("a picture that moved is still found by its name",
     !!assets.find("Page%20abc/Untitled.png", "Page abc.md"));

  ok("a picture that is not in the folder is not invented",
     assets.find("Page%20abc/Missing.png", "Page abc.md") === null);

  /*
   * Two subfolders holding the same filename is exactly the collision the
   * fallback risks. The specific key has to win, or an export with a dozen
   * "Untitled.png" files would show the same picture a dozen times.
   */
  const colliding = indexAssets([
    { path: "One/Untitled.png", file: file("ONE") },
    { path: "Two/Untitled.png", file: file("TWO") },
  ]);
  const hit = colliding.find("Two/Untitled.png", "doc.md");
  ok("the exact path wins over the shared filename", hit && hit.name === "TWO",
     hit && hit.name);
}

console.log("\n=== case, because macOS does not care and an export might ===");
{
  const assets = indexAssets([
    { path: "Page abc/Untitled.PNG", file: file("Untitled.PNG") },
  ]);
  ok("a path whose case disagrees with the file still matches",
     !!assets.find("Page%20abc/untitled.png", "Page abc.md"));
}

console.log("\n=== only pictures are indexed ===");
{
  const assets = indexAssets([
    { path: "Export/notes.md", file: file("notes.md") },
    { path: "Export/a.png", file: file("a.png") },
  ]);
  ok("the markdown file is not offered as a picture",
     assets.find("notes.md", "Export/doc.md") === null);
  ok("the picture is", !!assets.find("a.png", "Export/doc.md"));
}

console.log("\n=== the page gets a title a person would recognise ===");
{
  ok("the document's own first heading wins",
     titleFor("Reading the Market 24f8e1c0b3f5801aa9f1.md", "# Reading the Market\n\nText.") ===
     "Reading the Market");
  ok("with no heading, the filename loses its Notion id",
     titleFor("Reading the Market 24f8e1c0b3f5801aa9f1.md", "Just text.") ===
     "Reading the Market",
     titleFor("Reading the Market 24f8e1c0b3f5801aa9f1.md", "Just text."));
  ok("a plain filename is left alone",
     titleFor("notes.md", "Just text.") === "notes");
  ok("a nested path uses the filename, not the path",
     titleFor("Export/sub/Page abc12345.md", "") === "Page");
  ok("nothing usable still gives a title",
     titleFor(".md", "") === "Untitled", titleFor(".md", ""));
  /* A heading deeper in the document is not the title of the page. */
  ok("only a top-level heading counts",
     titleFor("notes.md", "Some text\n\n## Later heading") === "notes",
     titleFor("notes.md", "Some text\n\n## Later heading"));
}

console.log("\n=== what the message says ===");
/*
 * This is the only thing the user actually reads when a drop finishes, so it
 * has to be in the words of what happened and it has to admit the bad news.
 */
{
  ok("one page, no pictures",
     FFI.describe({ handled: true, pages: [1], pictures: 0, missing: 0 }) ===
     "Imported 1 page",
     FFI.describe({ handled: true, pages: [1], pictures: 0, missing: 0 }));

  ok("pages and pictures are counted",
     FFI.describe({ handled: true, pages: [1, 2], pictures: 7, missing: 0 }) ===
     "Imported 2 pages with 7 pictures");

  ok("a missing picture is said out loud, not hidden",
     /1 picture was not in the folder/.test(
       FFI.describe({ handled: true, pages: [1], pictures: 3, missing: 1 })),
     FFI.describe({ handled: true, pages: [1], pictures: 3, missing: 1 }));

  ok("when some pages fitted and the disk then filled, it says both",
     /Imported 1 of 3 pages/.test(FFI.describe({
       handled: true, pages: [1], pictures: 9, missing: 0, total: 3,
       error: { folioQuota: true },
     })) && /filled up/.test(FFI.describe({
       handled: true, pages: [1], pictures: 9, missing: 0, total: 3,
       error: { folioQuota: true },
     })),
     FFI.describe({ handled: true, pages: [1], pictures: 9, missing: 0, total: 3,
                    error: { folioQuota: true } }));

  /*
   * The likeliest outcome for a screenshot-heavy export, and therefore the
   * sentence most worth getting right. Composing it from the same pieces as
   * the others produced "Nothing could be imported with 118 pictures", which
   * reads as if the pictures were what got imported.
   */
  const tooBig = FFI.describe({ handled: true, pages: [], pictures: 118, missing: 0,
                                total: 1, error: { folioQuota: true } });
  ok("when nothing fitted at all it says so plainly",
     /^Storage is full, so nothing was imported/.test(tooBig), tooBig);
  ok("and does not claim the pictures arrived", !/with 118 pictures/.test(tooBig), tooBig);

  ok("a drop that was not handled says nothing",
     FFI.describe({ handled: false, pages: [] }) === "");
}

console.log("\n=== a drop with no folder in it is left to the old path ===");
/*
 * fromDrop returning null is the signal js/sidebar.js uses to fall back to
 * reading a single dropped file, which is the oldest way into Folio and must
 * keep working untouched.
 */
{
  ok("no items at all", FFI.fromDrop(undefined) === null);
  ok("an empty item list", FFI.fromDrop({ items: [] }) === null);
  ok("a single file, not a folder",
     FFI.fromDrop({ items: [{ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) }] })
       === null);
  ok("a browser with no entry support",
     FFI.fromDrop({ items: [{}] }) === null);
  const folder = FFI.fromDrop({
    items: [{ webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: "Export",
                                         createReader: () => ({ readEntries: (res) => res([]) }) }) }],
  });
  ok("a folder is taken on", folder && typeof folder.then === "function");
}

/* The module has to stay loadable in both worlds, which the require above proves. */
console.log("\n=== the module is readable from Node and the browser ===");
{
  ok("it exports what the app calls",
     typeof FFI.fromDrop === "function" && typeof FFI.importEntries === "function" &&
     typeof FFI.describe === "function");
  ok("it is wired into both entry points",
     ["index.html", "index-electron.html"].every((f) =>
       fs.readFileSync(REPO + "/" + f, "utf8").includes("js/folder-import.js")));
  /*
   * The converter is loaded before this module in both pages. If that ever
   * flips, FolioMarkdown would be undefined at the moment a drop is handled.
   */
  ok("and after the converter it depends on",
     ["index.html", "index-electron.html"].every((f) => {
       const html = fs.readFileSync(REPO + "/" + f, "utf8");
       return html.indexOf("js/markdown.js") < html.indexOf("js/folder-import.js");
     }));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

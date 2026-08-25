/*
 * Moving a page in the tree.
 *
 * The failure that matters here is not a wrong sort order — it is dropping a
 * page into its own descendant. That leaves the subtree in storage but
 * unreachable from the root, so it disappears from the sidebar and is
 * indistinguishable from having lost it.
 *
 * Second in line: `order` ties. Before this, `order` was written once at
 * creation and never touched, so two pages could share a number and the tree
 * would rearrange itself between reloads.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://x.test" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

const S = eval(fs.readFileSync(REPO + "/js/store.js", "utf8") + "; FolioStore;");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

/*
 *  a
 *  ├── a1
 *  │   └── a1x
 *  └── a2
 *  b
 */
function seed() {
  localStorage.clear();
  const t = (n) => new Date(1787000000000 + n * 1000).toISOString();
  localStorage.setItem("folio_documents", JSON.stringify([
    { id: "a",   title: "A",   parentId: null, order: 0, createdAt: t(0), updatedAt: t(0) },
    { id: "b",   title: "B",   parentId: null, order: 1, createdAt: t(1), updatedAt: t(1) },
    { id: "a1",  title: "A1",  parentId: "a",  order: 0, createdAt: t(2), updatedAt: t(2) },
    { id: "a2",  title: "A2",  parentId: "a",  order: 1, createdAt: t(3), updatedAt: t(3) },
    { id: "a1x", title: "A1X", parentId: "a1", order: 0, createdAt: t(4), updatedAt: t(4) },
  ]));
}
const kids = (p) => (p ? S.getChildDocuments(p) : S.getTopLevelDocuments()).map((d) => d.id);
const orders = (p) => (p ? S.getChildDocuments(p) : S.getTopLevelDocuments()).map((d) => d.order);

console.log("\n=== the seeded tree reads back as written ===");
seed();
ok("two pages at the root", kids(null).join(",") === "a,b", kids(null).join(","));
ok("A has two children in order", kids("a").join(",") === "a1,a2", kids("a").join(","));
ok("A1 has one child", kids("a1").join(",") === "a1x");

console.log("\n=== A CYCLE MUST BE REFUSED ===");
seed();
ok("a page cannot be dropped into its own child",
   S.reorderDocument("a", "a1", 0) === false);
ok("nor into a deeper descendant",
   S.reorderDocument("a", "a1x", 0) === false);
ok("nor into itself", S.reorderDocument("a", "a", 0) === false);
ok("and the tree is untouched after all three",
   kids(null).join(",") === "a,b" && kids("a").join(",") === "a1,a2" &&
   kids("a1").join(",") === "a1x",
   `${kids(null)} / ${kids("a")} / ${kids("a1")}`);
ok("every page is still reachable from the root",
   reachable().size === 5, String(reachable().size));

console.log("\n=== moving DOWNWARD is fine in the other direction ===");
seed();
ok("a child can move under a different parent",
   S.reorderDocument("a1", "b", 0) === true);
ok("it left its old parent", kids("a").join(",") === "a2", kids("a").join(","));
ok("it arrived at the new one", kids("b").join(",") === "a1", kids("b").join(","));
ok("its own child came with it", kids("a1").join(",") === "a1x");
ok("nothing was orphaned", reachable().size === 5, String(reachable().size));

console.log("\n=== ordering has no gaps and no ties ===");
seed();
S.reorderDocument("a1", "b", 0);
ok("the abandoned parent is renumbered from zero",
   orders("a").join(",") === "0", orders("a").join(","));
ok("the receiving parent too", orders("b").join(",") === "0", orders("b").join(","));

seed();
S.reorderDocument("b", null, 0);              // B jumps ahead of A
ok("a root reorder takes effect", kids(null).join(",") === "b,a", kids(null).join(","));
ok("and renumbers contiguously", orders(null).join(",") === "0,1", orders(null).join(","));

console.log("\n=== a no-op is recognised, not written ===");
seed();
const before = localStorage.getItem("folio_documents");
ok("moving a page to where it already is returns false",
   S.reorderDocument("a1", "a", 0) === false);
ok("and writes nothing at all",
   localStorage.getItem("folio_documents") === before);

console.log("\n=== inserting between siblings ===");
seed();
ok("B can be placed between A's children",
   S.reorderDocument("b", "a", 1) === true);
ok("it lands in the middle", kids("a").join(",") === "a1,b,a2", kids("a").join(","));
ok("orders stay contiguous", orders("a").join(",") === "0,1,2", orders("a").join(","));
ok("the root now holds only A", kids(null).join(",") === "a", kids(null).join(","));

console.log("\n=== an index past the end appends rather than throwing ===");
seed();
ok("a huge index is clamped", S.reorderDocument("b", "a", 999) === true);
ok("and it lands last", kids("a").join(",") === "a1,a2,b", kids("a").join(","));

console.log("\n=== ties in stored data settle deterministically ===");
localStorage.clear();
const t = (n) => new Date(1787000000000 + n * 1000).toISOString();
localStorage.setItem("folio_documents", JSON.stringify([
  { id: "x", title: "X", parentId: null, order: 0, createdAt: t(2), updatedAt: t(2) },
  { id: "y", title: "Y", parentId: null, order: 0, createdAt: t(1), updatedAt: t(1) },
]));
const first = kids(null).join(",");
ok("two pages sharing an order do not shuffle between reads",
   first === kids(null).join(",") && first === kids(null).join(","), first);
ok("the older one wins the tie", first === "y,x", first);

console.log("\n=== isDescendantOf ===");
seed();
ok("a1x is a descendant of a", S.isDescendantOf("a1x", "a") === true);
ok("a is not a descendant of a1x", S.isDescendantOf("a", "a1x") === false);
ok("b is unrelated to a", S.isDescendantOf("b", "a") === false);
ok("a missing id is not a descendant", S.isDescendantOf("nope", "a") === false);

/* Every page the sidebar could actually render, walking down from the root. */
function reachable() {
  const seen = new Set();
  const walk = (pid) => {
    for (const d of (pid ? S.getChildDocuments(pid) : S.getTopLevelDocuments())) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      walk(d.id);
    }
  };
  walk(null);
  return seen;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

# Dragging pages, and subpages

Planned 26 August 2026. Research and design; implementation follows.

## TL;DR

- **Half of this already ships.** `createSubpage` exists (`js/sidebar.js:287`)
  and is reachable two ways: the `+` on every row (`:123`) and "Add Subpage" in
  the context menu (`:173`). Nesting, expand/collapse and recursive rendering
  all work. **What is missing is dragging.**
- **Three drop targets per row, not one.** Top quarter = drop *above*, bottom
  quarter = drop *below*, middle half = drop *inside* as a child. One zone
  cannot express both "reorder" and "reparent", and users expect both.
- **`order` is written once at creation and never touched again**
  (`js/store.js:107`), and `listDocuments` sorts by it **globally** rather than
  within a parent. Reordering needs it maintained per parent — this is the only
  data-model change.
- **A page must not be dropped into its own descendant.** Nothing prevents it
  today and it would orphan a whole subtree out of the visible tree while
  leaving it in storage.
- **The existing file-drop must keep working.** `js/sidebar.js:586` listens on
  `document` for dropped `.md` files. A page drag carries no files, so it falls
  through harmlessly — but this needs a test, not an assumption.
- HTML5 drag-and-drop, not pointer events: it coexists with the file drop, it
  gives us `dragenter`/`dragleave` for free, and Folio has no gesture library.

## What exists today

| Piece | Where | State |
|---|---|---|
| `parentId` on document meta | `js/store.js:95` | Works |
| Recursive tree render | `js/sidebar.js:66` `buildPageItem` | Works |
| Expand/collapse, remembered | `js/sidebar.js:34` `expandedNodes` | Works |
| Create a subpage | `js/sidebar.js:287` | **Already done** |
| `+` button per row | `js/sidebar.js:117-125` | Works |
| "Add Subpage" menu item | `js/sidebar.js:173` | Works |
| Auto-expand ancestors on search hit | `js/sidebar.js:666` | Works |
| Reparent by dragging | — | **Missing** |
| Reorder siblings | — | **Missing** |
| `order` maintained | `js/store.js:107` sets it once | **Broken by omission** |

So the request reduces to: **dragging**, plus fixing `order` so a reorder can
persist.

## The interaction

### Three zones on every row

```
┌─────────────────────────────┐
│  ▔▔▔▔ top 25% → drop ABOVE  │   a 2px accent line appears above the row
│                             │
│   middle 50% → drop INSIDE  │   the row tints; it becomes the parent
│                             │
│  ▁▁▁▁ bottom 25% → BELOW    │   a 2px accent line appears below the row
└─────────────────────────────┘
```

One zone would force a choice between reordering and nesting. Three is what
Finder, Notion and every file tree do, and the proportions matter: a 50% middle
makes nesting the easy default while leaving reordering reachable.

**Indentation follows the line.** When the line is drawn under a row that has
children and is expanded, the drop means "first child", not "next sibling" —
otherwise dropping just below an expanded parent is ambiguous. The line is
indented to show which it will be.

### Auto-expand while hovering

Hovering the middle of a **collapsed** row for **600 ms** expands it, so you can
drag into a nested position without dropping and picking up again. Cancelled the
moment the pointer leaves the row.

### What is not a valid drop

- Onto itself.
- Into its own descendant — the check walks up from the target through
  `parentId`; if it meets the dragged page, the drop is refused.
- Into the position it already occupies (a no-op, silently ignored).

Refused targets show **no indicator at all**, and the cursor keeps the "no drop"
form. Nothing worse than an interface that accepts a gesture and then does
nothing.

### Root level

A drop zone below the last top-level row, spanning the remaining sidebar height,
means "make this a top-level page". Without it there is no way to *un*-nest by
dragging, only by dragging onto another root page.

## Data model

The only change is making `order` real.

```js
// New in js/store.js
reorderDocument(id, newParentId, newIndex)
```

It must:

1. Refuse if `newParentId` is `id` or a descendant of `id`.
2. Set `parentId`.
3. Renumber **all** siblings under `newParentId` 0..n-1 with the moved page
   inserted at `newIndex`, and renumber the **old** parent's remaining children
   too, so no gaps or ties are left behind.
4. Write once — one `folio_documents` array, one save.

And `getChildDocuments` / `getTopLevelDocuments` must sort **within the parent**:

```js
docs.filter(...).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))
```

Today `listDocuments` sorts globally by `order`, which mixes documents from
different parents that happen to share a number — harmless while ordering is
never edited, wrong the moment it is.

## Edge cases

| Case | Behaviour |
|---|---|
| Drop a page into its own child | Refused, no indicator |
| Drop onto itself | Refused |
| Drop into the same place | No-op, no write, no re-render |
| Drop onto a collapsed parent | Expands it and appends as last child |
| Dragging the currently-open page | Allowed; selection and route unaffected |
| Dragging while a page is being read aloud | Allowed; reading is on the document, not the tree |
| Dragging a page with a large subtree | Only the moved page's `parentId` changes; descendants follow automatically |
| A `.md` file dragged in from Finder | Still imports — different `dataTransfer` payload |
| A page dragged out of the sidebar and dropped on the article | Nothing; only sidebar targets accept |
| Drag cancelled with Escape / dropped outside | All indicators cleared, nothing written |
| Two rapid drags | Second re-reads from storage; last write wins |
| Deep nesting (5+ levels) | Allowed; indentation is `16px * depth` and will crowd — cap the visual indent at ~6 levels |
| Empty sidebar | Root zone still accepts, so a page can always be un-nested |

## What could go wrong that a test should catch

1. **A cycle is created** and a subtree vanishes from the tree while remaining in
   storage. The nastiest failure here — silent data loss from the user's point
   of view.
2. **`order` ties** leave the tree in an order that changes on every reload.
3. **The file import breaks**, because a page drag now consumes the drop.
4. **Indicators stick** after a cancelled drag.
5. **Reparenting loses the open document**, because the route points at an id
   whose position changed (it should not — routing is by id, not by path).

## Build order

1. `reorderDocument` + per-parent sorting in `js/store.js`, with a unit test
   covering cycles, renumbering and ties. **No UI yet** — the dangerous part is
   the data.
2. Drag on rows, three zones, indicators, cycle refusal.
3. Auto-expand on hover; the root drop zone.
4. Browser probe: drag to nest, drag to reorder, refuse a cycle, file import
   still works.

## Deliberately not doing

- **Multi-select drag.** One page at a time; the sidebar has no selection model.
- **Drag from the sidebar into the document** to insert a link. Different
  feature.
- **Undo.** There is no undo stack for the tree, and adding one for this alone
  would be inconsistent with rename and delete, which also have none.

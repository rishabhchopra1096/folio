/*
 * =============================================================================
 * READS-STUB.JS — the reads half of FolioStore, for suites that stub the store
 * =============================================================================
 * FILE OVERVIEW:
 * Several suites hand-build a `global.FolioStore` object with only the handful
 * of functions they need. Comments and highlights now carry a `readId` — which
 * pass through the document they were written during — so the comments module
 * calls `ensureReads`, `getCurrentRead` and `readLabel`, and those stubs stop
 * being complete enough to run.
 *
 * This file supplies exactly those functions over a plain in-memory array, so a
 * suite can write `{ ...readsStub(reads), getComments: ... }` and carry on
 * testing what it was actually about.
 *
 * WHY IT IS A SHARED FILE AND NOT COPIED INTO EACH SUITE:
 * A stub that drifts from the real store is worse than no stub, because it
 * makes a suite pass against behaviour the app does not have. One copy, kept
 * next to a note saying what it mirrors, is the cheapest way to notice when the
 * real contract changes.
 *
 * WHAT IT MIRRORS — keep in step with js/store.js:
 *   - a read is { id, n, color, startedAt }
 *   - the CURRENT read is the LAST element of the array, never a flag
 *   - colours cycle through READ_COLORS in the order reads are created
 *   - readLabel(read) is "Read " + read.n
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 * It does not migrate. The real `ensureReads` back-fills a `readId` onto
 * existing comments and highlights, and that behaviour is tested against the
 * REAL store in reads.selftest.js — not here. A stub that pretended to migrate
 * would be testing this file instead of the app.
 * =============================================================================
 */

// The same four colours the real store draws from, in the same order.
const READ_COLORS = ["yellow", "green", "blue", "pink"];

/*
 * WHAT THIS FUNCTION DOES:
 * Returns an object holding the reads half of the FolioStore API, backed by
 * the array you pass in.
 *
 * WHY WE NEED IT:
 * So a suite that only cares about, say, transcript formatting does not have to
 * know anything about reads beyond "there is one".
 *
 * HOW TO USE IT:
 *   const { readsStub } = require("./fixtures/reads-stub.js");
 *   const reads = [{ id: "rd_1", n: 1, color: "yellow", startedAt: "2026-01-01T00:00:00Z" }];
 *   global.FolioStore = { ...readsStub(reads), getComments: () => comments, ... };
 *
 * Pass no argument for a single default Read 1, which is what a suite wants
 * when it has no opinion about reads at all.
 */
function readsStub(reads) {
  // Default to one read, so the module under test always has a current read.
  const list = reads || [
    { id: "rd_1", n: 1, color: READ_COLORS[0], startedAt: "2026-01-01T00:00:00Z" },
  ];

  return {
    READ_COLORS: READ_COLORS,

    // Every read in the document, oldest first.
    getReads: () => list,

    saveReads: () => {},

    // The real one migrates on first call; here the list is always ready.
    ensureReads: () => list,

    // The current read is the last one — the same rule the real store uses.
    getCurrentRead: () => (list.length ? list[list.length - 1] : null),

    // Append a read numbered one past the last, taking the next colour.
    startNewRead: () => {
      const last = list[list.length - 1];
      const n = last ? last.n + 1 : 1;
      const read = {
        id: "rd_" + n,
        n: n,
        color: READ_COLORS[(n - 1) % READ_COLORS.length],
        startedAt: new Date().toISOString(),
      };
      list.push(read);
      return read;
    },

    readLabel: (read) => (read ? "Read " + read.n : "Read"),
  };
}

module.exports = { readsStub, READ_COLORS };

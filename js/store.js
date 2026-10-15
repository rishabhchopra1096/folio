/*
 * =============================================================================
 * STORE.JS — localStorage Data Layer for Folio
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages ALL persistent data for the Folio app. Since Folio is a
 * personal tool with no backend, everything lives in the browser's localStorage.
 *
 * HOW IT WORKS - The Data Model:
 * - folio_documents: JSON array of document metadata (title, icon, parent, dates)
 * - folio_doc_{id}: Editor.js JSON data for each document (blocks array)
 * - folio_highlights_{id}: JSON array of highlights per document
 * - folio_comments_{id}: JSON array of comments per document
 * - folio_settings: Global app settings (theme, font size, sidebar state, etc.)
 *
 * NESTED PAGES:
 * Documents have a parentId field. If null, they're top-level pages.
 * If set to another document's ID, they're a child page (nested under it).
 * This enables Notion-style page hierarchy.
 *
 * CONTENT FORMAT:
 * Documents store Editor.js JSON, not raw markdown. This preserves block
 * structure (headings, checklists, tables, code blocks, etc.) perfectly.
 * Markdown files can be imported by converting them to Editor.js blocks.
 * =============================================================================
 */

const FolioStore = (function () {

  // ==========================================================================
  // HELPERS — Utility functions used throughout the store
  // ==========================================================================

  // Generate a unique ID by combining a timestamp with a random string
  /*
   * ==========================================================================
   * KEEPING THE DATA
   * ==========================================================================
   * Every page, highlight and comment in Folio lives in this browser and
   * nowhere else. By default that storage is BEST EFFORT: Safari's tracking
   * prevention clears it after about seven days without a visit, and Chrome
   * evicts under storage pressure. Neither asks first, and the symptom would be
   * someone's notes simply being gone.
   *
   * navigator.storage.persist() asks for durable storage instead. Chrome grants
   * it silently on engagement signals; Safari grants it for installed web apps.
   * It can be refused, so the answer is recorded rather than assumed.
   *
   * This used to be requested only when the read-aloud audio cache first
   * opened — so a user who never turned on a paid voice never got it for their
   * DOCUMENTS, which is the thing that actually matters.
   */
  async function requestDurableStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return "unsupported";
      const already = navigator.storage.persisted
        ? await navigator.storage.persisted() : false;
      const granted = already || await navigator.storage.persist();
      try { localStorage.setItem("folio_storage_durable", granted ? "yes" : "no"); }
      catch { /* nothing more we can do */ }
      return granted ? "durable" : "best-effort";
    } catch { return "failed"; }
  }

  function storageDurability() {
    try { return localStorage.getItem("folio_storage_durable") || "unknown"; }
    catch { return "unknown"; }
  }

  /* How much room is left, so a warning can precede a failure. */
  async function storageEstimate() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch { return null; }
  }

  function generateId(prefix) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${timestamp}_${random}`;
  }

  // Safely read and parse JSON from localStorage, returning a fallback if missing
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  // Write a JSON value to localStorage
  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // ==========================================================================
  // DOCUMENTS — Create, read, update, delete document metadata + content
  // ==========================================================================

  // Get the full list of document metadata objects, sorted by order then updated
  function listDocuments() {
    const docs = readJSON("folio_documents", []);
    docs.sort((a, b) => {
      // Sort by explicit order first, then by updatedAt
      if (a.order !== undefined && b.order !== undefined) {
        return a.order - b.order;
      }
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return docs;
  }

  // Get top-level documents (no parent)
  /*
   * Siblings come back in THEIR OWN order.
   *
   * listDocuments sorts by `order` across the whole collection, which mixes
   * pages from different parents that happen to share a number — harmless while
   * nothing ever reordered anything, wrong the moment dragging exists. Ordering
   * is only ever meaningful among siblings, so it is applied here.
   */
  function sortSiblings(docs) {
    return docs.sort(function (a, b) {
      const ao = typeof a.order === "number" ? a.order : Infinity;
      const bo = typeof b.order === "number" ? b.order : Infinity;
      if (ao !== bo) return ao - bo;
      // A tie means neither was placed deliberately; fall back to age so the
      // tree at least stops rearranging itself between reloads.
      return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });
  }

  function getTopLevelDocuments() {
    return sortSiblings(listDocuments().filter((d) => !d.parentId));
  }

  // Get children of a specific document
  function getChildDocuments(parentId) {
    return sortSiblings(listDocuments().filter((d) => d.parentId === parentId));
  }

  /*
   * Is `maybeAncestor` somewhere above `id` in the tree?
   *
   * The guard that stops a page being dropped into its own descendant. Without
   * it the subtree stays in storage but becomes unreachable from the root — it
   * vanishes from the sidebar, which is indistinguishable from losing it.
   *
   * Walks upward with a hop limit rather than a visited set: if storage were
   * already cyclic — which this exists to prevent, but a hand-edited backup
   * could manage it — an unbounded walk would hang the tab.
   */
  function isDescendantOf(id, maybeAncestor) {
    if (!id || !maybeAncestor) return false;
    const docs = readJSON("folio_documents", []);
    const byId = new Map(docs.map((d) => [d.id, d]));
    let cur = byId.get(id);
    for (let hops = 0; cur && hops < 1000; hops++) {
      if (cur.parentId === maybeAncestor) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return false;
  }

  /*
   * Move a page: a new parent, a new position among its siblings, or both.
   * Returns true only if something actually changed.
   *
   * BOTH sibling lists are renumbered from zero afterwards — the one it left
   * and the one it joined — so `order` never develops gaps or ties. Ties are
   * what let the tree quietly rearrange itself between reloads.
   */
  function reorderDocument(id, newParentId, newIndex) {
    const parentId = newParentId || null;

    // A page cannot contain itself, directly or at any depth.
    if (id === parentId) return false;
    if (parentId && isDescendantOf(parentId, id)) return false;

    const docs = readJSON("folio_documents", []);
    const moved = docs.find((d) => d.id === id);
    if (!moved) return false;

    const oldParentId = moved.parentId || null;
    const siblingsOf = (pid) => sortSiblings(
      docs.filter((d) => d.id !== id && (d.parentId || null) === pid));

    const target = siblingsOf(parentId);
    const at = Math.max(0, Math.min(
      typeof newIndex === "number" ? newIndex : target.length, target.length));

    // Already exactly there — do not churn updatedAt or force a re-render.
    if (oldParentId === parentId) {
      const now = sortSiblings(docs.filter((d) => (d.parentId || null) === parentId));
      if (now.indexOf(moved) === at) return false;
    }

    moved.parentId = parentId;
    target.splice(at, 0, moved);
    target.forEach((d, i) => { d.order = i; });

    // The list it left now has a hole in it.
    if (oldParentId !== parentId) {
      siblingsOf(oldParentId).forEach((d, i) => { d.order = i; });
    }

    moved.updatedAt = new Date().toISOString();
    writeJSON("folio_documents", docs);
    return true;
  }

  // Get a single document's metadata and content (Editor.js JSON)
  function getDocument(id) {
    const docs = readJSON("folio_documents", []);
    const meta = docs.find((d) => d.id === id);
    if (!meta) return null;
    // Content is Editor.js JSON data
    const content = readJSON(`folio_doc_${id}`, { time: Date.now(), blocks: [] });
    return { meta, content };
  }

  // Create a new document and return its metadata
  // content can be Editor.js JSON or null for empty doc
  function createDocument(title, content, parentId) {
    const id = generateId("doc");
    const now = new Date().toISOString();

    // Calculate word count from Editor.js blocks
    const editorData = content || { time: Date.now(), blocks: [] };
    const wordCount = countWordsInBlocks(editorData.blocks || []);

    const meta = {
      id,
      title: title || "Untitled",
      icon: "",
      parentId: parentId || null,
      order: listDocuments().filter((d) => d.parentId === (parentId || null)).length,
      createdAt: now,
      updatedAt: now,
      wordCount,
    };

    // Add to the metadata array
    const docs = readJSON("folio_documents", []);
    docs.push(meta);
    writeJSON("folio_documents", docs);

    // Store the Editor.js content separately
    writeJSON(`folio_doc_${id}`, editorData);

    return meta;
  }

  // Update a document's title, content, icon, parentId, or order
  function updateDocument(id, changes) {
    const docs = readJSON("folio_documents", []);
    const idx = docs.findIndex((d) => d.id === id);
    if (idx === -1) return null;

    // If Editor.js content changed, update it and recalculate word count
    if (changes.content !== undefined) {
      writeJSON(`folio_doc_${id}`, changes.content);
      docs[idx].wordCount = countWordsInBlocks(changes.content.blocks || []);
    }

    // Update other metadata fields if provided
    if (changes.title !== undefined) docs[idx].title = changes.title;
    if (changes.icon !== undefined) docs[idx].icon = changes.icon;
    if (changes.parentId !== undefined) docs[idx].parentId = changes.parentId;
    if (changes.order !== undefined) docs[idx].order = changes.order;

    // Always bump the updatedAt timestamp
    docs[idx].updatedAt = new Date().toISOString();
    writeJSON("folio_documents", docs);

    return docs[idx];
  }

  // Delete a document and all its associated data (highlights, comments)
  // Also deletes all child documents recursively
  function deleteDocument(id) {
    // First, recursively delete all children
    const children = getChildDocuments(id);
    children.forEach((child) => deleteDocument(child.id));

    let docs = readJSON("folio_documents", []);
    docs = docs.filter((d) => d.id !== id);
    writeJSON("folio_documents", docs);

    // Remove the content, highlights, comments and reads keys
    localStorage.removeItem(`folio_doc_${id}`);
    localStorage.removeItem(`folio_highlights_${id}`);
    localStorage.removeItem(`folio_comments_${id}`);
    localStorage.removeItem(`folio_reads_${id}`);
  }

  // Count words across all Editor.js blocks
  function countWordsInBlocks(blocks) {
    let text = "";
    blocks.forEach((block) => {
      if (block.data) {
        // Extract text from common block types
        if (block.data.text) text += " " + block.data.text;
        if (block.data.items) {
          block.data.items.forEach((item) => {
            // Checklist items have a 'text' field, list items may be strings or objects
            if (typeof item === "string") text += " " + item;
            else if (item.text) text += " " + item.text;
            else if (item.content) text += " " + item.content;
          });
        }
        if (block.data.content) {
          // Table content: array of arrays
          if (Array.isArray(block.data.content)) {
            block.data.content.forEach((row) => {
              if (Array.isArray(row)) row.forEach((cell) => (text += " " + cell));
            });
          }
        }
      }
    });
    // Strip HTML tags from the text before counting
    const stripped = text.replace(/<[^>]*>/g, "");
    return stripped.trim().split(/\s+/).filter(Boolean).length;
  }

  // ==========================================================================
  // SEARCH — Full-text search across all documents
  // ==========================================================================

  function searchDocuments(query) {
    if (!query || !query.trim()) return [];

    const q = query.toLowerCase().trim();
    const docs = listDocuments();
    const results = [];

    docs.forEach((doc) => {
      let score = 0;
      let matchSnippet = "";

      // Search in title (high weight)
      if (doc.title.toLowerCase().includes(q)) {
        score += 10;
        matchSnippet = doc.title;
      }

      // Search in content (lower weight)
      const content = readJSON(`folio_doc_${doc.id}`, { blocks: [] });
      const blocks = content.blocks || [];
      for (const block of blocks) {
        const blockText = extractBlockText(block);
        if (blockText.toLowerCase().includes(q)) {
          score += 1;
          if (!matchSnippet) {
            // Grab a snippet around the match
            const idx = blockText.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 30);
            const end = Math.min(blockText.length, idx + q.length + 50);
            matchSnippet = (start > 0 ? "..." : "") +
              blockText.slice(start, end) +
              (end < blockText.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({ doc, score, snippet: matchSnippet });
      }
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // Extract plain text from an Editor.js block
  function extractBlockText(block) {
    if (!block.data) return "";
    let text = "";
    if (block.data.text) text += block.data.text;
    if (block.data.items) {
      block.data.items.forEach((item) => {
        if (typeof item === "string") text += " " + item;
        else if (item.text) text += " " + item.text;
        else if (item.content) text += " " + item.content;
      });
    }
    // Strip HTML
    return text.replace(/<[^>]*>/g, "");
  }

  // ==========================================================================
  // HIGHLIGHTS — Read and write highlight data per document
  // ==========================================================================

  function getHighlights(docId) {
    return readJSON(`folio_highlights_${docId}`, []);
  }

  function saveHighlights(docId, highlights) {
    writeJSON(`folio_highlights_${docId}`, highlights);
  }

  // ==========================================================================
  // COMMENTS — Read and write comment data per document
  // ==========================================================================

  function getComments(docId) {
    return readJSON(`folio_comments_${docId}`, []);
  }

  function saveComments(docId, comments) {
    writeJSON(`folio_comments_${docId}`, comments);
  }

  // ==========================================================================
  // READS — one record per pass through a document
  // ==========================================================================
  /*
   * WHAT A READ IS:
   * A "read" is one occasion on which you went through a document. You read
   * something in March, you come back to it in October, and the thoughts you
   * have the second time are not the thoughts you had the first time. A read
   * groups them so they can be exported apart.
   *
   * WHY IT IS STORED AS AN ARRAY AND NOT A FLAG:
   * The reads for a document live in `folio_reads_{docId}` in the order they
   * happened, and the CURRENT read is simply the last one. There is no
   * "isActive" field anywhere, because two sources of truth for "which read am
   * I in" is exactly the kind of thing that drifts apart and then has to be
   * repaired. Appending is the only way a read is ever created.
   *
   * WHAT POINTS AT WHAT:
   * Comments and highlights each carry a `readId`. They point at the read;
   * the read knows nothing about them. So deleting a comment can never leave
   * the reads list wrong, and counting a read's comments is a filter.
   */

  // The palette a read's colour is drawn from, in the order reads are given
  // them. These are the same four colours the highlight toolbar offers, so a
  // read's colour is always one the stylesheet already knows how to paint.
  const READ_COLORS = ["yellow", "green", "blue", "pink"];

  // Read the raw reads array. Returns [] when a document has never been read
  // under this scheme — callers that need a real read should use ensureReads.
  function getReads(docId) {
    return readJSON(`folio_reads_${docId}`, []);
  }

  function saveReads(docId, reads) {
    writeJSON(`folio_reads_${docId}`, reads);
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Guarantees that a document has at least one read, and that every comment
   * and highlight in it belongs to one. Returns the full reads array.
   *
   * WHY WE NEED IT:
   * Every document that existed before this feature has comments and
   * highlights with no `readId` at all. The export filters on `readId`, so
   * without a backfill every note written before today would match no read and
   * disappear from exports — losing exactly the history this feature is meant
   * to preserve. So the first time a document is touched, its existing notes
   * are adopted into a Read 1.
   *
   * HOW IT WORKS:
   * 1. If the document already has reads, there is nothing to do.
   * 2. Otherwise we date Read 1 from the OLDEST note in the document, because
   *    that is when the reading actually happened — not now, which is merely
   *    when the code first ran.
   * 3. We stamp every unstamped comment and highlight with that read's id.
   * 4. We save all three keys, so the next call takes the early exit.
   */
  function ensureReads(docId) {
    if (!docId) return [];

    const existing = getReads(docId);
    if (existing.length) return existing;

    const comments = getComments(docId);
    const highlights = getHighlights(docId);

    // The earliest timestamp among everything already written, which is the
    // honest start date for the reading that produced it.
    let earliest = null;
    comments.concat(highlights).forEach((item) => {
      const t = item && item.createdAt;
      if (!t) return;
      if (earliest === null || t < earliest) earliest = t;
    });

    const read = {
      id: generateId("rd"),
      n: 1,
      color: READ_COLORS[0],
      startedAt: earliest || new Date().toISOString(),
    };

    // Adopt the existing notes. Anything that somehow already has a readId is
    // left alone rather than overwritten.
    let touchedComments = false;
    comments.forEach((c) => {
      if (!c.readId) { c.readId = read.id; touchedComments = true; }
    });
    let touchedHighlights = false;
    highlights.forEach((h) => {
      if (!h.readId) { h.readId = read.id; touchedHighlights = true; }
    });

    if (touchedComments) saveComments(docId, comments);
    if (touchedHighlights) saveHighlights(docId, highlights);

    const reads = [read];
    saveReads(docId, reads);
    console.log(
      `[reads] migrated doc ${docId} into Read 1 — ` +
      `${comments.length} comments, ${highlights.length} highlights, started ${read.startedAt}`
    );
    return reads;
  }

  // The read you are currently in: the most recent one. Runs the migration
  // first, so this never returns null for a document that exists.
  function getCurrentRead(docId) {
    const reads = ensureReads(docId);
    return reads.length ? reads[reads.length - 1] : null;
  }

  /*
   * Begin a new read. Appends a record numbered one past the last, taking the
   * next colour in the palette so consecutive reads never look alike. The
   * palette cycles, so a fifth read reuses yellow — four passes is already far
   * more than the colours can usefully distinguish.
   */
  function startNewRead(docId) {
    const reads = ensureReads(docId);
    const last = reads[reads.length - 1];
    const n = last ? last.n + 1 : 1;

    const read = {
      id: generateId("rd"),
      n: n,
      color: READ_COLORS[(n - 1) % READ_COLORS.length],
      startedAt: new Date().toISOString(),
    };

    reads.push(read);
    saveReads(docId, reads);
    console.log(`[reads] started Read ${n} on doc ${docId} (${read.color})`);
    return read;
  }

  // Human label for a read, used in the panel, the export headings and the
  // export file names. Kept here so all three agree.
  function readLabel(read) {
    if (!read) return "Read";
    /*
     * A named read keeps its number. "Read 2 · Close reading" rather than just
     * "Close reading", because the number is the only thing that says which
     * pass came first — and in a list of five reads that ordering is most of
     * what you are looking for.
     */
    const name = (read.name || "").trim();
    return name ? `Read ${read.n} \u00b7 ${name}` : `Read ${read.n}`;
  }

  /*
   * WHAT THIS DOES:
   * Gives a read a name of your own, or clears it when passed nothing.
   *
   * WHY A NAME IS OPTIONAL AND NOT A REPLACEMENT:
   * The number is assigned, permanent and ordered; the name is yours and can
   * change. Keeping them in separate fields means renaming can never disturb
   * the ordering, and an empty name simply falls back to the number rather
   * than leaving a read with no label at all.
   */
  function renameRead(docId, readId, name) {
    const reads = ensureReads(docId);
    const read = reads.find((r) => r.id === readId);
    if (!read) return null;

    const clean = String(name == null ? "" : name).trim().slice(0, 60);
    if (clean) read.name = clean;
    else delete read.name;

    saveReads(docId, reads);
    console.log(`[reads] renamed ${readId} on doc ${docId} to "${clean || "(no name)"}"`);
    return read;
  }

  /*
   * WHAT THIS DOES:
   * Removes a read and hands everything written during it to a neighbouring
   * read — the one before it, or the one after it when deleting the first.
   * Returns { ok, movedComments, movedHighlights, into } or { ok: false }.
   *
   * WHY IT NEVER DELETES YOUR NOTES:
   * Deleting a read is a filing decision: you started one by accident, or you
   * want two passes treated as one. It is not a statement about the writing.
   * Throwing away comments as a side effect of tidying a label would be an
   * unrecoverable loss from an action that does not sound like one, and Folio
   * has no undo for it. So the notes always survive, and the caller is told
   * how many moved so it can say so plainly before and after.
   *
   * WHY THE LAST READ CANNOT GO:
   * Every comment and highlight points at a read. With no reads left there is
   * nowhere for them to point, and the migration would not rebuild one because
   * they already carry a readId — so they would vanish from every per-read
   * export. A document always keeps at least one read.
   */
  function deleteRead(docId, readId) {
    const reads = ensureReads(docId);
    if (reads.length <= 1) {
      console.warn(`[reads] refused to delete the only read on doc ${docId}`);
      return { ok: false, reason: "last" };
    }

    const i = reads.findIndex((r) => r.id === readId);
    if (i === -1) return { ok: false, reason: "missing" };

    // The read before it, or the one after when deleting the first.
    const into = i > 0 ? reads[i - 1] : reads[1];

    const comments = getComments(docId);
    let movedComments = 0;
    comments.forEach((c) => {
      if (c.readId === readId) { c.readId = into.id; movedComments++; }
    });

    const highlights = getHighlights(docId);
    let movedHighlights = 0;
    highlights.forEach((h) => {
      if (h.readId === readId) {
        h.readId = into.id;
        // The mark on the page is coloured by its read, so it has to follow.
        h.color = into.color;
        movedHighlights++;
      }
    });

    if (movedComments) saveComments(docId, comments);
    if (movedHighlights) saveHighlights(docId, highlights);

    reads.splice(i, 1);
    saveReads(docId, reads);

    console.log(
      `[reads] deleted ${readId} on doc ${docId} — moved ${movedComments} comments ` +
      `and ${movedHighlights} highlights into ${readLabel(into)}`
    );
    return { ok: true, movedComments, movedHighlights, into };
  }

  /*
   * WHAT THIS DOES:
   * Files one comment under a different read. Returns { ok, movedHighlight }.
   *
   * WHY THE HIGHLIGHT SOMETIMES COMES WITH IT:
   * The case this exists for is forgetting to press "New read" and writing a
   * few comments before noticing. In that case the HIGHLIGHT was made at the
   * wrong time too, and leaving it behind would leave a Read 2 comment sitting
   * under a yellow Read 1 mark on the page — correct in the export, which
   * follows the comment, but visibly wrong on screen.
   *
   * So its highlight moves as well, UNLESS some other read also has a comment
   * about that same passage. That exception is the re-reading case: a passage
   * marked in March that both March and October have something to say about
   * belongs to March, and dragging it forward would quietly relabel history.
   */
  function setCommentRead(docId, commentId, readId) {
    const reads = ensureReads(docId);
    const target = reads.find((r) => r.id === readId);
    if (!target) return { ok: false, reason: "missing-read" };

    const comments = getComments(docId);
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return { ok: false, reason: "missing-comment" };
    if (comment.readId === readId) return { ok: true, movedHighlight: false, noop: true };

    comment.readId = readId;

    let movedHighlight = false;
    if (comment.highlightId) {
      const sharedWithAnotherRead = comments.some(
        (c) => c.id !== commentId &&
               c.highlightId === comment.highlightId &&
               c.readId !== readId
      );
      if (!sharedWithAnotherRead) {
        const highlights = getHighlights(docId);
        const hl = highlights.find((h) => h.id === comment.highlightId);
        if (hl && hl.readId !== readId) {
          hl.readId = readId;
          hl.color = target.color;
          saveHighlights(docId, highlights);
          movedHighlight = true;
        }
      }
    }

    saveComments(docId, comments);
    console.log(
      `[reads] moved comment ${commentId} to ${readLabel(target)} on doc ${docId}` +
      (movedHighlight ? " (its highlight came too)" : "")
    );
    return { ok: true, movedHighlight };
  }

  /*
   * WHAT THIS DOES:
   * Puts a SECOND copy of a comment under another read, leaving the original
   * where it is. Returns { ok, id } with the new comment's id.
   *
   * WHY COPY AND NOT ONLY MOVE:
   * Some thoughts belong to both readings. "Never understood this properly"
   * written in March is still true in October, and an October export that left
   * it out would be missing something you still think. Moving it would empty
   * March of a thought you did have then; copying keeps both honest.
   *
   * WHY THE HIGHLIGHT IS NOT TOUCHED, unlike a move:
   * A move can take the highlight with it because only one comment was holding
   * it. A copy leaves the original comment behind, still pointing at that same
   * passage, so the highlight has to stay where it was made. The export is
   * unaffected: a read's export already includes any highlight its comments
   * refer to, whichever read marked it.
   *
   * WHY createdAt IS NOW AND NOT THE ORIGINAL'S:
   * The panel and the exports order by createdAt. Keeping the old timestamp
   * would drop the copy next to its original in the list — two identical rows
   * side by side with no explanation. The copy was filed today, so it is dated
   * today, and `copiedFrom` keeps the provenance rather than losing it.
   */
  function copyCommentToRead(docId, commentId, readId) {
    const reads = ensureReads(docId);
    const target = reads.find((r) => r.id === readId);
    if (!target) return { ok: false, reason: "missing-read" };

    const comments = getComments(docId);
    const source = comments.find((c) => c.id === commentId);
    if (!source) return { ok: false, reason: "missing-comment" };
    if (source.readId === readId) return { ok: false, reason: "same-read" };

    const now = new Date().toISOString();
    const copy = {
      id: generateId("cm"),
      highlightId: source.highlightId || null,
      isGeneral: !!source.isGeneral,
      readId: readId,
      text: source.text,
      createdAt: now,
      updatedAt: now,
      /*
       * Where this came from. Kept so the panel can say "copied" rather than
       * leave you wondering why you appear to have written the same thing
       * twice, and so a future "find the original" has something to follow.
       */
      copiedFrom: { commentId: source.id, readId: source.readId || null },
      /*
       * WHEN THE THOUGHT WAS ACTUALLY HAD, which is not `createdAt` above.
       *
       * This record is new; the sentence in it is not. Exports label every
       * comment "MY THOUGHT ON <date>", and dating a copy by the day it was
       * copied would file something written in March under September — which
       * corrupts the one comparison the whole re-reading feature exists to
       * support. Kept on the copy rather than looked up at export time
       * because a single-read export never sees the other read's comments,
       * and because deleting the original must not silently re-date this.
       */
      originalCreatedAt: source.originalCreatedAt || source.createdAt || null,
    };
    // A video comment carries the moment it was spoken; the copy is about the
    // same moment, so it keeps it.
    if (typeof source.videoTime === "number") copy.videoTime = source.videoTime;

    comments.push(copy);
    saveComments(docId, comments);
    console.log(
      `[reads] copied comment ${commentId} into ${readLabel(target)} on doc ${docId} as ${copy.id}`
    );
    return { ok: true, id: copy.id };
  }

  /* ==========================================================================
   * FEEDBACK — notes you write about Folio itself, not about a document
   * ==========================================================================
   * Everything above this line is about the thing being READ. This is about
   * the thing doing the reading: a bug you ran into, or something you wish
   * Folio did. The reason it lives in the store at all, rather than only in
   * the widget, is that it has to survive a reload and be swept up by the
   * backup export like everything else beginning with `folio_`.
   *
   * ONE KEY, `folio_feedback`, holding an array of notes newest LAST, each:
   *
   *   { id: "fb_<ts>_<rand>"   internal, never shown to anybody
   *     n: 3                   the number in the id you DO see, "FB-3"
   *     kind: "bug" | "idea"
   *     text: "..."            your words, kept exactly as typed
   *     shots: [ { name, type, w, h, bytes, sent } ]
   *     context: { ... }       which page, which mode, which read, which theme
   *     createdAt, sentAt, status: "open" | "done" }
   *
   * WHY THE NUMBER IS STORED RATHER THAN COUNTED:
   * "FB-3" has to mean the same note for ever, so that saying "FB-3 is still
   * broken" is unambiguous months later. If the number were the row's position
   * in the array, deleting a note would silently renumber every note after it
   * and every id either of us had written down would now point at the wrong
   * thing. So a counter that only ever goes up lives in its own key.
   */

  function getFeedback() {
    return readJSON("folio_feedback", []);
  }

  function saveFeedback(notes) {
    writeJSON("folio_feedback", notes);
  }

  /*
   * The next number to hand out, and the counter moves immediately.
   *
   * It is seeded from the highest number already in use, so a browser that has
   * notes but somehow lost the counter cannot hand out a number twice.
   */
  function nextFeedbackNumber() {
    const stored = parseInt(localStorage.getItem("folio_feedback_seq") || "0", 10);
    const highest = getFeedback().reduce((m, f) => Math.max(m, f.n || 0), 0);
    const n = Math.max(isNaN(stored) ? 0 : stored, highest) + 1;
    try { localStorage.setItem("folio_feedback_seq", String(n)); }
    catch { /* the note matters more than the counter; the seed above covers it */ }
    return n;
  }

  /*
   * Forget the picture bytes, keeping everything that says a picture was there.
   *
   * Called once a note has been sent. A screenshot is by far the biggest thing
   * Folio ever stores — a Retina grab is megabytes, and localStorage holds
   * about five in TOTAL, shared with every document you have. The bundle that
   * went to Downloads carries the picture, so a second copy in the browser
   * buys nothing and would eventually refuse to save a document.
   *
   * `sent: true` is what the thumbnail strip reads to draw a placeholder, so
   * the absence shows as deliberate rather than as a broken image.
   */
  function pruneFeedbackBytes(note) {
    if (!note || !Array.isArray(note.shots)) return note;
    note.shots = note.shots.map((s) => ({ ...s, bytes: null, sent: true }));
    return note;
  }

  // ==========================================================================
  // SETTINGS — Global app preferences
  // ==========================================================================

  const DEFAULT_SETTINGS = {
    theme: "default",
    fontSize: 18,
    lineHeight: 1.85,
    columnWidth: 720,
    lastOpenDocId: null,
    sidebarCollapsed: false,
  };

  function getSettings() {
    return readJSON("folio_settings", { ...DEFAULT_SETTINGS });
  }

  function saveSettings(settings) {
    writeJSON("folio_settings", settings);
  }

  // ==========================================================================
  // BACKUP / RESTORE — Export and import all data as a single JSON blob
  // ==========================================================================

  function exportAll() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("folio_")) {
        try {
          data[key] = JSON.parse(localStorage.getItem(key));
        } catch {
          data[key] = localStorage.getItem(key);
        }
      }
    }
    return data;
  }

  /*
   * Import a backup JSON blob. `mode` controls what happens to existing data:
   *   - "replace" — wipe all existing folio_* keys first, then load the backup
   *                 (use when you want the backup to be the exact state)
   *   - "merge"   — keep existing docs; for each doc in the backup, only add it
   *                 if no doc with that id already exists. Settings from the
   *                 backup are NOT applied in merge mode (preserve current UI).
   *                 Default — safer for one-click import.
   */
  function importAll(data, mode = "merge") {
    if (mode === "replace") {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith("folio_")) keysToRemove.push(key);
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));

      for (const [key, value] of Object.entries(data)) {
        writeValue(key, value);
      }
      return { added: Object.keys(data).length, skipped: 0 };
    }

    // Merge: union of doc metadata by id, then copy content/highlights/comments/reads
    // only for docs that weren't already present locally.
    const existingDocs = readJSON("folio_documents", []);
    const existingIds = new Set(existingDocs.map((d) => d.id));
    const incomingDocs = (data.folio_documents || []).filter((d) => d && d.id);

    let added = 0;
    let skipped = 0;
    const mergedDocs = existingDocs.slice();

    incomingDocs.forEach((doc) => {
      if (existingIds.has(doc.id)) {
        skipped++;
        return;
      }
      mergedDocs.push(doc);
      added++;
      // Pull along the doc's content/highlights/comments/reads if present in backup.
      // folio_reads_ must be here: a restored document whose reads were left
      // behind would have notes pointing at reads that no longer exist, and the
      // migration would not rebuild them because the notes already carry a readId.
      ["folio_doc_", "folio_highlights_", "folio_comments_", "folio_reads_"].forEach((prefix) => {
        const key = prefix + doc.id;
        if (data[key] !== undefined) writeValue(key, data[key]);
      });
    });

    writeJSON("folio_documents", mergedDocs);
    return { added, skipped };
  }

  // Helper for importAll — accept either a JSON-encoded string or a raw value
  function writeValue(key, value) {
    if (typeof value === "string") {
      localStorage.setItem(key, value);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  return {
    generateId,
    listDocuments,
    getTopLevelDocuments,
    getChildDocuments,
    getDocument,
    createDocument,
    updateDocument,
    deleteDocument,
    countWordsInBlocks,
    searchDocuments,
    getHighlights,
    saveHighlights,
    getComments,
    saveComments,
    getFeedback,
    saveFeedback,
    nextFeedbackNumber,
    pruneFeedbackBytes,
    getReads,
    saveReads,
    ensureReads,
    getCurrentRead,
    startNewRead,
    readLabel,
    renameRead,
    deleteRead,
    setCommentRead,
    copyCommentToRead,
    READ_COLORS,
    getSettings,
    saveSettings,
    exportAll,
    importAll,
    requestDurableStorage,
    storageDurability,
    storageEstimate,
    reorderDocument,
    isDescendantOf,
  };
})();

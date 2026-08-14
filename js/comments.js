/*
 * =============================================================================
 * COMMENTS.JS — Comment System for Highlighted Text
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages the commenting system. Every comment is attached to a
 * highlight — to add a comment, you first highlight text, then add a comment
 * to that highlight. Comments appear in a slide-out panel on the right side.
 *
 * HOW IT WORKS:
 * 1. User highlights text and clicks "Add Comment" from the highlight popover
 * 2. The comments panel slides open with a text input at the bottom
 * 3. Submitting saves the comment to FolioStore, linked to the highlight ID
 * 4. Clicking a comment in the panel scrolls to and pulses the highlight
 * 5. Comments can be edited or deleted from the panel
 * =============================================================================
 */

const Comments = (function () {

  // Cache DOM elements
  const panel = document.getElementById("comments-panel");
  const commentsList = document.getElementById("comments-list");
  const commentInput = document.getElementById("comment-input");
  const commentSubmit = document.getElementById("comment-submit");
  const commentCancel = document.getElementById("comment-cancel");
  const resizeHandle = document.getElementById("comments-resize");
  const header = panel.querySelector(".comments-header");

  // Distance from the right viewport edge at which the panel snaps to a
  // full-height right-side margin dock. Small enough to be intentional.
  const SNAP_THRESHOLD_PX = 32;

  // The highlight ID we're currently adding a comment to
  let activeHighlightId = null;
  // The comment ID being edited (null if creating new)
  let editingCommentId = null;
  // True when the user clicked "New note" and we should create a page-level
  // comment (no highlight attached). Distinguished from "orphaned" comments,
  // which are ones whose highlight was deleted after the fact.
  let creatingGeneralNote = false;

  // ==========================================================================
  // PANEL MANAGEMENT — Opening and closing the comments panel
  // ==========================================================================

  // Open the panel and show all comments for the current document
  function openPanel() {
    // Restore the last-used geometry before showing so the panel doesn't flash
    // in the default position and then jump.
    restoreGeometry();
    panel.classList.add("open");
    renderComments();
  }

  // ==========================================================================
  // GEOMETRY PERSISTENCE — remember where/how big the panel was last time
  // ==========================================================================

  /*
   * Panel geometry is stored under a single settings key so it survives across
   * sessions and across docs. Shape:
   *   {
   *     mode: "floating" | "docked",
   *     x, y: floating position (px from top-left of viewport)
   *     width, height: floating size
   *   }
   * We clamp everything into the current viewport on load so a resize down
   * doesn't leave the panel off-screen.
   */
  function getSavedGeometry() {
    const settings = FolioStore.getSettings();
    return settings.commentsGeometry || null;
  }

  function saveGeometry(geom) {
    const settings = FolioStore.getSettings();
    settings.commentsGeometry = geom;
    FolioStore.saveSettings(settings);
  }

  function restoreGeometry() {
    const g = getSavedGeometry();
    if (!g) return; // fall back to CSS defaults

    if (g.mode === "docked") {
      panel.classList.add("docked");
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.width = (g.width || 360) + "px";
      panel.style.height = "";
      return;
    }

    // Floating — clamp into viewport so a re-open after a window resize is safe
    panel.classList.remove("docked");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(g.width || 320, vw - 40);
    const h = Math.min(g.height || 400, vh - 40);
    const x = Math.max(8, Math.min(g.x, vw - w - 8));
    const y = Math.max(8, Math.min(g.y, vh - h - 8));
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = w + "px";
    panel.style.height = h + "px";
  }

  // Capture current on-screen rect and persist it (floating or docked mode)
  function captureAndSaveGeometry() {
    if (panel.classList.contains("docked")) {
      saveGeometry({ mode: "docked", width: panel.getBoundingClientRect().width });
      return;
    }
    const r = panel.getBoundingClientRect();
    saveGeometry({
      mode: "floating",
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  // ==========================================================================
  // DRAG — grab the header to move the panel; snap-to-margin at right edge
  // ==========================================================================

  function initDrag() {
    if (!header) return;
    let dragging = false;
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;

    header.addEventListener("mousedown", (e) => {
      // Ignore clicks on header buttons (close, export)
      if (e.target.closest("button")) return;
      dragging = true;
      // If we were docked, undock into a floating card at the drag origin so
      // the drag feels natural (else the panel would jump from full-height).
      if (panel.classList.contains("docked")) {
        const r = panel.getBoundingClientRect();
        panel.classList.remove("docked");
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.width = r.width + "px";
        panel.style.height = r.height + "px";
      }
      const r = panel.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      panel.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const x = Math.max(0, Math.min(originLeft + dx, vw - w));
      const y = Math.max(0, Math.min(originTop + dy, vh - h));
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("dragging");

      // Snap-to-margin: if the panel's right edge is within the snap threshold
      // of the viewport's right edge, dock it so it acts like a margin column.
      const r = panel.getBoundingClientRect();
      const distToRight = window.innerWidth - r.right;
      if (distToRight <= SNAP_THRESHOLD_PX) {
        panel.classList.add("docked");
        panel.style.left = "";
        panel.style.top = "";
        panel.style.right = "";
        panel.style.bottom = "";
        panel.style.height = "";
        panel.style.width = Math.round(r.width) + "px";
      }
      captureAndSaveGeometry();
    });
  }

  // ==========================================================================
  // RESIZE — bottom-right corner handle
  // ==========================================================================

  function initResize() {
    if (!resizeHandle) return;
    let resizing = false;
    let startX = 0, startY = 0;
    let startW = 0, startH = 0;

    resizeHandle.addEventListener("mousedown", (e) => {
      resizing = true;
      // If docked, undock into a floating card at the current on-screen rect
      // so the drag-to-resize feels 1:1 with the corner.
      if (panel.classList.contains("docked")) {
        const r = panel.getBoundingClientRect();
        panel.classList.remove("docked");
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.width = r.width + "px";
        panel.style.height = r.height + "px";
      }
      startX = e.clientX;
      startY = e.clientY;
      startW = panel.offsetWidth;
      startH = panel.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const dw = e.clientX - startX;
      const dh = e.clientY - startY;
      const w = Math.max(240, Math.min(startW + dw, window.innerWidth * 0.9));
      const h = Math.max(200, Math.min(startH + dh, window.innerHeight * 0.9));
      panel.style.width = w + "px";
      panel.style.height = h + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      captureAndSaveGeometry();
    });
  }

  // Open the panel specifically for adding a comment to a highlight
  function openPanelForHighlight(highlightId) {
    activeHighlightId = highlightId;
    editingCommentId = null;
    creatingGeneralNote = false;
    openPanel();
    commentInput.value = "";
    commentInput.placeholder = "Add a comment...";
    resetInputHeight();
    commentInput.focus();
  }

  // Open the panel with the textarea primed for a general (page-level) note.
  // Same UX as commenting on a highlight, but no highlight id.
  function openPanelForNewNote() {
    activeHighlightId = null;
    editingCommentId = null;
    creatingGeneralNote = true;
    openPanel();
    commentInput.value = "";
    commentInput.placeholder = "Write a note about this page...";
    resetInputHeight();
    commentInput.focus();
  }

  // Close the panel
  function closePanel() {
    panel.classList.remove("open");
    activeHighlightId = null;
    editingCommentId = null;
    commentInput.value = "";
    resetInputHeight();
  }

  // Grow the textarea to fit its content, up to the max-height set in CSS.
  // Called on every input event so typing feels like a growing note pad.
  function autoGrowInput() {
    if (!commentInput) return;
    commentInput.style.height = "auto";
    commentInput.style.height = commentInput.scrollHeight + "px";
  }
  function resetInputHeight() {
    if (!commentInput) return;
    commentInput.style.height = "";
  }

  // ==========================================================================
  // RENDERING — Build the comment list in the panel
  // ==========================================================================

  function renderComments() {
    const docId = Reader.getCurrentDocId();
    if (!docId) {
      commentsList.innerHTML =
        '<div class="comments-empty">Open a document to see comments.</div>';
      return;
    }

    const comments = FolioStore.getComments(docId);
    const highlights = FolioStore.getHighlights(docId);

    if (comments.length === 0) {
      commentsList.innerHTML =
        '<div class="comments-empty">No comments yet.<br>Highlight text and press <kbd>c</kbd>, or click "New note" above for a page-level note.</div>';
      return;
    }

    commentsList.innerHTML = "";

    // Sort comments by creation date (newest first)
    const sorted = [...comments].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    sorted.forEach((comment) => {
      // Three cases for the "context" label above a comment:
      //   1. General note   → italic "Note" label, no quote
      //   2. Orphaned       → highlight was deleted (comment.highlightId set,
      //                       but no matching highlight found)
      //   3. Attached       → matching highlight found → show quoted text
      const hl = comment.highlightId
        ? highlights.find((h) => h.id === comment.highlightId)
        : null;
      const isGeneral = !!comment.isGeneral || comment.highlightId === null;
      const isOrphan = !isGeneral && !!comment.highlightId && !hl;

      let contextHtml;
      if (isGeneral) {
        contextHtml = '<div class="comment-context-label">Note</div>';
      } else if (isOrphan) {
        contextHtml = '<div class="comment-context-label muted">(highlight removed)</div>';
      } else {
        contextHtml = `<div class="comment-highlight-text">${escapeHtml(hl.text)}</div>`;
      }

      const entry = document.createElement("div");
      entry.className = "comment-entry" + (isGeneral ? " comment-entry-general" : "");
      entry.dataset.highlightId = comment.highlightId || "";

      const dateStr = new Date(comment.createdAt).toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric" }
      );

      entry.innerHTML = `
        ${contextHtml}
        <div class="comment-text">${escapeHtml(comment.text)}</div>
        <div class="comment-meta">
          <span>${dateStr}</span>
          <div class="comment-actions">
            <button class="edit-comment" data-id="${comment.id}">Edit</button>
            <button class="delete-comment" data-id="${comment.id}">Delete</button>
          </div>
        </div>
      `;

      // Click to scroll to the highlight in the document — only meaningful if
      // the comment IS attached to a live highlight.
      entry.addEventListener("click", (e) => {
        if (e.target.closest(".comment-actions")) return;
        if (comment.highlightId && !isOrphan) scrollToHighlight(comment.highlightId);
      });

      // Edit button
      entry
        .querySelector(".edit-comment")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          startEditing(comment);
        });

      // Delete button
      entry
        .querySelector(".delete-comment")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          deleteComment(comment.id);
        });

      commentsList.appendChild(entry);
    });
  }

  // ==========================================================================
  // COMMENT CRUD — Create, edit, delete comments
  // ==========================================================================

  // Save a new comment or update an existing one
  function saveComment() {
    const docId = Reader.getCurrentDocId();
    if (!docId) return;

    const text = commentInput.value.trim();
    if (!text) return;

    const comments = FolioStore.getComments(docId);

    if (editingCommentId) {
      // Update existing comment
      const idx = comments.findIndex((c) => c.id === editingCommentId);
      if (idx !== -1) {
        comments[idx].text = text;
        comments[idx].updatedAt = new Date().toISOString();
      }
      editingCommentId = null;
    } else if (activeHighlightId) {
      // Create new comment attached to a highlight
      comments.push({
        id: FolioStore.generateId("cm"),
        highlightId: activeHighlightId,
        text: text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else if (creatingGeneralNote) {
      // Create a page-level note (no highlight). isGeneral distinguishes it
      // from orphan comments whose highlight was removed after the fact.
      comments.push({
        id: FolioStore.generateId("cm"),
        highlightId: null,
        isGeneral: true,
        text: text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    FolioStore.saveComments(docId, comments);
    commentInput.value = "";
    resetInputHeight();
    activeHighlightId = null;
    creatingGeneralNote = false;
    commentInput.placeholder = "Add a comment...";
    renderComments();
  }

  // Start editing an existing comment
  function startEditing(comment) {
    editingCommentId = comment.id;
    activeHighlightId = comment.highlightId;
    commentInput.value = comment.text;
    commentInput.placeholder = "Edit comment...";
    commentInput.focus();
    // Grow to fit the loaded text right away
    autoGrowInput();
  }

  // Delete a comment
  function deleteComment(commentId) {
    const docId = Reader.getCurrentDocId();
    if (!docId) return;

    let comments = FolioStore.getComments(docId);
    comments = comments.filter((c) => c.id !== commentId);
    FolioStore.saveComments(docId, comments);
    renderComments();
  }

  // ==========================================================================
  // SCROLL TO HIGHLIGHT — Navigate to and pulse a highlight in the document
  // ==========================================================================

  function scrollToHighlight(highlightId) {
    const mark = document.querySelector(
      `mark[data-highlight-id="${highlightId}"]`
    );
    if (!mark) return;

    // Scroll the highlight into view
    mark.scrollIntoView({ behavior: "smooth", block: "center" });

    // Add a pulsing animation to draw attention
    mark.classList.add("pulsing");
    setTimeout(() => mark.classList.remove("pulsing"), 1500);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ==========================================================================
  // EXPORT — dump highlights + comments as a markdown bulleted list
  // ==========================================================================

  /*
   * Format:
   *   # Highlights & comments — <doc title>
   *   _Exported <date>_
   *
   *   - "quoted highlight text"
   *     → my thought: comment text
   *
   *   - "another highlight, no comment"
   *
   * Design decisions (per plan):
   *   • Include highlights WITHOUT comments (option A) — they're breadcrumbs too
   *   • Order by highlight creation time so the export reads chronologically
   *   • Multi-line comments preserved via a blockquote-style indent
   *   • Markdown only (JSON round-trip is handled by the general backup feature)
   */
  function exportAnnotations() {
    const docId = Reader.getCurrentDocId();
    if (!docId) {
      alert("Open a document first — export operates on the currently open page.");
      return;
    }

    const doc = FolioStore.getDocument(docId);
    const highlights = FolioStore.getHighlights(docId);
    const comments = FolioStore.getComments(docId);

    if (!highlights.length && !comments.length) {
      alert("No highlights or comments to export yet.");
      return;
    }

    // Sort highlights by creation time so the export mirrors reading order-ish
    const sortedHighlights = [...highlights].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );

    const title = (doc && doc.meta && doc.meta.title) || "Untitled";
    const today = new Date().toISOString().slice(0, 10);

    const lines = [];
    lines.push(`# Highlights & comments — ${title}`);
    lines.push(`_Exported ${today}_`);
    lines.push("");

    // General notes first (they're about the whole page, not any specific quote)
    const generalNotes = comments.filter((c) => c.isGeneral || (c.highlightId === null));
    if (generalNotes.length) {
      lines.push("## General notes");
      lines.push("");
      generalNotes
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
        .forEach((c) => {
          const noteLines = (c.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
          if (!noteLines.length) return;
          lines.push(`- ${noteLines[0]}`);
          noteLines.slice(1).forEach((l) => lines.push(`  ${l}`));
        });
      lines.push("");
      if (sortedHighlights.length) {
        lines.push("## Highlights");
        lines.push("");
      }
    }

    sortedHighlights.forEach((hl) => {
      // Collapse internal whitespace so multi-line highlights read as one quote
      const quoteText = (hl.text || "").replace(/\s+/g, " ").trim();
      lines.push(`- "${quoteText}"`);
      const relatedComments = comments.filter((c) => c.highlightId === hl.id);
      relatedComments.forEach((c) => {
        // Indent each comment line so it visually attaches to its bullet
        const commentLines = (c.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
        commentLines.forEach((cl, i) => {
          const prefix = i === 0 ? "  → " : "    ";
          lines.push(`${prefix}${cl}`);
        });
      });
      lines.push("");
    });

    // Orphan comments: had a highlight once, but the highlight was removed.
    // Exclude general notes (already listed above) — an orphan has a non-null
    // highlightId that no longer resolves.
    const orphanComments = comments.filter(
      (c) => !c.isGeneral && c.highlightId != null && !highlights.some((h) => h.id === c.highlightId)
    );
    if (orphanComments.length) {
      lines.push("---");
      lines.push("");
      lines.push("**Notes whose highlight was removed:**");
      lines.push("");
      orphanComments.forEach((c) => {
        lines.push(`- ${c.text || ""}`);
      });
    }

    const md = lines.join("\n");
    const safeTitle = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "notes";
    downloadBlob(md, `${safeTitle}-annotations-${today}.md`, "text/markdown");
  }

  function downloadBlob(text, filename, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ==========================================================================
  // INITIALIZATION — Wire up event listeners
  // ==========================================================================

  function init() {
    // Close panel button
    document.getElementById("comments-close").addEventListener("click", closePanel);

    // Export annotations button
    const exportBtn = document.getElementById("comments-export");
    if (exportBtn) exportBtn.addEventListener("click", exportAnnotations);

    // "New note" button — creates a page-level comment (no highlight)
    const newNoteBtn = document.getElementById("comments-new-note");
    if (newNoteBtn) newNoteBtn.addEventListener("click", openPanelForNewNote);

    // Submit comment
    commentSubmit.addEventListener("click", saveComment);

    // Cancel editing
    commentCancel.addEventListener("click", () => {
      commentInput.value = "";
      resetInputHeight();
      editingCommentId = null;
      activeHighlightId = null;
      commentInput.placeholder = "Add a comment...";
    });

    // Auto-grow on every keystroke — CSS max-height caps the growth,
    // after which the internal scrollbar takes over
    commentInput.addEventListener("input", autoGrowInput);

    // Submit on Cmd+Enter (mac) / Ctrl+Enter (win/linux). preventDefault so
    // the newline the textarea would otherwise insert doesn't sneak in on
    // release — I dropped that bit last time and it was the difference
    // between the shortcut appearing to fire and actually saving cleanly.
    commentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        saveComment();
      }
      // Escape cancels an in-progress edit or new note
      if (e.key === "Escape") {
        e.preventDefault();
        commentInput.value = "";
        resetInputHeight();
        editingCommentId = null;
        activeHighlightId = null;
        commentInput.placeholder = "Add a comment...";
      }
    });

    // Floating-window behavior: drag by header, resize by corner
    initDrag();
    initResize();

    // Keep the panel in the viewport if the window is resized while docked
    // or floating — otherwise a shrink can leave it off-screen.
    window.addEventListener("resize", () => {
      if (panel.classList.contains("open")) restoreGeometry();
    });
  }

  return {
    init,
    openPanel,
    openPanelForHighlight,
    openPanelForNewNote,
    closePanel,
    renderComments,
  };
})();

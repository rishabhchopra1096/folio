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

  // The highlight ID we're currently adding a comment to
  let activeHighlightId = null;
  // The comment ID being edited (null if creating new)
  let editingCommentId = null;

  // ==========================================================================
  // PANEL MANAGEMENT — Opening and closing the comments panel
  // ==========================================================================

  // Open the panel and show all comments for the current document
  function openPanel() {
    panel.classList.add("open");
    renderComments();
  }

  // Open the panel specifically for adding a comment to a highlight
  function openPanelForHighlight(highlightId) {
    activeHighlightId = highlightId;
    editingCommentId = null;
    openPanel();
    commentInput.value = "";
    commentInput.placeholder = "Add a comment...";
    commentInput.focus();
  }

  // Close the panel
  function closePanel() {
    panel.classList.remove("open");
    activeHighlightId = null;
    editingCommentId = null;
    commentInput.value = "";
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
        '<div class="comments-empty">No comments yet. Highlight text and click "Add Comment" to start.</div>';
      return;
    }

    commentsList.innerHTML = "";

    // Sort comments by creation date (newest first)
    const sorted = [...comments].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    sorted.forEach((comment) => {
      // Find the associated highlight to show the highlighted text
      const hl = highlights.find((h) => h.id === comment.highlightId);
      const hlText = hl ? hl.text : "(highlight removed)";

      const entry = document.createElement("div");
      entry.className = "comment-entry";
      entry.dataset.highlightId = comment.highlightId;

      const dateStr = new Date(comment.createdAt).toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric" }
      );

      entry.innerHTML = `
        <div class="comment-highlight-text">${escapeHtml(hlText)}</div>
        <div class="comment-text">${escapeHtml(comment.text)}</div>
        <div class="comment-meta">
          <span>${dateStr}</span>
          <div class="comment-actions">
            <button class="edit-comment" data-id="${comment.id}">Edit</button>
            <button class="delete-comment" data-id="${comment.id}">Delete</button>
          </div>
        </div>
      `;

      // Click to scroll to the highlight in the document
      entry.addEventListener("click", (e) => {
        if (e.target.closest(".comment-actions")) return;
        scrollToHighlight(comment.highlightId);
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
      // Create new comment
      comments.push({
        id: FolioStore.generateId("cm"),
        highlightId: activeHighlightId,
        text: text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    FolioStore.saveComments(docId, comments);
    commentInput.value = "";
    activeHighlightId = null;
    renderComments();
  }

  // Start editing an existing comment
  function startEditing(comment) {
    editingCommentId = comment.id;
    activeHighlightId = comment.highlightId;
    commentInput.value = comment.text;
    commentInput.placeholder = "Edit comment...";
    commentInput.focus();
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
  // INITIALIZATION — Wire up event listeners
  // ==========================================================================

  function init() {
    // Close panel button
    document.getElementById("comments-close").addEventListener("click", closePanel);

    // Submit comment
    commentSubmit.addEventListener("click", saveComment);

    // Cancel editing
    commentCancel.addEventListener("click", () => {
      commentInput.value = "";
      editingCommentId = null;
      activeHighlightId = null;
      commentInput.placeholder = "Add a comment...";
    });

    // Submit on Ctrl+Enter
    commentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        saveComment();
      }
    });
  }

  return {
    init,
    openPanel,
    openPanelForHighlight,
    closePanel,
    renderComments,
  };
})();

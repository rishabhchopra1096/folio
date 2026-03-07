/*
 * =============================================================================
 * EDITOR.JS — Built-in Markdown Editor with Auto-Save
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages the markdown editing experience. It provides a full-width
 * textarea styled to look like writing on paper, with auto-save functionality
 * that persists changes to localStorage every second after typing stops.
 *
 * HOW IT WORKS:
 * 1. openEditor(docId) loads a document into the textarea
 * 2. Every keystroke triggers a debounced save (1 second delay)
 * 3. The save indicator in the stats bar shows "Saving..." / "Saved"
 * 4. Pressing Ctrl+E or the preview button switches to the reader view
 * =============================================================================
 */

const Editor = (function () {

  // The document currently being edited
  let currentDocId = null;
  // Timer for debounced auto-save
  let saveTimer = null;

  // Cache DOM elements
  const textarea = document.getElementById("editor-textarea");
  const titleInput = document.getElementById("editor-title");
  const saveIndicator = document.getElementById("save-indicator");

  // Open a document in the editor
  function openEditor(docId) {
    const doc = FolioStore.getDocument(docId);
    if (!doc) return;

    currentDocId = docId;

    // Populate the title and content
    titleInput.value = doc.meta.title || "";
    textarea.value = doc.content;

    // Show the stats bar with document info
    const wordCount = doc.content.trim().split(/\s+/).filter(Boolean).length;
    document.getElementById("word-count").textContent =
      wordCount.toLocaleString();
    document.getElementById("read-time").textContent =
      Math.ceil(wordCount / 220);
    document.getElementById("doc-title").textContent =
      doc.meta.title || "Untitled";

    document.getElementById("stats-bar").classList.add("visible");
    document.getElementById("main").classList.add("has-stats");

    // Show save indicator
    if (saveIndicator) saveIndicator.textContent = "Saved";

    // Focus the textarea
    textarea.focus();
  }

  // Auto-save: debounced write to localStorage on every keystroke
  textarea.addEventListener("input", () => {
    if (!currentDocId) return;

    // Show "Saving..." immediately
    if (saveIndicator) saveIndicator.textContent = "Saving...";

    // Clear any pending save and set a new one
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FolioStore.updateDocument(currentDocId, {
        content: textarea.value,
      });

      // Update word count in stats bar
      const wc = textarea.value.trim().split(/\s+/).filter(Boolean).length;
      document.getElementById("word-count").textContent =
        wc.toLocaleString();
      document.getElementById("read-time").textContent =
        Math.ceil(wc / 220);

      if (saveIndicator) saveIndicator.textContent = "Saved";
    }, 1000);
  });

  // Auto-save title changes
  titleInput.addEventListener("input", () => {
    if (!currentDocId) return;

    if (saveIndicator) saveIndicator.textContent = "Saving...";

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FolioStore.updateDocument(currentDocId, {
        title: titleInput.value || "Untitled",
      });
      document.getElementById("doc-title").textContent =
        titleInput.value || "Untitled";
      if (saveIndicator) saveIndicator.textContent = "Saved";
    }, 1000);
  });

  // Handle tab key in textarea (insert spaces instead of changing focus)
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value =
        textarea.value.substring(0, start) +
        "  " +
        textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      // Trigger input event for auto-save
      textarea.dispatchEvent(new Event("input"));
    }
  });

  // Hide editor UI (when navigating away)
  function hide() {
    // Force-save any pending changes
    if (currentDocId && saveTimer) {
      clearTimeout(saveTimer);
      FolioStore.updateDocument(currentDocId, {
        content: textarea.value,
        title: titleInput.value || "Untitled",
      });
    }
    currentDocId = null;
    textarea.value = "";
    titleInput.value = "";
    document.getElementById("stats-bar").classList.remove("visible");
    document.getElementById("main").classList.remove("has-stats");
  }

  // Get the ID of the document currently being edited
  function getCurrentDocId() {
    return currentDocId;
  }

  return {
    openEditor,
    hide,
    getCurrentDocId,
  };
})();

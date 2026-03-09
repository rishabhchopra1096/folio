/*
 * =============================================================================
 * EDITOR.JS — Editor.js Integration for Folio
 * =============================================================================
 * FILE OVERVIEW:
 * This file wraps the Editor.js block editor library, providing Notion-like
 * WYSIWYG editing. Users can write with rich formatting, slash commands,
 * checklists, code blocks, tables, and more — all without touching markdown.
 *
 * HOW IT WORKS:
 * 1. openEditor(docId) loads a document's Editor.js JSON and initializes Editor.js
 * 2. Editor.js handles all the block editing, slash commands, inline formatting
 * 3. Auto-save: on every change, we debounce-save the JSON to FolioStore
 * 4. Title and icon are editable inline above the editor
 *
 * EDITOR.JS PLUGINS LOADED:
 * - Header: H1-H6 headings
 * - List: Ordered/unordered lists
 * - Checklist: To-do checkboxes
 * - Code: Code blocks
 * - Table: Editable tables
 * - Quote: Blockquotes
 * - Delimiter: Horizontal rules
 * - InlineCode: Inline code formatting
 * - Marker: Text highlighting (inline)
 * =============================================================================
 */

const Editor = (function () {

  // The Editor.js instance
  let editorInstance = null;
  // The document currently being edited
  let currentDocId = null;
  // Timer for debounced auto-save
  let saveTimer = null;

  // Cache DOM elements
  const titleInput = document.getElementById("editor-title");
  const saveIndicator = document.getElementById("save-indicator");
  const iconBtn = document.getElementById("icon-picker-btn");

  // Common emoji icons for the page icon picker
  const ICON_OPTIONS = [
    "", "📄", "📝", "📚", "📖", "🗒️", "📋", "📌", "🔖",
    "💡", "🎯", "🚀", "⭐", "❤️", "🔥", "✅", "📊",
    "🎨", "🏗️", "🧪", "🔬", "📐", "🗂️", "💻", "🌐",
    "🎵", "📷", "✈️", "🍽️", "🏠", "💰", "📅", "🎓",
  ];

  // Open a document in the editor
  function openEditor(docId) {
    const doc = FolioStore.getDocument(docId);
    if (!doc) return;

    currentDocId = docId;

    // Set title
    titleInput.value = doc.meta.title || "";

    // Set icon button
    updateIconButton(doc.meta.icon);

    // Destroy previous editor instance if one exists
    if (editorInstance) {
      editorInstance.destroy();
      editorInstance = null;
    }

    // Initialize Editor.js with the document's saved block data
    editorInstance = new EditorJS({
      holder: "editorjs",
      placeholder: "Start writing or press / for commands...",
      autofocus: false,

      // Configure all the block tools
      tools: {
        header: {
          class: Header,
          inlineToolbar: true,
          config: {
            placeholder: "Heading",
            levels: [1, 2, 3, 4],
            defaultLevel: 2,
          },
        },
        list: {
          class: List,
          inlineToolbar: true,
          config: {
            defaultStyle: "unordered",
          },
        },
        checklist: {
          class: Checklist,
          inlineToolbar: true,
        },
        code: {
          class: CodeTool,
        },
        table: {
          class: Table,
          inlineToolbar: true,
          config: {
            rows: 3,
            cols: 3,
          },
        },
        quote: {
          class: Quote,
          inlineToolbar: true,
          config: {
            quotePlaceholder: "Enter a quote",
            captionPlaceholder: "Quote author",
          },
        },
        delimiter: Delimiter,
        inlineCode: {
          class: InlineCode,
        },
        marker: {
          class: Marker,
        },
      },

      // Load saved data
      data: doc.content && doc.content.blocks && doc.content.blocks.length > 0
        ? doc.content
        : { time: Date.now(), blocks: [] },

      // Auto-save on every change
      onChange: function () {
        debouncedSave();
      },

      // When editor is ready
      onReady: function () {
        if (saveIndicator) saveIndicator.textContent = "Saved";
      },
    });

    // Show save indicator
    if (saveIndicator) saveIndicator.textContent = "Saved";
  }

  // Debounced save — waits 1 second after last change before saving
  function debouncedSave() {
    if (!currentDocId || !editorInstance) return;

    if (saveIndicator) saveIndicator.textContent = "Saving...";

    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const data = await editorInstance.save();
        FolioStore.updateDocument(currentDocId, { content: data });
        if (saveIndicator) saveIndicator.textContent = "Saved";

        // Update the sidebar to reflect any changes
        if (typeof SidebarUI !== "undefined") {
          SidebarUI.renderPageTree();
        }
      } catch (err) {
        console.error("Auto-save failed:", err);
        if (saveIndicator) saveIndicator.textContent = "Save failed";
      }
    }, 1000);
  }

  // Auto-save title changes
  titleInput.addEventListener("input", () => {
    if (!currentDocId) return;

    if (saveIndicator) saveIndicator.textContent = "Saving...";

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FolioStore.updateDocument(currentDocId, {
        title: titleInput.value || "Untitled",
      });
      if (saveIndicator) saveIndicator.textContent = "Saved";

      // Update sidebar
      if (typeof SidebarUI !== "undefined") {
        SidebarUI.renderPageTree();
      }
    }, 500);
  });

  // ==========================================================================
  // ICON PICKER — Emoji selector for page icons
  // ==========================================================================

  function updateIconButton(icon) {
    iconBtn.textContent = icon || "📄";
    iconBtn.title = icon ? "Change icon" : "Add icon";
  }

  function showIconPicker() {
    let picker = document.getElementById("icon-picker");
    if (picker.children.length > 0) {
      // Toggle visibility
      picker.style.display = picker.style.display === "none" ? "grid" : "none";
      return;
    }

    // Build the picker grid
    picker.style.display = "grid";
    ICON_OPTIONS.forEach((emoji) => {
      const btn = document.createElement("button");
      btn.textContent = emoji || "✖";
      btn.title = emoji || "Remove icon";
      btn.className = "icon-option";
      btn.addEventListener("click", () => {
        if (currentDocId) {
          FolioStore.updateDocument(currentDocId, { icon: emoji });
          updateIconButton(emoji);
          if (typeof SidebarUI !== "undefined") SidebarUI.renderPageTree();
        }
        picker.style.display = "none";
      });
      picker.appendChild(btn);
    });
  }

  iconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showIconPicker();
  });

  // Close icon picker when clicking elsewhere
  document.addEventListener("click", () => {
    const picker = document.getElementById("icon-picker");
    if (picker) picker.style.display = "none";
  });

  // ==========================================================================
  // CLEANUP AND PUBLIC API
  // ==========================================================================

  // Force-save and clean up (called when navigating away)
  async function hide() {
    if (currentDocId && editorInstance) {
      clearTimeout(saveTimer);
      try {
        const data = await editorInstance.save();
        FolioStore.updateDocument(currentDocId, {
          content: data,
          title: titleInput.value || "Untitled",
        });
      } catch {
        // Editor may already be destroyed
      }
    }
    if (editorInstance) {
      editorInstance.destroy();
      editorInstance = null;
    }
    currentDocId = null;
  }

  // Get the ID of the document currently being edited
  function getCurrentDocId() {
    return currentDocId;
  }

  // Get the current Editor.js instance (for external access)
  function getInstance() {
    return editorInstance;
  }

  return {
    openEditor,
    hide,
    getCurrentDocId,
    getInstance,
    debouncedSave,
  };
})();

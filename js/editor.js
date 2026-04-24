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
        // New code blocks may have been added (slash command or paste) — resize
        autoResizeCodeBlocks();
      },

      // When editor is ready
      onReady: function () {
        if (saveIndicator) saveIndicator.textContent = "Saved";
        // Resize any code blocks loaded with the initial document
        autoResizeCodeBlocks();
        // Intercept Cmd+V of raw markdown text so inline formatting survives
        installMarkdownPasteHandler();
        // Live markdown shortcuts: "### ", "- ", "> ", etc. convert as you type
        installMarkdownShortcuts();
      },
    });

    // Show save indicator
    if (saveIndicator) saveIndicator.textContent = "Saved";
  }

  /*
   * Editor.js's default paste handler treats `**bold**` as literal text —
   * there's no built-in markdown-in, only HTML-in. When the clipboard looks
   * like multi-line markdown (has fenced code, headings, bold, lists, or is
   * long enough that losing formatting would be painful), we route it through
   * SidebarUI.markdownToBlocks and render the resulting blocks via
   * editor.blocks.renderFromHTML-equivalent — i.e. insert each block at the
   * caret. Single-line paragraphs without any markdown markers skip this path
   * so normal prose paste still works.
   */
  function installMarkdownPasteHandler() {
    const holder = document.getElementById("editorjs");
    if (!holder || holder.dataset.mdPasteBound) return;
    holder.dataset.mdPasteBound = "1";

    holder.addEventListener(
      "paste",
      (e) => {
        // Don't interfere with pastes into a code block — users want raw text there
        if (e.target && e.target.closest && e.target.closest(".ce-code__textarea, textarea")) return;

        // Only handle plain-text clipboards — rich HTML copy (from a web page,
        // Notion, etc.) is already structured and Editor.js handles it fine.
        const types = e.clipboardData && e.clipboardData.types ? Array.from(e.clipboardData.types) : [];
        if (types.includes("text/html")) return;

        const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
        if (!text || !looksLikeMarkdown(text)) return;

        // We're taking over — stop Editor.js from inserting the raw text
        e.preventDefault();
        e.stopPropagation();

        insertMarkdownAsBlocks(text);
      },
      true // capture phase — beats Editor.js's own listener
    );
  }

  // Cheap heuristic: does this blob of text look like structured markdown?
  // We only want to intercept when converting actually helps — short plain
  // sentences should paste normally.
  function looksLikeMarkdown(text) {
    if (text.length < 40) return false;
    // Multiple newlines = multi-block content
    const hasMultipleLines = text.split("\n").filter((l) => l.trim()).length >= 2;
    // Any of these tokens suggests real markdown
    const hasMarker = /(^|\n)#{1,6}\s|```|(^|\n)[-*+]\s|(^|\n)\d+\.\s|(^|\n)>\s|\*\*[^*]+\*\*|\|.*\|/.test(text);
    return hasMultipleLines && hasMarker;
  }

  // Convert markdown to Editor.js blocks and insert them at the current caret
  function insertMarkdownAsBlocks(markdown) {
    if (!editorInstance || typeof SidebarUI === "undefined") return;
    const { blocks } = SidebarUI.markdownToBlocks(markdown);
    if (!blocks || blocks.length === 0) return;

    const currentIdx = editorInstance.blocks.getCurrentBlockIndex();
    // Insert after the current block; if the current block is empty, replace it
    let insertAt = currentIdx >= 0 ? currentIdx + 1 : editorInstance.blocks.getBlocksCount();

    blocks.forEach((block) => {
      editorInstance.blocks.insert(block.type, block.data, {}, insertAt, false);
      insertAt++;
    });

    // Trigger save + code-block resize for the newly inserted content
    debouncedSave();
    setTimeout(autoResizeCodeBlocks, 0);
  }

  /*
   * Live markdown shortcuts — convert a paragraph to the intended block type
   * as soon as the user finishes typing the shortcut prefix.
   *
   * Editor.js has no built-in markdown-while-typing support (its "shortcuts"
   * are keyboard chords like Cmd+Shift+H, not `### `). Without this, typing
   * `### heading` leaves you with a paragraph that contains literal hash marks.
   *
   * We hook the `input` event on the editor holder. On each keystroke we look
   * at the current block's text. If it exactly matches a shortcut pattern AND
   * the block is still a paragraph, we swap it for the target block type.
   *
   * Shortcuts fire only when the whole block text matches — so `### ` alone
   * converts, but `### hello` does not (preventing mid-sentence conversions).
   */
  function installMarkdownShortcuts() {
    const holder = document.getElementById("editorjs");
    if (!holder || holder.dataset.mdShortcutsBound) return;
    holder.dataset.mdShortcutsBound = "1";

    holder.addEventListener("input", (e) => {
      if (!editorInstance) return;
      // Ignore input inside code textareas (user wants raw characters there)
      if (e.target && e.target.closest && e.target.closest(".ce-code__textarea, textarea")) return;

      const idx = editorInstance.blocks.getCurrentBlockIndex();
      if (idx < 0) return;
      const block = editorInstance.blocks.getBlockByIndex(idx);
      if (!block || block.name !== "paragraph") return;

      // Read the current paragraph's plain text (without HTML)
      const blockEl = block.holder;
      const contentEl = blockEl && blockEl.querySelector(".ce-paragraph, [contenteditable]");
      if (!contentEl) return;
      const text = contentEl.textContent || "";

      const shortcut = matchShortcut(text);
      if (!shortcut) return;

      applyShortcut(idx, shortcut);
    });
  }

  // Map a paragraph's full text to the block it should become (or null)
  function matchShortcut(text) {
    // Heading: "# " through "###### " — trailing space is the trigger
    const h = text.match(/^(#{1,6}) $/);
    if (h) return { type: "header", data: { text: "", level: h[1].length } };

    // Checklist: "[] ", "[ ] ", or "- [ ] " — before bullet list so `- [ ]`
    // isn't swallowed by the bullet pattern
    if (/^(-\s+)?\[\s?\] $/.test(text)) {
      return { type: "checklist", data: { items: [{ text: "", checked: false }] } };
    }

    // Unordered list: "- ", "* ", "+ "
    if (/^[-*+] $/.test(text)) {
      return { type: "list", data: { style: "unordered", items: [""] } };
    }

    // Ordered list: "1. " (or any digits)
    if (/^\d+\. $/.test(text)) {
      return { type: "list", data: { style: "ordered", items: [""] } };
    }

    // Blockquote: "> "
    if (text === "> ") return { type: "quote", data: { text: "", caption: "", alignment: "left" } };

    // Code fence: "```" — no trailing space, converts immediately on third backtick
    if (text === "```") return { type: "code", data: { code: "" } };

    // Horizontal rule: "---" (or "***", "___")
    if (text === "---" || text === "***" || text === "___") {
      return { type: "delimiter", data: {} };
    }

    return null;
  }

  // Replace the current paragraph with the chosen block type
  function applyShortcut(idx, shortcut) {
    // Defer to after the current input event — mutating blocks synchronously
    // inside an input handler can leave Editor.js in a stale state
    setTimeout(() => {
      if (!editorInstance) return;
      try {
        editorInstance.blocks.delete(idx);
        editorInstance.blocks.insert(shortcut.type, shortcut.data, {}, idx, true);

        // Delimiter has no editable surface — add a paragraph after it so the
        // caret has somewhere to land
        if (shortcut.type === "delimiter") {
          editorInstance.blocks.insert("paragraph", { text: "" }, {}, idx + 1, true);
        }

        autoResizeCodeBlocks();
      } catch (err) {
        console.error("Shortcut conversion failed:", err);
      }
    }, 0);
  }

  /*
   * Editor.js's CodeTool renders as a fixed-height <textarea>. For long fenced
   * code blocks (e.g. imported from markdown), the content gets stuck behind an
   * inner scrollbar. We size every code textarea to its content instead — one
   * tall block that scrolls with the page, not inside itself.
   *
   * Called from onReady (for loaded docs) and onChange (for new/edited blocks).
   * Each textarea is tagged so we only wire the input listener once.
   */
  function autoResizeCodeBlocks() {
    document.querySelectorAll("#editorjs .ce-code__textarea").forEach((ta) => {
      resizeTextarea(ta);
      if (!ta.dataset.autoResized) {
        ta.addEventListener("input", () => resizeTextarea(ta));
        ta.dataset.autoResized = "1";
      }
    });
  }

  function resizeTextarea(ta) {
    // Reset to a small height first so scrollHeight reflects actual content
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
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

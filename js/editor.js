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

/*
 * FolioImageTool — minimal Editor.js block for inline images.
 *
 * Editor.js doesn't ship with a built-in image block; the official @editorjs/image
 * tool assumes you have a server to upload to. We don't (Folio is static), so we
 * roll our own tiny one — it accepts a data URL (or any URL) and renders an
 * <img> + an editable caption. ~40 lines, no dependency.
 *
 * Data shape: { url: "data:image/jpeg;base64,...", caption: "" }
 */
class FolioImageTool {
  static get toolbox() {
    return {
      title: "Image",
      icon:
        '<svg width="17" height="15" viewBox="0 0 17 15" xmlns="http://www.w3.org/2000/svg"><path d="M2 1h13a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v11h13V2H2zm3 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-2 7l3-4 2 2 3-4 4 6H3z" fill="currentColor"/></svg>',
    };
  }

  static get isReadOnlySupported() { return true; }

  constructor({ data }) {
    this.data = {
      url: (data && data.url) || "",
      caption: (data && data.caption) || "",
    };
    this.wrapper = null;
    this.captionEl = null;
  }

  render() {
    const wrapper = document.createElement("figure");
    wrapper.className = "folio-image-block";

    if (this.data.url) {
      const img = document.createElement("img");
      img.src = this.data.url;
      img.alt = this.data.caption || "";
      wrapper.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "folio-image-placeholder";
      placeholder.textContent = "Paste an image (Cmd+V) to insert it here";
      wrapper.appendChild(placeholder);
    }

    const caption = document.createElement("div");
    caption.className = "folio-image-caption";
    caption.contentEditable = "true";
    caption.dataset.placeholder = "Caption (optional)";
    caption.textContent = this.data.caption;
    wrapper.appendChild(caption);

    this.wrapper = wrapper;
    this.captionEl = caption;
    return wrapper;
  }

  save() {
    return {
      url: this.data.url,
      caption: this.captionEl ? this.captionEl.textContent : this.data.caption,
    };
  }

  validate(savedData) {
    return !!(savedData && savedData.url);
  }
}

const Editor = (function () {

  // The Editor.js instance
  let editorInstance = null;
  // The document currently being edited
  let currentDocId = null;
  // Timer for debounced auto-save
  let saveTimer = null;
  /*
   * The title gets its OWN timer. It used to share `saveTimer`, which meant
   * typing in the title within a second of editing the body cancelled the
   * pending body save — the edit was silently dropped.
   */
  let titleTimer = null;

  /*
   * ==========================================================================
   * GUARDS AGAINST OVERWRITING SOMEBODY ELSE'S WRITE
   * ==========================================================================
   * This editor is not the only thing that writes a document. Generating or
   * importing a transcript rewrites the blocks (js/video.js), and renaming from
   * the sidebar rewrites the title (js/sidebar.js:231). Both can happen while an
   * editor instance is sitting there holding an older copy in memory.
   *
   * It used to save that older copy back on the way out — unconditionally — so
   * a freshly generated transcript was silently reverted the moment you
   * switched to the reader. Worse, the reader had already rendered the NEW
   * text, so the screen looked right and the loss only surfaced on reload.
   *
   * Two flags prevent it:
   *   - `loadedTime`, so an editor holding an older copy refuses to clobber a
   *     document that changed underneath it;
   *   - `titleDirty`, so a rename made elsewhere is not undone by the stale
   *     value still sitting in the title input.
   */
  let titleDirty = false;      // has the user edited the title in this editor?
  let loadedTime = 0;          // the `time` stamp of the content we loaded

  /* The `time` currently in storage, or 0 if there is nothing readable. */
  function storageTime(id) {
    try {
      const raw = localStorage.getItem(`folio_doc_${id}`);
      return raw ? (JSON.parse(raw).time || 0) : 0;
    } catch { return 0; }
  }

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

    /*
     * Remember exactly which revision this instance is showing. Any later save
     * checks this against storage, so an editor holding a stale copy can never
     * write over a transcript that was regenerated while it sat open.
     */
    const initial = doc.content && doc.content.blocks && doc.content.blocks.length > 0
      ? doc.content
      : { time: Date.now(), blocks: [] };
    /*
     * Read from STORAGE, never from `initial`.
     *
     * An empty document takes the second branch above, whose `time` is minted
     * right here and has never been written anywhere. Trusting it meant
     * loadedTime could never match storage, so every save was refused as stale
     * and a brand new page silently discarded everything typed or pasted into
     * it. What this field means is "the revision of storage this editor is
     * based on", so it has to come from storage.
     */
    loadedTime = storageTime(docId);
    titleDirty = false;

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
        image: {
          class: FolioImageTool,
          inlineToolbar: false,
        },
      },

      // Load saved data
      data: initial,

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

        // ── A bare YouTube link becomes a video document ──
        // Matches the behaviour people expect from Notion: pasting the link is
        // the request, no dialog in between.
        if (typeof Gemini !== "undefined" && typeof Video !== "undefined") {
          const maybeUrl = e.clipboardData ? e.clipboardData.getData("text/plain").trim() : "";
          if (maybeUrl && !/\s/.test(maybeUrl) && Gemini.parseYouTube(maybeUrl)) {
            e.preventDefault();
            e.stopPropagation();
            Video.importUrl(maybeUrl).catch((err) => {
              if (typeof Video !== "undefined") Video.notify(err && err.message ? err.message : "Could not import that video");
            });
            return;
          }
        }

        // ── Image pastes (Cmd+V from screenshot, photo, etc.) ──
        // Check clipboardData.items for an image file BEFORE looking at text:
        // some apps put both an image and a text fallback ("[image]") on the
        // clipboard, and we want the actual image, not the fallback string.
        const imageItem = findImageInClipboard(e.clipboardData);
        if (imageItem) {
          e.preventDefault();
          e.stopPropagation();
          handleImagePaste(imageItem);
          return;
        }

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

  // Pull the first image File out of a clipboard, or null if none present
  function findImageInClipboard(clipboardData) {
    if (!clipboardData) return null;
    // Prefer items[] — gives access to images even when the clipboard also has text
    if (clipboardData.items) {
      for (const item of clipboardData.items) {
        if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
          return item.getAsFile();
        }
      }
    }
    if (clipboardData.files) {
      for (const f of clipboardData.files) {
        if (f.type && f.type.startsWith("image/")) return f;
      }
    }
    return null;
  }

  /*
   * Image paste flow:
   *   1. Read the file as a data URL
   *   2. Pass through compressImage() — resizes >1800px, JPEG-encodes >500KB
   *   3. Insert as an image block at the caret
   *   4. Run a soft-quota check; warn if localStorage is near full
   */
  async function handleImagePaste(file) {
    if (!editorInstance) return;
    try {
      const dataUrl = await compressImage(file);
      const idx = editorInstance.blocks.getCurrentBlockIndex();
      const insertAt = idx >= 0 ? idx + 1 : editorInstance.blocks.getBlocksCount();
      editorInstance.blocks.insert("image", { url: dataUrl, caption: "" }, {}, insertAt, true);
      debouncedSave();
      checkStorageQuota();
    } catch (err) {
      console.error("Image paste failed:", err);
      if (typeof TTS !== "undefined" && TTS.toast) TTS.toast("Couldn't paste that image — " + (err.message || "unknown error"), 4000);
    }
  }

  /*
   * compressImage — turn an image File into a data URL that's safe for localStorage.
   *
   * Strategy (matches what we agreed):
   *   • If the file is already small (≤500KB), keep it as-is (preserves PNG
   *     transparency, GIF animation, screenshot crispness).
   *   • Otherwise decode into a canvas, resize so the longest edge ≤1800px,
   *     and re-encode as JPEG at 0.92 quality. If still >1.5MB, retry at 0.85.
   *
   * JPEG (per user preference) — wider compatibility than WebP at the cost of
   * losing transparency. Most screenshots/photos are RGB anyway.
   */
  async function compressImage(file) {
    const MAX_EDGE = 1800;
    const SMALL_FILE = 500 * 1024;
    const TARGET_BYTES = 1.5 * 1024 * 1024;

    // Tiny images go through unchanged — no point re-encoding
    if (file.size <= SMALL_FILE) {
      return await fileToDataUrl(file);
    }

    const img = await loadImage(await fileToDataUrl(file));

    // Compute target dimensions, preserving aspect ratio
    let { width, height } = img;
    if (width > MAX_EDGE || height > MAX_EDGE) {
      const scale = MAX_EDGE / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    // White background — JPEG can't do transparency, so flatten alpha to white
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    let dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    if (dataUrlByteSize(dataUrl) > TARGET_BYTES) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    }
    return dataUrl;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("Couldn't read clipboard image"));
      r.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't decode clipboard image"));
      img.src = dataUrl;
    });
  }

  // Approximate byte size of a base64 data URL
  function dataUrlByteSize(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma === -1) return 0;
    const b64 = dataUrl.slice(comma + 1);
    return Math.floor(b64.length * 0.75);
  }

  /*
   * Soft quota warning — and the two things wrong with it were both found on
   * 17 October 2026, after a page failed to save with no warning at all.
   *
   * FAULT ONE, AND IT IS THE REAL ONE: this was called from exactly one place,
   * the image-paste handler. So it only ever ran when an IMAGE was pasted. He
   * pasted TEXT into a document, filled the storage with ordinary writing, and
   * the check never executed once. It is now called after every successful
   * save, which is both the moment that matters and the moment the size
   * actually changed. It costs one walk of localStorage per session, because
   * it stops checking after it has warned.
   *
   * FAULT TWO: the threshold was a guess at the browser's limit, and the guess
   * is not knowable. Chrome allows ten megabytes per origin in current
   * versions and five in older ones; other browsers differ again. A fixed
   * number is either so low it nags on a roomy browser or so high it never
   * fires on a tight one.
   *
   * So the real signal is not a number at all: TRY A WRITE. A quarter-megabyte
   * test value, written and immediately removed, answers "is there room for
   * another page?" on any browser without needing to know its limit. The size
   * check stays as a second trigger for the case where the wall is still some
   * way off but approaching.
   */
  const SOFT_LIMIT = 4 * 1024 * 1024;
  const HEADROOM_TEST = 256 * 1024;      // a generous page, in UTF-16 bytes
  let storageWarned = false;

  /*
   * Is there room for another page? Asked by writing one and taking it back.
   * The key is removed in a finally, so a failure cannot leave the test value
   * behind taking up the very space it was measuring.
   */
  function hasHeadroom() {
    const key = "__folio_headroom__";
    try {
      localStorage.setItem(key, "x".repeat(HEADROOM_TEST / 2));
      return true;
    } catch (err) {
      return false;
    } finally {
      try { localStorage.removeItem(key); } catch (e) { /* nothing to undo */ }
    }
  }

  function checkStorageQuota() {
    if (storageWarned) return;
    const report = FolioStore.storageReport();
    const roomy = hasHeadroom();
    if (roomy && report.total <= SOFT_LIMIT) return;

    storageWarned = true;
    const mb = (report.total / 1048576).toFixed(1);
    /* Name the biggest group, because "storage is full" leaves the user with
     * nowhere to start and "3.1MB of that is pages" does not. */
    const top = Object.entries(report.groups).sort((a, b) => b[1] - a[1])[0];
    const where = top ? ` Most of it (${(top[1] / 1048576).toFixed(1)}MB) is ${top[0]}.` : "";
    const how = roomy
      ? `Storage is up to ${mb}MB.`
      : `Storage is ${mb}MB and there is no longer room for another page.`;
    setTimeout(() => {
      const msg = `${how}${where} Open Settings → Backup → Export all now — ` +
                  `once it is full, edits stop being saved.`;
      if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(msg, 14000);
      else console.warn("[folio]", msg);
    }, 100);
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

  /*
   * The ONE place editor content reaches storage. Both the debounced auto-save
   * and hide() go through here, so the staleness guard cannot be sidestepped by
   * some future caller that forgets it exists.
   *
   * Returns "saved" | "clean" | "stale" | "failed".
   */
  async function persistContent() {
    if (!currentDocId || !editorInstance) return "clean";

    const id = currentDocId;
    // Cheap pre-check, before paying for the serialisation.
    if (storageTime(id) !== loadedTime) return stale(id);

    try {
      const data = await editorInstance.save();
      /*
       * Check again. save() is async, so the document could have been rewritten
       * while we were serialising it — and the whole point of this guard is the
       * write that lands at an awkward moment.
       */
      if (storageTime(id) !== loadedTime) return stale(id);

      /*
       * Whether there is anything to write is decided by COMPARING, never by a
       * "dirty" flag. Editor.js reports edits through onChange asynchronously,
       * so a flag is still false for an edit made a moment ago — and gating the
       * write on it silently threw away anything typed just before you
       * navigated away. Comparing cannot be early.
       */
      if (sameAsStored(id, data.blocks)) return "clean";

      FolioStore.updateDocument(id, { content: data });
      // Our own write is now the revision this instance is based on.
      loadedTime = data.time || loadedTime;
      /*
       * Check the room left AFTER every successful save. This used to be
       * checked only when an image was pasted, so a document filled with
       * ordinary typing could walk all the way into a failed save without one
       * word of warning — which is what happened. It returns immediately once
       * it has warned, so this costs one walk of storage per session.
       */
      checkStorageQuota();
      return "saved";
    } catch (err) {
      console.error("Auto-save failed:", err);
      /*
       * REMEMBER WHY IT FAILED, because the two causes need different words.
       * A full disk is something the user can act on — export, delete a page,
       * carry on. Anything else is a defect they can do nothing about, and
       * telling them "storage holds 0.0MB" in that case is both useless and
       * obviously wrong, which costs the rest of the message its credibility.
       * Found by looking at a rendered banner, not by any assertion.
       */
      lastSaveFailure = FolioStore.isQuotaError(err) ? "quota" : "other";
      return "failed";
    }
  }

  /* Why the last save failed: "quota", "other", or null if none has. */
  let lastSaveFailure = null;
  function lastSaveFailureReason() { return lastSaveFailure; }

  /*
   * Does what the editor holds match what is already on disk? Compared on type
   * and data only: Editor.js mints block ids on load for blocks that never had
   * them, and those differences are not content.
   */
  function sameAsStored(id, blocks) {
    try {
      const raw = localStorage.getItem(`folio_doc_${id}`);
      if (!raw) return false;
      const shape = (bs) => JSON.stringify((bs || []).map((b) => [b.type, b.data]));
      return shape(JSON.parse(raw).blocks) === shape(blocks);
    } catch { return false; }
  }

  /*
   * Somebody else wrote this document after we loaded it — a regenerated
   * transcript, an import, a Notion pull. Their copy is current, ours is not,
   * so we keep our hands off it and say so rather than failing silently.
   */
  function stale(id) {
    console.warn(`[editor] ${id} changed elsewhere since it was opened — not overwriting`);
    return "stale";
  }

  // Debounced save — waits 1 second after last change before saving
  function debouncedSave() {
    if (!currentDocId || !editorInstance) return;

    if (saveIndicator) saveIndicator.textContent = "Saving...";

    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const result = await persistContent();
      if (saveIndicator) {
        saveIndicator.textContent =
          result === "stale"  ? "Changed elsewhere — not saved" :
          result === "failed" ? "Save failed" : "Saved";
      }
      // Update the sidebar to reflect any changes
      if (result === "saved" && typeof SidebarUI !== "undefined") {
        SidebarUI.renderPageTree();
      }
    }, 1000);
  }

  // Auto-save title changes
  titleInput.addEventListener("input", () => {
    if (!currentDocId) return;
    titleDirty = true;

    if (saveIndicator) saveIndicator.textContent = "Saving...";

    /*
     * Its own timer. Sharing `saveTimer` meant that typing a title within a
     * second of editing the body cancelled the body's pending save, and that
     * edit was lost without a trace.
     */
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      FolioStore.updateDocument(currentDocId, {
        title: titleInput.value || "Untitled",
      });
      titleDirty = false;
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
  /*
   * Close the editor, flushing it first — and REFUSE to close it if that flush
   * failed, because the text would then exist nowhere.
   *
   * Reported 17 October 2026: a page edited with a full localStorage showed
   * "Save failed" in the corner, and pressing the view button drew an empty
   * document. Nothing had been written, the instance was destroyed anyway, and
   * the only copy of the text went with it. The reader was telling the truth —
   * storage really was empty — which made it look exactly like the text had
   * been deleted.
   *
   * So a failed flush now leaves EVERYTHING standing: the instance, its
   * content, the document id. The caller is told, and it is the caller's job
   * to keep the user where their words are. Pass { force: true } to close
   * anyway, which is for the case where the user has been told and chooses to
   * leave regardless.
   *
   * Returns the persist result: "saved" | "clean" | "stale" | "failed".
   */
  async function hide(opts) {
    const force = !!(opts && opts.force);
    let result = "clean";
    if (currentDocId && editorInstance) {
      clearTimeout(saveTimer);
      clearTimeout(titleTimer);
      // Flushes only if the user actually edited, and only if nothing else has
      // rewritten the document since this editor opened.
      result = await persistContent();

      /*
       * The whole point of the change. Tearing down here would destroy the
       * only copy of what is on screen.
       */
      if (result === "failed" && !force) {
        if (saveIndicator) saveIndicator.textContent = "Save failed";
        return result;
      }
      /*
       * Same rule for the title. It used to be written unconditionally, so
       * renaming a page from the sidebar while its editor was open got reverted
       * the moment you navigated away — the stale value sitting in this input
       * won over the rename you had just made.
       */
      if (titleDirty) {
        try {
          FolioStore.updateDocument(currentDocId, { title: titleInput.value || "Untitled" });
          titleDirty = false;
        } catch (err) {
          /* A title that cannot be written is the same failure as a body that
           * cannot be written, and for the same reason: the storage is full. */
          console.error("[editor] could not save the title", err);
          if (!force) {
            if (saveIndicator) saveIndicator.textContent = "Save failed";
            return "failed";
          }
        }
      }
    }
    if (editorInstance) {
      editorInstance.destroy();
      editorInstance = null;
    }
    currentDocId = null;
    return result;
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
    lastSaveFailureReason,
    debouncedSave,
  };
})();

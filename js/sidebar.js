/*
 * =============================================================================
 * SIDEBAR.JS — Persistent Page Tree with Search
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages the sidebar — the always-visible left panel that shows
 * the page tree, search, and navigation. It handles:
 * - Rendering the page tree (with nested pages)
 * - Creating, renaming, deleting pages
 * - Full-text search across all documents
 * - Drag-and-drop file import
 * - Collapsing/expanding the sidebar
 *
 * HOW IT WORKS:
 * 1. renderPageTree() builds the page tree from FolioStore data
 * 2. Pages are rendered recursively (children nested under parents)
 * 3. Search is debounced and queries FolioStore.searchDocuments()
 * 4. Context menus provide rename, delete, export, add subpage options
 * =============================================================================
 */

const SidebarUI = (function () {

  // Cache DOM elements
  const sidebar = document.getElementById("sidebar");
  const pagesContainer = document.getElementById("sidebar-pages");
  const searchInput = document.getElementById("sidebar-search-input");
  const searchResults = document.getElementById("search-results");
  const fileInput = document.getElementById("file-input");

  // Track which document is currently selected
  let activeDocId = null;
  // Track which page tree nodes are expanded
  let expandedNodes = new Set();
  // Currently open context menu
  let activeContextMenu = null;
  // Search debounce timer
  let searchTimer = null;

  // ==========================================================================
  // PAGE TREE — Build and render the recursive page tree
  // ==========================================================================

  // Render the entire page tree from scratch
  function renderPageTree() {
    pagesContainer.innerHTML = "";

    const topLevel = FolioStore.getTopLevelDocuments();

    if (topLevel.length === 0) {
      pagesContainer.innerHTML = `
        <div style="padding: 20px 16px; text-align: center; color: var(--ink-faint); font-family: var(--font-ui); font-size: 12px;">
          No pages yet. Click "New Page" to start.
        </div>
      `;
      return;
    }

    topLevel.forEach((doc) => {
      const el = buildPageItem(doc, 0);
      pagesContainer.appendChild(el);
    });

    pagesContainer.appendChild(buildRootDropZone());
  }

  /*
   * The empty space below the tree accepts a drop and makes the page top level.
   *
   * Without it there is no way to UN-nest by dragging — only to drag onto some
   * other root page, which is a different intent and leaves a page you wanted
   * at the top buried one level down.
   */
  function buildRootDropZone() {
    const zone = document.createElement("div");
    zone.id = "sidebar-root-drop";

    zone.addEventListener("dragover", (e) => {
      if (!draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropMarks();
      zone.classList.add("drop-active");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-active"));
    zone.addEventListener("drop", (e) => {
      if (!draggingId) return;
      e.preventDefault();
      e.stopPropagation();
      const moved = draggingId;
      draggingId = null;
      clearDropMarks();
      FolioStore.reorderDocument(moved, null, Number.MAX_SAFE_INTEGER);
      renderPageTree();
    });

    return zone;
  }

  // Build a single page item element (recursively includes children)
  function buildPageItem(doc, depth) {
    const children = FolioStore.getChildDocuments(doc.id);
    const hasChildren = children.length > 0;
    const isExpanded = expandedNodes.has(doc.id);

    // Create the container for this page + its children
    const wrapper = document.createElement("div");
    wrapper.className = "page-item-wrapper";

    // The clickable page item row
    const item = document.createElement("div");
    item.className = "page-item" + (doc.id === activeDocId ? " active" : "");
    item.style.paddingLeft = (16 + depth * 16) + "px";
    item.dataset.id = doc.id;

    // Toggle arrow (only if has children)
    if (hasChildren) {
      const toggle = document.createElement("span");
      toggle.className = "page-item-toggle" + (isExpanded ? " expanded" : "");
      toggle.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (expandedNodes.has(doc.id)) {
          expandedNodes.delete(doc.id);
        } else {
          expandedNodes.add(doc.id);
        }
        renderPageTree();
      });
      item.appendChild(toggle);
    } else {
      // Spacer to align items without toggles
      const spacer = document.createElement("span");
      spacer.style.width = "16px";
      spacer.style.flexShrink = "0";
      item.appendChild(spacer);
    }

    // Page icon
    const icon = document.createElement("span");
    icon.className = "page-item-icon";
    icon.textContent = doc.icon || "";
    item.appendChild(icon);

    // Page title
    const title = document.createElement("span");
    title.className = "page-item-title";
    title.textContent = doc.title || "Untitled";
    item.appendChild(title);

    // Add subpage button
    const addBtn = document.createElement("button");
    addBtn.className = "page-item-add";
    addBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    addBtn.title = "Add subpage";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      createSubpage(doc.id);
    });
    item.appendChild(addBtn);

    // Three-dot menu
    const menuBtn = document.createElement("button");
    menuBtn.className = "page-item-menu";
    menuBtn.innerHTML = "&hellip;";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(e, doc);
    });
    item.appendChild(menuBtn);

    // Click to open the page
    item.addEventListener("click", () => {
      window.location.hash = `#/doc/${doc.id}`;
    });

    attachDragHandlers(item, doc);

    wrapper.appendChild(item);

    // Render children if expanded
    if (hasChildren && isExpanded) {
      const childContainer = document.createElement("div");
      childContainer.className = "page-children";
      children.forEach((child) => {
        childContainer.appendChild(buildPageItem(child, depth + 1));
      });
      wrapper.appendChild(childContainer);
    }

    return wrapper;
  }

  // ==========================================================================
  // DRAGGING PAGES — reparent and reorder
  // ==========================================================================

  /*
   * Every row is three drop targets, not one.
   *
   *   ┌──────────────────────────┐
   *   │  top 25%    → drop ABOVE │   reorder among siblings
   *   │  middle 50% → drop INSIDE│   becomes a child of this page
   *   │  bottom 25% → drop BELOW │   reorder among siblings
   *   └──────────────────────────┘
   *
   * One zone cannot express both "put it here in the list" and "put it inside
   * this page", and both are things people expect from a tree. The middle is
   * the larger half because nesting is the more common intent; the edges stay
   * big enough to hit deliberately.
   */
  let draggingId = null;
  let expandTimer = null;

  const ZONE_INSIDE = "inside";
  const ZONE_ABOVE = "above";
  const ZONE_BELOW = "below";
  const AUTO_EXPAND_MS = 600;

  function zoneFor(item, clientY) {
    const r = item.getBoundingClientRect();
    const y = (clientY - r.top) / (r.height || 1);
    if (y < 0.25) return ZONE_ABOVE;
    if (y > 0.75) return ZONE_BELOW;
    return ZONE_INSIDE;
  }

  function clearDropMarks() {
    pagesContainer.querySelectorAll(".drop-inside, .drop-above, .drop-below")
      .forEach((el) => el.classList.remove("drop-inside", "drop-above", "drop-below"));
    const root = document.getElementById("sidebar-root-drop");
    if (root) root.classList.remove("drop-active");
    if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
  }

  /*
   * A page cannot be dropped into itself or into anything beneath it. Allowing
   * it would leave the subtree in storage but unreachable from the root — it
   * would simply vanish from the sidebar, which looks exactly like data loss.
   */
  function dropAllowed(target, zone) {
    if (!draggingId) return false;
    if (target.id === draggingId) return false;

    // Dropping INSIDE makes the target the new parent.
    if (zone === ZONE_INSIDE) {
      return !FolioStore.isDescendantOf(target.id, draggingId);
    }

    /*
     * Dropping above or below makes the target's PARENT the new parent — which
     * is its own way to build a cycle. Dragging A onto the gap beside its own
     * child A1 would make A a child of A. Checking only the target would let
     * that through.
     */
    const pid = target.parentId || null;
    if (!pid) return true;                     // the root can never be a descendant
    if (pid === draggingId) return false;
    return !FolioStore.isDescendantOf(pid, draggingId);
  }

  function attachDragHandlers(item, doc) {
    item.draggable = true;

    item.addEventListener("dragstart", (e) => {
      draggingId = doc.id;
      /*
       * A payload is required or Firefox refuses to start the drag, and the
       * custom type keeps this distinguishable from a file drop — the sidebar
       * already accepts dragged .md files and must keep doing so.
       */
      e.dataTransfer.setData("application/x-folio-page", doc.id);
      e.dataTransfer.effectAllowed = "move";
      item.classList.add("dragging");
    });

    item.addEventListener("dragend", () => {
      draggingId = null;
      item.classList.remove("dragging");
      clearDropMarks();
    });

    item.addEventListener("dragover", (e) => {
      if (!draggingId) return;                 // a file, or something else
      const zone = zoneFor(item, e.clientY);
      if (!dropAllowed(doc, zone)) {
        e.dataTransfer.dropEffect = "none";
        return;                                // no preventDefault → refused
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (!item.classList.contains("drop-" + zone)) {
        clearDropMarks();
        item.classList.add("drop-" + zone);
      }

      /*
       * Hovering a collapsed page opens it, so you can drop into a nested
       * position without letting go and picking the drag up again.
       */
      if (zone === ZONE_INSIDE && !expandedNodes.has(doc.id) &&
          FolioStore.getChildDocuments(doc.id).length && !expandTimer) {
        expandTimer = setTimeout(() => {
          expandTimer = null;
          expandedNodes.add(doc.id);
          renderPageTree();
        }, AUTO_EXPAND_MS);
      }
    });

    item.addEventListener("dragleave", () => {
      item.classList.remove("drop-inside", "drop-above", "drop-below");
      if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
    });

    item.addEventListener("drop", (e) => {
      if (!draggingId) return;
      e.preventDefault();
      e.stopPropagation();                     // never reach the file importer
      const moved = draggingId;
      const zone = zoneFor(item, e.clientY);
      /*
       * Decide BEFORE clearing the drag state. dropAllowed reads draggingId, so
       * nulling it first made every drop refuse itself — including the ones
       * that should have worked.
       */
      const allowed = dropAllowed(doc, zone);
      clearDropMarks();
      draggingId = null;

      if (!allowed) return;

      if (zone === ZONE_INSIDE) {
        FolioStore.reorderDocument(moved, doc.id, Number.MAX_SAFE_INTEGER);
        expandedNodes.add(doc.id);
      } else {
        const parentId = doc.parentId || null;
        const siblings = (parentId ? FolioStore.getChildDocuments(parentId)
                                   : FolioStore.getTopLevelDocuments())
          .filter((d) => d.id !== moved);
        let index = siblings.findIndex((d) => d.id === doc.id);
        if (index === -1) index = siblings.length;
        FolioStore.reorderDocument(moved, parentId, zone === ZONE_BELOW ? index + 1 : index);
      }
      renderPageTree();
    });
  }

  // ==========================================================================
  // CONTEXT MENU — Right-click / three-dot menu on pages
  // ==========================================================================

  function showContextMenu(event, doc) {
    closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = event.clientX + "px";
    menu.style.top = event.clientY + "px";

    const actions = [
      { label: "Edit", action: () => { window.location.hash = `#/doc/${doc.id}/edit`; } },
      { label: "Read", action: () => { window.location.hash = `#/doc/${doc.id}`; } },
      { label: "Rename", action: () => showRenameModal(doc) },
      { label: "Add Subpage", action: () => createSubpage(doc.id) },
      { label: "Export .md", action: () => exportDocument(doc.id) },
      { label: "Delete", action: () => showDeleteModal(doc), danger: true },
    ];

    actions.forEach(({ label, action, danger }) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      if (danger) btn.className = "danger";
      btn.addEventListener("click", () => {
        closeContextMenu();
        action();
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    activeContextMenu = menu;

    // Adjust if offscreen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (event.clientX - rect.width) + "px";
    if (rect.bottom > window.innerHeight) menu.style.top = (event.clientY - rect.height) + "px";

    setTimeout(() => {
      document.addEventListener("click", closeContextMenu, { once: true });
    }, 0);
  }

  function closeContextMenu() {
    if (activeContextMenu) {
      activeContextMenu.remove();
      activeContextMenu = null;
    }
  }

  // ==========================================================================
  // MODALS — Rename and Delete confirmation
  // ==========================================================================

  function showRenameModal(doc) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>Rename Page</h3>
        <input class="rename-input" type="text" value="${escapeHtml(doc.title)}" />
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
          <button class="modal-btn primary save-btn">Save</button>
        </div>
      </div>
    `;
    const input = overlay.querySelector(".rename-input");
    overlay.querySelector(".cancel-btn").onclick = () => overlay.remove();
    overlay.querySelector(".save-btn").onclick = () => {
      const newTitle = input.value.trim();
      if (newTitle) {
        FolioStore.updateDocument(doc.id, { title: newTitle });
        renderPageTree();
      }
      overlay.remove();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") overlay.querySelector(".save-btn").click();
      if (e.key === "Escape") overlay.remove();
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    input.select();
  }

  function showDeleteModal(doc) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const children = FolioStore.getChildDocuments(doc.id);
    const childWarning = children.length > 0
      ? `<br><small style="color:var(--ink-faint)">This will also delete ${children.length} subpage(s).</small>`
      : "";
    overlay.innerHTML = `
      <div class="modal">
        <h3>Delete Page</h3>
        <p>Are you sure you want to delete "<strong>${escapeHtml(doc.title)}</strong>"? This cannot be undone.${childWarning}</p>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
          <button class="modal-btn danger delete-btn">Delete</button>
        </div>
      </div>
    `;
    overlay.querySelector(".cancel-btn").onclick = () => overlay.remove();
    overlay.querySelector(".delete-btn").onclick = () => {
      FolioStore.deleteDocument(doc.id);
      renderPageTree();
      // If we just deleted the active doc, go home
      if (activeDocId === doc.id) {
        window.location.hash = "#/";
      }
      overlay.remove();
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ==========================================================================
  // PAGE CREATION
  // ==========================================================================

  function createNewPage() {
    const meta = FolioStore.createDocument("Untitled", null, null);
    expandedNodes.add(meta.id);
    renderPageTree();
    window.location.hash = `#/doc/${meta.id}/edit`;
  }

  function createSubpage(parentId) {
    const meta = FolioStore.createDocument("Untitled", null, parentId);
    expandedNodes.add(parentId);
    renderPageTree();
    window.location.hash = `#/doc/${meta.id}/edit`;
  }

  // ==========================================================================
  // EXPORT — Download a document as .md
  // ==========================================================================

  function exportDocument(docId) {
    const doc = FolioStore.getDocument(docId);
    if (!doc) return;

    // Convert Editor.js JSON to markdown-ish text
    const md = blocksToMarkdown(doc.content.blocks || []);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (doc.meta.title || "document") + ".md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Simple Editor.js JSON to markdown converter
  function blocksToMarkdown(blocks) {
    return blocks.map(blockToMarkdown).join("\n\n");
  }

  /*
   * One block, on its own.
   *
   * Split out of blocksToMarkdown so the annotation export can render a
   * document block by block and drop each comment in after the passage it was
   * written about. blocksToMarkdown joins everything into a single string,
   * which leaves nowhere to interleave.
   */
  function blockToMarkdown(block) {
    {
      const d = block.data || {};
      switch (block.type) {
        case "header":
          return "#".repeat(d.level || 2) + " " + stripHtml(d.text || "");
        case "paragraph":
          return stripHtml(d.text || "");
        case "list": {
          return (d.items || []).map((item, i) => {
            const text = typeof item === "string" ? item : (item.content || item.text || "");
            return d.style === "ordered"
              ? `${i + 1}. ${stripHtml(text)}`
              : `- ${stripHtml(text)}`;
          }).join("\n");
        }
        case "checklist":
          return (d.items || []).map((item) => {
            return `- [${item.checked ? "x" : " "}] ${stripHtml(item.text || "")}`;
          }).join("\n");
        case "code":
          return "```\n" + (d.code || "") + "\n```";
        case "quote":
          return "> " + stripHtml(d.text || "") + (d.caption ? `\n> — ${stripHtml(d.caption)}` : "");
        case "delimiter":
          return "---";
        case "table": {
          const rows = d.content || [];
          if (rows.length === 0) return "";
          let md = rows[0].map((c) => stripHtml(c)).join(" | ") + "\n";
          md += rows[0].map(() => "---").join(" | ") + "\n";
          rows.slice(1).forEach((row) => {
            md += row.map((c) => stripHtml(c)).join(" | ") + "\n";
          });
          return md;
        }
        default:
          return d.text ? stripHtml(d.text) : "";
      }
    }
  }

  function stripHtml(str) {
    return str.replace(/<[^>]*>/g, "");
  }

  // ==========================================================================
  // MARKDOWN IMPORT — Convert markdown text to Editor.js blocks
  // ==========================================================================

  /*
   * markdownToBlocks — Convert a raw markdown string into Editor.js block data.
   *
   * Uses `marked` (loaded globally) in two passes:
   *   1. marked.lexer(md) gives a flat token stream for block-level structure
   *      (headings, paragraphs, lists, tables, code fences, etc.)
   *   2. marked.parseInline(text) on each block's text converts inline markdown
   *      (**bold**, *italic*, `code`, [link](url)) into the HTML that Editor.js
   *      paragraph/header/list/table/quote sanitizers accept out of the box.
   *
   * Without step 2, asterisks and backticks survive as literal characters in
   * the rendered document because Editor.js never parses markdown itself.
   */
  function markdownToBlocks(md) {
    if (typeof marked === "undefined") {
      // Fallback: marked failed to load — treat the whole thing as one paragraph
      return { time: Date.now(), blocks: [{ type: "paragraph", data: { text: escapeHtml(md) } }] };
    }

    const blocks = [];
    const tokens = marked.lexer(md);

    for (const token of tokens) {
      const block = tokenToBlock(token);
      if (block) blocks.push(block);
    }

    return { time: Date.now(), blocks };
  }

  /*
   * Inline markdown, in the tags Editor.js will actually keep.
   *
   * THIS IS WHERE BOLD WAS BEING LOST. marked emits semantic HTML — <strong>,
   * <em>, <del> — while Editor.js keeps only what its enabled inline tools
   * declare. Read straight out of the bundle: the Bold tool is
   * `sanitize(){return{b:{}}}`, Italic is `{i:{}}`, and the string "strong"
   * does not appear in it at all. So every **bold** and *italic* in a pasted
   * document was silently deleted on the way in.
   *
   * The fix is a translation, not a sanitiser fight: emit the tags the editor
   * already understands.
   *
   *   <strong> -> <b>      Bold tool
   *   <em>     -> <i>      Italic tool
   *   <code>              already allowed (InlineCode)
   *   <a>                 already allowed (Link)
   *   <mark>              already allowed (Marker)
   *
   * <del> has no tool to keep it, so strikethrough is unwrapped to plain text
   * rather than vanishing along with the words inside it.
   */
  const KEEPS = { strong: "b", em: "i" };

  function toEditorTags(html) {
    return String(html)
      .replace(/<(\/?)(strong|em)\b([^>]*)>/gi,
               (m, close, tag, rest) => `<${close}${KEEPS[tag.toLowerCase()]}${rest}>`)
      // No tool keeps these; unwrap so the words survive even if the style does not.
      .replace(/<\/?(del|s|strike|ins|sup|sub|small)\b[^>]*>/gi, "");
  }

  function inlineMd(text) {
    if (!text) return "";
    return toEditorTags(marked.parseInline(text)).trim();
  }

  // Map a single marked lexer token to an Editor.js block (or null to skip)
  function tokenToBlock(token) {
    switch (token.type) {
      case "heading":
        return {
          type: "header",
          data: { text: inlineMd(token.text), level: Math.min(token.depth, 6) },
        };

      case "paragraph": {
        /*
         * A standalone image. marked never emits a top-level `image` token —
         * it wraps one in a paragraph — so the image case below was
         * unreachable, and `![alt](url)` on its own line became an EMPTY
         * paragraph. The picture was dropped entirely.
         */
        const kids = token.tokens || [];
        const onlyImage = kids.length === 1 && kids[0].type === "image";
        if (onlyImage) {
          const img = kids[0];
          if (img.href && /^(data:image\/|https?:)/.test(img.href)) {
            return { type: "image", data: { url: img.href, caption: img.text || "" } };
          }
          return null;
        }
        return { type: "paragraph", data: { text: inlineMd(token.text) } };
      }

      case "code":
        // Fenced code — keep raw (no inline parsing, no HTML)
        return { type: "code", data: { code: token.text } };

      case "hr":
        return { type: "delimiter", data: {} };

      case "blockquote":
        /*
         * A quote's children are block-level, and EVERY kind has to be kept.
         *
         * This used to filter to paragraphs and text, discarding the rest — so
         * a quote containing a list, a heading or a nested quote lost it
         * outright. Measured on a real document: 85 bold spans lived inside
         * blockquotes and only 11 survived, because most of those quotes held
         * something other than a bare paragraph.
         *
         * A quote block stores one HTML string, so children are flattened
         * rather than nested. Flattening loses their shape; dropping them lost
         * the words.
         */
        return {
          type: "quote",
          data: { text: quoteInnerHtml(token.tokens || []), caption: "", alignment: "left" },
        };

      case "list": {
        // GitHub-flavored task lists: items have { task: true, checked: bool }
        const isChecklist = token.items.length > 0 && token.items.every((it) => it.task === true);
        if (isChecklist) {
          return {
            type: "checklist",
            data: {
              items: token.items.map((it) => ({
                text: inlineMd(itemPlainText(it)),
                checked: !!it.checked,
              })),
            },
          };
        }
        return {
          type: "list",
          data: {
            style: token.ordered ? "ordered" : "unordered",
            items: flattenListItems(token.items, 0, []),
          },
        };
      }

      case "table":
        return {
          type: "table",
          data: {
            withHeadings: true,
            content: [
              token.header.map((h) => inlineMd(h.text)),
              ...token.rows.map((row) => row.map((cell) => inlineMd(cell.text))),
            ],
          },
        };

      case "image":
        // Markdown ![alt](url) — only honor data-URL or http(s) sources to
        // avoid pulling in protocol handlers we don't trust
        if (token.href && /^(data:image\/|https?:)/.test(token.href)) {
          return { type: "image", data: { url: token.href, caption: token.text || "" } };
        }
        return null;

      case "space":
      case "html":
        // Ignore whitespace tokens and raw HTML blocks (out of scope)
        return null;

      default:
        // Unknown — render raw content as a paragraph so nothing is silently lost
        if (token.raw && token.raw.trim()) {
          return { type: "paragraph", data: { text: inlineMd(token.raw) } };
        }
        return null;
    }
  }

  /*
   * Everything inside a blockquote, as one HTML string.
   *
   * Recursive, because a quote can hold a quote. Line breaks are real <br>
   * rather than newlines, which HTML would collapse into spaces.
   */
  function quoteInnerHtml(tokens) {
    const parts = [];
    for (const t of tokens || []) {
      switch (t.type) {
        case "paragraph":
        case "text":
          parts.push(inlineMd(t.text || t.raw || "").replace(/\n/g, "<br>"));
          break;
        case "heading":
          // No headings inside a quote block, so carry the emphasis instead.
          parts.push("<b>" + inlineMd(t.text || "") + "</b>");
          break;
        case "list":
          flattenListItems(t.items, 0, []).forEach((item) => parts.push("• " + item));
          break;
        case "code":
          parts.push("<code>" + escapeHtml(t.text || "") + "</code>");
          break;
        case "blockquote":
          parts.push(quoteInnerHtml(t.tokens || []));
          break;
        case "space":
          break;
        default:
          if (t.raw && t.raw.trim()) parts.push(inlineMd(t.raw));
      }
    }
    return parts.filter(Boolean).join("<br>");
  }

  /*
   * A list item's OWN words, without its sub-list.
   *
   * `item.text` contains the nested markdown too, so using it put a literal
   * "- inner" inside the parent item — the sub-bullet appeared as characters
   * rather than as a bullet. marked keeps the item's own words in a leading
   * `text` token and hands the sub-list over as a separate `list` token, so
   * take the former and leave the latter to flattenListItems.
   */
  function itemPlainText(item) {
    const toks = Array.isArray(item.tokens) ? item.tokens : [];
    const own = toks.filter((t) => t.type === "text")
                    .map((t) => t.text || "").join(" ").trim();
    if (own) return own;
    // No token tree (older marked output): take the first line only.
    return String(item.text || item.raw || "").split("\n")[0];
  }

  /*
   * Flatten a list, sub-lists included.
   *
   * The bundled List tool is the flat one — 6KB, and the strings "nested" and
   * "items" appear nowhere in it — so a hierarchy genuinely cannot be stored.
   * Flattening loses the shape, which is a real loss, but silently dropping
   * sub-items or leaving raw "- " in the text are both worse. Depth is marked
   * with a middle dot so a sub-bullet still reads as one.
   */
  function flattenListItems(items, depth, out) {
    for (const it of items || []) {
      const own = itemPlainText(it);
      if (own.trim()) {
        out.push((depth > 0 ? "· ".repeat(depth) : "") + inlineMd(own));
      }
      for (const t of (it.tokens || [])) {
        if (t.type === "list") flattenListItems(t.items, depth + 1, out);
      }
    }
    return out;
  }

  // ==========================================================================
  // SEARCH — Full-text search across all documents
  // ==========================================================================

  function initSearch() {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const query = searchInput.value.trim();

      if (!query) {
        searchResults.classList.remove("visible");
        searchResults.innerHTML = "";
        return;
      }

      searchTimer = setTimeout(() => {
        const results = FolioStore.searchDocuments(query);
        searchResults.innerHTML = "";

        if (results.length === 0) {
          searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-title" style="color:var(--ink-faint)">No results found</div></div>';
          searchResults.classList.add("visible");
          return;
        }

        results.forEach(({ doc, snippet }) => {
          const item = document.createElement("div");
          item.className = "search-result-item";
          item.innerHTML = `
            <div class="search-result-title">${doc.icon || "📄"} ${escapeHtml(doc.title)}</div>
            <div class="search-result-snippet">${escapeHtml(snippet)}</div>
          `;
          item.addEventListener("click", () => {
            window.location.hash = `#/doc/${doc.id}`;
            searchInput.value = "";
            searchResults.classList.remove("visible");
          });
          searchResults.appendChild(item);
        });

        searchResults.classList.add("visible");
      }, 200);
    });

    // Close search results when clicking outside
    document.addEventListener("click", (e) => {
      if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
        searchResults.classList.remove("visible");
      }
    });

    // Keyboard: Escape closes search
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInput.value = "";
        searchResults.classList.remove("visible");
        searchInput.blur();
      }
    });
  }

  // ==========================================================================
  // FILE IMPORT — Drag-and-drop + file picker
  // ==========================================================================

  function initImport() {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importFile(file);
      fileInput.value = "";
    });

    // Also allow dropping files anywhere on the page
    document.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && /\.(md|txt|markdown)$/i.test(file.name)) {
        importFile(file);
      }
    });
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const title = file.name.replace(/\.[^.]+$/, "");
      const editorData = markdownToBlocks(ev.target.result);
      const meta = FolioStore.createDocument(title, editorData, null);
      renderPageTree();
      window.location.hash = `#/doc/${meta.id}/edit`;
    };
    reader.readAsText(file);
  }

  // ==========================================================================
  // SIDEBAR COLLAPSE
  // ==========================================================================

  function initCollapse() {
    const collapseBtn = document.getElementById("sidebar-collapse");
    const toggleBtn = document.getElementById("sidebar-toggle");
    const mainContent = document.getElementById("main-content");

    collapseBtn.addEventListener("click", () => {
      sidebar.classList.add("collapsed");
      mainContent.classList.add("expanded");
      toggleBtn.classList.add("visible");
      const settings = FolioStore.getSettings();
      settings.sidebarCollapsed = true;
      FolioStore.saveSettings(settings);
    });

    toggleBtn.addEventListener("click", () => {
      sidebar.classList.remove("collapsed");
      mainContent.classList.remove("expanded");
      toggleBtn.classList.remove("visible");
      const settings = FolioStore.getSettings();
      settings.sidebarCollapsed = false;
      FolioStore.saveSettings(settings);

      // On mobile, also handle the mobile-open class
      if (window.innerWidth <= 768) {
        sidebar.classList.add("mobile-open");
      }
    });

    // Restore sidebar state
    const settings = FolioStore.getSettings();
    if (settings.sidebarCollapsed) {
      sidebar.classList.add("collapsed");
      mainContent.classList.add("expanded");
      toggleBtn.classList.add("visible");
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Set the active document in the sidebar (highlight it)
  function setActiveDoc(docId) {
    activeDocId = docId;

    // Auto-expand parents so the active doc is visible
    if (docId) {
      const docs = FolioStore.listDocuments();
      let current = docs.find((d) => d.id === docId);
      while (current && current.parentId) {
        expandedNodes.add(current.parentId);
        current = docs.find((d) => d.id === current.parentId);
      }
    }

    renderPageTree();
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  function init() {
    initSearch();
    initImport();
    initCollapse();

    // New page button
    document.getElementById("new-page-btn").addEventListener("click", createNewPage);

    // Import button in footer
    document.getElementById("import-btn").addEventListener("click", () => {
      fileInput.click();
    });

    // Initial render
    renderPageTree();
  }

  return {
    init,
    renderPageTree,
    setActiveDoc,
    createNewPage,
    createSubpage,
    exportDocument,
    markdownToBlocks,
    // Used by the annotation export to render a document block by block.
    blockToMarkdown,
  };
})();

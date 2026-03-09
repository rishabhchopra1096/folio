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
    return blocks.map((block) => {
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
    }).join("\n\n");
  }

  function stripHtml(str) {
    return str.replace(/<[^>]*>/g, "");
  }

  // ==========================================================================
  // MARKDOWN IMPORT — Convert markdown text to Editor.js blocks
  // ==========================================================================

  function markdownToBlocks(md) {
    const blocks = [];
    const lines = md.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Skip empty lines
      if (!line.trim()) { i++; continue; }

      // Headers
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        blocks.push({
          type: "header",
          data: { text: headerMatch[2], level: headerMatch[1].length },
        });
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
        blocks.push({ type: "delimiter", data: {} });
        i++;
        continue;
      }

      // Code block
      if (line.trim().startsWith("```")) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        blocks.push({ type: "code", data: { code: codeLines.join("\n") } });
        i++; // skip closing ```
        continue;
      }

      // Checklist
      const checkMatch = line.match(/^-\s+\[([ x])\]\s+(.+)$/);
      if (checkMatch) {
        const items = [];
        while (i < lines.length) {
          const cm = lines[i].match(/^-\s+\[([ x])\]\s+(.+)$/);
          if (!cm) break;
          items.push({ text: cm[2], checked: cm[1] === "x" });
          i++;
        }
        blocks.push({ type: "checklist", data: { items } });
        continue;
      }

      // Unordered list
      if (/^[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^[-*+]\s+/, ""));
          i++;
        }
        blocks.push({ type: "list", data: { style: "unordered", items } });
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\d+\.\s+/, ""));
          i++;
        }
        blocks.push({ type: "list", data: { style: "ordered", items } });
        continue;
      }

      // Blockquote
      if (line.startsWith("> ")) {
        const quoteLines = [];
        while (i < lines.length && lines[i].startsWith("> ")) {
          quoteLines.push(lines[i].replace(/^>\s*/, ""));
          i++;
        }
        blocks.push({ type: "quote", data: { text: quoteLines.join(" ") } });
        continue;
      }

      // Default: paragraph
      blocks.push({ type: "paragraph", data: { text: line } });
      i++;
    }

    return { time: Date.now(), blocks };
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
  };
})();

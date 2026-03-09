/*
 * =============================================================================
 * APP.JS — Application Shell, Router, and Global Coordination
 * =============================================================================
 * FILE OVERVIEW:
 * This is the main entry point for Folio. It handles:
 * 1. Hash-based routing (switching between Welcome, Editor, and Reader views)
 * 2. Initializing all modules (sidebar, editor, reader, settings, etc.)
 * 3. Global keyboard shortcuts (Ctrl+E, Ctrl+N, Ctrl+K for search)
 * 4. Coordinating state between the sidebar and the main content area
 *
 * THE ROUTES:
 * - #/ or empty     -> Welcome view (when no doc is selected)
 * - #/doc/{id}      -> Reader view (beautiful reading experience)
 * - #/doc/{id}/edit -> Editor view (Editor.js block editing)
 * =============================================================================
 */

const App = (function () {

  // The three view containers
  const viewWelcome = document.getElementById("view-welcome");
  const viewEditor = document.getElementById("view-editor");
  const viewReader = document.getElementById("view-reader");
  const topbar = document.getElementById("topbar");

  const allViews = [viewWelcome, viewEditor, viewReader];

  // Track the current mode for the mode toggle button
  let currentMode = null; // 'edit' or 'read'
  let currentDocId = null;

  // ==========================================================================
  // VIEW SWITCHING — Show one view, hide the others
  // ==========================================================================

  function showView(viewElement) {
    allViews.forEach((v) => v.classList.remove("active"));
    viewElement.classList.add("active");
  }

  // ==========================================================================
  // ROUTER — Parse the URL hash and switch to the right view
  // ==========================================================================

  function route() {
    const hash = window.location.hash || "#/";

    // Clean up previous view state
    Reader.hide();
    Highlights.hideToolbar();
    Highlights.hidePopover();
    Comments.closePanel();

    // Match: #/doc/{id}/edit
    const editMatch = hash.match(/^#\/doc\/([^/]+)\/edit$/);
    if (editMatch) {
      const docId = editMatch[1];
      const doc = FolioStore.getDocument(docId);
      if (!doc) { window.location.hash = "#/"; return; }

      currentMode = "edit";
      currentDocId = docId;
      showView(viewEditor);
      topbar.style.display = "";
      Editor.openEditor(docId);
      SidebarUI.setActiveDoc(docId);
      updateBreadcrumb(doc.meta);
      updateModeToggle("edit");
      document.getElementById("save-indicator").style.display = "";
      document.getElementById("progress-bar-wrap").style.display = "none";
      window.scrollTo(0, 0);
      return;
    }

    // Match: #/doc/{id}
    const docMatch = hash.match(/^#\/doc\/([^/]+)$/);
    if (docMatch) {
      const docId = docMatch[1];
      const doc = FolioStore.getDocument(docId);
      if (!doc) { window.location.hash = "#/"; return; }

      currentMode = "read";
      currentDocId = docId;

      // Must hide editor before showing reader (cleanup Editor.js)
      Editor.hide();

      showView(viewReader);
      topbar.style.display = "";
      Reader.renderDocument(docId);
      SidebarUI.setActiveDoc(docId);
      updateBreadcrumb(doc.meta);
      updateModeToggle("read");
      document.getElementById("save-indicator").style.display = "none";
      window.scrollTo(0, 0);
      return;
    }

    // Default: Welcome / Home
    currentMode = null;
    currentDocId = null;
    Editor.hide();
    showView(viewWelcome);
    topbar.style.display = "none";
    SidebarUI.setActiveDoc(null);
  }

  // ==========================================================================
  // BREADCRUMB — Show the page hierarchy in the topbar
  // ==========================================================================

  function updateBreadcrumb(meta) {
    const breadcrumb = document.getElementById("breadcrumb");
    breadcrumb.innerHTML = "";

    // Build the ancestor chain
    const chain = [];
    let current = meta;
    const allDocs = FolioStore.listDocuments();

    while (current) {
      chain.unshift(current);
      if (current.parentId) {
        current = allDocs.find((d) => d.id === current.parentId);
      } else {
        break;
      }
    }

    chain.forEach((doc, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-sep";
        sep.textContent = "/";
        breadcrumb.appendChild(sep);
      }

      if (i < chain.length - 1) {
        // Ancestor link
        const link = document.createElement("span");
        link.className = "breadcrumb-item";
        link.textContent = (doc.icon ? doc.icon + " " : "") + doc.title;
        link.addEventListener("click", () => {
          window.location.hash = `#/doc/${doc.id}`;
        });
        breadcrumb.appendChild(link);
      } else {
        // Current page (not clickable)
        const span = document.createElement("span");
        span.className = "breadcrumb-current";
        span.textContent = (doc.icon ? doc.icon + " " : "") + doc.title;
        breadcrumb.appendChild(span);
      }
    });
  }

  // ==========================================================================
  // MODE TOGGLE — Switch between edit and read mode
  // ==========================================================================

  function updateModeToggle(mode) {
    const icon = document.getElementById("mode-toggle-icon");
    if (mode === "edit") {
      // Show eye icon (switch to read mode)
      icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      document.getElementById("mode-toggle").title = "Read mode (Ctrl+E)";
    } else {
      // Show pencil icon (switch to edit mode)
      icon.innerHTML = '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>';
      document.getElementById("mode-toggle").title = "Edit mode (Ctrl+E)";
    }
  }

  function toggleMode() {
    if (!currentDocId) return;

    if (currentMode === "edit") {
      window.location.hash = `#/doc/${currentDocId}`;
    } else if (currentMode === "read") {
      window.location.hash = `#/doc/${currentDocId}/edit`;
    }
  }

  // ==========================================================================
  // KEYBOARD SHORTCUTS
  // ==========================================================================

  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      const isMod = e.ctrlKey || e.metaKey;

      // Escape: close settings, popover, etc.
      if (e.key === "Escape") {
        document.getElementById("settings-panel").classList.remove("open");
        Comments.closePanel();
        Highlights.hidePopover();
      }

      // Ctrl+E: toggle edit/read mode
      if (isMod && e.key === "e") {
        e.preventDefault();
        toggleMode();
      }

      // Ctrl+N: new page
      if (isMod && e.key === "n") {
        e.preventDefault();
        SidebarUI.createNewPage();
      }

      // Ctrl+K: focus search
      if (isMod && e.key === "k") {
        e.preventDefault();
        document.getElementById("sidebar-search-input").focus();
      }
    });
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  function init() {
    // Initialize all modules
    Settings.init();
    SidebarUI.init();
    Highlights.init();
    Comments.init();

    // Set up routing
    window.addEventListener("hashchange", route);

    // Mode toggle button
    document.getElementById("mode-toggle").addEventListener("click", toggleMode);

    // Comments button
    document.getElementById("comments-btn").addEventListener("click", () => {
      Comments.openPanel();
    });

    // Settings button in topbar
    document.getElementById("settings-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("settings-panel").classList.toggle("open");
    });

    // Settings toggle in sidebar footer
    document.getElementById("settings-toggle-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("settings-panel").classList.toggle("open");
    });

    // Close settings when clicking outside
    document.addEventListener("click", (e) => {
      const panel = document.getElementById("settings-panel");
      if (!panel.contains(e.target)) {
        panel.classList.remove("open");
      }
    });

    // Welcome screen new page button
    document.getElementById("welcome-new-btn").addEventListener("click", () => {
      SidebarUI.createNewPage();
    });

    // Dropzone on welcome screen
    const dropzone = document.getElementById("dropzone");
    if (dropzone) {
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("drag-over");
      });
      dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("drag-over");
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const title = file.name.replace(/\.[^.]+$/, "");
            const editorData = SidebarUI.markdownToBlocks(ev.target.result);
            const meta = FolioStore.createDocument(title, editorData, null);
            SidebarUI.renderPageTree();
            window.location.hash = `#/doc/${meta.id}/edit`;
          };
          reader.readAsText(file);
        }
      });
    }

    // Initialize shortcuts
    initShortcuts();

    // Initial route
    route();
  }

  return {
    init,
    route,
    toggleMode,
  };
})();

// Start the app when DOM is ready
document.addEventListener("DOMContentLoaded", App.init);

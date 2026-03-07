/*
 * =============================================================================
 * APP.JS — Application Shell, Router, and Keyboard Shortcuts
 * =============================================================================
 * FILE OVERVIEW:
 * This is the main entry point for the Folio app. It handles:
 * 1. Hash-based routing (switching between Home, Reader, and Editor views)
 * 2. Initializing all modules (store, settings, sidebar, highlights, comments)
 * 3. Global keyboard shortcuts
 * 4. Backup/restore functionality
 *
 * THE ROUTES:
 * - #/ or #/home   -> Home view (document grid)
 * - #/doc/{id}     -> Reader view (renders and reads a document)
 * - #/doc/{id}/edit -> Editor view (edit a document's markdown)
 * =============================================================================
 */

const App = (function () {

  // The three view containers in the DOM
  const viewHome = document.getElementById("view-home");
  const viewReader = document.getElementById("view-reader");
  const viewEditor = document.getElementById("view-editor");

  // All views in an array for easy iteration
  const allViews = [viewHome, viewReader, viewEditor];

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

    // Hide all transient UI elements
    Reader.hide();
    Editor.hide();
    Highlights.hideToolbar();
    Highlights.hidePopover();
    Comments.closePanel();
    document.getElementById("progress-ring-wrap").classList.remove("visible");
    document.getElementById("close-btn").classList.remove("visible");

    // Hide reader-only topbar elements when not in reader
    document.getElementById("progress-bar-wrap").style.display = "none";
    document.getElementById("progress-label").style.display = "none";

    // Show/hide edit and comments buttons
    document.getElementById("edit-btn").style.display = "none";
    document.getElementById("comments-btn").style.display = "none";
    document.getElementById("preview-btn").style.display = "none";
    document.getElementById("save-indicator").style.display = "none";

    // Match: #/doc/{id}/edit
    const editMatch = hash.match(/^#\/doc\/([^/]+)\/edit$/);
    if (editMatch) {
      const docId = editMatch[1];
      showView(viewEditor);
      Editor.openEditor(docId);

      // Show preview button and save indicator
      document.getElementById("preview-btn").style.display = "";
      document.getElementById("save-indicator").style.display = "";
      window.scrollTo(0, 0);
      return;
    }

    // Match: #/doc/{id}
    const docMatch = hash.match(/^#\/doc\/([^/]+)$/);
    if (docMatch) {
      const docId = docMatch[1];
      showView(viewReader);
      Reader.renderDocument(docId);

      // Show reader-specific topbar elements
      document.getElementById("progress-bar-wrap").style.display = "";
      document.getElementById("progress-label").style.display = "";
      document.getElementById("edit-btn").style.display = "";
      document.getElementById("comments-btn").style.display = "";
      window.scrollTo(0, 0);
      return;
    }

    // Default: Home view
    showView(viewHome);
    Sidebar.renderDocList();
    window.scrollTo(0, 0);
  }

  // ==========================================================================
  // KEYBOARD SHORTCUTS
  // ==========================================================================

  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      const isMod = e.ctrlKey || e.metaKey;

      // Escape: close settings panel
      if (e.key === "Escape") {
        document.getElementById("settings-panel").classList.remove("open");
      }

      // Ctrl+E: toggle between edit and read mode
      if (isMod && e.key === "e") {
        e.preventDefault();
        const hash = window.location.hash || "#/";

        const editMatch = hash.match(/^#\/doc\/([^/]+)\/edit$/);
        if (editMatch) {
          // Switch to reader
          window.location.hash = `#/doc/${editMatch[1]}`;
          return;
        }

        const docMatch = hash.match(/^#\/doc\/([^/]+)$/);
        if (docMatch) {
          // Switch to editor
          window.location.hash = `#/doc/${docMatch[1]}/edit`;
          return;
        }
      }

      // Ctrl+N: new document
      if (isMod && e.key === "n") {
        e.preventDefault();
        createNewDocument();
      }
    });
  }

  // ==========================================================================
  // DOCUMENT CREATION
  // ==========================================================================

  function createNewDocument() {
    const meta = FolioStore.createDocument("Untitled", "");
    window.location.hash = `#/doc/${meta.id}/edit`;
  }

  // ==========================================================================
  // BACKUP / RESTORE
  // ==========================================================================

  function exportAllData() {
    const data = FolioStore.exportAll();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `folio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importAllData(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        FolioStore.importAll(data);
        // Re-route to refresh the view
        window.location.hash = "#/";
        route();
      } catch {
        alert("Invalid backup file.");
      }
    };
    reader.readAsText(file);
  }

  // ==========================================================================
  // INITIALIZATION — Wire everything up when the app loads
  // ==========================================================================

  function init() {
    // Initialize all modules
    Settings.init();
    Sidebar.init();
    Highlights.init();
    Comments.init();

    // Set up routing
    window.addEventListener("hashchange", route);

    // Wire up navigation buttons
    document.getElementById("logo").addEventListener("click", () => {
      window.location.hash = "#/";
    });
    document.getElementById("close-btn").addEventListener("click", () => {
      window.location.hash = "#/";
    });

    // New document button on home page
    document.getElementById("new-doc-btn").addEventListener("click", () => {
      createNewDocument();
    });

    // Edit button in reader topbar
    document.getElementById("edit-btn").addEventListener("click", () => {
      const docId = Reader.getCurrentDocId();
      if (docId) window.location.hash = `#/doc/${docId}/edit`;
    });

    // Preview button in editor topbar
    document.getElementById("preview-btn").addEventListener("click", () => {
      const docId = Editor.getCurrentDocId();
      if (docId) window.location.hash = `#/doc/${docId}`;
    });

    // Comments button in reader topbar
    document.getElementById("comments-btn").addEventListener("click", () => {
      Comments.openPanel();
    });

    // Initialize keyboard shortcuts
    initShortcuts();

    // Perform initial routing
    route();
  }

  return {
    init,
    createNewDocument,
    exportAllData,
    importAllData,
  };
})();

// Start the app when the DOM is ready
document.addEventListener("DOMContentLoaded", App.init);

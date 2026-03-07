/*
 * =============================================================================
 * SIDEBAR.JS — Home View: Document List, Create, Rename, Delete
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages the home screen of Folio — the document grid where users
 * can see all their documents, create new ones, import files, and manage
 * existing documents (rename, delete, export).
 *
 * HOW IT WORKS:
 * 1. renderDocList() reads all documents from FolioStore and builds card elements
 * 2. Each card shows the title, a 2-line preview, word count, and last edited date
 * 3. The three-dot menu on each card provides rename, export, and delete options
 * 4. Drag-and-drop + file picker let users import .md/.txt files as new documents
 * =============================================================================
 */

const Sidebar = (function () {

  // Cache the grid container and import elements
  const docGrid = document.getElementById("doc-grid");
  const fileInput = document.getElementById("file-input");
  const dropzone = document.getElementById("dropzone");

  // Currently open context menu (so we can close it when opening another)
  let activeContextMenu = null;

  // Render the full document list in the home view
  function renderDocList() {
    const docs = FolioStore.listDocuments();
    docGrid.innerHTML = "";

    // If no documents, show the empty state with the dropzone
    if (docs.length === 0) {
      dropzone.style.display = "";
      return;
    }

    // Hide the dropzone since we have documents (it's still at the bottom)
    dropzone.style.display = "";

    docs.forEach((doc) => {
      const card = document.createElement("div");
      card.className = "doc-card";
      card.dataset.id = doc.id;

      // Get a plain-text preview by loading a snippet of the content
      const content = localStorage.getItem(`folio_doc_${doc.id}`) || "";
      // Strip markdown syntax for preview
      const preview = content
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[*_`~\[\]]/g, "")
        .replace(/\n+/g, " ")
        .trim()
        .slice(0, 120);

      // Format the date nicely
      const updated = new Date(doc.updatedAt);
      const dateStr = updated.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year:
          updated.getFullYear() !== new Date().getFullYear()
            ? "numeric"
            : undefined,
      });

      card.innerHTML = `
        <div class="doc-card-title">${escapeHtml(doc.title)}</div>
        <div class="doc-card-preview">${escapeHtml(preview) || "Empty document"}</div>
        <div class="doc-card-meta">
          <span>${doc.wordCount.toLocaleString()} words</span>
          <span>${dateStr}</span>
        </div>
        <button class="doc-card-menu" title="Options">&hellip;</button>
      `;

      // Click the card to open in reader
      card.addEventListener("click", (e) => {
        // Don't navigate if clicking the menu button
        if (e.target.closest(".doc-card-menu")) return;
        window.location.hash = `#/doc/${doc.id}`;
      });

      // Three-dot menu
      card.querySelector(".doc-card-menu").addEventListener("click", (e) => {
        e.stopPropagation();
        showContextMenu(e, doc);
      });

      docGrid.appendChild(card);
    });
  }

  // Show a context menu near the clicked position
  function showContextMenu(event, doc) {
    closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "context-menu";

    // Position near the click
    menu.style.left = event.clientX + "px";
    menu.style.top = event.clientY + "px";

    // Rename button
    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => {
      closeContextMenu();
      showRenameModal(doc);
    });

    // Edit button
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      closeContextMenu();
      window.location.hash = `#/doc/${doc.id}/edit`;
    });

    // Export as .md
    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Export .md";
    exportBtn.addEventListener("click", () => {
      closeContextMenu();
      exportDocument(doc.id);
    });

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      closeContextMenu();
      showDeleteModal(doc);
    });

    menu.appendChild(editBtn);
    menu.appendChild(renameBtn);
    menu.appendChild(exportBtn);
    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);
    activeContextMenu = menu;

    // Adjust position if it goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (event.clientX - rect.width) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (event.clientY - rect.height) + "px";
    }

    // Close when clicking outside
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

  // Show a rename modal dialog
  function showRenameModal(doc) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>Rename Document</h3>
        <input class="rename-input" type="text" value="${escapeHtml(doc.title)}" />
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
          <button class="modal-btn primary save-btn">Save</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector(".rename-input");
    overlay.querySelector(".cancel-btn").addEventListener("click", () => {
      overlay.remove();
    });
    overlay.querySelector(".save-btn").addEventListener("click", () => {
      const newTitle = input.value.trim();
      if (newTitle) {
        FolioStore.updateDocument(doc.id, { title: newTitle });
        renderDocList();
      }
      overlay.remove();
    });
    // Save on Enter
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        overlay.querySelector(".save-btn").click();
      }
      if (e.key === "Escape") {
        overlay.remove();
      }
    });
    // Close on overlay click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    input.select();
  }

  // Show a delete confirmation modal
  function showDeleteModal(doc) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>Delete Document</h3>
        <p>Are you sure you want to delete "<strong>${escapeHtml(doc.title)}</strong>"? This cannot be undone.</p>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
          <button class="modal-btn danger delete-btn">Delete</button>
        </div>
      </div>
    `;

    overlay.querySelector(".cancel-btn").addEventListener("click", () => {
      overlay.remove();
    });
    overlay.querySelector(".delete-btn").addEventListener("click", () => {
      FolioStore.deleteDocument(doc.id);
      renderDocList();
      overlay.remove();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  // Export a document as a downloadable .md file
  function exportDocument(docId) {
    const doc = FolioStore.getDocument(docId);
    if (!doc) return;

    const blob = new Blob([doc.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (doc.meta.title || "document") + ".md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Set up drag-and-drop and file import
  function initImport() {
    // File input change handler
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importFile(file);
      fileInput.value = "";
    });

    // Drag-and-drop on the dropzone
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
      if (file) importFile(file);
    });

    // Paste support (only on home view)
    document.addEventListener("paste", (e) => {
      // Only handle paste when on the home view
      const homeView = document.getElementById("view-home");
      if (!homeView.classList.contains("active")) return;

      const text = e.clipboardData.getData("text/plain");
      if (text && text.length > 30) {
        const meta = FolioStore.createDocument("Pasted Document", text);
        renderDocList();
        window.location.hash = `#/doc/${meta.id}`;
      }
    });
  }

  // Read a file and create a new document from it
  function importFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const title = file.name.replace(/\.[^.]+$/, "");
      const meta = FolioStore.createDocument(title, ev.target.result);
      renderDocList();
      window.location.hash = `#/doc/${meta.id}`;
    };
    reader.readAsText(file);
  }

  // Escape HTML to prevent XSS when displaying user-provided text
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Initialize the import handlers
  function init() {
    initImport();
  }

  return {
    init,
    renderDocList,
    exportDocument,
  };
})();

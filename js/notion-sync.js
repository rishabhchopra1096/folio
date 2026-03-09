/*
 * =============================================================================
 * NOTION-SYNC.JS — Two-Way Notion Sync Engine for Folio Desktop
 * =============================================================================
 * FILE OVERVIEW:
 * This file handles syncing Notion pages with the Folio desktop app. It lets
 * users connect their Notion account, pick which pages to sync, and then
 * keeps those pages in sync — edits in Folio push to Notion, edits in Notion
 * pull into Folio.
 *
 * HOW IT WORKS:
 * 1. User enters their Notion integration token in settings
 * 2. "Add from Notion" shows a searchable list of shared pages
 * 3. Selected pages are pulled (as markdown) and converted to Editor.js blocks
 * 4. On edit in Folio: blocks → markdown → push to Notion
 * 5. On panel show / every 2 min: check Notion for newer versions → pull
 * 6. Conflict resolution: last-write-wins (Notion = source of truth)
 *
 * IMPORTANT ARCHITECTURE NOTE:
 * Notion API calls can't be made from the browser (CORS). They go through
 * Electron's main process via the `window.folio` bridge (see preload.js).
 * This module only works in Electron — it silently does nothing on the web.
 *
 * DATA STORED IN LOCALSTORAGE:
 * - folio_notion_token: The integration token (plain text for now)
 * - folio_notion_pages: Array of { notionPageId, folioDocId, lastSyncedAt,
 *   lastNotionEditedAt, title }
 * =============================================================================
 */

const NotionSync = (function () {

  // ==========================================================================
  // GUARDS — Only run in Electron
  // ==========================================================================

  /*
   * This entire module is a no-op when running in a regular browser (the web
   * version on Vercel). We check for the Electron bridge object that preload.js
   * exposes on `window.folio`.
   */
  const isElectron = typeof window.folio !== "undefined" && window.folio.isElectron;

  // If we're not in Electron, return a stub that does nothing
  if (!isElectron) {
    return {
      init: function () {},
      syncOnShow: function () {},
      pushAfterSave: function () {},
      isNotionDoc: function () { return false; },
    };
  }

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  // localStorage keys for Notion sync data
  const TOKEN_KEY = "folio_notion_token";
  const PAGES_KEY = "folio_notion_pages";

  // How often to check Notion for changes (in milliseconds)
  // 2 minutes = 120,000ms
  const POLL_INTERVAL = 120000;

  // Timer reference for background polling
  let pollTimer = null;

  // Whether a sync is currently in progress (prevent overlapping syncs)
  let isSyncing = false;

  // ==========================================================================
  // TOKEN MANAGEMENT — Store and retrieve the Notion integration token
  // ==========================================================================

  /*
   * The token is stored in localStorage. For a personal-use app, this is
   * acceptable. For a production multi-user app, you'd want encrypted storage
   * or OS keychain integration.
   */

  // Get the stored Notion token (or null if not set)
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  // Save the Notion token to localStorage
  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  // Remove the stored token (disconnect)
  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  // ==========================================================================
  // SYNCED PAGES REGISTRY — Track which pages are synced
  // ==========================================================================

  /*
   * We maintain a registry of synced pages in localStorage. Each entry maps
   * a Notion page ID to a Folio document ID, along with timestamps to detect
   * which version is newer.
   */

  // Get the array of synced page records
  function getSyncedPages() {
    try {
      return JSON.parse(localStorage.getItem(PAGES_KEY)) || [];
    } catch {
      return [];
    }
  }

  // Save the synced pages array
  function saveSyncedPages(pages) {
    localStorage.setItem(PAGES_KEY, JSON.stringify(pages));
  }

  // Find a synced page record by its Notion page ID
  function findSyncedPage(notionPageId) {
    return getSyncedPages().find((p) => p.notionPageId === notionPageId);
  }

  // Find a synced page record by its Folio document ID
  function findSyncedPageByFolioId(folioDocId) {
    return getSyncedPages().find((p) => p.folioDocId === folioDocId);
  }

  // Check if a Folio document is a synced Notion page
  function isNotionDoc(folioDocId) {
    return !!findSyncedPageByFolioId(folioDocId);
  }

  // ==========================================================================
  // PULL — Fetch a page from Notion and update the local Folio document
  // ==========================================================================

  /*
   * Pulling a page means:
   * 1. Call Notion's markdown endpoint to get the page content
   * 2. Convert the markdown to Editor.js blocks using our existing converter
   * 3. Update the Folio document with the new content
   * 4. Update the sync timestamp so we know this is the latest
   */

  async function pullPage(notionPageId) {
    const token = getToken();
    if (!token) return { error: true, message: "No token" };

    // Fetch the page content as markdown from Notion
    const result = await window.folio.notionFetchPage(token, notionPageId);
    if (result.error) return result;

    // The markdown content comes back in result.data.markdown
    const markdown = result.data.markdown || "";

    // Convert markdown to Editor.js blocks using the existing converter
    // (defined in sidebar.js and available globally as SidebarUI.markdownToBlocks)
    const editorData = SidebarUI.markdownToBlocks(markdown);

    return { error: false, editorData, markdown };
  }

  // ==========================================================================
  // PUSH — Send local changes to Notion
  // ==========================================================================

  /*
   * Pushing means converting the Editor.js blocks back to markdown and
   * sending it to Notion's markdown endpoint. This replaces the entire
   * page content in Notion.
   */

  async function pushPage(notionPageId, blocks) {
    const token = getToken();
    if (!token) return { error: true, message: "No token" };

    // Convert Editor.js blocks to markdown using the existing converter
    // (defined in sidebar.js — we access it through a helper since
    //  blocksToMarkdown is not exported, we'll need to use the export function)
    const markdown = blocksToMarkdownLocal(blocks);

    // Push the markdown to Notion
    const result = await window.folio.notionPushPage(token, notionPageId, markdown);
    return result;
  }

  /*
   * Local copy of blocks-to-markdown conversion. We replicate the logic from
   * sidebar.js's blocksToMarkdown since it's not exported publicly. This
   * converts Editor.js JSON blocks into standard markdown text.
   */
  function blocksToMarkdownLocal(blocks) {
    if (!blocks || !Array.isArray(blocks)) return "";

    return blocks.map((block) => {
      const d = block.data || {};
      switch (block.type) {
        case "header":
          // Convert header level to markdown heading (# for h1, ## for h2, etc.)
          return "#".repeat(d.level || 2) + " " + stripHtml(d.text || "");

        case "paragraph":
          // Paragraphs are just plain text (strip any HTML formatting)
          return stripHtml(d.text || "");

        case "list": {
          // Lists can be ordered (1. 2. 3.) or unordered (- - -)
          return (d.items || []).map((item, i) => {
            const text = typeof item === "string" ? item : (item.content || item.text || "");
            return d.style === "ordered"
              ? `${i + 1}. ${stripHtml(text)}`
              : `- ${stripHtml(text)}`;
          }).join("\n");
        }

        case "checklist":
          // Checklists use GitHub-style task list syntax: - [x] or - [ ]
          return (d.items || []).map((item) => {
            return `- [${item.checked ? "x" : " "}] ${stripHtml(item.text || "")}`;
          }).join("\n");

        case "code":
          // Code blocks wrapped in triple backticks
          return "```\n" + (d.code || "") + "\n```";

        case "quote":
          // Blockquotes prefixed with >
          return "> " + stripHtml(d.text || "") +
            (d.caption ? `\n> — ${stripHtml(d.caption)}` : "");

        case "delimiter":
          // Horizontal rule
          return "---";

        case "table": {
          // Tables in markdown format with header row and separator
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

  // Helper to strip HTML tags from text
  function stripHtml(str) {
    return str.replace(/<[^>]*>/g, "");
  }

  // ==========================================================================
  // SYNC CYCLE — Check for changes and pull/push as needed
  // ==========================================================================

  /*
   * A sync cycle checks all synced pages for changes:
   * 1. For each synced page, get its metadata from Notion (last_edited_time)
   * 2. If Notion's version is newer than our last sync, pull the new content
   * 3. We don't push during a sync cycle — pushes happen immediately after saves
   */

  async function syncAll() {
    // Prevent overlapping sync cycles
    if (isSyncing) return;
    isSyncing = true;

    const token = getToken();
    if (!token) {
      isSyncing = false;
      return;
    }

    // Update the UI to show syncing status
    updateSyncStatus("syncing", "Syncing...");

    const syncedPages = getSyncedPages();
    let hasErrors = false;

    // Check each synced page for changes
    for (const page of syncedPages) {
      try {
        // Get the page's current metadata from Notion
        const metaResult = await window.folio.notionGetMeta(token, page.notionPageId);
        if (metaResult.error) {
          console.warn("Failed to get meta for", page.notionPageId, metaResult.message);
          hasErrors = true;
          continue;
        }

        // Compare Notion's last_edited_time with our last sync time
        const notionEditedAt = metaResult.data.last_edited_time;
        const lastSynced = page.lastSyncedAt;

        // If Notion's version is newer, pull the updated content
        if (!lastSynced || new Date(notionEditedAt) > new Date(lastSynced)) {
          const pullResult = await pullPage(page.notionPageId);
          if (pullResult.error) {
            console.warn("Failed to pull", page.notionPageId, pullResult.message);
            hasErrors = true;
            continue;
          }

          // Update the local Folio document with the new content
          FolioStore.updateDocument(page.folioDocId, {
            content: pullResult.editorData,
          });

          // Update the sync timestamp
          page.lastSyncedAt = new Date().toISOString();
          page.lastNotionEditedAt = notionEditedAt;

          // If the currently open editor is showing this page, refresh it
          if (typeof Editor !== "undefined" && Editor.getCurrentDocId() === page.folioDocId) {
            Editor.openEditor(page.folioDocId);
          }
        }
      } catch (err) {
        console.error("Sync error for page", page.notionPageId, err);
        hasErrors = true;
      }
    }

    // Save the updated sync timestamps
    saveSyncedPages(syncedPages);

    // Update the status indicator
    if (hasErrors) {
      updateSyncStatus("error", "Sync error");
    } else {
      updateSyncStatus("ok", "Synced " + new Date().toLocaleTimeString());
    }

    isSyncing = false;
  }

  // ==========================================================================
  // PUSH AFTER SAVE — Called when a synced page is saved in Folio
  // ==========================================================================

  /*
   * This is called by the editor's auto-save mechanism. After saving locally,
   * if the page is a synced Notion page, we push the changes to Notion.
   */

  async function pushAfterSave(folioDocId) {
    // Check if this is a synced page
    const syncRecord = findSyncedPageByFolioId(folioDocId);
    if (!syncRecord) return; // Not a synced page, nothing to do

    const token = getToken();
    if (!token) return;

    // Get the current document content
    const doc = FolioStore.getDocument(folioDocId);
    if (!doc || !doc.content || !doc.content.blocks) return;

    // Push to Notion
    updateSyncStatus("syncing", "Pushing to Notion...");
    const result = await pushPage(syncRecord.notionPageId, doc.content.blocks);

    if (result.error) {
      console.warn("Push failed:", result.message);
      updateSyncStatus("error", "Push failed");
    } else {
      // Update the sync timestamp
      const pages = getSyncedPages();
      const page = pages.find((p) => p.notionPageId === syncRecord.notionPageId);
      if (page) {
        page.lastSyncedAt = new Date().toISOString();
        saveSyncedPages(pages);
      }
      updateSyncStatus("ok", "Synced " + new Date().toLocaleTimeString());
    }
  }

  // ==========================================================================
  // SYNC ON PANEL SHOW — Triggered when the panel slides open
  // ==========================================================================

  /*
   * Every time the user opens the panel with Cmd+Shift+N, we do a quick
   * sync check. This ensures the content is always fresh when they look at it.
   */
  function syncOnShow() {
    const token = getToken();
    if (!token) return;

    const syncedPages = getSyncedPages();
    if (syncedPages.length === 0) return;

    // Run sync in the background (don't block the UI)
    syncAll();
  }

  // ==========================================================================
  // BACKGROUND POLLING — Check for changes every 2 minutes
  // ==========================================================================

  function startPolling() {
    // Don't start if already polling
    if (pollTimer) return;

    pollTimer = setInterval(() => {
      const token = getToken();
      if (!token) return;

      const syncedPages = getSyncedPages();
      if (syncedPages.length === 0) return;

      syncAll();
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ==========================================================================
  // UI — Sync status indicator
  // ==========================================================================

  function updateSyncStatus(status, text) {
    const statusEl = document.getElementById("sync-status");
    const dotEl = document.getElementById("sync-dot");
    const textEl = document.getElementById("sync-status-text");

    if (!statusEl) return;

    // Show the status indicator if we have a token
    statusEl.style.display = getToken() ? "flex" : "none";

    // Update the dot color based on sync state
    if (dotEl) {
      dotEl.className = "sync-dot";
      if (status === "syncing") dotEl.classList.add("syncing");
      if (status === "error") dotEl.classList.add("error");
    }

    // Update the status text
    if (textEl) textEl.textContent = text || "";
  }

  // ==========================================================================
  // NOTION SETTINGS UI — Token input, connect/disconnect, page picker
  // ==========================================================================

  /*
   * The Notion settings UI lives in a modal that opens when the user clicks
   * the "Notion" button in the sidebar footer. It has:
   * 1. A token input field
   * 2. A "Connect" / "Disconnect" button
   * 3. An "Add from Notion" button that opens the page picker
   * 4. A list of currently synced pages with "unsync" option
   */

  function showNotionSettings() {
    const token = getToken();
    const syncedPages = getSyncedPages();

    // Build the modal HTML
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" style="max-width: 360px; width: 90%;">
        <h3>Notion Sync</h3>
        <p style="margin-bottom: 16px; line-height: 1.5;">
          Connect your Notion account to sync pages into Folio.
          <br><small style="color: var(--ink-faint);">Create an integration at notion.so/my-integrations</small>
        </p>

        <!-- Token input -->
        <div style="margin-bottom: 12px;">
          <label style="display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--ink-faint); margin-bottom:4px;">Integration Token</label>
          <input type="password" class="notion-token-input" id="notion-token-field"
            placeholder="ntn_..." value="${token || ""}" />
        </div>

        <!-- Connect/Disconnect button -->
        <button class="notion-connect-btn ${token ? "disconnect" : ""}" id="notion-connect-action">
          ${token ? "Disconnect" : "Connect"}
        </button>

        <!-- Synced pages section (only visible when connected) -->
        <div id="notion-synced-section" style="margin-top: 16px; ${token ? "" : "display:none"}">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 8px;">
            <label style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--ink-faint);">Synced Pages</label>
            <button class="modal-btn primary" id="notion-add-pages" style="font-size: 11px; padding: 4px 12px;">
              + Add from Notion
            </button>
          </div>
          <div id="notion-synced-list" style="max-height: 200px; overflow-y: auto;">
            ${syncedPages.length === 0
              ? '<div style="color: var(--ink-faint); font-size: 12px; padding: 8px 0;">No pages synced yet.</div>'
              : syncedPages.map((p) => `
                <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--line);">
                  <span style="flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.title || "Untitled")}</span>
                  <button class="modal-btn" data-unsync="${p.notionPageId}" style="font-size:10px; padding:2px 8px;">Unsync</button>
                </div>
              `).join("")
            }
          </div>
        </div>

        <!-- Close button -->
        <div class="modal-actions" style="margin-top: 16px;">
          <button class="modal-btn" id="notion-settings-close">Close</button>
        </div>
      </div>
    `;

    // Wire up event handlers

    // Close modal
    const closeModal = () => overlay.remove();
    overlay.querySelector("#notion-settings-close").onclick = closeModal;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

    // Connect/Disconnect
    overlay.querySelector("#notion-connect-action").onclick = () => {
      const tokenField = overlay.querySelector("#notion-token-field");
      const currentToken = getToken();

      if (currentToken) {
        // Disconnect — clear token and stop syncing
        clearToken();
        stopPolling();
        updateSyncStatus("", "");
        closeModal();
        showNotionSettings(); // Reopen with fresh state
      } else {
        // Connect — save token
        const newToken = tokenField.value.trim();
        if (!newToken) {
          tokenField.style.borderColor = "#c0392b";
          return;
        }
        setToken(newToken);
        startPolling();
        updateSyncStatus("ok", "Connected");
        closeModal();
        showNotionSettings(); // Reopen with synced pages section visible
      }
    };

    // Add from Notion button
    const addBtn = overlay.querySelector("#notion-add-pages");
    if (addBtn) {
      addBtn.onclick = () => {
        closeModal();
        showPagePicker();
      };
    }

    // Unsync buttons
    overlay.querySelectorAll("[data-unsync]").forEach((btn) => {
      btn.onclick = () => {
        const notionPageId = btn.dataset.unsync;
        unsyncPage(notionPageId);
        closeModal();
        showNotionSettings(); // Reopen with updated list
      };
    });

    document.body.appendChild(overlay);
  }

  // ==========================================================================
  // PAGE PICKER — Browse and select Notion pages to sync
  // ==========================================================================

  /*
   * The page picker shows a searchable list of all Notion pages shared with
   * the integration. Users can toggle pages on/off. Selected pages get pulled
   * and added to Folio's page tree.
   */

  async function showPagePicker() {
    const token = getToken();
    if (!token) return;

    // Create the picker overlay
    const overlay = document.createElement("div");
    overlay.className = "notion-picker-overlay";
    overlay.innerHTML = `
      <div class="notion-picker">
        <div class="notion-picker-header">
          <h3>Add from Notion</h3>
          <button class="notion-picker-close">&times;</button>
        </div>
        <div class="notion-picker-search">
          <input type="text" placeholder="Search pages..." id="notion-picker-search" />
        </div>
        <div class="notion-picker-list" id="notion-picker-list">
          <div class="notion-picker-loading">Loading pages...</div>
        </div>
        <div class="notion-picker-footer">
          <button class="modal-btn" id="notion-picker-cancel">Cancel</button>
          <button class="modal-btn primary" id="notion-picker-done">Done</button>
        </div>
      </div>
    `;

    const closeModal = () => overlay.remove();
    overlay.querySelector(".notion-picker-close").onclick = closeModal;
    overlay.querySelector("#notion-picker-cancel").onclick = closeModal;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

    document.body.appendChild(overlay);

    // Fetch all pages from Notion
    const result = await window.folio.notionSearch(token, "");
    const listEl = overlay.querySelector("#notion-picker-list");

    if (result.error) {
      listEl.innerHTML = `<div class="notion-picker-empty">Error: ${escapeHtml(result.message)}</div>`;
      return;
    }

    // Filter to just pages (not databases)
    const pages = (result.data.results || []).filter((r) => r.object === "page");
    if (pages.length === 0) {
      listEl.innerHTML = '<div class="notion-picker-empty">No pages found. Make sure you\'ve shared pages with your integration.</div>';
      return;
    }

    // Track which pages are already synced
    const syncedPages = getSyncedPages();
    const syncedIds = new Set(syncedPages.map((p) => p.notionPageId));

    // Track selections in this picker session
    const selectedIds = new Set(syncedIds);

    // Render the page list
    function renderPages(filter) {
      listEl.innerHTML = "";

      const filtered = filter
        ? pages.filter((p) => getNotionPageTitle(p).toLowerCase().includes(filter.toLowerCase()))
        : pages;

      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="notion-picker-empty">No matching pages</div>';
        return;
      }

      filtered.forEach((page) => {
        const pageId = page.id;
        const title = getNotionPageTitle(page);
        const icon = getNotionPageIcon(page);
        const isSelected = selectedIds.has(pageId);

        const item = document.createElement("div");
        item.className = "notion-picker-item";
        item.innerHTML = `
          <span class="picker-icon">${icon}</span>
          <span class="picker-title">${escapeHtml(title)}</span>
          <span class="picker-check ${isSelected ? "checked" : ""}"></span>
        `;

        item.addEventListener("click", () => {
          if (selectedIds.has(pageId)) {
            selectedIds.delete(pageId);
          } else {
            selectedIds.add(pageId);
          }
          renderPages(filter);
        });

        listEl.appendChild(item);
      });
    }

    renderPages("");

    // Search filter
    overlay.querySelector("#notion-picker-search").addEventListener("input", (e) => {
      renderPages(e.target.value.trim());
    });

    // Done button — sync newly selected pages, unsync deselected ones
    overlay.querySelector("#notion-picker-done").onclick = async () => {
      // Find newly added pages (selected but not yet synced)
      const newlyAdded = [...selectedIds].filter((id) => !syncedIds.has(id));
      // Find removed pages (were synced but now deselected)
      const removed = [...syncedIds].filter((id) => !selectedIds.has(id));

      // Unsync removed pages
      removed.forEach((id) => unsyncPage(id));

      // Sync newly added pages
      for (const pageId of newlyAdded) {
        const page = pages.find((p) => p.id === pageId);
        if (page) {
          await addSyncedPage(page);
        }
      }

      // Refresh the sidebar to show new pages
      if (typeof SidebarUI !== "undefined") {
        SidebarUI.renderPageTree();
      }

      closeModal();
    };
  }

  // ==========================================================================
  // ADD/REMOVE SYNCED PAGES
  // ==========================================================================

  /*
   * Adding a synced page means:
   * 1. Pull the page content from Notion (as markdown → Editor.js blocks)
   * 2. Create a new Folio document with that content
   * 3. Add the sync record to our registry
   */

  async function addSyncedPage(notionPage) {
    const pageId = notionPage.id;
    const title = getNotionPageTitle(notionPage);

    // Pull the page content
    const pullResult = await pullPage(pageId);
    if (pullResult.error) {
      console.warn("Failed to pull page:", pageId, pullResult.message);
      return;
    }

    // Create a new Folio document with the pulled content
    const meta = FolioStore.createDocument(title, pullResult.editorData, null);

    // Add the icon from Notion if available
    const icon = getNotionPageIcon(notionPage);
    if (icon && icon !== "📄") {
      FolioStore.updateDocument(meta.id, { icon });
    }

    // Register this page in our sync registry
    const pages = getSyncedPages();
    pages.push({
      notionPageId: pageId,
      folioDocId: meta.id,
      title: title,
      lastSyncedAt: new Date().toISOString(),
      lastNotionEditedAt: notionPage.last_edited_time || null,
    });
    saveSyncedPages(pages);
  }

  /*
   * Unsyncing a page removes it from the sync registry but KEEPS the local
   * Folio document. The page becomes a regular local-only Folio page.
   */
  function unsyncPage(notionPageId) {
    const pages = getSyncedPages();
    const updated = pages.filter((p) => p.notionPageId !== notionPageId);
    saveSyncedPages(updated);
  }

  // ==========================================================================
  // NOTION PAGE HELPERS — Extract title and icon from Notion API response
  // ==========================================================================

  /*
   * Notion pages have their title buried in a "properties" object. The exact
   * location depends on whether it's a database page or a standalone page.
   * These helpers dig it out.
   */

  function getNotionPageTitle(page) {
    // Try the "title" property first (most common)
    const props = page.properties || {};

    for (const key of Object.keys(props)) {
      const prop = props[key];
      if (prop.type === "title" && prop.title && prop.title.length > 0) {
        return prop.title.map((t) => t.plain_text).join("");
      }
    }

    // Fallback: check for Name property
    if (props.Name && props.Name.title) {
      return props.Name.title.map((t) => t.plain_text).join("");
    }

    return "Untitled";
  }

  function getNotionPageIcon(page) {
    if (!page.icon) return "📄";

    if (page.icon.type === "emoji") {
      return page.icon.emoji;
    }

    // External or file icons — just use a default
    return "📄";
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
  // INITIALIZATION — Wire up UI elements and start sync
  // ==========================================================================

  function init() {
    // Wire up the "Notion" button in the sidebar footer
    const notionBtn = document.getElementById("notion-btn");
    if (notionBtn) {
      notionBtn.addEventListener("click", () => {
        showNotionSettings();
      });
    }

    // If we have a token, show sync status and start polling
    if (getToken()) {
      updateSyncStatus("ok", "Connected");
      startPolling();
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  return {
    init,
    syncOnShow,
    pushAfterSave,
    isNotionDoc,
    showNotionSettings,
  };
})();

/*
 * Auto-initialize NotionSync when the DOM is ready. This runs after all
 * other modules (store, editor, sidebar) are loaded because this script
 * tag comes last in index-electron.html.
 */
document.addEventListener("DOMContentLoaded", () => {
  // Small delay to ensure all other modules are initialized first
  setTimeout(() => {
    NotionSync.init();
  }, 100);
});

/*
 * Hook into the editor's auto-save to push changes to Notion.
 * We override Editor.debouncedSave to add a push step after the normal save.
 * This is done via a wrapper so we don't modify editor.js directly.
 */
(function () {
  if (typeof window.folio === "undefined") return;

  // Wait for Editor module to be available, then wrap its save
  const origInterval = setInterval(() => {
    if (typeof Editor !== "undefined" && Editor.debouncedSave) {
      const originalSave = Editor.debouncedSave;

      // We can't easily wrap debouncedSave since it triggers internally.
      // Instead, we'll observe document changes by checking after saves.
      // A simpler approach: poll the save indicator and push when it says "Saved"
      const observer = new MutationObserver(() => {
        const indicator = document.getElementById("save-indicator");
        if (indicator && indicator.textContent === "Saved") {
          const docId = Editor.getCurrentDocId();
          if (docId && NotionSync.isNotionDoc(docId)) {
            NotionSync.pushAfterSave(docId);
          }
        }
      });

      const indicator = document.getElementById("save-indicator");
      if (indicator) {
        observer.observe(indicator, { childList: true, characterData: true, subtree: true });
      }

      clearInterval(origInterval);
    }
  }, 500);
})();

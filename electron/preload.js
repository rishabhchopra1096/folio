/*
 * =============================================================================
 * PRELOAD.JS — Context Bridge for Folio Desktop
 * =============================================================================
 * Exposes a safe API from Electron's main process to the renderer via
 * contextBridge. This includes panel controls and Notion API proxy.
 * =============================================================================
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("folio", {
  // ── Panel Controls ──

  // Request the main process to expand the panel (edge tab click)
  expandPanel: () => {
    ipcRenderer.send("expand-panel");
  },

  // Request the main process to collapse the panel
  collapsePanel: () => {
    ipcRenderer.send("collapse-panel");
  },

  // Listen for panel expand event
  onPanelExpand: (callback) => {
    ipcRenderer.on("panel-expand", () => callback());
  },

  // Listen for panel collapse event
  onPanelCollapse: (callback) => {
    ipcRenderer.on("panel-collapse", () => callback());
  },

  // Listen for new page request from tray menu
  onNewPage: (callback) => {
    ipcRenderer.on("new-page", () => callback());
  },

  /*
   * Text selected in some OTHER application, captured when the read-aloud
   * shortcut was pressed. Arrives as { text, app, method } on success, or
   * { error, needsPermission } when nothing could be read — the renderer shows
   * either, because a keypress that produces silence reads as a broken app.
   */
  onReadSelection: (callback) => {
    ipcRenderer.on("read-selection", (_event, payload) => callback(payload));
  },

  // ── Notion API (proxied through main process to avoid CORS) ──

  notionSearch: (token, query) => {
    return ipcRenderer.invoke("notion:search", token, query);
  },

  notionFetchPage: (token, pageId) => {
    return ipcRenderer.invoke("notion:fetch-page", token, pageId);
  },

  notionPushPage: (token, pageId, markdown) => {
    return ipcRenderer.invoke("notion:push-page", token, pageId, markdown);
  },

  notionGetMeta: (token, pageId) => {
    return ipcRenderer.invoke("notion:get-meta", token, pageId);
  },

  // ── Platform Info ──
  platform: process.platform,
  isElectron: true,
});

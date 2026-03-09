/*
 * =============================================================================
 * PRELOAD.JS — Context Bridge for Folio Desktop
 * =============================================================================
 * FILE OVERVIEW:
 * This preload script runs in the renderer process but with access to Node.js
 * APIs. It exposes a safe, minimal API to the renderer via contextBridge.
 *
 * WHAT IT EXPOSES:
 * - Panel events: onPanelShow, onPanelHide, onNewPage, hidePanel
 * - Notion API: search, fetchPage, pushPage, getPageMeta
 * - Platform info: platform string for OS detection
 * =============================================================================
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("folio", {
  // ==========================================================================
  // PANEL CONTROLS — Show/hide animation triggers
  // ==========================================================================

  // Listen for panel show event from main process
  onPanelShow: (callback) => {
    ipcRenderer.on("panel-show", () => callback());
  },

  // Listen for panel hide event from main process
  onPanelHide: (callback) => {
    ipcRenderer.on("panel-hide", () => callback());
  },

  // Listen for new page request from tray menu
  onNewPage: (callback) => {
    ipcRenderer.on("new-page", () => callback());
  },

  // Request the main process to hide the panel
  hidePanel: () => {
    ipcRenderer.send("hide-panel");
  },

  // ==========================================================================
  // NOTION API — Proxied through main process to avoid CORS
  // ==========================================================================

  // Search Notion pages shared with the integration
  notionSearch: (token, query) => {
    return ipcRenderer.invoke("notion:search", token, query);
  },

  // Fetch a page's content as markdown
  notionFetchPage: (token, pageId) => {
    return ipcRenderer.invoke("notion:fetch-page", token, pageId);
  },

  // Push markdown content to a Notion page
  notionPushPage: (token, pageId, markdown) => {
    return ipcRenderer.invoke("notion:push-page", token, pageId, markdown);
  },

  // Get page metadata (title, last_edited_time, etc.)
  notionGetMeta: (token, pageId) => {
    return ipcRenderer.invoke("notion:get-meta", token, pageId);
  },

  // ==========================================================================
  // PLATFORM INFO
  // ==========================================================================

  // The OS platform string (darwin, win32, linux)
  platform: process.platform,

  // Whether we're running in Electron (renderer can check this)
  isElectron: true,
});

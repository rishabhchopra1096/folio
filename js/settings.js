/*
 * =============================================================================
 * SETTINGS.JS — Theme, Font Size, Line Height, Column Width Controls
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages the settings panel in the top-right corner of the app.
 * Users can change the visual theme, adjust font size, line height, and
 * column width. All settings are persisted to localStorage via FolioStore.
 *
 * HOW IT WORKS:
 * 1. On app load, we read saved settings from FolioStore and apply them
 * 2. Each setting control has an event listener that updates the UI + saves
 * 3. The settings panel opens/closes via the gear icon in the top bar
 * =============================================================================
 */

const Settings = (function () {

  // Track current values in memory for quick access
  let fontSize = 18;
  let lineHeight = 1.85;
  let columnWidth = 680;

  // Load saved settings and apply them to the DOM
  function init() {
    const saved = FolioStore.getSettings();
    fontSize = saved.fontSize || 18;
    lineHeight = saved.lineHeight || 1.85;
    columnWidth = saved.columnWidth || 680;

    // Apply the saved theme
    applyTheme(saved.theme || "default");

    // Apply font size, line height, and column width
    applyFontSize();
    applyLineHeight();
    applyColumnWidth();

    // Set slider values to match saved settings
    document.getElementById("lh-slider").value = lineHeight;
    document.getElementById("width-slider").value = columnWidth;

    // Wire up the settings panel toggle
    const settingsBtn = document.getElementById("settings-btn");
    const settingsPanel = document.getElementById("settings-panel");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsPanel.classList.toggle("open");
    });
    // Close settings panel when clicking outside
    document.addEventListener("click", (e) => {
      if (!settingsPanel.contains(e.target)) {
        settingsPanel.classList.remove("open");
      }
    });

    // Theme buttons
    document.querySelectorAll(".theme-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyTheme(btn.dataset.t);
        save();
      });
    });

    // Font size up/down buttons
    document.getElementById("fs-up").addEventListener("click", () => {
      fontSize = Math.min(26, fontSize + 1);
      applyFontSize();
      save();
    });
    document.getElementById("fs-down").addEventListener("click", () => {
      fontSize = Math.max(13, fontSize - 1);
      applyFontSize();
      save();
    });

    // Line height slider
    document.getElementById("lh-slider").addEventListener("input", (e) => {
      lineHeight = parseFloat(e.target.value);
      applyLineHeight();
      save();
    });

    // Column width slider
    document.getElementById("width-slider").addEventListener("input", (e) => {
      columnWidth = parseInt(e.target.value);
      applyColumnWidth();
      save();
    });
  }

  // Apply a theme by setting the data-theme attribute on <html>
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "default" ? "" : theme;
    // Update the active button state
    document.querySelectorAll(".theme-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.t === theme);
    });
  }

  // Apply font size to the article and editor containers
  function applyFontSize() {
    const article = document.getElementById("article");
    const editor = document.getElementById("editor-textarea");
    if (article) {
      article.style.fontSize = fontSize + "px";
      article.style.setProperty("--article-fs", fontSize + "px");
    }
    if (editor) {
      editor.style.fontSize = (fontSize - 2) + "px";
    }
    document.getElementById("fs-val").textContent = fontSize + "px";
  }

  // Apply line height to the article and editor
  function applyLineHeight() {
    const article = document.getElementById("article");
    const editor = document.getElementById("editor-textarea");
    if (article) article.style.lineHeight = lineHeight;
    if (editor) editor.style.lineHeight = lineHeight;
  }

  // Apply column width to the article and editor containers
  function applyColumnWidth() {
    const article = document.getElementById("article");
    const editorContainer = document.getElementById("editor-container");
    if (article) article.style.maxWidth = columnWidth + "px";
    if (editorContainer) editorContainer.style.maxWidth = columnWidth + "px";
  }

  // Persist current settings to localStorage
  function save() {
    const currentTheme =
      document.documentElement.dataset.theme || "default";
    FolioStore.saveSettings({
      theme: currentTheme,
      fontSize,
      lineHeight,
      columnWidth,
      lastOpenDocId: FolioStore.getSettings().lastOpenDocId,
    });
  }

  // Get current font size (used by editor)
  function getFontSize() { return fontSize; }
  function getLineHeight() { return lineHeight; }
  function getColumnWidth() { return columnWidth; }

  return {
    init,
    applyFontSize,
    applyLineHeight,
    applyColumnWidth,
    save,
    getFontSize,
    getLineHeight,
    getColumnWidth,
  };
})();

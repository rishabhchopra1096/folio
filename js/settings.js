/*
 * =============================================================================
 * SETTINGS.JS — Theme, Font Size, Line Height, Column Width Controls
 * =============================================================================
 * FILE OVERVIEW:
 * Manages the settings panel. Users can change theme, font size, line height,
 * and column width. All settings are persisted to localStorage via FolioStore.
 * =============================================================================
 */

const Settings = (function () {

  let fontSize = 18;
  let lineHeight = 1.85;
  let columnWidth = 720;

  function init() {
    const saved = FolioStore.getSettings();
    fontSize = saved.fontSize || 18;
    lineHeight = saved.lineHeight || 1.85;
    columnWidth = saved.columnWidth || 720;

    applyTheme(saved.theme || "default");
    applyFontSize();
    applyLineHeight();
    applyColumnWidth();

    document.getElementById("lh-slider").value = lineHeight;
    document.getElementById("width-slider").value = columnWidth;

    // Theme buttons
    document.querySelectorAll(".theme-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyTheme(btn.dataset.t);
        save();
      });
    });

    // Font size buttons
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

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "default" ? "" : theme;
    document.querySelectorAll(".theme-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.t === theme);
    });
  }

  function applyFontSize() {
    const article = document.getElementById("article");
    if (article) {
      article.style.fontSize = fontSize + "px";
      article.style.setProperty("--article-fs", fontSize + "px");
    }
    document.getElementById("fs-val").textContent = fontSize + "px";
  }

  function applyLineHeight() {
    const article = document.getElementById("article");
    if (article) article.style.lineHeight = lineHeight;
  }

  function applyColumnWidth() {
    const article = document.getElementById("article");
    const editorContainer = document.getElementById("editor-container");
    if (article) article.style.maxWidth = columnWidth + "px";
    if (editorContainer) editorContainer.style.maxWidth = columnWidth + "px";
  }

  function save() {
    const currentTheme = document.documentElement.dataset.theme || "default";
    const existing = FolioStore.getSettings();
    FolioStore.saveSettings({
      ...existing,
      theme: currentTheme,
      fontSize,
      lineHeight,
      columnWidth,
    });
  }

  return { init, applyFontSize, applyLineHeight, applyColumnWidth, save };
})();

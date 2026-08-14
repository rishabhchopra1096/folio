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
  // Width mode: "narrow" uses the slider value (480-960), "wide" pins to ~1100px,
  // "full" expands to fill the available content area. Default "narrow" so
  // existing users see no behavior change.
  let widthMode = "narrow";

  function init() {
    const saved = FolioStore.getSettings();
    fontSize = saved.fontSize || 18;
    lineHeight = saved.lineHeight || 1.85;
    columnWidth = saved.columnWidth || 720;
    widthMode = saved.widthMode || "narrow";

    applyTheme(saved.theme || "default");
    applyFontSize();
    applyLineHeight();
    applyColumnWidth();
    applyWidthMode();

    document.getElementById("lh-slider").value = lineHeight;
    document.getElementById("width-slider").value = columnWidth;
    document.querySelectorAll(".width-mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === widthMode);
    });

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

    // Column width slider (only meaningful in narrow mode)
    document.getElementById("width-slider").addEventListener("input", (e) => {
      columnWidth = parseInt(e.target.value);
      applyColumnWidth();
      save();
    });

    // Width mode buttons (Narrow / Wide / Full)
    document.querySelectorAll(".width-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        widthMode = btn.dataset.mode;
        document.querySelectorAll(".width-mode-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.mode === widthMode);
        });
        applyWidthMode();
        save();
      });
    });

    // Backup: export all folio_* localStorage keys as a JSON file
    document.getElementById("backup-export-btn").addEventListener("click", exportBackup);

    // Backup: import a previously-exported JSON file
    const importBtn = document.getElementById("backup-import-btn");
    const importFile = document.getElementById("backup-import-file");
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importBackup(file);
      importFile.value = "";
    });

    // Voice: Groq API key handlers (Save / Test / Clear)
    initVoiceKeyUI();
  }

  /*
   * Wire the Groq API key controls in the settings panel. The key never leaves
   * the browser — Voice module reads it from localStorage and posts audio
   * directly to Groq. Test button records ~500ms of ambient audio, uploads it,
   * and confirms Groq accepted the key (silence returns an empty transcript,
   * not an error).
   */
  function initVoiceKeyUI() {
    const input = document.getElementById("voice-key-input");
    const saveBtn = document.getElementById("voice-key-save-btn");
    const testBtn = document.getElementById("voice-key-test-btn");
    const clearBtn = document.getElementById("voice-key-clear-btn");
    const status = document.getElementById("voice-key-status");
    if (!input || !saveBtn || typeof Voice === "undefined") return;

    // Prefill the field with a masked hint if a key is already stored
    if (Voice.hasKey()) {
      const k = Voice.getKey();
      input.placeholder = maskKey(k);
    }

    saveBtn.addEventListener("click", () => {
      const raw = input.value.trim();
      if (!raw) {
        setStatus(status, "Paste a key first", "muted");
        return;
      }
      Voice.setKey(raw);
      input.value = "";
      input.placeholder = maskKey(raw);
      setStatus(status, "Saved — try the Test button to confirm", "ok");
    });

    testBtn.addEventListener("click", async () => {
      if (!Voice.hasKey()) {
        setStatus(status, "Save a key first", "err");
        return;
      }
      setStatus(status, "Testing… (grant mic permission if prompted)", "muted");
      try {
        await Voice.testKey();
        setStatus(status, "Key works ✓", "ok");
      } catch (err) {
        setStatus(status, "Test failed: " + (err && err.message ? err.message : "unknown"), "err");
      }
    });

    clearBtn.addEventListener("click", () => {
      Voice.clearKey();
      input.value = "";
      input.placeholder = "gsk_...";
      setStatus(status, "Cleared", "muted");
    });
  }

  function maskKey(k) {
    if (!k || k.length < 10) return "gsk_...";
    return k.slice(0, 6) + "…" + k.slice(-4);
  }

  function setStatus(el, text, tone) {
    if (!el) return;
    el.textContent = text;
    el.className = "voice-key-status voice-key-status-" + (tone || "muted");
  }

  /*
   * Dump every folio_* localStorage key into one JSON blob and trigger a
   * download. Filename includes today's date so multiple backups don't clash.
   */
  function exportBackup() {
    const data = FolioStore.exportAll();
    const meta = {
      exportedAt: new Date().toISOString(),
      version: 1,
      data,
    };
    const blob = new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const today = new Date().toISOString().slice(0, 10);
    const docCount = (data.folio_documents || []).length;
    a.download = `folio-backup-${today}-${docCount}docs.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /*
   * Read a backup file, ask the user whether to merge or replace, then restore.
   * Defaults to merge (safer — existing docs are kept, only new ones are added).
   */
  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.target.result);
      } catch {
        alert("That file isn't a valid Folio backup (couldn't parse JSON).");
        return;
      }

      // Accept both the wrapped { version, data } shape and a raw folio_* map
      const data = parsed && parsed.data ? parsed.data : parsed;
      if (!data || typeof data !== "object" || !data.folio_documents) {
        alert("That file doesn't look like a Folio backup (no folio_documents key).");
        return;
      }

      const incomingCount = (data.folio_documents || []).length;
      const currentCount = FolioStore.listDocuments().length;

      // If there's no existing data, just import straight in
      let mode = "merge";
      if (currentCount > 0) {
        const choice = confirm(
          `Import backup (${incomingCount} pages)?\n\n` +
            `You currently have ${currentCount} pages.\n\n` +
            `OK = Merge (keep your pages, add new ones from the backup).\n` +
            `Cancel = pick Replace instead.`
        );
        if (!choice) {
          const replace = confirm(
            `Replace everything with the backup?\n\nThis wipes your ${currentCount} current pages and restores the backup exactly as it was. Cannot be undone.`
          );
          if (!replace) return;
          mode = "replace";
        }
      }

      const result = FolioStore.importAll(data, mode);
      alert(
        mode === "replace"
          ? `Restored backup. ${incomingCount} pages loaded.`
          : `Merged backup. ${result.added} new pages added, ${result.skipped} skipped (already present).`
      );

      // Reload the page so all modules re-read the new store state cleanly
      window.location.reload();
    };
    reader.readAsText(file);
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
    // Slider value only takes effect in narrow mode — wide/full ignore it
    if (widthMode !== "narrow") return;
    document.documentElement.style.setProperty("--article-width", columnWidth + "px");
  }

  /*
   * Width mode controls how wide the reading/editing column is:
   *   - narrow: slider value (480-960px) — comfortable reading width, default
   *   - wide:   ~1100px — more generous, good for full-window with content
   *   - full:   100% of available content area minus padding — no max
   *
   * We drive this through CSS custom properties on :root so #article and
   * #editor-container (which already reference var(--article-width)) update
   * automatically. The "full" mode swaps in a different value via a body class
   * because CSS variables can't be conditional but classes can.
   */
  function applyWidthMode() {
    const root = document.documentElement;
    document.body.classList.remove("width-narrow", "width-wide", "width-full");
    document.body.classList.add("width-" + widthMode);
    if (widthMode === "narrow") {
      root.style.setProperty("--article-width", columnWidth + "px");
    } else if (widthMode === "wide") {
      root.style.setProperty("--article-width", "1100px");
    } else if (widthMode === "full") {
      root.style.setProperty("--article-width", "none");
    }
    // Disable the slider visually when it has no effect
    const slider = document.getElementById("width-slider");
    if (slider) slider.disabled = widthMode !== "narrow";
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
      widthMode,
    });
  }

  return { init, applyFontSize, applyLineHeight, applyColumnWidth, applyWidthMode, save };
})();

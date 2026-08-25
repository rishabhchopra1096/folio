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
  // Sleep intensity for the Paper theme: "off" | "warm" | "bedtime".
  // Only visually relevant when theme === "paper".
  let sleepIntensity = "off";

  function init() {
    const saved = FolioStore.getSettings();
    fontSize = saved.fontSize || 18;
    lineHeight = saved.lineHeight || 1.85;
    columnWidth = saved.columnWidth || 720;
    widthMode = saved.widthMode || "narrow";
    sleepIntensity = saved.sleepIntensity || "off";

    applyTheme(saved.theme || "default");
    applySleepIntensity();
    applyFontSize();
    applyLineHeight();
    applyColumnWidth();
    applyWidthMode();

    document.getElementById("lh-slider").value = lineHeight;
    document.getElementById("width-slider").value = columnWidth;
    document.querySelectorAll(".width-mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === widthMode);
    });
    document.querySelectorAll(".sleep-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.sleep === sleepIntensity);
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

    // Sleep-intensity buttons (Off / Warm / Bedtime) — Paper theme only
    document.querySelectorAll(".sleep-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        sleepIntensity = btn.dataset.sleep;
        document.querySelectorAll(".sleep-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.sleep === sleepIntensity);
        });
        applySleepIntensity();
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
    // Video: Gemini API key handlers
    initGeminiKeyUI();
    initSpeechifyUI();
    // Video: which model transcribes, and the diagnostic log
    initGeminiModel();
    initGeminiLog();
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

  /*
   * Gemini key for YouTube transcription. Same arrangement as the Groq key:
   * the user's own key, in this browser only, never in the shipped source —
   * Folio's repo is public and Google keys are auto-detected by secret
   * scanning, so a committed key would be revoked within minutes anyway.
   */
  function initGeminiKeyUI() {
    const input = document.getElementById("gemini-key-input");
    const saveBtn = document.getElementById("gemini-key-save-btn");
    const clearBtn = document.getElementById("gemini-key-clear-btn");
    const status = document.getElementById("gemini-key-status");
    if (!input || !saveBtn || typeof Gemini === "undefined") return;

    if (Gemini.hasKey()) input.placeholder = maskKey(Gemini.getKey());

    saveBtn.addEventListener("click", () => {
      const raw = input.value.trim();
      if (!raw) { setStatus(status, "Paste a key first", "muted"); return; }
      Gemini.setKey(raw);
      input.value = "";
      input.placeholder = maskKey(raw);
      setStatus(status, "Saved — paste a YouTube link to try it", "ok");
    });

    clearBtn.addEventListener("click", () => {
      Gemini.clearKey();
      input.value = "";
      input.placeholder = "AIza...";
      setStatus(status, "Cleared", "muted");
    });
  }


  /*
   * Speechify key + voice, for reading aloud.
   *
   * Same arrangement as the other two: the user's own key, in this browser
   * only, never in the shipped source. This repo is public and `sk_` keys are
   * exactly what secret scanners match.
   *
   * Choosing an engine here is deliberately not a toggle the user can get
   * wrong: saving a key switches to Simba, clearing it switches back. TTS
   * refuses any provider that is not actually available, so the document always
   * reads even if this ends up in a strange state.
   */
  function initSpeechifyUI() {
    const input = document.getElementById("speechify-key-input");
    const saveBtn = document.getElementById("speechify-key-save-btn");
    const testBtn = document.getElementById("speechify-key-test-btn");
    const clearBtn = document.getElementById("speechify-key-clear-btn");
    const status = document.getElementById("speechify-key-status");
    if (!input || !saveBtn || typeof SpeechifyProvider === "undefined") return;

    /*
     * Persist the choice BEFORE telling TTS to repaint. reloadVoices re-reads
     * settings, so switching the live engine first and saving after would be
     * immediately undone by the stale stored value.
     */
    function useSpeechify(on) {
      if (typeof TTS === "undefined" || !TTS.setProvider) return;
      const st = FolioStore.getSettings();
      st.ttsProvider = on ? "speechify" : "webspeech";
      // Let the new engine choose its own default voice rather than keeping a
      // name that belongs to the other one.
      st.ttsVoicePicked = false;
      FolioStore.saveSettings(st);
      TTS.setProvider(st.ttsProvider);
      if (TTS.reloadVoices) TTS.reloadVoices();
    }

    if (SpeechifyProvider.hasKey()) input.placeholder = maskKey(SpeechifyProvider.getKey());

    saveBtn.addEventListener("click", () => {
      const raw = input.value.trim();
      if (!raw) { setStatus(status, "Paste a key first", "muted"); return; }
      /*
       * Say what was actually stored. A truncated or quote-wrapped paste is the
       * commonest cause of a 401, and it is invisible in a password field.
       */
      SpeechifyProvider.setKey(raw);
      const saved = SpeechifyProvider.getKey();
      if (!/^sk_/.test(saved) || saved.length < 20) {
        setStatus(status,
          `That does not look like a Speechify key — stored ${saved.length} characters starting "${saved.slice(0, 3)}". Keys start "sk_".`,
          "err");
        return;
      }
      input.value = "";
      input.placeholder = maskKey(raw);
      useSpeechify(true);
      setStatus(status, "Saved — pick a Simba voice in the reading bar", "ok");
    });

    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        if (!SpeechifyProvider.hasKey()) {
          setStatus(status, "Save a key first", "muted"); return;
        }
        setStatus(status, "Testing…", "muted");
        testBtn.disabled = true;
        /*
         * Synthesises three words rather than checking the key's shape — the
         * only failure worth reporting is the one that happens on a real call,
         * and this costs a fraction of a cent.
         */
        let handle = null;
        try {
          await new Promise((resolve, reject) => {
            handle = SpeechifyProvider.speak("Speechify is working.", {
              rate: 1,
              voice: SpeechifyProvider.defaultVoice(),
              onWord: function () {},
              onEnd: resolve,
              onError: reject,
            });
            setTimeout(() => reject(new Error("Timed out after 20 seconds")), 20000);
          });
          setStatus(status, "Working — that was Simba 3.2", "ok");
          useSpeechify(true);
        } catch (err) {
          if (handle) handle.stop();
          setStatus(status, (err && err.message) || "Test failed", "err");
        } finally {
          testBtn.disabled = false;
        }
      });
    }

    /*
     * Reading aloud fails in ways the console cannot explain on its own — a
     * burst of 429s says the limit was hit but not by how many requests, and a
     * gap between sentences could be the network, the queue or a retry. This
     * hands over the whole timeline.
     */
    const logBtn = document.getElementById("speechify-log-copy-btn");
    if (logBtn) {
      logBtn.addEventListener("click", async () => {
        const text = SpeechifyProvider.formatLog();
        if (!text) { setStatus(status, "Nothing logged yet — press play first", "muted"); return; }
        try {
          await navigator.clipboard.writeText(text);
          setStatus(status, `Copied ${SpeechifyProvider.getLog().length} log lines`, "ok");
        } catch {
          // Clipboard can be blocked; a file always works.
          const blob = new Blob([text], { type: "text/plain" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "folio-speechify-log.txt";
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
          setStatus(status, "Clipboard blocked — saved as a file instead", "ok");
        }
      });
    }

    /*
     * Audio is kept on disk so a paragraph is paid for once and replays free
     * after a reload. Showing the size makes that visible rather than something
     * you have to take on trust, and gives a way to reclaim the space.
     */
    const cacheStatus = document.getElementById("speechify-cache-status");
    const cacheBtn = document.getElementById("speechify-cache-clear-btn");

    async function showCacheSize() {
      if (!cacheStatus || !SpeechifyProvider.diskUsage) return;
      const u = await SpeechifyProvider.diskUsage();
      cacheStatus.className = "voice-key-status voice-key-status-muted";
      cacheStatus.textContent = u.entries
        ? `${u.entries} passages saved (${(u.bytes / 1048576).toFixed(1)} MB) — these replay free`
        : "No audio saved yet";
    }
    showCacheSize();

    if (cacheBtn) {
      cacheBtn.addEventListener("click", async () => {
        await SpeechifyProvider.clearDisk();
        await showCacheSize();
        setStatus(status, "Audio cleared — the next read will synthesise again", "muted");
      });
    }

    /*
     * Start a clean session. The log and its running totals persist across
     * reloads on purpose — a reading session spans them — so there has to be a
     * way to say "measure from here".
     */
    const resetBtn = document.getElementById("speechify-log-reset-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        SpeechifyProvider.clearLog();
        setStatus(status, "Log reset — this session starts from zero", "ok");
      });
    }

    clearBtn.addEventListener("click", () => {
      SpeechifyProvider.clearKey();
      input.value = "";
      input.placeholder = "sk_...";
      useSpeechify(false);
      setStatus(status, "Cleared — back to the system voice", "muted");
    });

  }

  /*
   * Which model transcribes a video, and what it costs.
   *
   * This was overridable only by setting a localStorage key by hand, which
   * means in practice it was not overridable at all — and worse, there was no
   * way to see which model a transcript had actually used without reading the
   * diagnostic log. Given how much the choice costs, it belongs on screen.
   */
  function initGeminiModel() {
    const status = document.getElementById("gemini-model-status");
    const btns = Array.from(document.querySelectorAll(".model-btn"));
    if (!btns.length || typeof Gemini === "undefined" || !Gemini.getModel) return;

    const paint = () => {
      const current = Gemini.getModel();
      btns.forEach((b) => b.classList.toggle("active", b.dataset.model === current));
      const known = btns.some((b) => b.dataset.model === current);
      setStatus(status, known ? "Using " + current : "Using " + current + " (custom)",
                "muted");
    };

    btns.forEach((b) => {
      b.addEventListener("click", () => {
        Gemini.setModel(b.dataset.model === Gemini.DEFAULT_MODEL ? "" : b.dataset.model);
        paint();
      });
    });
    paint();
  }

  /*
   * The transcription log: read it, keep it, or throw it away.
   *
   * A run that ends short leaves no trace on screen — you just get fewer lines
   * than you expected. These give you the reason without a DevTools session,
   * and because the log lives in localStorage it is still there after the
   * reload that killed the run.
   */
  function initGeminiLog() {
    const copyBtn = document.getElementById("gemini-log-copy-btn");
    const saveBtn = document.getElementById("gemini-log-save-btn");
    const clearBtn = document.getElementById("gemini-log-clear-btn");
    const status = document.getElementById("gemini-log-status");
    if (!copyBtn || typeof Gemini === "undefined" || !Gemini.formatLog) return;

    const summary = () => {
      const n = Gemini.getLog().length;
      return n ? `${n} entries recorded` : "Nothing recorded yet";
    };
    setStatus(status, summary(), "muted");

    copyBtn.addEventListener("click", async () => {
      const text = Gemini.formatLog();
      try {
        await navigator.clipboard.writeText(text);
        setStatus(status, "Copied — paste it anywhere", "ok");
      } catch {
        // Clipboard access can be refused; falling back to a download beats
        // telling someone their diagnostics are unreachable.
        downloadText(text, logFilename());
        setStatus(status, "Clipboard blocked — saved as a file instead", "muted");
      }
    });

    saveBtn.addEventListener("click", () => {
      downloadText(Gemini.formatLog(), logFilename());
      setStatus(status, "Saved", "ok");
    });

    clearBtn.addEventListener("click", () => {
      Gemini.clearLog();
      setStatus(status, "Cleared", "muted");
    });
  }

  function logFilename() {
    return "folio-transcription-log-" + new Date().toISOString().slice(0, 10) + ".txt";
  }

  function downloadText(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    // Sleep-intensity strip only makes sense with the Paper theme —
    // hide it under any other theme so the settings panel stays tidy.
    const strip = document.getElementById("sleep-intensity");
    if (strip) strip.classList.toggle("visible", theme === "paper");
  }

  /*
   * Apply the sleep intensity as [data-sleep] on the html element.
   * Only visually relevant when the active theme is "paper" — the token
   * override selectors in variables.css are gated on [data-theme="paper"].
   * We still write the attribute even for other themes so switching to
   * Paper later restores the user's last chosen intensity without needing
   * a re-click.
   */
  function applySleepIntensity() {
    if (sleepIntensity && sleepIntensity !== "off") {
      document.documentElement.dataset.sleep = sleepIntensity;
    } else {
      delete document.documentElement.dataset.sleep;
    }
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
      sleepIntensity,
    });
  }

  return { init, applyFontSize, applyLineHeight, applyColumnWidth, applyWidthMode, applySleepIntensity, save };
})();

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

  /*
   * WHY THIS IS ASYNC, AND WHY IT COUNTS ITS OWN CALLS.
   *
   * Reported 17 October 2026: "when i paste the text, it's visible in edit
   * mode, but vanishes in view mode." Two separate faults, both here, and
   * both long-standing — a probe reproduced them in code six weeks older.
   *
   * FAULT ONE, the one that was reported. Editor.hide() is an async function:
   * it flushes the editor to storage with `await persistContent()`, which in
   * turn awaits Editor.js's own save(). This function used to call it WITHOUT
   * awaiting, then read storage in the same synchronous turn — so the reader
   * drew the revision from BEFORE the paste. Nothing was lost; the screen was
   * one revision behind, and a reload would have shown the text. But a person
   * who pastes and switches to read mode has no way to know that.
   *
   * FAULT TWO, found while diagnosing the first, and worse. The edit branch
   * never flushed at all, and openEditor() destroys the previous Editor.js
   * instance without saving it. So clicking from one page's editor straight
   * into another page's editor really did destroy whatever had been typed in
   * the first within the last second — gone from storage, not merely undrawn.
   * Awaiting the flush here fixes both, and it has to be HERE rather than
   * inside openEditor, which reassigns currentDocId to the new document
   * before that destroy — a flush added there would write the first page's
   * content under the second page's id.
   *
   * THE TOKEN, AND AN HONEST NOTE ABOUT IT. Making this async opens a race it
   * did not have before: two quick navigations both await, and whichever
   * resumes last paints its view over the newer one. Each call takes a ticket
   * and gives up after an await if a newer call has started.
   *
   * That guard is UNPROVEN and is kept as insurance, not as a fix for
   * anything observed. test/browser/routerace.probe.html tried three times to
   * catch its removal — including wrapping the editor's save() to take 600ms
   * and navigating again 50ms into that window — and every attempt passed
   * with the guard disabled. The reason is that every branch below has
   * exactly one await and it is the same call: a second navigation arriving
   * mid-flush finds the editor still alive, because the teardown happens
   * after that await, so it takes the slow path too and its own timer was
   * started later. A later call cannot overtake an earlier one.
   *
   * It stays because it costs three lines and the failure it prevents — the
   * wrong page on screen with the right URL in the bar — is nasty and silent.
   * If a future await with different timing is added below, this is already
   * handled. But it should not be counted as tested.
   */
  let routeToken = 0;

  async function route() {
    const token = ++routeToken;
    const current = () => token === routeToken;
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

      /*
       * Flush and tear down the editor we are leaving BEFORE opening the next
       * one. Without this, moving between two pages' editors loses the last
       * second of work on the first.
       *
       * There was briefly a guard here that skipped this when the editor was
       * already open on this exact document, to stop a rebuild from storage
       * discarding unsaved work. It was removed because a mutation test showed
       * it changed nothing, and the reason holds: the only way an instance is
       * still alive when route() runs is that a previous flush was REFUSED,
       * and the refusal below returns before openEditor is reached. Leaving it
       * out also means pressing the button again genuinely retries the save,
       * which is what someone who has just freed up space expects.
       */
      const leftEdit = await Editor.hide();
      if (!current()) return;
      if (leftEdit === "failed") {
        /* The page we are leaving could not be written. Go back to it rather
         * than opening another one on top of work that exists nowhere else. */
        showSaveFailed(saveFailedMessage(Editor.getCurrentDocId()));
        window.location.hash = "#/doc/" + Editor.getCurrentDocId() + "/edit";
        return;
      }

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

      /*
       * AWAITED, and that is half the fix for the reported bug. hide() flushes
       * the editor to storage asynchronously; renderDocument() below reads
       * that storage. Unawaited, the read happened first and the reader drew
       * the text as it was before the last edit.
       *
       * The other half is the refusal below. When the flush FAILS there is
       * nothing in storage to draw, and carrying on would paint an empty page
       * over the only copy of the user's writing — which is exactly what was
       * reported. So the navigation is abandoned and the editor stays up.
       */
      const flushed = await Editor.hide();
      if (!current()) return;
      if (flushed === "failed") {
        const stuckOn = Editor.getCurrentDocId() || docId;
        showSaveFailed(saveFailedMessage(stuckOn));
        currentMode = "edit";
        currentDocId = stuckOn;
        showView(viewEditor);
        updateModeToggle("edit");
        /* Put the URL back so it agrees with what is on screen. The guard at
         * the top of the edit branch stops this rebuilding the editor. */
        window.location.hash = "#/doc/" + stuckOn + "/edit";
        return;
      }

      showView(viewReader);
      topbar.style.display = "";
      Reader.renderDocument(docId);
      /*
       * An interrupted transcription only resumes on the document you have
       * open, so the check has to run on every navigation — not just at
       * startup. Held leases make a second call while one is already running a
       * no-op.
       */
      if (typeof Video !== "undefined" && Video.resumePending) Video.resumePending();
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
    /* Awaited for the same reason: going home from an editor must not race
     * the flush of what was just written — and refused for the same reason
     * too, since the welcome screen would hide unsaved writing just as
     * completely as an empty reader would. */
    const wentHome = await Editor.hide();
    if (!current()) return;
    if (wentHome === "failed") {
      const stuckOn = Editor.getCurrentDocId();
      showSaveFailed(saveFailedMessage(stuckOn));
      window.location.hash = "#/doc/" + stuckOn + "/edit";
      return;
    }
    showView(viewWelcome);
    topbar.style.display = "none";
    SidebarUI.setActiveDoc(null);
  }

  // ==========================================================================
  // THE SAVE-FAILED BANNER — the one message that must not be missable
  // ==========================================================================

  /*
   * WHY THIS EXISTS, in the user's words on 17 October 2026: "still same
   * problem, content vanishes when i press view button". The screenshot that
   * came with it showed "Save failed" in grey 12px type in the corner of the
   * topbar, which he had not noticed, and a blank page where his writing had
   * been. The writing was fine — it was in the editor, unsaved, because the
   * browser's storage was full — but nothing on screen said so.
   *
   * A corner label is the wrong shape for this news. Everything else Folio
   * says can be missed without consequence; this cannot, because carrying on
   * typing is the one response that guarantees losing the work. So it is a
   * band across the top that stays until it is dismissed, in the colour the
   * app uses for nothing else.
   *
   * BUILT IN JAVASCRIPT ON PURPOSE. index.html and index-electron.html both
   * have to carry any new markup, and the two drifting apart is a standing
   * hazard in this repo. A banner that creates itself cannot drift.
   */
  let banner = null;
  function showSaveFailed(detail) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "save-failed-banner";
      banner.setAttribute("role", "alert");
      banner.style.cssText = [
        "position:fixed", "top:0", "left:0", "right:0", "z-index:100000",
        "background:#8c2f1d", "color:#fff6ee",
        "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "padding:14px 56px 14px 20px", "box-shadow:0 2px 12px rgba(0,0,0,.4)",
      ].join(";");
      const close = document.createElement("button");
      close.textContent = "×";
      close.title = "Dismiss";
      close.style.cssText = [
        "position:absolute", "top:8px", "right:14px", "background:none",
        "border:0", "color:inherit", "font-size:24px", "line-height:1",
        "cursor:pointer", "padding:4px 8px",
      ].join(";");
      close.addEventListener("click", clearSaveFailed);
      banner.appendChild(document.createElement("span"));
      banner.appendChild(close);
      document.body.appendChild(banner);
    }
    banner.firstChild.innerHTML = detail;
    /*
     * PUSH THE PAGE DOWN RATHER THAN SIT ON TOP OF IT. The first version
     * overlaid the topbar, which hides the breadcrumb and the view, comments
     * and theme buttons for as long as the banner is up — so the message
     * about not being able to save also took away the controls. Only visible
     * by looking at a screenshot of it. The sidebar is fixed-position and the
     * shell is not, so both need the offset.
     */
    const h = banner.getBoundingClientRect().height;
    document.body.style.paddingTop = h + "px";
    const side = document.getElementById("sidebar");
    if (side) { side.style.top = h + "px"; side.style.height = "calc(100vh - " + h + "px)"; }
  }

  /* Undo the offset, so dismissing gives the page back exactly as it was. */
  function clearSaveFailed() {
    if (banner) { banner.remove(); banner = null; }
    document.body.style.paddingTop = "";
    const side = document.getElementById("sidebar");
    if (side) { side.style.top = ""; side.style.height = ""; }
  }

  /*
   * What to actually say. A full disk and a document rewritten underneath you
   * are both "could not save" and need completely different actions, so they
   * get completely different sentences — and the full-disk one names the
   * biggest thing in storage, because "free up space" with no idea where to
   * start is not advice.
   */
  function saveFailedMessage(docId) {
    const head = "<strong>This page could not be saved, so it has been left open.</strong> " +
                 "Your writing is still on screen and still safe — but it is only here, " +
                 "so copy it somewhere safe before closing this tab. ";

    /*
     * Only blame the storage when the storage is to blame. A rendered shot of
     * the first version said "Storage holds 0.0MB" for a failure that had
     * nothing to do with space, which is both useless and visibly wrong — and
     * a message that is visibly wrong in one clause does not get believed in
     * the others.
     */
    const why = (typeof Editor !== "undefined" && Editor.lastSaveFailureReason)
      ? Editor.lastSaveFailureReason() : null;
    if (why !== "quota") {
      return head + "The reason is not a full browser — something else refused " +
             "the write. The browser console has the details.";
    }

    let where = "This browser's storage is full. ";
    try {
      const r = FolioStore.storageReport();
      /*
       * QUOTE THE NUMBER ONLY IF IT AGREES WITH THE FAILURE. A rendered shot
       * said "storage is full at 0.0MB", which is self-contradictory and makes
       * the rest of the sentence unbelievable. If the measurement says there
       * is almost nothing stored while the browser refuses to write, the
       * measurement is the part that is wrong — so the plain sentence is used
       * and no figure is invented.
       */
      if (r.total > 1048576) {
        const top = Object.entries(r.groups).sort((a, b) => b[1] - a[1])[0];
        where = "This browser's storage is full at " + (r.total / 1048576).toFixed(1) + "MB" +
                (top ? ", most of it (" + (top[1] / 1048576).toFixed(1) + "MB) " + top[0] : "") +
                ". ";
      }
    } catch (e) { /* the plain sentence above already says the useful part */ }

    return head + where +
           "Open Settings → Backup → Export all, then delete a few pages to make room.";
  }

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
    /*
     * Ask to keep the data BEFORE anything else. Every page lives in this
     * browser and nowhere else, and browsers evict best-effort storage without
     * warning — Safari after about a week of not visiting. Asking first is the
     * difference between "my notes are gone" and not.
     */
    /*
     * SQUEEZE THE PAGES BEFORE ANYTHING ELSE RUNS.
     *
     * On 17 October 2026 storage hit 10.00MB — Chrome's ceiling for one
     * origin — and every save started failing. Page content was 7.49MB of
     * that, and Editor.js JSON wrapped around prose compresses by about
     * 84%, so compacting it is the difference between a browser that refuses
     * to save and one that is a third full.
     *
     * It runs FIRST because every module below reads pages, and a module that
     * read one mid-compaction would be reading a value in the middle of being
     * replaced. It is synchronous for the same reason.
     *
     * It is also cheap after the first run: already-compressed pages are
     * recognised by their marker and skipped, so this costs a walk of the
     * keys and nothing more.
     */
    try {
      FolioStore.compactStorage();
    } catch (err) {
      /* Never let a space optimisation stop the app from starting. The worst
       * case without it is the storage staying as large as it was. */
      console.error("[folio] could not compact storage at startup", err);
    }

    FolioStore.requestDurableStorage().then(function (state) {
      if (state === "best-effort") {
        console.warn("[folio] The browser would not promise to keep this data. " +
                     "Export a backup from Settings, and consider installing Folio " +
                     "as an app so it is not evicted.");
      }
    });

    // Initialize all modules
    Settings.init();
    SidebarUI.init();
    Highlights.init();
    Comments.init();
    /*
     * The feedback box at the bottom left. Guarded like the other optional
     * modules: a page that does not include the markup simply has no box,
     * rather than a broken startup.
     */
    if (typeof Feedback !== "undefined") Feedback.init();
    if (typeof TTS !== "undefined") TTS.init();
    /*
     * Reading a selection from another application. Electron only — the web
     * build has no way to capture one, and the module is not loaded there.
     */
    if (typeof ReadAloud !== "undefined") ReadAloud.init();

    // Restart any transcription that a reload interrupted.
    if (typeof Video !== "undefined" && Video.resumePending) Video.resumePending();

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

    // Add-a-video button in the sidebar footer
    const videoBtn = document.getElementById("add-video-btn");
    if (videoBtn && typeof Video !== "undefined") {
      videoBtn.addEventListener("click", () => Video.promptImport());
    }

    /*
     * Pasting a bare YouTube link anywhere outside a text field imports it.
     * Guarded to a URL on its own so pasting a link INTO prose still just
     * pastes the link.
     */
    document.addEventListener("paste", (e) => {
      if (typeof Video === "undefined" || typeof Gemini === "undefined") return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const text = e.clipboardData ? e.clipboardData.getData("text/plain").trim() : "";
      if (!text || /\s/.test(text)) return;
      if (!Gemini.parseYouTube(text)) return;
      e.preventDefault();
      // No dialog — pasting a link IS the request, the way it is in Notion.
      Video.importUrl(text).catch((err) => {
        Video.notify(err && err.message ? err.message : "Could not import that video");
      });
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
      /*
       * The same import the sidebar uses, not a second copy of it.
       *
       * This handler used to read the dropped file itself, which meant two
       * import paths with one of them behind: when a dropped FOLDER started
       * being understood (a Notion export, pictures and all), only the sidebar
       * learned it, and the welcome screen — the most obvious place to drop
       * something — would still have silently thrown the pictures away.
       *
       * It also never checked the extension, so dropping a PDF here made a
       * page of binary noise.
       *
       * stopPropagation IS LOAD-BEARING. js/sidebar.js also listens for a drop
       * on the whole document, so a file dropped here was being imported
       * TWICE — the dropzone's own handler and the document's, each making its
       * own page. Letting it bubble was a quiet way to get two copies of
       * everything you dragged onto the welcome screen.
       */
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("drag-over");
        SidebarUI.handleDrop(e.dataTransfer);
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

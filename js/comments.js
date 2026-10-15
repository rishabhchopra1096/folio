/*
 * =============================================================================
 * COMMENTS.JS — Comment System for Highlighted Text
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages the commenting system. Every comment is attached to a
 * highlight — to add a comment, you first highlight text, then add a comment
 * to that highlight. Comments appear in a slide-out panel on the right side.
 *
 * HOW IT WORKS:
 * 1. User highlights text and clicks "Add Comment" from the highlight popover
 * 2. The comments panel slides open with a text input at the bottom
 * 3. Submitting saves the comment to FolioStore, linked to the highlight ID
 * 4. Clicking a comment in the panel scrolls to and pulses the highlight
 * 5. Comments can be edited or deleted from the panel
 * =============================================================================
 */

const Comments = (function () {

  // Cache DOM elements
  const panel = document.getElementById("comments-panel");
  const commentsList = document.getElementById("comments-list");
  const commentInput = document.getElementById("comment-input");
  const commentSubmit = document.getElementById("comment-submit");
  const commentCancel = document.getElementById("comment-cancel");
  const resizeHandle = document.getElementById("comments-resize");
  const header = panel.querySelector(".comments-header");

  // Distance from the right viewport edge at which the panel snaps to a
  // full-height right-side margin dock. Small enough to be intentional.
  const SNAP_THRESHOLD_PX = 32;

  // The highlight ID we're currently adding a comment to
  let activeHighlightId = null;
  // The comment ID being edited (null if creating new)
  let editingCommentId = null;
  // True when the user clicked "New note" and we should create a page-level
  // comment (no highlight attached). Distinguished from "orphaned" comments,
  // which are ones whose highlight was deleted after the fact.
  let creatingGeneralNote = false;

  // ==========================================================================
  // PANEL MANAGEMENT — Opening and closing the comments panel
  // ==========================================================================

  /*
   * ==========================================================================
   * KEEPING THE TEXT READABLE WHILE THE COMMENTS ARE OPEN
   * ==========================================================================
   * The panel is position:fixed, so left alone it sits on top of the article.
   * At a wide window a floating card is fine — it covers margin. As the window
   * narrows, that same card covers the words, and it does so exactly when you
   * most want to read the text and the comment together.
   *
   * So below a threshold the panel docks itself and the article gives up the
   * width it takes, side by side instead of stacked. Above it, whatever
   * arrangement you dragged the panel into is left alone — a preference you
   * set deliberately should not be overridden because you resized a window.
   */
  const DOCK_BELOW_PX = 1100;

  function enforceLayout() {
    if (!panel) return;
    const narrow = window.innerWidth < DOCK_BELOW_PX;

    // Too narrow to float: dock it, but remember that WE did, so the user's
    // own choice comes back when there is room for it again.
    if (narrow && panel.classList.contains("open") && !panel.classList.contains("docked")) {
      panel.classList.add("docked", "auto-docked");
      panel.style.left = panel.style.top = panel.style.height = "";
    } else if (!narrow && panel.classList.contains("auto-docked")) {
      panel.classList.remove("docked", "auto-docked");
      restoreGeometry();
    }

    /*
     * The margin has to match the panel's ACTUAL width, not a guess — the panel
     * is resizable, and a stale number would either overlap the text or leave a
     * gap beside it.
     */
    const docked = panel.classList.contains("open") && panel.classList.contains("docked");
    document.body.classList.toggle("comments-docked", docked);
    if (docked) {
      const w = Math.round(panel.getBoundingClientRect().width);
      if (w > 0) document.documentElement.style.setProperty("--comments-width", w + "px");
    }
  }

  // Open the panel and show all comments for the current document
  function openPanel() {
    // Restore the last-used geometry before showing so the panel doesn't flash
    // in the default position and then jump.
    restoreGeometry();
    panel.classList.add("open");
    renderComments();
    enforceLayout();
  }

  // ==========================================================================
  // READS — which pass through the document a note belongs to
  // ==========================================================================
  /*
   * WHAT THIS SECTION IS FOR:
   * You read something in March and wrote six comments. You come back in
   * October, read it again, and have four new thoughts. Those are two
   * different readings and you want them exported apart. A "read" is the
   * record of one such pass; the store owns them (see FolioStore.getReads),
   * and this section is everything the comments panel needs to show them,
   * label them and filter an export by them.
   *
   * WHAT IS NOT HERE:
   * Nothing in this section decides a colour. A read's colour is assigned when
   * the read is created, in the store, so the panel and the highlight marks
   * cannot disagree about it.
   */

  // The id of the read currently in progress, which is what a brand-new
  // comment gets stamped with. Returns null only if there is no document.
  function currentReadId(docId) {
    try {
      const read = FolioStore.getCurrentRead(docId);
      return read ? read.id : null;
    } catch (err) {
      console.warn("[reads] could not resolve the current read", err);
      return null;
    }
  }

  // A read's month and year, for labels like "Read 2 · October 2026". The month
  // is enough — the point is "which visit was this", not the exact minute.
  function readDateLabel(read) {
    if (!read || !read.startedAt) return "";
    const d = new Date(read.startedAt);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  /*
   * WHAT THIS DOES:
   * Given every comment and highlight in a document, returns just the ones
   * belonging to one read.
   *
   * THE RULE FOR COMMENTS is the obvious one: keep those whose readId matches.
   *
   * THE RULE FOR HIGHLIGHTS IS NOT OBVIOUS, and getting it wrong breaks the
   * main thing this feature is for. Re-reading a passage you marked in March
   * and adding a fresh thought about it today produces a comment belonging to
   * THIS read attached to a highlight belonging to the OLD one. Filtering
   * highlights by readId alone would drop that highlight, the comment would
   * lose the quote it is about, and all three export formats would then file it
   * under "notes whose highlight was removed" — turning the feature's central
   * use case into a bug report.
   *
   * So a highlight is included when EITHER this read made it, OR one of this
   * read's comments points at it.
   */
  function sliceByRead(readId, highlights, comments) {
    const mine = comments.filter((c) => c.readId === readId);

    // Highlights this read's comments refer to, whichever read marked them.
    const referenced = new Set();
    mine.forEach((c) => { if (c.highlightId) referenced.add(c.highlightId); });

    const hls = highlights.filter(
      (h) => h.readId === readId || referenced.has(h.id)
    );
    return { highlights: hls, comments: mine };
  }

  /*
   * Redraw the strip under the panel header that says which read you are in
   * and offers to start a new one.
   *
   * It lives below the header rather than as a fourth header button because it
   * has to REPORT state as well as offer an action — you need to know you are
   * in Read 2 before "New read" means anything — and because starting a read
   * happens once per revisit while the other header buttons are constant.
   */
  function renderReadBar() {
    const bar = document.getElementById("comments-read-bar");
    if (!bar) return;

    const docId = Reader.getCurrentDocId();
    if (!docId) { bar.hidden = true; return; }

    const read = FolioStore.getCurrentRead(docId);
    if (!read) { bar.hidden = true; return; }

    bar.hidden = false;

    const label = document.getElementById("comments-read-label");
    const dot = document.getElementById("comments-read-dot");
    if (dot) dot.className = "read-dot hl-" + read.color;
    if (label) {
      /*
       * A named read shows its name and drops the month; an unnamed one shows
       * the month, which is the only thing that tells the reads apart. The
       * full label goes in the tooltip either way, so nothing is lost to the
       * strip being one line wide.
       */
      const when = readDateLabel(read);
      const named = !!(read.name && read.name.trim());
      label.textContent = FolioStore.readLabel(read) + (named || !when ? "" : " \u00b7 " + when);
      label.title = FolioStore.readLabel(read) + (when ? " \u00b7 " + when : "") +
                    " \u2014 click to rename or delete a read";
    }
  }

  /*
   * WHAT THIS DOES:
   * Opens the reads manager — one panel listing every read on this document,
   * where each can be given a name or deleted.
   *
   * WHY IT IS A PANEL AND NOT MORE BUTTONS ON THE BAR:
   * Renaming and deleting apply to ANY read, not just the one you are in, so
   * the controls need a list to hang off. Putting them on the bar would both
   * crowd a strip that already has a button and leave no way to touch an older
   * read at all.
   *
   * WHY RENAMING IS AN INPUT RATHER THAN A SECOND DIALOG:
   * Naming reads is something you do to several at once, after the fact —
   * "that was the skim, that was the close read". A dialog per read would make
   * that four dialogs.
   */
  function openReadsManager() {
    const docId = Reader.getCurrentDocId();
    if (!docId) {
      notice("Open a document first \u2014 reads belong to the page you are reading.");
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal reads-manager">
        <h3>Reads</h3>
        <div class="reads-rows"></div>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Done</button>
        </div>
      </div>`;

    const rows = overlay.querySelector(".reads-rows");

    // Redrawn in place after a rename or a delete, so the list and the counts
    // never show a state that has already changed underneath them.
    function draw() {
      const reads = FolioStore.ensureReads(docId);
      const comments = FolioStore.getComments(docId);
      const highlights = FolioStore.getHighlights(docId);
      const currentId = reads.length ? reads[reads.length - 1].id : null;

      rows.innerHTML = "";
      // Newest first, matching the comment list and the export chooser.
      reads.slice().reverse().forEach((r) => {
        const nComments = comments.filter((c) => c.readId === r.id).length;
        const nHighlights = highlights.filter((h) => h.readId === r.id).length;
        const when = readDateLabel(r);

        const row = document.createElement("div");
        row.className = "reads-row" + (r.id === currentId ? " is-current" : "");
        row.innerHTML = `
          <div class="reads-row-head">
            <span class="read-dot hl-${r.color}"></span>
            <span class="reads-row-title">Read ${r.n}${when ? " \u00b7 " + escapeHtml(when) : ""}</span>
            ${r.id === currentId ? '<span class="reads-row-current">current</span>' : ""}
            <span class="reads-row-count">${nComments} comment${nComments === 1 ? "" : "s"}, ${
              nHighlights} highlight${nHighlights === 1 ? "" : "s"}</span>
          </div>
          <div class="reads-row-actions">
            <input class="reads-row-name" type="text" maxlength="60"
                   placeholder="Give this read a name"
                   value="${escapeHtml(r.name || "")}" />
            <button class="modal-btn reads-row-delete">Delete</button>
          </div>`;

        const input = row.querySelector(".reads-row-name");
        const commit = () => {
          const before = (r.name || "").trim();
          const after = input.value.trim();
          if (before === after) return;
          FolioStore.renameRead(docId, r.id, after);
          renderReadBar();
          renderComments();
          draw();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
          if (e.key === "Escape") { input.value = r.name || ""; input.blur(); }
        });

        const del = row.querySelector(".reads-row-delete");
        if (reads.length <= 1) {
          /*
           * The only read cannot go. Every comment points at a read, so with
           * none left they would point at nothing — and the migration will not
           * rebuild one, because they already carry a readId. Disabled with
           * the reason attached rather than hidden, so the absence is
           * explained rather than mysterious.
           */
          del.disabled = true;
          del.title = "A document always keeps at least one read";
        } else {
          del.addEventListener("click", () => confirmDeleteRead(docId, r, draw));
        }

        rows.appendChild(row);
      });
    }

    draw();

    const close = () => overlay.remove();
    overlay.querySelector(".cancel-btn").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });

    document.body.appendChild(overlay);
  }

  /*
   * Confirm deleting a read, saying up front exactly where the writing goes.
   *
   * The sentence matters more than the dialog does. "Delete" sounds like
   * losing something, and here nothing is lost — the comments and highlights
   * move to the neighbouring read — so the dialog's job is to say so before
   * the press rather than reassure afterwards.
   */
  function confirmDeleteRead(docId, read, after) {
    const reads = FolioStore.ensureReads(docId);
    const i = reads.findIndex((r) => r.id === read.id);
    const into = i > 0 ? reads[i - 1] : reads[1];

    const comments = FolioStore.getComments(docId).filter((c) => c.readId === read.id).length;
    const highlights = FolioStore.getHighlights(docId).filter((h) => h.readId === read.id).length;

    const moving = comments || highlights
      ? `Its ${comments} comment${comments === 1 ? "" : "s"} and ${highlights} highlight${
          highlights === 1 ? "" : "s"} move into ${escapeHtml(FolioStore.readLabel(into))}.
         Nothing you wrote is deleted.`
      : "It has nothing written in it.";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <h3>Delete ${escapeHtml(FolioStore.readLabel(read))}?</h3>
        <p class="modal-body">${moving}</p>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
          <button class="modal-btn primary confirm-btn">Delete read</button>
        </div>
      </div>`;

    const close = () => overlay.remove();
    overlay.querySelector(".cancel-btn").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".confirm-btn").onclick = () => {
      const res = FolioStore.deleteRead(docId, read.id);
      close();
      if (!res.ok) {
        notice(res.reason === "last"
          ? "A document always keeps at least one read."
          : "That read is no longer there.");
        return;
      }
      /*
       * The marks on the page are coloured by their read, and deleteRead
       * restamps the ones it moved — so the page has to be repainted or it
       * keeps showing the colour of a read that no longer exists.
       *
       * syncHighlightColors, NOT applyHighlights: the latter skips any text
       * already inside a mark (so that calling it twice cannot nest marks),
       * which means it silently refuses to touch the very marks that need
       * changing. That looked like it worked and did nothing.
       */
      if (typeof Highlights !== "undefined" && Highlights.syncHighlightColors) {
        Highlights.syncHighlightColors(docId);
      }
      renderReadBar();
      renderComments();
      if (typeof after === "function") after();
      notice(
        res.movedComments || res.movedHighlights
          ? `Deleted. ${res.movedComments} comment${res.movedComments === 1 ? "" : "s"} moved into ` +
            FolioStore.readLabel(res.into) + "."
          : "Deleted."
      );
    };

    document.body.appendChild(overlay);
  }

  /*
   * WHAT THIS DOES:
   * Asks which read a comment should be filed under, and whether to MOVE it
   * there or leave a copy in both.
   *
   * WHY BOTH VERBS, AND WHY THEY SIT ON THE SAME ROW:
   * Moving is for the mistake — you forgot to press "New read" and wrote three
   * comments before remembering, and they are in the wrong pass. Copying is
   * for the thought that is true in both passes: "never understood this
   * properly" is as true in October as it was in March, and an October export
   * that dropped it would be missing something you still think.
   *
   * Two buttons on each read's row rather than a mode switch at the top,
   * because a mode is a thing you can misread — press Copy believing you are
   * in Move and the mistake is silent until an export looks wrong. Naming the
   * verb on the button you actually press leaves nothing to misread.
   */
  function openMoveComment(comment) {
    const docId = Reader.getCurrentDocId();
    if (!docId) return;

    const reads = FolioStore.ensureReads(docId);
    if (reads.length <= 1) {
      notice("There is only one read on this page, so there is nowhere to move it.");
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const rows = reads.slice().reverse().map((r) => {
      const when = readDateLabel(r);
      const here = r.id === comment.readId;
      return `
        <div class="read-pick-row${here ? " is-here" : ""}">
          <span class="read-pick-name">
            <span class="read-dot hl-${r.color}"></span>
            ${escapeHtml(FolioStore.readLabel(r))}${when ? " \u00b7 " + escapeHtml(when) : ""}
          </span>
          ${here
            ? '<span class="read-pick-here">it is here now</span>'
            : `<button class="modal-btn read-pick-move" data-read="${escapeHtml(r.id)}"
                       title="File it under this read instead">Move</button>
               <button class="modal-btn read-pick-copy" data-read="${escapeHtml(r.id)}"
                       title="Leave it where it is and put a copy under this read">Copy</button>`}
        </div>`;
    }).join("");

    overlay.innerHTML = `
      <div class="modal reads-manager">
        <h3>Move or copy this comment</h3>
        <p class="modal-body">Move files it under another read. Copy leaves it where it is
          and puts a second copy there, so it counts in both.</p>
        <div class="read-pick-rows">${rows}</div>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
        </div>
      </div>`;

    const close = () => overlay.remove();
    overlay.querySelector(".cancel-btn").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });

    const labelFor = (readId) => {
      const r = FolioStore.getReads(docId).find((x) => x.id === readId);
      return FolioStore.readLabel(r);
    };

    overlay.querySelectorAll(".read-pick-move").forEach((btn) => {
      btn.addEventListener("click", () => {
        const res = FolioStore.setCommentRead(docId, comment.id, btn.dataset.read);
        close();
        if (!res.ok) { notice("Could not move that comment."); return; }
        /*
         * A move can recolour the highlight, because the mark on the page is
         * painted in its read's colour. Repaint, or the article keeps showing
         * the old one.
         */
        if (res.movedHighlight && typeof Highlights !== "undefined" && Highlights.syncHighlightColors) {
          Highlights.syncHighlightColors(docId);
        }
        renderComments();
        notice("Moved to " + labelFor(btn.dataset.read) +
               (res.movedHighlight ? ", with its highlight." : "."));
      });
    });

    overlay.querySelectorAll(".read-pick-copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        const res = FolioStore.copyCommentToRead(docId, comment.id, btn.dataset.read);
        close();
        if (!res.ok) { notice("Could not copy that comment."); return; }
        // Nothing moved and no colour changed, so the article is untouched.
        renderComments();
        notice("Copied into " + labelFor(btn.dataset.read) + ". The original stays where it was.");
      });
    });

    document.body.appendChild(overlay);
  }

  /*
   * Begin a new read on the open document.
   *
   * Deliberately NOT confirmed with a dialog. It creates a record and changes
   * nothing that existed — every old comment and highlight is untouched and
   * still on screen — so there is nothing here to warn about. The one thing
   * worth saying is said afterwards, as a notice naming the read that started.
   */
  function startNewRead() {
    const docId = Reader.getCurrentDocId();
    if (!docId) {
      notice("Open a document first \u2014 a read belongs to the page you are reading.");
      return;
    }
    const read = FolioStore.startNewRead(docId);
    renderReadBar();
    renderComments();
    notice(
      FolioStore.readLabel(read) + " started. Comments from here on are grouped under it."
    );
  }

  // ==========================================================================
  // GEOMETRY PERSISTENCE — remember where/how big the panel was last time
  // ==========================================================================

  /*
   * Panel geometry is stored under a single settings key so it survives across
   * sessions and across docs. Shape:
   *   {
   *     mode: "floating" | "docked",
   *     x, y: floating position (px from top-left of viewport)
   *     width, height: floating size
   *   }
   * We clamp everything into the current viewport on load so a resize down
   * doesn't leave the panel off-screen.
   */
  function getSavedGeometry() {
    const settings = FolioStore.getSettings();
    return settings.commentsGeometry || null;
  }

  function saveGeometry(geom) {
    const settings = FolioStore.getSettings();
    settings.commentsGeometry = geom;
    FolioStore.saveSettings(settings);
  }

  function restoreGeometry() {
    const g = getSavedGeometry();
    if (!g) return; // fall back to CSS defaults

    if (g.mode === "docked") {
      panel.classList.add("docked");
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.width = (g.width || 360) + "px";
      panel.style.height = "";
      return;
    }

    // Floating — clamp into viewport so a re-open after a window resize is safe
    panel.classList.remove("docked");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(g.width || 320, vw - 40);
    const h = Math.min(g.height || 400, vh - 40);
    const x = Math.max(8, Math.min(g.x, vw - w - 8));
    const y = Math.max(8, Math.min(g.y, vh - h - 8));
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = w + "px";
    panel.style.height = h + "px";
  }

  // Capture current on-screen rect and persist it (floating or docked mode)
  function captureAndSaveGeometry() {
    if (panel.classList.contains("docked")) {
      saveGeometry({ mode: "docked", width: panel.getBoundingClientRect().width });
      return;
    }
    const r = panel.getBoundingClientRect();
    saveGeometry({
      mode: "floating",
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  // ==========================================================================
  // DRAG — grab the header to move the panel; snap-to-margin at right edge
  // ==========================================================================

  function initDrag() {
    if (!header) return;
    let dragging = false;
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;

    header.addEventListener("mousedown", (e) => {
      // Ignore clicks on header buttons (close, export)
      if (e.target.closest("button")) return;
      dragging = true;
      // If we were docked, undock into a floating card at the drag origin so
      // the drag feels natural (else the panel would jump from full-height).
      if (panel.classList.contains("docked")) {
        const r = panel.getBoundingClientRect();
        panel.classList.remove("docked");
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.width = r.width + "px";
        panel.style.height = r.height + "px";
      }
      const r = panel.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      panel.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const x = Math.max(0, Math.min(originLeft + dx, vw - w));
      const y = Math.max(0, Math.min(originTop + dy, vh - h));
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("dragging");

      // Snap-to-margin: if the panel's right edge is within the snap threshold
      // of the viewport's right edge, dock it so it acts like a margin column.
      const r = panel.getBoundingClientRect();
      const distToRight = window.innerWidth - r.right;
      if (distToRight <= SNAP_THRESHOLD_PX) {
        panel.classList.add("docked");
        panel.style.left = "";
        panel.style.top = "";
        panel.style.right = "";
        panel.style.bottom = "";
        panel.style.height = "";
        panel.style.width = Math.round(r.width) + "px";
      }
      captureAndSaveGeometry();
      enforceLayout();
    });
  }

  // ==========================================================================
  // RESIZE — bottom-right corner handle
  // ==========================================================================

  function initResize() {
    if (!resizeHandle) return;
    let resizing = false;
    let startX = 0, startY = 0;
    let startW = 0, startH = 0;

    resizeHandle.addEventListener("mousedown", (e) => {
      resizing = true;
      // If docked, undock into a floating card at the current on-screen rect
      // so the drag-to-resize feels 1:1 with the corner.
      if (panel.classList.contains("docked")) {
        const r = panel.getBoundingClientRect();
        panel.classList.remove("docked");
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.width = r.width + "px";
        panel.style.height = r.height + "px";
      }
      startX = e.clientX;
      startY = e.clientY;
      startW = panel.offsetWidth;
      startH = panel.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const dw = e.clientX - startX;
      const dh = e.clientY - startY;
      const w = Math.max(240, Math.min(startW + dw, window.innerWidth * 0.9));
      const h = Math.max(200, Math.min(startH + dh, window.innerHeight * 0.9));
      panel.style.width = w + "px";
      panel.style.height = h + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      captureAndSaveGeometry();
      enforceLayout();
    });
  }

  // Open the panel specifically for adding a comment to a highlight
  function openPanelForHighlight(highlightId) {
    activeHighlightId = highlightId;
    editingCommentId = null;
    creatingGeneralNote = false;
    openPanel();
    commentInput.value = "";
    commentInput.placeholder = "Add a comment...";
    resetInputHeight();
    commentInput.focus();
  }

  // Open the panel with the textarea primed for a general (page-level) note.
  // Same UX as commenting on a highlight, but no highlight id.
  function openPanelForNewNote() {
    activeHighlightId = null;
    editingCommentId = null;
    creatingGeneralNote = true;
    openPanel();
    commentInput.value = "";
    commentInput.placeholder = "Write a note about this page...";
    resetInputHeight();
    commentInput.focus();
  }

  // Close the panel
  function closePanel() {
    document.body.classList.remove("comments-docked");
    panel.classList.remove("open");
    activeHighlightId = null;
    editingCommentId = null;
    commentInput.value = "";
    resetInputHeight();
    // If a voice recording was in progress, cancel it so the mic stays freed
    if (voiceHandle && typeof Voice !== "undefined") {
      Voice.cancelRecording(voiceHandle);
      voiceHandle = null;
      const btn = document.getElementById("comment-mic-btn");
      if (btn) {
        btn.classList.remove("recording", "processing");
        btn.disabled = false;
      }
    }
  }

  // Grow the textarea to fit its content, up to the max-height set in CSS.
  // Called on every input event so typing feels like a growing note pad.
  function autoGrowInput() {
    if (!commentInput) return;
    commentInput.style.height = "auto";
    commentInput.style.height = commentInput.scrollHeight + "px";
  }
  function resetInputHeight() {
    if (!commentInput) return;
    commentInput.style.height = "";
  }

  // ==========================================================================
  // RENDERING — Build the comment list in the panel
  // ==========================================================================

  function renderComments() {
    const docId = Reader.getCurrentDocId();

    // Keep the read strip in step with the list. Done here rather than at each
    // call site so no future path can redraw the comments and leave the bar
    // naming a read you have already moved on from.
    renderReadBar();

    if (!docId) {
      commentsList.innerHTML =
        '<div class="comments-empty">Open a document to see comments.</div>';
      return;
    }

    const comments = FolioStore.getComments(docId);
    const highlights = FolioStore.getHighlights(docId);

    if (comments.length === 0) {
      commentsList.innerHTML =
        '<div class="comments-empty">No comments yet.<br>Highlight text and press <kbd>c</kbd>, or click "New note" above for a page-level note.</div>';
      return;
    }

    commentsList.innerHTML = "";

    // Sort comments by creation date (newest first)
    const sorted = [...comments].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    /*
     * Every read in this document, by id, plus which one is current.
     *
     * Only comments from an EARLIER read get a chip. Chipping the current
     * read's comments too would label every row in the panel with the same
     * thing, which tells you nothing and crowds out the text you came to read.
     * The chip answers one question — "is this me now, or me in March?" — and
     * absence of a chip is the answer "now".
     */
    const reads = FolioStore.ensureReads(docId);
    const readById = new Map(reads.map((r) => [r.id, r]));
    const currentId = reads.length ? reads[reads.length - 1].id : null;

    sorted.forEach((comment) => {
      // Three cases for the "context" label above a comment:
      //   1. General note   → italic "Note" label, no quote
      //   2. Orphaned       → highlight was deleted (comment.highlightId set,
      //                       but no matching highlight found)
      //   3. Attached       → matching highlight found → show quoted text
      const hl = comment.highlightId
        ? highlights.find((h) => h.id === comment.highlightId)
        : null;
      const isGeneral = !!comment.isGeneral || comment.highlightId === null;
      const isOrphan = !isGeneral && !!comment.highlightId && !hl;

      let contextHtml;
      if (isGeneral) {
        contextHtml = '<div class="comment-context-label">Note</div>';
      } else if (isOrphan) {
        contextHtml = '<div class="comment-context-label muted">(highlight removed)</div>';
      } else {
        /*
         * A transcript line carries its timestamp in a chip at the front, and
         * selecting the line sweeps the chip's text into the highlight — which
         * rendered as "20:14Excellent. No nickname…", the stamp glued to the
         * first word. Peel it back off and show it as a stamp.
         */
        const m = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/s.exec(hl.text || "");
        contextHtml = m
          ? `<div class="comment-highlight-text">` +
            `<span class="comment-stamp">${escapeHtml(m[1])}</span>` +
            `${escapeHtml(m[2])}</div>`
          : `<div class="comment-highlight-text">${escapeHtml(hl.text)}</div>`;
      }

      const entry = document.createElement("div");
      entry.className = "comment-entry" + (isGeneral ? " comment-entry-general" : "");
      entry.dataset.highlightId = comment.highlightId || "";

      const dateStr = new Date(comment.createdAt).toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric" }
      );

      /*
       * The read chip. An unstamped comment (one written before reads existed
       * AND somehow missed by the migration) gets no chip rather than a wrong
       * one — inventing a read for it would be a lie about when it was written.
       */
      const read = comment.readId ? readById.get(comment.readId) : null;
      const readChip =
        read && read.id !== currentId
          ? `<span class="comment-read-chip hl-${read.color}" title="Written during ${
              escapeHtml(FolioStore.readLabel(read))} ${escapeHtml(readDateLabel(read))
            }">${escapeHtml(FolioStore.readLabel(read))}</span>`
          : "";

      /*
       * A comment that was copied here from another read says so. Without it
       * you find what looks like the same sentence written twice and have no
       * way to tell whether you repeated yourself or filed it deliberately.
       */
      const from = comment.copiedFrom && comment.copiedFrom.readId
        ? readById.get(comment.copiedFrom.readId) : null;
      const copyMark = comment.copiedFrom
        ? `<span class="comment-copy-mark" title="Copied from ${
            from ? escapeHtml(FolioStore.readLabel(from)) : "another read"}">copied</span>`
        : "";

      entry.innerHTML = `
        ${contextHtml}
        <div class="comment-text">${escapeHtml(comment.text)}</div>
        <div class="comment-meta">
          <span class="comment-meta-left"><span>${dateStr}</span>${readChip}${copyMark}</span>
          <div class="comment-actions">
            ${reads.length > 1
              ? `<button class="move-comment" data-id="${comment.id}" title="Move or copy this comment to another read">Reads</button>`
              : ""}
            <button class="edit-comment" data-id="${comment.id}">Edit</button>
            <button class="delete-comment" data-id="${comment.id}">Delete</button>
          </div>
        </div>
      `;

      // Click to scroll to the highlight in the document — only meaningful if
      // the comment IS attached to a live highlight.
      entry.addEventListener("click", (e) => {
        if (e.target.closest(".comment-actions")) return;
        if (comment.highlightId && !isOrphan) scrollToHighlight(comment.highlightId);
      });

      // Edit button
      entry
        .querySelector(".edit-comment")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          startEditing(comment);
        });

      // Delete button
      entry
        .querySelector(".delete-comment")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          deleteComment(comment.id);
        });

      /*
       * Move button — only rendered when there is more than one read, since
       * with one read there is nowhere to move anything to.
       */
      const moveBtn = entry.querySelector(".move-comment");
      if (moveBtn) {
        moveBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openMoveComment(comment);
        });
      }

      commentsList.appendChild(entry);
    });
  }

  // ==========================================================================
  // COMMENT CRUD — Create, edit, delete comments
  // ==========================================================================

  // Save a new comment or update an existing one
  function saveComment() {
    const docId = Reader.getCurrentDocId();
    if (!docId) return;

    const text = commentInput.value.trim();
    if (!text) return;

    const comments = FolioStore.getComments(docId);

    if (editingCommentId) {
      // Update existing comment
      const idx = comments.findIndex((c) => c.id === editingCommentId);
      if (idx !== -1) {
        comments[idx].text = text;
        comments[idx].updatedAt = new Date().toISOString();
      }
      editingCommentId = null;
    } else if (activeHighlightId) {
      // Create new comment attached to a highlight
      comments.push({
        id: FolioStore.generateId("cm"),
        highlightId: activeHighlightId,
        readId: currentReadId(docId),
        text: text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else if (creatingGeneralNote) {
      // Create a page-level note (no highlight). isGeneral distinguishes it
      // from orphan comments whose highlight was removed after the fact.
      comments.push({
        id: FolioStore.generateId("cm"),
        highlightId: null,
        isGeneral: true,
        readId: currentReadId(docId),
        text: text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    FolioStore.saveComments(docId, comments);
    commentInput.value = "";
    resetInputHeight();
    activeHighlightId = null;
    creatingGeneralNote = false;
    commentInput.placeholder = "Add a comment...";
    renderComments();
  }

  /*
   * Save a comment against a highlight without opening the panel.
   *
   * Read-aloud uses this for its dictate-and-resume loop: the point there is
   * to stay in flow, so popping the panel open (and stealing focus into the
   * textarea) would defeat it. Returns the new comment's id.
   */
  /*
   * `docId` is optional and defaults to the open document. Pass it explicitly
   * when saving something that was captured earlier — a dictation held while
   * offline, say — otherwise a retry that lands after the reader has moved on
   * would file the comment against whatever document happens to be open.
   */
  function addComment(highlightId, text, docId, videoTime) {
    docId = docId || Reader.getCurrentDocId();
    if (!docId || !text || !text.trim()) return null;

    const comments = FolioStore.getComments(docId);
    const id = FolioStore.generateId("cm");
    const rec = {
      id: id,
      highlightId: highlightId || null,
      isGeneral: !highlightId,
      readId: currentReadId(docId),
      text: text.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    /*
     * A comment made on a video before its transcript exists has no line to
     * attach to, so we record WHERE IN THE VIDEO it was spoken. Once the
     * transcript arrives that timestamp identifies the line, and the comment
     * gets re-pointed at it — see Video.reconcileTimedComments.
     */
    /*
     * Kept whether or not a highlight exists. It used to be stored only for
     * comments with no highlight, on the reasoning that an attached comment
     * already knows its line — but that threw away the one piece of
     * information that is unambiguous. When a transcript repeats itself, the
     * line text matches in eighty places and the moment matches in one.
     */
    if (typeof videoTime === "number" && isFinite(videoTime)) {
      rec.videoTime = videoTime;
    }
    comments.push(rec);
    FolioStore.saveComments(docId, comments);

    // Keep the panel current if it happens to be open on that same doc.
    if (panel.classList.contains("open") && docId === Reader.getCurrentDocId()) {
      renderComments();
    }
    return id;
  }

  /*
   * Comments still waiting to be matched to a transcript line: anchored to a
   * moment in the video, but not yet to any text.
   */
  function listTimed(docId) {
    docId = docId || Reader.getCurrentDocId();
    if (!docId) return [];
    return FolioStore.getComments(docId)
      .filter((c) => typeof c.videoTime === "number" && !c.highlightId);
  }

  /*
   * Detach a note from its highlight and pin it to a MOMENT instead.
   *
   * Used before a transcript is regenerated: the new text will not contain the
   * old highlight's range, so the anchor has to become the timestamp, which
   * survives any amount of rewriting. reconcileTimedComments picks it up again
   * once the new lines land.
   *
   * This must run BEFORE any highlight is deleted. Highlights.removeHighlight
   * deletes the comments attached to a highlight along with it, so unanchoring
   * first is what keeps the note rather than losing it with its anchor.
   */
  function unanchor(docId, commentId, videoTime) {
    docId = docId || Reader.getCurrentDocId();
    if (!docId || !commentId) return false;
    const comments = FolioStore.getComments(docId);
    const c = comments.find((x) => x.id === commentId);
    if (!c) return false;

    if (typeof videoTime === "number" && isFinite(videoTime)) c.videoTime = videoTime;
    // With no moment to re-anchor by, detaching would strand it. Leave it.
    if (typeof c.videoTime !== "number" || !isFinite(c.videoTime)) return false;

    c.highlightId = null;
    c.isGeneral = false;
    c.updatedAt = new Date().toISOString();
    FolioStore.saveComments(docId, comments);
    return true;
  }

  // Re-point a comment at a highlight once one exists for its moment.
  function attachToHighlight(docId, commentId, highlightId) {
    docId = docId || Reader.getCurrentDocId();
    if (!docId || !commentId || !highlightId) return false;
    const comments = FolioStore.getComments(docId);
    const c = comments.find((x) => x.id === commentId);
    if (!c) return false;
    c.highlightId = highlightId;
    c.isGeneral = false;
    c.updatedAt = new Date().toISOString();
    FolioStore.saveComments(docId, comments);
    if (panel.classList.contains("open") && docId === Reader.getCurrentDocId()) {
      renderComments();
    }
    return true;
  }

  // Start editing an existing comment
  function startEditing(comment) {
    editingCommentId = comment.id;
    activeHighlightId = comment.highlightId;
    commentInput.value = comment.text;
    commentInput.placeholder = "Edit comment...";
    commentInput.focus();
    // Grow to fit the loaded text right away
    autoGrowInput();
  }

  // Delete a comment
  function deleteComment(commentId) {
    const docId = Reader.getCurrentDocId();
    if (!docId) return;

    let comments = FolioStore.getComments(docId);
    comments = comments.filter((c) => c.id !== commentId);
    FolioStore.saveComments(docId, comments);
    renderComments();
  }

  // ==========================================================================
  // SCROLL TO HIGHLIGHT — Navigate to and pulse a highlight in the document
  // ==========================================================================

  function scrollToHighlight(highlightId) {
    const mark = document.querySelector(
      `mark[data-highlight-id="${highlightId}"]`
    );
    /*
     * Nothing on the page carries that id. This used to return in silence, so
     * clicking a comment did nothing at all and there was no way to tell
     * whether the click had even registered.
     */
    if (!mark) {
      if (typeof TTS !== "undefined" && TTS.toast) {
        TTS.toast("That passage isn’t on this page any more — the text it marked has changed.", 3400);
      }
      return;
    }

    // Scroll the highlight into view
    mark.scrollIntoView({ behavior: "smooth", block: "center" });

    // Add a pulsing animation to draw attention
    mark.classList.add("pulsing");
    setTimeout(() => mark.classList.remove("pulsing"), 1500);
  }

  /*
   * The mirror of scrollToHighlight — given a highlight, bring the comment
   * written about it into view.
   *
   * The link between the two used to run one way only. Clicking a comment
   * scrolled to its highlight, but clicking the highlight showed just the small
   * popover, so a comment you had already written stayed invisible unless you
   * happened to spot it in the list.
   *
   * Returns false when the highlight has no comments, so the caller can leave
   * the panel closed rather than throwing an empty one over the text.
   */
  function revealCommentsFor(highlightId) {
    if (!highlightId) return false;

    const docId = Reader.getCurrentDocId();
    if (!docId) return false;

    const has = FolioStore.getComments(docId)
      .some((c) => c.highlightId === highlightId);
    if (!has) return false;

    openPanel();

    /*
     * Wait a frame. openPanel() has only just added the class that gives the
     * panel its size, and scrolling inside a box the browser has not laid out
     * yet silently does nothing.
     */
    requestAnimationFrame(() => {
      const entry = commentsList.querySelector(
        `.comment-entry[data-highlight-id="${highlightId}"]`
      );
      if (!entry) return;
      entry.scrollIntoView({ behavior: "smooth", block: "center" });
      entry.classList.add("pulsing");
      setTimeout(() => entry.classList.remove("pulsing"), 1500);
    });

    return true;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /*
   * Non-blocking notice — see Video.notify. A modal in the middle of watching
   * or dictating is worse than the problem it reports.
   */
  function notice(msg) {
    if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(escapeHtml(String(msg)), 3600);
    else console.warn("[folio]", msg);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ==========================================================================
   * DATING A THOUGHT — the label every export puts in front of a comment
   * ==========================================================================
   * Every export used to introduce a comment with a bare arrow:
   *
   *     - "quoted highlight text"
   *       → the thing I thought
   *
   * which says nothing about WHEN the thought was had. That is the one fact
   * these exports exist to carry: the whole point of re-reading a document is
   * to see what a passage did to you in March and what it does to you now, and
   * two undated lines under one quote cannot tell you which is which — or even
   * which came first.
   *
   *     - "quoted highlight text"
   *       **MY THOUGHT ON MAR 2, 2026:** the thing I thought then
   *       **MY THOUGHT ON SEP 5, 2026:** what I think about it now
   *
   * THE YEAR IS ALWAYS THERE, and that is a deliberate departure from the
   * panel, which shows a bare "Sep 5". The panel is about now; an export is
   * kept, and a file holding one read from 2024 and another from 2026 with
   * both labelled "SEP 5" would be worse than useless. An export is read at an
   * unknown distance from the day it was written.
   */

  /*
   * The date a thought was actually HAD, which is not always the date on the
   * record.
   *
   * A comment copied into another read is a NEW record, created today, holding
   * a thought you had months ago. Dating the copy today would put a sentence
   * you wrote in March into September's column — which corrupts the exact
   * comparison this label exists to support. So a copy is dated by its
   * original whenever that date was kept.
   */
  function thoughtDate(c) {
    if (!c) return null;
    if (c.copiedFrom && c.originalCreatedAt) return c.originalCreatedAt;
    return c.createdAt || null;
  }

  function thoughtLabel(c) {
    const when = thoughtDate(c);
    const d = when ? new Date(when) : null;
    /*
     * An undated comment gets "MY THOUGHT" with no date rather than an invented
     * one. Every comment Folio has ever written carries a createdAt, so this
     * only fires for a hand-edited or half-imported record — and in that case
     * a missing date is the honest thing to show.
     */
    if (!d || isNaN(d.getTime())) return "MY THOUGHT";
    const stamp = d.toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    }).toUpperCase();
    /*
     * "(copied)" earns its place: without it, the same sentence appearing
     * under two reads with the SAME date reads as a bug in the export rather
     * than as something you deliberately carried forward.
     */
    return "MY THOUGHT ON " + stamp + (c.copiedFrom ? " (copied)" : "");
  }

  /* Oldest first. Dating the thoughts is only half of showing how they
   * changed; they also have to come out in the order you had them. */
  function byThoughtDate(a, b) {
    return new Date(thoughtDate(a) || 0) - new Date(thoughtDate(b) || 0);
  }

  // ==========================================================================
  // EXPORT — dump highlights + comments as a markdown bulleted list
  // ==========================================================================

  /*
   * Format:
   *   # Highlights & comments — <doc title>
   *   _Exported <date>_
   *
   *   - "quoted highlight text"
   *     **MY THOUGHT ON MAR 2, 2026:** what I thought the first time
   *     **MY THOUGHT ON SEP 5, 2026:** what I think now
   *
   *   - "another highlight, no comment"
   *
   * Design decisions (per plan):
   *   • Include highlights WITHOUT comments (option A) — they're breadcrumbs too
   *   • Order by highlight creation time so the export reads chronologically
   *   • Several thoughts on one passage come out OLDEST FIRST, so the column
   *     under a quote reads as a progression rather than as storage order
   *   • Multi-line comments preserved via a blockquote-style indent
   *   • Markdown only (JSON round-trip is handled by the general backup feature)
   */
  function exportAnnotations() {
    const docId = Reader.getCurrentDocId();
    if (!docId) {
      notice("Open a document first — export works on the page you're viewing.");
      return;
    }

    const doc = FolioStore.getDocument(docId);
    const highlights = FolioStore.getHighlights(docId);
    const comments = FolioStore.getComments(docId);

    /*
     * A video document exports differently: the whole transcript, with your
     * comments sitting under the lines they belong to. Exporting only the
     * commented lines would strip out the thing that gives them meaning.
     */
    const blocks = (doc && doc.content && doc.content.blocks) || [];
    const isVideo = blocks.some((b) => b.type === "video");

    if (!highlights.length && !comments.length && !blocks.length) {
      notice("Nothing to export yet.");
      return;
    }

    /*
     * Two exports, because they answer different questions and neither
     * replaces the other.
     *
     * The whole document with comments inline is what you want when the
     * document is the point and your notes are annotations on it. A digest of
     * just the highlighted passages is what you want when YOUR NOTES are the
     * point and the document was only where you found them — the difference
     * between re-reading a chapter and reviewing what you marked in it.
     *
     * This used to export only the digest, then only the full document. Asking
     * is better than guessing which of those someone meant.
     */
    /*
     * Two questions, in this order: what shape of file, then which read.
     *
     * Kind first because it is the question you always have an answer to. The
     * read question does not even appear on a document you have only read once,
     * so for most exports this is still a single click.
     */
    chooseExport(isVideo, function (kind) {
      chooseRead(docId, function (readId) { runExport(kind, docId, readId); });
    });
  }

  /*
   * Do one specific export. Separated from the chooser so that both are
   * reachable directly — by a test that means a particular one, and by anything
   * that already knows which is wanted.
   */
  function runExport(kind, docId, readId) {
    const id = docId || Reader.getCurrentDocId();
    if (!id) { notice("Open a document first."); return; }

    const doc = FolioStore.getDocument(id);
    let highlights = FolioStore.getHighlights(id);
    let comments = FolioStore.getComments(id);
    const blocks = (doc && doc.content && doc.content.blocks) || [];

    /*
     * `readId` null means every read — the consolidated export. Anything else
     * narrows to one read, using the inclusion rule in sliceByRead (which is
     * where the subtlety lives; read its comment before changing this).
     */
    const reads = FolioStore.ensureReads(id);
    const scopeRead = readId ? reads.find((r) => r.id === readId) || null : null;
    if (scopeRead) {
      const slice = sliceByRead(scopeRead.id, highlights, comments);
      highlights = slice.highlights;
      comments = slice.comments;
      if (!highlights.length && !comments.length) {
        notice("Nothing written during " + FolioStore.readLabel(scopeRead) + " yet.");
        return;
      }
    }

    // Everything the export writers need to know about reads, in one object so
    // adding a field later does not mean changing three signatures.
    const ctx = {
      reads: reads,
      readById: new Map(reads.map((r) => [r.id, r])),
      scopeRead: scopeRead,
      // Only worth labelling reads inside a file when there are several and we
      // did not already narrow to one.
      labelReads: !scopeRead && reads.length > 1,
    };

    console.log(
      `[reads] export kind=${kind} scope=${scopeRead ? FolioStore.readLabel(scopeRead) : "all reads"} ` +
      `highlights=${highlights.length} comments=${comments.length}`
    );

    if (kind === "digest") return exportHighlightsDigest(doc, highlights, comments, ctx);
    if (blocks.some((b) => b.type === "video")) {
      return exportTranscript(doc, blocks, highlights, comments, ctx);
    }
    return exportTextDocument(doc, blocks, highlights, comments, ctx);
  }

  /*
   * WHAT THIS DOES:
   * Asks which read to export, and calls done(readId) — or done(null) meaning
   * every read in one file.
   *
   * WHY IT SOMETIMES ASKS NOTHING:
   * A document you have read once has a single read, so there is no choice to
   * make. Showing a chooser with one option would be a dialog that exists only
   * to be dismissed, so it calls done(null) straight away.
   */
  function chooseRead(docId, done) {
    const reads = FolioStore.ensureReads(docId);
    if (reads.length <= 1) return done(null);

    const comments = FolioStore.getComments(docId);
    const countFor = (rid) => comments.filter((c) => c.readId === rid).length;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    // Newest first: re-reading something is the reason this chooser exists, so
    // the read you have just finished is the one you most likely want.
    const rows = reads
      .slice()
      .reverse()
      .map((r) => {
        const n = countFor(r.id);
        const when = readDateLabel(r);
        return `
        <button class="export-option" data-read="${escapeHtml(r.id)}">
          <span class="export-option-title">
            <span class="read-dot hl-${r.color}"></span>
            ${escapeHtml(FolioStore.readLabel(r))}${when ? " \u00b7 " + escapeHtml(when) : ""}
          </span>
          <span class="export-option-desc">${n} comment${n === 1 ? "" : "s"} written during this read.</span>
        </button>`;
      })
      .join("");

    overlay.innerHTML = `
      <div class="modal export-choice">
        <h3>Which read?</h3>
        ${rows}
        <button class="export-option" data-read="__all__">
          <span class="export-option-title">All reads, in one file</span>
          <span class="export-option-desc">Everything you have ever written about this
            document, with each comment labelled by the read it came from.</span>
        </button>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
        </div>
      </div>`;

    const close = () => overlay.remove();
    overlay.querySelector(".cancel-btn").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll(".export-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        close();
        const v = btn.dataset.read;
        done(v === "__all__" ? null : v);
      });
    });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });

    document.body.appendChild(overlay);
  }

  /*
   * The slug that goes in an export's file name, so two exports of the same
   * document on the same day do not overwrite each other in the Downloads
   * folder. "read-2" or "all-reads".
   */
  function readFileTag(ctx) {
    if (ctx && ctx.scopeRead) return `read-${ctx.scopeRead.n}`;
    if (ctx && ctx.reads && ctx.reads.length > 1) return "all-reads";
    return "";
  }

  // Joins the file-name parts that are present, so a single-read document
  // keeps the old file name exactly as it was.
  function exportFileName(safeTitle, middle, ctx, today) {
    const tag = readFileTag(ctx);
    return [safeTitle, middle, tag, today].filter(Boolean).join("-") + ".md";
  }

  /*
   * Ask which export is wanted.
   *
   * The wording says what you GET rather than naming a format, because
   * "annotations" and "transcript" mean nothing until you have seen both.
   */
  function chooseExport(isVideo, done) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const fullLabel = isVideo ? "Full transcript" : "Full document";
    const fullDesc = isVideo
      ? "Every line of the transcript, with your comments under the moment they belong to."
      : "The whole document, with each comment inline under the passage it is about.";

    overlay.innerHTML = `
      <div class="modal export-choice">
        <h3>Export</h3>
        <button class="export-option" data-kind="full">
          <span class="export-option-title">${fullLabel}</span>
          <span class="export-option-desc">${fullDesc}</span>
        </button>
        <button class="export-option" data-kind="digest">
          <span class="export-option-title">Highlights &amp; comments only</span>
          <span class="export-option-desc">Just the passages you highlighted and what you
            wrote about them, plus your page notes. Without the rest of the ${
              isVideo ? "transcript" : "document"}.</span>
        </button>
        <div class="modal-actions">
          <button class="modal-btn cancel-btn">Cancel</button>
        </div>
      </div>`;

    const close = () => overlay.remove();
    overlay.querySelector(".cancel-btn").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll(".export-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        close();
        done(btn.dataset.kind);
      });
    });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });

    document.body.appendChild(overlay);
  }

  /*
   * ==========================================================================
   * EXPORT: JUST WHAT YOU MARKED
   * ==========================================================================
   * The passages you highlighted, what you wrote about each, and your
   * page-level notes — without the document around them.
   *
   * READ ONLY, like the other exports: it reads and writes a file, and calls
   * nothing that saves.
   */
  function exportHighlightsDigest(doc, highlights, comments, ctx) {
    if (!highlights.length && !comments.length) {
      notice("No highlights or comments to export yet.");
      return;
    }

    const title = (doc && doc.meta && doc.meta.title) || "Untitled";
    const today = new Date().toISOString().slice(0, 10);
    const safeTitle = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "notes";

    const lines = [];
    lines.push(`# Highlights & comments — ${title}`);
    lines.push(`_Exported ${today}_`);
    if (ctx && ctx.scopeRead) {
      const when = readDateLabel(ctx.scopeRead);
      lines.push(`_${FolioStore.readLabel(ctx.scopeRead)}${when ? " · " + when : ""}_`);
    }
    lines.push("");

    /*
     * THE CONSOLIDATED CASE — every read, one section each, oldest first.
     *
     * Written this way so the file reads as the history of your thinking about
     * a document rather than as one undated heap: what you noticed in March
     * sits under its own heading, what you noticed in October under another.
     *
     * Each section is built by digestBody, the same function that builds a
     * single-read digest. That is deliberate: two copies of this formatting
     * would be free to drift apart, and the whole value of the per-read export
     * is that a section looks the same whether it is alone in a file or one of
     * five.
     */
    if (ctx && ctx.labelReads) {
      let wrote = 0;
      ctx.reads.forEach((r) => {
        const slice = sliceByRead(r.id, highlights, comments);
        if (!slice.highlights.length && !slice.comments.length) return;
        const when = readDateLabel(r);
        lines.push(`## ${FolioStore.readLabel(r)}${when ? " · " + when : ""}`);
        lines.push("");
        digestBody(lines, slice.highlights, slice.comments, 3);
        wrote++;
      });

      /*
       * A note with no readId belongs to no read, so the loop above skipped it.
       * That should not happen — the migration stamps everything — but if it
       * ever does, the note is written out under its own heading rather than
       * silently dropped. Losing something the user wrote is the one outcome
       * this whole feature exists to prevent.
       */
      const known = new Set(ctx.reads.map((r) => r.id));
      const strandedComments = comments.filter((c) => !known.has(c.readId));
      const strandedHighlights = highlights.filter((h) => !known.has(h.readId));
      if (strandedComments.length || strandedHighlights.length) {
        console.warn(
          `[reads] ${strandedComments.length} comments and ${strandedHighlights.length} ` +
          `highlights belong to no known read — exported under "Not filed under a read"`
        );
        lines.push("## Not filed under a read");
        lines.push("");
        digestBody(lines, strandedHighlights, strandedComments, 3);
        wrote++;
      }

      if (!wrote) { notice("No highlights or comments to export yet."); return; }

      downloadBlob(
        lines.join("\n"),
        exportFileName(safeTitle, "highlights", ctx, today),
        "text/markdown"
      );
      return;
    }

    digestBody(lines, highlights, comments, 2);
    downloadBlob(
      lines.join("\n"),
      exportFileName(safeTitle, "highlights", ctx, today),
      "text/markdown"
    );
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Appends the body of a digest to `lines` — your page-level notes, then each
   * highlighted passage with its comments indented underneath, then any comment
   * whose passage has since been deleted.
   *
   * WHY IT IS SEPARATE FROM THE FUNCTION ABOVE:
   * The consolidated export calls it once per read; the single-read export
   * calls it once. One shared builder is what guarantees a read's section looks
   * the same in both files.
   *
   * WHAT `level` IS FOR:
   * The markdown heading depth for the sub-headings ("General notes",
   * "Highlights"). A single-read digest puts them at ##; inside a consolidated
   * file they sit under a "## Read 2" so they have to drop to ###.
   */
  function digestBody(lines, highlights, comments, level) {
    const h = "#".repeat(Math.max(2, level || 2));

    // Creation order, so the export roughly mirrors the order you read in.
    const sortedHighlights = [...highlights].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );

    // Page-level notes first — they are about the whole thing, not a quote.
    const generalNotes = comments.filter((c) => c.isGeneral || (c.highlightId === null));
    if (generalNotes.length) {
      lines.push(`${h} General notes`);
      lines.push("");
      generalNotes
        .sort(byThoughtDate)
        .forEach((c) => {
          const noteLines = (c.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
          if (!noteLines.length) return;
          // Dated like every other thought: a note about the whole page is
          // still something you thought on a particular day.
          lines.push(`- **${thoughtLabel(c)}:** ${noteLines[0]}`);
          noteLines.slice(1).forEach((l) => lines.push(`  ${l}`));
        });
      lines.push("");
      if (sortedHighlights.length) {
        lines.push(`${h} Highlights`);
        lines.push("");
      }
    }

    sortedHighlights.forEach((hl) => {
      // Collapse internal whitespace so a multi-line highlight reads as one quote.
      const quoteText = (hl.text || "").replace(/\s+/g, " ").trim();
      lines.push(`- "${quoteText}"`);
      /*
       * Oldest thought first. When a passage has been commented on across
       * several reads, this column IS the record of how your mind changed —
       * and in storage order it was just a pile.
       */
      comments.filter((c) => c.highlightId === hl.id).sort(byThoughtDate).forEach((c) => {
        // Indented so a comment visually attaches to its quote.
        const commentLines = (c.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
        commentLines.forEach((cl, i) => {
          lines.push(i === 0 ? `  **${thoughtLabel(c)}:** ${cl}` : `    ${cl}`);
        });
      });
      lines.push("");
    });

    /*
     * Comments whose highlight was deleted after the fact. Dropping them would
     * silently lose something the user wrote, so they are kept and labelled.
     */
    const orphans = comments.filter((c) =>
      !c.isGeneral && c.highlightId != null &&
      !highlights.some((h2) => h2.id === c.highlightId));
    if (orphans.length) {
      lines.push("---");
      lines.push("");
      lines.push("**Notes whose highlight was removed:**");
      lines.push("");
      orphans.sort(byThoughtDate)
             .forEach((c) => lines.push(`- **${thoughtLabel(c)}:** ${flatten(c.text)}`));
      lines.push("");
    }
  }

  /*
   * ==========================================================================
   * EXPORTING A TEXT DOCUMENT
   * ==========================================================================
   * The whole article, with every comment sitting under the passage it was
   * written about and labelled `COMMENT:`.
   *
   * This used to export a digest — a bullet list of quoted highlights with the
   * comments hanging off them — so the document itself never made it into the
   * file and a note was left without the context that gave it meaning. Video
   * documents already exported the full transcript with comments inline; this
   * is the same idea for pages that have no video.
   *
   * READ ONLY. It reads documents, highlights and comments and writes a file.
   * It never calls saveComments or saveHighlights, so exporting cannot alter or
   * lose anything you have written.
   */
  function exportTextDocument(doc, blocks, highlights, comments, ctx) {
    const title = (doc && doc.meta && doc.meta.title) || "Untitled";
    const today = new Date().toISOString().slice(0, 10);

    if (!blocks.length && !comments.length) {
      notice("Nothing to export yet.");
      return;
    }

    const hlById = new Map(highlights.map((h) => [h.id, h]));
    const norm = (v) => stripTags(String(v || "")).replace(/\s+/g, " ").trim();

    /* One markdown string per block, so comments can be dropped in between. */
    const asMarkdown = (b) =>
      (typeof SidebarUI !== "undefined" && SidebarUI.blockToMarkdown)
        ? SidebarUI.blockToMarkdown(b)
        : stripTags((b && b.data && b.data.text) || "");

    const rendered = blocks.map(asMarkdown);
    const searchable = rendered.map(norm);

    const perBlock = new Map();     // block index -> [{c, quote}]
    const loose = [];               // page-level notes, and passages now gone

    /*
     * Oldest first, so several comments on the same paragraph come out in the
     * order they were written rather than in whatever order storage held them.
     */
    [...comments]
      .sort(byThoughtDate)
      .forEach((c) => {
        const hl = c.highlightId != null ? hlById.get(c.highlightId) : null;
        const quote = hl ? norm(hl.text) : "";

        // A page-level note belongs to no passage at all.
        if (!quote) { loose.push({ c, quote: "" }); return; }

        let idx = searchable.findIndex((t) => t && t.indexOf(quote) !== -1);
        if (idx === -1) {
          /*
           * A highlight that runs across two blocks is contained by neither, so
           * fall back to its opening words — those do sit inside the first
           * block it covers.
           */
          const head = quote.slice(0, 40);
          if (head) idx = searchable.findIndex((t) => t && t.indexOf(head) !== -1);
        }

        // The passage is gone; keep the note rather than dropping it.
        if (idx === -1) { loose.push({ c, quote }); return; }

        if (!perBlock.has(idx)) perBlock.set(idx, []);
        perBlock.get(idx).push({ c, quote });
      });

    /*
     * Every line starts with MY THOUGHT ON <date> — the same label the digest
     * uses, so one habit reads both files — and names the passage when one is
     * known, so you can tell which part of a long paragraph a note was about.
     *
     * This replaced a bare "COMMENT". That was greppable, which was the point,
     * and "MY THOUGHT" greps just as well while also saying when. In a
     * document with notes from three different readings, the date is the only
     * thing that tells them apart as you scroll.
     */
    /*
     * A read prefix is added only when the file holds more than one read.
     *
     * The document itself cannot be grouped by read — it is linear, and
     * printing it once per read would be absurd — so for this export format
     * "which read" becomes a tag on each comment line instead of a heading.
     * On a single-read export the prefix is omitted entirely, which keeps the
     * file byte-identical to what this export produced before reads existed.
     */
    const readTag = (c) => {
      if (!ctx || !ctx.labelReads) return "";
      const r = c.readId ? ctx.readById.get(c.readId) : null;
      return r ? `[${FolioStore.readLabel(r)}] ` : "";
    };

    const commentLine = (c, quote) => {
      const head = `**${thoughtLabel(c)}**${readTag(c) ? " " + readTag(c).trim() : ""}`;
      return quote ? `${head} on "${quote}": ${flatten(c.text)}`
                   : `${head}: ${flatten(c.text)}`;
    };

    const out = [];
    out.push(`# ${title}`);
    out.push(`_Exported ${today}_`);
    if (ctx && ctx.scopeRead) {
      const when = readDateLabel(ctx.scopeRead);
      out.push(`_${FolioStore.readLabel(ctx.scopeRead)}${when ? " · " + when : ""} — comments from this read only_`);
    }
    out.push("");

    rendered.forEach((md, i) => {
      if (md && md.trim()) { out.push(md); out.push(""); }
      (perBlock.get(i) || []).forEach(({ c, quote }) => {
        out.push(commentLine(c, quote));
        out.push("");
      });
    });

    if (loose.length) {
      out.push("---");
      out.push("");
      out.push("## Notes not attached to a passage");
      out.push("");
      loose.forEach(({ c, quote }) => { out.push(commentLine(c, quote)); out.push(""); });
    }

    const safeTitle = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "notes";
    downloadBlob(
      out.join("\n"),
      exportFileName(safeTitle, "annotations", ctx, today),
      "text/markdown"
    );
  }

  // ==========================================================================
  // VOICE DICTATION — mic button in the textarea, powered by Voice module
  // ==========================================================================

  /*
   * Two states per session: idle or recording. Click toggles.
   * On stop → upload to Groq → insert transcript at the caret in
   * commentInput. Escape while recording cancels without uploading.
   *
   * We keep a module-level handle since only one recording can be active per
   * comment panel at a time; if the user closes the panel mid-recording, we
   * proactively cancel.
   */
  let voiceHandle = null;

  function initMicButton() {
    const btn = document.getElementById("comment-mic-btn");
    if (!btn || typeof Voice === "undefined") return;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (voiceHandle) {
        // Currently recording → stop and transcribe
        await stopAndInsert(btn);
      } else {
        // Idle → start recording
        await startVoice(btn);
      }
    });

    // Escape while recording cancels — but only if the textarea has focus,
    // else we'd fight the Escape handler on commentInput's keydown listener.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && voiceHandle) {
        Voice.cancelRecording(voiceHandle);
        voiceHandle = null;
        setMicState(btn, "idle");
      }
    });
  }

  async function startVoice(btn) {
    if (!Voice.hasKey()) {
      notice("Add your Groq API key in Settings → Voice to dictate.");
      return;
    }
    try {
      voiceHandle = await Voice.startRecording();
      setMicState(btn, "recording");
    } catch (err) {
      voiceHandle = null;
      notice(err && err.message ? err.message : "Couldn't start recording");
    }
  }

  async function stopAndInsert(btn) {
    const handle = voiceHandle;
    voiceHandle = null;
    setMicState(btn, "processing");

    let transcript = "";
    try {
      transcript = await Voice.stopRecording(handle);
    } catch (err) {
      setMicState(btn, "idle");
      notice(err && err.message ? err.message : "Transcription failed");
      return;
    }
    setMicState(btn, "idle");

    if (!transcript) return;
    insertAtCaret(commentInput, transcript);
    autoGrowInput();
    commentInput.focus();
  }

  // Set the mic button visual state — "idle" | "recording" | "processing"
  function setMicState(btn, state) {
    btn.classList.toggle("recording", state === "recording");
    btn.classList.toggle("processing", state === "processing");
    btn.disabled = state === "processing";
    if (state === "recording") btn.title = "Click to stop and transcribe";
    else if (state === "processing") btn.title = "Transcribing…";
    else btn.title = "Dictate (Groq Whisper) — click to record, click again to stop";
  }

  // Insert text at the current cursor position in a textarea, replacing any
  // active selection. Adds a space separator if we're appending mid-sentence.
  function insertAtCaret(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    // Only add a leading space if there's non-whitespace directly before
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const inserted = (needsLeadingSpace ? " " : "") + text;
    textarea.value = before + inserted + after;
    // Move caret to end of inserted text
    const newPos = start + inserted.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
  }

  /*
   * Export a video document: the full transcript with comments interleaved.
   *
   * Comments are matched to lines through their highlight — a dictated comment
   * highlights the line it was spoken over, so the highlight's text identifies
   * the line. General notes have no line and are collected at the top.
   */
  function exportTranscript(doc, blocks, highlights, comments, ctx) {
    const title = (doc && doc.meta && doc.meta.title) || "Untitled";
    const today = new Date().toISOString().slice(0, 10);

    const videoBlock = blocks.find((b) => b.type === "video");
    const url = (videoBlock && videoBlock.data && videoBlock.data.url) || "";

    /*
     * A read prefix on each comment, used only when the file holds several
     * reads. A transcript is linear like a document, so "which read" is a tag
     * on the comment rather than a heading over a section. On a single-read
     * export it is empty, leaving the file exactly as it was before reads
     * existed.
     */
    const readTag = (c) => {
      if (!ctx || !ctx.labelReads) return "";
      const r = c.readId ? ctx.readById.get(c.readId) : null;
      return r ? `[${FolioStore.readLabel(r)}] ` : "";
    };

    // highlight id -> its comments
    const byHighlight = new Map();
    const general = [];
    comments.forEach((c) => {
      if (c.isGeneral || c.highlightId == null) { general.push(c); return; }
      if (!byHighlight.has(c.highlightId)) byHighlight.set(c.highlightId, []);
      byHighlight.get(c.highlightId).push(c);
    });

    /*
     * Which line does a highlight belong to? Match on the highlight's stored
     * text — a dictated comment covers the whole line, so the line whose text
     * the highlight contains is the one it came from. Falls back to a
     * substring test for a hand-made partial selection.
     */
    const lineComments = new Map();     // block index -> comments
    const addTo = (idx, cs) => {
      if (!lineComments.has(idx)) lineComments.set(idx, []);
      lineComments.get(idx).push.apply(lineComments.get(idx), cs);
    };

    /*
     * Timestamped comments are placed by WHEN THEY WERE SPOKEN, which is exact.
     *
     * Matching on text used to do this job, and it is wrong in a way that only
     * shows up on a bad transcript: it takes the FIRST line whose text
     * matches. When the model loops and emits the same sentence eighty times,
     * every comment in the second half of the video lands on the first copy.
     * A real export put notes recorded at 20:14 and 25:32 under the line at
     * 6:50. The panel had it right the whole time because it reads videoTime.
     */
    const timeline = [];                // [{t, idx}] over transcript lines
    blocks.forEach((b, i) => {
      if (b.type === "paragraph" && b.data.t != null) timeline.push({ t: b.data.t, idx: i });
    });
    const lineAt = (t) => {
      let best = -1;
      for (const e of timeline) { if (e.t <= t + 0.5) best = e.idx; else break; }
      return best;
    };

    comments.forEach((c) => {
      if (typeof c.videoTime !== "number" || !isFinite(c.videoTime)) return;
      if (!timeline.length) return;
      const idx = lineAt(c.videoTime);
      if (idx === -1) return;           // spoken before the first line
      addTo(idx, [c]);
      if (c.highlightId != null) {
        const rest = (byHighlight.get(c.highlightId) || []).filter((x) => x !== c);
        if (rest.length) byHighlight.set(c.highlightId, rest);
        else byHighlight.delete(c.highlightId);
      } else {
        const k = general.indexOf(c);
        if (k !== -1) general.splice(k, 1);
      }
    });

    highlights.forEach((hl) => {
      const cs = byHighlight.get(hl.id);
      if (!cs || !cs.length) return;
      const needle = stripTags(hl.text || "").trim();
      if (!needle) return;
      let best = -1;
      blocks.forEach((b, i) => {
        if (b.type !== "paragraph" || b.data.t == null) return;
        const line = stripTags(b.data.text || "").trim();
        if (!line) return;
        if (line === needle || needle.indexOf(line) !== -1 || line.indexOf(needle) !== -1) {
          if (best === -1) best = i;
        }
      });
      if (best === -1) { general.push.apply(general, cs); return; }
      addTo(best, cs);
      byHighlight.delete(hl.id);          // claimed
    });

    /*
     * Anything still unclaimed belongs to a highlight that no longer exists —
     * the passage was edited away, or the highlight was removed after the
     * comment was written. Those comments were previously dropped from the
     * export entirely, silently losing what the user had said. Collect them
     * rather than iterating only over surviving highlights.
     */
    byHighlight.forEach((cs) => general.push.apply(general, cs));

    const out = [];
    out.push(`# ${title}`);
    if (url) out.push(url);
    out.push(`_Exported ${today}_`);
    if (ctx && ctx.scopeRead) {
      const when = readDateLabel(ctx.scopeRead);
      out.push(`_${FolioStore.readLabel(ctx.scopeRead)}${when ? " · " + when : ""} — comments from this read only_`);
    }
    out.push("");

    if (general.length) {
      out.push("## Notes");
      out.push("");
      general
        .sort(byThoughtDate)
        .forEach((c) => out.push(`- **${thoughtLabel(c)}:** ${readTag(c)}${flatten(c.text)}`));
      out.push("");
    }

    out.push("## Transcript");
    out.push("");

    let lineCount = 0;
    blocks.forEach((b, i) => {
      if (b.type !== "paragraph" || b.data.t == null) return;
      lineCount++;
      const stamp = typeof Gemini !== "undefined"
        ? Gemini.formatTime(b.data.t) : String(Math.round(b.data.t));
      out.push(`**[${stamp}]** ${stripTags(b.data.text || "")}`);
      const cs = lineComments.get(i);
      if (cs && cs.length) {
        cs.forEach((c) => {
          // Its own stamp, when known — so you can always see the moment a
          // note was made rather than trusting where it got filed.
          const at = typeof c.videoTime === "number" && isFinite(c.videoTime) &&
                     typeof Gemini !== "undefined"
            ? `[${Gemini.formatTime(c.videoTime)}] ` : "";
          /*
           * Two different times sit on this line and they mean different
           * things: the date is WHEN YOU THOUGHT IT, the [12:34] is where in
           * the video you were. A note made on a second watch is the whole
           * reason both are worth printing.
           */
          out.push(`  > 💬 **${thoughtLabel(c)}:** ${readTag(c)}${at}${flatten(c.text)}`);
        });
      }
      out.push("");
    });

    if (!lineCount) {
      out.push("_No transcript yet — it may still be generating._");
      out.push("");
    }

    const safe = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "video";
    downloadBlob(
      out.join("\n"),
      exportFileName(safe, "transcript", ctx, today),
      "text/markdown"
    );
  }

  // Strip the inline HTML the reader stores in block text.
  function stripTags(s) {
    const d = document.createElement("div");
    d.innerHTML = String(s == null ? "" : s);
    return d.textContent || "";
  }

  // Collapse a multi-line comment so it sits on one markdown line.
  function flatten(s) {
    return String(s == null ? "" : s).split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  }

  function downloadBlob(text, filename, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ==========================================================================
  // INITIALIZATION — Wire up event listeners
  // ==========================================================================

  function init() {
    // Close panel button
    document.getElementById("comments-close").addEventListener("click", closePanel);

    /*
     * Re-decide the arrangement whenever the window changes size. Debounced,
     * because a drag-resize fires this continuously and re-docking on every
     * frame would fight the pointer.
     */
    let layoutTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(enforceLayout, 120);
    });

    // Export annotations button
    const exportBtn = document.getElementById("comments-export");
    if (exportBtn) exportBtn.addEventListener("click", exportAnnotations);

    // "New note" button — creates a page-level comment (no highlight)
    const newNoteBtn = document.getElementById("comments-new-note");
    if (newNoteBtn) newNoteBtn.addEventListener("click", openPanelForNewNote);

    // "New read" button — starts a fresh pass, so comments from here on group
    // separately. See the READS section at the top of this file.
    const newReadBtn = document.getElementById("comments-new-read");
    if (newReadBtn) newReadBtn.addEventListener("click", startNewRead);

    // The read's name in the bar opens the reads manager — rename, delete.
    const readLabelBtn = document.getElementById("comments-read-label");
    if (readLabelBtn) readLabelBtn.addEventListener("click", openReadsManager);

    // Submit comment
    commentSubmit.addEventListener("click", saveComment);

    // Cancel editing
    commentCancel.addEventListener("click", () => {
      commentInput.value = "";
      resetInputHeight();
      editingCommentId = null;
      activeHighlightId = null;
      commentInput.placeholder = "Add a comment...";
    });

    // Auto-grow on every keystroke — CSS max-height caps the growth,
    // after which the internal scrollbar takes over
    commentInput.addEventListener("input", autoGrowInput);

    // Voice dictation via Groq Whisper — click to start, click again to stop,
    // Escape while recording cancels without uploading.
    initMicButton();

    // Submit on Cmd+Enter (mac) / Ctrl+Enter (win/linux). preventDefault so
    // the newline the textarea would otherwise insert doesn't sneak in on
    // release — I dropped that bit last time and it was the difference
    // between the shortcut appearing to fire and actually saving cleanly.
    commentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        saveComment();
      }
      // Escape cancels an in-progress edit or new note
      if (e.key === "Escape") {
        e.preventDefault();
        commentInput.value = "";
        resetInputHeight();
        editingCommentId = null;
        activeHighlightId = null;
        commentInput.placeholder = "Add a comment...";
      }
    });

    // Floating-window behavior: drag by header, resize by corner
    initDrag();
    initResize();

    // Keep the panel in the viewport if the window is resized while docked
    // or floating — otherwise a shrink can leave it off-screen.
    window.addEventListener("resize", () => {
      if (panel.classList.contains("open")) restoreGeometry();
    });
  }

  return {
    init,
    openPanel,
    openPanelForHighlight,
    openPanelForNewNote,
    closePanel,
    renderComments,
    addComment,
    listTimed,
    attachToHighlight,
    unanchor,
    revealCommentsFor,
    // Start a new read on the open document, so comments made from now on
    // group under it. Same thing the "+ New read" button does.
    startNewRead,
    // Rename or delete a read; move one comment to a different read.
    openReadsManager,
    openMoveComment,
    /*
     * The two exports, individually. exportAnnotations() asks which one and
     * which read; these do one without asking.
     *
     * The omitted third argument means "every read", which is the right
     * default here: a caller that did not ask about reads wants everything,
     * not an arbitrary one. Pass a read id as the second argument's successor
     * when a specific read is meant.
     */
    exportFull: (docId, readId) => runExport("full", docId, readId),
    exportDigest: (docId, readId) => runExport("digest", docId, readId),
  };
})();

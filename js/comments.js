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

  // Open the panel and show all comments for the current document
  function openPanel() {
    // Restore the last-used geometry before showing so the panel doesn't flash
    // in the default position and then jump.
    restoreGeometry();
    panel.classList.add("open");
    renderComments();
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
        contextHtml = `<div class="comment-highlight-text">${escapeHtml(hl.text)}</div>`;
      }

      const entry = document.createElement("div");
      entry.className = "comment-entry" + (isGeneral ? " comment-entry-general" : "");
      entry.dataset.highlightId = comment.highlightId || "";

      const dateStr = new Date(comment.createdAt).toLocaleDateString(
        "en-US",
        { month: "short", day: "numeric" }
      );

      entry.innerHTML = `
        ${contextHtml}
        <div class="comment-text">${escapeHtml(comment.text)}</div>
        <div class="comment-meta">
          <span>${dateStr}</span>
          <div class="comment-actions">
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
    if (typeof videoTime === "number" && isFinite(videoTime) && !highlightId) {
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
    if (!mark) return;

    // Scroll the highlight into view
    mark.scrollIntoView({ behavior: "smooth", block: "center" });

    // Add a pulsing animation to draw attention
    mark.classList.add("pulsing");
    setTimeout(() => mark.classList.remove("pulsing"), 1500);
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

  // ==========================================================================
  // EXPORT — dump highlights + comments as a markdown bulleted list
  // ==========================================================================

  /*
   * Format:
   *   # Highlights & comments — <doc title>
   *   _Exported <date>_
   *
   *   - "quoted highlight text"
   *     → my thought: comment text
   *
   *   - "another highlight, no comment"
   *
   * Design decisions (per plan):
   *   • Include highlights WITHOUT comments (option A) — they're breadcrumbs too
   *   • Order by highlight creation time so the export reads chronologically
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
    if (blocks.some((b) => b.type === "video")) {
      return exportTranscript(doc, blocks, highlights, comments);
    }

    if (!highlights.length && !comments.length) {
      notice("Nothing to export yet.");
      return;
    }

    // Sort highlights by creation time so the export mirrors reading order-ish
    const sortedHighlights = [...highlights].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );

    const title = (doc && doc.meta && doc.meta.title) || "Untitled";
    const today = new Date().toISOString().slice(0, 10);

    const lines = [];
    lines.push(`# Highlights & comments — ${title}`);
    lines.push(`_Exported ${today}_`);
    lines.push("");

    // General notes first (they're about the whole page, not any specific quote)
    const generalNotes = comments.filter((c) => c.isGeneral || (c.highlightId === null));
    if (generalNotes.length) {
      lines.push("## General notes");
      lines.push("");
      generalNotes
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
        .forEach((c) => {
          const noteLines = (c.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
          if (!noteLines.length) return;
          lines.push(`- ${noteLines[0]}`);
          noteLines.slice(1).forEach((l) => lines.push(`  ${l}`));
        });
      lines.push("");
      if (sortedHighlights.length) {
        lines.push("## Highlights");
        lines.push("");
      }
    }

    sortedHighlights.forEach((hl) => {
      // Collapse internal whitespace so multi-line highlights read as one quote
      const quoteText = (hl.text || "").replace(/\s+/g, " ").trim();
      lines.push(`- "${quoteText}"`);
      const relatedComments = comments.filter((c) => c.highlightId === hl.id);
      relatedComments.forEach((c) => {
        // Indent each comment line so it visually attaches to its bullet
        const commentLines = (c.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
        commentLines.forEach((cl, i) => {
          const prefix = i === 0 ? "  → " : "    ";
          lines.push(`${prefix}${cl}`);
        });
      });
      lines.push("");
    });

    // Orphan comments: had a highlight once, but the highlight was removed.
    // Exclude general notes (already listed above) — an orphan has a non-null
    // highlightId that no longer resolves.
    const orphanComments = comments.filter(
      (c) => !c.isGeneral && c.highlightId != null && !highlights.some((h) => h.id === c.highlightId)
    );
    if (orphanComments.length) {
      lines.push("---");
      lines.push("");
      lines.push("**Notes whose highlight was removed:**");
      lines.push("");
      orphanComments.forEach((c) => {
        lines.push(`- ${c.text || ""}`);
      });
    }

    const md = lines.join("\n");
    const safeTitle = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "notes";
    downloadBlob(md, `${safeTitle}-annotations-${today}.md`, "text/markdown");
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
  function exportTranscript(doc, blocks, highlights, comments) {
    const title = (doc && doc.meta && doc.meta.title) || "Untitled";
    const today = new Date().toISOString().slice(0, 10);

    const videoBlock = blocks.find((b) => b.type === "video");
    const url = (videoBlock && videoBlock.data && videoBlock.data.url) || "";

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
      if (!lineComments.has(best)) lineComments.set(best, []);
      lineComments.get(best).push.apply(lineComments.get(best), cs);
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
    out.push("");

    if (general.length) {
      out.push("## Notes");
      out.push("");
      general
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
        .forEach((c) => out.push(`- ${flatten(c.text)}`));
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
        cs.forEach((c) => out.push(`  > 💬 ${flatten(c.text)}`));
      }
      out.push("");
    });

    if (!lineCount) {
      out.push("_No transcript yet — it may still be generating._");
      out.push("");
    }

    const safe = title.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "video";
    downloadBlob(out.join("\n"), `${safe}-transcript-${today}.md`, "text/markdown");
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

    // Export annotations button
    const exportBtn = document.getElementById("comments-export");
    if (exportBtn) exportBtn.addEventListener("click", exportAnnotations);

    // "New note" button — creates a page-level comment (no highlight)
    const newNoteBtn = document.getElementById("comments-new-note");
    if (newNoteBtn) newNoteBtn.addEventListener("click", openPanelForNewNote);

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
  };
})();

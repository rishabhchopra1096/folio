/*
 * =============================================================================
 * HIGHLIGHTS.JS — Text Highlighting System
 * =============================================================================
 * FILE OVERVIEW:
 * This file lets users select text in the reading view and highlight it with
 * a chosen color (yellow, green, blue, pink). Highlights persist in localStorage
 * and are re-applied every time a document is rendered.
 *
 * HOW IT WORKS - The Main Challenge:
 * When the user selects text, we get a DOM Range object. But the DOM changes
 * every time we re-render the markdown. So we need to serialize the Range into
 * a format that survives re-renders. We do this by recording:
 * - Which text node (by walking the DOM tree and counting text nodes)
 * - The character offset within that text node
 *
 * THE FLOW:
 * 1. User selects text -> mouseup fires -> we show the highlight toolbar
 * 2. User clicks a color -> we serialize the Range, wrap text in <mark>, save
 * 3. On document re-render -> we load saved highlights and re-wrap the text
 * 4. Clicking a highlight -> shows a popover with "Add Comment" / "Remove"
 * =============================================================================
 */

const Highlights = (function () {

  // The toolbar that appears when text is selected
  const toolbar = document.getElementById("highlight-toolbar");
  // The popover that appears when clicking an existing highlight
  const popover = document.getElementById("highlight-popover");
  // The article container where highlights live
  const article = document.getElementById("article");

  // The current Range object captured from the user's text selection
  let pendingRange = null;
  // The highlight ID that's currently showing the popover
  let activeHighlightId = null;
  // The most recently created highlight (for Cmd+Z undo). We reset this on any
  // action other than "create," so undo only ever affects the last create.
  let lastCreatedHighlightId = null;
  // IDs of highlights that overlap the pending selection — populated whenever
  // pendingRange is set, so the eraser button knows what to remove.
  let overlappingHighlightIds = [];

  // ==========================================================================
  // RANGE SERIALIZATION — Converting DOM Ranges to storable paths
  // ==========================================================================

  // Walk all text nodes inside a container in document order
  function getTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  /*
   * Triple-click bug fix — normalize a range so its start/end are always
   * text nodes, never element nodes.
   *
   * When you triple-click a paragraph, browsers set the selection's
   * start/end containers to the <p> element itself with element-offset
   * (child index), not to the inner text nodes. Our serializeRange +
   * wrapRange logic assumes text nodes and silently failed on element
   * containers (indexOf returned -1 → serializeRange returned null →
   * hideToolbar → no highlight, and if a prior lastCreatedHighlightId
   * happened to be set, the "c" shortcut would even open the comment
   * panel for the WRONG (old) highlight).
   *
   * Fix: drill into text nodes. For the START, walk down to the first
   * text node inside/after the child at startOffset. For the END, walk
   * to the last text node inside/before the child at endOffset-1.
   * Everything downstream can then assume text-node endpoints.
   */
  function normalizeRangeToTextNodes(range) {
    if (!range) return null;
    const r = range.cloneRange();

    if (r.startContainer.nodeType === Node.ELEMENT_NODE) {
      const child = r.startContainer.childNodes[r.startOffset];
      const firstText = child
        ? findFirstTextNode(child)
        : findFirstTextNode(r.startContainer);
      if (firstText) r.setStart(firstText, 0);
    }

    if (r.endContainer.nodeType === Node.ELEMENT_NODE) {
      const childIdx = Math.max(0, r.endOffset - 1);
      const child = r.endContainer.childNodes[childIdx];
      const lastText = child
        ? findLastTextNode(child)
        : findLastTextNode(r.endContainer);
      if (lastText) r.setEnd(lastText, lastText.length);
    }

    return r;
  }

  function findFirstTextNode(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return node;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  }

  function findLastTextNode(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return node;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let last = null;
    let n;
    while ((n = walker.nextNode())) last = n;
    return last;
  }

  // Serialize a Range to a storable object
  // We record the text node index and character offset for start and end
  function serializeRange(range) {
    const textNodes = getTextNodes(article);
    const startIdx = textNodes.indexOf(range.startContainer);
    const endIdx = textNodes.indexOf(range.endContainer);

    if (startIdx === -1 || endIdx === -1) return null;

    return {
      startNodeIndex: startIdx,
      startOffset: range.startOffset,
      endNodeIndex: endIdx,
      endOffset: range.endOffset,
    };
  }

  // Deserialize a stored path back into a DOM Range
  function deserializeRange(serialized) {
    const textNodes = getTextNodes(article);
    if (
      serialized.startNodeIndex >= textNodes.length ||
      serialized.endNodeIndex >= textNodes.length
    ) {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(
        textNodes[serialized.startNodeIndex],
        Math.min(
          serialized.startOffset,
          textNodes[serialized.startNodeIndex].length
        )
      );
      range.setEnd(
        textNodes[serialized.endNodeIndex],
        Math.min(
          serialized.endOffset,
          textNodes[serialized.endNodeIndex].length
        )
      );
      return range;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // HIGHLIGHT CREATION — Wrapping selected text in <mark> elements
  // ==========================================================================

  // Wrap a Range in <mark> elements with the given highlight ID and color class
  function wrapRange(range, highlightId, colorClass) {
    // For simple ranges that fit in a single text node
    if (range.startContainer === range.endContainer) {
      const mark = document.createElement("mark");
      mark.dataset.highlightId = highlightId;
      mark.className = colorClass;
      range.surroundContents(mark);
      return;
    }

    // For ranges spanning multiple nodes, we need to wrap each text node segment
    const textNodes = getTextNodes(article);
    const startIdx = textNodes.indexOf(range.startContainer);
    const endIdx = textNodes.indexOf(range.endContainer);

    // Collect the nodes and offsets we need to wrap
    const nodesToWrap = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const node = textNodes[i];
      if (!node || !node.parentNode) continue;

      let start = 0;
      let end = node.length;

      if (i === startIdx) start = range.startOffset;
      if (i === endIdx) end = range.endOffset;

      // Skip empty segments
      if (start >= end) continue;

      nodesToWrap.push({ node, start, end });
    }

    // Wrap each segment (go in reverse to avoid index shifts)
    for (let i = nodesToWrap.length - 1; i >= 0; i--) {
      const { node, start, end } = nodesToWrap[i];

      // Split the text node to isolate the highlighted portion
      const mark = document.createElement("mark");
      mark.dataset.highlightId = highlightId;
      mark.className = colorClass;

      // If we need a portion of the text node, split it
      if (end < node.length) {
        node.splitText(end);
      }
      const targetNode = start > 0 ? node.splitText(start) : node;

      // Wrap the target text node in the mark element
      targetNode.parentNode.insertBefore(mark, targetNode);
      mark.appendChild(targetNode);
    }
  }

  /*
   * Create a highlight from the current selection AND immediately open the
   * comments panel focused on it. This is the one-shot "annotate" action —
   * triggered by the comment button in the toolbar or by pressing "c" while
   * the toolbar is visible. Default color is yellow (matches most reader tools).
   *
   * We snapshot lastCreatedHighlightId BEFORE calling createHighlight so we
   * can detect whether this particular call actually created something. If
   * wrapRange fails and no new ID is set, we do NOT open the panel on a
   * stale ID from an earlier highlight — that was the "opens the wrong
   * comment box" bug behind the triple-click complaint.
   */
  function createHighlightAndComment() {
    if (!pendingRange) return;
    const before = lastCreatedHighlightId;
    createHighlight("yellow");
    if (lastCreatedHighlightId && lastCreatedHighlightId !== before && typeof Comments !== "undefined") {
      Comments.openPanelForHighlight(lastCreatedHighlightId);
    }
  }

  // Create a new highlight from the current pending selection
  function createHighlight(color) {
    if (!pendingRange) return;
    return createHighlightFromRange(pendingRange, color);
  }

  /*
   * Create a highlight from ANY range, not just the current mouse selection.
   *
   * This is the shared implementation behind both the selection path (the
   * colour swatches / "c" shortcut, via createHighlight above) and
   * programmatic callers like read-aloud, which highlights the paragraph you
   * paused on. Returns the new highlight's id, or null if it couldn't be
   * created.
   */
  function createHighlightFromRange(range, color) {
    if (!range) return null;

    const docId = Reader.getCurrentDocId();
    if (!docId) return null;

    // Normalize first — element-container ranges (triple-click, or a
    // programmatic selectNodeContents) break serialize/wrap otherwise.
    const norm = normalizeRangeToTextNodes(range);
    if (!norm || norm.collapsed) return null;

    // Serialize the range before we modify the DOM
    const serialized = serializeRange(norm);
    if (!serialized) {
      hideToolbar();
      return null;
    }

    // Get the selected text for storage
    const text = norm.toString();
    const colorClass = `hl-${color}`;

    // Generate a unique ID for this highlight
    const highlightId = FolioStore.generateId("hl");

    // Wrap the text in <mark> elements
    try {
      wrapRange(norm, highlightId, colorClass);
    } catch {
      // If wrapping fails (complex DOM), fall back to re-rendering
      hideToolbar();
      return null;
    }

    // Save the highlight to the store
    const highlights = FolioStore.getHighlights(docId);
    highlights.push({
      id: highlightId,
      color: color,
      ...serialized,
      text: text,
      createdAt: new Date().toISOString(),
    });
    FolioStore.saveHighlights(docId, highlights);

    // Remember this ID so Cmd+Z can undo just this creation
    lastCreatedHighlightId = highlightId;

    // Clear the selection and hide the toolbar
    window.getSelection().removeAllRanges();
    hideToolbar();

    return highlightId;
  }

  // ==========================================================================
  // UNDO — remove the most recently created highlight (Cmd+Z after creating)
  // ==========================================================================

  function undoLastHighlight() {
    if (!lastCreatedHighlightId) return false;
    const id = lastCreatedHighlightId;
    lastCreatedHighlightId = null; // consume it — one undo per create
    removeHighlight(id);
    return true;
  }

  // ==========================================================================
  // HIGHLIGHT RE-APPLICATION — Restoring highlights after markdown re-render
  // ==========================================================================

  // Apply all saved highlights for a document (called after rendering markdown)
  function applyHighlights(docId) {
    const highlights = FolioStore.getHighlights(docId);
    if (!highlights.length) return;

    // Apply each highlight by deserializing its range and wrapping
    highlights.forEach((hl) => {
      const range = deserializeRange(hl);
      if (!range) return;

      // Verify the text still matches (to handle content changes)
      const currentText = range.toString();
      if (currentText !== hl.text) return;

      try {
        wrapRange(range, hl.id, `hl-${hl.color}`);
      } catch {
        // Skip highlights that can't be applied (content changed too much)
      }
    });
  }

  // ==========================================================================
  // HIGHLIGHT REMOVAL
  // ==========================================================================

  // Remove a highlight by its ID — unwrap the <mark> elements
  function removeHighlight(highlightId) {
    const marks = article.querySelectorAll(
      `mark[data-highlight-id="${highlightId}"]`
    );
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      // Merge adjacent text nodes
      parent.normalize();
    });

    // Remove from store
    const docId = Reader.getCurrentDocId();
    if (docId) {
      let highlights = FolioStore.getHighlights(docId);
      highlights = highlights.filter((h) => h.id !== highlightId);
      FolioStore.saveHighlights(docId, highlights);

      // Also remove associated comments
      let comments = FolioStore.getComments(docId);
      comments = comments.filter((c) => c.highlightId !== highlightId);
      FolioStore.saveComments(docId, comments);
    }

    hidePopover();
  }

  // ==========================================================================
  // TOOLBAR — Floating color picker shown on text selection
  // ==========================================================================

  function showToolbar(x, y) {
    toolbar.style.left = x + "px";
    toolbar.style.top = y + "px";
    toolbar.classList.add("visible");
  }

  function hideToolbar() {
    toolbar.classList.remove("visible");
    pendingRange = null;
  }

  // ==========================================================================
  // POPOVER — Options shown when clicking an existing highlight
  // ==========================================================================

  function showPopover(x, y, highlightId) {
    activeHighlightId = highlightId;
    popover.style.left = x + "px";
    popover.style.top = y + "px";
    popover.classList.add("visible");
  }

  function hidePopover() {
    popover.classList.remove("visible");
    activeHighlightId = null;
  }

  // ==========================================================================
  // EVENT HANDLERS — Mouse events for selection and highlight interaction
  // ==========================================================================

  function init() {
    // When user finishes selecting text in the article, show the toolbar
    document.addEventListener("mouseup", (e) => {
      // Ignore if clicking on the toolbar itself or popover
      if (toolbar.contains(e.target) || popover.contains(e.target)) return;

      // Hide popover on any click
      hidePopover();

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        hideToolbar();
        return;
      }

      const range = selection.getRangeAt(0);
      // Only handle selections within the article
      if (!article.contains(range.commonAncestorContainer)) {
        hideToolbar();
        return;
      }

      // Only in reader mode
      const readerView = document.getElementById("view-reader");
      if (!readerView.classList.contains("active")) {
        hideToolbar();
        return;
      }

      // Store the range and show the toolbar above the selection.
      // Normalize to text-node endpoints first so triple-click / other
      // element-container selections don't silently break serialize/wrap.
      pendingRange = normalizeRangeToTextNodes(range);
      if (!pendingRange || pendingRange.collapsed) {
        hideToolbar();
        return;
      }

      // Figure out whether the selection overlaps any existing highlights —
      // that's what the eraser will act on. We walk the fragment produced by
      // cloneContents() looking for <mark data-highlight-id="..."> tags, and
      // ALSO check the ancestor chain in case the selection sits entirely
      // inside a single existing highlight.
      overlappingHighlightIds = findHighlightsInRange(range);
      updateEraserState();

      const rect = range.getBoundingClientRect();
      // Toolbar is now wider (color swatches + divider + eraser) — center on it
      const toolbarX = rect.left + rect.width / 2 - 80;
      const toolbarY = rect.top - 44;
      showToolbar(
        Math.max(8, toolbarX),
        Math.max(8, toolbarY)
      );
    });

    // Eraser click — remove every highlight overlapping the current selection
    const eraserBtn = document.getElementById("hl-eraser");
    if (eraserBtn) {
      eraserBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the selection alive across the click
        e.stopPropagation();
      });
      eraserBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!overlappingHighlightIds.length) return;
        overlappingHighlightIds.forEach((id) => removeHighlight(id));
        overlappingHighlightIds = [];
        window.getSelection().removeAllRanges();
        hideToolbar();
      });
    }

    // Comment button — one click: highlight + open comment panel focused on it
    const commentBtn = document.getElementById("hl-comment");
    if (commentBtn) {
      commentBtn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep the selection alive across the click
        e.stopPropagation();
      });
      commentBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        createHighlightAndComment();
      });
    }

    // Color button clicks in the toolbar
    toolbar.querySelectorAll(".hl-color-btn").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault(); // Prevent losing the selection
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        createHighlight(btn.dataset.color);
      });
    });

    // Click on an existing highlight mark
    article.addEventListener("click", (e) => {
      const mark = e.target.closest("mark[data-highlight-id]");
      if (!mark) return;

      const highlightId = mark.dataset.highlightId;
      const rect = mark.getBoundingClientRect();
      showPopover(
        rect.left,
        rect.bottom + 6,
        highlightId
      );
    });

    // Popover button: Remove highlight
    document.getElementById("popover-remove").addEventListener("click", () => {
      if (activeHighlightId) {
        removeHighlight(activeHighlightId);
      }
    });

    // Popover button: Add comment
    document.getElementById("popover-comment").addEventListener("click", () => {
      if (activeHighlightId && typeof Comments !== "undefined") {
        Comments.openPanelForHighlight(activeHighlightId);
      }
      hidePopover();
    });

    // Close toolbar/popover on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideToolbar();
        hidePopover();
      }

      // Cmd+Z / Ctrl+Z after highlighting → undo the last created highlight.
      // Only fires in reader mode and when we have a create to undo; anywhere
      // else, native undo (e.g. inside the editor) is untouched.
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const readerView = document.getElementById("view-reader");
        if (readerView && readerView.classList.contains("active") && lastCreatedHighlightId) {
          e.preventDefault();
          undoLastHighlight();
        }
      }

      // "c" while the highlight toolbar is visible → one-shot highlight + comment.
      // Guard against input focus so it doesn't hijack keystrokes inside a
      // contenteditable/textarea/input somewhere else on the page.
      if (
        (e.key === "c" || e.key === "C") &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        toolbar.classList.contains("visible") &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        createHighlightAndComment();
      }
    });
  }

  // True if the event target is somewhere the user is actively typing —
  // used to keep single-key shortcuts from stealing keystrokes.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // Return an array of unique highlight IDs that overlap the given range.
  // Used to enable the eraser button + drive its click action.
  function findHighlightsInRange(range) {
    const ids = new Set();

    // Case 1: selection is INSIDE a single highlight — commonAncestor is the mark
    let node = range.commonAncestorContainer;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    const ancestorMark = node && node.closest ? node.closest("mark[data-highlight-id]") : null;
    if (ancestorMark) ids.add(ancestorMark.dataset.highlightId);

    // Case 2: selection SPANS one or more highlights — clone and walk contents
    try {
      const frag = range.cloneContents();
      frag.querySelectorAll("mark[data-highlight-id]").forEach((m) => {
        ids.add(m.dataset.highlightId);
      });
    } catch {
      // Some cross-node selections throw — ignore, ancestor check above still fires
    }

    return Array.from(ids);
  }

  function updateEraserState() {
    const btn = document.getElementById("hl-eraser");
    if (!btn) return;
    btn.disabled = overlappingHighlightIds.length === 0;
  }

  return {
    init,
    applyHighlights,
    removeHighlight,
    createHighlightFromRange,
    hideToolbar,
    hidePopover,
  };
})();

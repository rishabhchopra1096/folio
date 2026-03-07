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

  // Create a new highlight from the current pending selection
  function createHighlight(color) {
    if (!pendingRange) return;

    const docId = Reader.getCurrentDocId();
    if (!docId) return;

    // Serialize the range before we modify the DOM
    const serialized = serializeRange(pendingRange);
    if (!serialized) {
      hideToolbar();
      return;
    }

    // Get the selected text for storage
    const text = pendingRange.toString();
    const colorClass = `hl-${color}`;

    // Generate a unique ID for this highlight
    const highlightId = FolioStore.generateId("hl");

    // Wrap the text in <mark> elements
    try {
      wrapRange(pendingRange, highlightId, colorClass);
    } catch {
      // If wrapping fails (complex DOM), fall back to re-rendering
      hideToolbar();
      return;
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

    // Clear the selection and hide the toolbar
    window.getSelection().removeAllRanges();
    hideToolbar();
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

      // Store the range and show the toolbar above the selection
      pendingRange = range.cloneRange();
      const rect = range.getBoundingClientRect();
      const toolbarX = rect.left + rect.width / 2 - 60;
      const toolbarY = rect.top - 44;
      showToolbar(
        Math.max(8, toolbarX),
        Math.max(8, toolbarY)
      );
    });

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
    });
  }

  return {
    init,
    applyHighlights,
    removeHighlight,
    hideToolbar,
    hidePopover,
  };
})();

/*
 * =============================================================================
 * READER.JS — Renders Editor.js JSON as Beautiful HTML for Reading
 * =============================================================================
 * FILE OVERVIEW:
 * This file handles the reading experience. It takes Editor.js JSON blocks
 * and converts them into beautifully styled HTML, using Folio's typographic
 * styles. It also tracks scroll progress and calculates reading time.
 *
 * HOW IT WORKS:
 * 1. renderDocument() loads a document's Editor.js JSON from the store
 * 2. Each block type (header, paragraph, list, etc.) is converted to HTML
 * 3. The HTML is placed in the #article container with all the nice typography
 * 4. Scroll listener tracks reading progress (top bar + floating ring)
 * =============================================================================
 */

const Reader = (function () {

  // State for the currently open document
  let currentDocId = null;
  let wordCount = 0;
  let readStartTime = null;
  const wpm = 220;

  // Cache DOM elements
  const progressBar = document.getElementById("progress-bar");
  const ringFill = document.getElementById("ring-fill");
  const ringPct = document.getElementById("ring-pct");
  const ringWrap = document.getElementById("progress-ring-wrap");
  const article = document.getElementById("article");

  // SVG ring math
  const r = 23;
  const circ = 2 * Math.PI * r;
  ringFill.style.strokeDasharray = circ;
  ringFill.style.strokeDashoffset = circ;

  // ==========================================================================
  // BLOCK-TO-HTML CONVERSION — Turn Editor.js blocks into beautiful HTML
  // ==========================================================================

  // Convert an array of Editor.js blocks to an HTML string
  function blocksToHtml(blocks) {
    return blocks.map(blockToHtml).join("\n");
  }

  // Convert a single Editor.js block to HTML
  function blockToHtml(block) {
    const data = block.data || {};

    switch (block.type) {
      case "header":
        return `<h${data.level || 2}>${data.text || ""}</h${data.level || 2}>`;

      case "paragraph":
        return `<p>${data.text || ""}</p>`;

      case "list": {
        const tag = data.style === "ordered" ? "ol" : "ul";
        const items = (data.items || [])
          .map((item) => {
            // Editor.js list items can be strings or objects with content
            const text = typeof item === "string" ? item : (item.content || item.text || "");
            return `<li>${text}</li>`;
          })
          .join("");
        return `<${tag}>${items}</${tag}>`;
      }

      case "checklist": {
        const items = (data.items || [])
          .map((item) => {
            const checked = item.checked ? "checked" : "";
            const cls = item.checked ? "checklist-done" : "";
            return `<li class="checklist-item ${cls}">
              <input type="checkbox" ${checked} disabled />
              <span>${item.text || ""}</span>
            </li>`;
          })
          .join("");
        return `<ul class="checklist">${items}</ul>`;
      }

      case "code":
        return `<pre><code>${escapeHtml(data.code || "")}</code></pre>`;

      case "table": {
        const rows = data.content || [];
        if (rows.length === 0) return "";
        const withHeadings = data.withHeadings;
        let html = "<table>";
        rows.forEach((row, i) => {
          html += "<tr>";
          row.forEach((cell) => {
            const tag = withHeadings && i === 0 ? "th" : "td";
            html += `<${tag}>${cell}</${tag}>`;
          });
          html += "</tr>";
        });
        html += "</table>";
        return html;
      }

      case "quote":
        return `<blockquote>
          <p>${data.text || ""}</p>
          ${data.caption ? `<footer>${data.caption}</footer>` : ""}
        </blockquote>`;

      case "delimiter":
        return "<hr />";

      default:
        // Unknown block: render as paragraph if it has text
        if (data.text) return `<p>${data.text}</p>`;
        return "";
    }
  }

  // Escape HTML to prevent XSS (used for code blocks)
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ==========================================================================
  // DOCUMENT RENDERING — Load and display a document
  // ==========================================================================

  function renderDocument(docId) {
    const doc = FolioStore.getDocument(docId);
    if (!doc) return;

    currentDocId = docId;
    const blocks = (doc.content && doc.content.blocks) || [];

    // Render blocks to HTML
    article.innerHTML = blocksToHtml(blocks);

    // Calculate word count
    wordCount = FolioStore.countWordsInBlocks(blocks);
    const readMins = Math.ceil(wordCount / wpm);

    // Show progress ring
    ringWrap.classList.add("visible");
    document.getElementById("progress-bar-wrap").style.display = "";

    // Start tracking reading progress
    readStartTime = Date.now();
    updateProgress();

    // Save as last opened doc
    const settings = FolioStore.getSettings();
    settings.lastOpenDocId = docId;
    FolioStore.saveSettings(settings);

    // Apply highlights if any
    if (typeof Highlights !== "undefined") {
      Highlights.applyHighlights(docId);
    }
  }

  // ==========================================================================
  // SCROLL PROGRESS — Update the progress bar and ring
  // ==========================================================================

  function updateProgress() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docH = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docH > 0 ? Math.min(100, Math.round((scrollTop / docH) * 100)) : 0;

    // Update progress bar
    progressBar.style.width = pct + "%";
    ringPct.textContent = pct + "%";

    // Update SVG ring
    const offset = circ - (pct / 100) * circ;
    ringFill.style.strokeDashoffset = offset;

    // Calculate ETA
    const elapsed = (Date.now() - readStartTime) / 1000 / 60;
    const actualWpm = pct > 5 ? (wordCount * (pct / 100)) / elapsed : null;
    const effectiveWpm = actualWpm ? wpm * 0.3 + actualWpm * 0.7 : wpm;
    const wordsLeft = wordCount * (1 - pct / 100);
    const minsLeft = Math.ceil(wordsLeft / effectiveWpm);
    const etaStr = pct >= 98 ? "Done!" : minsLeft <= 0 ? "< 1 min" : minsLeft + " min";

    document.getElementById("tt-pct").textContent = pct + "%";
    document.getElementById("tt-remain").textContent = etaStr;
  }

  // Hide the reader UI
  function hide() {
    ringWrap.classList.remove("visible");
    document.getElementById("progress-bar-wrap").style.display = "none";
    article.innerHTML = "";
    progressBar.style.width = "0%";
    ringFill.style.strokeDashoffset = circ;
    ringPct.textContent = "0%";
    currentDocId = null;
  }

  // Track scroll for progress updates
  window.addEventListener("scroll", () => {
    if (currentDocId) updateProgress();
  }, { passive: true });

  function getCurrentDocId() {
    return currentDocId;
  }

  return {
    renderDocument,
    hide,
    getCurrentDocId,
    blocksToHtml,
  };
})();

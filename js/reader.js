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

      case "paragraph": {
        // Transcript lines carry a start time; everything else is a plain <p>.
        if (data.t == null) return `<p>${data.text || ""}</p>`;
        const t = Number(data.t) || 0;
        const label = typeof Gemini !== "undefined" ? Gemini.formatTime(t) : String(Math.round(t));
        return `<p data-t="${t}"><button class="video-ts" tabindex="-1" ` +
               `title="Jump to ${label}">${label}</button>${data.text || ""}</p>`;
      }

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

      case "video": {
        // A placeholder only — js/video.js swaps in the real IFrame player,
        // which is the only way to read the playhead for transcript sync.
        const vid = String(data.videoId || "");
        if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return "";
        return `<div class="folio-video" data-video-id="${vid}" data-start="${Number(data.start) || 0}">
          <div class="folio-video-loading">Loading player…</div>
        </div>`;
      }

      case "image": {
        /*
         * Two shapes, both permanent (see js/images.js):
         *   { ref }  the picture is in IndexedDB — the <img> goes out with NO
         *            src and FolioImages.attach fills it after this string has
         *            been put in the page, because reading a blob is
         *            asynchronous and this function builds HTML in one go.
         *   { url }  the picture is in the page, which is every page written
         *            before refs existed. Unchanged, forever.
         */
        const cap = data.caption ? `<figcaption>${escapeHtml(String(data.caption))}</figcaption>` : "";
        const alt = escapeAttr(data.caption);

        if (typeof FolioImages !== "undefined" && FolioImages.isRef(data.ref)) {
          return `<figure class="folio-image">
            <img data-folio-ref="${escapeAttr(data.ref)}" alt="${alt}" loading="lazy" />
            ${cap}
          </figure>`;
        }

        const url = data.url || (data.file && data.file.url) || "";
        if (!url) return "";
        /*
         * The src is escaped now. It was interpolated raw, so a caption or a
         * url carrying a quote could close the attribute and add its own —
         * which for a value that arrives from an imported file is worth not
         * leaving to chance.
         */
        return `<figure class="folio-image">
          <img src="${escapeAttr(url)}" alt="${alt}" loading="lazy" />
          ${cap}
        </figure>`;
      }

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

  /*
   * For a value going inside an attribute, where the quote matters.
   *
   * escapeHtml above leaves " and ' alone, which is right for text content
   * and wrong for `alt="..."` — a caption carrying a quote closes the
   * attribute and whatever follows is read as markup. Captions arrive from
   * imported files now, so this is no longer a value worth trusting.
   */
  function escapeAttr(str) {
    return escapeHtml(String(str == null ? "" : str))
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

    /*
     * Make sure this document has a read before anything can be written into
     * it. A "read" is the record of one pass through a document, and comments
     * and highlights are stamped with the one they were made during.
     *
     * WHY IT HAPPENS HERE, at the moment the document opens, rather than
     * lazily when the comments panel first renders: a document that has been
     * opened has been read, so this is the honest moment for the record to
     * exist. Leaving it to the panel meant the answer to "which read am I in"
     * depended on whether you had happened to open the sidebar — and, for a
     * document carried over from before reads existed, meant its old notes
     * stayed unadopted until something else went looking for them.
     *
     * It is also where the one-time migration of a pre-reads document runs.
     * See FolioStore.ensureReads.
     */
    if (typeof FolioStore.ensureReads === "function") {
      FolioStore.ensureReads(docId);
    }

    // Apply highlights if any
    if (typeof Highlights !== "undefined") {
      Highlights.applyHighlights(docId);
    }

    // Rebuild the read-aloud index against the freshly-rendered DOM. Must run
    // AFTER applyHighlights, since that inserts <mark> wrappers and therefore
    // changes the text-node layout the index maps against.
    if (typeof TTS !== "undefined") {
      TTS.attach(docId);
    }

    // Turn any video placeholder into a live player and start syncing the
    // transcript. No-op on documents without one.
    if (typeof Video !== "undefined") {
      Video.attach();
    }

    /*
     * Fill in any picture that lives in IndexedDB rather than in the page.
     *
     * AFTER applyHighlights and TTS.attach, not before: those two walk and
     * rewrap the text nodes, and this only ever touches <img> attributes, so
     * the order cannot matter to them — but putting it last keeps the one
     * asynchronous step out of the way of the two that must see a settled DOM.
     * No-op on a document whose pictures are inline, and on every document
     * written before pictures moved out of pages.
     */
    if (typeof FolioImages !== "undefined") {
      FolioImages.attach(article);
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
    // Stop any in-flight speech and drop the index — it points at DOM nodes
    // that are about to be destroyed.
    if (typeof TTS !== "undefined") TTS.detach();
    if (typeof Video !== "undefined") Video.detach();
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

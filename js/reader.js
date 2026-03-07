/*
 * =============================================================================
 * READER.JS — Markdown Rendering & Reading Progress Tracking
 * =============================================================================
 * FILE OVERVIEW:
 * This file handles the reading experience: rendering markdown to HTML,
 * tracking scroll progress (both the top bar and the floating ring), and
 * calculating reading time estimates.
 *
 * HOW IT WORKS:
 * 1. renderDocument() takes a document ID, loads it from the store, and
 *    renders the markdown using the marked.js library
 * 2. A scroll listener continuously updates the progress bar, ring, and ETA
 * 3. The progress ring in the bottom-right shows percentage with a tooltip
 * =============================================================================
 */

const Reader = (function () {

  // State for the currently open document
  let currentDocId = null;
  let wordCount = 0;
  let readStartTime = null;
  const wpm = 220; // average reading speed in words per minute

  // Cache DOM elements we update frequently during scroll
  const progressBar = document.getElementById("progress-bar");
  const progressLabel = document.getElementById("progress-label");
  const ringFill = document.getElementById("ring-fill");
  const ringPct = document.getElementById("ring-pct");
  const statsBar = document.getElementById("stats-bar");
  const ringWrap = document.getElementById("progress-ring-wrap");
  const closeBtn = document.getElementById("close-btn");
  const article = document.getElementById("article");

  // The progress ring is an SVG circle; we animate it by changing strokeDashoffset
  const r = 23;
  const circ = 2 * Math.PI * r;
  ringFill.style.strokeDasharray = circ;
  ringFill.style.strokeDashoffset = circ;

  // Render a document by its ID into the reading view
  function renderDocument(docId) {
    const doc = FolioStore.getDocument(docId);
    if (!doc) return;

    currentDocId = docId;
    const md = doc.content;

    // Use marked.js to convert markdown to HTML
    article.innerHTML = marked.parse(md);

    // Calculate word count and reading time
    wordCount = md.trim().split(/\s+/).filter(Boolean).length;
    const readMins = Math.ceil(wordCount / wpm);

    // Update the stats bar
    document.getElementById("word-count").textContent =
      wordCount.toLocaleString();
    document.getElementById("read-time").textContent = readMins;
    document.getElementById("doc-title").textContent =
      doc.meta.title || "Document";
    document.getElementById("eta-val").textContent = readMins + " min";

    // Show the reader UI elements
    statsBar.classList.add("visible");
    ringWrap.classList.add("visible");
    closeBtn.classList.add("visible");
    document.getElementById("main").classList.add("has-stats");

    // Reset and start tracking reading progress
    readStartTime = Date.now();
    updateProgress();

    // Save this as the last opened doc
    const settings = FolioStore.getSettings();
    settings.lastOpenDocId = docId;
    FolioStore.saveSettings(settings);

    // After rendering, apply highlights if any exist
    if (typeof Highlights !== "undefined") {
      Highlights.applyHighlights(docId);
    }
  }

  // Calculate and update all progress indicators based on scroll position
  function updateProgress() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docH =
      document.documentElement.scrollHeight - window.innerHeight;
    const pct =
      docH > 0
        ? Math.min(100, Math.round((scrollTop / docH) * 100))
        : 0;

    // Update the top bar progress
    progressBar.style.width = pct + "%";
    progressLabel.textContent = pct + "%";
    ringPct.textContent = pct + "%";

    // Update the SVG ring by adjusting the dash offset
    const offset = circ - (pct / 100) * circ;
    ringFill.style.strokeDashoffset = offset;

    // Calculate ETA using a blend of assumed and actual reading speed
    const elapsed = (Date.now() - readStartTime) / 1000 / 60;
    const actualWpm =
      pct > 5 ? (wordCount * (pct / 100)) / elapsed : null;
    const effectiveWpm = actualWpm ? wpm * 0.3 + actualWpm * 0.7 : wpm;
    const wordsLeft = wordCount * (1 - pct / 100);
    const minsLeft = Math.ceil(wordsLeft / effectiveWpm);
    const etaStr =
      pct >= 98
        ? "Done!"
        : minsLeft <= 0
          ? "< 1 min"
          : minsLeft + " min";

    document.getElementById("eta-val").textContent = etaStr;
    document.getElementById("tt-pct").textContent = pct + "%";
    document.getElementById("tt-remain").textContent = etaStr;
  }

  // Hide all reader UI elements (when navigating away)
  function hide() {
    statsBar.classList.remove("visible");
    ringWrap.classList.remove("visible");
    closeBtn.classList.remove("visible");
    document.getElementById("main").classList.remove("has-stats");
    article.innerHTML = "";
    progressBar.style.width = "0%";
    progressLabel.textContent = "0%";
    ringFill.style.strokeDashoffset = circ;
    ringPct.textContent = "0%";
    currentDocId = null;
  }

  // Listen for scroll events to update progress (passive for performance)
  window.addEventListener("scroll", () => {
    if (currentDocId) updateProgress();
  }, { passive: true });

  // Get the currently open document ID
  function getCurrentDocId() {
    return currentDocId;
  }

  return {
    renderDocument,
    updateProgress,
    hide,
    getCurrentDocId,
  };
})();

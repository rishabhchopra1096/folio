/*
 * =============================================================================
 * STORE.JS — localStorage Data Layer for Folio
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages ALL persistent data for the Folio app. Since Folio is a
 * personal tool with no backend, everything lives in the browser's localStorage.
 *
 * HOW IT WORKS - The Data Model:
 * - folio_documents: JSON array of document metadata (title, icon, parent, dates)
 * - folio_doc_{id}: Editor.js JSON data for each document (blocks array)
 * - folio_highlights_{id}: JSON array of highlights per document
 * - folio_comments_{id}: JSON array of comments per document
 * - folio_settings: Global app settings (theme, font size, sidebar state, etc.)
 *
 * NESTED PAGES:
 * Documents have a parentId field. If null, they're top-level pages.
 * If set to another document's ID, they're a child page (nested under it).
 * This enables Notion-style page hierarchy.
 *
 * CONTENT FORMAT:
 * Documents store Editor.js JSON, not raw markdown. This preserves block
 * structure (headings, checklists, tables, code blocks, etc.) perfectly.
 * Markdown files can be imported by converting them to Editor.js blocks.
 * =============================================================================
 */

const FolioStore = (function () {

  // ==========================================================================
  // HELPERS — Utility functions used throughout the store
  // ==========================================================================

  // Generate a unique ID by combining a timestamp with a random string
  function generateId(prefix) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${timestamp}_${random}`;
  }

  // Safely read and parse JSON from localStorage, returning a fallback if missing
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  // Write a JSON value to localStorage
  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // ==========================================================================
  // DOCUMENTS — Create, read, update, delete document metadata + content
  // ==========================================================================

  // Get the full list of document metadata objects, sorted by order then updated
  function listDocuments() {
    const docs = readJSON("folio_documents", []);
    docs.sort((a, b) => {
      // Sort by explicit order first, then by updatedAt
      if (a.order !== undefined && b.order !== undefined) {
        return a.order - b.order;
      }
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return docs;
  }

  // Get top-level documents (no parent)
  function getTopLevelDocuments() {
    return listDocuments().filter((d) => !d.parentId);
  }

  // Get children of a specific document
  function getChildDocuments(parentId) {
    return listDocuments().filter((d) => d.parentId === parentId);
  }

  // Get a single document's metadata and content (Editor.js JSON)
  function getDocument(id) {
    const docs = readJSON("folio_documents", []);
    const meta = docs.find((d) => d.id === id);
    if (!meta) return null;
    // Content is Editor.js JSON data
    const content = readJSON(`folio_doc_${id}`, { time: Date.now(), blocks: [] });
    return { meta, content };
  }

  // Create a new document and return its metadata
  // content can be Editor.js JSON or null for empty doc
  function createDocument(title, content, parentId) {
    const id = generateId("doc");
    const now = new Date().toISOString();

    // Calculate word count from Editor.js blocks
    const editorData = content || { time: Date.now(), blocks: [] };
    const wordCount = countWordsInBlocks(editorData.blocks || []);

    const meta = {
      id,
      title: title || "Untitled",
      icon: "",
      parentId: parentId || null,
      order: listDocuments().filter((d) => d.parentId === (parentId || null)).length,
      createdAt: now,
      updatedAt: now,
      wordCount,
    };

    // Add to the metadata array
    const docs = readJSON("folio_documents", []);
    docs.push(meta);
    writeJSON("folio_documents", docs);

    // Store the Editor.js content separately
    writeJSON(`folio_doc_${id}`, editorData);

    return meta;
  }

  // Update a document's title, content, icon, parentId, or order
  function updateDocument(id, changes) {
    const docs = readJSON("folio_documents", []);
    const idx = docs.findIndex((d) => d.id === id);
    if (idx === -1) return null;

    // If Editor.js content changed, update it and recalculate word count
    if (changes.content !== undefined) {
      writeJSON(`folio_doc_${id}`, changes.content);
      docs[idx].wordCount = countWordsInBlocks(changes.content.blocks || []);
    }

    // Update other metadata fields if provided
    if (changes.title !== undefined) docs[idx].title = changes.title;
    if (changes.icon !== undefined) docs[idx].icon = changes.icon;
    if (changes.parentId !== undefined) docs[idx].parentId = changes.parentId;
    if (changes.order !== undefined) docs[idx].order = changes.order;

    // Always bump the updatedAt timestamp
    docs[idx].updatedAt = new Date().toISOString();
    writeJSON("folio_documents", docs);

    return docs[idx];
  }

  // Delete a document and all its associated data (highlights, comments)
  // Also deletes all child documents recursively
  function deleteDocument(id) {
    // First, recursively delete all children
    const children = getChildDocuments(id);
    children.forEach((child) => deleteDocument(child.id));

    let docs = readJSON("folio_documents", []);
    docs = docs.filter((d) => d.id !== id);
    writeJSON("folio_documents", docs);

    // Remove the content, highlights, and comments keys
    localStorage.removeItem(`folio_doc_${id}`);
    localStorage.removeItem(`folio_highlights_${id}`);
    localStorage.removeItem(`folio_comments_${id}`);
  }

  // Count words across all Editor.js blocks
  function countWordsInBlocks(blocks) {
    let text = "";
    blocks.forEach((block) => {
      if (block.data) {
        // Extract text from common block types
        if (block.data.text) text += " " + block.data.text;
        if (block.data.items) {
          block.data.items.forEach((item) => {
            // Checklist items have a 'text' field, list items may be strings or objects
            if (typeof item === "string") text += " " + item;
            else if (item.text) text += " " + item.text;
            else if (item.content) text += " " + item.content;
          });
        }
        if (block.data.content) {
          // Table content: array of arrays
          if (Array.isArray(block.data.content)) {
            block.data.content.forEach((row) => {
              if (Array.isArray(row)) row.forEach((cell) => (text += " " + cell));
            });
          }
        }
      }
    });
    // Strip HTML tags from the text before counting
    const stripped = text.replace(/<[^>]*>/g, "");
    return stripped.trim().split(/\s+/).filter(Boolean).length;
  }

  // ==========================================================================
  // SEARCH — Full-text search across all documents
  // ==========================================================================

  function searchDocuments(query) {
    if (!query || !query.trim()) return [];

    const q = query.toLowerCase().trim();
    const docs = listDocuments();
    const results = [];

    docs.forEach((doc) => {
      let score = 0;
      let matchSnippet = "";

      // Search in title (high weight)
      if (doc.title.toLowerCase().includes(q)) {
        score += 10;
        matchSnippet = doc.title;
      }

      // Search in content (lower weight)
      const content = readJSON(`folio_doc_${doc.id}`, { blocks: [] });
      const blocks = content.blocks || [];
      for (const block of blocks) {
        const blockText = extractBlockText(block);
        if (blockText.toLowerCase().includes(q)) {
          score += 1;
          if (!matchSnippet) {
            // Grab a snippet around the match
            const idx = blockText.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 30);
            const end = Math.min(blockText.length, idx + q.length + 50);
            matchSnippet = (start > 0 ? "..." : "") +
              blockText.slice(start, end) +
              (end < blockText.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({ doc, score, snippet: matchSnippet });
      }
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // Extract plain text from an Editor.js block
  function extractBlockText(block) {
    if (!block.data) return "";
    let text = "";
    if (block.data.text) text += block.data.text;
    if (block.data.items) {
      block.data.items.forEach((item) => {
        if (typeof item === "string") text += " " + item;
        else if (item.text) text += " " + item.text;
        else if (item.content) text += " " + item.content;
      });
    }
    // Strip HTML
    return text.replace(/<[^>]*>/g, "");
  }

  // ==========================================================================
  // HIGHLIGHTS — Read and write highlight data per document
  // ==========================================================================

  function getHighlights(docId) {
    return readJSON(`folio_highlights_${docId}`, []);
  }

  function saveHighlights(docId, highlights) {
    writeJSON(`folio_highlights_${docId}`, highlights);
  }

  // ==========================================================================
  // COMMENTS — Read and write comment data per document
  // ==========================================================================

  function getComments(docId) {
    return readJSON(`folio_comments_${docId}`, []);
  }

  function saveComments(docId, comments) {
    writeJSON(`folio_comments_${docId}`, comments);
  }

  // ==========================================================================
  // SETTINGS — Global app preferences
  // ==========================================================================

  const DEFAULT_SETTINGS = {
    theme: "default",
    fontSize: 18,
    lineHeight: 1.85,
    columnWidth: 720,
    lastOpenDocId: null,
    sidebarCollapsed: false,
  };

  function getSettings() {
    return readJSON("folio_settings", { ...DEFAULT_SETTINGS });
  }

  function saveSettings(settings) {
    writeJSON("folio_settings", settings);
  }

  // ==========================================================================
  // BACKUP / RESTORE — Export and import all data as a single JSON blob
  // ==========================================================================

  function exportAll() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("folio_")) {
        try {
          data[key] = JSON.parse(localStorage.getItem(key));
        } catch {
          data[key] = localStorage.getItem(key);
        }
      }
    }
    return data;
  }

  function importAll(data) {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("folio_")) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        localStorage.setItem(key, value);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  return {
    generateId,
    listDocuments,
    getTopLevelDocuments,
    getChildDocuments,
    getDocument,
    createDocument,
    updateDocument,
    deleteDocument,
    countWordsInBlocks,
    searchDocuments,
    getHighlights,
    saveHighlights,
    getComments,
    saveComments,
    getSettings,
    saveSettings,
    exportAll,
    importAll,
  };
})();

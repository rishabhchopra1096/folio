/*
 * =============================================================================
 * STORE.JS — localStorage Data Layer for Folio
 * =============================================================================
 * FILE OVERVIEW:
 * This file manages ALL persistent data for the Folio app. Since Folio is a
 * personal tool with no backend, everything lives in the browser's localStorage.
 *
 * HOW IT WORKS - The Data Model:
 * - folio_documents: JSON array of document metadata (title, dates, word count)
 * - folio_doc_{id}: Raw markdown string for each document (one key per doc)
 * - folio_highlights_{id}: JSON array of highlights per document
 * - folio_comments_{id}: JSON array of comments per document
 * - folio_settings: Global app settings (theme, font size, etc.)
 *
 * WHY separate content from metadata:
 * Loading the document list only reads the small metadata array, not every
 * document's full markdown content. This keeps the home screen fast.
 * =============================================================================
 */

// Wrap everything in an IIFE to avoid polluting the global scope,
// but expose the FolioStore object on window for other modules to use
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

  // Get the full list of document metadata objects, sorted by last updated
  function listDocuments() {
    const docs = readJSON("folio_documents", []);
    // Sort newest-updated first
    docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return docs;
  }

  // Get a single document's metadata and content
  function getDocument(id) {
    const docs = readJSON("folio_documents", []);
    const meta = docs.find((d) => d.id === id);
    if (!meta) return null;
    const content = localStorage.getItem(`folio_doc_${id}`) || "";
    return { meta, content };
  }

  // Create a new document and return its metadata
  function createDocument(title, content) {
    const id = generateId("doc");
    const now = new Date().toISOString();
    const wordCount = content.trim().split(/\s+/).filter(Boolean).length;

    const meta = {
      id,
      title: title || "Untitled",
      createdAt: now,
      updatedAt: now,
      wordCount,
    };

    // Add to the metadata array
    const docs = readJSON("folio_documents", []);
    docs.push(meta);
    writeJSON("folio_documents", docs);

    // Store the content separately
    localStorage.setItem(`folio_doc_${id}`, content);

    return meta;
  }

  // Update a document's title, content, or both
  function updateDocument(id, changes) {
    const docs = readJSON("folio_documents", []);
    const idx = docs.findIndex((d) => d.id === id);
    if (idx === -1) return null;

    // If content changed, update it and recalculate word count
    if (changes.content !== undefined) {
      localStorage.setItem(`folio_doc_${id}`, changes.content);
      docs[idx].wordCount = changes.content
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
    }

    // If title changed, update it
    if (changes.title !== undefined) {
      docs[idx].title = changes.title;
    }

    // Always bump the updatedAt timestamp
    docs[idx].updatedAt = new Date().toISOString();
    writeJSON("folio_documents", docs);

    return docs[idx];
  }

  // Delete a document and all its associated data (highlights, comments)
  function deleteDocument(id) {
    let docs = readJSON("folio_documents", []);
    docs = docs.filter((d) => d.id !== id);
    writeJSON("folio_documents", docs);

    // Remove the content, highlights, and comments keys
    localStorage.removeItem(`folio_doc_${id}`);
    localStorage.removeItem(`folio_highlights_${id}`);
    localStorage.removeItem(`folio_comments_${id}`);
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
    columnWidth: 680,
    lastOpenDocId: null,
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

  // Exports everything in localStorage that starts with "folio_" into one object
  function exportAll() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("folio_")) {
        // Try to parse as JSON; if it fails, store as raw string (for doc content)
        try {
          data[key] = JSON.parse(localStorage.getItem(key));
        } catch {
          data[key] = localStorage.getItem(key);
        }
      }
    }
    return data;
  }

  // Imports a previously exported JSON blob, overwriting existing data
  function importAll(data) {
    // Clear existing folio data first
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("folio_")) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    // Write the imported data
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        localStorage.setItem(key, value);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    }
  }

  // ==========================================================================
  // PUBLIC API — Expose all methods as a single object
  // ==========================================================================
  return {
    generateId,
    listDocuments,
    getDocument,
    createDocument,
    updateDocument,
    deleteDocument,
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

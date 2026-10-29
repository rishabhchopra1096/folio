/*
 * =============================================================================
 * IMAGES.JS — pictures live here, not inside the page
 * =============================================================================
 * WHAT THIS FILE DOES:
 * Keeps a document's pictures as real binary blobs in IndexedDB, and hands out
 * a short reference — "img_a3f2c1..." — for a page to store instead of the
 * picture itself.
 *
 * WHY IT EXISTS, with the numbers that forced it:
 * Pictures used to go straight into the page as base64 data URLs, which is
 * where a pasted screenshot has always gone. Then a real Notion export was
 * measured: 118 screenshots, 12.71MB on disk, about 17.4MB once base64 has
 * added its third — against the 10.00MB that Chrome allows this origin for
 * ALL of localStorage. The document could not be opened at all, and nothing
 * about how hard the pictures were compressed could change that: the median
 * file was 98KB and not one of the 118 was over the 500KB threshold where the
 * compressor even engages. They were already small. There were just a lot.
 *
 * IndexedDB has no such ceiling — the budget here is 250MB, the same figure
 * the read-aloud audio cache uses — and it stores a Blob as bytes rather than
 * as base64 text, so the third that encoding added goes away too.
 *
 * WHY IT LOOKS LIKE js/speechify.js:
 * Because that file already solved this problem for audio: a blob store, a
 * request for durable storage, eviction oldest-first, and a graceful collapse
 * to nothing in private browsing. Copying a shape that has been in use for
 * weeks is worth more than a cleverer one written today.
 *
 * WHAT A PAGE STORES NOW:
 *   { type: "image", data: { ref: "img_a3f2c1...", caption: "..." } }
 *
 * AND WHAT IT USED TO STORE, WHICH STILL WORKS AND ALWAYS WILL:
 *   { type: "image", data: { url: "data:image/jpeg;base64,...", caption: "..." } }
 *
 * Every page written before today holds the second shape. Both renderers
 * accept either, nothing is migrated, and no old page needs touching. A `ref`
 * that cannot be found degrades to a caption and a quiet note rather than a
 * broken-image icon.
 */
const FolioImages = (function () {
  // ==========================================================================
  // THE SHAPE OF THE STORE
  // ==========================================================================

  const DB_NAME = "folio-images";
  const DB_VERSION = 1;
  const DB_STORE = "pictures";

  /* Matches js/speechify.js. Generous, because a picture is cheap and a
   * missing picture in a document someone is reading is not. */
  const DISK_BUDGET_BYTES = 250 * 1024 * 1024;

  const REF_PREFIX = "img_";

  /*
   * Object URLs are cached and capped.
   *
   * createObjectURL pins its blob in memory until revoked, so an unbounded
   * cache turns reading a 118-picture document into holding all 118 in RAM for
   * the rest of the session. Capped and evicted least-recently-used, with the
   * revoke on the way out. 300 is comfortably more than one long document and
   * far less than a leak.
   */
  const URL_CACHE_MAX = 300;
  const urlCache = new Map();   // key -> objectURL, in insertion/touch order

  let dbPromise = null;

  // ==========================================================================
  // OPENING IT
  // ==========================================================================

  /*
   * Ask the browser not to throw a document's pictures away.
   *
   * Storage is BEST EFFORT by default: Safari clears it after about seven days
   * without a visit and Chrome evicts under pressure, neither of them asking.
   * For cached audio that means paying again. For the pictures in somebody's
   * document it means the document quietly losing its pictures, which is
   * worse, so the request is made the first time the store is opened rather
   * than waiting for anything else to ask.
   */
  function requestDurable() {
    try {
      if (typeof FolioStore !== "undefined" &&
          typeof FolioStore.requestDurableStorage === "function") {
        FolioStore.requestDurableStorage();
      }
    } catch { /* a refusal is not a failure */ }
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    requestDurable();
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: "key" });
          /* Eviction walks oldest-used first, so it needs its own index. */
          store.createIndex("lastUsed", "lastUsed");
          /* Deleting a page's pictures needs to find them without a full scan. */
          store.createIndex("docId", "docId");
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB would not open")); };
    }).catch(function (err) {
      /*
       * Private browsing and some lockdown modes refuse outright. Returning
       * null rather than throwing means every caller below degrades to "no
       * picture" instead of taking the import or the render down with it.
       */
      console.warn("[folio] the picture store is unavailable:",
                   err && err.message);
      return null;
    });
    return dbPromise;
  }

  function tx(db, mode) {
    return db.transaction(DB_STORE, mode).objectStore(DB_STORE);
  }

  const asPromise = (req) => new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });

  /* Is there anywhere to put a picture at all? Callers choose their fallback. */
  async function available() {
    return !!(await openDb());
  }

  // ==========================================================================
  // NAMING A PICTURE BY WHAT IT CONTAINS
  // ==========================================================================
  /*
   * The key is a hash of the bytes, so the same picture twice costs once.
   *
   * That is not a micro-optimisation on a Notion export. A document that
   * shows the same screenshot in two places — a before-and-after, a diagram
   * referred to twice — genuinely stores it once, and the dedupe is free
   * because the hash has to be computed anyway to have a stable name.
   *
   * WHEN HASHING IS NOT AVAILABLE, the key is random instead. crypto.subtle
   * needs a secure context; https and file:// both qualify, so this should
   * never fire, but a weaker hash would risk two different pictures colliding
   * on one key and showing the wrong image — and losing dedupe is a far
   * smaller price than that.
   */
  async function keyFor(blob) {
    try {
      if (crypto && crypto.subtle && crypto.subtle.digest) {
        const buf = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const hex = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        return REF_PREFIX + hex.slice(0, 32);
      }
    } catch { /* fall through to a random name */ }
    return REF_PREFIX + "r" + Date.now().toString(36) +
           Math.random().toString(36).slice(2, 10);
  }

  function isRef(value) {
    return typeof value === "string" && value.indexOf(REF_PREFIX) === 0;
  }

  // ==========================================================================
  // PUTTING ONE IN
  // ==========================================================================

  /*
   * put — store a picture and return the reference a page should hold.
   *
   * Returns null when there is nowhere to store it, which is the signal for a
   * caller to fall back to putting the picture in the page the old way. A
   * document with its pictures inline is worse than one with them out of the
   * way; a document with no pictures at all is worse than both.
   *
   * `docId` is recorded so a deleted page can take its pictures with it. It is
   * a hint, not ownership: the same picture shared by two pages keeps the
   * first page's id, and the garbage collector below is what actually decides
   * whether anything still references it.
   */
  async function put(blob, docId) {
    const db = await openDb();
    if (!db || !blob || !blob.size) return null;

    const key = await keyFor(blob);
    const now = Date.now();

    try {
      const existing = await asPromise(tx(db, "readonly").get(key));
      if (existing) {
        /* Already here — the same bytes. Touch it so eviction knows it is live. */
        existing.lastUsed = now;
        try { tx(db, "readwrite").put(existing); } catch { /* a touch is best effort */ }
        return key;
      }
      await asPromise(tx(db, "readwrite").put({
        key,
        blob,
        type: blob.type || "image/jpeg",
        bytes: blob.size,
        docId: docId || null,
        createdAt: now,
        lastUsed: now,
      }));
      return key;
    } catch (err) {
      console.warn("[folio] could not store a picture:", err && err.message);
      return null;
    }
  }

  /*
   * putDataUrl — store a picture that has already been compressed to a data URL.
   *
   * Both ways a picture enters Folio end up holding a data URL at this point:
   * a pasted screenshot because that is what compressImage returns, and an
   * imported file because it goes through the same compressor. Decoding it
   * back to bytes here means one place does the conversion and one place
   * decides what happens when there is nowhere to store it.
   *
   * Returns null when the picture could not be stored, which is the caller's
   * signal to keep it in the page the old way. A picture inline is subject to
   * the 10MB ceiling; a picture lost is lost.
   */
  async function putDataUrl(dataUrl, docId) {
    if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) return null;
    try {
      /* fetch() on a data: URL is the shortest correct decode — it handles the
       * mime type and the base64 padding without this file having to. */
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      if (!blob || !blob.size) return null;
      return await put(blob, docId);
    } catch (err) {
      console.warn("[folio] could not move a picture out of the page:",
                   err && err.message);
      return null;
    }
  }

  // ==========================================================================
  // GETTING ONE OUT
  // ==========================================================================

  /*
   * url — an object URL for a reference, or null if it is not here.
   *
   * Memoised, because a document can show the same picture twice and because
   * re-reading a blob out of IndexedDB on every render would make scrolling
   * a long document do disk work it does not need to.
   */
  async function url(ref) {
    if (!isRef(ref)) return null;

    if (urlCache.has(ref)) {
      /* Re-insert to move it to the most-recent end of the cache. */
      const hit = urlCache.get(ref);
      urlCache.delete(ref);
      urlCache.set(ref, hit);
      return hit;
    }

    const db = await openDb();
    if (!db) return null;

    try {
      const rec = await asPromise(tx(db, "readonly").get(ref));
      if (!rec || !rec.blob) return null;

      rec.lastUsed = Date.now();
      try { tx(db, "readwrite").put(rec); } catch { /* a touch is best effort */ }

      const objectUrl = URL.createObjectURL(rec.blob);
      urlCache.set(ref, objectUrl);
      trimUrlCache();
      return objectUrl;
    } catch (err) {
      console.warn("[folio] could not read a picture:", err && err.message);
      return null;
    }
  }

  function trimUrlCache() {
    while (urlCache.size > URL_CACHE_MAX) {
      const oldest = urlCache.keys().next().value;
      const dead = urlCache.get(oldest);
      urlCache.delete(oldest);
      try { URL.revokeObjectURL(dead); } catch { /* already gone */ }
    }
  }

  // ==========================================================================
  // PUTTING THEM ON SCREEN
  // ==========================================================================

  /*
   * attach — fill in every picture under `root` that is waiting for one.
   *
   * Both renderers mark a waiting picture the same way: an <img> with
   * data-folio-ref and no src. The editor's image block builds its node
   * synchronously because Editor.js requires it, and the reader builds a
   * string of HTML in one go — neither can await a lookup mid-render, so the
   * lookup happens here, afterwards.
   *
   * A reference that is not in the store leaves a short note rather than a
   * broken-image icon. That case is real: storage can be cleared, or a page
   * can be opened in a different browser from the one it was imported in,
   * where the pictures genuinely are not.
   */
  function attach(root) {
    const scope = root || document;
    const waiting = scope.querySelectorAll("img[data-folio-ref]:not([src])");
    if (!waiting.length) return Promise.resolve(0);

    const jobs = Array.from(waiting).map(async (img) => {
      const ref = img.getAttribute("data-folio-ref");
      const objectUrl = await url(ref);
      if (objectUrl) {
        img.src = objectUrl;
        return true;
      }
      missingPicture(img);
      return false;
    });

    return Promise.all(jobs).then((r) => r.filter(Boolean).length);
  }

  /*
   * Say the picture is not here, in words, where the picture would have been.
   *
   * An <img> with no src collapses to nothing and a broken one shows the
   * browser's torn-paper icon; both leave someone wondering whether the
   * document ever had a picture there. The caption is usually still on the
   * page beside this, which is often enough to know what is missing.
   */
  function missingPicture(img) {
    if (img.dataset.folioMissing) return;
    img.dataset.folioMissing = "1";
    const note = document.createElement("div");
    note.className = "folio-image-missing";
    note.textContent = "This picture is not stored in this browser";
    if (img.parentNode) img.parentNode.insertBefore(note, img);
    img.remove();
  }

  // ==========================================================================
  // THROWING THEM AWAY
  // ==========================================================================

  /*
   * forget — drop the pictures recorded against one page.
   *
   * Called when a page is deleted. It uses the docId hint, so a picture that
   * two pages share and that happens to be recorded against the deleted one
   * would go while the other page still wants it. collectGarbage below is the
   * backstop for that: it decides by what pages actually reference, and a
   * picture wrongly dropped here is re-stored on the next import rather than
   * lost from a document that is itself being deleted.
   */
  async function forget(docId) {
    const db = await openDb();
    if (!db || !docId) return 0;
    try {
      const keys = await asPromise(tx(db, "readonly").index("docId").getAllKeys(docId));
      for (const key of keys || []) {
        await asPromise(tx(db, "readwrite").delete(key));
        dropFromCache(key);
      }
      return (keys || []).length;
    } catch (err) {
      console.warn("[folio] could not forget pictures for " + docId, err);
      return 0;
    }
  }

  /*
   * assign — record which page these pictures belong to.
   *
   * An import has to store the pictures BEFORE it can create the page, because
   * the page's blocks are what hold the references — so at the moment a
   * picture is written there is no page id to record against it. This is
   * called once the page exists.
   *
   * Without it the pictures are simply unowned: forget() would not find them
   * when the page is deleted, and they would wait for collectGarbage instead.
   * That is a slower cleanup, not a leak, which is why this is allowed to fail
   * quietly.
   */
  async function assign(refs, docId) {
    const db = await openDb();
    if (!db || !docId || !refs || !refs.length) return 0;

    const wanted = refs.filter(isRef);
    if (!wanted.length) return 0;

    /*
     * ONE TRANSACTION FOR ALL OF THEM, not one each.
     *
     * The first version awaited a get and a put per picture, which for a
     * 120-picture import is 240 separate transactions. It finished, but
     * slowly enough that a page deleted immediately afterwards could run
     * forget() while a few pictures were still unclaimed — and an unclaimed
     * picture is one forget() cannot find. The browser probe caught exactly
     * that: 119 of 120 released, one left behind waiting for the garbage
     * collector.
     *
     * In a single transaction the whole claim either happens or does not, and
     * it is fast enough that the caller can afford to await it.
     */
    return new Promise(function (resolve) {
      let done = 0;
      let store;
      try { store = tx(db, "readwrite"); }
      catch { return resolve(0); }

      store.transaction.oncomplete = function () { resolve(done); };
      store.transaction.onerror = function () { resolve(done); };
      store.transaction.onabort = function () { resolve(done); };

      for (const ref of wanted) {
        const get = store.get(ref);
        get.onsuccess = function () {
          const rec = get.result;
          if (!rec) return;
          /* First page to claim it keeps it; a shared picture is not reassigned. */
          if (rec.docId) return;
          rec.docId = docId;
          store.put(rec);
          done++;
        };
        /* A single unreadable record must not abort the others. */
        get.onerror = function (e) { e.preventDefault(); };
      }
    });
  }

  function dropFromCache(key) {
    if (!urlCache.has(key)) return;
    try { URL.revokeObjectURL(urlCache.get(key)); } catch { /* already gone */ }
    urlCache.delete(key);
  }

  /*
   * Every reference held by any page in this browser.
   *
   * Read through FolioStore, never straight out of localStorage: page content
   * is lz-compressed behind a prefix, so a raw read returns compressed text
   * and finding no references in it would make the collector below delete
   * every picture in the store.
   */
  function referencedRefs() {
    const refs = new Set();
    try {
      const docs = FolioStore.listDocuments();
      for (const meta of docs) {
        const doc = FolioStore.getDocument(meta.id);
        const blocks = (doc && doc.content && doc.content.blocks) || [];
        for (const b of blocks) {
          if (b && b.type === "image" && isRef(b.data && b.data.ref)) refs.add(b.data.ref);
        }
      }
    } catch (err) {
      /* Returning null — NOT an empty set — so the caller refuses to delete. */
      console.warn("[folio] could not read the pages to check pictures", err);
      return null;
    }
    return refs;
  }

  /*
   * collectGarbage — delete pictures no page refers to any more.
   *
   * Deleting an image block, or undoing an import, leaves its picture behind.
   * Nothing points at it and nothing will, so it sits in the budget for ever.
   *
   * TWO GUARDS, both of which exist because the failure here is deleting a
   * picture somebody still wants:
   *
   *   1. If the pages cannot be read, nothing is deleted. An empty reference
   *      set from a failed read looks exactly like a store full of orphans.
   *   2. Nothing younger than GRACE is touched, so a picture written seconds
   *      ago by an import that has not yet saved its page is safe. Without
   *      this, running the collector during an import would eat it.
   */
  const GRACE_MS = 10 * 60 * 1000;

  async function collectGarbage() {
    const db = await openDb();
    if (!db) return { ran: false, deleted: 0 };

    const refs = referencedRefs();
    if (!refs) return { ran: false, deleted: 0, why: "could not read the pages" };

    try {
      const all = await asPromise(tx(db, "readonly").getAll());
      const cutoff = Date.now() - GRACE_MS;
      let deleted = 0, bytes = 0;
      for (const rec of all || []) {
        if (refs.has(rec.key)) continue;
        if ((rec.createdAt || 0) > cutoff) continue;
        await asPromise(tx(db, "readwrite").delete(rec.key));
        dropFromCache(rec.key);
        deleted++; bytes += rec.bytes || 0;
      }
      if (deleted) {
        console.log("[folio] released " + deleted + " unused picture(s), " +
                    (bytes / 1048576).toFixed(2) + "MB");
      }
      return { ran: true, deleted, bytes };
    } catch (err) {
      console.warn("[folio] could not collect unused pictures", err);
      return { ran: false, deleted: 0 };
    }
  }

  /*
   * sweep — hold the store under its budget, oldest-used first.
   *
   * Runs after an import rather than before, because refusing a picture to
   * stay under a budget that a sweep would have freed is the wrong order.
   */
  async function sweep() {
    const db = await openDb();
    if (!db) return { ran: false };
    try {
      const all = await asPromise(tx(db, "readonly").getAll());
      let total = (all || []).reduce((n, r) => n + (r.bytes || 0), 0);
      if (total <= DISK_BUDGET_BYTES) return { ran: true, evicted: 0, bytes: total };

      const byOldest = (all || []).slice().sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
      let evicted = 0;
      for (const rec of byOldest) {
        if (total <= DISK_BUDGET_BYTES) break;
        await asPromise(tx(db, "readwrite").delete(rec.key));
        dropFromCache(rec.key);
        total -= rec.bytes || 0;
        evicted++;
      }
      return { ran: true, evicted, bytes: total };
    } catch (err) {
      console.warn("[folio] could not sweep the picture store", err);
      return { ran: false };
    }
  }

  /* For the settings panel, and for a report that does not have to guess. */
  async function stats() {
    const db = await openDb();
    if (!db) return { available: false, count: 0, bytes: 0 };
    try {
      const all = await asPromise(tx(db, "readonly").getAll());
      return {
        available: true,
        count: (all || []).length,
        bytes: (all || []).reduce((n, r) => n + (r.bytes || 0), 0),
      };
    } catch {
      return { available: false, count: 0, bytes: 0 };
    }
  }

  // ==========================================================================
  // WHAT THE REST OF THE APP CAN CALL
  // ==========================================================================
  return {
    REF_PREFIX,
    isRef,
    available,
    put,
    putDataUrl,
    url,
    assign,
    attach,
    forget,
    collectGarbage,
    sweep,
    stats,
  };
})();

/* Node can require this file too, for the parts that need no browser. */
if (typeof module !== "undefined" && module.exports) module.exports = FolioImages;

/*
 * =============================================================================
 * FOLDER-IMPORT.JS — bringing in a Notion export, pictures and all
 * =============================================================================
 * WHAT THIS FILE DOES:
 * Takes a folder someone dragged onto Folio, finds the markdown and the
 * pictures inside it, and creates a page per markdown file with the pictures
 * actually showing.
 *
 * WHY IT EXISTS:
 * A Notion export is not a file, it is a folder. Unzipped, one page looks like:
 *
 *     Export/
 *       Reading the Market 24f8e1c0/        ← the pictures
 *         Untitled.png
 *       Reading the Market 24f8e1c0.md      ← the page
 *
 * and inside the markdown every picture is a RELATIVE path, percent-encoded:
 *
 *     ![](Reading%20the%20Market%2024f8e1c0/Untitled.png)
 *
 * Dropping a file read exactly one file — the markdown — so the pictures were
 * never present to resolve those paths against, and js/markdown.js refused
 * every one of them. On a real export that is every picture in the document
 * disappearing with no error anywhere.
 *
 * HOW IT WORKS — and why in this order:
 *   1. Grab the dropped entries SYNCHRONOUSLY. The browser empties
 *      DataTransfer.items the moment the drop handler returns, so the walk has
 *      to start from entries taken before any `await`.
 *   2. Walk the tree for markdown files and picture files.
 *   3. Ask js/markdown.js which pictures each document actually references, so
 *      an export folder full of unused files only costs what is in use.
 *   4. Read and compress those pictures into data URLs.
 *   5. Convert the markdown with a lookup for the relative paths.
 *
 * Steps 3–5 are split that way because reading a file is asynchronous and the
 * markdown converter is deliberately not. Resolving the pictures first means
 * the converter still gets a plain synchronous lookup, and stays a pure
 * function the Node tests can call without a browser.
 *
 * WHERE THE PICTURES END UP:
 * Inside the page, as data URLs — the same place a pasted screenshot goes.
 * That is the cheap route and it has a ceiling: this origin gets 10MB of
 * ordinary storage in total, base64 is a third larger than the bytes it
 * carries, and a PNG does not compress a second time. Roughly 3–4MB of
 * original picture bytes across the whole app. The ceiling is handled rather
 * than hoped about — see `createPage` — and docs/notion-images/README.md
 * records what replaces this when it starts to hurt.
 */
const FolioFolderImport = (function () {
  // ==========================================================================
  // WHAT COUNTS AS WHAT
  // ==========================================================================

  const MD_RE = /\.(md|markdown|txt)$/i;
  const IMG_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

  /* A folder tree deeper than this is a mistake or a loop, not an export. */
  const MAX_DEPTH = 10;
  /* Enough for an export with subpages; a guard against walking a home folder. */
  const MAX_FILES = 4000;

  // ==========================================================================
  // READING THE DROP
  // ==========================================================================

  /*
   * The dropped entries, taken before anything can await.
   *
   * THIS IS THE ONE ORDERING RULE THAT MATTERS IN THIS FILE. `items` is a live
   * list that the browser clears as soon as the drop event finishes, and
   * `webkitGetAsEntry()` returns null once it has. So this runs first, inside
   * the handler, and everything slow happens afterwards on what it returned.
   */
  function entriesFrom(dataTransfer) {
    const out = [];
    const items = dataTransfer && dataTransfer.items;
    if (!items) return out;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item.webkitGetAsEntry !== "function") continue;
      const entry = item.webkitGetAsEntry();
      if (entry) out.push(entry);
    }
    return out;
  }

  /* Does this drop contain a folder at all? Decides whether to walk or not. */
  function hasDirectory(entries) {
    return entries.some((e) => e && e.isDirectory);
  }

  function readEntries(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  function entryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  /*
   * Walk one entry into a flat list of { path, file }.
   *
   * `path` is relative to the drop, so a file inside the dropped folder keeps
   * the folder's own name at the front. That is deliberate: which level of the
   * tree got dragged is unknowable here, and `pathsFor` below is what makes
   * both possibilities work.
   *
   * readEntries() hands back at most 100 children per call and signals the end
   * by returning an empty batch, so it is asked repeatedly. Reading it once —
   * the obvious way to write this — silently truncates any folder with more
   * than a hundred things in it.
   */
  async function walk(entry, prefix, out, depth) {
    if (!entry || depth > MAX_DEPTH || out.length >= MAX_FILES) return;

    if (entry.isFile) {
      if (!MD_RE.test(entry.name) && !IMG_RE.test(entry.name)) return;
      try {
        out.push({ path: prefix + entry.name, file: await entryFile(entry) });
      } catch {
        /* One unreadable file must not take the whole import down. */
      }
      return;
    }

    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const childPrefix = prefix + entry.name + "/";
    for (;;) {
      let batch = [];
      try { batch = await readEntries(reader); } catch { break; }
      if (!batch || !batch.length) break;
      for (const child of batch) {
        await walk(child, childPrefix, out, depth + 1);
        if (out.length >= MAX_FILES) return;
      }
    }
  }

  async function filesFrom(entries) {
    const out = [];
    for (const entry of entries) await walk(entry, "", out, 0);
    return out;
  }

  // ==========================================================================
  // MATCHING A MARKDOWN PATH TO A FILE ON DISK
  // ==========================================================================
  /*
   * Three keys, tried most specific first, because the right one depends on
   * which folder was dragged.
   *
   * Drag the outer `Export/` and the walk sees
   * `Export/Reading the Market 24f8e1c0/Untitled.png` while the markdown asks
   * for `Reading the Market 24f8e1c0/Untitled.png`. Drag the inner folder and
   * the two agree. Neither is wrong, and telling someone to drag a particular
   * level of a folder tree is an instruction nobody reads.
   *
   * So: the path joined to the markdown file's own directory, then the path as
   * written, then the bare filename. The bare filename is LAST because it is
   * the one that can collide — two subfolders can both hold `Untitled.png` —
   * and a possibly-wrong picture still beats a missing one.
   */
  function normalize(p) {
    return String(p || "")
      .replace(/\\/g, "/")        // Windows separators
      .replace(/^\.\//, "")       // a leading ./ means nothing
      .replace(/^\/+/, "");       // nor does a leading /
  }

  /* Percent-encoded is how Notion writes a path with spaces in it. */
  function decodePath(href) {
    let out = String(href || "");
    try { out = decodeURIComponent(out); } catch { /* leave it as written */ }
    return normalize(out.split("#")[0].split("?")[0]);
  }

  function dirOf(path) {
    const at = normalize(path).lastIndexOf("/");
    return at === -1 ? "" : normalize(path).slice(0, at + 1);
  }

  function baseOf(path) {
    const parts = normalize(path).split("/");
    return parts[parts.length - 1];
  }

  /* The candidate keys for one href, in the order they should be tried. */
  function pathsFor(href, mdPath) {
    const rel = decodePath(href);
    if (!rel) return [];
    const keys = [dirOf(mdPath) + rel, rel, baseOf(rel)];
    // Deduplicate while keeping the order — the three collapse into one when
    // the markdown sits at the root of the drop.
    return keys.filter((k, i) => k && keys.indexOf(k) === i);
  }

  /*
   * An index of the dropped pictures.
   *
   * Exact match first and a lowercased fallback second, because macOS and
   * Windows do not care about the case of a filename and an exported path and
   * the file it names can therefore disagree about it.
   */
  function indexAssets(files) {
    const exact = new Map();
    const lower = new Map();
    for (const item of files) {
      if (!IMG_RE.test(item.path)) continue;
      const full = normalize(item.path);
      const base = baseOf(full);
      for (const key of [full, base]) {
        if (!exact.has(key)) exact.set(key, item.file);
        const lk = key.toLowerCase();
        if (!lower.has(lk)) lower.set(lk, item.file);
      }
    }
    return {
      find(href, mdPath) {
        for (const key of pathsFor(href, mdPath)) {
          if (exact.has(key)) return exact.get(key);
          const lk = key.toLowerCase();
          if (lower.has(lk)) return lower.get(lk);
        }
        return null;
      },
      size: exact.size,
    };
  }

  // ==========================================================================
  // TURNING A PICTURE FILE INTO SOMETHING A PAGE CAN HOLD
  // ==========================================================================
  /*
   * Compression goes through the editor's `compressImage`, which is the one a
   * pasted screenshot already uses: untouched below 500KB, otherwise resized
   * to 1800px on the long edge and re-encoded as JPEG. Sharing it rather than
   * writing a second one means an imported picture and a pasted picture are
   * the same size and the same quality, and there is one place to change that.
   *
   * SVG is passed through unresized: it is text, it is usually tiny, and a
   * canvas would turn a sharp vector into a blurry bitmap.
   */
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("could not read " + (file.name || "a picture")));
      r.readAsDataURL(file);
    });
  }

  async function toDataUrl(file) {
    const isSvg = /svg/i.test(file.type || "") || /\.svg$/i.test(file.name || "");
    if (!isSvg && typeof Editor !== "undefined" && typeof Editor.compressImage === "function") {
      return await Editor.compressImage(file);
    }
    return await readAsDataUrl(file);
  }

  /*
   * Resolve every picture one document asks for.
   *
   * Returns a plain Map, so the conversion that follows stays synchronous. A
   * picture that cannot be read is left out rather than aborting the import —
   * losing one image is survivable, losing the document is not — and the count
   * comes back so the caller can say so.
   */
  async function resolvePictures(markdown, mdPath, assets) {
    const refs = FolioMarkdown.imageRefs(markdown);
    const resolved = new Map();
    let missing = 0;
    let bytes = 0;

    for (const href of refs) {
      const file = assets.find(href, mdPath);
      if (!file) { missing++; continue; }
      try {
        const url = await toDataUrl(file);
        resolved.set(href, url);
        bytes += url.length;
      } catch (err) {
        missing++;
        console.warn("[folio] could not bring in " + href, err);
      }
    }
    return { resolved, missing, found: resolved.size, asked: refs.length, bytes };
  }

  // ==========================================================================
  // CREATING THE PAGES
  // ==========================================================================
  /*
   * Create one page, and leave nothing behind if storage refuses it.
   *
   * FolioStore.createDocument writes the page LIST before the page CONTENT, so
   * a write that fails on the second half leaves a page in the sidebar with
   * nothing inside it. That is unlikely with prose and genuinely likely with
   * pictures, which is the whole reason this path is written out rather than
   * calling createDocument and hoping. The rollback is what keeps a full disk
   * from littering the sidebar with empty pages.
   */
  function createPage(title, editorData) {
    let meta = null;
    try {
      meta = FolioStore.createDocument(title, editorData, null);
      return { meta };
    } catch (err) {
      if (meta && meta.id) {
        try { FolioStore.deleteDocument(meta.id); } catch { /* best effort */ }
      }
      return { meta: null, error: err };
    }
  }

  function titleFor(path, markdown) {
    /*
     * Notion puts the page id on the end of the filename
     * ("Reading the Market 24f8e1c0b3f5801aa9f1.md"), which is not a title
     * anybody wants to look at. The document's own first heading is the real
     * title, so prefer it and fall back to a cleaned-up filename.
     */
    const firstHeading = /^\s*#\s+(.+)$/m.exec(markdown || "");
    if (firstHeading && firstHeading[1].trim()) return firstHeading[1].trim();

    return baseOf(path)
      .replace(/\.[^.]+$/, "")
      .replace(/\s+[0-9a-f]{8,}$/i, "")   // the trailing Notion id
      .trim() || "Untitled";
  }

  // ==========================================================================
  // THE WHOLE JOURNEY
  // ==========================================================================

  /*
   * importEntries — from a walked folder to pages on screen.
   *
   * Every markdown file found becomes its own page. A Notion export of a page
   * with children holds several, and importing one and discarding the rest
   * would lose content without saying so. They arrive flat rather than nested;
   * see the gap list in docs/notion-images/README.md.
   */
  async function importEntries(entries) {
    const files = await filesFrom(entries);
    const docs = files.filter((f) => MD_RE.test(f.path));
    if (!docs.length) {
      return { handled: false, reason: "no-markdown", pages: [] };
    }

    const assets = indexAssets(files);
    // Shallowest first, so the parent page of an export lands above its subpages.
    docs.sort((a, b) => a.path.split("/").length - b.path.split("/").length ||
                        a.path.localeCompare(b.path));

    const pages = [];
    let pictures = 0;
    let missing = 0;
    let stoppedFull = null;

    for (const doc of docs) {
      let markdown = "";
      try { markdown = await readText(doc.file); }
      catch { missing++; continue; }

      const pics = await resolvePictures(markdown, doc.path, assets);
      pictures += pics.found;
      missing += pics.missing;

      const editorData = FolioMarkdown.toBlocks(markdown, {
        resolveImage: (href) => pics.resolved.get(href) || null,
      });

      const made = createPage(titleFor(doc.path, markdown), editorData);
      if (made.error) {
        stoppedFull = made.error;
        break;
      }
      pages.push(made.meta);
    }

    return {
      handled: true,
      pages,
      pictures,
      missing,
      total: docs.length,
      error: stoppedFull,
    };
  }

  function readText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(new Error("could not read " + (file.name || "that file")));
      r.readAsText(file);
    });
  }

  /*
   * fromDrop — the entry point a drop handler calls.
   *
   * Returns false, synchronously enough to matter, when the drop is not a
   * folder: the existing single-file behaviour must keep working exactly as it
   * did, and the caller decides that by what comes back here.
   */
  function fromDrop(dataTransfer) {
    const entries = entriesFrom(dataTransfer);
    if (!hasDirectory(entries)) return null;
    return importEntries(entries);
  }

  /*
   * A message in the words of what happened, not of what the code did.
   *
   * The "nothing fitted" case gets its own sentence rather than being built up
   * from the same pieces as the others, because composing it produced
   * "Nothing could be imported with 118 pictures" — which reads as though the
   * pictures were the thing that was imported. A real export failing on the
   * ceiling is the likeliest outcome of all for a screenshot-heavy document,
   * so it is the sentence most worth getting right.
   */
  function describe(result) {
    if (!result || !result.handled) return "";
    const n = result.pages.length;
    const pics = result.pictures
      ? " with " + result.pictures + (result.pictures === 1 ? " picture" : " pictures")
      : "";

    if (!n) {
      return result.error && result.error.folioQuota
        ? "Storage is full, so nothing was imported — that export is too big to " +
          "fit. Pictures take up a lot of room."
        : "Nothing in that folder could be imported";
    }

    /* Say the denominator when some pages were left behind, not just the count. */
    let msg = result.total && result.total > n
      ? "Imported " + n + " of " + result.total + " pages" + pics
      : "Imported " + n + (n === 1 ? " page" : " pages") + pics;

    if (result.missing) {
      msg += ". " + result.missing +
             (result.missing === 1 ? " picture was" : " pictures were") +
             " not in the folder";
    }
    if (result.error) {
      msg += result.error.folioQuota
        ? ". Storage then filled up, so the rest was left out"
        : ". The rest could not be saved";
    }
    return msg;
  }

  // ==========================================================================
  // WHAT THE REST OF THE APP CAN CALL
  // ==========================================================================
  return {
    fromDrop,
    importEntries,
    describe,
    /* Exposed for the tests — the path matching is the fiddly part. */
    _internals: { pathsFor, indexAssets, decodePath, titleFor, baseOf, dirOf },
  };
})();

/* Node can require this file too, so the path matching needs no browser. */
if (typeof module !== "undefined" && module.exports) module.exports = FolioFolderImport;

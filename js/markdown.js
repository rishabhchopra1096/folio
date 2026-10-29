/*
 * =============================================================================
 * MARKDOWN.JS — turning markdown text into Editor.js blocks
 * =============================================================================
 * WHAT THIS FILE DOES:
 * Takes a string of markdown — from a dragged-in .md file, from a file opened
 * on the drive screen, from a paste — and returns the block structure Folio
 * actually stores: { time, blocks: [ { type, data }, ... ] }.
 *
 * WHY IT IS ITS OWN FILE:
 * It used to live inside js/sidebar.js, because the sidebar was the only thing
 * that imported markdown. Then the drive screen grew a "paste a page" box, and
 * there were two ways in with one converter between them. The choices were:
 *
 *   1. Load the whole sidebar on the drive screen — 36KB of page-tree,
 *      context-menu and search code, on a phone, on a car's network, for one
 *      function.
 *   2. Write a smaller converter for the drive screen.
 *   3. Move the converter here and have both ways in call it.
 *
 * (2) is the tempting one and the wrong one. Where the converter decides a
 * heading ends and a paragraph begins is where the voice pauses and where a
 * dictated note can attach itself, so a second, simpler converter would mean a
 * pasted page reading differently from the same file dragged in on the laptop
 * — a difference nobody would think to look for.
 *
 * WHAT IT NEEDS:
 * `marked`, loaded globally (vendor/marked.min.js). If marked is missing this
 * degrades to one plain paragraph rather than throwing, because losing the
 * formatting of a pasted page is survivable and losing the page is not.
 *
 * THE FLOW:
 * toBlocks() runs marked's lexer for the block-level shape, then
 * marked.parseInline on each block's text for the inline shape, then maps each
 * token to the Editor.js block that can hold it.
 */
const FolioMarkdown = (function () {
  // ==========================================================================
  // ESCAPING — a local copy, because this file must not depend on the sidebar
  // ==========================================================================

  /*
   * Turn text into HTML that means exactly that text.
   *
   * Uses the DOM rather than a regular expression over the five dangerous
   * characters, because the DOM is the thing that will later parse the result
   * and so is the only authority on what needs escaping.
   */
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ==========================================================================
  // MARKDOWN IMPORT — Convert markdown text to Editor.js blocks
  // ==========================================================================

  /*
   * markdownToBlocks — Convert a raw markdown string into Editor.js block data.
   *
   * Uses `marked` (loaded globally) in two passes:
   *   1. marked.lexer(md) gives a flat token stream for block-level structure
   *      (headings, paragraphs, lists, tables, code fences, etc.)
   *   2. marked.parseInline(text) on each block's text converts inline markdown
   *      (**bold**, *italic*, `code`, [link](url)) into the HTML that Editor.js
   *      paragraph/header/list/table/quote sanitizers accept out of the box.
   *
   * Without step 2, asterisks and backticks survive as literal characters in
   * the rendered document because Editor.js never parses markdown itself.
   */
  function markdownToBlocks(md, opts) {
    if (typeof marked === "undefined") {
      // Fallback: marked failed to load — treat the whole thing as one paragraph
      return { time: Date.now(), blocks: [{ type: "paragraph", data: { text: escapeHtml(md) } }] };
    }

    const blocks = [];
    const tokens = marked.lexer(md);

    for (const token of tokens) {
      const block = tokenToBlock(token, opts);
      if (block) blocks.push(block);
    }

    return { time: Date.now(), blocks };
  }

  // ==========================================================================
  // IMAGES THAT LIVE IN A FOLDER RATHER THAN ON THE WEB
  // ==========================================================================
  /*
   * A Notion export points at its pictures with a relative path:
   *
   *     ![](Reading%20the%20Market%2024f8e1c0/Untitled.png)
   *
   * That is not a URL this file can do anything with on its own. There is no
   * folder here — only a string of markdown — so for most of Folio's history
   * such a path was refused and the picture silently disappeared. On a real
   * export that is every picture in the document, with no error anywhere.
   *
   * The resolution has to come from whoever had the files. An importer that
   * read a dropped folder passes `opts.resolveImage`, a lookup from relative
   * path to something renderable; a paste, which has no folder behind it, does
   * not, and relative paths stay refused there because nothing could honour
   * them.
   *
   * THE REFUSAL IS STILL HERE. Whatever the lookup hands back is checked
   * against the same list of sources that an inline `![](...)` is, so an
   * importer cannot widen what this file will render — `javascript:` is still
   * refused however it arrives.
   */
  const SAFE_SRC = /^(data:image\/|blob:|https?:)/;
  /*
   * A reference to a picture kept outside the page (js/images.js). Matched
   * strictly rather than by prefix, so nothing that merely starts with the
   * right four characters is written into a page as though it were one.
   */
  const SAFE_REF = /^img_[A-Za-z0-9]{8,40}$/;

  /*
   * What a page should store for one picture: { url } or { ref }, or nothing.
   *
   * A lookup may hand back either a source string — which is checked against
   * the same list an inline `![](...)` is — or `{ ref }`, meaning the picture
   * has been put in IndexedDB and the page only needs its name. Both are
   * validated here, so an importer still cannot widen what a page may hold.
   */
  function resolveImageData(href, opts) {
    if (!href) return null;
    if (SAFE_SRC.test(href)) return { url: href };

    const lookup = opts && opts.resolveImage;
    if (typeof lookup !== "function") return null;

    let found = null;
    try { found = lookup(href); } catch { return null; }
    if (!found) return null;

    if (typeof found === "string") return SAFE_SRC.test(found) ? { url: found } : null;
    if (typeof found === "object") {
      if (SAFE_REF.test(String(found.ref || ""))) return { ref: String(found.ref) };
      if (typeof found.url === "string" && SAFE_SRC.test(found.url)) return { url: found.url };
    }
    return null;
  }

  function imageBlock(href, caption, opts) {
    const found = resolveImageData(href, opts);
    if (!found) return null;
    return { type: "image", data: { ...found, caption: caption || "" } };
  }

  /*
   * Every picture this document asks for, in the order it asks.
   *
   * An importer needs this BEFORE converting, because reading a file is
   * asynchronous and the conversion above is not. Knowing the list up front
   * means the pictures can be read and compressed first and the lookup handed
   * over as a plain synchronous function — which is what keeps toBlocks a pure
   * function that the tests can call without a browser.
   *
   * It also means an export folder holding fifty files only costs whatever the
   * document actually references.
   *
   * Walks the token tree rather than running a regular expression over the
   * text, so a `![](x.png)` inside a fenced code block is correctly NOT
   * treated as a picture to go and fetch.
   */
  function imageRefs(md) {
    if (typeof marked === "undefined") return [];
    const out = [];
    try { collectImages(marked.lexer(md), out); } catch { return out; }
    return out;
  }

  function collectImages(tokens, out) {
    for (const t of tokens || []) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "image" && t.href && !SAFE_SRC.test(t.href) && out.indexOf(t.href) === -1) {
        out.push(t.href);
      }
      if (Array.isArray(t.tokens)) collectImages(t.tokens, out);
      if (Array.isArray(t.items)) collectImages(t.items, out);
      if (Array.isArray(t.header)) collectImages(t.header, out);
      if (Array.isArray(t.rows)) for (const row of t.rows) collectImages(row, out);
    }
  }

  /*
   * Inline markdown, in the tags Editor.js will actually keep.
   *
   * THIS IS WHERE BOLD WAS BEING LOST. marked emits semantic HTML — <strong>,
   * <em>, <del> — while Editor.js keeps only what its enabled inline tools
   * declare. Read straight out of the bundle: the Bold tool is
   * `sanitize(){return{b:{}}}`, Italic is `{i:{}}`, and the string "strong"
   * does not appear in it at all. So every **bold** and *italic* in a pasted
   * document was silently deleted on the way in.
   *
   * The fix is a translation, not a sanitiser fight: emit the tags the editor
   * already understands.
   *
   *   <strong> -> <b>      Bold tool
   *   <em>     -> <i>      Italic tool
   *   <code>              already allowed (InlineCode)
   *   <a>                 already allowed (Link)
   *   <mark>              already allowed (Marker)
   *
   * <del> has no tool to keep it, so strikethrough is unwrapped to plain text
   * rather than vanishing along with the words inside it.
   */
  const KEEPS = { strong: "b", em: "i" };

  function toEditorTags(html) {
    return String(html)
      .replace(/<(\/?)(strong|em)\b([^>]*)>/gi,
               (m, close, tag, rest) => `<${close}${KEEPS[tag.toLowerCase()]}${rest}>`)
      // No tool keeps these; unwrap so the words survive even if the style does not.
      .replace(/<\/?(del|s|strike|ins|sup|sub|small)\b[^>]*>/gi, "");
  }

  function inlineMd(text) {
    if (!text) return "";
    return toEditorTags(marked.parseInline(text)).trim();
  }

  // Map a single marked lexer token to an Editor.js block (or null to skip)
  function tokenToBlock(token, opts) {
    switch (token.type) {
      case "heading":
        return {
          type: "header",
          data: { text: inlineMd(token.text), level: Math.min(token.depth, 6) },
        };

      case "paragraph": {
        /*
         * A standalone image. marked never emits a top-level `image` token —
         * it wraps one in a paragraph — so the image case below was
         * unreachable, and `![alt](url)` on its own line became an EMPTY
         * paragraph. The picture was dropped entirely.
         */
        const kids = token.tokens || [];
        const onlyImage = kids.length === 1 && kids[0].type === "image";
        if (onlyImage) {
          const img = kids[0];
          return imageBlock(img.href, img.text, opts);
        }
        return { type: "paragraph", data: { text: inlineMd(token.text) } };
      }

      case "code":
        // Fenced code — keep raw (no inline parsing, no HTML)
        return { type: "code", data: { code: token.text } };

      case "hr":
        return { type: "delimiter", data: {} };

      case "blockquote":
        /*
         * A quote's children are block-level, and EVERY kind has to be kept.
         *
         * This used to filter to paragraphs and text, discarding the rest — so
         * a quote containing a list, a heading or a nested quote lost it
         * outright. Measured on a real document: 85 bold spans lived inside
         * blockquotes and only 11 survived, because most of those quotes held
         * something other than a bare paragraph.
         *
         * A quote block stores one HTML string, so children are flattened
         * rather than nested. Flattening loses their shape; dropping them lost
         * the words.
         */
        return {
          type: "quote",
          data: { text: quoteInnerHtml(token.tokens || []), caption: "", alignment: "left" },
        };

      case "list": {
        // GitHub-flavored task lists: items have { task: true, checked: bool }
        const isChecklist = token.items.length > 0 && token.items.every((it) => it.task === true);
        if (isChecklist) {
          return {
            type: "checklist",
            data: {
              items: token.items.map((it) => ({
                text: inlineMd(itemPlainText(it)),
                checked: !!it.checked,
              })),
            },
          };
        }
        return {
          type: "list",
          data: {
            style: token.ordered ? "ordered" : "unordered",
            items: flattenListItems(token.items, 0, []),
          },
        };
      }

      case "table":
        return {
          type: "table",
          data: {
            withHeadings: true,
            content: [
              token.header.map((h) => inlineMd(h.text)),
              ...token.rows.map((row) => row.map((cell) => inlineMd(cell.text))),
            ],
          },
        };

      case "image":
        // Markdown ![alt](url). A web or data source is taken as-is; a relative
        // path needs an importer's lookup (see resolveImageData). Anything else
        // is refused rather than handing an untrusted protocol to the browser.
        return imageBlock(token.href, token.text, opts);

      case "space":
      case "html":
        // Ignore whitespace tokens and raw HTML blocks (out of scope)
        return null;

      default:
        // Unknown — render raw content as a paragraph so nothing is silently lost
        if (token.raw && token.raw.trim()) {
          return { type: "paragraph", data: { text: inlineMd(token.raw) } };
        }
        return null;
    }
  }

  /*
   * Everything inside a blockquote, as one HTML string.
   *
   * Recursive, because a quote can hold a quote. Line breaks are real <br>
   * rather than newlines, which HTML would collapse into spaces.
   */
  function quoteInnerHtml(tokens) {
    const parts = [];
    for (const t of tokens || []) {
      switch (t.type) {
        case "paragraph":
        case "text":
          parts.push(inlineMd(t.text || t.raw || "").replace(/\n/g, "<br>"));
          break;
        case "heading":
          // No headings inside a quote block, so carry the emphasis instead.
          parts.push("<b>" + inlineMd(t.text || "") + "</b>");
          break;
        case "list":
          flattenListItems(t.items, 0, []).forEach((item) => parts.push("• " + item));
          break;
        case "code":
          parts.push("<code>" + escapeHtml(t.text || "") + "</code>");
          break;
        case "blockquote":
          parts.push(quoteInnerHtml(t.tokens || []));
          break;
        case "space":
          break;
        default:
          if (t.raw && t.raw.trim()) parts.push(inlineMd(t.raw));
      }
    }
    return parts.filter(Boolean).join("<br>");
  }

  /*
   * A list item's OWN words, without its sub-list.
   *
   * `item.text` contains the nested markdown too, so using it put a literal
   * "- inner" inside the parent item — the sub-bullet appeared as characters
   * rather than as a bullet. marked keeps the item's own words in a leading
   * `text` token and hands the sub-list over as a separate `list` token, so
   * take the former and leave the latter to flattenListItems.
   */
  function itemPlainText(item) {
    const toks = Array.isArray(item.tokens) ? item.tokens : [];
    const own = toks.filter((t) => t.type === "text")
                    .map((t) => t.text || "").join(" ").trim();
    if (own) return own;
    // No token tree (older marked output): take the first line only.
    return String(item.text || item.raw || "").split("\n")[0];
  }

  /*
   * Flatten a list, sub-lists included.
   *
   * The bundled List tool is the flat one — 6KB, and the strings "nested" and
   * "items" appear nowhere in it — so a hierarchy genuinely cannot be stored.
   * Flattening loses the shape, which is a real loss, but silently dropping
   * sub-items or leaving raw "- " in the text are both worse. Depth is marked
   * with a middle dot so a sub-bullet still reads as one.
   */
  function flattenListItems(items, depth, out) {
    for (const it of items || []) {
      const own = itemPlainText(it);
      if (own.trim()) {
        out.push((depth > 0 ? "· ".repeat(depth) : "") + inlineMd(own));
      }
      for (const t of (it.tokens || [])) {
        if (t.type === "list") flattenListItems(t.items, depth + 1, out);
      }
    }
    return out;
  }
  // ==========================================================================
  // WHAT THE REST OF THE APP CAN CALL
  // ==========================================================================
  return {
    toBlocks: markdownToBlocks,
    imageRefs,
  };
})();

/* Node can require this file too, so the markdown tests need no browser. */
if (typeof module !== "undefined" && module.exports) module.exports = FolioMarkdown;

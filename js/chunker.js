/*
 * =============================================================================
 * CHUNKER.JS — Cutting a rendered document into the units a voice is billed in
 * =============================================================================
 * FILE OVERVIEW:
 * A speech engine is not given a whole document. It is given pieces, one
 * request at a time, and each request costs money and about a second of
 * waiting. Where those pieces begin and end is therefore the single most
 * important decision in the whole read-aloud feature, and this file makes it.
 *
 * HOW IT WORKS - The Components:
 * 1. indexDom(root)       - walks the rendered article into three parallel
 *                           views: the plain text, where each piece of text
 *                           came from in the DOM, and which paragraph owns it
 * 2. findSentences()      - cuts that text into sentences
 * 3. groupChunks()        - groups sentences into the pieces actually sent to
 *                           the voice, choosing boundaries the TEXT decides
 * 4. plan(root)           - all three in one call, which is what a caller wants
 * 5. textNodes(root)      - the article's text nodes in order, which is the
 *                           coordinate system highlights are stored against
 *
 * THE FLOW:
 * First we walk the article and build one long string of its text, remembering
 * which DOM node every character came from. Then we cut that string into
 * sentences. Then we glue sentences together until a piece is big enough AND
 * the sentence itself says "this is a boundary" — a rule explained at length
 * below, because the obvious alternative is expensive.
 *
 * WHY THIS IS A FILE OF ITS OWN:
 * js/tts.js has had this logic since the read-aloud feature was built. The
 * drive player (js/drive.js) needs the SAME pieces, because a piece of audio
 * is cached under a key derived from its exact text — so a drive that cut the
 * document even slightly differently would re-buy audio the reader had already
 * paid for. Rather than refactor 2,000 lines of player while a trip was
 * waiting, the algorithm is reproduced here and the two are pinned together by
 * test/chunker-parity.selftest.js, which fails the moment they disagree about
 * a single character. If you change a rule here, change it in js/tts.js too;
 * the test will tell you if you forget.
 * =============================================================================
 */

const Chunker = (function () {

  // ==========================================================================
  // WHAT COUNTS AS A BLOCK, AND WHAT IS SKIPPED ENTIRELY
  // ==========================================================================

  /*
   * Elements that are a unit of text in their own right.
   *
   * LI is the one that matters. If blocks were the top-level children of the
   * article, an entire <ul> would be a single block — so a note dictated while
   * a list was being read would attach to the WHOLE list instead of the bullet
   * being spoken. TD, DT and DD have the same shape of problem for tables and
   * definition lists.
   */
  const BLOCK_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "BLOCKQUOTE", "TD", "TH", "DT", "DD", "FIGCAPTION",
  ]);

  // Never read aloud: code listings, images and their captions, rules.
  const SKIP_TAGS = new Set(["PRE", "FIGURE", "HR"]);

  // ==========================================================================
  // CHUNK SIZE
  // ==========================================================================

  const CHUNK_MIN_CHARS = 600;
  const CHUNK_MAX_CHARS = 1800;
  const BOUNDARY_EVERY = 4;      // 1-in-N sentences is a candidate boundary

  // ==========================================================================
  // THE DOM WALK
  // ==========================================================================

  /*
   * Which block a piece of text belongs to: the nearest enclosing block
   * element, falling back to the top-level child of the article.
   *
   * Nearest-enclosing rather than descend-from-the-top is what makes nesting
   * work. A bullet inside a bullet resolves to the inner LI, and the outer
   * item's own words still resolve to the outer one, without either having to
   * know the other exists.
   */
  function nearestBlock(node, root) {
    let el = node.parentElement;
    let topLevel = null;
    while (el && el !== root) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      topLevel = el;
      el = el.parentElement;
    }
    return topLevel || node.parentElement;
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Walks the rendered article once and produces three parallel views of it.
   *
   * WHY WE NEED IT:
   *   docText  - the plain text, which is what we hand to the speech engine
   *   segments - lets us turn any offset in docText back into a DOM position,
   *              which is how a spoken word gets highlighted
   *   blocks   - lets us find the paragraph element containing an offset, which
   *              is how a dictated note knows which paragraph it belongs to
   *
   * HOW IT WORKS:
   * 1. Walk every text node, rejecting anything inside a skipped container
   * 2. Whenever the owning block changes, close the old block and start a new
   *    one, separated in docText by a blank line so the voice pauses there
   * 3. Record, for each text node, the range of docText it produced
   */
  function indexDom(root) {
    let docText = "";
    const segments = [];
    const blocks = [];
    if (!root) return { docText, segments, blocks };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        // Anything inside a skipped container is skipped with it.
        let el = n.parentElement;
        while (el && el !== root) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let open = null;           // the block being accumulated: { el, ds }
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue;
      if (!t) continue;

      const owner = nearestBlock(node, root);
      if (!open || owner !== open.el) {
        if (open && docText.length > open.ds) {
          blocks.push({ ds: open.ds, de: docText.length, el: open.el });
          docText += "\n\n";
        }
        open = { el: owner, ds: docText.length };
      }

      segments.push({ ds: docText.length, de: docText.length + t.length, node: node, ns: 0 });
      docText += t;
    }
    if (open && docText.length > open.ds) {
      blocks.push({ ds: open.ds, de: docText.length, el: open.el });
    }

    return { docText, segments, blocks };
  }

  /*
   * The article's text nodes in document order.
   *
   * This is the coordinate system a saved highlight is stored against — "the
   * 47th text node, 12 characters in" — so anything that wants to WRITE a
   * highlight has to be able to count nodes the same way js/highlights.js
   * does. Deliberately has no acceptNode filter, because that file has none
   * either: skipped-for-speech text still counts as a node.
   */
  function textNodes(root) {
    const nodes = [];
    if (!root) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  // ==========================================================================
  // SENTENCES
  // ==========================================================================

  /*
   * Cut each block into sentences, as absolute offsets into docText.
   *
   * Intl.Segmenter knows that "Dr. Chen" is not two sentences and that "$5 on
   * 2026." is one. The regex fallback does not, but it is only reached on
   * engines old enough that nothing else here would work either.
   */
  function findSentences(docText, blocks) {
    const sentences = [];

    const canSegment = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
    const seg = canSegment ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;

    for (const b of blocks) {
      const text = docText.slice(b.ds, b.de);
      if (!text.trim()) continue;

      const sents = [];
      if (seg) {
        for (const s of seg.segment(text)) {
          if (!s.segment.trim()) continue;
          sents.push({ ds: b.ds + s.index, de: b.ds + s.index + s.segment.length });
        }
      } else {
        // Fallback for engines without Intl.Segmenter: split on . ! ?
        const re = /[^.!?]+[.!?]*\s*/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (!m[0].trim()) continue;
          sents.push({ ds: b.ds + m.index, de: b.ds + m.index + m[0].length });
        }
      }
      if (!sents.length) sents.push({ ds: b.ds, de: b.de });

      sentences.push.apply(sentences, sents);
    }

    return sentences;
  }

  // ==========================================================================
  // GROUPING SENTENCES INTO SYNTHESIS UNITS
  // ==========================================================================

  /*
   * FNV-1a. Chosen because it is short, has no dependencies and spreads well on
   * text; nothing here needs cryptographic quality, only that the same sentence
   * always lands on the same side of the boundary test.
   */
  function sentenceHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  /*
   * WHAT THIS FUNCTION DOES:
   * Glues sentences together into the pieces that are actually sent to the
   * voice, and says where each one starts and ends.
   *
   * WHY IT IS NOT JUST "ACCUMULATE UNTIL FULL":
   * Two things were wrong with the obvious approaches, and they pull in
   * opposite directions, so both are handled here.
   *
   * 1. A CHUNK USED TO END AT EVERY PARAGRAPH. The median paragraph in a real
   *    document is about 90 characters, so the size cap almost never came into
   *    it: an 18,000-word document produced 545 chunks with a median size of
   *    105. For a network voice that is 545 separate requests, each paying a
   *    flat ~0.8s floor, and only one may be in flight at a time. Letting a
   *    chunk span consecutive paragraphs brings that to 144 — the SAME number
   *    of characters billed, a quarter of the round trips. The paragraph break
   *    travels inside the text, so the voice still pauses there.
   *
   * 2. WHERE A CHUNK ENDED DEPENDED ON EVERYTHING BEFORE IT. Accumulating
   *    until a character cap means inserting one word can push a sentence over
   *    the edge and shift every boundary after it — and a shifted boundary is
   *    new text, so it is bought again. Editing one word could re-bill 8
   *    chunks.
   *
   *    So a boundary is decided by the SENTENCE ITSELF: a cheap hash of its
   *    text, independent of position. Edit a sentence and the chunks around it
   *    change; everything further on keeps its identity and stays cached.
   *    Measured over 40 random edits, worst case falls from 8 chunks to 2.
   */
  function groupChunks(docText, sentences) {
    let chunks = [];
    let cs = null, ce = null;

    for (const s of sentences) {
      // Would this sentence overflow the backstop? Close what we have first.
      if (cs !== null && (s.de - cs) > CHUNK_MAX_CHARS) {
        chunks.push({ ds: cs, de: ce });
        cs = null;
      }

      if (cs === null) { cs = s.ds; ce = s.de; }
      else { ce = s.de; }

      /*
       * A boundary the text itself decides. Position plays no part, so an edit
       * upstream cannot move it.
       */
      const bigEnough = (ce - cs) >= CHUNK_MIN_CHARS;
      const isBoundary = (sentenceHash(docText.slice(s.ds, s.de).trim()) % BOUNDARY_EVERY) === 0;
      if (bigEnough && isBoundary) {
        chunks.push({ ds: cs, de: ce });
        cs = null;
      }
    }

    if (cs !== null) chunks.push({ ds: cs, de: ce });

    return chunks.map((c) => ({ ds: c.ds, de: c.de, text: docText.slice(c.ds, c.de) }));
  }

  // ==========================================================================
  // THE WHOLE JOB, IN ONE CALL
  // ==========================================================================

  /*
   * Index a rendered article and cut it up, in the order the steps depend on
   * each other. This is what a caller actually wants.
   */
  function plan(root) {
    const ix = indexDom(root);
    const sentences = findSentences(ix.docText, ix.blocks);
    const chunks = groupChunks(ix.docText, sentences);
    return {
      docText: ix.docText,
      segments: ix.segments,
      blocks: ix.blocks,
      sentences: sentences,
      chunks: chunks,
    };
  }

  /*
   * Which block contains a character offset. Used to work out which paragraph
   * a note belongs to, given where in the audio it was spoken.
   */
  function blockAt(blocks, pos) {
    for (let i = 0; i < blocks.length; i++) {
      if (pos < blocks[i].de) return blocks[i];
    }
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  return {
    plan,
    indexDom,
    findSentences,
    groupChunks,
    blockAt,
    textNodes,
    nearestBlock,
    // Exposed so the parity test can check the constants match js/tts.js too.
    sentenceHash,
    BLOCK_TAGS,
    SKIP_TAGS,
    CHUNK_MIN_CHARS,
    CHUNK_MAX_CHARS,
    BOUNDARY_EVERY,
  };
})();

// Let the Node test suites require this file directly.
if (typeof module !== "undefined" && module.exports) module.exports = Chunker;

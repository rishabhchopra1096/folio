# Folio integration constraints for Read-Aloud

_My own analysis of the existing Folio codebase — what a TTS feature must not break, and the DOM surface it has to work with._

## TL;DR

- **Do NOT wrap words in `<span>`s.** Folio's highlight persistence is keyed on **text-node indices**; per-word spans would explode the node count and silently invalidate every saved highlight in every document.
- **Use the CSS Custom Highlight API instead** (`CSS.highlights` + `::highlight()`). It paints ranges with zero DOM mutation. Production-ready across Chrome/Edge 105+, Safari 17.2+, Firefox 140+ (baseline since June 2025).
- Two highlight registries give the exact two-tier effect requested: `tts-sentence` (soft) and `tts-word` (strong).
- The "pause → comment on this paragraph" flow can reuse the existing one-shot annotate path (`Highlights.createHighlightAndComment`) almost verbatim.

---

## Constraint 1 — Highlight persistence is text-node-index based (the collision)

`js/highlights.js:56` serializes a highlight as indices into the flat list of text nodes under `#article`:

```js
function serializeRange(range) {
  const textNodes = getTextNodes(article);
  const startIdx = textNodes.indexOf(range.startContainer);
  const endIdx   = textNodes.indexOf(range.endContainer);
  if (startIdx === -1 || endIdx === -1) return null;
  return { startNodeIndex: startIdx, startOffset: range.startOffset,
           endNodeIndex: endIdx,   endOffset: range.endOffset };
}
```

and `deserializeRange` (`js/highlights.js:72`) reads those indices back against a freshly-walked node list.

**Why per-word spans break this.** `getTextNodes()` walks with `NodeFilter.SHOW_TEXT`. Wrapping every word in `<span class="tts-word">` splits one paragraph text node into N word text nodes. A document with ~50 text nodes becomes ~10,000. Every stored `startNodeIndex` then addresses a completely different node.

The failure is **silent**, which is worse than loud: `applyHighlights` (`js/highlights.js:213`) guards with

```js
const currentText = range.toString();
if (currentText !== hl.text) return;   // silently skips
```

so highlights would just quietly stop appearing rather than erroring. The user would lose annotations with no signal.

**Verdict:** any approach that mutates `#article`'s text-node structure is disqualified.

## Constraint 2 — Reader re-renders wholesale on navigation

`js/reader.js:152` does `article.innerHTML = blocksToHtml(blocks)` then re-applies highlights at `:173`. Any TTS state (word ranges, playhead mapping) is invalidated on every doc switch and must be rebuilt or torn down. TTS must hook `Reader.hide()` / `renderDocument()` for lifecycle.

## Constraint 3 — Content is Editor.js JSON, not markdown

Per `CLAUDE.md`, the canonical format is Editor.js blocks. `blocksToHtml` (`js/reader.js:44`) maps block types → HTML. For TTS we need **text extraction with a stable mapping back into the rendered DOM**. Two options:

- Walk the rendered DOM's text nodes and build `{textNode, startOffset, endOffset}` per word — keeps a direct handle for `Range` construction. **Preferred.**
- Extract from blocks and re-locate in DOM later — fragile, requires re-matching.

Note `blocksToHtml` emits raw `data.text` (which contains inline HTML like `<b>`, `<i>`, `<code>` from the markdown importer), so a paragraph is frequently **several** text nodes already. Word tokenization must therefore span text-node boundaries.

## Constraint 4 — Existing highlight colors must remain visually distinct from TTS highlights

Existing highlights render as `<mark class="hl-yellow|green|blue|pink">` (`css/highlights.css:1-38`). TTS sentence/word highlights need to be visually separable from those — and must compose sanely when the TTS playhead crosses an existing highlight. The Custom Highlight API paints *over* the element background, and `::highlight()` pseudo-elements support only a limited property set (color, background-color, text-decoration, text-shadow — **not** padding/border/transform), which is fine here.

## Constraint 5 — Reader-mode only

Highlighting/commenting is gated to reader mode (`js/highlights.js:327` checks `#view-reader.active`). TTS should follow the same rule — no read-aloud in the Editor.js editing view.

---

## The DOM surface available

- `#article` — the rendered reading column. Block-level children are `<h1..h6>`, `<p>`, `<ul>/<ol>`, `<table>`, `<blockquote>`, `<pre>`, `<figure class="folio-image">`, `<hr>`.
- Paragraph-level granularity for the "pause → comment" flow maps naturally to these block children.
- `<pre>` (code) and `<figure>` (images) should be **skipped** by the reader — reading code aloud is noise.

## Recommended approach (pending research agents' input)

1. **Tokenize** `#article` into a word list at load: `[{ word, textNode, start, end, blockEl, sentenceIdx }]`. No DOM mutation.
2. **Paint** with two `Highlight` registries:
   ```js
   const wordHL = new Highlight();      CSS.highlights.set("tts-word", wordHL);
   const sentHL = new Highlight();      CSS.highlights.set("tts-sentence", sentHL);
   ```
   ```css
   ::highlight(tts-sentence) { background: rgba(184,115,51,0.16); }
   ::highlight(tts-word)     { background: rgba(184,115,51,0.42); color: var(--ink); }
   ```
   Update by `.clear()` + `.add(range)` per frame.
3. **Drive** the playhead from `audio.currentTime` in a `requestAnimationFrame` loop — never a wall clock (see the superwhisper post-mortem for why).
4. **Pause** → take the block element containing the current word, build a `Range` over it, hand it to the existing annotate path.

## Reuse targets in existing code

| Need | Existing code to reuse |
|---|---|
| Create highlight + open comment box | `Highlights.createHighlightAndComment()` — `js/highlights.js` |
| Range → stored highlight | `serializeRange` / `wrapRange` — `js/highlights.js:56,108` |
| Comment panel + mic | `Comments.openPanelForHighlight()` — `js/comments.js` |
| Settings persistence | `FolioStore.getSettings/saveSettings` — `js/store.js:300` |
| API key in localStorage pattern | `js/voice.js` (`folio_groq_key`) — mirror as `folio_speechify_key` |
| Floating draggable panel | `#comments-panel` drag/resize/dock — `js/comments.js` |

---

## EMPIRICAL FINDINGS (tested live, 2026-08-16)

### ✅ Speechify CORS is open — browser can call it directly

Preflight from Folio's production origin succeeds on every endpoint we need:

```
$ curl -i -X OPTIONS https://api.sws.speechify.com/v1/audio/speech \
    -H "Origin: https://folio-six-sigma.vercel.app" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,content-type"

HTTP/2 200
access-control-allow-origin: https://folio-six-sigma.vercel.app
access-control-allow-methods: POST
access-control-allow-headers: Authorization, Content-Type
access-control-max-age: 300
vary: Origin
```

| Endpoint | OPTIONS status | allow-origin |
|---|---|---|
| `/v1/audio/speech` | 200 | echoes our origin |
| `/v1/audio/stream` | 200 | echoes our origin |
| `/v1/audio/stream/with-timestamps` | 200 | echoes our origin |
| `/v1/voices` | 200 | echoes our origin |

Both hosts behave identically: `api.speechify.ai` and `api.sws.speechify.com`.

**Consequence:** no proxy, no serverless function, no Electron IPC. Architecture is
identical to the existing Groq voice-input feature — user's key in `localStorage`,
direct `fetch()` from the renderer. This closes the "browser/Electron feasibility and
CORS" gap that the prior rabbitwhole research explicitly left open.

### ⚠️ Offset index-space is a THREE-way ambiguity, and it will bite

Measured against the user's real document `sample_docs/md.md`:

| Index space | Length |
|---|---|
| UTF-8 bytes | 137,564 |
| JS UTF-16 code units (what `String.prototype.slice` uses) | 135,874 |
| Unicode code points | 135,734 |

Non-ASCII inventory: 201 `—` (U+2014), 178 `→` (U+2192), 119 `🎨` (U+1F3A8,
**surrogate pair**), 108 `─`, 55 `│`, 54 U+FE0F variation selectors, 52 `⚙`,
plus `🔥` and 🇧🇷 flag pairs.

Byte-vs-char divergence is **1,830** over the document; surrogate pairs add another
140 units of JS-vs-codepoint divergence. If the API returns byte offsets and we
`slice()` with them, word highlighting drifts progressively and is ~1,830 chars wrong
by the end. The prior research flagged a bytes-vs-chars contradiction
(`reference-listeninterrupt-architecture.md:164` says characters, `:392` says UTF-8
bytes) and never resolved it.

**Mitigation — don't depend on the offsets at all.** Every speech mark carries
`value: string` (the word text). Align the API's word list against our own tokenized
word list **by sequence + text match**, using offsets only as a tiebreaker for
repeated words. This is immune to all three index spaces. Add a one-time startup
probe that slices the first chunk three ways and logs which reproduces `value`, so we
know the truth for logging/debugging, but never make correctness depend on it.

## Sources

- [MDN — CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
- [MDN — Highlight](https://developer.mozilla.org/en-US/docs/Web/API/Highlight)
- [Frontend Masters — Using the Custom Highlight API](https://frontendmasters.com/blog/using-the-custom-highlight-api/)

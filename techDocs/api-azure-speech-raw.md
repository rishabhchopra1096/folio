# Runner-up providers — raw reference notes (captured 2026-08-16)

Companion to [`api-speechify-raw.md`](./api-speechify-raw.md) and
[`tts-web-research-2026.md`](./tts-web-research-2026.md).

Two providers are documented here:

1. **Azure AI Speech** — the strongest fallback. Different mechanism (SDK + WebSocket +
   boundary events), 10× more generous free tier, larger chunks.
2. **ElevenLabs** — the *easiest* fallback. Same shape as Speechify (one POST, JSON back),
   so it's a ~30-line adapter, but 5–16× the cost.

---
---

# PART 1 — Azure AI Speech (JavaScript SDK)

## 1.1 Loading it in a no-build-step site

VERIFIED — Microsoft's
[setup-platform quickstart](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/quickstarts/setup-platform)
has a dedicated **Browser-based** tab (separate from Node.js, explicitly because "the DOM
isn't available for server-side applications; the Node.js file system isn't available to
client-side applications"). It ships a prebuilt UMD bundle:

```html
<script src="https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@latest/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js"></script>
```

With the `<script>` tag path, the docs note **"the `sdk` prefix is not needed"** — globals are
exposed directly.

> For Folio this would mean vendoring ~1 MB into `vendor/` alongside the Editor.js plugins,
> and adding a `<script>` tag to **both** `index.html` and `index-electron.html` (per the
> repo's CLAUDE.md DOM-contract rule). Speechify needs none of this — it's a plain `fetch`.

**NOT VERIFIED:** the exact current SDK version. Signals converge on the 1.46–1.51.x range;
npmjs.com and socket.dev both 403'd. Pin a specific version rather than `@latest` in
production.

## 1.2 Auth

```js
const speechConfig = sdk.SpeechConfig.fromSubscription(SUBSCRIPTION_KEY, REGION);
```

VERIFIED: this is the first line of the browser quickstart — **direct client-side key auth is
supported**. Microsoft separately recommends a backend-minted 10-minute token via
`SpeechConfig.fromAuthorizationToken()`, but that guidance addresses multi-tenant SaaS
shipping *one operator's* key to *all* users. It does not apply to a BYOK app where the key is
the user's own, in their own browser.

## 1.3 CORS — the question doesn't arise

The SDK communicates over **WebSocket** (`wss://<region>.tts.speech.microsoft.com/...`), not
XHR/fetch. **INFERRED** (from platform behaviour, not an explicit Microsoft statement):
WebSocket handshakes are not gated by the CORS preflight mechanism that governs
XHR/fetch. Corroborating evidence: every connectivity problem found in Microsoft Q&A threads
was firewall/region/close-code-1006 related, never a CORS error.

## 1.4 THE KEY PATTERN — raw audio bytes, no auto-playback

This is the single most important thing in this document, because it's what makes the
`playbackRate` architecture (research doc §C) work with Azure.

`AudioConfig` factory methods:

| Method | Behaviour |
|---|---|
| `fromDefaultSpeakerOutput()` | SDK plays the audio itself. **Avoid** — you lose control of the element. |
| `fromAudioFileOutput(path)` | Writes to a filesystem path. **INFERRED Node-only** — browsers can't write arbitrary paths. Also has a filed bug where `wordBoundary` doesn't fire ([cognitive-services-speech-sdk#1104](https://github.com/Azure-Samples/cognitive-services-speech-sdk/issues/1104)). |
| **Omit it entirely / pass `null`** | **Nothing plays. You get `result.audioData` as an `ArrayBuffer`, and `wordBoundary` events still fire.** ← this one |

```js
// VERIFIED against Microsoft's own how-to sample.
const synth = new sdk.SpeechSynthesizer(speechConfig);   // NO AudioConfig argument

synth.speakTextAsync(
  text,
  result => {
    const buf = result.audioData;                        // ArrayBuffer
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    audioEl.src = url;                                   // YOUR element -> YOUR playbackRate
    synth.close();
  },
  err => { console.error(err); synth.close(); }
);
```

Cross-confirmed by a second independent source (a Microsoft Q&A sample using
`audio_config=None` specifically to suppress output while keeping word-boundary callbacks).

### Escape hatch: `SpeakerAudioDestination.internalAudio`

If you *do* use `SpeakerAudioDestination`, it publicly exposes
`internalAudio: HTMLAudioElement`. VERIFIED by reading the
[SDK source](https://github.com/microsoft/cognitive-services-speech-sdk-js/blob/master/src/sdk/Audio/SpeakerAudioDestination.ts):
it's created via `new Audio()`, `.play()` is called on it directly in `notifyPlayback()`, and
the getter returns the live reference — so `dest.internalAudio.playbackRate = 1.5` would work.
Nothing in the SDK reads or writes `playbackRate` itself.

**But treat this as an unofficial trick, not a contract.** The class docs also note it's
MSE-backed ("the SDK will try to use Media Source Extensions to play audio… mp3 format has
better support"). Prefer §1.4's no-AudioConfig path.

## 1.5 WordBoundary event — exact shape

```js
synthesizer.wordBoundary = (sender, e) => { /* e is SpeechSynthesisWordBoundaryEventArgs */ };
```

[Reference](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesiswordboundaryeventargs?view=azure-node-latest):

| Field | Type | Meaning |
|---|---|---|
| `audioOffset` | number | Offset into the audio. **Ticks = 100-nanosecond units.** |
| `duration` | number | Docs verbatim: *"Specifies the duration, in ticks (100 nanoseconds)."* |
| `text` | string | The word |
| `textOffset` | number | **Character offset into the input text** |
| `wordLength` | number | Length in characters |
| `boundaryType` | enum | `Word` \| `Punctuation` \| `Sentence` |

**Unit conversion** (from Microsoft's own sample):

```js
const ms = (e.audioOffset + 5000) / 10000;   // +5000 rounds to nearest ms; /10000 = ticks->ms
```

> Contrast with Speechify, which gives milliseconds directly. Same information, one more
> conversion step, and an easy place to introduce an off-by-1000× bug.

### Boundary types and their defaults

[`SpeechSynthesisBoundaryType`](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesisboundarytype?view=azure-node-latest)
= `Word | Punctuation | Sentence`.

| Boundary | Default | How to enable |
|---|---|---|
| Word | **on** | — |
| Punctuation | **on** (`SpeechServiceResponse_RequestPunctuationBoundary` defaults `true`) | — |
| Sentence | **OFF** | `speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestSentenceBoundary, "true")` |

Microsoft's own sample comments the sentence line *"Required for WordBoundary event
sentences."* **This is a genuine advantage over Speechify**, whose speech marks have only an
utterance tier and a word tier — with Azure you get a real sentence tier for free instead of
deriving it with `Intl.Segmenter`.

**Known issue (single-sourced, Microsoft Q&A):** `audioOffset` reportedly returns 0 for
certain neural voices/locales (pt-PT cited). Smoke-test your chosen voice.

## 1.6 Limits — better than Speechify's

VERIFIED from
[Quotas and Limits](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits):

| Limit | Value |
|---|---|
| Max SSML/text per request | **64 KB** (text content, not markup) |
| Max audio output per request | **10 minutes** |
| Longer than 10 min | Use the separate async **Batch Synthesis API**, not the realtime SDK |

**The 10-minute audio cap binds first**, not the 64 KB text cap. At ~150 wpm that's
**~1,500 words per request** → a 10,000-word document is **6–10 chunks**, versus Speechify's
~30–50 (2,000-char cap) and Web Speech API's 35–50.

`audioOffset` is per-request, so maintain a cumulative offset across chunks if you want one
continuous timeline. (Per research-doc §D.2 you probably don't — per-chunk timebases are
simpler.)

**Known gap:** the JS SDK does **not** support the newer `SpeechSynthesisRequest`
text-streaming input mode that other language SDKs have —
[cognitive-services-speech-sdk-js#850](https://github.com/microsoft/cognitive-services-speech-sdk-js/issues/850).
Don't design around it.

## 1.7 Pricing

VERIFIED from the official pricing page's own text: **Free (F0) tier = 0.5 million characters
per month.** Tier names present on the page: "Neural / Neural HD Flash", "Neural HD", "Custom
Professional Voice", "Personal Voice".

**NOT VERIFIED — dollar figures.** Azure's pricing page renders amounts via client-side JS
that couldn't be executed. These come from three converging third-party aggregators and
should be confirmed at the Azure pricing calculator for your region:

| Tier | Approx. cost |
|---|---|
| Standard Neural | ~$16 / 1M chars |
| Neural HD | ~$22 / 1M chars (one source claims a drop from $30 in March 2026 — single-sourced) |
| Commitment tiers | reportedly ~$7.50 / 1M at volume |

**The free tier is the headline: 500k chars/month is ~9 full 10k-word documents, versus
Speechify's 50k (~0.9 documents).**

---
---

# PART 2 — ElevenLabs (the drop-in fallback)

## 2.1 Endpoint

```
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps
xi-api-key: <key>
Content-Type: application/json
```

[Docs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)

Query params (optional): `enable_logging` (default `true`), `optimize_streaming_latency`
(0–4), `output_format` (default `mp3_44100_128`).

Body: `text` (required), `model_id` (default `eleven_multilingual_v2`), `voice_settings`
(object incl. `stability`, `similarity_boost`, `speed`), `language_code`, `seed`,
`previous_text`, `next_text`.

> `previous_text` / `next_text` are genuinely useful for chunked reading — they give the model
> prosodic context across chunk boundaries so sentence intonation doesn't reset at every seam.
> Speechify has no equivalent documented.

## 2.2 Response — character-level, not word-level

```json
{
  "audio_base64": "base64_encoded_audio_string",
  "alignment": {
    "characters": ["H", "e", "l", "l", "o"],
    "character_start_times_seconds": [0, 0.1, 0.2, 0.3, 0.4],
    "character_end_times_seconds":   [0.1, 0.2, 0.3, 0.4, 0.5]
  },
  "normalized_alignment": {
    "characters": ["H", "e", "l", "l", "o"],
    "character_start_times_seconds": [0, 0.1, 0.2, 0.3, 0.4],
    "character_end_times_seconds":   [0.1, 0.2, 0.3, 0.4, 0.5]
  }
}
```

**Units: SECONDS** (Speechify uses milliseconds — don't mix them up).
**Granularity: per character.** Three parallel arrays, index-aligned.

Two alignment objects: `alignment` maps to the text as you sent it;
`normalized_alignment` maps to the text after ElevenLabs' internal normalization (numbers
expanded to words, etc.). **For highlighting your source text, use `alignment`** — its indices
correspond 1:1 to your input string, which is what you need to map back to the DOM.

## 2.3 Folding characters into words

Character-level is *more* information than Speechify gives, and the char index is implicit in
the array position — so the offsets are exact by construction. Collapse on whitespace:

```js
function elevenLabsToWords(alignment, base) {
  const { characters: ch,
          character_start_times_seconds: st,
          character_end_times_seconds: en } = alignment;
  const words = [];
  let from = null;
  for (let i = 0; i <= ch.length; i++) {
    const isBreak = i === ch.length || /\s/.test(ch[i]);
    if (!isBreak && from === null) from = i;
    if (isBreak && from !== null) {
      words.push({
        startMs: st[from] * 1000,          // seconds -> ms, to match the internal shape
        endMs:   en[i - 1] * 1000,
        from:    base + from,              // global char offset
        to:      base + i,
      });
      from = null;
    }
  }
  return words;
}
```

That output plugs straight into the research doc's §C.7 loop with no other changes — which is
the point of normalizing every provider into one `{startMs, endMs, from, to}` shape.

## 2.4 CORS — the most permissive of any provider tested

Measured 2026-08-16:

```
access-control-allow-origin: *
access-control-allow-headers: *
access-control-allow-methods: POST, PATCH, OPTIONS, DELETE, GET, PUT
access-control-max-age: 600
```

Wide-open wildcard. Direct browser calls work.

## 2.5 Pricing — the reason it's a fallback and not the pick

VERIFIED from [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api):

| | Per 1,000 chars | Per 1M chars |
|---|---|---|
| Flash / Turbo | $0.05 | **$50** |
| Multilingual v2 / v3 | $0.10 | **$100** |

Plans: Starter $6/mo, Creator $22/mo, Pro $99/mo (440k Multilingual / 1.98M Flash chars),
Scale $299/mo, Business $990/mo. Flash/Turbo consume 0.5 credits per character;
Multilingual consumes 1.

**A 10k-word (≈55k char) document: $2.75 on Flash, $5.50 on Multilingual — versus $0.55 on
Speechify Starter.**

---

## Cross-provider quick reference

| | Speechify | Azure | ElevenLabs |
|---|---|---|---|
| Transport | plain `fetch` POST | SDK over WebSocket | plain `fetch` POST |
| Extra dependency | none | ~1 MB SDK | none |
| Timing granularity | **word** (+ utterance) | **word + punctuation + sentence** | **character** |
| Timing units | **milliseconds** | **ticks (100 ns)** | **seconds** |
| Char offsets into input | yes (`start`/`end`) | yes (`textOffset`/`wordLength`) | implicit (array index) |
| Max per request | 2,000 chars (batch) / 20,000 (stream) | 64 KB text **or 10 min audio** | not documented here |
| Chunks for a 10k-word doc | ~30–50 | **~6–10** | depends |
| Free tier / month | 50k chars | **500k chars** | limited |
| Cost / 1M chars | **$6–10** | ~$16–22 | $50–100 |
| Browser CORS | ✅ measured | N/A (WebSocket) | ✅ measured `*` |

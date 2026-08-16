# Browser TTS with word-synced highlighting — Research (Aug 2026)

> Scope: building a Speechify-style read-aloud into Folio — a vanilla-JS static site, no
> build step, no backend, deployed on Vercel, with the user's own API key in localStorage.
> Every claim below is marked **VERIFIED** (I read it in a primary source or measured it
> myself) or **INFERRED** (my reasoning, needs empirical confirmation).

### Related documents in this folder

This is the **web/browser-platform** research. It sits alongside work done in parallel:

| Doc | What it covers |
|---|---|
| [`api-speechify-raw.md`](./api-speechify-raw.md) | Raw Speechify API capture — schemas, verbatim JSON, gotchas, measured CORS headers |
| [`api-azure-speech-raw.md`](./api-azure-speech-raw.md) | Raw capture for the two fallbacks: Azure AI Speech and ElevenLabs |
| [`superwhisper-tts-postmortem.md`](./superwhisper-tts-postmortem.md) | Code-level post-mortem of the **previous attempt** — why speed and sync broke, with `file:line` |
| [`folio-integration-constraints.md`](./folio-integration-constraints.md) | What a TTS feature must not break in Folio's existing DOM/highlight code |
| [`speechify-simba-findings.md`](./speechify-simba-findings.md) | Prior in-house Speechify research, incl. **measured** latency numbers |

**Where this doc changes the prior conclusions:**
1. **CORS was an open question in the prior research**, which assumed Folio would need to
   proxy Speechify through Electron IPC the way it proxies Notion.
   **I measured it: no proxy is needed** (§A.5). That unblocks the web build entirely.
2. **Variable playback speed was explicitly unaddressed** in all prior research. §C is the
   answer, and it is simpler than expected.
3. The post-mortem's findings **confirm** the root-cause analysis in §C.1, which I had
   originally written as an inference.

---

## TL;DR — the recommended stack and why

- **Use Speechify.** Not out of loyalty to the key you already have — it independently wins.
  It is the only candidate that gives **true word-level timestamps *with* character offsets
  back into your input text**, and it is **5–16× cheaper than ElevenLabs**
  ($6–10 per 1M chars vs $50–100). VERIFIED.
- **CORS is not a problem. This was the big open risk and it is dead.** I sent a real
  preflight to `api.speechify.ai` from an arbitrary origin and it returned
  `access-control-allow-origin: <my origin>` plus `access-control-allow-headers:
  Authorization, Content-Type`. **A static site can call Speechify directly with a Bearer
  token. No proxy, no Vercel function.** VERIFIED empirically — see §A.5.
- **The variable-speed sync problem has a one-line answer, and it is a non-problem if you
  build it right.** `audio.currentTime` is defined by spec to be a position on the *media
  timeline*, and `playbackRate` is defined as "units of media time per unit time of the
  media timeline's clock". So **`currentTime` never leaves the media's own timebase at any
  playback rate.** Drive the highlight off `audio.currentTime` and speed changes are
  *automatically* correct — zero rescaling, zero re-sync, zero re-synthesis. VERIFIED
  against the WHATWG spec — see §C.1.
- **Pitch is already handled for you.** `preservesPitch` defaults to `true` and is Baseline
  since Dec 2023. No chipmunk effect unless you explicitly opt into one. VERIFIED.
- **Never use Web Audio `AudioBufferSourceNode.playbackRate`** — it resamples, so it *does*
  pitch-shift. That is almost certainly what broke the previous attempt, or a wall-clock
  timer was. VERIFIED.
- **Drive the highlight from `requestAnimationFrame` reading `audio.currentTime`, and
  recompute the active word from scratch every frame** (binary search, not an incrementing
  cursor). Not `timeupdate` (spec-permitted as low as **4 Hz**, and explicitly
  non-deterministic). Not `cuechange` (the spec explicitly warns short cues get *skipped*
  when the UA catches up — fatal at 2×). VERIFIED — see §C.4.
- **Chunking is mandatory, not a design choice**: `/v1/audio/speech` caps input at
  **2,000 characters**. Chunk on sentence boundaries into ~1,200–1,800 char groups, keep a
  1-chunk lookahead, ping-pong two pre-unlocked `<audio>` elements. VERIFIED cap.
- **Paint with the CSS Custom Highlight API, not `<span>` wrapping.** It styles arbitrary
  `Range`s with zero DOM mutation — which matters enormously here, because Folio's existing
  highlight/comment anchoring would be destroyed by wrapping every word in a span. VERIFIED.
- **Budget:** a 10,000-word doc ≈ 55–60k chars ≈ **$0.55 per full read-through** at the
  Starter rate. The free tier (50k chars/mo) is just under one document per month.
- **Fallback ladder, if you ever need it:** **Azure** (~$16/1M but a **500k/mo free tier —
  10× Speechify's**, plus a built-in sentence tier and 6–10 chunks instead of 30–50) →
  **Unreal Speech** (~$8–12/1M, what Readwise actually ships) → **ElevenLabs** (drop-in but
  5–16× the cost). All three are CORS-open and all three drop into the same §C architecture.
  **Browser-native `speechSynthesis` is disqualified** — `rate` cannot be changed
  mid-utterance at all (§B.3).

**One-sentence architecture:** synthesize *once at rate 1.0*, per sentence-group chunk,
into an `<audio>` element; keep that chunk's word timestamps in the chunk's own media
timebase; every animation frame, binary-search `audio.currentTime * 1000` into that array
and repaint two `Highlight` objects; change speed by assigning `audio.playbackRate` and
touching nothing else.

---

## A. Speechify API reference

Full raw capture — request/response schemas, verbatim JSON, all documented gotchas — is in
**[`api-speechify-raw.md`](./api-speechify-raw.md)**. Condensed here.

> **Docs moved.** `docs.sws.speechify.com` now **301-redirects** to `docs.speechify.ai`.
> Both API hosts (`api.speechify.ai`, `api.sws.speechify.com`) are live and behave
> identically. Prefer `api.speechify.ai`. VERIFIED.

### A.1 The two endpoints that matter

| | Batch | Streaming |
|---|---|---|
| URL | `POST https://api.speechify.ai/v1/audio/speech` | `POST https://api.speechify.ai/v1/audio/stream/with-timestamps` |
| Returns | JSON: base64 audio + speech marks | SSE: `speech.chunk` / `speech.done` / `speech.error` |
| Speech marks on | **all models** | **`simba-3.0`, `simba-3.2` only** |
| Max input | **2,000 chars** | **20,000 chars** |
| Formats | `wav` (default), `mp3`, `ogg`, `aac`, `pcm` | `pcm_*`, `mp3_*`, `ulaw_8000`, `ogg_24000`, `aac_24000` |

Auth on both: `Authorization: Bearer sk_...`. VERIFIED live — a bogus key returns
`HTTP 401 {"error":{"code":"unauthorized",...}}`, not 404, confirming the paths.

Sources: [Create Speech](https://docs.speechify.ai/build/api-reference/v1/audio/speech) ·
[Stream with timestamps](https://docs.speechify.ai/build/api-reference/v1/audio/stream/with-timestamps.md) ·
[API limits](https://docs.speechify.ai/docs/get-started/api-limits)

### A.2 Speech marks — exact shape

VERIFIED from [the speech marks page](https://docs.speechify.ai/tts/text-to-speech/features/speech-marks):

```ts
type NestedChunk = {
  start_time: number  // MILLISECONDS from start of this synthesis
  end_time: number    // MILLISECONDS
  start: number       // CHARACTER INDEX into the input text
  end: number         // CHARACTER INDEX into the input text
  value: string
}
type SpeechMarks = NestedChunk & { chunks: NestedChunk[] }
```

Verbatim example from the docs:

```js
{
  start: 0, end: 27, start_time: 0, end_time: 1850,
  value: 'Hello, welcome to Speechify',
  chunks: [
    { start: 0,  end: 6,  start_time: 125, end_time: 375,  value: 'Hello,' },
    { start: 7,  end: 14, start_time: 375, end_time: 750,  value: 'welcome' },
    { start: 15, end: 17, start_time: 750, end_time: 875,  value: 'to' },
    { start: 18, end: 27, start_time: 875, end_time: 1850, value: 'Speechify' }
  ]
}
```

**Answering the question directly: yes — `start`/`end` per word in *milliseconds*, AND
character offsets into the input text, in a two-level chunk→word nesting.** That character
offset is the single most valuable field in this whole document: it means you never have
to fuzzy-match spoken words back onto your text. You get an exact index.

There is **no sentence tier** — only utterance and word. Sentence grouping must be derived
client-side from the character offsets. INFERRED consequence: segment your text into
sentences *before* sending it, remember each sentence's char range, and a word belongs to
whichever sentence range contains its `start`.

Four documented gotchas, all of which will bite:

1. **SSML escaping leaks into the offsets.** "Values are returned based on the SSML, so any
   escaping of `&`, `<` and `>` will be present in the `value`, `start` and `end` fields."
   → **Send plain text, not SSML**, or your character indices will drift.
2. **There are gaps between words.** The docs tell you to look up a word by testing
   `start >= yourIndex` rather than range containment. Whitespace and punctuation between
   tokens belong to no chunk. → A naive `start <= t && t < end` test makes the highlight
   *blink off* between words. Use "last word whose `start_time <= t`" instead.
3. **Leading silence.** First word's `start_time` is 125 ms in the example, not 0.
4. **Trailing silence.** "The `end_time` of the last word does not necessarily correspond
   with the end of the audio chunk." → Never assume `audio.duration * 1000` equals the last
   word's `end_time`. Useful side effect: chunk boundaries already contain a natural pause
   (relevant in §D).

### A.3 Models and voices

| Model | Notes |
|---|---|
| `simba-3.2` | Streaming-native flagship, shipped to the API **July 2026**; Speechify's recommended model for new English integrations |
| `simba-3.0` | **The API default if you omit `model`** |
| `simba-english` | Older English |
| `simba-multilingual` | Older multilingual |

Speech-mark support is **not voice-dependent** — it is endpoint- and model-dependent (all
models on batch; `simba-3.0`/`simba-3.2` on streaming). Voice catalogue is at
`GET /v1/voices` (path confirmed live, returns 401 with a bad key). I could not enumerate
voices without a real key. **NOT VERIFIED: which specific voice IDs exist.**

### A.4 Streaming vs batch — and a browser gotcha

The SSE framing is:

```
event: speech.chunk
data: {"type":"speech.chunk","audio":"[Base64]","speech_marks":[{"type":"word","value":"text","start":0,"end":100}]}

event: speech.done
data: {"type":"speech.done"}
```

Per the docs, **timestamps are absolute milliseconds from the start of the synthesis** and
audio chunks concatenate into one timeline — so within a single streaming request there is
no per-chunk offset math.

**INFERRED, and important:** the native `EventSource` API cannot set an `Authorization`
header and only issues GET. This endpoint is a POST with a Bearer token, so **`EventSource`
will not work.** You must read the SSE stream with `fetch()` + `response.body.getReader()`
and parse the `event:`/`data:` framing yourself. That is an ordinary cross-origin fetch,
which the CORS policy below permits.

**⚠️ The #1 parser trap — the audio field is named differently on the two endpoints:**

| Endpoint | Base64 audio field |
|---|---|
| `POST /v1/audio/speech` (batch) | **`audio_data`** |
| `POST /v1/audio/stream/with-timestamps` (SSE) | **`audio`** |

Flagged in prior in-house research ([`speechify-simba-findings.md`](./speechify-simba-findings.md))
as the single most common integration bug, and consistent with the two schemas I captured
independently. Write one normalizer that accepts either and never touch the raw field names
again.

Related: legacy voices/models on the streaming endpoint reportedly fail with
**`400 speech_marks_unsupported`** rather than silently returning marks-free audio — a
helpful, loud failure. (Reported in the prior research; **not independently verified here**.)

### A.5 CORS verdict — **VERIFIED EMPIRICALLY, this is the headline finding**

I sent a real preflight on 2026-08-16:

```bash
curl -i -X OPTIONS "https://api.speechify.ai/v1/audio/speech" \
  -H "Origin: https://folio.vercel.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

```
HTTP/2 200
access-control-allow-headers: Authorization, Content-Type
access-control-allow-methods: POST
access-control-allow-origin: https://folio.vercel.app
access-control-max-age: 300
vary: Origin
```

It **reflected my arbitrary origin** and **explicitly allowed the `Authorization` header**.
Identical result for `/v1/audio/stream/with-timestamps` and for the `api.sws.speechify.com`
host.

**Verdict: a static site can call Speechify directly from the browser with the user's
Bearer token. No proxy required.** This kills the main architectural risk.

> **This closes a question the prior in-house research left open.**
> [`speechify-simba-findings.md`](./speechify-simba-findings.md) lists CORS as unresolved
> question #12 and guesses the pessimistic answer — *"Folio already proxies Notion through
> Electron IPC for exactly this reason … likely the same answer here."* It isn't. Notion
> genuinely does block cross-origin browser calls; **Speechify explicitly allows them.**
> Practical consequence: unlike the Notion integration, **read-aloud does not need to be
> Electron-only.** It works identically in the Vercel web build with no `ipcMain.handle` /
> `contextBridge` pair to maintain.

Two footnotes:
- Speechify's docs *do* describe a server-side short-lived token flow
  (`POST /v1/auth/token`, client-credentials, default scope `audio:all voices:read`) and say
  the token call "must only be called server-side". That guidance exists for apps serving
  *other people's* users. For a bring-your-own-key app where the key is the user's own and
  lives in their own localStorage, it does not apply — there is no secret to leak to anyone
  but the key's owner.
- `access-control-max-age: 300` means the browser re-runs the preflight every 5 minutes.
  One occasional extra round trip, not a correctness issue.

### A.6 Speed control in the API is the *wrong* lever

Speechify exposes speed **only** through SSML `<prosody rate="...">` in the `input`
(keywords `x-slow`…`x-fast`, or percentages **−83% to +100%**).
[Docs](https://docs.speechify.ai/tts/text-to-speech/features/ssml).

That is server-side. Using it for a speed slider would mean **re-synthesizing on every
speed change** — new cost, new latency, new (different) speech marks, and a re-seek to
where the user was. Do not do this. Synthesize once at rate 1.0 and use
`audio.playbackRate`. VERIFIED that these are the only two options.

### A.7 Pricing (VERIFIED, [speechify.ai/pricing](https://speechify.ai/pricing))

| Plan | Price | Included | Overage |
|---|---|---|---|
| Free | $0 | 50,000 chars/mo (**hard cap**, no card) | — |
| Starter | $10/mo | 1M chars | $10 / 1M |
| Pro | $99/mo | 3M chars | $8 / 1M |
| Scale | $499/mo | 10M chars | $6 / 1M |

Flat per character, no credit conversion.

**Folio's working number: a 10,000-word doc ≈ 55–60k characters ≈ $0.55 per full
read-through at Starter.** The free tier covers just under one such document per month —
which makes the caching and prefetch-discipline in §D matter more than it might seem.

### A.8 Rate and concurrency limits (VERIFIED)

| Plan | Sustained rps | Burst | Concurrent |
|---|---|---|---|
| Free | 1 | 10 | **1** |
| Starter | 20 | 60 | 15 |
| Pro | 40 | 120 | 30 |
| Scale | 80 | 240 | 60 |

429 responses carry either `rate_limited` or `concurrency_limited`, plus `Retry-After`.
**Free-tier concurrency of 1 means a one-chunk lookahead is the *maximum* safe prefetch
depth on the free plan** — you cannot fetch chunk N+1 while a retry is in flight.

---

## B. Provider comparison table

| Provider | Word timestamps | Browser CORS | Cost / 1M chars | Voice quality | Latency | Verdict |
|---|---|---|---|---|---|---|
| **Speechify** (`simba-3.2`) | **Yes — word-level, ms, + char offsets into input** | ✅ **reflects origin, allows `Authorization`** (measured) | **$6–10** | Excellent (the reason you're here) | Streaming-native flagship; SSE first-chunk | ✅ **Recommended** |
| **Unreal Speech** | **Yes — per-word timestamps** | ✅ reflects origin, allows `Authorization` (measured) | **~$8–12** | Good (Readwise ships it as their English default) | Good | ⚠️ **Strong runner-up** — cheapest entry is $49/mo though, vs Speechify's $10 |
| ElevenLabs (`/with-timestamps`) | Character-level only (`characters[]`, `character_start_times_seconds[]`, `character_end_times_seconds[]`), seconds | ✅ `ACAO: *`, `ACAH: *` (measured) | **$50** Flash / **$100** Multilingual | Excellent | Flash is very fast | Viable fallback, but **5–16× the cost** and you must fold chars→words yourself |
| OpenAI TTS | ❌ **None. No timestamps of any kind.** | ✅ reflects origin (measured) | ~$15 (gpt-4o-mini-tts) | Good | Chunked-transfer streaming | ❌ **Disqualified** — cannot do word highlighting at all |
| Deepgram Aura | ❌ No documented TTS word timestamps | ✅ reflects origin (measured) | ~$30 (Aura-2) | Good, agent-tuned | Very low (their pitch) | ❌ Disqualified for this use case |
| Cartesia Sonic | Yes — but **WebSocket only** (`add_timestamps: true`; `{words[], start[], end[]}` in **seconds**) | ✅ `ACAO: *` on HTTP (measured); WS bypasses CORS entirely | ~$25–40 | Very good | Lowest in class (~50 ms) | Viable, but WS + no timestamps on the plain HTTP endpoint adds complexity |
| Google Cloud TTS | SSML `<mark>` timepoints (`timepoints[]`, seconds) — you must inject a mark per word | ✅ reflects origin (measured) | ~$16 (Neural2) | Good | Moderate | Workable but clumsy: hand-inserting a `<mark>` before every word bloats input and is fragile |
| Azure Speech (JS SDK) | **Yes — `WordBoundary` events with `audioOffset` + `textOffset` + `wordLength`** | ✅ N/A — SDK uses **WebSocket**, which CORS doesn't gate; `fromSubscription(key)` works client-side | ~$16 Neural / ~$22 Neural HD; **500k chars/mo free** | Very good | Moderate | ⚠️ **Genuinely viable** (see §B.2) — 2–3× Speechify's cost and needs a 1 MB SDK, but the **500k free tier is 10× Speechify's** |
| Browser `speechSynthesis` | `onboundary` (`charIndex`/`charLength`) — free, no key | N/A | **$0** | Poor–OK (OS voices) | Instant | ❌ **Disqualified — cannot change rate on the fly at all** (see §B.3) |

**CORS column is measured, not assumed.** I ran an `OPTIONS` preflight against every one of
these hosts from `https://folio.vercel.app` on 2026-08-16. All returned 200 with a
permissive `Access-Control-Allow-Origin` and an `Access-Control-Allow-Headers` that
includes the auth header. **CORS turned out not to differentiate the providers at all** —
which is itself the useful finding, because it means provider choice can be made purely on
timestamps, cost, and voice.

> Detailed request/response schemas for the two fallbacks — **Azure** (different mechanism,
> 10× free tier) and **ElevenLabs** (drop-in, expensive) — are in
> **[`api-azure-speech-raw.md`](./api-azure-speech-raw.md)**, including a ready-to-use
> character→word folding function for ElevenLabs.

### B.1 Why character-level (ElevenLabs) is worse than word-level (Speechify) here

ElevenLabs returns a per-character array. To get words you group runs between whitespace
and take `min(start)`/`max(end)` — trivially doable, and it does give you *exact* character
offsets by construction (index in the array = index in the string).

The real cost is money, not effort: **$50/1M (Flash) or $100/1M (Multilingual) vs Speechify's
$6–10/1M**. A 10k-word doc costs ~$0.55 on Speechify Starter and **$2.75–$5.50** on
ElevenLabs. For an app whose whole point is reading long documents, that is a 5–16× swing.
VERIFIED from [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api).

Keep ElevenLabs as the documented fallback provider — the timing-map abstraction in §C makes
swapping providers a ~30-line adapter.

### B.1b Unreal Speech — the runner-up worth knowing about

Surfaced from the prior-art research (§E): **Readwise Reader — the closest analogue to what
Folio is building — uses Unreal Speech as their English default**, with Azure as a non-English
fallback. That's a meaningful signal from someone who solved this exact problem in production.

- **Per-word timestamps** in the API response. VERIFIED (vendor docs/marketing; I did not
  fetch a schema, so **the exact field names are NOT VERIFIED**).
- **CORS-open**, measured: `api.v8.unrealspeech.com` reflects an arbitrary origin and allows
  `authorization`. Direct browser calls work.
- **~$8–12 per 1M characters** at their Plus/Pro tiers — genuinely competitive with Speechify.
  **250k characters free** (5× Speechify's free tier).
- **The catch: their cheapest paid plan is $49/mo**, versus Speechify's $10/mo Starter. For a
  personal reading app, Speechify's entry price is materially better, and per-character rates
  are close enough that the plan floor dominates.

**Verdict: stay with Speechify** — you already have the key, you like the voice, the entry
price is 5× lower, and the speech-marks payload carries character offsets. But Unreal Speech is
the one to try first if Speechify's voice or latency disappoints.

### B.2 Azure Speech — the sleeper pick, and it *does* work

Your instinct was right: this one deserved a hard look, and it survives scrutiny. **The
thing I expected to kill it — the SDK insisting on playing audio itself — turns out to be
avoidable.**

**It loads from a CDN with no bundler.** VERIFIED — Microsoft's
[setup-platform quickstart](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/quickstarts/setup-platform)
has a dedicated *browser* tab shipping a prebuilt UMD bundle:

```html
<script src="https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@latest/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js"></script>
```

That's compatible with Folio's no-build-step constraint. (It is, however, a ~1 MB dependency
versus Speechify's zero — you'd be adding a vendored SDK to a repo that currently makes
plain `fetch` calls.)

**The `WordBoundary` event, exactly.** VERIFIED from the
[`SpeechSynthesisWordBoundaryEventArgs` reference](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesiswordboundaryeventargs?view=azure-node-latest):

```js
synthesizer.wordBoundary = (sender, e) => {
  e.audioOffset   // ticks — 100-nanosecond units
  e.duration      // ticks — docs: "Specifies the duration, in ticks (100 nanoseconds)"
  e.text          // the word
  e.textOffset    // character offset into the input text
  e.wordLength    // length in characters
  e.boundaryType  // Word | Punctuation | Sentence
};
// Microsoft's own sample converts ticks → ms as:  (e.audioOffset + 5000) / 10000
```

**Answering the sub-questions directly:**
- **Units: ticks (100 ns), not ms.** Divide by 10,000.
- **It gives `textOffset` + `wordLength`** — the same character-offset capability that makes
  Speechify's speech marks good. Equivalent on this axis.
- **Sentence boundaries exist but are OFF by default.** `SpeechSynthesisBoundaryType` has
  `Word | Punctuation | Sentence`; `SpeechServiceResponse_RequestPunctuationBoundary`
  defaults to **true**, `SpeechServiceResponse_RequestSentenceBoundary` defaults to **false**.
  Opt in with
  `speechConfig.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestSentenceBoundary, "true")`.
  Nice — that's a free sentence tier that Speechify doesn't give you.

**The key finding — you can get raw bytes and keep your own `<audio>` element.** VERIFIED
from Microsoft's own how-to sample: **omit `AudioConfig` entirely** (or pass `null`) when
constructing the synthesizer:

```js
const synth = new sdk.SpeechSynthesizer(speechConfig);   // no AudioConfig
synth.speakTextAsync(text, result => { /* result.audioData is an ArrayBuffer */ });
```

Nothing plays. You get an `ArrayBuffer`, and **`wordBoundary` still fires normally during
that call.** Wrap it in a `Blob`, make an object URL, feed your own `<audio>` element — and
everything in §C applies unchanged. `SpeakerAudioDestination` also publicly exposes
`internalAudio: HTMLAudioElement` (VERIFIED by reading the
[SDK source](https://github.com/microsoft/cognitive-services-speech-sdk-js/blob/master/src/sdk/Audio/SpeakerAudioDestination.ts)),
so you *could* set `playbackRate` on it — but that's an internal-looking property and you
don't need it if you never hand the SDK an `AudioConfig`.

**Auth and CORS:** `SpeechConfig.fromSubscription(key, region)` works directly client-side —
it's the first line of the browser quickstart. Microsoft's "mint a short-lived token
server-side" guidance targets multi-tenant SaaS, not BYOK. **The SDK talks over WebSocket
(`wss://<region>.tts.speech.microsoft.com/...`), and WebSocket handshakes aren't gated by
CORS**, so the CORS question doesn't even arise. (INFERRED from platform behaviour — no
explicit Microsoft statement, but every connectivity complaint found was firewall/region
related, never CORS.)

**Chunking limits — actually better than Speechify's.** VERIFIED from
[Quotas and Limits](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits):
**64 KB text per request** and a **10-minute cap on audio output per request**. The audio cap
binds first: ~10 minutes ≈ **~1,500 words**, so a 10k-word doc is **6–10 chunks** versus
Speechify's ~30–50 (2,000-char cap). Fewer seams. Note that Azure's `audioOffset` values are
per-request, so you'd offset by cumulative totals across chunks.

**Pricing:** ~**$16/1M** Neural, ~**$22/1M** Neural HD — 2–3× Speechify. But the **free tier
is 500,000 chars/month**, which is **10× Speechify's 50k** and about **9 full 10k-word
documents per month for free**. VERIFIED: the free-tier figure appears in the official
pricing page text. **NOT VERIFIED: the dollar figures** — Azure's pricing page renders
amounts via client-side JS; those numbers come from converging third-party aggregators.
Confirm before committing.

**Verdict:** Azure is a real, working option and I was wrong to pre-judge it. It loses to
Speechify on cost-per-character, dependency weight, and (subjectively) the voice you already
like — but it wins on free-tier generosity, larger chunks, and a built-in sentence tier.
**If Speechify's free tier proves too tight for your actual usage, Azure is the switch to
make**, and the §C architecture ports over unchanged.

### B.3 Browser-native `speechSynthesis` — free, and disqualified on your core requirement

Free, no key, offline, zero latency. And it **cannot do the one thing you specifically
asked for.**

**The disqualifier: rate cannot be changed mid-utterance.** VERIFIED. `utterance.rate` is
read at `speak()` time and is not live. The universally documented pattern — including MDN's
own example and
[Bugzilla 1523920 "SpeechSynthesis Utterances are not reusable"](https://bugzilla.mozilla.org/show_bug.cgi?id=1523920)
— is `if (synth.speaking) synth.cancel(); synth.speak(newUtteranceWithNewRate)`. **Every
speed change is a cancel-and-restart from the current word, with an audible artifact.** There
is no `playbackRate` equivalent because there is no media element — `speechSynthesis` is a
black box with no scrubbable timeline. That alone ends it for a 0.5×–2× on-the-fly slider.

**`onboundary` fields and support** (VERIFIED against MDN's live browser-compat-data, fetched
as raw JSON rather than a summary):

| Field | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| `charIndex` | 33+ | 14+ | 49+ | 7+ |
| `charLength` | 77+ | 15+ | 53+ | **16+** (Sept 2022) |
| `elapsedTime` | 33+ | 14+ | 49+ | 7+ — **semantics drifted; don't rely on it** |
| `name` | 33+ | 14+ | 49+ | 7+ |

Not supported at all: **Opera Android, WebView Android**.

Worth correcting a piece of stale folklore you may run into: **"Safari doesn't support
`charLength`" is out of date** — WebKit added it in Safari 16 (changeset 291124, March 2022),
Baseline since Sept 2022. Sources still repeating that in 2026 are four years behind.

**Reliability is genuinely unresolved, and I'm going to present the conflict rather than
pick a side:**
- MDN's live compat data flags **desktop Chrome as "Partial implementation"** with the note
  *"The `boundary` event does not fire as expected"* (crbug 40715888), and the MDN page
  carries a banner: *"This feature is not Baseline because it does not work in some of the
  most widely-used browsers."*
- But [mdn/browser-compat-data#28419](https://github.com/mdn/browser-compat-data/issues/28419)
  actively disputes that flag, arguing with a live demo that desktop Chrome fires `boundary`
  per word correctly and that crbug 40715888 is really about **Android** Chrome. As of the
  data fetched today, MDN still carries the original note — unclear whether the correction
  was rejected or just not merged.
- Practitioner reports contradict each other on Safari granularity: some (2026-dated) say
  "Safari fires per sentence"; [dbushell (July 2025)](https://dbushell.com/2025/07/26/text-to-speech-synthesis/)
  reports word highlighting works well in current Chromium *and* WebKit but gives up on
  Firefox ESR 128; a 2020 source says macOS never fires `'sentence'` and gives words instead.
  **These cannot be reconciled from documentation — only by testing.**
- Everyone agrees **Android is broken**.

**The other killer: the Chrome ~15-second cutoff.** The spec cap is 32,767 chars per
utterance ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/text)),
but the practical ceiling is far lower: [crbug 679437](https://bugs.chromium.org/p/chromium/issues/detail?id=679437),
"Speech Synthesis stops abruptly after about 15 seconds," is **reportedly still unresolved in
2026** — Chrome silently cancels after ~14–15 s with **no error callback**. The classic
`pause()`/`resume()`-every-14s hack **breaks on Android, where `pause()` behaves as
`cancel()`** (agreed by independent sources five years apart). The only safe workaround is
chunking to ~200–300 words — meaning **35–50 chunks for a 10k-word doc**, ~5× more seams than
Speechify and ~6× more than Azure.

**Verdict: not viable as the primary engine.** The rate constraint alone is fatal to the
stated requirement. It could serve as a **$0 degraded tier** — no API key configured, fixed
speed or accept-the-restart-artifact, sentence-level highlighting only — but do not build the
main feature on it.

---

## C. Variable speed + word sync — THE definitive approach

This is the section that answers the question the previous attempt got wrong.

### C.1 `currentTime` stays in the media timebase at every playback rate — YES, confirmed

**VERIFIED, quoting the [WHATWG HTML Standard](https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource) verbatim:**

> "A media resource has a **media timeline** that maps times (in seconds) to positions in
> the media resource."

> "Media elements have a **current playback position** … **The current playback position is
> a time on the media timeline.**"

> "The `currentTime` attribute must, on getting, return the media element's default playback
> start position, unless that is zero, in which case it must return the element's **official
> playback position**."

And the decisive sentence:

> "When a media element is potentially playing and its Document is a fully active Document,
> its current playback position must increase monotonically at the element's **`playbackRate`
> units of media time per unit time of the media timeline's clock**."

Read that carefully: `playbackRate` is defined as a **ratio of media time to wall-clock
time**. It changes *how fast* `currentTime` advances relative to the wall clock. It does not
change *what `currentTime` means*. At 2× the value still counts seconds of the media; it
just gets there in half the wall-clock time.

**Therefore: speech-mark times (media-time ms) and `audio.currentTime * 1000` are in the
same units, permanently, at every rate. Zero conversion. Ever.**

> **This is the whole answer to "why did my highlighting desync when I changed speed".**
> If the highlight is driven off `audio.currentTime`, it *cannot* desync — the audio and the
> timestamps are reading the same clock. If it desynced, the implementation was driving the
> highlight off something else: a `setInterval` advancing a wall-clock counter, a `Date.now()`
> delta, or a cursor that increments once per word on a timer. All of those break the instant
> `playbackRate ≠ 1`. The fix is not "scale the timestamps by the rate" — that's a patch that
> will drift on every pause, seek, and buffer stall. The fix is to delete the independent
> clock entirely and make `audio.currentTime` the only source of truth.
>
> **UPGRADED FROM INFERRED TO CONFIRMED.** I originally wrote the paragraph above as an
> inference. A parallel code-level post-mortem of the previous attempt
> ([`superwhisper-tts-postmortem.md`](./superwhisper-tts-postmortem.md)) independently found
> exactly these causes in the source, with `file:line` citations — and found that speed broke
> in **three separate subsystems at once**, which is why it never felt fixed:
> 1. **A wall-clock dead-reckoning estimate of the media clock, computed in a different
>    process from the audio element** (`reader-extension/content.js:69`). This is the §C.1
>    failure, in its worst possible form — the estimator couldn't even see the real clock.
> 2. **Web Audio `AudioBufferSourceNode.playbackRate`** used for playback
>    (`content.js:110`) — the §C.3 resampling/pitch-shift failure.
> 3. **A word-index space mismatch** — TTS-spoken word counts used to index into a DOM word
>    array (`offscreen.js:139` → `content.js:72`), so **error compounded monotonically across
>    the document**. This one is not a speed bug at all; it's why highlighting drifted even
>    at 1×.
>
> That third cause is worth dwelling on, because §C.7 is specifically designed to make it
> impossible: **never index words by count.** Use the character offsets the API gives you
> (`start`/`end`) as the only address space. Counting words in two places and assuming the
> counts agree is the bug; character offsets from the synthesizer can't drift because they
> are the synthesizer's own view of the exact string you sent.
>
> The post-mortem's own top-line conclusion matches this section's: *"The single most
> expensive mistake in the whole history was separating the audio clock from the highlighter
> across a process boundary."*

Corollary worth internalizing: **you should never multiply or divide a timestamp by the
playback rate anywhere in this feature.** If you find yourself writing `* rate` or
`/ rate`, you have reintroduced the bug.

### C.2 `preservesPitch` — no chipmunk, and it's already the default

**VERIFIED.** MDN on
[`playbackRate`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate):

> "**The pitch of the audio is corrected by default.** You can disable pitch correction
> using the `HTMLMediaElement.preservesPitch` property."

MDN on [`preservesPitch`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch):
default is **`true`**, and it is **"Baseline Widely available … since December 2023"**. The
old `mozPreservesPitch` / `webkitPreservesPitch` prefixes are **no longer needed in 2026**
(harmless to set defensively, but not required).

The spec makes it a hard requirement, not a hint:

> "If the element's `playbackRate` is not 1.0 and `preservesPitch` is true, the user agent
> must apply pitch adjustment to preserve the original pitch of the audio."

**Quality ceiling** (VERIFIED for Chromium, INFERRED as broadly representative):
Chromium implements this with **WSOLA** (Waveform Similarity Overlap-Add) in
`audio_renderer_algorithm`. Two documented details:
- For rate changes within about **±5–6%** Chromium uses *resampling* instead, because WSOLA
  produces audible "warbling / transient stuttering" artifacts on very small adjustments.
- Chromium does not mute until **`playbackRate > 8`**. Firefox
  [mutes outside 0.25–4.0](https://bugzilla.mozilla.org/show_bug.cgi?id=1630569), which MDN
  also notes.

Practical read: **0.5×–2× is comfortably inside the good zone for speech** — speech is the
easy case for WSOLA (quasi-periodic, single source, no stereo image to smear). Degradation
becomes noticeable around **2.5–3×** and unpleasant past ~4×. Capping the UI at 3× is a
defensible product decision. **NOT VERIFIED: exact perceptual quality in Safari at 2×+** —
there are older reports of Safari sounding worse when sped up, and Safari's implementation
differs from Chromium's. Since Folio also ships as an Electron (Chromium) app, this only
affects the web build. **Test this by ear in Safari before shipping.**

### C.3 Web Audio `AudioBufferSourceNode.playbackRate` — confirmed WRONG tool

**VERIFIED.** Per [MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/playbackRate),
this parameter causes the node to **resample** the buffer:

> "A value of 1.0 indicates it should play at the same speed as its sampling rate, values
> less than 1.0 cause the sound to play more slowly, while values greater than 1.0 result in
> audio playing faster than normal."

Resampling changes speed and pitch **together** — 44.1 kHz played at rate 2.0 is emitted as
if it were 88.2 kHz. There is no `preservesPitch` equivalent on `AudioBufferSourceNode`;
adding one has been an
[open Chromium request](https://issues.chromium.org/issues/41263293) for years.

So: `<audio>.playbackRate` = time-stretch, pitch preserved. `AudioBufferSourceNode.playbackRate`
= resample, chipmunk. **If the previous attempt used Web Audio for playback, that alone
explains the pitch problem** — and it would *also* have made sync harder, because
`AudioContext.currentTime` is a wall-clock-ish context timeline, not a media timeline, so
you'd have to divide by the rate manually and it would drift.

### C.4 The right loop: `requestAnimationFrame`, not `timeupdate`, not `cuechange`

**`timeupdate` is disqualified. VERIFIED — spec, verbatim:**

> "The event thus is not to be fired faster than about 66Hz or **slower than 4Hz** (assuming
> the event handlers don't take longer than 250ms to run). **User agents are encouraged to
> vary the frequency of the event** based on the system load and the average cost of
> processing the event each time…"

Two independent killers, not one: the floor is **4 Hz** (250 ms — a word at normal speech is
~150–350 ms, so you'd skip words even at 1×), *and* the rate is explicitly **non-deterministic
and load-dependent**, so you cannot even calibrate around it. At 2× the situation doubles in
severity: 250 ms of wall clock is now 500 ms of media time.

**`cuechange` / WebVTT is elegant but riskier than it looks.** It is genuinely tempting: cues
are evaluated against the media timeline by the "time marches on" algorithm, so it is
inherently rate-correct, and the spec asks for real precision:

> "…user agents should fire cue events as close as possible to their position on the media
> timeline, and **ideally within 20 milliseconds**."

But the very next paragraph is the problem:

> "**If one iteration takes a long time, this can cause short duration cues to be skipped
> over as the user agent rushes ahead to 'catch up', so these cues will not appear in the
> `activeCues` list.**"

Word cues are short by definition — ~200 ms at 1×, **~100 ms at 2×, ~65 ms at 3×**. The spec
explicitly permits the UA to skip exactly those. A skipped cue means a word that never
highlights. **INFERRED but well-founded: `cuechange` is fine for sentence-level cues and
risky for word-level cues at high rates.**

**`requestAnimationFrame` reading `audio.currentTime` is the right answer**, for a reason
that is worth stating precisely: it is not just "more frequent". It is **stateless and
therefore self-healing**. Every frame you *recompute* which word should be active from
`currentTime`, rather than *advancing* a cursor. That single design choice makes the
highlight immune to:

- speed changes (the value read is already in media time),
- seeks and scrubbing (recompute lands on the right word instantly),
- buffer stalls (the audio clock stops, so the highlight stops with it),
- dropped frames / GC pauses (a missed frame delays the repaint, it can never mis-target it),
- **hidden tabs** — `requestAnimationFrame` does not run in a background tab, so the highlight
  freezes while audio keeps playing; the moment the tab is visible again the next frame
  recomputes and it is instantly correct with no catch-up logic. VERIFIED that Chrome does
  not call rAF for backgrounded pages.

rAF fires at display refresh (60–120 Hz → 8–16 ms), comfortably inside the spec's own 20 ms
"ideal cue accuracy" target, and it costs one binary search over a few hundred entries per
frame — nothing.

### C.5 Existing libraries and standards — nothing worth adopting

I looked. The honest answer is **write the ~40 lines yourself**.

- **Prior-art implementations exist and all do the same thing**:
  [westonruter/html5-audio-read-along](https://github.com/westonruter/html5-audio-read-along),
  [johndyer/audiosync](https://j.hn/html5-audio-karoke-a-javascript-audio-text-aligner/),
  [MediaSync](https://github.com/fabiosoggia/MediaSync), `karaoke-js`. They are all "array of
  {start, end, index} + read the media clock". Several are old enough to use `timeupdate`
  (see above — don't). None handles chunked streaming TTS or a 2,000-char API cap.
- **wavesurfer.js / Howler are the wrong shape.** wavesurfer is a waveform *visualizer* whose
  regions are for audio editing UI; Howler is a playback abstraction (and its Web Audio path
  reintroduces the §C.3 pitch problem). Neither maps time→text.
- **EPUB Media Overlays** ([EPUB 3.3 §Media Overlays](https://www.w3.org/TR/epub-33/#sec-media-overlays))
  is a **SMIL 3.0 subset** — `<par>` containers pairing a `<text>` fragment reference with an
  `<audio clipBegin clipEnd>`. It is a real standard and it is exactly this problem, but it is
  an *authoring/packaging* format for pre-narrated books: XML, file-based, fragment-ID-based.
  Nothing in it helps at runtime, and no browser implements it natively.
- **W3C SyncMediaLite** ([CG draft](https://w3c.github.io/sync-media-pub/sync-media-lite)) is the
  modern, web-native take — WebVTT cues carrying JSON payloads with CSS/text-position
  selectors. Conceptually the closest thing to what we want. But it is a **Community Group
  Note that literally says "These are ideas, nothing official yet!"** Not a standard. Not
  implemented.

**Verdict: there is no standard timing format worth adopting.** Speechify's speech-marks JSON
already *is* the timing map, in a lighter form than any of these, and with character offsets
that SMIL/Media Overlays don't give you. Define a tiny internal shape and write provider
adapters into it — that also makes ElevenLabs/Cartesia drop-in replacements.

### C.6 Painting the highlight — CSS Custom Highlight API (important for Folio specifically)

**Do not wrap words in `<span>`s. In this codebase specifically, that would silently corrupt
every saved highlight in every document.** I verified the mechanism directly rather than
assuming it: `js/highlights.js:121` serializes a highlight by its **position in the flat list
of text nodes** —

```js
const startIdx = textNodes.indexOf(range.startContainer);   // js/highlights.js:123
// stored as { startNodeIndex: startIdx, startOffset, ... }  // :129
```

— and `deserializeRange` (`js/highlights.js:137`) reads those indices back against a freshly
walked node list. `getTextNodes` (`js/highlights.js:50`) walks with `NodeFilter.SHOW_TEXT`.

**Wrapping each word in a span splits one paragraph text node into N word text nodes.** A
document with ~50 text nodes becomes ~10,000, and every stored `startNodeIndex` then addresses
a completely different node. The failure is **silent** — highlights don't error, they just
reattach to the wrong text. That is far worse than a crash, and it would only be noticed after
the damage was saved.

(This constraint is analysed in more depth, including the comment-flow reuse path, in
[`folio-integration-constraints.md`](./folio-integration-constraints.md).)

The [**CSS Custom Highlight API**](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)
styles arbitrary `Range` objects **with zero DOM mutation**. Registered via `CSS.highlights`,
styled via `::highlight()`.

Support (VERIFIED): **Chrome/Edge 105** (Aug 2022), **Safari 17.2** (Dec 2023),
**Firefox 149** (March 2026). **Baseline "newly available" as of June 2025.** As of Aug 2026
all three engines ship it. Folio's Electron build is Chromium, so it is guaranteed there;
the web build needs a feature check (`if (CSS.highlights)`) and a graceful degrade to
sentence-only or no highlighting on stragglers.

Two highlights, different strengths, exactly matching the requirement:

```css
::highlight(tts-sentence) { background: rgba(255, 214, 102, 0.28); }
::highlight(tts-word)     { background: rgba(255, 176,  32, 0.70); border-radius: 2px; }
```

Set `wordHighlight.priority = 1` so the word paints above the sentence.

### C.7 Code sketch

```js
// ---------------------------------------------------------------------------
// 1. ONE-TIME: build a flat-text ↔ DOM map for the rendered document.
//    Everything downstream addresses text by a single global character offset,
//    which is exactly the coordinate system Speechify's speech marks use.
// ---------------------------------------------------------------------------
function buildTextMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  return { text, nodes };
}

// Turn a global char offset into a live DOM position (binary search the map).
function locate(map, offset) {
  let lo = 0, hi = map.nodes.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map.nodes[mid].start <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  const entry = map.nodes[ans];
  return { node: entry.node, offset: offset - entry.start };
}

function rangeFor(map, startOffset, endOffset) {
  const a = locate(map, startOffset), b = locate(map, endOffset);
  const r = new Range();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

// ---------------------------------------------------------------------------
// 2. A chunk = one synthesis request. `base` is where this chunk's text starts
//    in the global flat text, so `base + mark.start` is a global offset.
//    NOTE: word times stay in THIS chunk's own media timebase. We deliberately
//    do NOT build a global audio timeline — each chunk has its own <audio>,
//    so its own currentTime already is the right clock.
// ---------------------------------------------------------------------------
function normalizeSpeechify(speechMarks, base) {
  return speechMarks.chunks.map((c) => ({
    startMs: c.start_time,
    endMs:   c.end_time,
    from:    base + c.start,   // global char offset
    to:      base + c.end,
  }));
}

// ---------------------------------------------------------------------------
// 3. THE SYNC LOOP. The only clock is audio.currentTime.
//    Nothing here is aware of playbackRate — that is the entire point.
// ---------------------------------------------------------------------------
const sentenceHL = new Highlight();
const wordHL     = new Highlight();
wordHL.priority  = 1;
CSS.highlights.set('tts-sentence', sentenceHL);
CSS.highlights.set('tts-word', wordHL);

let rafId = null;
let lastIdx = -1;

// "Last word that has already started." Per Speechify's own guidance, do NOT
// test `start <= t && t < end` — there are gaps between words (whitespace and
// punctuation belong to no chunk) and a containment test blinks the highlight
// off in every gap.
function activeWordIndex(words, tMs) {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= tMs) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

function tick(chunk, map) {
  // The one load-bearing line in this entire feature.
  // currentTime is a position on the MEDIA timeline at every playbackRate,
  // so this comparison is rate-correct by construction. Never scale it.
  const tMs = chunk.audio.currentTime * 1000;

  const i = activeWordIndex(chunk.words, tMs);
  if (i !== lastIdx) {                 // repaint only on change
    lastIdx = i;
    wordHL.clear();
    sentenceHL.clear();
    if (i >= 0) {
      const w = chunk.words[i];
      wordHL.add(rangeFor(map, w.from, w.to));
      const s = chunk.sentenceFor(i);  // precomputed sentence char range
      sentenceHL.add(rangeFor(map, s.from, s.to));
    }
  }
  rafId = requestAnimationFrame(() => tick(chunk, map));
}

// ---------------------------------------------------------------------------
// 4. SPEED. This is the complete implementation. There is no step 2.
// ---------------------------------------------------------------------------
function setRate(player, rate) {
  player.rate = rate;                       // remember it for future chunks
  for (const el of player.audioElements) {  // current + preloaded next
    el.preservesPitch = true;               // default is already true; explicit for clarity
    el.playbackRate = rate;
  }
  // No re-synthesis. No timestamp rescaling. No re-seek. Nothing else to do.
}

// ---------------------------------------------------------------------------
// 5. PAUSE → highlight the paragraph and offer a comment box.
// ---------------------------------------------------------------------------
chunk.audio.addEventListener('pause', () => {
  cancelAnimationFrame(rafId);
  if (lastIdx < 0) return;
  const w = chunk.words[lastIdx];
  const { node } = locate(map, w.from);
  const para = node.parentElement.closest('[data-block-id]'); // Editor.js block
  para.classList.add('tts-paused-block');
  Comments.openInlineComposer(para);   // reuse Folio's existing comment UI
});
```

Note what is *absent* from that sketch: no `setInterval`, no `Date.now()`, no accumulated
elapsed-time variable, no `* rate` anywhere. That absence is the design.

---

## D. Chunking & gapless playback

### D.1 Chunk size is dictated by the API, not by taste

**VERIFIED hard cap: `/v1/audio/speech` rejects input over 2,000 characters.** (Streaming
allows 20,000.) A 10,000-word document is ~55–60k characters, so **you must split it into
roughly 30–50 requests regardless of what you'd prefer architecturally.**

Recommended segmentation:

1. Split the flat document text into **sentences** with
   [`Intl.Segmenter`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)
   using `{ granularity: 'sentence' }`. VERIFIED: it's built into the platform (**Baseline
   since April 2024**), it handles abbreviations far better than a regex, and — the part that
   matters most here — each segment carries an **`index`: the character offset of the segment
   in the original string**. That is the same coordinate system as Speechify's speech marks,
   so sentence ranges and word marks line up with no translation layer:

   ```js
   const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
   const sentences = [...seg.segment(flatText)]
     .map(s => ({ from: s.index, to: s.index + s.segment.length, text: s.segment }));
   ```
2. Greedily accumulate sentences into chunks of **~1,200–1,800 characters**, never splitting
   a sentence across chunks. That leaves headroom under the 2,000 cap for safety.
3. Prefer breaking at **paragraph boundaries** when one falls near the target size — chunk
   seams are audible, and a paragraph break is where a seam is *supposed* to be.
4. Record each chunk's `base` global character offset. That is what makes speech-mark
   offsets addressable against the document.

Why not one chunk per sentence? Time-to-first-audio would be great, but you'd make ~600
requests for a 10k-word doc, which collides with the free tier's 1 rps / 1 concurrent limit
and multiplies per-request latency overhead. Why not the 20k-char streaming endpoint for
everything? It's a good option for *sustained* reading (fewer seams, timestamps already
absolute across the whole request), but it costs you granular caching and makes "user jumped
to paragraph 40" wasteful. **Recommendation: sentence-grouped ~1.5k-char chunks on the batch
endpoint.** It is the simplest thing that satisfies the cap, the concurrency limit, and
seek-anywhere.

### D.2 Gapless playback — and why you can mostly stop worrying

The textbook problem: **MP3 carries encoder delay and padding**, so concatenating two MP3s
produces an audible gap (~20–50 ms). "The popular MP3 format defines no way to record the
amount of delay or padding for later removal", per the
[Hydrogenaudio gapless article](https://wiki.hydrogenaudio.org/index.php?title=Gapless_playback).
WAV/PCM and Opus don't have this; AAC is better than MP3.

**But this is a speech app, not a music app, and that changes the verdict.** Two reasons the
gap is nearly a non-issue here:

1. Chunk boundaries are **sentence or paragraph boundaries**, where a pause is natural and
   expected. A 30 ms silence at a full stop is not a defect; it's punctuation.
2. Speechify's own output already has trailing silence — their docs explicitly warn that
   "the `end_time` of the last word does not necessarily correspond with the end of the audio
   chunk — there can be silence at the end". The seam is already padded.

So the recommendation is the **simple** one:

**Two `<audio>` elements, ping-ponged.** While A plays chunk N, B has chunk N+1's blob URL
already assigned and `preload="auto"`. On A's `ended`, call `B.play()`, swap roles, and kick
off synthesis of N+2 into A.

Three implementation details that will otherwise cost you a day each:

- **Unlock both elements inside the initial user gesture.** Safari's autoplay policy gates
  `.play()` on a user activation, and creating/playing a *fresh* element later can be
  blocked. During the click that starts playback, call `.play()` on *both* elements with a
  tiny silent source (then pause). Reusing two long-lived, already-unlocked elements avoids
  the whole class of bug. **INFERRED from well-known Safari behaviour — verify on device.**
- **Re-apply `playbackRate` and `preservesPitch` before every `.play()`.** These are
  per-element properties and a newly-loaded source resets nothing for you. This is the most
  likely place for "speed reverts to 1× at every paragraph" to sneak in.
- **Each chunk's timestamps are in its own timebase.** Because each chunk is its own media
  resource, `audio.currentTime` restarts at 0 — which is *exactly right*, since that chunk's
  speech marks also start at 0. **Do not build a global timeline.** It buys you nothing and
  adds an offset you can get wrong.

**If the seam ever does bother you**, in ascending order of effort:
1. Request `wav`/`pcm` instead of `mp3` (no encoder padding) — costs ~10× bandwidth.
2. Cross-fade 25–50 ms using two Web Audio gain nodes fed by `MediaElementSourceNode`
   (keeps `<audio>` as the clock, so §C still holds).
3. **MediaSource Extensions** — append chunks into one `SourceBuffer` for a single true
   timeline on one `<audio>` element. This is the "correct" answer and preserves everything
   in §C perfectly. VERIFIED support: full on Chrome/Firefox/Safari desktop; **iOS Safari
   only via `ManagedMediaSource` (iOS 17.1+, Nov 2023), which additionally requires
   `disableRemotePlayback = true` or the `sourceopen` event never fires.** That iOS caveat is
   why I'd skip MSE for v1.

### D.3 Prefetch without burning quota

Policy:

- **Lookahead of exactly 1 chunk**, raised to 2 when `playbackRate >= 1.75` (at 2× a
  ~90-second chunk is consumed in 45 s, so you need more runway). Free tier's concurrency
  limit of **1** means 1 is the ceiling there.
- **Trigger prefetch on a progress threshold, not on `ended`** — start synthesizing N+1 when
  N crosses ~60% of its duration. Cheap, and hides synthesis latency completely.
- **Never prefetch on hover, scroll, or document open.** Synthesis is only ever triggered by
  actual playback progress. Worst-case waste when the user stops reading is **1–2 chunks
  ≈ 3,600 chars ≈ $0.04**. That is the whole point of the lookahead discipline.
- **Cancel in flight.** Keep an `AbortController` per outstanding request and abort on
  pause/seek/navigate. Speechify bills per *request*, so an aborted-but-completed request
  still costs — abort early or not at all.
- **Cache by content hash**, `hash(chunkText + voiceId + model)`, so re-reading a document,
  seeking backwards, or toggling speed costs nothing.

**Where to cache — and a Folio-specific warning.** Audio must **not** go in localStorage. A
10k-word doc at 32 kbps mono MP3 is roughly **16 MB** (≈67 minutes × 4 KB/s); localStorage
gives you 5–10 MB total and Folio already ships a soft storage warning. Options:

- **In-memory `Map` of blob URLs, evicted LRU** — correct for v1, zero policy questions,
  survives seeking within a session. Revoke object URLs on eviction or you leak.
- **IndexedDB** for cross-session caching — the right long-term answer, *but* `CLAUDE.md`
  explicitly says not to introduce IndexedDB without discussing it first. **Flagging as a
  decision for you, not making it.**
- **Speech marks JSON is tiny** (~30 KB for a whole 10k-word doc) and *could* live in
  localStorage under a `folio_tts_marks_{docId}` key. Note this only helps if the audio is
  also cached — marks without audio are useless.

---

## E. Prior art

Summary up front: **the products that do this well all use provider-native timing metadata
against a scrubbable audio clock. The ones that use live TTS boundary *events* all fight
platform bugs.** That split is the single most useful pattern in this section, and it points
the same way §C does.

### E.1 Summary table

| Product | Granularity | Timing source | Survives speed change? | Chunking |
|---|---|---|---|---|
| **Speechify (API)** | Word, nested in sentence | Native speech marks (ms + char offsets) | Undocumented | 20k char cap on streaming; no auto-chunker |
| **Speechify (consumer app)** | Word | **Unknown — not public** | Unknown | Unknown |
| **MS Immersive Reader** | Word (secondary src) | **Unknown — closed-source hosted iframe** | Unknown; speed is 0.5–2.5 in fixed steps | **Host app must pre-chunk** (`chunks: Chunk[]`, 50 MB cap) |
| **MS Edge Read Aloud** | Word + sentence | **Text-offset boundary events** (`charIndex`/`charLength`) | No Edge-specific report | Per-text-node in comparable impls |
| **Apple Books Read Aloud** | **Author's choice** — word or sentence | Pre-authored **SMIL** `clipBegin`/`clipEnd` | N/A (pre-recorded, not TTS) | Pre-authored, **fixed-layout books only** |
| **Apple Digital Narration** | — | AI-narrated audiobook | **Not confirmed to have synced highlighting at all** | Reflowable, English-only |
| **Readwise Reader** | Word | Provider-native word boundaries (Unreal Speech EN, Azure fallback) | **They explicitly fixed pitch at ≠1.0× speeds** | **Section-by-section, on demand** |
| **Matter** | Word (secondary) | Not found | Not found | Not found |
| **Instapaper** | Sentence/phrase (unverified) | OS voices, then unnamed "AI Voices" | Not found | Not found |
| **Pocket** | **No evidence auto-follow highlighting ever existed** | Amazon Polly | N/A | N/A — **service fully dead** |

### E.2 The findings that actually change the design

**Readwise Reader is the closest analogue to Folio, and it validates the whole plan.**
VERIFIED from their [Dec 2023 Reader update](https://readwise.io/reader/update-dec2023):
they run **Unreal Speech for English with Azure as a non-English fallback**, their changelog
uses the literal phrase **"mistimed word boundaries"** (so the highlight rides on
provider-native word timing, not a heuristic), they load **section-by-section on demand**
for long documents — which is exactly §D's chunking model — and, most tellingly, they shipped
a fix that **"fixed the pitch of the voices when listening at slower and faster than 1.0x
speeds."** A production competitor hit the pitch problem and had to fix it explicitly. In our
architecture that fix is free: `preservesPitch` is already `true` by default (§C.2).

**Edge Read Aloud's word highlighting is why `charIndex`/`charLength` exist at all.**
VERIFIED primary source: a Nov 2016
[W3C `public-speech-api` post](https://lists.w3.org/Archives/Public/public-speech-api/2016Nov/0000.html)
in which Jerry Smith of Microsoft proposes adding a `length` field to the boundary event,
writing: *"Knowing the length in addition to boundary makes it very simple to highlight text
while it is being spoken."* That proposal became today's `charLength`. Good historical
context — and a reminder that the event-driven approach is the *older* one.

**The event-driven approach is demonstrably fragile, and this is well documented.**
- [codersblock](https://codersblock.com/blog/javascript-text-to-speech-and-its-many-quirks/):
  `boundary` doesn't fire on Android at all; **Safari never provides `charLength`**; macOS
  never fires `'sentence'`; Windows reports `charLength: 0` for sentence boundaries.
- MDN browser-compat ([issue #28419](https://github.com/mdn/browser-compat-data/issues/28419),
  Chromium bug 40715888): Chrome Android never fires `boundary`. MDN marks the feature
  **not Baseline**.
- The best root-cause artifact found anywhere in this research: an
  [Apple Developer Forums thread](https://developer.apple.com/forums/thread/654747) where an
  **Apple engineer confirms** that `AVSpeechSynthesizer`'s
  `willSpeakRangeOfSpeechString` callbacks fire in **bursty groups** — three words' callbacks
  landing inside a 10–20 ms window, then a 530 ms gap — rather than evenly spaced. Their
  suggested workaround was to bucket words by a time threshold rather than trust per-word
  callback timing. **This is the structural reason to prefer a timestamp map + media clock
  over live boundary events**: a map is queryable at any instant; events arrive when the
  engine feels like it.

**dbushell independently arrived at the same painting mechanism we recommend.** VERIFIED:
his Web Speech API demo uses the **CSS Custom Highlight API** with
`range.setStart($text, ev.charIndex); range.setEnd($text, ev.charIndex + ev.charLength)`,
and splits the document into **per-text-node utterances** specifically to keep the
charIndex→DOM mapping tractable. That's convergent evidence for §C.6, and for keeping a
flat-text↔DOM offset map (§C.7).

**One library switches timing strategy per backend — exactly the adapter shape §C.5
recommends.** `albirrkarim/react-speech-highlight-demo` (VERIFIED) uses `audio.currentTime`
for pre-rendered audio, native `boundary` events for browser TTS, and provider transcript
timestamps for API TTS — three sources behind one highlight abstraction, and it batches long
articles into multiple TTS requests.

**`am-lyrics` documents the exact rAF-vs-`timeupdate` choice** we make in §C.4 (VERIFIED):
it recommends `requestAnimationFrame`-polled `audio.currentTime` and calls plain `timeupdate`
"less precise… fires at browser-determined intervals."

**Commercial reader engines treat rate change as something you must actively propagate.**
[Colibrio's Reader Framework](https://colibrio.com) (VERIFIED from its API docs) requires TTS
implementations to expose a `setPlaybackRate()` hook that "will be called by the
`SyncMediaPlayer` when its `playbackRate` has been changed." The existence of dedicated
rate-change plumbing in a commercial engine is evidence the desync problem is real and
common. **Our architecture makes that hook unnecessary** — because `currentTime` is already
in media time, nothing downstream of a rate change needs to be told about it.
Readium's [kotlin-toolkit TTS guide](https://github.com/readium/kotlin-toolkit/blob/develop/docs/guides/tts.md)
(VERIFIED) keeps a coarse `utteranceLocator` plus a fine `tokenLocator` fed by the OS TTS
word-boundary callbacks, and warns that updating UI per token "can significantly reduce
performance", recommending throttling to ~1 s. It does **not** document rescaling on rate
change — it just trusts the OS callbacks.

**Apple Books uses the pre-authored path, which is a different problem.** VERIFIED from
[Apple's asset guide](https://help.apple.com/itc/booksassetguide/en.lproj/itcf373ff8f8.html):
*"Highlighting the words during read aloud can be as detailed or broad as the content-creator
defines it… For children's books, word-level granularity is preferred, though sentence-level
is also supported."* It's SMIL `<par>` pairing text fragment IDs to `<audio clipBegin
clipEnd>`, with the active style declared via `media:active-class`. Notably, **read-aloud is
supported only in fixed-layout books** — reflowable EPUBs can't use it. That constraint is
exactly why this approach is wrong for Folio: our text reflows.

**Forced alignment is the fallback if you ever need to sync to audio you didn't synthesize.**
[ReadAlongs Studio](https://github.com/ReadAlongs) runs **SoundSwallower** (a PocketSphinx
rewrite compiled to **WASM, client-side in-browser**) producing per-utterance word segments as
`{"b": start_sec, "d": duration_sec}`. [Aeneas](https://github.com/readbeyond/aeneas) instead
uses **DTW over MFCC features**, comparing real audio against TTS-synthesized audio of the
same text. Both are heavier than we need — we get exact timestamps from the synthesizer for
free — but worth knowing they exist and run in a browser.

### E.3 The honest negative result on the desync bug

I looked specifically for a public "I changed playback speed and my highlighting desynced"
bug report or postmortem. **No single canonical one was found.** What exists is
architectural: Colibrio's dedicated `setPlaybackRate()` hook, Apple's confirmed callback
burstiness, and **Amazon's patent US 9,478,219 B2** (audio synchronization for document
narration, resembling Whispersync for Voice — VERIFIED via Google Patents), which describes a
**static, pre-computed timing file** generated once at ingestion and **discloses no dynamic
playback-speed recalculation mechanism at all**.

So there is no *public* postmortem of this failure mode. **But there is an in-house one**, and
it is better evidence than anything public would have been:
[`superwhisper-tts-postmortem.md`](./superwhisper-tts-postmortem.md) traces the previous
attempt's desync to a wall-clock estimator running in a different process from the audio
element, Web Audio resampling, and a compounding word-index mismatch — all with `file:line`
citations. §C.1 is updated accordingly. The public silence on this bug is best read as
"everyone hits it privately," not "it doesn't happen."

(Caveat on method: Stack Overflow was not reachable by the research tooling in this
environment, so "not found publicly" is weaker here than it would otherwise be.)

### E.4 What could not be determined

Flagging these as genuine gaps rather than glossing them:
- **No confirmed link between Speechify's public speech-marks API and its own consumer
  app/extension internals.** Plausible, unproven. No reverse-engineering writeup found.
- **Immersive Reader's highlight timing is unknowable from outside** — the SDK is a thin
  launcher and the real UI runs in a closed-source Microsoft-hosted iframe.
- **Apple "Digital Narration" — not confirmed to produce synced highlighting at all**, in
  either direction, by any Apple source.
- **Matter's TTS vendor was not identified anywhere**, including founder interviews.
- **Instapaper's highlight granularity has no primary source** (the one candidate returned 403).
- **Pocket never demonstrably had auto-follow highlighting** — the "highlighting" in 2017–18
  press was manual long-press annotation. The service is fully dead (offline July 2025, data
  deleted Nov 2025), so it's moot. (Not to be confused with *Pocket Casts*, a different Mozilla
  product, which shipped sentence-level highlighted transcripts in June 2026.)

---

## Rejected approaches and why

| Approach | Why rejected |
|---|---|
| **Server-side proxy for Speechify** | Unnecessary. Measured CORS shows direct browser calls work with a Bearer token (§A.5). A proxy would also break the "no backend" constraint and put you in the path of the user's key. |
| **SSML `<prosody rate>` for the speed slider** | Server-side. Every speed change = new request, new cost, new latency, *different* speech marks, and a re-seek. Use `playbackRate` (§A.6). |
| **Web Audio `AudioBufferSourceNode` for playback** | Resamples → pitch-shifts (§C.3). No `preservesPitch` equivalent exists. Also forces you onto `AudioContext.currentTime`, which is not a media timeline, so you'd hand-divide by rate and drift. |
| **`timeupdate` to drive the highlight** | Spec floor is **4 Hz** and the rate is explicitly non-deterministic (§C.4). Skips words even at 1×. |
| **WebVTT `cuechange` for word-level highlight** | Spec explicitly permits skipping short cues when the UA catches up. Word cues are 65–100 ms at 2–3× (§C.4). Acceptable for *sentence* cues; unsafe for words. |
| **Scaling timestamps by playback rate** | The bug, not the fix. `currentTime` is already in media time (§C.1). Any `* rate` reintroduces drift on pause/seek/stall. |
| **Wrapping each word in a `<span>`** | Destroys Folio's existing highlight/comment DOM anchoring, thrashes layout at ~5 Hz. Use the CSS Custom Highlight API (§C.6). |
| **OpenAI TTS** | No timestamps of any kind. Cannot do word highlighting, full stop (§B). |
| **Deepgram Aura** | No documented word timestamps for TTS output. Would require running generated audio back through STT for forced alignment — extra cost, extra latency, extra failure mode. |
| **Browser `speechSynthesis` as the engine** | **`utterance.rate` cannot be changed mid-utterance** — every speed change is a `cancel()` + `speak()` restart with an audible artifact. There is no media element and no scrubbable timeline. Plus the unresolved Chrome ~15 s cutoff and broken Android `boundary` events (§B.3). Keep only as a $0 degraded tier. |
| **Azure Speech — NOT rejected** | Listed here to correct my own initial assumption. I expected the SDK's auto-playback to disqualify it; it doesn't — **omitting `AudioConfig` gives you raw `audioData` while `wordBoundary` still fires**, so §C applies unchanged. It loses on cost (2–3×) and a ~1 MB dependency, but wins on free tier (10×) and chunk size. **This is the fallback to pick if Speechify's free tier is too tight** (§B.2). |
| **ElevenLabs as primary** | Works and is CORS-open, but 5–16× the cost for the same capability. Keep as the documented drop-in fallback adapter (§B.1). |
| **Unreal Speech as primary** | Genuinely competitive per-character (~$8–12/1M) and it's what Readwise ships, but its cheapest paid plan is $49/mo vs Speechify's $10 (§B.1b). |
| **EPUB Media Overlays / SMIL** | Real standard, right problem, wrong lifecycle — an XML *authoring* format for pre-narrated books. No browser implements it. Speech marks JSON is strictly lighter and carries char offsets SMIL doesn't (§C.5). |
| **W3C SyncMediaLite** | Community Group Note that says "nothing official yet". Not implemented anywhere (§C.5). |
| **MSE for v1 chunk stitching** | Correct but heavy, and iOS Safari needs `ManagedMediaSource` + `disableRemotePlayback`. Ping-ponged `<audio>` elements are enough because seams land on sentence boundaries (§D.2). |
| **Caching audio in localStorage** | ~16 MB per 10k-word doc vs a 5–10 MB budget Folio is already straining (§D.3). |
| **Existing read-along libraries** | All are "array + media clock", several use `timeupdate`, none handles chunked streaming TTS or a 2,000-char cap. ~40 lines to write correctly (§C.5). |

---

## Open questions / things to verify empirically

These are the things I could **not** settle from documentation. Most need the real API key
or a device.

1. **Actual time-to-first-audio** for `/v1/audio/speech` on a ~1,500-char chunk from *your*
   location. **Partially answered by prior in-house measurement, and the answer is not
   flattering to the marketing:** Speechify advertises "sub-100 ms" TTFB, but the user's own
   production agent **measured 831 ms median with a 431 ms spread** — from India
   ([`speechify-simba-findings.md`](./speechify-simba-findings.md)). No US-vantage measurement
   exists. **Implication for the design: ~800 ms is too slow to feel instant on the very first
   play.** Mitigations, in order of preference: (a) **pre-synthesize chunk 1 as soon as the
   reader view opens**, before the user presses play — it's ~1,800 chars ≈ $0.02 and it makes
   the first press feel instant; (b) use the streaming endpoint for chunk 1 only, so audio
   starts on the first SSE frame; (c) make the first chunk deliberately short (one or two
   sentences) so it synthesizes fast, then return to full-size chunks.
2. **Whether `speech_marks.type` is reliably `"word"`** on the batch endpoint. The OpenAPI
   stub shows a generic `"type": "string"`; the streaming example shows `"type":"word"`.
   Log one real response and confirm before relying on it.
3. **Whether batch speech marks ever nest deeper than two levels.** The published TypeScript
   type says no; the OpenAPI schema shows `chunks: [{}]`, which is uninformative.
4. **Voice IDs and which voices sound right.** `GET /v1/voices` needs a real key. `geffen_32`
   appears in the docs' examples.
5. **Safari's `preservesPitch` audio quality at 2×+.** Chromium's WSOLA behaviour is
   documented; Safari's is not, and there are older complaints about Safari sounding worse
   when sped up. Affects the web build only (Electron is Chromium). **Test by ear.**
6. **Safari autoplay behaviour when swapping between two `<audio>` elements** mid-playback —
   confirm the "unlock both during the initial gesture" trick actually holds across a chunk
   transition on iOS.
7. **`Intl.Segmenter` sentence splitting *quality*** against real Folio documents. Its
   availability and API are VERIFIED (Baseline Apr 2024, returns char `index`); what's
   unverified is how it behaves on your actual content — abbreviations, inline code, list
   items, headings, markdown artifacts. Editor.js block structure may be a better *primary*
   segmentation signal, with `Intl.Segmenter` used only to subdivide long blocks.
8. **How to handle non-prose blocks** — code blocks, tables, images. Skip them? Read alt text?
   This is a product decision that affects the character-offset map, since skipped text still
   occupies offsets in the flat text.
9. **Perceptibility of the MP3 seam** at a mid-paragraph chunk boundary at 1× and 2×. If it's
   audible, the escalation path is in §D.2.
10. **Whether the 2,000-char cap counts characters or bytes** for non-ASCII input. Docs say
    "characters, including SSML tags"; unverified for multi-byte text.
11. **Azure's exact per-character pricing.** Their pricing page renders dollar amounts via
    client-side JS; the ~$16/~$22 figures come from third-party aggregators. The **500k/mo
    free tier is verified** from the page's own text. Confirm at the Azure calculator before
    treating Azure as the cost-saving fallback.
12. **Whether Speechify's real-world voice quality and latency beat Unreal Speech**, which
    Readwise chose for exactly this use case at a comparable per-character price. Worth a
    side-by-side listen if you're ever unhappy with the Speechify voice.

**Not investigated at all** (out of scope, flagging honestly):
- Rate-limit/429 retry behaviour under real load; whether `Retry-After` is always present.
- Anything about mobile Safari playback of blob-URL audio in a backgrounded tab / lock screen,
  or Media Session API integration (lock-screen controls, which a read-aloud feature arguably
  wants).
- Accessibility: how the moving highlight interacts with VoiceOver/screen readers. A
  screen-reader user almost certainly should not get both at once — needs a product decision.
- Whether any of this works inside Folio's Electron panel at 400px width, or how it should
  behave when the panel collapses to the 8px edge tab.

---

## Sources

**Speechify**
- Speech marks reference — https://docs.speechify.ai/tts/text-to-speech/features/speech-marks
- Create Speech (batch) — https://docs.speechify.ai/build/api-reference/v1/audio/speech
- Stream with timestamps — https://docs.speechify.ai/build/api-reference/v1/audio/stream/with-timestamps.md
- SSML / prosody rate — https://docs.speechify.ai/tts/text-to-speech/features/ssml
- API limits (2,000-char cap, rate/concurrency) — https://docs.speechify.ai/docs/get-started/api-limits
- Access tokens — https://docs.sws.speechify.com/v1/api-reference/api-reference/tts/auth/create-access-token
- Pricing — https://speechify.ai/pricing
- CORS + endpoint liveness — measured directly with `curl`, 2026-08-16 (see §A.5)

**Specs**
- WHATWG HTML, media elements (media timeline, currentTime, playbackRate, preservesPitch, timeupdate cadence, cue accuracy) — https://html.spec.whatwg.org/multipage/media.html#playing-the-media-resource
- EPUB 3.3 Media Overlays — https://www.w3.org/TR/epub-33/#sec-media-overlays
- W3C SyncMediaLite (CG Note) — https://w3c.github.io/sync-media-pub/sync-media-lite
- WebVTT — https://www.w3.org/TR/webvtt1/

**MDN**
- `HTMLMediaElement.playbackRate` — https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate
- `HTMLMediaElement.preservesPitch` — https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch
- `HTMLMediaElement.currentTime` — https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime
- `timeupdate` event — https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/timeupdate_event
- `AudioBufferSourceNode.playbackRate` — https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/playbackRate
- CSS Custom Highlight API — https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
- `Intl.Segmenter` — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter
- `TextTrack: cuechange` — https://developer.mozilla.org/en-US/docs/Web/API/TextTrack/cuechange_event
- `ManagedMediaSource` — https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource

**Other providers**
- ElevenLabs with-timestamps — https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
- ElevenLabs API pricing — https://elevenlabs.io/pricing/api
- OpenAI TTS guide — https://developers.openai.com/api/docs/guides/text-to-speech
- Cartesia TTS WebSocket (`add_timestamps`) — https://docs.cartesia.ai/api-reference/tts/websocket
- Deepgram TTS docs — https://developers.deepgram.com/docs/tts-rest
- Unreal Speech pricing — https://app.unrealspeech.com/pricing

**Azure AI Speech**
- Browser SDK setup (CDN bundle) — https://learn.microsoft.com/en-us/azure/ai-services/speech-service/quickstarts/setup-platform
- `SpeechSynthesisWordBoundaryEventArgs` — https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesiswordboundaryeventargs?view=azure-node-latest
- `SpeechSynthesisBoundaryType` — https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesisboundarytype?view=azure-node-latest
- `AudioConfig` — https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/audioconfig?view=azure-node-latest
- `SpeakerAudioDestination` source (`internalAudio`) — https://github.com/microsoft/cognitive-services-speech-sdk-js/blob/master/src/sdk/Audio/SpeakerAudioDestination.ts
- Quotas and limits (64 KB text / 10 min audio) — https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
- JS SDK lacks `SpeechSynthesisRequest` streaming input — https://github.com/microsoft/cognitive-services-speech-sdk-js/issues/850

**Web Speech API**
- `SpeechSynthesisUtterance.rate` — https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/rate
- `SpeechSynthesisUtterance.text` (32,767 char cap) — https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/text
- Utterances are not reusable (Bugzilla 1523920) — https://bugzilla.mozilla.org/show_bug.cgi?id=1523920
- Chrome ~15-second cutoff (crbug 679437) — https://bugs.chromium.org/p/chromium/issues/detail?id=679437
- Disputed MDN "Chrome partial support" flag for `boundary` — https://github.com/mdn/browser-compat-data/issues/28419
- dbushell, "Text to Speech Synthesis" (July 2025) — https://dbushell.com/2025/07/26/text-to-speech-synthesis/
- Safari `charIndex` bug with Spanish spacing — https://developer.apple.com/forums/thread/712667

**Playback / audio engineering**
- Chromium WSOLA + resampling threshold — https://issues.chromium.org/issues/41263293
- Firefox mute range 0.25–4.0 — https://bugzilla.mozilla.org/show_bug.cgi?id=1630569
- MP3 encoder delay/padding — https://wiki.hydrogenaudio.org/index.php?title=Gapless_playback
- MSE seamless playback — https://web.dev/articles/mse-seamless-playback
- ManagedMediaSource on iOS 17.1 — https://webkit.org/blog/14735/webkit-features-in-safari-17-1/
- Chrome background tab throttling — https://developer.chrome.com/blog/background_tabs

**Read-along prior art**
- Readwise Reader update, Dec 2023 (Unreal Speech + Azure, "mistimed word boundaries", pitch fix) — https://readwise.io/reader/update-dec2023
- Readwise Reader TTS FAQ (section-by-section loading) — https://docs.readwise.io/reader/docs/faqs/text-to-speech
- Jerry Smith (Microsoft) proposing `length` on the boundary event, W3C, Nov 2016 — https://lists.w3.org/Archives/Public/public-speech-api/2016Nov/0000.html
- Apple engineer confirming bursty `willSpeakRangeOfSpeechString` callbacks — https://developer.apple.com/forums/thread/654747
- Web Speech API cross-browser quirks catalogue — https://codersblock.com/blog/javascript-text-to-speech-and-its-many-quirks/
- Chrome Android never fires `boundary` (compat data) — https://github.com/mdn/browser-compat-data/issues/28419
- Immersive Reader SDK reference (`chunks`, `speed` 0.5–2.5) — https://learn.microsoft.com/en-us/azure/ai-services/immersive-reader/reference
- Apple Books read-aloud / Media Overlays authoring guide — https://help.apple.com/itc/booksassetguide/en.lproj/itcf373ff8f8.html
- Apple Books: read-aloud is fixed-layout only — https://help.apple.com/itc/booksassetguide/en.lproj/itc6db639756.html
- Readium kotlin-toolkit TTS guide (utteranceLocator / tokenLocator) — https://github.com/readium/kotlin-toolkit/blob/develop/docs/guides/tts.md
- ReadAlongs Studio / SoundSwallower (WASM forced alignment) — https://github.com/ReadAlongs
- Aeneas (DTW/MFCC forced alignment) — https://github.com/readbeyond/aeneas
- html5-audio-read-along — https://github.com/westonruter/html5-audio-read-along
- Spoken Word (read-along TTS) — https://weston.ruter.net/2018/02/21/spoken-word-read-along-tts/
- AudioSync — https://j.hn/html5-audio-karoke-a-javascript-audio-text-aligner/
- MediaSync — https://github.com/fabiosoggia/MediaSync
- react-speech-highlight (per-backend timing strategy) — https://github.com/albirrkarim/react-speech-highlight-demo
- CSS Custom Highlight API caniuse/interop — https://github.com/web-platform-tests/interop/issues/1149
- Unreal Speech pricing — https://app.unrealspeech.com/pricing

# Speechify Simba — Findings from prior rabbitwhole research

_Extracted from the user's own earlier research. Source file:line for each claim._

**Source repo:** `/Users/rishabhchopra/Documents/GitHub/rabbitwhole`
**Extraction date:** 2026-08-16. **Underlying research dates:** July 2026 (streaming verdict, landscape, production agent measurements) and August 2026 (listeninterrupt architecture + phase-1 reader).

Citations below are `path:line` **relative to the rabbitwhole repo root** unless the path starts with `folio/`. Four source docs were copied into this repo:

| Copied to `folio/techDocs/` | Original |
|---|---|
| `reference-listeninterrupt-architecture.md` | `listeninterrupt/ARCHITECTURE.md` |
| `reference-phase-1-reader.md` | `listeninterrupt/techDocs/phase-1-reader.md` |
| `reference-speechify-streaming-verdict.md` | `techDocs/speechify-streaming-verdict.md` |
| `reference-speechify-simba-stack-feasibility.md` | `techDocs/simba-stack-feasibility.md` |

**Confidence labels used throughout:** **DOC-CONFIRMED** = read from live Speechify docs. **MEASURED** = a number produced by the user's own running code. **INFERRED** = reasoned, not observed. **UNKNOWN** = the prior research explicitly failed to determine it.

---

## TL;DR

- **Word-level timestamps exist and are exactly what a word-highlighting reader needs.** Every mark carries `start_time`/`end_time` in **milliseconds** *and* `start`/`end` **indices into the exact string you sent**, nested word-inside-sentence (`ARCHITECTURE.md:164-169`, `phase-1-reader.md:126-133`). Both time-level and text-level anchoring, in one payload.
- **Two endpoints.** Batch `POST /v1/audio/speech` (all models, one JSON blob) and streaming `POST /v1/audio/stream/with-timestamps` (SSE, **simba-3.0/3.2 only** — legacy voices return `400 speech_marks_unsupported`) (`ARCHITECTURE.md:170-172`, `.claude/chat-archive/chat-history.md:25921`).
- **Field names differ between the two endpoints** and this is the #1 parser trap: streaming audio field is `audio`, batch is `audio_data` (`phase-1-reader.md:119`, `:576`).
- **Rewind is free.** Speechify bills per character *sent*, so replaying cached audio costs $0. The only re-charge risk is cache eviction (`ARCHITECTURE.md:174-177`).
- **Cost ~$0.27–0.55 per listening-hour** at $10/1M chars (`ARCHITECTURE.md:207`, `simba-stack-feasibility.md:171`).
- **Latency: the marketing is wrong by ~8x.** Speechify markets "sub-100ms" / "lowest TTFB"; the user's own production agent **measured 831 ms median TTFB with a 431 ms spread** from India (`phase2-agent/agent.py:147`, `speechify-streaming-verdict.md:342`). No measurement from a US vantage point exists.
- **⚠️ VARIABLE PLAYBACK SPEED IS COMPLETELY UNADDRESSED.** I searched the entire repo. There is **no** finding, no design note, and no test about changing playback speed and keeping word highlighting synced. Speechify's request body has **no `speed` parameter** anywhere in the research corpus. See the dedicated section below — it is the biggest gap for your use case, but the prior architecture happens to make it easy anyway, and I explain why.
- **One unresolved internal contradiction:** the same architecture doc says char indices are **characters** in §2 and **UTF-8 bytes** in §6. Never resolved. Flagged as a must-verify.

---

## API surface (endpoints, auth, request/response shapes)

### Hosts

Two hosts exist and **both resolve to the same IP** (`34.49.245.64`, Google global anycast) — so there is no geographic reason to prefer either (`speechify-streaming-verdict.md:364-366`, `:791`):

- `https://api.speechify.ai` — the **documented** host. Use this.
- `https://api.sws.speechify.com` — legacy; what the `livekit-plugins-speechify` package hardcodes (`speechify-streaming-verdict.md:318`).

### Auth

`Authorization: Bearer <SPEECHIFY_API_KEY>` — plain bearer token, key from `platform.speechify.ai` (`phase-1-reader.md:80`, `speechify-streaming-verdict.md:592`).

### The full endpoint list

As of the July 2026 OpenAPI 3.1 spec (`docs.speechify.ai/openapi/api-reference.json`), exactly 6 paths / 8 operations (`speechify-streaming-verdict.md:104-111`):

```
POST   /v1/audio/speech
POST   /v1/audio/stream
GET    /v1/voices          POST /v1/voices
GET    /v1/voices/{id}     DELETE /v1/voices/{id}
GET    /v1/voices/{id}/sample
GET    /v1/audio/models
```

**Note the discrepancy:** `/v1/audio/stream/with-timestamps` is **absent from that July list** but is DOC-CONFIRMED against live docs in August 2026 (`phase-1-reader.md:79`, `:611`). Either it postdates the spec snapshot or the spec was incomplete. Treat the endpoint as real but **verify it responds before building on it**.

Probing established that only `/v1/audio`, `/v1/voices`, `/v1/agents` are registered prefixes; `/v1/tts`, `/v1/ws`, `/v1/websocket`, `/v1/realtime`, `/v1/stream`, `/v1/text-to-speech` all 404 (`speechify-streaming-verdict.md:708-711`).

### The three synthesis endpoints compared

| Endpoint | Delivery | Marks? | Audio formats | Model support |
|---|---|---|---|---|
| `POST /v1/audio/speech` (batch) | one JSON response after full synthesis | ✅ `speech_marks`, nested object | mp3/wav/ogg/aac/pcm | **all models** |
| `POST /v1/audio/stream` | raw HTTP-chunked audio **bytes**, not SSE | ❌ none | mp3/wav/ogg/aac/pcm | all models |
| `POST /v1/audio/stream/with-timestamps` | **SSE** | ✅ `speech_marks`, flat arrays across chunks | **PCM only** | **simba-3.0 / simba-3.2 only** |

(`chat-history.md:25919-25921`, `phase-1-reader.md:99`, `:136`, `speechify-streaming-verdict.md:176-184`)

### Request body — DOC-CONFIRMED, verbatim (`phase-1-reader.md:86-94`)

```jsonc
{
  "input": "<the paragraph, EXACT plain text — no SSML>",
  "voice_id": "geffen_32",              // simba-3.2 voice allow-list
  "model": "simba-3.2",                 // DEFAULT IS simba-3.0; set 3.2 explicitly
  "output_format": "pcm_24000",         // streaming accepts pcm_8000..pcm_48000 (PCM-only)
  "language": "en-US",                  // ISO 639-1 + region
  "options": { "text_normalization": true }  // NESTED. Streaming default is FALSE
}
```

Required fields are **`input` and `voice_id`** only (`speechify-streaming-verdict.md:115-116`).

**Constraints:**
- `input` is one complete string per request — **there is no streaming-text-IN** (see Streaming section).
- **~20,000 character limit per streaming request** (`phase-1-reader.md:100`).
- **`text_normalization` is nested under `options` and its default differs by endpoint**: `true` in batch, **`false` in streaming** (`phase-1-reader.md:9`, `:573`). Set it explicitly.

### Billing telemetry on the response

- Batch `/v1/audio/speech` returns `billable_characters_count` as a **documented** top-level JSON field (`verified-cost-sources.md:204`).
- `/v1/audio/stream` returns the same value as an **UNDOCUMENTED response header** `x-speechify-billable-characters-count`. This was **verified live** — a test call returned `44` (`verified-cost-sources.md:196-205`). It works but Speechify can remove it without notice.
- The streaming-with-timestamps endpoint returns it in the terminal `speech.done` event (below).
- There is **no** account/balance/usage API. `/v1/usage`, `/v1/account`, `/v1/credits`, `/v1/billing`, `/v1/quota`, `/v1/balance` all 404. Dollar balance is dashboard-only (`verified-cost-sources.md:212`).

---

## Speech marks / word timestamps — exact payload shape

**This is word-level AND character-level, in a two-level nest.** It is not either/or.

### The structure — quoted verbatim from the Speechify speech-marks feature page (`chat-history.md:25871-25896`)

```ts
// NestedChunk (word-level)
{
  start_time: number   // milliseconds from audio start
  end_time: number     // milliseconds from audio start
  start: number        // character index in original text
  end: number          // character index in original text
  value: string        // text content
}

// SpeechMarks (sentence/paragraph-level parent)
{
  start: number
  end: number
  start_time: number
  end_time: number
  value: string
  chunks: NestedChunk[]   // the word-level marks
}
```

### A real example — verbatim from the docs (`chat-history.md:25899-25907`)

```ts
{
  start: 0, end: 27, start_time: 0, end_time: 1850,
  value: 'Hello, welcome to Speechify',
  chunks: [
    { start: 0, end: 6,  start_time: 125, end_time: 375, value: 'Hello,' },
    { start: 7, end: 14, start_time: 375, end_time: 750, value: 'welcome' }
  ]
}
```

Note in this example: the sentence parent starts at `start_time: 0` but the **first word starts at 125 ms** — that is the leading-silence gotcha, live in the docs' own example.

### Units and semantics

| Question | Answer | Source |
|---|---|---|
| Time units | **Milliseconds.** Feature page says ms; the batch endpoint schema renders them as `double`. Treat as **ms, floating point** | `chat-history.md:25911` |
| Time origin | **Absolute ms from the start of the synthesis** — not relative to the chunk they arrive in | `ARCHITECTURE.md:204`, `phase-1-reader.md:121` |
| `start`/`end` units | **Index into the text you sent.** Per-word char ranges, not per-character timing | `chat-history.md:25912` |
| Granularity | **word** (in `chunks`) and **sentence/paragraph** (parent). **No phoneme-level marks documented** | `chat-history.md:25914` |
| A `type` field | Exists on the **batch** response (e.g. word/sentence). **Exact enum values UNKNOWN** — not enumerated in docs | `chat-history.md:25914`, `phase-1-reader.md:136` |
| Streaming vs batch nesting | Batch returns one nested object. **Streaming delivers flat arrays across chunks — but whether words arrive flat or nested is UNKNOWN.** Prior research's parser flattens defensively | `phase-1-reader.md:136`, `:603` |

### ⚠️ The unresolved bytes-vs-characters contradiction

**The same architecture document contradicts itself**, and the contradiction was never resolved:

- `ARCHITECTURE.md:164` — *"character start/end indices into your input text"*
- `ARCHITECTURE.md:392` — *"speech-mark offsets are **UTF-8 BYTES, not chars** — any emoji/curly-quote/em-dash desyncs; index paragraphs in bytes"*

The downstream docs split along the same line: `phase-1-reader.md` treats them as characters throughout, while `listeninterrupt/techDocs/phase-3-intelligence.md:141` and `:435` treat them as bytes and build the note-anchoring math on byte offsets.

`phase-1-reader.md:601` correctly demotes this to an explicit open question:

> *"**byte-vs-char:** are `start`/`end` UTF-16 code units, Unicode scalars, or bytes? (test with "café — 5€")"* — **status: UNKNOWN**

**Implication for a word-highlighting reader:** ASCII-only text is unaffected (all three encodings agree). The moment the document contains an em-dash, curly quote, emoji, or accented character, highlighting will drift by a few characters per occurrence and progressively desync. **Test with a non-ASCII string on day one.**

---

## Streaming

### There is no streaming text IN — this is closed with high confidence

The prior research spent an entire document on this and established it four independent ways (`speechify-streaming-verdict.md:96-171`):

1. **OpenAPI schema** — `GetStreamRequest` has `required: ["input", "voice_id"]` with `input` a plain `string`. One complete string per request.
2. **No continuation primitives exist.** Grep counts across the entire TTS spec: `context_id 0, continue 0, flush 0, append 0, partial 0, sequence 0, stream_input 0, incremental 0` (`:128-130`). There is no field with which to say "more text is coming."
3. **The official SDK ships no WebSocket code.** `speechify-api` 3.0.1 declares `httpx, pydantic, aiohttp` and no `websockets`; grep for `websocket|wss://|ws_connect` returns zero. By contrast `cartesia` 3.3.0 declares `websockets<16,>=13` (`:136-140`).
4. **The full 37-page docs corpus greps clean** for `websocket|SSE|bidirectional|duplex|incremental|flush|context_id` — one hit, and it is LiveKit's own signalling URL (`:153-165`).

Speechify's changelog (2026-06-23) says so explicitly: *"The response body is the **raw audio bytes** delivered over HTTP chunked transfer encoding... No API behaviour changed."* (`:176-181`).

**Vocabulary trap worth internalising** (`speechify-streaming-verdict.md:186-190`): Speechify calls simba-3.2 *"the streaming-native model with lower TTFB."* That means **streaming audio OUT**, always. It never means streaming text in. *"The disambiguation comes from the request schema, never from the vocabulary."*

**For a document reader this does not matter at all** — you have the full text up front. It only bites conversational agents feeding LLM tokens.

### The SSE contract — DOC-CONFIRMED (`phase-1-reader.md:105-121`)

```
event: speech.chunk
data: {"audio":"SUQzBAAAAAAA...","speech_marks":[ ... ]}

event: speech.chunk
data: {"speech_marks":[ ... ]}          ← a chunk may carry marks-only …

event: speech.chunk
data: {"audio":"//uQx..."}              ← … or audio-only

event: speech.done
data: {"billable_characters_count":40,"audio_duration_ms":4350}
```

- Three event types: `speech.chunk`, `speech.done`, and `speech.error` (`chat-history.md:25923`).
- **No `[DONE]` sentinel.** `speech.done` is terminal (`phase-1-reader.md:120`).
- **Field name split — the trap:** streaming audio field is **`audio`**; the **batch** field is **`audio_data`**. Do not copy a batch parser (`phase-1-reader.md:119`, `:576`).
- **Assembly rule, verbatim from the docs** (`chat-history.md:25925`): *"Speech-mark times are absolute milliseconds from the start of the synthesis, so concatenate the audio chunks into one stream and apply the marks against that single timeline."* … *"Which chunk a mark arrives on is a delivery detail and carries no meaning."*

### Audio formats

- **Streaming-with-timestamps is PCM-only**: `pcm_8000, pcm_16000, pcm_22050, pcm_24000, pcm_44100, pcm_48000` (`phase-1-reader.md:99`).
- **PCM byte layout is NOT documented.** The prior research *assumes* 16-bit signed little-endian mono → 48000 bytes/s at 24 kHz, and flags it as **UNKNOWN, verify** (`phase-1-reader.md:101`, `:599`).
- Batch/plain-stream additionally support `mp3_24000`, `wav_48000`, `ogg_24000`, `aac_24000`.
- **A verbatim docs guarantee worth noting:** *"Times stay correct for every output_format: changing the codec or sample rate does not change the duration"* (`chat-history.md:25925`). Marks are codec-invariant.
- **⚠️ `wav_48000` is broken.** *"the API returns MP3 bytes regardless and LiveKit's WAV decoder crashes on the ID3 header"* (`phase2-agent/agent.py:164-166`). MEASURED in production.

### Rate limits (per **account**, not per key) — `speechify-streaming-verdict.md:450-455`

| Plan | Simultaneous requests | Rate |
|---|---|---|
| Free | **1** | 1 rps |
| Paid | 15 | 20 rps |

On the free plan, **any parallel prefetch is impossible** — this directly constrains the "prefetch 2–3 paragraphs ahead" strategy.

---

## Models & voices

- **`simba-3.2`** — the current model. **The API default is `simba-3.0`, so you must set it explicitly** (`phase-1-reader.md:89`).
- **`simba-3.0`** — also supports streaming marks.
- **`simba-english`, `simba-multilingual`** — legacy. On `/with-timestamps` they return **`400 speech_marks_unsupported`** — verbatim error string, with the docs' own remedy: *"use POST /v1/audio/speech for a non-streamed response with marks on any model"* (`chat-history.md:25921`).

### Voice IDs known to work

Simba-3.2 voices carry a **`_32` suffix** (`ARCHITECTURE.md:172`, `chat-history.md:25917`):

| Voice ID | Status |
|---|---|
| `geffen_32` | **Used in production** by the user's LiveKit agent (`phase2-agent/agent.py:163`) and the head-to-head harness (`compare_tts_headtohead.py:197`) |
| `harper_32` | Used in the head-to-head harness (`compare_tts_headtohead.py:199`) |
| `dominic_32` | Named in docs (`chat-history.md:25917`) — not tested by the user |

**The scarcity finding, MEASURED** (`phase2-agent/agent.py:160-161`):

> *"Speechify: only 8 of their 949 voices support simba-3.2, and just 4 are female. `geffen_32` and `harper_32` are the two US-English ones."*

Cloned voices can also be enabled for simba-3.2 (`chat-history.md:25917`), but Speechify's **Agents** curated catalogue explicitly **excludes cloned voices** (`speechify-streaming-verdict.md:578-580`).

Caveat: `phase-1-reader.md:600` still lists "`geffen_32` is on the simba-3.2 voice allow-list" as UNVERIFIED for the *streaming-with-timestamps* endpoint specifically. It is proven on the plain `/audio/stream` path by the running agent; it has never been exercised against `/with-timestamps`.

---

## Cost

### Published tiers (`simba-stack-feasibility.md:168-173`)

| Tier | Monthly fee | Included | Overage |
|---|---|---|---|
| Free | $0 | 50K chars, **hard cap (usage pauses)** | — |
| **Starter** | **$10/mo** | **1M chars** | **$10/1M** |
| Pro | $99/mo | 3M chars | $8/1M |
| Scale | $499/mo | 10M chars | $6/1M |

**These are subscriptions with allowances, not flat per-character rates — the doc calls this "a trap worth naming"** (`:165-166`).

**Starter is the right tier and stays right for a long time** (`:175-178`): its included allowance is priced identically to its overage, so it behaves as flat $10/1M pay-as-you-go with a $10/month floor. *"Pro and Scale are strictly worse until roughly 37.5M and 182M chars/month respectively."*

Below ~1M chars/month the $10 floor dominates and your effective rate is worse than $10/1M (`:181-182`).

### Per listening-hour

- **~45,000–55,000 billable characters per hour** at natural ~150 wpm, spaces excluded → **~$0.27–$0.55 per listening-hour** (`ARCHITECTURE.md:207`, `chat-history.md:26062`).
- **Rewind adds $0** — replaying cached audio makes no API call. The only way to re-incur cost is evict + re-synthesize, which the persistent disk cache prevents (`ARCHITECTURE.md:174-177`).
- **Speed scales cost linearly.** *"Chars/hour depends on the user's playback speed (I used ~50k/hr at ~150 wpm; 2–3× listeners roughly double TTS cost)"* (`chat-history.md:25697`). ⚠️ **This is arguably wrong for your architecture** — see the playback-speed section; if you speed up *client-side playback of cached audio*, you synthesize the same characters and cost does **not** change.

### Versus alternatives at the same volume (`simba-stack-feasibility.md:187-190`)

```
Speechify Simba 3.2  (Starter)          $10/1M
Inworld TTS 2        (LiveKit gateway)  $25/1M
Cartesia Sonic 3.5   (LiveKit gateway)  $50/1M
ElevenLabs Flash 2.5 (gateway)         $150/1M   (ElevenLabs direct is $50/1M — gateway charges 3x)
```

Speechify is **5–8× cheaper than Cartesia and ~15× cheaper than ElevenLabs-via-gateway**, and independently scores **Elo 1232, rank #2** on the TTS quality leaderboard the user compiled (`tts-landscape-2026.md:366`, `:462`). The landscape doc calls this *"an extraordinary quality-per-dollar claim"* but flags it *"Interesting, not yet trustworthy"* on the grounds that Speechify's own "Voice Arena" PR claim is **UNVERIFIED — that leaderboard renders empty** (`:462-466`).

---

## Latency

### MEASURED (the user's own code, real calls)

| Number | Conditions | Source |
|---|---|---|
| **831 ms median TTFB, 431 ms spread** over 5 runs | simba-3.2, `mp3_24000`, India → Speechify, via LiveKit plugin | `phase2-agent/agent.py:147`, `speechify-streaming-verdict.md:342` |
| **890–1317 ms** | raw curl, bypassing LiveKit entirely | `speechify-streaming-verdict.md:343` |
| **1127 / 1129 / 1247 ms** | three production calls from India | `first-audio-delay-diagnosis.md:101` |
| `mp3_24000` = **831 ms** | fastest of the working encodings | `phase2-agent/agent.py:164-167` |
| `ogg_24000` = **1042 ms** | | `phase2-agent/agent.py:166` |
| `aac_24000` = **1203 ms** | | `phase2-agent/agent.py:166` |
| Cartesia sonic-3.5 = **149 ms, 12 ms spread** | same machine, same sentences, India | `phase2-agent/agent.py:146` |

**The 431 ms spread on byte-identical text is itself a finding** (`speechify-streaming-verdict.md:348-352`): *"Model compute for a byte-identical input is near-constant. A 431ms swing across five runs of the same sentence is queueing, cold workers, or autoscaler scheduling — not synthesis compute."* Expect jitter, not just latency.

### MARKETING-CLAIMED (do not trust)

- **"sub-100ms"** — *"Claims sub-100ms; unverified from India, which is exactly the claim this harness exists to test"* (`compare_tts_headtohead.py:192`). The harness measured 831 ms. **The marketing claim is off by ~8×** at least from India.
- **"lowest TTFB"** for simba-3.2 — *"marketed 'lowest TTFB' but **no numeric figure documented**"* (`ARCHITECTURE.md:208`). The `~200–300 ms` figure that appears in the architecture doc is labelled *"an **unconfirmed** estimate"* (`:209`).
- `simba-stack-feasibility.md:32` is blunt: *"its 'lowest TTFB' positioning is vendor marketing."*

### PREDICTED, never observed

`~550–800 ms` from us-east (`speechify-streaming-verdict.md:380`). This is **arithmetic** (measured TTFB minus an estimated long-haul component), explicitly labelled *"not an observation"* (`:734-736`). **No Speechify measurement from a US vantage point exists anywhere in the research.** Since you would be calling from a US/EU consumer machine, your real TTFB is genuinely unknown and is probably meaningfully better than 831 ms.

### ⚠️ A contradiction about PCM I resolved

Two claims collide:

- `speechify-streaming-verdict.md:328` / `phase-1-reader.md:99`: *"our own earlier raw-curl testing measured `pcm_24000` as **~130 ms faster per request** than the mp3 path."*
- `first-audio-delay-diagnosis.md:134` cites `measured-findings.md:176-177` as having *"already measured PCM as slower than mp3 end-to-end (930ms vs 814ms) and 7x the bytes."*

**The second citation is a misattribution.** I read `measured-findings.md:160-177`: that table is **Hume Octave**, not Speechify — the rows are literally labelled `Octave 2 + instant + mp3 | 814 ms` and `Octave 2 + instant + PCM | 930 ms`. It says nothing about Speechify. So the "PCM is slower" claim does **not** apply here; the "~130 ms faster" claim stands, though I could not locate the primary raw-curl artifact behind it either. **Treat the PCM speedup as plausible but unverified.**

---

## Chunking strategy

### For a document reader — synthesize PER PARAGRAPH

The recommendation is explicit and consistent across both docs (`ARCHITECTURE.md:178-180`, `phase-1-reader.md:536-554`):

- **One synthesis request per paragraph.** Paragraphs are the cache unit, the prefetch unit, and the seek unit all at once.
- **Merge headings into the following paragraph.** Rationale: *"a heading synthesized alone ('Chapter 3') gets bad prosody and wastes a cache unit — merge it with the following paragraph so it reads as one breath"* (`phase-1-reader.md:552`).
- **Split anything over ~800 characters at sentence boundaries, never mid-sentence.** Rationale: *"smaller units = lower first-audio latency and finer prefetch granularity"* (`phase-1-reader.md:553`). Stay well under the 20,000-char hard limit.
- **Stream the current paragraph; prefetch 2–3 ahead** (`ARCHITECTURE.md:179`, `phase-1-reader.md:285`).
- **Never synthesize the whole document up front** — cost + latency (`phase-1-reader.md:286`).
- **Keep all marks for the whole doc in memory** (tiny JSON); audio on disk always, memory LRU optional (`ARCHITECTURE.md:180`, `phase-1-reader.md:264`).

Chunking code, verbatim (`phase-1-reader.md:539-549`):

```ts
function chunkIntoParagraphs(raw: string): Paragraph[] {
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const merged = mergeHeadings(blocks);       // short punctuation-less line + next block → one unit
  const units = merged.flatMap(splitIfLong);  // split > ~800 chars at sentence boundaries
  let offset = 0;
  return units.map((text, index) => {
    const p: Paragraph = { index, text, charOffsetInDoc: offset };
    offset += text.length + 2;                 // +2 for the "\n\n" separator we split on
    return p;
  });
}
```

### The cache key — this is what makes rewind free (`phase-1-reader.md:269-280`)

```
cacheKey = sha256("<text>|<voiceId>|<model>|<outputFormat>")
```

*"Include `text` in the key (not just paragraph index) so an edited paste re-synthesizes only changed paragraphs and a rewind to an unchanged one is a pure disk hit → $0."*

### ⚠️ The prosody risk nobody tested

**Each Speechify request is an independent synthesis.** `GetStreamRequest` carries no context or continuation field, so the model cannot condition chunk N+1 on chunk N (`speechify-streaming-verdict.md:478-485`):

> *"Cross-chunk intonation continuity is lost, and no amount of network overlap restores it. **This is the risk most likely to damage the exact thing you are protecting.**"*

And from the gap inventory (`:751-754`): *"**Audio quality at chunk boundaries. Completely untested by listening.** Since each request is an independent synthesis, splitting a reply may audibly reset intonation... it can only be settled by ear."*

This is a direct argument **against** chunking too finely. Larger paragraphs = better prosody continuity, at the cost of first-audio latency.

### For a conversational agent (different problem, included for contrast)

The production agent uses a 200-char minimum chunk, and the tuning data is MEASURED on a 342-char answer (`phase2-agent/agent.py:183-185`):

```
min_sentence_len=20   -> 10 chunks -> ~8.1s of added gaps   (the default, unusable)
min_sentence_len=150  ->  2 chunks -> ~0.9s
min_sentence_len=400  ->  1 chunk  -> 0s
```

This is a LiveKit `StreamAdapter` artifact — irrelevant to a reader, where you control chunking directly.

---

## Variable playback speed — what the research says

### The honest answer: **essentially nothing. This is the single largest gap.**

I grepped the entire rabbitwhole repo (excluding `node_modules`, `.venv`, `Pods`, `.history`) for `playback rate`, `playbackRate`, `speed control`, `0.5x`, `2x speed`, `varispeed`, `AVAudioUnitTimePitch`, `timePitch`, `setRate`, `wpm`, `words per minute`, and `"speed"` as an API parameter. **There is no design note, no test, no measurement, and no discussion of changing playback speed while keeping word highlighting synced.** The four adjacent hits are all tangential:

| Hit | What it actually says | Relevance |
|---|---|---|
| `chat-history.md:25697` | *"Chars/hour depends on the user's playback speed (I used ~50k/hr at ~150 wpm; 2–3× listeners roughly double TTS cost)"* | **Cost only**, and see my correction below |
| `chat-history.md:26822` | LiveKit's `synchronized_transcript` estimates position from `STANDARD_SPEECH_RATE = 3.83 hyphens/sec × speed` and *"can drift from actual TTS timing"* | **LiveKit's** estimator, not Speechify's. Irrelevant if you own the player |
| `phase-1-reader.md:495` | `MPNowPlayingInfoPropertyPlaybackRate: rate` — but the comment says *"1.0 playing, 0.0 paused"* | Only ever binary. Not a speed feature |
| `chat-history.md:25925` (docs verbatim) | *"Times stay correct for every output_format: changing the codec or sample rate does not change the duration"* | **Codec-invariance, not speed-invariance.** Do not over-read this |

**There is no `speed` parameter in any Speechify request body anywhere in the research corpus.** By contrast, Hume's TTS *does* expose one (`techDocs/livekit-hume-tts.md:103`, `:145` `speed=2`), and the fact that the same author documented Hume's `speed` while never mentioning a Speechify equivalent is weak-but-real evidence that Speechify has none. **Status: UNKNOWN, lean "no server-side speed control."**

### What I can tell you by reasoning over the architecture (⚠️ MY INFERENCE, not prior research)

**The good news: the architecture the prior research landed on makes variable speed almost free, and it does so by accident.**

The design is a **client-side deterministic player that owns the playhead** (`ARCHITECTURE.md:266`, `:273-281`). Speech marks are fetched once, cached, and used purely as a **lookup table from milliseconds-of-audio to character-range** (`phase-1-reader.md:343-346`). Crucially, the marks describe the **audio asset**, not the playback session.

That gives you a clean separation:

- **Speech-mark times are in "audio time"** — fixed properties of the synthesized PCM, unaffected by how fast you play it.
- **Your playhead is in "wall-clock time"** — `originGlobalMs + sampleTime/sampleRate` (`phase-1-reader.md:380-385`).

At 1.0× those coincide. At rate `r`, they diverge by exactly a factor of `r`, and the fix is one multiplication: **audio-time = accumulated (wall-clock-elapsed × r)**. Resolve the highlight with the existing binary-search floor (`phase-1-reader.md:426-434`) against that audio-time value and highlighting stays exact at any rate.

Two things make this cleaner than it sounds:

1. **`AVAudioPlayerNode.playerTime(forNodeTime:).sampleTime` already counts *rendered source frames*, not wall-clock time.** If you implement speed via an `AVAudioUnitVarispeed` or `AVAudioUnitTimePitch` node inserted after the player node, `sampleTime` continues to advance in source-audio frames — meaning the existing `globalPlayheadMs()` at `phase-1-reader.md:380-385` **may already be rate-correct with zero changes**. This is the single highest-value thing to verify empirically, because if true, variable speed costs you nothing.
2. **Speed changes cost $0 and require no re-synthesis** — you are resampling cached PCM locally. This also **corrects** the cost claim at `chat-history.md:25697`: 2× listening doubles TTS cost only if you *listen to twice as much text*. Changing the rate on a fixed document changes nothing about characters sent.

**The pieces that would need touching** (all small, all in code the prior research already wrote):

- `seekToGlobalMs` (`phase-1-reader.md:393-412`) — the seek target is in audio-ms, so it is already rate-independent. Should need no change.
- `originGlobalMs` bookkeeping (`phase-1-reader.md:373`) — must be re-anchored on a **rate change** as well as on `stop()+play()`, otherwise elapsed time is scaled by the wrong factor for the segment before the change.
- `MPNowPlayingInfoPropertyPlaybackRate` (`phase-1-reader.md:495`) — set to the real rate so the iOS lock-screen scrubber extrapolates correctly instead of drifting.
- The highlight timer (`phase-1-reader.md:388`, ~30 Hz) — at 2× each word occupies half the wall-clock time, so a 100 ms timer that felt fine at 1× may visibly lag. Prefer `CADisplayLink`.
- **Pitch:** `AVAudioUnitVarispeed` changes pitch with speed (chipmunk effect); `AVAudioUnitTimePitch` preserves pitch. For a reader you want `AVAudioUnitTimePitch` with `rate` set and `pitch` left at 0.

**Bottom line for your use case:** the prior research does not answer your question, but it also does not create any obstacle. Because it chose speech marks as a *static time↔char table over cached audio* rather than relying on any live provider-side alignment, speed is a pure client-side playback concern. **Verify assumption (1) above first — it determines whether this is a 0-line or a ~20-line change.**

---

## Gotchas & failure modes

### Speech-mark / synchronization gotchas (`ARCHITECTURE.md:195-206`, `phase-1-reader.md:568-580`)

1. **Leading silence.** The first word's `start_time ≠ 0` — visible in the docs' own example (125 ms). Always drive off the actual `startTime`; restarting a paragraph at `docStartMs[p]` replays ~100–300 ms of silence.
2. **Marks have GAPS.** Resolve "word at time t" as the **last word with `startTime ≤ t`** — binary-search FLOOR. **Never** a range test `start ≤ t ≤ end`, because t routinely falls in inter-word silence and the test returns nothing.
3. **Send plain text, never SSML.** SSML entity-escaping (`&`→`&amp;`) **shifts character indices** so marks no longer align with your stored string.
4. **`text_normalization` default differs by endpoint** (`true` batch / `false` streaming) and is **nested under `options`**. With it on, "$5" is *spoken* "five dollars" but the mark still points at the original "$5" span — so highlighting stays correct. **DOC-IMPLIED, flagged to confirm on live audio** (`phase-1-reader.md:602`).
5. **Per-paragraph synthesis resets both times and char indices to zero.** Offset by `docStartMs[p]` (time) and `charOffsetInDoc` (chars) to get doc-global position.
6. **Streaming marks are absolute ms from synth start.** Concatenate audio strictly in arrival order and pool all marks; which chunk a mark arrived on is meaningless.
7. **Field-name split:** streaming = `audio`, batch = `audio_data`.
8. **Bytes vs chars is unresolved** — see the dedicated warning above. Non-ASCII text is the trigger.

### API / operational failure modes

9. **429 Too Many Requests in production.** MEASURED: *"On walk-21, Speechify returned '429 Too Many Requests' on 6 of 48 requests, one of them stalling a reply for 2 seconds of dead air"* (`phase2-agent/agent.py:225-226`). That is a **12.5% failure rate** on a real session. The mitigation shipped was a `FallbackAdapter` to a second provider. For a reader, the equivalent is retry-with-backoff plus a deeper prefetch buffer.
10. **Free plan allows 1 simultaneous request** (`speechify-streaming-verdict.md:452`) — parallel prefetch is impossible on free.
11. **Rate limits are per ACCOUNT, not per API key** (`:455`) — you cannot shard around them with extra keys.
12. **`wav_48000` is broken** — returns MP3 bytes regardless (`phase2-agent/agent.py:164-166`).
13. **The billable-characters response header is undocumented** and can vanish without notice (`verified-cost-sources.md:205`).
14. **No usage/balance API exists** — everything is dashboard-only (`verified-cost-sources.md:212`).
15. **Prosody resets at chunk boundaries** — untested by ear, and the risk most likely to undermine the reason you picked this voice (`speechify-streaming-verdict.md:478-485`, `:751-754`).
16. **`api.sws.speechify.com` vs `api.speechify.ai` are the same IP** — a "faster host" is a myth (`speechify-streaming-verdict.md:791`).
17. **The `livekit-plugins-speechify` package is built against an older contract**: `TTSModels` lacks `simba-3.2`, `TTSEncoding` has no PCM member, and it sends the legacy `audio_format` field to the legacy host (`speechify-streaming-verdict.md:311-318`). `simba-3.2` only works because `Literal` is not runtime-enforced. **Irrelevant if you call the REST API directly, which you should.**

### Player gotchas (Apple-specific, if that ever matters)

18. **`scheduleSegment` takes an `AVAudioFile`, not a buffer** — the architecture doc's shorthand was wrong and phase-1 corrects it (`phase-1-reader.md:10`, `:314`).
19. **`playerTime.sampleTime` resets on every `play()` session** — store `originGlobalMs` on `stop()+play()` only, never on gapless advance (`phase-1-reader.md:578`).
20. **Never seek past the synthesized frontier** — clamp (`phase-1-reader.md:580`).

---

## Verbatim code samples found

### 1. The step-0 verification curl — DOC-CONFIRMED shape, never actually run (`phase-1-reader.md:586-591`)

```bash
curl -N -X POST https://api.speechify.ai/v1/audio/stream/with-timestamps \
  -H "Authorization: Bearer $SPEECHIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"input":"Testing streaming with timestamps. It costs $5 at 3pm, café.","voice_id":"geffen_32","model":"simba-3.2","output_format":"pcm_24000","language":"en-US","options":{"text_normalization":true}}'
```

The test string is deliberately constructed: `$5` and `3pm` exercise `text_normalization`, and `café` exercises the byte-vs-char question.

### 2. Non-streaming PCM probe against both hosts (`speechify-streaming-verdict.md:605-618`)

```bash
curl -s -o /dev/null -w "http=%{http_code} ttfb=%{time_starttransfer}\n" \
  -X POST https://api.speechify.ai/v1/audio/stream \
  -H "Authorization: Bearer $SPEECHIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Testing raw PCM output from the documented host.",
       "voice_id":"geffen_32","model":"simba-3.2","output_format":"pcm_24000"}'
```

### 3. Working Python — the production LiveKit agent (`phase2-agent/agent.py:200-210`)

This is **real running code**, though it goes through the LiveKit plugin rather than raw REST, and uses the plain `/audio/stream` endpoint (no marks):

```python
engine = speechify.TTS(
    voice_id=SPEECHIFY_VOICE,     # "geffen_32"
    model=SPEECHIFY_MODEL,        # "simba-3.2"
    encoding=SPEECHIFY_ENCODING,  # "mp3_24000"
)
return tts_lib.StreamAdapter(
    tts=engine,
    sentence_tokenizer=basic_tokenize.SentenceTokenizer(
        min_sentence_len=SPEECHIFY_MIN_CHUNK_CHARS   # 200
    ),
)
```

### 4. The SSE parser core — Swift, written but never run (`phase-1-reader.md:184-217`)

The load-bearing logic, condensed. Note the arrival-order append and the defensive flatten:

```swift
func flushFrame() throws {
    guard !dataBuf.isEmpty else { return }
    let json = try JSONSerialization.jsonObject(with: Data(dataBuf.utf8)) as? [String: Any] ?? [:]
    switch eventName {
    case "speech.chunk":
        if let b64 = json["audio"] as? String, let audio = Data(base64Encoded: b64) {
            pcm.append(audio)                       // ARRIVAL ORDER — never reorder
        }
        if let marks = json["speech_marks"] as? [[String: Any]] {
            words.append(contentsOf: flatten(marks))  // pool + flatten
        }
    case "speech.done":
        durationMs = json["audio_duration_ms"] as? Int ?? durationMs
    default: break
    }
    eventName = ""; dataBuf = ""
}

for try await line in bytes.lines {
    if line.isEmpty { try flushFrame(); continue }   // blank line = end of SSE frame
    if line.hasPrefix("event:") { eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
    else if line.hasPrefix("data:") {
        let piece = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        dataBuf += (dataBuf.isEmpty ? "" : "\n") + piece
    }
}
try flushFrame()   // trailing frame if no final blank line
```

The mark flattener, which handles the "flat or nested — unknown" case (`phase-1-reader.md:220-235`):

```swift
private func flatten(_ marks: [[String: Any]]) -> [WordMark] {
    var out: [WordMark] = []
    for m in marks {
        if let chunks = m["chunks"] as? [[String: Any]], !chunks.isEmpty {
            out.append(contentsOf: flatten(chunks))   // descend into words
        } else {
            out.append(WordMark(
                startTimeMs: Int(m["start_time"] as? Double ?? 0),
                endTimeMs:   Int(m["end_time"]   as? Double ?? 0),
                startChar:   m["start"] as? Int ?? 0,
                endChar:     m["end"]   as? Int ?? 0,
                value:       m["value"] as? String ?? ""))
        }
    }
    return out
}
```

### 5. The word-at-time binary-search FLOOR — the highlighting primitive (`phase-1-reader.md:426-434`)

**This is the most directly reusable piece of logic in the entire corpus** and it is language-agnostic:

```swift
func wordFloorIndex(_ t: Int) -> Int {          // globalWords sorted ascending by globalStartMs
    var lo = 0, hi = globalWords.count - 1, ans = 0
    while lo <= hi {
        let mid = (lo + hi) / 2
        if globalWords[mid].globalStartMs <= t { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
}
```

### 6. Building the global timeline across per-paragraph syntheses (`phase-1-reader.md:341-346`)

```swift
// docStartMs[p] = Σ durations of paragraphs < p
var docStartMs: [Int] = []   // docStartMs[0] = 0; docStartMs[p] = docStartMs[p-1] + durationMs[p-1]
// word.globalStartMs = docStartMs[p] + word.startTimeMs
struct GlobalWord { let paragraph: Int; let wordIndex: Int; let globalStartMs: Int
                    let startChar: Int; let endChar: Int }
var globalWords: [GlobalWord] = []   // sorted ascending by globalStartMs
```

### 7. The bridge/event contract for a highlighting UI (`phase-1-reader.md:50-69`)

Worth stealing wholesale as an interface design:

```ts
export interface WordMark { startTimeMs: number; endTimeMs: number; startChar: number; endChar: number; value: string }
export interface Paragraph { index: number; text: string; charOffsetInDoc: number }

ReaderEngine.seekToGlobalMs(ms: number): void
ReaderEngine.goBack(seconds: number): void        // default 15
ReaderEngine.getPlayheadMs(): number

// Events
onWordBoundary: { globalMs, paragraphIndex, wordIndex, startChar, endChar }  // drives highlighting
onParagraphChanged: { index }
onStateChange: { state: 'idle'|'playing'|'paused'|'buffering' }
```

---

## Open questions the prior research did NOT answer

### Explicitly flagged by the prior research (`phase-1-reader.md:595-603`, `:626-631`)

| # | Question | Why it matters |
|---|---|---|
| 1 | **Runtime confirmation of the SSE shape.** The contract is doc-confirmed but **the step-0 curl was never executed** — no API key was available, and the author avoided spending credits | The whole parser |
| 2 | **Real TTFB from a non-India vantage point** | UNKNOWN — no number published, none measured outside India |
| 3 | **PCM byte layout of `pcm_24000`** — 16-bit signed LE, mono? Expect 48000 bytes/s | Buffer decode and all frame math |
| 4 | **Is `geffen_32` on the simba-3.2 allow-list for `/with-timestamps` specifically?** | Wrong voice = 400 or silence |
| 5 | **byte vs char vs UTF-16 code unit** for `start`/`end` | Highlighting correctness on any non-ASCII document |
| 6 | **Does `text_normalization: true` keep marks on the original span?** Doc-implied only | Highlighting correctness on "$5", "3pm", numerals |
| 7 | **Do streaming word marks arrive flat or nested?** | One line of the parser |
| 8 | **The `type` enum values on marks** (`"word"`/`"sentence"`?) | Not enumerated in docs |

### Gaps I identified that the prior research never even raised

| # | Question | Note |
|---|---|---|
| 9 | **Everything about variable playback speed.** Does Speechify accept a `speed` request parameter? Does `sampleTime` remain rate-correct through a varispeed node? | Zero coverage. The most important gap for your use case |
| 10 | **Sentence-level vs word-level highlighting.** The parent `SpeechMarks` object gives free sentence boundaries, but no doc discusses using them for a two-tier highlight (dim sentence + bright word) | Free feature nobody costed |
| 11 | **Browser/Web feasibility.** Every implementation note assumes native Swift + `AVAudioEngine`. Nothing addresses Web Audio API, `MediaSource`, or an Electron renderer | Directly relevant to folio, which is a web + Electron app |
| 12 | **CORS.** Can `api.speechify.ai` be called from a browser renderer at all, or must it be proxied through a main process? | Folio already proxies Notion through Electron IPC for exactly this reason (`folio/CLAUDE.md`) — likely the same answer here |
| 13 | **Behaviour of `speech.error`.** The event type is named once (`chat-history.md:25923`) and never described | No error payload shape known |
| 14 | **Whether marks are stable across identical requests.** The cache key assumes determinism; the 431 ms latency spread hints at heterogeneous workers | If two syntheses of the same text differ in timing, cached marks could mismatch re-fetched audio |
| 15 | **Any character-level (sub-word) timing.** Confirmed absent: *"No phoneme-level marks are documented"* (`chat-history.md:25914`) | Rules out karaoke-style intra-word highlighting |

---

## What I did NOT do

- **I ran no live API call.** Everything here is extracted from prior research; I did not obtain a key or validate a single endpoint. Every "DOC-CONFIRMED" label reflects the prior author reading Speechify's docs in August 2026, not me re-reading them today.
- **I did not re-verify the docs are still accurate.** Speechify shipped `simba-3.0` in May 2026 and `with-timestamps` sometime after the July OpenAPI snapshot; the API is moving. Anything here could be six months stale.
- **I read `techDocs/tts-landscape-2026.md`, `.notes/tts-landscape-research.md`, `techDocs/measured-findings.md`, `techDocs/first-audio-delay-diagnosis.md`, `techDocs/verified-cost-sources.md`, and `techDocs/latency-levers-checklist.md` by targeted grep, not cover to cover.** Their Speechify content is thin (4–15 matching lines each) and I read the full surrounding context of every match, but a non-matching passage could hold something.
- **I did not read `listeninterrupt/techDocs/phase-2-interrupt-loop.md` or `phase-0-gate.md` in full** — they cover the voice-interrupt gate and have no Speechify TTS content per grep.
- **I did not read the 30,000-line `.claude/chat-archive/chat-history.md` in full** — only the ~120 lines around Speechify/speech-mark/speed matches.
- **The variable-playback-speed section's engineering analysis is my own reasoning, clearly labelled as such.** It is untested. In particular the claim that `AVAudioPlayerNode.playerTime.sampleTime` stays rate-correct behind a varispeed node is an inference from Apple's API semantics, not something I or the prior research verified.

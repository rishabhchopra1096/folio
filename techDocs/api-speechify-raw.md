# Speechify API — raw reference notes (captured 2026-08-16)

> Source of truth: <https://docs.speechify.ai>. NOTE: the older `docs.sws.speechify.com`
> domain now **301-redirects** to `docs.speechify.ai`. Old links still work but resolve
> to the new host. Both API hosts `api.speechify.ai` and `api.sws.speechify.com` are
> live and behave identically (verified via curl, see CORS section).

---

## 1. Base URL and auth

```
https://api.speechify.ai
Authorization: Bearer sk_...
Content-Type: application/json
```

Verified live 2026-08-16 — a request with a bogus key returns:

```
HTTP 401
{"error":{"code":"unauthorized","message":"Unauthorized"},"request_id":"c7e1bc67dd29ebad73df19f1"}
```

(401 rather than 404 confirms the endpoint paths below are correct.)

### Optional: short-lived access tokens (for client-side use)

`POST /v1/auth/token` — OAuth2 client-credentials flow.

- Body: `grant_type=client_credentials`, optional `scope` (space-delimited).
- Response: `{ access_token, expires_in, scope, token_type: "bearer" }`
- Default scope if omitted: `audio:all voices:read`
- Speechify's docs say this call **must be made server-side** and the resulting token
  handed to the client. For a bring-your-own-key app this is irrelevant — the user's own
  `sk_` key goes straight in the `Authorization` header from the browser.

Docs: <https://docs.sws.speechify.com/v1/api-reference/api-reference/tts/auth/create-access-token>

---

## 2. `POST /v1/audio/speech` — batch synthesis (returns audio + speech marks)

Docs: <https://docs.speechify.ai/build/api-reference/v1/audio/speech>

### Request body

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `input` | string | yes | — | Plain text **or SSML** |
| `voice_id` | string | yes | — | From `GET /v1/voices` |
| `audio_format` | enum | no | `wav` | `wav`, `mp3`, `ogg`, `aac`, `pcm` |
| `language` | string | no | — | ISO 639-1 + ISO 3166-1, e.g. `en-US` |
| `model` | enum | no | `simba-3.0` | `simba-english`, `simba-multilingual`, `simba-3.0`, `simba-3.2` |
| `output_format` | enum | no | — | `codec_sampleRate_bitrate`; overrides `audio_format` |
| `options.loudness_normalization` | bool | no | `false` | Normalizes to −14 LUFS |
| `options.text_normalization` | bool | no | `true` | Numbers/dates → words |

### Example request

```json
{
  "input": "Hello! This is the Speechify text-to-speech API.",
  "voice_id": "geffen_32",
  "audio_format": "mp3",
  "model": "simba-3.2"
}
```

### Response 200

```json
{
  "audio_data": "base64_string",
  "audio_format": "wav|mp3|ogg|aac|pcm|ulaw",
  "billable_characters_count": 10,
  "output_format": "optional_codec_format",
  "speech_marks": {
    "start": 1,
    "end": 1,
    "start_time": 1.0,
    "end_time": 1.0,
    "type": "string",
    "value": "string",
    "chunks": [{}]
  }
}
```

**Speech marks are returned on this endpoint for ALL models.**

---

## 3. Speech marks — exact shape

Docs: <https://docs.speechify.ai/tts/text-to-speech/features/speech-marks>

```ts
type NestedChunk = {
  start_time: number  // MILLISECONDS from start of this synthesis
  end_time: number    // MILLISECONDS
  start: number       // CHARACTER INDEX into the original input text
  end: number         // CHARACTER INDEX into the original input text
  value: string       // the text of this chunk
}

type SpeechMarks = NestedChunk & {
  chunks: NestedChunk[]   // word-level children
}
```

Two levels only: one top-level object covering the whole utterance, with a flat
`chunks[]` array of word-level entries. There is no sentence tier — sentence
grouping must be derived client-side from the character offsets.

### Verbatim example from the docs

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

### Documented gotchas (quote/paraphrase from the docs page)

1. **SSML escaping leaks into the offsets.** "Values are returned based on the SSML, so
   any escaping of `&`, `<` and `>` will be present in the `value`, `start` and `end`
   fields." → If you send SSML, character offsets index into the *escaped* string, not
   your original text. Safest path: send **plain text** and keep your own offset map.
2. **Character index gaps exist between words.** The docs say to look up a word by
   testing `start >= yourIndex` rather than checking `yourIndex` falls inside
   `[start, end]`. (Whitespace/punctuation between tokens is not covered by any chunk.)
3. **Leading silence.** The first word's `start_time` is not 0 — in the example above it
   is 125 ms while the chunk starts at 0 ms.
4. **Trailing silence.** "The `end_time` of the last word does not necessarily correspond
   with the end of the audio chunk — there can be silence at the end that will make the
   chunk longer." → Never assume `audio.duration * 1000 === lastWord.end_time`.

---

## 4. `POST /v1/audio/stream/with-timestamps` — streaming synthesis + speech marks

Docs: <https://docs.speechify.ai/build/api-reference/v1/audio/stream/with-timestamps.md>

### Request

Same core params as batch, plus:

- `output_format` (enum): `pcm_*`, `mp3_*`, `ulaw_8000`, `ogg_24000`, `aac_24000`
- `Accept` header (optional): `audio/mpeg`, `audio/ogg`, `audio/aac`, `audio/pcm`
- `options.text_normalization` defaults to **`false`** here (differs from batch, where it defaults to `true`)

**Model restriction: speech marks on the streaming endpoint are only supported by
`simba-3.0` and `simba-3.2`.** (`simba-english` / `simba-multilingual` are accepted by
the endpoint but do not carry timestamps.)

### Response framing — Server-Sent Events

`Content-Type: text/event-stream`

```
event: speech.chunk
data: {"type":"speech.chunk","audio":"[Base64]","speech_marks":[{"type":"word","value":"text","start":0,"end":100}]}

event: speech.done
data: {"type":"speech.done"}
```

Event types:

| Event | Meaning |
|---|---|
| `speech.chunk` | Base64 audio run + finalized word-level speech marks |
| `speech.done` | Stream terminator |
| `speech.error` | Mid-stream error |

Per the docs, **times are absolute milliseconds from the start of the synthesis**, and
audio chunks are meant to be concatenated into a single timeline. So the timestamps
across the whole SSE stream already share one timebase — no per-chunk offset math needed
*within* a single request.

### ⚠️ Field-name trap between the two endpoints

| Endpoint | Base64 audio field | Speech marks field |
|---|---|---|
| `POST /v1/audio/speech` | **`audio_data`** | `speech_marks` (object with `.chunks`) |
| `POST /v1/audio/stream/with-timestamps` | **`audio`** | `speech_marks` (flat array per event) |

Two differences, not one: the audio field is renamed **and** the speech-marks shape changes
from a nested object to a flat per-event array. Normalize both into one internal shape at the
adapter boundary. Flagged in prior in-house research as the most common integration bug.

### Browser implementation gotcha (INFERRED, verify empirically)

The native `EventSource` API cannot set an `Authorization` header and only issues GET.
This endpoint is a POST with a Bearer token, so **`EventSource` will not work** — you must
consume the SSE stream with `fetch()` + `response.body.getReader()` and parse the
`event:` / `data:` framing yourself. This is a normal cross-origin `fetch`, which the CORS
headers below permit.

---

## 5. SSML / speed control

Docs: <https://docs.speechify.ai/tts/text-to-speech/features/ssml>

Speed is controlled **only** via SSML `<prosody rate="...">` in the `input`:

- Keywords `x-slow` … `x-fast`
- Percentages from **−83% to +100%**, e.g. `<prosody rate="+20%">`

**This is server-side.** Changing speed this way requires a *new synthesis request*, and
returns *different* speech marks. It is therefore the wrong mechanism for an on-the-fly
playback-speed slider — use `HTMLMediaElement.playbackRate` on the client instead and
synthesize once at rate 1.0. (See the main research doc, section C.)

---

## 6. CORS — VERIFIED EMPIRICALLY, 2026-08-16

Real `OPTIONS` preflight from an arbitrary origin:

```bash
curl -i -X OPTIONS "https://api.speechify.ai/v1/audio/speech" \
  -H "Origin: https://folio.vercel.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

Response:

```
HTTP/2 200
access-control-allow-headers: Authorization, Content-Type
access-control-allow-methods: POST
access-control-allow-origin: https://folio.vercel.app
access-control-max-age: 300
vary: Origin
vary: Access-Control-Request-Method
vary: Access-Control-Request-Headers
server: Google Frontend
```

The same result was returned for `/v1/audio/stream/with-timestamps` and for the
`api.sws.speechify.com` host.

**Verdict: Speechify reflects any `Origin` and explicitly allows the `Authorization`
header. A static site can call the API directly from the browser with a Bearer token.
No proxy required.**

Caveat worth noting: `access-control-max-age: 300` means the browser re-runs the preflight
every 5 minutes — one extra round trip occasionally, not a correctness problem.

---

## 7. Pricing (from <https://speechify.ai/pricing>, captured 2026-08-16)

| Plan | Price | TTS included | Overage |
|---|---|---|---|
| Free | $0 | 50,000 chars/mo (**hard cap**, no card) | n/a |
| Starter | $10/mo | 1M chars | $10 / 1M |
| Pro | $99/mo | 3M chars | $8 / 1M |
| Scale | $499/mo | 10M chars | $6 / 1M |
| Enterprise | custom | — | volume discounts |

Flat per-character billing, no credit conversion. One shared balance across TTS and
voice agents.

**Working numbers for Folio:** a 10,000-word document is roughly 55,000–60,000
characters. That is **~$0.55 per full read-through at the Starter rate**, and the free
tier covers just under one such document per month.

---

## 8. Models

| Model | Notes |
|---|---|
| `simba-3.2` | Streaming-native flagship, shipped to the API July 2026; Speechify's recommended model for new English integrations |
| `simba-3.0` | Previous flagship; still the API **default** if `model` is omitted |
| `simba-english` | Older English model |
| `simba-multilingual` | Older multilingual model |

Speech-mark support: **all models** on `/v1/audio/speech`; **`simba-3.0` and `simba-3.2`
only** on `/v1/audio/stream/with-timestamps`.

---

## 9. Other endpoints noted

- `GET /v1/voices` — voice catalogue (returns 401 with a bad key, so path confirmed).
- `POST /v1/audio/stream` — streaming audio **without** timestamps.

---

## Things NOT verified here

- Actual latency to first audio byte (needs a real API key).
- Whether `speech_marks.type` is always `"word"` on the batch endpoint (the schema shows a
  generic `"type": "string"`; the streaming example shows `"type":"word"`).
- Whether the batch endpoint's top-level `speech_marks` object ever nests more than two
  levels deep (docs' TypeScript type says no; the OpenAPI stub shows `chunks: [{}]`).
- Rate limits / concurrency caps per plan.

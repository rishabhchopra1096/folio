# Gemini multi-turn chat over REST — the shape Folio should use

Notes for building ask mode. **The endpoint here is the one Folio already ships
against and has proven works from a browser**, so the chat feature adds no new
network assumptions — only a different request body.

## TL;DR

- Use `v1beta/models/{model}:generateContent`, the **same endpoint transcription
  already uses** (`js/gemini.js:33`, `js/gemini.js:491`).
- Multi-turn is just a longer `contents` array. Roles are **`user`** and
  **`model`** — not `assistant`.
- The API is **stateless**: you resend the whole conversation every turn. There
  is nothing to store server-side and nothing to expire.
- Auth is the header `x-goog-api-key`. Browser CORS works — proven daily.
- Keep `thinkingLevel: "low"`, as transcription does. Measured faster, cheaper
  *and* denser output.
- A newer `interactions` API exists with server-side conversation state. It is
  **untested here** — see the caveat at the bottom. Don't migrate onto it
  without measuring.

## The request

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent
Content-Type: application/json
x-goog-api-key: <key>
```

```jsonc
{
  // Standing instructions. Not part of the turn history, never echoed back.
  "systemInstruction": {
    "parts": [{ "text": "You answer questions about a lesson the user is watching…" }]
  },

  // The whole conversation, oldest first. Resent in full every turn.
  "contents": [
    { "role": "user",  "parts": [{ "text": "<transcript context + question 1>" }] },
    { "role": "model", "parts": [{ "text": "<answer 1>" }] },
    { "role": "user",  "parts": [{ "text": "<question 2>" }] }
  ],

  "generationConfig": {
    "thinkingConfig": { "thinkingLevel": "low" },
    "maxOutputTokens": 1200
  }
}
```

### Rules that bite

- **Roles are `user` and `model`.** Sending `assistant` is an error. This is the
  single most common mistake when porting from an OpenAI-shaped client.
- **`contents` must alternate and must end on `user`.** A trailing `model` turn
  means you are asking the model to continue its own sentence.
- **`systemInstruction` is a separate top-level field**, not a `contents` entry
  with a `system` role. There is no `system` role on this API.
- **Statelessness is the whole design.** Nothing is remembered between calls, so
  history length is entirely your problem — and your cost.

## The response

```jsonc
{
  "candidates": [{
    "content": { "parts": [{ "text": "…the answer…" }], "role": "model" },
    "finishReason": "STOP"          // or MAX_TOKENS, SAFETY, RECITATION
  }],
  "usageMetadata": { "promptTokenCount": 4213, "candidatesTokenCount": 380 }
}
```

Read the text at `candidates[0].content.parts[0].text`. **Always check
`finishReason`** — `MAX_TOKENS` means the answer was cut mid-sentence and should
be shown as truncated rather than presented as complete. `js/gemini.js` already
treats this distinction as load-bearing during top-ups.

`usageMetadata` is what makes cost visible; log it per turn.

## Streaming

Swap the method and add `alt=sse`:

```
POST …/models/gemini-3.7-flash:streamGenerateContent?alt=sse
```

The body is identical. The response is Server-Sent Events — `data: {…}` lines,
each carrying the same candidate shape with an incremental `parts[0].text`.
Concatenate the deltas.

Minimal browser reader:

```js
const res = await fetch(url, { method: "POST", headers, body, signal });
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", full = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop();                                  // keep the partial line
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const j = JSON.parse(line.slice(6));
    const t = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (t) { full += t; onDelta(full); }
  }
}
```

Two things to get right, both learned the hard way elsewhere in this repo:

1. **Buffer the partial line.** A chunk boundary lands mid-JSON often enough to
   matter; parsing the tail of a split line throws.
2. **`signal` must be honoured** so navigating away or asking a new question
   cancels the old stream instead of racing it into the panel.

## Errors

`js/gemini.js` already classifies these correctly and the chat module should
reuse that logic rather than re-derive it:

| status | meaning | retry? |
|---|---|---|
| 503 | model busy — clears in seconds | yes, fast ladder |
| 429 + "credits are depleted" | account empty | **no** — terminal, say so plainly |
| 429 otherwise | rate limited | yes, slow ladder |
| 400 | malformed body (usually a bad role) | no — a bug, not a condition |

The distinction between the two 429s cost real confusion once: reporting an
empty account as "rate limit, try later" sends the user to wait for something
that will never clear. **Show Google's own message.**

## Cost, measured

Against the 36 real lesson transcripts already produced (`youtube-storyboard-extractor/narratives/`),
at flash pricing ($0.30/M in, $2.50/M out) with a ~400-word answer:

| transcript | tokens in | cost per question |
|---|---|---|
| smallest (1,058 words) | ~1,375 | ~$0.0017 |
| **median (3,147 words)** | **~4,091** | **~$0.0025** |
| largest (12,857 words) | ~16,714 | ~$0.0063 |

**100 questions on a median lesson costs about $0.25.** A ten-turn conversation
with the full history resent each turn costs about $0.036.

The consequence is worth stating plainly: **the whole transcript fits in every
request, cheaply.** No retrieval, no chunking, no embeddings, no vector store.
Send it all. Any design that adds a retrieval layer here is solving a cost
problem that does not exist.

## Caveat: the newer `interactions` API

Google's current text-generation page documents a different surface —
`v1beta/interactions`, with `input`, `system_instruction`, and
`previous_interaction_id` for server-side conversation state. It would remove
the resend-everything pattern.

**It has not been tested from this codebase.** Folio's proven, working path is
`:generateContent`, and the cost table above shows resending history is
essentially free at this scale. There is no pressure to migrate. If it is ever
tried, measure first — the last time an untested assumption about this API was
built on, it cost a day.

---

Verified 21 August 2026 against `js/gemini.js` as shipped: endpoint at line 33,
model `gemini-3.7-flash` at line 45, `thinkingLevel: "low"` at line 265, and the
`x-goog-api-key` header at line 493. The multi-turn `contents`/role shape is from
Google's API reference and should be confirmed by the first real call.

# Can We Keep the Speechify Voice AND Get Proper Streaming TTS?

**Status:** Verdict. Four independent research streams, adversarially cross-checked. Refuted
findings have been stripped out or corrected in place.
**Date:** 2026-07-19
**Stack under discussion:** LiveKit Agents 1.6.6, livekit-plugins-speechify 1.6.6,
Speechify simba-3.2 / voice `geffen_32`, Gemini 3.5 Flash, agent hosted in India South.

---

## TL;DR

- **You keep the voice. You do not get "proper streaming" in the sense you mean it — nobody
  can, because Speechify's API has no mechanism to accept text incrementally.** That is a
  vendor product gap, not a plugin gap, and no fork fixes it.
- **The route to keeping the voice is: make each round trip cheaper and make there be fewer
  of them.** You are already doing the second half (200-char chunking, `agent.py:160`).
  The first half is geography plus a PCM encoding the installed plugin cannot request.
- **Moving to us-east helps, but not the way you hoped.** The hypothesis "a chunk round trip
  drops from ~900ms to ~150ms" is false. A realistic post-move Speechify TTFB is ~550-800ms,
  not 150ms, because a large Speechify-internal residual survives any relocation.
- **A custom pipelined plugin is buildable (12-18h) but its headline benefit is NOT lower
  first-audio latency** — pipelining measurably does nothing for TTFB. Its real wins are
  removing mid-reply gaps and unlocking `pcm_24000`, which your own earlier testing measured
  at ~130ms saved per request.
- **A true streaming plugin (option c) is impossible.** There is no transport to implement
  against. This is closed, with high confidence.
- **There is a fifth route nobody has evaluated: Speechify's own Agents platform**, which
  runs on LiveKit, uses simba-3.2, and per its OpenAPI schema accepts a custom
  OpenAI-compatible LLM endpoint. It is the *only* configuration where the Speechify voice
  gets genuine streaming text input. It is unverified and gated on one 5-second API call.
- **Do this first, before any migration or code:** two authenticated curls (below). They cost
  five minutes and could make most of this document moot.

---

## Document Map

1. **The Answer** — yes/no and by what route.
2. **Does the Speechify API support streaming text input?** — definitive, with method.
3. **Why the plugin says `streaming=False`** — plugin gap or API constraint.
4. **The Options, Ranked** — latency, effort, risk for (a) us-east, (b) pipelined plugin,
   (c) true streaming plugin, (d) Cartesia. Plus (e), the unevaluated Agents route.
5. **Recommendation** — concrete next step, with code.
6. **What We Could Not Determine** — the honest gap inventory.

Throughout, two things are kept strictly apart:

> **(a) streaming audio OUT** — audio flows to the room as it is produced. *Every* LiveKit
> TTS does this, Speechify included. When Speechify's docs say they "stream," this is what
> they mean. It is not our problem and it already works.
>
> **(b) streaming text IN** — the TTS accepts LLM tokens as they are emitted, over a
> persistent connection, returning audio continuously with no per-chunk round trip. This is
> what `capabilities.streaming=False` refers to. **This is our problem.**

---

## 1. The Answer

**Yes, you keep `geffen_32` and Gemini 3.5 Flash. No, you do not get (b) streaming text in
— not from anyone, not with any amount of engineering, because Speechify does not expose a
transport that accepts incremental text.** What you get instead is a set of levers that make
the non-streaming architecture cheap enough to stop noticing.

The route, in order of value per unit of effort:

1. **Run two curls** (Section 5) to test whether `geffen_32` exists in Speechify's Agents
   catalogue and whether the plugin's host accepts `output_format=pcm_24000`. Five minutes.
   The first could open a route to genuine (b); the second unlocks a measured ~130ms/request.
2. **Move the agent to us-east.** Expect Speechify TTFB ~831ms → ~550-800ms and, separately,
   one transpacific round trip removed from every Gemini call. Net gain is real but modest,
   and one term (STT routing) could halve it.
3. **Experiment with `SPEECHIFY_MIN_CHUNK_CHARS`** at 300-400. Your own measurements
   (`agent.py:152-154`) say 400 collapses a typical answer to a single request — which
   eliminates more TTS wall-clock than the entire us-east migration does. The cost is a
   later first word, which is a perceptual judgement only a real call can settle.
4. **Build the custom pipelined plugin only if 1-3 leave you short.** 12-18h, and justify it
   on PCM and gap-removal, not on first-word latency.

The framing correction that matters most: **the load-bearing fix was never geography. It was
chunk size.** `SPEECHIFY_MIN_CHUNK_CHARS = 200` (`agent.py:160`) took you from ~10 requests
per response to 1.9, and from "felt like 10-15 seconds" to "usable." Everything discussed
below is optimization on top of an already-working configuration, not a rescue of a broken
one.

---

## 2. Does the Speechify API Support Streaming Text Input?

**No. Definitively no, on documentation and interface evidence; formally "not established"
only in the narrow sense that an entirely undocumented endpoint cannot be excluded without
credentials — and such an endpoint would be unusable anyway, having no spec, no docs, and no
SDK client.**

### What was checked

Four independent lines of evidence, gathered separately and then adversarially cross-checked:

**1. The machine-readable OpenAPI 3.1 spec.**
[`docs.speechify.ai/openapi/api-reference.json`](https://docs.speechify.ai/openapi/api-reference.json)
(servers: `https://api.speechify.ai`) declares exactly 6 paths / 8 operations:

```
POST   /v1/audio/speech
POST   /v1/audio/stream
GET    /v1/voices          POST /v1/voices
GET    /v1/voices/{id}     DELETE /v1/voices/{id}
GET    /v1/voices/{id}/sample
GET    /v1/audio/models
```

Two of these synthesize audio. Both are HTTP POST. The `GetStreamRequest` schema has
`required: ["input", "voice_id"]` with `input` typed as a plain `string` — one complete
string per request.

**Caveat recorded honestly:** enumerating OpenAPI `paths` is *not* by itself valid evidence
against a WebSocket, because OpenAPI 3.1 has no construct for describing one. ElevenLabs and
Cartesia both ship WebSocket TTS and both would also show "zero WebSocket paths." This line
of evidence is necessary but not sufficient, which is why the other three exist.

**2. The absence of every protocol primitive that streaming text in requires.**
This is the strongest structural argument. Any (b) protocol needs a way to say "more text is
coming for this same synthesis." Cartesia's WebSocket uses `context_id` + `continue` +
`flush`; ElevenLabs' uses incremental `text` messages terminated by an empty string. In
Speechify's entire TTS spec the occurrence counts are:

```
context_id 0   continue 0   flush 0   append 0
partial 0      sequence 0   stream_input 0   incremental 0
```

There is no field with which to signal continuation, so incremental push is impossible
regardless of how the server parses the request body.

**3. The official SDK contains no WebSocket code at all.**
`speechify-api` 3.0.1 declares `httpx, pydantic, pydantic-core, typing_extensions, aiohttp`
— and no `websockets`. Grepping the unzipped wheel for `websocket|wss://|ws_connect` returns
zero matches. By direct contrast, `cartesia` 3.3.0 — which *does* have a WebSocket TTS API —
declares `websockets<16,>=13`. A vendor with a WebSocket API ships a WebSocket client.

The SDK's own type signature states the (a)/(b) split precisely:

```python
# speechify/audio/client.py:116
def stream(self, *, input: str, voice_id: str, ...) -> typing.Iterator[bytes]
```

`input` is one complete `str` — **streaming text IN = false**. The return is
`Iterator[bytes]` yielded as generated — **streaming audio OUT = true**. That is exactly (a)
without (b), expressed in code.

**4. The complete documentation corpus.**
[`docs.speechify.ai/build/llms.txt`](https://docs.speechify.ai/build/llms.txt) enumerates
the entire Build product. All 36 indexed pages were fetched (HTTP 200), plus one live-but-
unindexed page (`build/guides/integrations/pipecat.md`), plus all 17 changelog entries. A
keyword grep across all 37 pages for `websocket | wss:// | ws:// | SSE | server-sent |
event-stream | bidirectional | duplex | incremental | streaming input | flush | context_id |
continuation` returns **exactly one hit**:

```
build/guides/integrations/livekit.md:50   LIVEKIT_URL=wss://your-project.livekit.cloud
```

— which is LiveKit's own signalling URL, not a Speechify endpoint.

> *Method note, because it matters for trust:* an earlier version of this finding claimed the
> corpus was "the entire Build documentation, 28 pages, exhaustive." It was 28 of 36+. The
> eight missing pages were fetched and re-grepped during verification; the result was
> identical, so the conclusion strengthened rather than changed. The original *framing* was
> wrong and has been corrected here.

### Speechify says "streaming." They mean (a).

They have gone out of their way to say so. Changelog entry 2026-06-23 is titled verbatim
*"Docs: response-streaming behaviour on `POST /v1/audio/stream` clarified"* and states:

> "The response body is the **raw audio bytes** delivered over HTTP chunked transfer
> encoding... No API behaviour changed. This is a documentation correction only."

HTTP chunked transfer encoding is a *response*-body framing mechanism, unidirectional
server→client. The request body is fully transmitted before the response begins. The
streaming guide reinforces it: *"delivers audio chunks as they're generated, so your
application can start playback before the full audio is ready."*

**Traps in their vocabulary.** The word "streaming" alone never disambiguates in Speechify's
docs. They call simba-3.2 *"the streaming-native model with lower TTFB"*; a changelog entry
is titled *"API: New simba-3.0 streaming model"*; `llms.txt` describes the Simba family as
*"3.0 streaming."* Read carelessly, all of these sound like (b). They are all (a). The
disambiguation comes from the request schema, never from the vocabulary.

### Is it on their roadmap?

**No documented plan exists.** A grep for `roadmap | coming soon | planned | not yet
supported | in beta | early access | waitlist` across the corpus returns hits — but none
relating to streaming, WebSockets, or input handling. The hits are about multilingual
language coverage (`guides/concepts/models.md:22` "Simba 3.2 | English (multilingual coming
soon)"), SCIM directory sync (`guides/get-started/enterprise-sso.md:52`), and Agents webhook
events. Nothing about (b).

### The one place `wss://` genuinely appears

Speechify's **Agents** product — a separate offering from the Build/TTS API — does operate a
public WebSocket surface. `api-reference-2.json` contains `CreateConversationResponse.url`
("Realtime session wss:// URL to connect to") and `ShadowConversationResponse.signaling_url`
(documented as "listen-only"). The string `livekit` appears 34 times in that spec.

This is **not** a TTS endpoint you can feed Gemini tokens into at the transport layer — it is
the client transport for Speechify's own hosted agent. Whether the *agent behind it* can be
pointed at your own LLM is an open question treated in Section 4(e). Anyone re-running these
greps site-wide will hit `wss://` and may wrongly conclude Speechify offers streaming-input
TTS. It does not.

---

## 3. Why the Plugin Says `streaming=False`

**Both a plugin gap and an API constraint exist — but the API constraint is the binding one.
`streaming=False` is an honest declaration, not laziness.**

### What the plugin actually does

In `livekit-plugins-speechify` 1.6.6 (the newest release on PyPI — no upgrade is pending):

```python
# .venv/.../livekit/plugins/speechify/tts.py:119-125
super().__init__(
    capabilities=tts.TTSCapabilities(
        streaming=False,          # <- line 121
    ),
    sample_rate=_sample_rate_from_encoding(encoding),
    num_channels=1,
)
```

A literal `False`, not derived from any argument. There is exactly one `capabilities`
assignment in the whole package, and the constructor exposes no streaming-related parameter.

The plugin defines **no `stream()` method at all** (`grep "def stream"` → nothing). Calls
therefore fall through to the base class:

```python
# .venv/.../livekit/agents/tts/tts.py:259-264
def stream(self, *, conn_options=...) -> SynthesizeStream:
    raise NotImplementedError(
        "streaming is not supported by this TTS, please use a different TTS or use a StreamAdapter"
    )
```

**A tempting non-fix, tested and rejected:** `TTSCapabilities` is a non-frozen dataclass, so
`tts._capabilities.streaming = True` does flip the flag. Doing so is a trap, not a workaround
— there is no `SynthesizeStream` implementation behind it, so the very next call raises the
`NotImplementedError` above. The flag is a truthful advertisement of an absent feature.

### The plugin *does* do (a) correctly

```python
# tts.py:211-213 — text IN: one complete, immutable string, fixed before the request opens
data = {"input": self._input_text, ...}

# tts.py:228-233 — a single aiohttp POST to {base_url}/audio/stream (tts.py:267)

# tts.py:247 — audio OUT: pushed to the emitter as bytes arrive off the socket
async for chunk, _ in resp.content.iter_chunks():
    output_emitter.push(chunk)
```

So the plugin streams audio out of a request whose text was fully known up front. (a) yes,
(b) no — mirroring the API exactly.

### The cost this imposes, confirmed in LiveKit's source

Because `capabilities.streaming` is `False`, LiveKit wraps the TTS in a `StreamAdapter`
(`voice/agent.py:564-572`), and that adapter is **strictly serial**:

```python
# .venv/.../livekit/agents/tts/stream_adapter.py, inside _synthesize() (line 119)
async for ev in sent_stream:                                   # :123
    ...
    async with self._tts._wrapped_tts.synthesize(              # :132
        text, conn_options=self._wrapped_tts_conn_options
    ) as tts_stream:
        async for audio in tts_stream:                         # :135
            output_emitter.push(audio.frame.data.tobytes())
            duration += audio.frame.duration
        output_emitter.flush()                                 # :138
```

**Chunk N+1's request is not issued until chunk N's audio has fully downloaded.** The
`async with` block cannot exit until the inner `async for` drains. Verified empirically with
a mock TTS at 0.5s simulated latency: four chunks took 2.051s with **zero** overlapping
requests, each starting 2-3ms after the previous ended.

A subtlety worth recording so nobody "fixes" this wrongly: `ChunkedStream` *does* start its
HTTP request eagerly at construction (`agents/tts/tts.py:304, 333`). The serialization is
caused by **call-site placement** — construction happens inside the loop body — not by lazy
initiation. Only two tasks run concurrently (`stream_adapter.py:140-143`), and the other one
(`_forward_input`) merely feeds the tokenizer; it issues no TTS calls.

### Verdict on responsibility

Nobody implemented `stream()` for Speechify — and nobody could have. There is no transport to
implement it against. **`streaming=False` is the plugin correctly reporting an upstream
constraint.** No fork, patch, or upstream PR changes this. The N-serialized-round-trips cost
is structural.

### One genuine plugin defect, independent of streaming

The installed plugin is built against an **older Speechify API contract**:

```python
# models.py
TTSModels   = Literal["simba-english", "simba-multilingual"]          # no simba-3.2
TTSEncoding = Literal["mp3_24000", "wav_48000", "ogg_24000", "aac_24000"]   # no PCM
# tts.py:216 sends the legacy field name:
"audio_format": _audio_format_from_encoding(self._opts.encoding)
# tts.py:55 targets the legacy host:
API_BASE_URL_V1 = "https://api.sws.speechify.com/v1"
```

Two consequences:

- `simba-3.2` works only because `Literal` is not enforced at runtime. A type checker flags
  it. It is passed through to the request body unvalidated.
- **The plugin cannot request raw PCM at all.** The current API documents `output_format`
  with `pcm_8000` … `pcm_48000`. Our own earlier raw-curl testing measured
  `pcm_24000` as **~130ms faster per request** than the mp3 path — a saving that is
  currently unreachable through the plugin. This is an independent, measured reason to
  consider a custom plugin, entirely separate from pipelining.

---

## 4. The Options, Ranked

Ranked by expected value per hour of effort. All latency figures state where they were
measured; simulation results are labelled as such.

### Baseline (what is running today)

| Quantity | Value | Source |
|---|---|---|
| Speechify simba-3.2 TTFB, from India | **831ms** median, **431ms spread** over 5 runs | `agent.py:116`, `compare_tts_headtohead.py` |
| Raw curl, bypassing LiveKit | 890-1317ms | `.notes/HANDOFF-next-session.md:229` |
| Cartesia sonic-3.5 TTFB, from India | 149ms, 12ms spread | `agent.py:115` |
| Requests per response @ 200-char chunks | ~1.9 | measured on real calls |
| Total TTS wait per response | ~1.6s | 1.9 × 831ms |

**The 431ms spread on identical text is important and often missed.** Model compute for a
byte-identical input is near-constant. A 431ms swing across five runs of the *same sentence*
is queueing, cold workers, or autoscaler scheduling — not synthesis compute. Any claim that
"~530ms of the TTFB is region-invariant compute" is unsupported; the residual is a mix of
Speechify-internal network, queue wait, and compute, in unknown proportions.

---

### (a) Move the agent to us-east, keep everything else — **RANK 1**

**Expected latency.** Honestly bounded rather than precisely predicted.

What relocation can remove is the transpacific portion of each Speechify round trip. What it
cannot touch is Speechify's internal residual. Decomposing from measurements taken on the
owner's India link:

- `api.sws.speechify.com` and `api.speechify.ai` both resolve to **34.49.245.64**, which is
  in `34.49.0.0/16`, published by Google as `{"service":"Google Cloud","scope":"global"}` —
  i.e. **global anycast**. Responses carry `server: Google Frontend`, `via: 1.1 google`.
- The anycast edge is genuinely local: ping RTT **9.2ms avg** (8/8), traceroute terminates
  in 11 hops all under 19ms, TCP connect ~18-21ms.
- **But locality buys nothing for request servicing.** On a fully warm, connection-reused
  request (`tcp=0, tls=0`), an origin-generated 401 still costs **~300-310ms**, while a
  load-balancer-generated 301 on port 80 over the same VIP costs **~32-35ms**. That ~265ms
  gap is the edge→origin leg over Google's private backbone, invisible to any client timer.

So of the ~831-1064ms measured TTFB, roughly 300ms is client→origin round trip (of which
~265ms is the long-haul leg), and the remaining ~530-760ms is Speechify-internal.
**Relocation plausibly removes 200-270ms per round trip. It does not remove the residual.**

| | India (today) | us-east (predicted) |
|---|---|---|
| Speechify TTFB | 831-1064ms | **~550-800ms** |
| TTS wait @ 1.9 chunks | ~1.6s | **~1.1-1.5s** |
| TTS wait @ old 20-char default (10 chunks) | ~8.3s | ~5.5-8.0s — *still unusable* |

**The hoped-for 900ms → 150ms drop is not achievable.** Nothing about relocation approaches
Cartesia's 149ms, because Cartesia's 149ms is below the physical floor for any India↔US round
trip — which is itself the proof that Cartesia is served from APAC and Speechify is not.

**Gains beyond Speechify.** The Gemini call becomes intra-US, removing roughly one
transpacific round trip (~240ms) per turn. **This gain is independent of which TTS you
choose** and is arguably the strongest single argument for the move.

**Costs.**

- The **audio path** now crosses the Pacific: user speech up, agent audio down. India↔us-east
  TCP connect measures 278-310ms, so expect roughly +240ms added to end-to-end conversational
  latency. WebRTC optimizes routing but cannot beat propagation delay. LiveKit's own docs are
  explicit that you are defeating a feature they built:
  > "LiveKit Cloud additionally exercises geographic affinity to prioritize matching users and
  > agent servers that are geographically closest to each other."
  — [docs.livekit.io/agents/ops/deployment/custom/](https://docs.livekit.io/agents/ops/deployment/custom/)
- **The Cartesia fallback gets worse.** Cartesia's 149ms is APAC-served; from us-east that
  number will not survive. `agent.py:124` keeps `TTS_PROVIDER` switchable precisely so the two
  can be A/B'd — after a move, any comparison must be re-measured, never compared against the
  existing India numbers.
- **The risk that could halve the gain:** `STT_MODEL = "assemblyai/universal-streaming"`
  (`agent.py:108`) routes through LiveKit Inference, whose regional topology we could not
  determine (four candidate doc URLs returned 404). If that gateway is APAC-pinned, moving the
  agent costs another round trip on every turn.

**Rough per-turn ledger.** Gains: Gemini ~+240ms, Speechify ~+400-500ms (2 chunks × ~220ms).
Losses: audio path ~-240ms. **Net ≈ +400-500ms**, dropping to roughly **+200ms** if the STT
term goes against us.

**Effort:** deployment/config change. A few hours plus re-measurement.
**Risk:** low technically; moderate on payoff, because of the STT unknown.
**Reversible:** yes, trivially.

---

### (b) Custom pipelined plugin — overlap the round trips — **RANK 2 (conditional)**

Write a real `SynthesizeStream` that still uses one HTTP POST per chunk, but fires the
requests concurrently instead of serially, pushing results in submission order.

**Expected latency — and the correction that matters most here:**

> **Pipelining does NOT improve time-to-first-audio.** Measured deltas between serial and
> pipelined were **-0.029s** (4 chunks) and **+0.022s** (10 chunks) — noise. Chunk 1's round
> trip is on the critical path either way. Anyone who claims pipelining reduces TTFB is wrong.

What it fixes is **mid-reply stuttering**. Simulation against the *real* LiveKit
`AudioEmitter`, using an India latency profile calibrated to the owner's own measurements:

| Chunks | Serial | Pipelined |
|---|---|---|
| 10 | 12.01s audio over **13.56s** wall, 2.75s accumulated dead air, 73 stall points | **4.52s** wall, 0.00s worst gap — continuous |
| 4 | 0.91s dead air ("noticeable but tolerable") | continuous |

Frame counts were identical between strategies (41/41, 101/101), confirming ordering was
preserved. The model reproduces the owner's *subjective* reports — 0.91s dead air ↔ "usable";
2.75s ↔ "felt like 10-15 seconds" — which is decent evidence it is faithful.

**But at 200-char chunks there are only 1.9 requests per response**, so there is roughly
0.9 requests' worth of stutter available to eliminate. The dramatic table rows above describe
the 20-char configuration you already abandoned.

**Hard gate — check this before anything else.** Speechify's
[API limits](https://docs.speechify.ai/build/guides/concepts/api-limits) state:

| Plan | Simultaneous requests | Rate |
|---|---|---|
| Free | **1** | 1 rps |
| Paid | 15 | 20 rps |

*"All limits apply per account, not per API key."* **On the free plan, pipelining is
strictly impossible.** On paid, at `MAX_INFLIGHT=3` per call, the account-wide ceiling of 15
permits roughly 5 concurrent phone calls before `concurrency_limit_reached` 429s begin.

**Three implementation risks, all reproduced in testing:**

1. **Ordering.** `AudioEmitter` performs no reordering whatsoever — `push()` order *is*
   playback order (`tts.py:1006-1013` sends into a single channel; `tts.py:1279` consumes it
   sequentially). Fetches must be launched concurrently but *awaited in submission order*.
2. **Codec.** `AudioEmitter` creates **one stateful decoder per segment**
   (`tts.py:1334-1342`) and reuses it. Concatenating independently-framed OGG/MP3 responses
   corrupts it — the source comments spell out the hazard explicitly. A pipelined plugin
   **must** request raw PCM and set `mime_type="audio/pcm"` to take the raw branch
   (`tts.py:1303-1322`). **The installed plugin cannot do this** (Section 3), so this
   requirement and the ~130ms PCM saving point the same direction.
3. **Interruption leaks — reproduced.** Barge-in calls
   `SynthesizeStream.aclose()` → `aio.cancel_and_wait(self._task)` (`tts.py:819-821`), which
   cancels `_run` but **does nothing about tasks `_run` spawned**. Naive pipelining with bare
   `create_task`: peak 8 concurrent, 7 requests still running at barge-in, all 7 completing
   *after* close — leaked, burning the account-wide concurrency budget. With
   `asyncio.Semaphore(3)` plus a `try/finally` cancelling outstanding tasks: peak 3, zero
   in flight, zero leaked.

**A prosody risk that pipelining cannot fix, and which argues against the premise.** Each
Speechify request is an **independent synthesis** — `GetStreamRequest` carries no context or
continuation field, so the model cannot condition chunk N+1 on chunk N. Cross-chunk
intonation continuity is lost, and no amount of network overlap restores it. **This is the
risk most likely to damage the exact thing you are protecting.** It follows that "keep small
chunks AND overlap the round trips" is the wrong target: pipelining should be used to make
*large* chunks cheap, not to make small chunks viable. This is untested by listening and
should be A/B'd before any small-chunk configuration ships.

**Effort: 12-18h (~2 working days).** Grounded in reference sizes: `inference/tts.py`'s
`SynthesizeStream` is 156 lines, `google/tts.py`'s is 109, the whole Speechify plugin is 292.
A working prototype came to ~280 heavily-commented lines. Breakdown: core `_run` 3-4h; live
API testing including boundary prosody 3-4h; barge-in/cancellation correctness 2-3h (where
bugs hide — the leak appeared immediately); 429/retry semantics 2-3h; tuning chunk size and
`MAX_INFLIGHT` against real latency 2-3h.

**A correction to a commonly repeated claim about this work:** it is *not* true that "the
only method you must implement is `_run(output_emitter)`." Three things are also required,
verified by execution:
- `synthesize` is `@abstractmethod` on `TTS` (`tts.py:254-257`) — omitting it raises
  `TypeError: Can't instantiate abstract class ... with abstract method synthesize`.
- **The base class never calls `_mark_started()`** (`tts.py:707`) — every call site is inside
  an implementer's `_run`. Omit it and `tts.py:722` short-circuits, emitting **zero metrics**
  (tested: 4 audio frames delivered, 0 metrics events). For this project that means **no TTFB
  measurement at all, silently** — losing the exact number the whole effort optimizes.
- `_run`'s body is a protocol: it must call `initialize()`, open/close segments, and keep
  segment count in parity with `push_text` or `_main_task` raises (`tts.py:634-642`; tested:
  `RuntimeError: start_segment() must be called before pushing audio data`).

A working prototype exists at
`/private/tmp/claude-501/.../scratchpad/speechify_pipelined.py` — verified to report
`capabilities.streaming == True` and to return a genuine `tts.SynthesizeStream` subclass.
**Never tested against the live Speechify API.**

---

### (c) A true streaming plugin — **IMPOSSIBLE, RANK N/A**

**Closed.** There is no transport to implement against — no WebSocket, no SSE, no
chunked-request mode, no continuation field. Section 2 establishes this four independent
ways. Writing a `SynthesizeStream` that genuinely accepts LLM tokens over a persistent
connection to Speechify is not a hard task; it is an impossible one.

For calibration, had a WebSocket existed this would have been **less** work than (b) —
roughly 8-12h — because the server handles ordering and you inherit LiveKit's
`ConnectionPool` (`agents/utils/connection_pool.py:14`). And its payoff would have been
strictly larger, since it would improve TTFB, which (b) does not. That is the measure of what
Speechify's API gap actually costs.

---

### (d) Switch to Cartesia — **RANK LAST, and you have ruled it out**

Recorded for completeness only. Cartesia via `inference.TTS` has
`capabilities.streaming == True`, measures **149ms TTFB** from India with a 12ms spread
(`agent.py:115`), and issues ~0.9 requests per response. Its 149ms is *below* the physical
floor for an India→US round trip, which is decisive proof it is served from APAC.

Structurally, Cartesia is reachable by LiveKit Inference's co-located gateway (roster:
Cartesia, Deepgram, ElevenLabs, Fish Audio, Inworld, Rime, xAI —
[docs.livekit.io/agents/models/tts/](https://docs.livekit.io/agents/models/tts/)).
**Speechify is not on that list.** It is plugin-only, so the gateway can never co-locate it,
and it has no regional endpoints of its own. That structural exclusion is why "agent near
user AND models near agent" is achievable — but only by giving up the voice.

Cost note in the other direction: Cartesia is $50/1M chars against Speechify's $6-10/1M
(`agent.py:115-116`).

---

### (e) Speechify Agents platform — **UNEVALUATED, and the only route to genuine (b)**

Not in the requested list, but it is the single configuration found anywhere in which the
Speechify voice gets true streaming text input, so it would be dishonest to omit it.

**What the schema says.** From `api-reference-2.json` (the Agents OpenAPI spec):

- `AgentLlmConfigProvider` enum = `["openai", "speechify", "custom"]`, where `custom`
  *"points the worker at any OpenAI / vLLM-compatible endpoint — see base_url,
  credential_id, extra_body."*
- `AgentLLMConfig` exposes `base_url` (*"Custom OpenAI/vLLM-compatible endpoint base URL.
  Required when provider is custom"*) and `credential_id`.
- `AgentVoiceModelName` enum = `["simba-3.0", "simba-3.2"]`.
- `POST /v1/agents/{agent_id}/conversations` returns a short-lived JWT and a realtime
  `wss://` URL.
- The string `livekit` appears 34 times — LiveKit is the realtime provider, so existing
  LiveKit RN client and CallKit work would likely transfer.

Because Speechify runs the TTS inside their own worker, **the per-chunk transpacific round
trip disappears entirely.**

**Why this is flagged UNVERIFIED rather than recommended.** During cross-checking, a
competing reading held that the Agents realtime session is a closed pipeline running
Speechify's own STT/LLM/TTS, and that "BYO" in the Agents guides refers to BYOC SIP trunks
(telephony carriers), not bring-your-own-LLM. These readings are not strictly contradictory
— the *transport* is audio-in/audio-out and closed from the client's perspective, while the
*LLM* may still be configurable server-side via `provider=custom` — but the conflict was not
resolved, and the prose guides and the machine-readable schema pull in different directions.
**Do not act on this without testing it.**

It is also gated on one hard unknown: `GET /v1/agents/voices` serves a *"curated voice
catalogue"* that explicitly **excludes cloned voices**. Whether `geffen_32` is in it could
not be checked without an API key. If it is not, this entire route is closed.

---

## 5. Recommendation

### Step 0 — two curls, five minutes, before anything else

These are the highest-information-per-second actions available, and both are blocked only by
an API key.

```bash
export SPEECHIFY_API_KEY=...   # from platform.speechify.ai

# (1) Is geffen_32 available to the Agents platform?
#     If YES, option (e) is live and could give genuine streaming text IN
#     while keeping BOTH the voice and Gemini. If NO, (e) is closed forever.
curl -s -H "Authorization: Bearer $SPEECHIFY_API_KEY" \
  https://api.speechify.ai/v1/agents/voices | grep -i geffen

# (2) Does the plugin's legacy host accept the modern PCM output field?
#     Our own raw-curl testing measured pcm_24000 as ~130 ms/request faster.
#     The installed plugin cannot request it (TTSEncoding has no pcm member,
#     and it sends the legacy `audio_format` field) — so this gates whether a
#     custom plugin can capture that saving, and on which host.
curl -s -o /dev/null -w "http=%{http_code} ttfb=%{time_starttransfer}\n" \
  -X POST https://api.sws.speechify.com/v1/audio/stream \
  -H "Authorization: Bearer $SPEECHIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Testing raw PCM output from the legacy host.",
       "voice_id":"geffen_32","model":"simba-3.2","output_format":"pcm_24000"}'

# Control: same request against the documented host.
curl -s -o /dev/null -w "http=%{http_code} ttfb=%{time_starttransfer}\n" \
  -X POST https://api.speechify.ai/v1/audio/stream \
  -H "Authorization: Bearer $SPEECHIFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Testing raw PCM output from the documented host.",
       "voice_id":"geffen_32","model":"simba-3.2","output_format":"pcm_24000"}'
```

Also worth one email to Speechify support asking directly whether a WebSocket / streaming-
text-input TTS endpoint exists in private beta or on the roadmap. Their docs contain zero
roadmap language on the subject, so a direct question is the only way to learn about an
unadvertised capability. Given how strongly you prefer this voice, it is cheap and worth
doing.

### Step 1 — move the agent to us-east, then re-measure everything

Highest-value change you have already agreed to. Expect Speechify TTFB ~831ms → ~550-800ms
and one transpacific round trip removed from every Gemini call.

**Re-measure, do not assume.** Specifically: Speechify TTFB from the new host; Cartesia TTFB
from the new host (it will get worse — that baseline must be re-established); end-to-end
turn latency on a real call from India; and whether AssemblyAI STT latency changed, which
tells you whether LiveKit Inference followed you or not.

### Step 2 — sweep the chunk size, because it may beat the migration

Your own measurements on a 342-char answer (`agent.py:152-154`):

```
min_sentence_len = 20   -> 10 chunks -> ~8.1s of added gaps   (the old default, unusable)
min_sentence_len = 150  ->  2 chunks -> ~0.9s
min_sentence_len = 400  ->  1 chunk  -> 0s
```

At one chunk the TTS wall-clock cost from India is a single 831ms request, versus ~1.6s
today — **a larger saving than the entire us-east migration**, at zero infrastructure risk.
The trade is a later first word, because TTS waits for more text before it can start. That is
a perceptual question, not an arithmetic one, and only a real call settles it.

Change one constant in `phase2-agent/agent.py:160`:

```python
SPEECHIFY_MIN_CHUNK_CHARS = 200   # try 300, then 400
```

**Note this is a tuning sweep, not a fix — the wrapping is already correct.** `agent.py:187-192`
already pre-wraps Speechify with an explicit tokenizer, deliberately bypassing the
auto-wrap that would otherwise use LiveKit's 20-char blingfire default (`voice/agent.py:564-572`):

```python
return tts_lib.StreamAdapter(
    tts=engine,
    sentence_tokenizer=basic_tokenize.SentenceTokenizer(
        min_sentence_len=SPEECHIFY_MIN_CHUNK_CHARS
    ),
)
```

Anyone proposing "pre-wrap the StreamAdapter yourself" as a new fix is describing what you
shipped in commit `7ff0aaa`. Adopting it changes nothing; the ~1.6s figure is measured *with*
it in place. Swapping the `basic` tokenizer for `blingfire` is likewise a no-op: on a 303-char
answer, `basic(200)` gives 2 chunks of [240, 62] and `blingfire(200)` gives 2 chunks of
[240, 63].

### Step 3 — build the pipelined plugin only if Steps 1-2 leave you short

And if you do, **justify it on PCM and gap-removal, not on first-word latency**, because
pipelining measurably does not touch TTFB. Before starting, confirm the account is on the
**paid** plan — on free, 1 simultaneous request makes pipelining impossible and the entire
option evaporates.

### Step 4 — the listening test, whatever else you do

A/B the same reply synthesized as one request versus split across four. Each Speechify
request is an independent synthesis with no cross-chunk context, so intonation may audibly
reset at boundaries. **You chose this voice because it sounds better; the one failure mode
that would silently undo that choice is invisible to every latency number in this document.**

---

## 6. What We Could Not Determine

Stated plainly, because on this project an honest "could not determine" has been worth more
than a confident wrong claim.

**Blocked on credentials — no Speechify API key was available to any research stream.**

- Whether **`geffen_32` is in the Agents curated voice catalogue.** The single most
  decision-relevant unknown in this document. It alone decides whether option (e) exists.
- Whether **`output_format=pcm_24000` works** on the plugin's host (`api.sws.speechify.com`)
  or requires moving to `api.speechify.ai`. Gates the measured ~130ms/request saving.
- Whether an **undocumented endpoint** exists under `/v1/audio/*`. Speechify authenticates
  *before* routing on that prefix — a deliberately bogus path like
  `/v1/audio/zzzz_not_real_9f3b` returns 401, identical to `/v1/audio/stream` — so
  unauthenticated probing cannot distinguish "exists" from "does not exist" there. The
  discriminator *is* clean one level up (`/v1/zzz_nope` returns a Go-style
  `404 page not found`), and only `/v1/audio`, `/v1/voices`, `/v1/agents` are registered;
  `/v1/tts`, `/v1/ws`, `/v1/websocket`, `/v1/realtime`, `/v1/stream` and
  `/v1/text-to-speech` all 404, including under a full RFC6455 upgrade handshake.
  **An undocumented WebSocket cannot be formally excluded** — though with no spec, no doc
  page, and no SDK client, it would be unusable in production regardless.

**Blocked on infrastructure opacity.**

- **Speechify's actual origin region.** The global anycast LB (34.49.245.64) masks it
  completely, and no response header leaks a region. We established the origin is *not* local
  to India (~32ms for what the edge answers vs ~300ms for what the origin answers, same VIP)
  but **not** that it is specifically in us-east. India→us-east TCP connect measures
  278-310ms and India→us-west 294-326ms — only a 15-30ms difference — so the two are not
  well discriminated from here. If the origin is us-west, an agent in us-east retains a small
  intra-US hop.
- **LiveKit Inference's regional topology.** Four candidate doc URLs returned HTTP 404
  (`/home/cloud/regions/`, `/home/cloud/deployment-regions/`, `/agents/ops/deployment/regions/`,
  `/inference/`). This blocks a confident answer on whether AssemblyAI STT follows the agent
  to us-east, which is the term that could halve the net gain. **Worth asking LiveKit support
  directly rather than inferring.** Relatedly, Cartesia's 149ms proves APAC serving but not
  Mumbai specifically — Singapore fits equally well, and the ~72-83ms TCP connect to
  `rabbitwhole-422ywtyh.livekit.cloud` points more toward Singapore than Mumbai.

**Blocked on lack of a US vantage point.**

- **No Speechify measurement from us-east exists.** The ~550-800ms prediction is arithmetic
  (measured TTFB minus an estimated long-haul component), not an observation. Deploy a probe
  to us-east and re-run the existing measurement before committing to the move.

**Not measured, only simulated.**

- **All pipelining figures** (13.56s → 4.52s, dead-air totals, stall counts) come from a mock
  calibrated to the owner's own India measurements, run against the *real* LiveKit
  `AudioEmitter`. The mock reproduces the owner's subjective reports faithfully, which is good
  evidence it is directionally sound. **They are not live measurements and must not be quoted
  as such.**
- The claim that **us-east alone makes the serial StreamAdapter continuous even at 20-char
  chunks** is a simulation result resting on an assumed post-move RTT. Treat it as a
  hypothesis to test after the move, not as a finding.

**Not tested at all.**

- **Audio quality at chunk boundaries.** Completely untested by listening. Since each request
  is an independent synthesis, splitting a reply may audibly reset intonation. This is the
  risk most likely to damage the exact thing you are trying to preserve, and it can only be
  settled by ear.
- **Whether a chunked-transfer request body** to `/v1/audio/stream` behaves differently. The
  schema makes it near-moot (a required complete `input` string, no continuation field), but
  it was never empirically pushed.
- **Whether `provider=custom` actually works with Gemini 3.5 Flash**, including tool/function
  calling. The Agents spec says "any OpenAI / vLLM-compatible endpoint," which is a
  compatibility *claim*, not a tested integration.
- **Where Speechify's Agents realtime infrastructure runs geographically.** The whole benefit
  of (e) hinges on their worker being close to their TTS. If the LiveKit room is US-hosted, you
  trade N transpacific TTS round trips for one transpacific audio path — likely still a large
  net win, but it should be measured, not assumed.

**Search coverage gap.**

- WebSearch budget was exhausted early in every stream, so **no community reports, GitHub
  issues, forum posts, or vendor support statements** were consulted. All conclusions rest on
  first-party documentation fetched directly, the machine-readable OpenAPI specs, the official
  SDK wheel, and installed source. That is strong evidence, but it is not an exhaustive search
  of all public claims.

---

## Appendix: Claims Investigated and Rejected

Recorded so they do not resurface as fact in a later session.

| Claim | Status |
|---|---|
| "Relocation saves exactly 243ms — a hard physical ceiling" | **Refuted.** Measured to `ec2.us-east-1.amazonaws.com`, not to Speechify. Speechify's edge is ~9ms from India via Google anycast; the long-haul leg is edge→origin and is not directly measurable from a client. |
| "~530ms of the TTFB is region-invariant *synthesis compute*" | **Refuted.** The 431ms spread across five runs of identical text shows much of it is queueing/scheduling. The residual also contains an unmeasured Speechify-internal network hop; its composition is unknown. |
| "The 300ms warm round trip proves the origin is in us-east" | **Refuted.** Global anycast + no region headers makes the origin region unmeasurable from a client. |
| "Pre-wrapping StreamAdapter at `min_sentence_len=200` is a zero-code fix" | **Refuted.** It is the deployed status quo (`agent.py:187-192`, commit `7ff0aaa`). Adopting it yields zero improvement. |
| "LiveKit does not expose the chunk-size knob" | **Refuted.** It is exposed via `StreamAdapter(sentence_tokenizer=...)` and via overriding `Agent.tts_node`, and you already use the first. |
| "The only method a streaming TTS must implement is `_run()`" | **Refuted.** `synthesize` is also abstract; `_mark_started()` is never called by the base class (omit it and TTFB metrics silently vanish); and `_run` has an enforced internal segment protocol. |
| "An exhaustive 28-page doc grep found nothing" | **Refuted on scope, conclusion upheld.** It was 28 of 36+ pages. All omitted pages were fetched and re-grepped: zero hits, so the conclusion strengthened. |
| "The only 'coming soon' language in the docs concerns multilingual support" | **Refuted.** SCIM directory sync and Agents webhook events also appear on documented roadmaps. No streaming-text-input roadmap language exists — that part stands. |
| "Zero WebSocket paths in the OpenAPI spec proves no WebSocket exists" | **Refuted as a method.** OpenAPI 3.1 cannot describe WebSockets; the argument is vacuous on its own. The conclusion holds on other evidence (SDK dependencies, request schema, docs index). |
| "`api.sws.speechify.com` is faster than `api.speechify.ai` because of geography" | **Refuted.** Both resolve to the identical IP, 34.49.245.64. The same anycast address cannot differ by distance. |

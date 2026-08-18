# Hosted expressive TTS — Aug 2026

_Research date: 2026-08-18. Scope: hosted TTS that is **expressive/context-aware**, exposes **word- or character-level timestamps**, and is callable **directly from a browser** by a static Vercel site with a user-supplied key in localStorage._

**Companion docs in this folder:** [`tts-web-research-2026.md`](./tts-web-research-2026.md) (the mechanics — chunking, playback-rate sync, CSS Custom Highlight API), [`folio-integration-constraints.md`](./folio-integration-constraints.md) (why per-word `<span>`s are disqualified), [`api-azure-speech-raw.md`](./api-azure-speech-raw.md) (Azure request/response schemas).

Every claim below is tagged **VERIFIED** (I fetched the page or ran the request on 2026-08-18) or **INFERRED** (reasoned, single-sourced, or carried over from earlier in-repo research). CORS results are from live preflights I ran today, not from documentation.

---

## TL;DR — what's worth paying for, and how much

- **CORS is a non-issue.** I preflighted 19 TTS hosts today. **17 of 19 allow direct browser calls** with a bearer/API-key header. This does not narrow the field at all. Only **PlayAI/PlayHT** (no OPTIONS response at all) and **Fish Audio** (no `Access-Control-Allow-Origin` on any response) actually fail. **Amazon Polly is disqualified separately** — it requires AWS SigV4 request signing, which needs a server. (VERIFIED)
- **The premise of the question turns out to be wrong.** Hume Octave 2 — the most explicitly "LLM-native, context-aware" product on the market — ranks **57th of 95** on the Artificial Analysis TTS Arena (Elo 1057) while charging **$150/1M chars**. Speechify Simba 3.2 ranks **3rd** (Elo 1240) at **$10/1M**. Context-aware marketing does not predict blind-listening wins. (VERIFIED)
- **The winner on every axis at once is Speechify Simba 3.2.** Arena #3, **word-level** speech marks with character offsets into your submitted text (the single best timestamp format for this app), browser CORS confirmed, **$10/1M** on a $10/mo plan, 50k chars/mo free with no card. A 137k-char document costs **$1.37**.
- **Cartesia Sonic is the quality ceiling** (Sonic 3.6 is Arena **#1**, Elo 1283) and it *does* expose `word_timestamps` — but only on the **SSE** endpoint, which I confirmed returns `ACAO: *`. It costs ~4× Speechify (**$5.37/doc**). Worth it only if you A/B the voices and genuinely prefer it.
- **ElevenLabs is the trap.** Its expressive model (`eleven_v3`, audio tags, "dramatic delivery") and its `/with-timestamps` endpoint appear to be **mutually exclusive** — the timestamps endpoint documents only character alignment and defaults to `eleven_multilingual_v2`; `eleven_v3` is not listed as supported. And v3 caps at **5,000 chars**, so a 137k doc is 28+ requests. At **$100/1M** it is 10× Speechify for a model ranked **8 places lower**.
- **Yes, the gap over macOS Premium is real — but smaller than the price gap.** macOS Premium voices sit around the Azure Neural tier (Elo ~1031, INFERRED). Simba 3.2 at 1240 is a ~209-point gap ≈ **77% blind preference**. That is genuinely audible. But the Arena scores **short expressive clips**, not 90-minute narration — and Amazon's purpose-built **Polly Long-Form scores only 1042 (#63)**, which tells you the benchmark rewards drama, not narration stamina. Treat 77% as an upper bound for your use case.
- **There is no cheap "audiobook tier" anywhere.** I checked. Polly's Long-Form voices cost **$100/1M vs $16/1M** for Neural — long-form is *more* expensive, not less. No provider discounts batch/offline synthesis. The only lever is volume tiers.
- **The real cost lever is caching, and it has an architectural cost.** 137k chars ≈ 133 minutes ≈ **~120 MB of MP3**. localStorage (5–10 MB) cannot hold one document's audio. Caching requires the Cache API or IndexedDB, which the project's `CLAUDE.md` explicitly says not to add without discussion. **Without caching, every re-read re-bills.**

---

## A. Provider comparison

Costs are per **1M characters**; `$/137k doc` is one full read-through of a 137,000-char document.

| Provider / model | Expressive / context-aware | Word timestamps | Browser CORS (live preflight) | $/1M chars | $/137k doc | Free tier |
|---|---|---|---|---|---|---|
| **Speechify Simba 3.2** | Good; Arena **#3** (1240). No explicit context API | ✅ **Word-level + char offsets into input** | ✅ 200, reflects Origin, allows `Authorization` | **$10** (→$6 at Scale) | **$1.37** | **50k chars/mo, no card** |
| **Cartesia Sonic 3.5 / 3.6** | Excellent; Arena **#1** (1283) | ✅ `add_timestamps` → `{words[],start[],end[]}` sec — **SSE endpoint only** | ✅ 200, **`ACAO: *`** on `/tts/sse` | ~$39 (Startup) / $50 (Pro) | **$5.37** | 20k credits/mo |
| **Azure Neural / Neural HD** | Modest; Neural 1031 (#68), **HD 2.5 1132 (#22)** | ✅ **`WordBoundary`: `audioOffset`+`textOffset`+`wordLength`** (JS SDK, WebSocket) | ✅ 204, **`ACAO: *`**, allows `ocp-apim-subscription-key` — **no token backend needed** | ~$16 / ~$22 (INFERRED) | $2.19 / $3.01 | **500k chars/mo, forever** |
| **Inworld Realtime TTS-2** | **Yes** — "natural language steering", Arena #8/#10 (1195/1188) | ✅ Timestamps + phonetics + visemes | ✅ 200, reflects Origin | $25 (→$12.50 Growth) | $3.43 | 70 min TTS |
| **Inworld TTS-2 Flash** | ❌ No steering on Flash | ✅ Timestamp alignment | ✅ 200 | $15 (→$7) | $2.06 | shared |
| **Hume Octave 2** | **Claims most**; `context` + `description` acting directions. Arena **#57** (1057) | ✅ `include_timestamp_types` → word **and** phoneme, ms | ✅ 200, allows `x-hume-api-key` | **$150** (→$50 Business) | **$20.55** | 10k chars/mo |
| **ElevenLabs `eleven_v3`** | Audio tags, "dramatic delivery". Arena #11 (1179) | ❌ **Not listed as supported by `/with-timestamps`** (INFERRED) | ✅ 200, `ACAO: *`, `ACAH: *` | $100 | $13.70 | small |
| **ElevenLabs `multilingual_v2` / `flash_v2_5`** | Modest; 1104 (#32) / 1084 (#38) | ⚠️ **Character-level only** (`character_start_times_seconds[]`) — fold to words yourself | ✅ 200, `ACAO: *` | $100 / $50 | $13.70 / $6.85 | small |
| **Deepgram Aura-2** | Modest, agent-tuned | ❌ **None documented** | ✅ 200, reflects Origin | $30 | $4.11 | **$200 credit, no card** |
| **OpenAI `gpt-4o-mini-tts`** | Steerable via `instructions` (accent/emotion/tone/whisper). TTS-1 HD 1107 (#29) | ❌ **None. Confirmed still true Aug 2026** | ✅ 200, reflects Origin | ~$12–15 | ~$1.85 | none |
| **Google Gemini 3.1 Flash TTS** | **Yes** — audio tags + "Director's Notes". Arena **#5** (1211) | ❌ **None of any kind** | ✅ 200, allows `x-goog-api-key` | n/p | — | AI Studio quota |
| **Google Cloud Chirp 3: HD** | Modest; 1057 (#56) | ⚠️ SSML `<mark>` timepoints — **start times only**, one `<mark>` per word | ✅ 200, reflects Origin | ~$30 (INFERRED) | ~$4.11 | 1M chars/mo (Std) |
| **Groq `canopylabs/orpheus-v1-english`** | "Vocal direction controls" | ❌ None documented | ✅ 204, `ACAO: *` | not published | — | Groq free tier |
| **Rime Coda / Arcana v3 / Mist v2** | Mixed; 1058 / 1004 / 899 | ❌ None in quickstart docs | ✅ 200, `ACAO: *` | not published | — | — |
| **Smallest.ai Lightning V3.1 Pro** | Arena **#9** (1193) | ❓ not documented | ✅ 204, reflects Origin | ~$0.09/min only (unclear) | — | — |
| **Resemble Chatterbox HD** | 1095 (#33) | ❓ | ✅ 200, reflects Origin | — | — | — |
| **Neuphonic** | **936 (#84)** — poor | ❓ | ✅ 200, reflects Origin | — | — | — |
| **LMNT** | **977 (#78)** — poor | ❓ | ✅ 204, `ACAH: *,X-API-Key` | — | — | — |
| **Amazon Polly (Neural / Long-Form)** | Neural 887 (#91); Long-Form 1042 (#63) | ✅ Speech Marks (word-level) | ❌ **DISQUALIFIED — AWS SigV4 signing requires a server** | $16 / **$100** | $2.19 / $13.70 | 1M Neural/mo (12mo) |
| **PlayAI / PlayHT** | — | — | ❌ **No OPTIONS response at all → preflight fails** | — | — | — |
| **Fish Audio S2.1 Pro** | 1144 (#17) | ❓ | ❌ **No `Access-Control-Allow-Origin` on any response** | — | — | — |

### The live CORS preflights (VERIFIED 2026-08-18)

Every row above marked ✅ came from a real request of this shape, `Origin: https://folio.vercel.app`:

```bash
curl -i -X OPTIONS "<endpoint>" \
  -H "Origin: https://folio.vercel.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

The three that decide the question:

```
=== https://api.cartesia.ai/tts/sse
    HTTP/2 200
    access-control-allow-origin: *
    access-control-allow-headers: Authorization, Content-Type, Cartesia-Version

=== https://api.hume.ai/v0/tts
    HTTP/2 200
    access-control-allow-origin: https://folio.vercel.app
    access-control-allow-headers: origin, x-requested-with, accept, content-type,
      authorization, x-hume-preview-hostname, x-hume-api-key, ...

=== https://eastus.tts.speech.microsoft.com/cognitiveservices/v1
    HTTP/2 204
    access-control-allow-origin: *
    access-control-allow-headers: ocp-apim-subscription-key,content-type,x-microsoft-outputformat
```

**The Azure result specifically answers the question you asked.** The REST synthesis endpoint returns `ACAO: *` and explicitly allows `ocp-apim-subscription-key`. **A browser can use the raw subscription key directly — no token-minting backend is required.** The caveat is that the REST endpoint returns audio bytes only; `WordBoundary` events come from the **JS SDK over WebSocket**, and WebSockets are not subject to CORS at all, so `SpeechConfig.fromSubscription(key, region)` works client-side either way. (VERIFIED: `wordBoundary` is a documented property of `SpeechSynthesizer` in `microsoft-cognitiveservices-speech-sdk`.)

The two failures:

```
=== https://api.play.ai/api/v1/tts/stream   -> (empty response, no headers at all)
=== https://api.play.ht/api/v2/tts/stream   -> (empty response, no headers at all)
=== https://api.fish.audio/v1/tts           -> OPTIONS 404; POST returns 401 with NO ACAO header
```

Both would be blocked by the browser. **Amazon Polly** is a different failure mode and worth stating plainly: it authenticates with **AWS Signature Version 4**, which requires an HMAC chain over a secret access key. Handing a browser an AWS secret key is both a security problem and impractical to scope. **Polly is disqualified for a no-backend static site regardless of its CORS headers.**

---

## B. Which are genuinely context-aware vs marketing

### B.1 The independent benchmark

The Artificial Analysis TTS Arena is blind pairwise human preference across 95 models — the only vendor-neutral number available. Full leaderboard fetched 2026-08-18 (VERIFIED):

| # | Model | Elo | | # | Model | Elo |
|---|---|---|---|---|---|---|
| 1 | **Cartesia Sonic 3.6** | **1283** | | 26 | Speechify Simba 3.0 | 1124 |
| 2 | Alibaba Qwen-Audio-3.0-TTS-Plus | 1240 | | 29 | OpenAI TTS-1 HD | 1107 |
| 3 | **Speechify Simba 3.2** | **1240** | | 31/32 | ElevenLabs Turbo v2.5 / Multilingual v2 | 1104 |
| 4 | VUI Labs Luna TTS | 1219 | | 38 | ElevenLabs Flash v2.5 | 1084 |
| 5 | Google Gemini 3.1 Flash TTS | 1211 | | 44 | Cartesia Sonic 3 | 1072 |
| 7 | Cartesia Sonic 3.5 | 1204 | | 55 | Rime Coda | 1058 |
| 8 | Inworld Realtime TTS 1.5 Max | 1195 | | 56 | Google Chirp 3: HD | 1057 |
| 9 | Smallest.ai Lightning V3.1 Pro | 1193 | | **57** | **Hume AI Octave 2** | **1057** |
| 10 | Inworld Realtime TTS-2 (preview) | 1188 | | 63 | Amazon Polly **Long-Form** | 1042 |
| 11 | ElevenLabs Eleven v3 | 1179 | | 68 | Microsoft Azure Neural | 1031 |
| 17 | Fish Audio S2.1 Pro | 1144 | | 69 | Hume AI Octave TTS (v1) | 1031 |
| 22 | **Microsoft Azure HD 2.5** | **1132** | | 75 | Rime Arcana v3 | 1004 |
| 25 | Fish Audio S2 Pro | 1126 | | 84 | Neuphonic TTS | 936 |

### B.2 Genuinely context-aware, by mechanism

These four expose an API surface that actually conditions prosody on meaning or surrounding text, rather than just accepting per-sentence knobs:

1. **Hume Octave 2** — the most honest implementation. `context` accepts **prior utterances** so prosody carries across request boundaries; `description` gives natural-language acting directions; `include_timestamp_types` returns word and phoneme timing. This is real engineering, not a wrapper. (VERIFIED, `dev.hume.ai/reference/text-to-speech-tts/synthesize-json`.) **It also ranks 57th and costs $150/1M.** Being architecturally context-aware and sounding good are apparently different problems.
2. **Google Gemini TTS** — built on an actual LLM; docs describe an "Audio Profile / Scene / Director's Notes" prompt structure and inline `[whispers]`-style tags, and state the model "knows not only what to say, but also how to say it". Arena #5 confirms it works. **Zero timestamps of any kind**, so it cannot drive word highlighting. (VERIFIED)
3. **Inworld Realtime TTS-2** — "natural language steering for more contextually aware speech", plus timestamps with phonetics and visemes. Arena #8/#10. **This is the only provider that has genuine steering AND timestamps AND a mid-range price.** (VERIFIED)
4. **OpenAI `gpt-4o-mini-tts`** — `instructions` steers accent, emotional range, intonation, speed, tone, whispering. Genuinely steerable, but the steering is *global per request*, not derived from the text's meaning. **No timestamps.** (VERIFIED)

### B.3 Marketing, or at least oversold

- **ElevenLabs v3 "audio tags"** are *manual* markup you write (`[excited]`, `[whispers]`). The model does not infer them from meaning — you do. That is authoring control, not context-awareness. And per the model table, audio tags are documented only for `eleven_v3_conversational`. (VERIFIED)
- **Cartesia Sonic** makes no strong context claim at all and wins the Arena anyway. Its advantage is raw acoustic quality and naturalness, not semantic understanding.
- **Speechify Simba 3.2** likewise makes no context-API claim and ranks #3. 
- **Hume** is the clearest gap between claim and measured outcome in this whole survey.

### B.4 Whole-paragraph prosody vs sentence-by-sentence

Directly answering B.1 of the brief: **only Hume (`context`) and Gemini (32k-token session window) document mechanisms that shape prosody across more than one utterance.** (VERIFIED) Everyone else — Speechify, Cartesia, ElevenLabs, Azure, Inworld, OpenAI — synthesizes the chunk you send with prosody derived from that chunk alone. In practice this matters less than it sounds, because **you control chunk size**: sending a full paragraph rather than a sentence gets you paragraph-level prosody from any of them. The models with 10k–40k char limits (`eleven_flash_v2_5` at 40k, `eleven_multilingual_v2` at 10k) give you more room to do that than the 5k-char models (`eleven_v3`, Hume).

---

## C. Long-form narration quality — is the gap over macOS Premium real?

**Short answer: yes, but it is smaller than the leaderboard implies, and the leaderboard is measuring the wrong thing for you.**

### C.1 The arithmetic

macOS Premium voices (Ava, Zoe, Evan) are not on the Arena. Placing them requires inference: they are neural, 22–48 kHz, highly intelligible, with flat prosody and no semantic inflection — behaviourally the same class as **Azure Neural (Elo 1031)**. I'd put them at **1020–1060**. (INFERRED — this is a judgement call, not a measurement.)

Converting Elo gaps to blind preference with the standard logistic:

| Comparison | Elo gap | Blind preference for the paid model |
|---|---|---|
| Cartesia Sonic 3.6 vs macOS Premium (~1031) | 252 | **~81%** |
| Speechify Simba 3.2 vs macOS Premium | 209 | **~77%** |
| ElevenLabs v3 vs macOS Premium | 148 | ~70% |
| Azure HD 2.5 vs macOS Premium | 101 | ~64% |
| **Hume Octave 2 vs macOS Premium** | **26** | **~54% — statistically a coin flip** |

So a listener told to pick between Simba 3.2 and Ava picks Simba about three times in four. That is a real, audible difference — not a placebo. **But Hume Octave 2, the most expensive option in this survey at $150/1M, is a coin flip against a free OS voice.**

### C.2 Why the benchmark overstates the gap for *your* use case

Three reasons to discount the numbers above, in order of importance:

1. **The Arena scores short clips.** Preference on a 10-second sample is dominated by timbre, warmth, and expressive range — exactly the qualities that fatigue over 90 minutes. Nothing in the methodology tests stamina.
2. **The strongest direct evidence is Polly Long-Form at #63 (Elo 1042).** Amazon built that voice family specifically for audiobooks and long-form narration, and it scores *below* Chirp 3 HD and barely above Azure Neural. Either Amazon failed, or **the Arena systematically under-rewards the steady, low-variance delivery that long-form narration actually wants.** I think it is mostly the latter.
3. **Expressiveness is a liability here, and you already said so.** You are reading documents, not performing audiobooks. "Dramatic delivery" (ElevenLabs v3's own phrase) applied to 20,000 words of prose is actively worse than neutral delivery. The models optimised hardest for expressiveness are optimised for conversational agents and character voices.

### C.3 The honest verdict on C

The complaint you actually have about macOS Premium — that it "doesn't infer prosody from sentence meaning" — is a **real** deficiency and the paid models do fix it. Sentence-final intonation, question contours, clause-boundary pausing, and emphasis on contrastive words are all noticeably better on Simba 3.2 and Sonic 3.x. Over a 90-minute document that reduces the "reading a list" quality that makes OS voices tiring.

But: **no hosted model will be 4× better, and you should not expect the 77% number to feel like 77%** when the material is expository prose rather than dialogue. Budget one afternoon to A/B **the same three paragraphs** through Speechify Simba 3.2, Cartesia Sonic 3.5, and Ava before committing. Both have free tiers that cover this (Speechify 50k chars no-card; Cartesia 20k credits). If the difference does not survive that test on your own text, the honest answer is to keep `speechSynthesis` and spend the effort elsewhere.

---

## D. Cost at 5 docs/week

**Assumptions:** 137,000 chars/document. 5 documents/week × 52/12 = **21.67 documents/month = 2,968,333 chars/month**. This is the **no-caching worst case** — see the note below, which changes the picture completely.

| Provider | $/1M | $ per 137k doc | $/month (5 docs/wk, uncached) | Notes |
|---|---|---|---|---|
| **Speechify Starter** | $10 | **$1.37** | **$29.68** ($10 plan + $19.68 overage) | Best plan fit; Pro at $99/3M is *worse* here |
| Speechify Scale | $6 | $0.82 | $499 flat (10M incl.) | Only rational above ~8M chars/mo |
| **Azure Neural** | ~$16 | $2.19 | **$39.49** (after 500k free) | INFERRED price; free tier is 3.6 docs/mo |
| Azure Neural HD 2.5 | ~$22 | $3.01 | $54.30 | Arena #22; INFERRED price |
| Inworld TTS-2 Flash | $15 | $2.06 | $44.52 | No steering on Flash |
| Inworld TTS-2 | $25 | $3.43 | $74.21 | Steering + timestamps |
| Deepgram Aura-2 | $30 | $4.11 | $89.05 | **No timestamps — unusable here** |
| **Cartesia (Startup)** | ~$39 | **$5.37** | ~$116 | Arena #1; credit≈char is INFERRED |
| ElevenLabs Flash v2.5 | $50 | $6.85 | $148.42 | Arena #38 — cheap tier is the *weak* model |
| ElevenLabs v3 / Multilingual v2 | $100 | $13.70 | $296.83 | v3 likely can't do timestamps |
| **Hume Octave 2** | **$150** | **$20.55** | **$445.25** | Arena #57. Worst value in the survey |

### Free tiers and whether you can audition before funding

| Provider | Free allowance | Card required to try? |
|---|---|---|
| **Deepgram** | **$200 credit** (≈6.6M chars on Aura-2) | **No** — but no timestamps, so moot |
| **Azure** | **500k chars/month, permanent** | Azure account (card on file, but F0 never bills) |
| **Speechify** | 50k chars/month, hard cap | **No card** |
| Cartesia | 20k credits/month | No |
| Inworld | ~70 min TTS | No |
| Amazon Polly | 1M Neural chars/mo, first 12 months | AWS account (card) — and SigV4 blocks browser use anyway |
| **Hume** | **10k chars/month** (~7% of one document) | No — but 10k chars is too small to audition a document |

**Note the Hume free tier is 10,000 characters — you cannot even synthesize a tenth of one of your documents before paying.** Azure's 500k/month permanent free tier is by far the most generous of any option that also has usable timestamps: **it covers 3.6 documents every month, forever, at zero cost.**

### The caching caveat that dominates every number above

Your brief says the documents are **"read repeatedly."** Synthesis is deterministic — you pay once per document, not once per read, *if you cache the audio and the timing map*. That makes the steady-state cost **new documents only**, and the table above becomes a one-time onboarding cost rather than a monthly bill.

**The obstacle is storage, and it collides with this repo's stated architecture.** 137,000 chars ≈ 20,000 words ≈ 133 minutes of speech ≈ **120–130 MB** as 128 kbps MP3. Per `CLAUDE.md`, Folio persists everything in **localStorage**, which caps at 5–10 MB — **three orders of magnitude too small for a single document's audio.** Caching therefore requires the Cache API or IndexedDB, and `CLAUDE.md` says explicitly: *"Don't introduce IndexedDB or a service worker without discussing — the whole app assumes synchronous reads from `FolioStore`."*

That is a genuine architectural decision, not an implementation detail. **Three options:**
- **Cache audio in the Cache API / IndexedDB, keep only the timing map in localStorage.** The timing map for 20k words is roughly 400–600 KB of JSON — that alone is near the localStorage ceiling and probably also belongs in IndexedDB.
- **Don't cache; accept re-billing per read.** At Speechify's $1.37/doc this is defensible if re-reads are infrequent. At Hume's $20.55 it is not.
- **Cache only in the Electron build** (which has a real filesystem) and re-synthesize on the web build.

---

## E. Cheapest option that keeps word timing

Ranked by cost per 137k document, restricted to options that actually produce word-level (or usable character-level) timing **and** work from a browser:

| Rank | Option | $/doc | Timing quality | Arena | Verdict |
|---|---|---|---|---|---|
| **1** | **Azure Neural (first 500k chars/mo)** | **$0.00** | `WordBoundary` with `textOffset` + `wordLength` — **char offsets into your input, best-in-class** | 1031 | **Free for 3.6 docs/month, forever.** But quality ≈ macOS Premium, so it buys you nothing over `speechSynthesis` on expressiveness |
| **2** | **Speechify Simba 3.2** | **$1.37** | Word-level marks **+ char offsets into input** | **1240 (#3)** | ⭐ **The recommendation.** Best quality-per-dollar by a wide margin |
| 3 | Azure Neural (beyond free tier) | $2.19 | Best-in-class | 1031 | Good fallback; free tier makes it the best *trial* |
| 4 | Inworld TTS-2 Flash | $2.06 | Timestamp alignment | ~1188 | Cheap and high-ranked, but Flash drops the steering |
| 5 | Azure HD 2.5 | $3.01 | Best-in-class | 1132 (#22) | Meaningful quality bump over Neural at same plumbing |
| 6 | Inworld TTS-2 | $3.43 | Timestamps + phonetics + visemes | 1188 (#10) | Only "real steering + timestamps + sane price" combo |
| 7 | **Cartesia Sonic 3.5/3.6** | **$5.37** | `word_timestamps` **SSE only**; no char offsets | **1283 (#1)** | The quality ceiling, at ~4× Speechify |
| 8 | ElevenLabs Flash v2.5 | $6.85 | Character-level; fold to words | 1084 (#38) | Bad value — weakest model at 5× the price |
| 9 | ElevenLabs Multilingual v2 | $13.70 | Character-level | 1104 (#32) | Bad value |
| 10 | Hume Octave 2 | $20.55 | Word **and** phoneme, ms | 1057 (#57) | **Worst value in the survey** |

**Answer to question D — is there a cheap AND expressive AND timestamped option?** **Yes: Speechify Simba 3.2**, and it is not close. Arena #3 at $10/1M, with the most convenient timestamp format available (word-level with character offsets straight back into the string you submitted, which is exactly what `js/highlights.js`'s range machinery wants).

**Answer to the long-form/audiobook-tier sub-question: no such tier exists anywhere.** I checked every provider in the table. The one vendor with an explicitly named long-form product prices it *upward*: **Amazon Polly Long-Form is $100/1M against $16/1M for Neural** (VERIFIED). Azure offers a **batch synthesis API** for audio over 10 minutes, but it is an async convenience for long jobs, **not a discount** — same per-character rate. No provider rewards you for tolerating slow synthesis. The only cost lever is volume commitment (Speechify $6/1M at $499/mo Scale; Inworld $12.50/1M at Growth), and at ~3M chars/month you are far below the volume where those pay off.

---

## Honest verdict for this app

**1. Ship Speechify Simba 3.2.** It wins on every axis simultaneously — Arena #3 for quality, word-level timestamps with character offsets into the submitted string, browser-direct CORS confirmed by live preflight, $1.37 per document, and a 50k-char no-card free tier that lets you audition before spending anything. Nothing else in this survey is better on more than one axis at a time.

**2. Audition against Azure's free tier first, not against a paid trial.** 500k chars/month permanently free is 3.6 of your documents, and Azure's `WordBoundary` gives you `textOffset` and `wordLength` — character offsets directly into your input string, which is the cleanest possible fit for Folio's text-node-index range model. If you build the timing-map abstraction against Azure first, you get a working feature at **$0/month** and can decide about paid quality later with real listening evidence instead of leaderboards.

**3. Do not buy Hume.** This is the strongest negative finding here and it contradicts the premise the research started from. Octave 2 is architecturally the most context-aware product available — real `context` continuation across utterances, real acting directions, word *and* phoneme timestamps. It is also **57th of 95** in blind preference, **statistically indistinguishable from a free macOS voice** (~54%), **$150/1M — the most expensive option surveyed**, and gated behind a **10,000-character** free tier that cannot synthesize even a tenth of one of your documents. The prior investigation's note that "Octave 2 is roughly half the price of Octave 1" is **NOT CONFIRMED** — Hume's live pricing page shows a single character rate that does not distinguish the two models.

**4. Do not buy ElevenLabs for this.** Its expressive model and its timestamps endpoint appear not to combine (INFERRED but well-supported: `/with-timestamps` documents only character alignment, defaults to `eleven_multilingual_v2`, and the model table does not list v3 as timestamp-capable). Its cheap tier (`flash_v2_5`, $50/1M) is Arena #38 — you would pay 5× Speechify for a model 35 places worse. **Verify the v3-plus-timestamps question with a single API call before dismissing it**, since it is the one materially load-bearing thing I could not confirm.

**5. Cartesia is the upgrade path, not the starting point.** Sonic 3.6 is genuinely #1, and `/tts/sse` returning `ACAO: *` with `add_timestamps` means it is fully usable from the browser. But it is ~4× Speechify's cost, gives seconds-based word arrays with no character offsets (so you match by token index and must tokenize identically), and requires SSE parsing rather than a single JSON response. Revisit if you A/B it and clearly prefer it.

**6. Settle the storage question before writing any synthesis code.** Whether audio is cached determines whether this feature costs $1.37 once or $1.37 every read, and caching cannot happen in localStorage. This is the highest-leverage open decision and it is architectural, not incremental.

**7. Keep `speechSynthesis` as the default and make the hosted provider opt-in.** Free, offline, instant, and word-exact is a strong baseline. The honest expected improvement is "noticeably better sentence-level prosody, ~70–77% blind preference on short samples, less than that on 20,000 words of expository prose." That is worth $1.37 a document to a user who wants it, and worth nothing to a user who doesn't.

### What I did NOT verify

- **The single most important open question: whether `eleven_v3` works with `/with-timestamps`.** ElevenLabs' docs neither confirm nor deny it. My conclusion is INFERRED from the endpoint's documented default model and the absence of v3 in its supported-model list. One authenticated API call settles it.
- **Azure's current per-character price.** The pricing page renders `$-` placeholders, and the Azure retail-prices API returned zero rows for every `serviceName` I tried (`Cognitive Services`, `Speech Services`, `Azure AI Speech`). The ~$16/~$22 figures are carried over from earlier in-repo research (`api-azure-speech-raw.md:187`) and are **INFERRED**. The 500k/month free tier is VERIFIED from live page text.
- **Cartesia's credit-to-character ratio.** Assumed 1:1 (INFERRED, consistent with their "20k credits ≈ 27 minutes" figure). Their pricing page never states it, so all Cartesia dollar figures could be off by whatever that multiplier really is.
- **Whether Cartesia exposes `sonic-3.6`.** The Arena's #1 entry is Sonic 3.6; the API docs list only `sonic-3.5` (default), `sonic-3`, and `sonic-latest`. `sonic-latest` presumably resolves to 3.6 but I did not confirm.
- **Groq, Rime, Smallest.ai, Resemble, LMNT, Neuphonic per-character pricing** — none publish it in a fetchable form. Groq's TTS lineup has changed (PlayAI appears retired, replaced by `canopylabs/orpheus-*`), and Orpheus documents no timestamps, so **the existing Groq key does not help here.**
- **No listening test of my own.** Every quality claim traces to the Artificial Analysis Arena or vendor docs. I did not synthesize a single sample, and I have not heard any of these voices read your text.
- **macOS Premium's Elo placement (~1031) is my inference**, not a measurement. It anchors the entire "is the gap real" section, so treat the 77% figure as directional.
- **No MOS studies or academic listening tests** were located — the WebSearch budget for this session was exhausted early, so this relies on Arena data plus direct documentation fetches rather than a literature sweep.

---

## Sources

**Live preflights run 2026-08-18** against `api.elevenlabs.io`, `api.hume.ai`, `api.cartesia.ai` (`/tts/bytes` and `/tts/sse`), `api.openai.com`, `api.groq.com`, `texttospeech.googleapis.com`, `generativelanguage.googleapis.com`, `eastus.tts.speech.microsoft.com`, `api.sws.speechify.com`, `api.speechify.ai`, `api.deepgram.com`, `users.rime.ai`, `api.inworld.ai`, `api.play.ai`, `api.play.ht`, `api.neuphonic.com`, `waves-api.smallest.ai`, `f.cluster.resemble.ai`, `api.lmnt.com`, `api.fish.audio`, `api.v8.unrealspeech.com`.

- [Artificial Analysis — TTS Arena leaderboard](https://artificialanalysis.ai/text-to-speech/arena?tab=leaderboard) — the 95-model Elo table
- [Artificial Analysis — Text to Speech](https://artificialanalysis.ai/text-to-speech)
- [Hume — pricing](https://www.hume.ai/pricing)
- [Hume — TTS overview](https://dev.hume.ai/docs/text-to-speech-tts/overview)
- [Hume — synthesize-json API reference](https://dev.hume.ai/reference/text-to-speech-tts/synthesize-json) — `include_timestamp_types`, `context`, `description`
- [ElevenLabs — API pricing](https://elevenlabs.io/pricing/api)
- [ElevenLabs — models](https://elevenlabs.io/docs/models)
- [ElevenLabs — text-to-speech capabilities](https://elevenlabs.io/docs/capabilities/text-to-speech)
- [ElevenLabs — convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- [Cartesia — pricing](https://cartesia.ai/pricing)
- [Cartesia — /tts/bytes](https://docs.cartesia.ai/api-reference/tts/bytes)
- [Cartesia — /tts/sse](https://docs.cartesia.ai/api-reference/tts/sse) — `add_timestamps`, `word_timestamps`
- [Speechify — pricing](https://speechify.ai/pricing/)
- [Microsoft — Text to speech overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)
- [Microsoft — SpeechSynthesizer (JS SDK)](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesizer) — `wordBoundary`
- [Azure — Speech Services pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/) — free tier text; dollar figures render as placeholders
- [Google — Gemini speech generation](https://ai.google.dev/gemini-api/docs/speech-generation)
- [OpenAI — text to speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
- [Groq — text to speech](https://console.groq.com/docs/text-to-speech)
- [Deepgram — pricing](https://deepgram.com/pricing)
- [Deepgram — TTS models](https://developers.deepgram.com/docs/tts-models)
- [Inworld — pricing](https://inworld.ai/pricing)
- [Inworld — TTS docs](https://docs.inworld.ai/docs/tts/tts)
- [Rime — quickstart](https://docs.rime.ai/api-reference/quickstart)
- [Smallest.ai — pricing](https://smallest.ai/pricing)
- [Amazon Polly — pricing](https://aws.amazon.com/polly/pricing/)
- In-repo prior research: [`tts-web-research-2026.md`](./tts-web-research-2026.md), [`api-azure-speech-raw.md`](./api-azure-speech-raw.md), [`folio-integration-constraints.md`](./folio-integration-constraints.md)

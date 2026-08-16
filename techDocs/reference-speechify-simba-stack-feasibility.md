# Feasibility: Deepgram Nova-3 + Gemini 3.5 Flash + Speechify Simba 3.2

**Written 2026-07-18.** Every number below is labelled **measured**, **published**, or
**inferred**. Every latency number says where it was measured from. Six research streams fed
this document and their load-bearing claims were adversarially fact-checked; where a claim was
refuted, the corrected version is what appears here and the refutation is listed in
[Section 6](#6-what-we-did-not-verify).

---

## TL;DR

**No custom plugin is needed.** An official first-party `livekit-plugins-speechify` package
exists in the LiveKit monorepo (v1.6.6, published 2026-07-18; v1.6.4 exists and matches our
installed `livekit-agents` 1.6.4). Reaching Simba 3.2 is a version-pinned install plus about
two edited lines in `agent.py`, not a multi-day build.
([PyPI](https://pypi.org/pypi/livekit-plugins-speechify/json),
[LiveKit docs](https://docs.livekit.io/agents/integrations/tts/speechify/))

- **Can the stack be built? Yes.** All three components are reachable. TTS is path 2 (direct
  plugin, our own Speechify key, direct billing, no LiveKit markup). STT and LLM are already
  solved. Total integration effort is roughly **1–2 hours**, dominated by provisioning a key
  and auditioning voices, not by writing code.
- **What does it cost? ~$0.57 per 15-minute session (~$0.038/session-minute)**, realistic
  range **$0.51–$1.11**. That is **56% cheaper than what we run today** ($1.30/session) and
  28% cheaper than the Cartesia alternative ($0.79/session). **Speechify is genuinely and
  dramatically the cheapest TTS on the board** — about $0.055/session against Cartesia's
  $0.275 and our current ElevenLabs-via-gateway $0.825.
- **What is the latency? ~2.05–3.45 seconds end-to-end, confidence LOW.** The TTS term is
  entirely unmeasured. Cartesia is **164 ms TTFB measured from India** — the only provider we
  have that escapes the ~500 ms India→US transit tax. Speechify has **zero** India
  measurements, and its "lowest TTFB" positioning is vendor marketing.
- **The single biggest blocker: nobody has measured Speechify from India, and the plugin
  declares `streaming=False`,** which gates first audio on the LLM emitting a complete
  sentence rather than a first token. Cartesia and ElevenLabs on the gateway are
  websocket-streaming and do not pay that toll.
- **Two things in the plan are wrong, and one is a genuine surprise.** Swapping STT to Nova-3
  is a **downgrade** — 1.9× the price, worse word error rate in both benchmarks we found, and
  no native semantic end-of-turn, which puts our hard-won 0.4 s turn-taking at risk. And the
  **LLM, not TTS, is about to become the dominant line item** at ~$0.29/session.
- **Recommendation: ship the Cartesia swap first (it is measured, free to try, and still
  un-shipped from last session), keep AssemblyAI for STT, and measure Speechify from India on
  its free tier before committing to it.** Full reasoning in
  [Section 5](#5-the-honest-recommendation).

---

## Document Map

| Section | What it answers |
|---|---|
| [1. Verdict per component](#1-verdict-per-component) | Can LiveKit reach each model, at what price, with what risk flag |
| [2. Cost model](#2-cost-model) | Full-stack cost per minute and per session, with arithmetic, compared against today and against Cartesia |
| [3. Latency model](#3-latency-model) | End-to-end latency decomposed into its five terms, with a range and a confidence statement |
| [4. Blockers](#4-blockers) | Everything that must be resolved first, ordered by severity |
| [5. The honest recommendation](#5-the-honest-recommendation) | Whether a #1 quality ranking justifies the trade, with numbers |
| [6. What we did not verify](#6-what-we-did-not-verify) | Gap inventory: unverified assumptions, refuted claims, things needing measurement |

---

## 1. Verdict per component

**The gating question — "can LiveKit even reach Simba 3.2?" — is answered yes, and more
easily than expected.** The three-paths constraint from our earlier notes still holds
(gateway / direct plugin / write-it-yourself), and Speechify lands cleanly on path 2.

| Component | Chosen model | How LiveKit reaches it | Cost per session-minute | Latency (TTFB / TTFT) | Flag |
|---|---|---|---|---|---|
| **STT** | `deepgram/nova-3` | **Gateway** — curated list, no key needed | **$0.0048/min** *(published, Build/Ship)* | Not separately measured | **RISKY** |
| **LLM** | `gemini-3.5-flash` | **Direct plugin** (`google.LLM`), our own key | **~$0.019/min** *(inferred, see §2)* | **1,576 ms TTFT** *(measured, India→Google, laptop, thinking off)* | **GO** |
| **TTS** | `speechify/simba-3.2` | **Direct plugin** — official `livekit-plugins-speechify`, our own key | **$0.0037/min** *(published rate, inferred volume)* | **UNMEASURED** | **RISKY** |
| *LiveKit agent compute* | — | — | **$0.0100/min** *(published, Build/Ship)* | — | GO |
| *Bandwidth* | — | — | **<$0.0002/min** *(inferred; inside included allotment)* | — | GO |

### Why STT is flagged RISKY, not GO

Nova-3 has **no native semantic end-of-turn detection**. LiveKit's turn-detection docs name
exactly two providers for `turn_detection="stt"`: AssemblyAI ("the recommended STT plugin for
STT-based endpointing") and Deepgram **Flux**. Nova-3 never appears in a turn-detection
context. ([LiveKit turn docs](https://docs.livekit.io/agents/build/turns/),
[Deepgram STT docs](https://docs.livekit.io/agents/models/stt/deepgram/))

Deepgram's own Nova-3→Flux migration guide independently confirms this from the vendor side:
it tells Nova-3 users they must "decide when to interrupt your agent manually" and instructs
migrators to "remove custom VAD/barge-in logic (Flux handles this natively!)".
([Deepgram](https://developers.deepgram.com/docs/flux/nova-3-migration))

`agent.py:165` currently sets `turn_detection="stt"` and relies on AssemblyAI's neural EOT.
That setting is precisely what killed the 2.5-second waits. Swapping in Nova-3 would not
crash, but it degrades to a **fixed silence timer** — LiveKit applies its own
`min_endpointing_delay` floor (our `agent.py:108` sets 0.4 s) with no confidence signal to
shorten or lengthen it. A tutor's users pause mid-thought; a fixed timer cannot tell "I'm
thinking" from "I'm done."

### Why TTS is flagged RISKY, not GO

Three reasons, in descending order of importance:

1. **`streaming=False`.** The plugin declares
   `capabilities=tts.TTSCapabilities(streaming=False)` (`tts.py:119-125`, verified identical in
   1.6.4 and 1.6.6). LiveKit's default `tts_node` auto-wraps it in a `StreamAdapter`
   (`voice/agent.py:506-510`) which sentence-tokenizes the LLM output and fires **one complete
   HTTP POST per sentence, serially** — sentence N+1 does not begin until N is fully received
   (`tts/stream_adapter.py:123-137`). This is a supported, automatic path, not an error. But it
   changes the shape of first-audio latency. See [§3](#3-latency-model).
2. **Zero India measurements.** Speechify's docs claim "lowest TTFB and richest expressivity"
   with no figure and no measurement location.
   ([Speechify models](https://docs.speechify.ai/build/guides/concepts/models))
3. **English only, 8 curated voices, none auditioned.** Simba 3.2 serves only
   `beatrice_32, dominic_32, edmund_32, geffen_32, harper_32, hugh_32, imogen_32, wyatt_32`
   plus manually-approved clones. No Hindi, no Hinglish code-switching.

### The configuration gotchas that will bite on first run

These are read from the shipped source, which contradicts LiveKit's published docs in two
places. **Trust the source, not the docs page.**

| Thing | Docs say | Code actually says | Consequence |
|---|---|---|---|
| Model literal | `simba-english`, `simba-multilingual` | same (`models.py:16-19`) | `simba-3.2` is **absent**. It still works — `_TTSOptions` is a plain `@dataclass`, not pydantic, so `Literal` is unenforced at runtime, and `tts.py:215` passes the string straight into the JSON body. A type checker will flag it; add `# type: ignore[arg-type]`. |
| Default voice | `cliff` (docstring `tts.py:104`) | `jack` (`tts.py:54`) | **`jack` is not in the Simba 3.2 curated set.** You must set model *and* a `*_32` voice together or expect a 400. |
| Default encoding | `wav_48000` | `ogg_24000` (`tts.py:41`) | Speechify documents WAV as unavailable on the streaming endpoint, so the docs' default would be an actively bad choice. Set encoding explicitly. |
| Base URL | `api.speechify.ai` | `api.sws.speechify.com/v1` (`tts.py:55`) | Both resolve to 34.49.245.64 but present **separate TLS certificates**, so "same backend" is unproven. Pass `base_url="https://api.speechify.ai/v1"` explicitly to run against the documented host. |

Speechify's `/v1/audio/stream` endpoint officially accepts `simba-3.2` in its model enum
(`simba-english`, `simba-multilingual`, `simba-3.0`, `simba-3.2`), and the default when the
field is omitted is `simba-english` — so **you must set it explicitly to opt in**.
([API reference](https://docs.speechify.ai/build/api-reference/v1/audio/stream.md))

Dependency note: pin to **`livekit-plugins-speechify==1.6.4`**. It requires
`livekit-agents[codecs]>=1.6.4`, which our installed 1.6.4 satisfies. The latest 1.6.6 requires
`>=1.6.6` and a bare `pip install` would silently force-upgrade the agent framework under a
working voice stack. PyAV (needed to decode the OGG default) is already present in
`phase2-agent/.venv`.

---

## 2. Cost model

**This is the headline deliverable, and it contains a surprise: the LLM is about to become the
dominant cost, not the TTS.**

### The assumptions, stated up front

Every cost figure below rests on these. They are the weakest part of the model and are labelled
accordingly.

| Assumption | Value | Basis |
|---|---|---|
| Session length | 15 minutes | Product spec |
| Agent speech volume | **5,500 characters/session** | **Inferred.** Range 4,000–7,000. Anchored on a real measured transcript (`transcripts/spikechatty_2026-07-13_67aa36a3.txt`: 7,021 agent chars over 30.2 min = 232 chars/session-minute, agent talking ~28% of the time). Vera is a tutor and will talk more than that interview-style agent, so the central figure assumes ~40% talk share. |
| Turns per session | **40** (~2.7/min) | **Inferred**, consistent with the measured transcript's 40 agent turns |
| System prompt | **9,858 tokens** | **Measured** (`techDocs/measured-findings.md:76`) |
| Average history carried | ~2,500 tokens (grows 0 → ~5,000) | **Inferred** |
| Output tokens | ~1,400/session (5,500 chars ÷ ~4 chars/token) | **Inferred** |

**Critical framing note:** all per-minute figures below are per **session-minute** (wall-clock),
not per minute-of-speech. That is the right basis because it lets TTS, STT, LLM and LiveKit's
$0.0100/min agent compute be added together on the same denominator. Research figures quoted
elsewhere as "$X per minute at 825 chars/min" assume the agent talks 100% of the time and are
not comparable.

### TTS arithmetic

Speechify's published tiers ([speechify.ai/pricing](https://speechify.ai/pricing)) are
**subscriptions with included allowances, not flat per-character rates** — a trap worth naming:

| Tier | Monthly fee | Included | Overage |
|---|---|---|---|
| Free | $0 | 50K chars, hard cap (usage pauses) | — |
| **Starter** | **$10/mo** | **1M chars** | **$10/1M** |
| Pro | $99/mo | 3M chars | $8/1M |
| Scale | $499/mo | 10M chars | $6/1M |

**Starter is the correct tier and stays correct for a long time.** Because its included
allowance is priced identically to its overage rate, it behaves as flat $10/1M pay-as-you-go
with a $10/month minimum. Pro and Scale are strictly *worse* until roughly 37.5M and 182M
chars/month respectively — about 6,800 and 33,000 sessions/month. Do not "upgrade for the
discount."

Below ~182 sessions/month (1M chars) the $10 floor dominates and the effective rate is higher
than $10/1M. That is a real caveat at pilot scale and irrelevant at production scale.

TTS cost per session at 5,500 raw characters:

```
Speechify Simba 3.2 (direct, Starter)  5,500 × $10/1M  = $0.0550
Cartesia Sonic 3.5  (LiveKit gateway)  5,500 × $50/1M  = $0.2750
ElevenLabs Flash v2.5 (gateway, today) 5,500 × $150/1M = $0.8250
Inworld TTS 2       (LiveKit gateway)  5,500 × $25/1M  = $0.1375
```

*(Gateway rates published at [livekit.com/pricing/inference](https://livekit.com/pricing/inference),
Build/Ship tier. Note ElevenLabs direct is $50/1M — the gateway charges 3× for the same model.
Speechify is not on the gateway at all, so no markup applies to it.)*

**One point in Speechify's favour that we have not applied:** Speechify explicitly does not bill
whitespace or SSML tags. English text is ~15–17% whitespace, so real billable volume is closer
to 4,700 chars, cutting the figure to ~$0.047/session. I have **not** applied this discount in
the tables below because I could not verify whether ElevenLabs and Cartesia bill whitespace, and
an unverified asymmetric discount would make the comparison dishonest.

### LLM arithmetic — the line item that matters most

Gemini 3.5 Flash direct pricing: **$1.50/1M input, $9.00/1M output, $0.15/1M cached input**
([Google](https://ai.google.dev/gemini-api/docs/pricing)). LiveKit's gateway charges the
*identical* rate for this model, so going direct costs nothing extra — we go direct only to
reach `thinking_config`.

**Caching is the whole game here, and our previous understanding of it was wrong in both
directions.** The corrected picture, measured 2026-07-18 against the real prompt:

- Gemini 3.5 Flash's implicit-cache **minimum token floor is ~10.2K tokens**, versus ~2K for
  2.5-flash. Vera's bare 9,842-token prompt sits roughly **370 tokens below that floor** —
  which is why an isolated test of it returns 0% and looks like caching is broken.
- In the **production shape** (system_instruction plus accumulating conversation history, which
  is what the LiveKit agent actually sends), the total crosses the floor at turn 6 and caching
  then holds at **77–80%** for the rest of the lesson.
- So the honest model is **0% for the first ~5 turns, then ~78%** — not the flat 93.4% recorded
  in `techDocs/measured-findings.md` (that figure was measured on **2.5**-flash), and not the
  0% that a naive isolated test suggests.

```
Turns 1–5   (uncached):        5 × ~10,200 tok  =   51,000 input tok
Turns 6–40  (78% cached):     35 × ~12,700 tok  =  444,500 input tok
                                    of which cached =  346,710
                                    of which uncached =  97,790

Uncached input:  148,790 × $1.50/1M  = $0.2232
Cached input:    346,710 × $0.15/1M  = $0.0520
Output:            1,400 × $9.00/1M  = $0.0126
                                       ────────
LLM per session                        $0.2878   → $0.0192/session-minute
```

**Ceiling if caching never fires:** 495,500 input tok × $1.50/1M + output = **$0.756/session**.
That is the number to budget against if the cache floor behaves differently in production than
in the probe. It is a 2.6× swing on the largest line item, which is why the full-stack range
below is as wide as it is.

**The uncomfortable observation:** re-sending a 9,858-token system prompt 40 times per session
costs more than any TTS on this list except ElevenLabs-via-gateway. Prompt size is a cost lever
nobody has pulled.

### Full stack, per 15-minute session

| Line item | Proposed (Nova-3 + 3.5F + Simba 3.2) | Today (AssemblyAI + 3.5F + ElevenLabs gw) | Cartesia alt (Nova-3 + 3.5F + Sonic 3.5) |
|---|---|---|---|
| STT | $0.0720 | **$0.0375** | $0.0720 |
| LLM | $0.2878 | $0.2878 | $0.2878 |
| TTS | **$0.0550** | $0.8250 | $0.2750 |
| LiveKit agent compute | $0.1500 | $0.1500 | $0.1500 |
| Bandwidth | ~$0.0010 | ~$0.0010 | ~$0.0010 |
| **Total per session** | **$0.566** | **$1.301** | **$0.786** |
| **Per session-minute** | **$0.0377** | **$0.0868** | **$0.0524** |
| **Realistic range** | **$0.51 – $1.11** | **$1.24 – $1.85** | **$0.73 – $1.33** |
| **Per 1,000 sessions** | **$566** | **$1,301** | **$786** |

Ranges are driven almost entirely by the LLM caching uncertainty ($0.24–$0.76) plus the speech
volume band (4,000–7,000 chars).

**Plainly: the proposed stack is the cheapest of the three.** It saves **$735 per 1,000
sessions** against what we run today and **$220 per 1,000 sessions** against the Cartesia
alternative. Speechify is not marginally cheaper — it is 5× cheaper than Cartesia and 15× cheaper
than our current gateway ElevenLabs on the TTS line.

### Two cheaper configurations nobody has evaluated

Worth putting on the table because they beat all three columns above:

| Configuration | Per session | Per 1,000 | Note |
|---|---|---|---|
| AssemblyAI + 3.5-flash + **Cartesia** | $0.751 | $751 | Keeps measured 164 ms TTFB *and* the cheaper, better-WER STT. No new API key at all. |
| AssemblyAI + **gemini-3.1-flash-lite** + Simba 3.2 | **$0.291** | **$291** | 3.1-flash-lite is $0.25/$1.50/1M ([published](https://ai.google.dev/gemini-api/docs/pricing)), ~6× cheaper than 3.5-flash, and has a shutdown date of May 7 2027 so it survives the 2.5-flash cutover. **Quality for tutoring is completely unevaluated.** |

The second row is a 4.5× cost reduction against today's stack, and it comes from the component
nobody was looking at.

---

## 3. Latency model

**This is the other headline deliverable, and its honest answer is "we do not know, because the
TTS term has never been measured."**

### The five terms

End-to-end latency, from the user finishing speaking to the first audible word, decomposes as:

```
  end-of-utterance detection
+ STT finalisation
+ LLM time-to-first-token  (or time-to-first-SENTENCE for Speechify — see below)
+ TTS time-to-first-byte
+ network return leg to the phone
= perceived response latency
```

### The transit tax, and why production differs from our test bench

**Roughly 500 ms of any India→US round trip is pure transit.** This is our own measured finding,
not a guess. ElevenLabs markets ~75 ms and measured **572 ms from India**; Hume markets ~100 ms
and measured **729 ms from India** (`techDocs/measured-findings.md:43-52`, five runs each, one
harness, `compare_tts_headtohead.py`). Vendor latency claims are datacenter-local and do not
survive a Mumbai laptop.

**But in production the request does not originate from a phone in India.** It originates from
the LiveKit agent in a datacenter. So the model-call legs (STT, LLM, TTS) shed most of that
transit tax, and what remains is the phone↔LiveKit media path. This means our India-measured
figures are **upper bounds on the production values**, and the *differences* between providers
are the part that genuinely transfers.

The exception that proves the rule: **Cartesia measured 164 ms from India** — it did not pay the
transit tax at all, which strongly implies an APAC edge POP. That is a structural advantage no
amount of datacenter-side improvement can take away from it.

### Term-by-term

| Term | Value | Label | Measured from |
|---|---|---|---|
| End-of-utterance detection | **400–1,200 ms** | Configured (`agent.py:108-110`) | Our own config: `min_endpointing_delay=0.4`, `max=1.2` |
| STT finalisation | ~50–150 ms | **Inferred**, largely overlaps EOT | — |
| LLM TTFT, `gemini-3.5-flash`, thinking off | **1,576 ms** | **Measured** | India → Google, from Rishabh's Mac. In production from a datacenter, **inferred** ~1,050–1,150 ms |
| LLM time-to-first-*sentence* (Speechify only) | **+100–400 ms on top of TTFT** | **Inferred** | Gemini Flash emits ~100–200 tok/s; a ≥20-char sentence is ~20–40 further tokens |
| TTS TTFB — Cartesia Sonic 3.5 | **164 ms** | **Measured** | India, laptop, 5 runs, spread 26 ms |
| TTS TTFB — ElevenLabs Flash v2.5 | **572 ms** | **Measured** | India, laptop, 5 runs |
| TTS TTFB — Hume Octave 2 | **729 ms** | **Measured** | India, laptop, 5 runs |
| **TTS TTFB — Speechify Simba 3.2** | **UNKNOWN** | **No measurement exists anywhere** | — |
| Network return leg to phone | ~200–300 ms one-way | **Inferred** | — |

### The Speechify-specific structural penalty

This is the part that is not about milliseconds-per-vendor and is about architecture, and it is
the most important thing in this section.

Because the plugin declares `streaming=False`, LiveKit wraps it in a `StreamAdapter`. That has
three consequences:

1. **First audio waits for a complete SENTENCE, not a first token.** Cartesia and ElevenLabs on
   the gateway are websocket-streaming and begin synthesising on the first token. Speechify
   cannot. This adds the inferred +100–400 ms above, *before the HTTP request is even sent*.
2. **A short opening line is merged with the next sentence.** The sentence tokenizer's
   `min_sentence_len` defaults to 20 characters
   (`livekit/agents/tokenize/blingfire.py:57`). This was **executed and observed**, not inferred:
   tokenizing `"Hello there. This is a second sentence."` returns **one** token, not two. A snappy
   opener will not ship on its own — it waits.
3. **Sentences are synthesised serially, one HTTP round trip each.** Sentence N+1 does not begin
   until N is fully received. In practice playback of sentence N largely masks synthesis of N+1,
   so the risk concentrates on the **first** sentence and after any short one.

Two mitigations exist and neither has been tested: the framework's `StreamAdapter` accepts a
`text_pacing` argument (LiveKit's auto-wrap does not pass it, so it defaults off), and a custom
tokenizer with a lower `min_sentence_len` would let the opening clause ship immediately.

What is *not* a problem: Speechify does stream audio back incrementally within a sentence
(`resp.content.iter_chunks()`), and the plugin reuses a pooled aiohttp session with a 120 s
keepalive, so sentences after the first do not re-pay a TLS handshake.

### End-to-end estimates

From a US-hosted agent, user in India, first audible word after the user stops speaking:

| Stack | Estimated end-to-end | Confidence |
|---|---|---|
| **Today** (AssemblyAI + 3.5F + ElevenLabs gw) | **~1.95 – 2.75 s** | **Medium** — every term has a measured anchor |
| **Proposed** (Nova-3 + 3.5F + Simba 3.2) | **~2.05 – 3.45 s** | **LOW** — the TTS term is a guess, and the upper bound is unbounded upward |
| **Cartesia alt** (+ Sonic 3.5) | **~1.80 – 2.60 s** | **Medium-high** — Cartesia's 164 ms is the best-measured, tightest-spread number we own |

**I will not put a point estimate on the proposed stack.** Doing so would invent precision we do
not have. What can be said with confidence is the *ordering*: Cartesia is fastest, today's stack
is in the middle, and Simba 3.2 is somewhere between "matches today" and "meaningfully worse,"
with the sentence-gating penalty guaranteed and the TTFB unknown.

**A #1 quality ranking on Artificial Analysis predicts nothing here.** That is a quality ELO. Our
own record is unambiguous: we have now been burned twice by published latency figures (Hume
~100 ms marketed / 729 ms measured; ElevenLabs ~75 ms marketed / 572 ms measured).

---

## 4. Blockers

Ordered by severity. Nothing below is optional before this stack carries a real user.

### 1. No Speechify TTFB measurement from India exists — anywhere

Not from us, not from Speechify, not from any third party. The Artificial Analysis provider page
is JS-rendered and yields no extractable TTFB. Speechify's docs give only qualitative claims
("lowest TTFB", "optimized for real-time streaming") with no figure and no measurement location.

This is the decisive number and it is missing. **We already own the harness**
(`phase2-agent/measure_hume_ttfb.py`, `compare_tts_headtohead.py`), and Speechify's free tier
gives 50,000 characters at no cost and no credit card — enough for roughly 9–14 sessions' worth
of synthesis, far more than a TTFB test needs. **This experiment is free and takes under an
hour.** There is no excuse for deciding without it.

Measure **per sentence**, not per session, because `streaming=False` means the per-sentence round
trip is what actually governs perceived latency.

### 2. An API key must be created by hand before anything is verifiable

Speechify keys are console-only at `platform.speechify.ai/api-keys`. No documented public
key-management endpoint exists, so this cannot be scripted. Until a human clicks through, **every
Speechify claim in this document is source-reading, not observation** — including whether
`model="simba-3.2"` is actually accepted end-to-end by the endpoint the plugin POSTs to.

### 3. Concurrency ceiling of 15 simultaneous requests on the paid tier

Speechify's Build Audio endpoints cap at **15 concurrent requests / 20 RPS** on paid plans, and
**1 concurrent / 1 RPS** on free.
([API limits](https://docs.speechify.ai/build/guides/concepts/api-limits))

This interacts badly with `streaming=False`: `StreamAdapter` issues one HTTP request **per
sentence**, so a single talkative Vera session generates requests continuously. 15 concurrent is
a real ceiling on simultaneous users and needs sizing before launch. The free tier's 1-concurrent
limit cannot support even one realistic conversation, so evaluation beyond a raw TTFB probe
requires the $10 Starter plan.

### 4. The STT half of the plan is a regression, not an upgrade

Nova-3 as specified is not viable without accepting a turn-taking downgrade (no semantic EOT —
see [§1](#1-verdict-per-component)), and it is worse on both axes we can check:

- **Price:** $0.0048/min vs AssemblyAI's $0.0025/min — 1.9× more, for the model that does less.
- **Accuracy:** Nova-3 lost to AssemblyAI in **both** benchmarks found (Coval: 4.8% vs 2.7% WER;
  Gradium: 25.3% vs 4.2%). In no benchmark did Nova-3 win. *Caveat: these two disagree about
  Nova-3 by 5×, Gradium is published by a vendor whose own model won, and Nova-3's Gradium
  standard deviation (30.1) exceeds its mean — so use these for direction only, never as values.*

The one genuine argument for Deepgram is **Mumbai co-location**, and it is stronger than the
research initially suggested: LiveKit's regional deployment table lists `deepgram/nova-3-general`
(English, Hindi, Multilingual), `nova-2-general` (English, Hindi) and `flux-general` (English) as
co-located in Mumbai with Frankfurt fallback, routed automatically with no code change.
([LiveKit regional docs](https://docs.livekit.io/agents/models/stt/inference/deepgram/#regional),
[India blog](https://livekit.com/blog/building-performant-voice-agents-india)) AssemblyAI has no
documented regional deployment either way.

**But that benefit is conditional on deploying the agent in ap-south, which we have not done**
(`lk cloud auth` is still open item #3 in the handoff). Until then, the co-location argument buys
nothing.

### 5. English only — no Hindi, no Hinglish

Simba 3.2 is documented as "English only today." Our users are in India. If Vera ever needs to
code-switch, Simba 3.2 cannot, and the fallback (`simba-multilingual`) is labelled experimental
by Speechify. **This is a product decision that should be made before any engineering effort**,
because it cannot be fixed later with configuration.

### 6. None of the eight Simba 3.2 voices has been heard

Voice quality is the *entire* reason for choosing Simba 3.2, and nobody has listened to one.
Gender and accent for the `*_32` set are undocumented; the names suggest `beatrice_32`,
`harper_32` and `imogen_32` are female, but that is name inference. One weak source suggests
Beatrice and Imogen are British-accented on Speechify's consumer platform — **a British tutor
voice may be the wrong call for an India-market product**, and it is exactly the kind of thing
that only surfaces on listening. Resolve with one authenticated `GET /v1/voices?limit=200` call
and audition the `preview_audio` URLs.

Note that this same gap applies to Cartesia: our last bake-off ran Cartesia and Inworld on
*default* voices against ElevenLabs on Jessica, which is unfair on quality
(`.notes/HANDOFF-next-session.md:52-53`).

### 7. Unverified request-field mismatch on audio format

The plugin sends a field named `audio_format` with a short value (`"ogg"`, produced by splitting
`ogg_24000` at the underscore, `tts.py:49-51, 216`). The endpoint spec documents a field named
`output_format` with long values (`ogg_24000`, `pcm_24000`, …). Either `audio_format` is an
accepted legacy alias or the docs are incomplete. The plugin is first-party and presumably
tested, so it likely works — but **the first live call settles it**, and if it fails it is a hard
blocker until found. The fix would be small (pass `base_url`, or patch the helper).

---

## 5. The honest recommendation

**Do not build this stack as specified. Build two thirds of a different one, and measure the
remaining third before committing to it.**

Concretely, in order:

1. **Ship the Cartesia TTS swap now.** Two words in `agent.py:158`. No new API key, already on
   the gateway. **164 ms measured from India**, 3.5× faster and 3× cheaper than what we run
   today. This has been sitting on the table since the last session, un-shipped. It is the
   single best-evidenced change available and it costs nothing to try.
2. **Keep AssemblyAI for STT.** It is half the price of Nova-3, ahead on WER in both benchmarks,
   and it is the component providing the native semantic end-of-turn that fixed our 2.5-second
   waits. Before even considering a swap, run the **free** experiment first: the comment at
   `agent.py:137-138` claiming the gateway cannot set the EOT threshold **is false** —
   `AssemblyaiOptions` exposes `end_of_turn_confidence_threshold` (defaulting to a very
   permissive 0.01), `min_end_of_turn_silence_when_confident` and `max_turn_silence` through
   `extra_kwargs` on the installed version. Tuning that costs nothing and may remove the
   motivation to switch vendors at all.
3. **Measure Speechify from India on the free tier.** 50K characters, no credit card, harness
   already written. If Simba 3.2's per-sentence TTFB lands near Cartesia's 164 ms, it becomes a
   genuinely compelling option on cost. If it lands near ElevenLabs' 572 ms, the sentence-gating
   penalty stacks on top of that and it is not competitive.
4. **Then, and only then, run a blind listening test** between Cartesia Sonic 3.5 and Simba 3.2
   on voice-matched samples.

### On the #1 Artificial Analysis ranking — addressed directly

The user wants Simba 3.2 because it ranks #1. That deserves a real answer rather than a
dismissal, and the argument for it is **stronger than usual for this specific product**:

**The case FOR paying a latency premium for voice quality here.** A 15-minute tutoring session
means the user hears roughly 8 minutes of continuous synthesised speech. Voice quality compounds
over that duration in a way it simply does not in a 30-second IVR or a customer-service bounce.
Fatigue, warmth, prosody on a long explanation — these are the difference between a tutor
somebody returns to and one they abandon. If any product should pay for TTS quality, it is this
one. That is a legitimate reason to take Simba 3.2 seriously, and it is why this document
recommends measuring it rather than dropping it.

**The three reasons that argument does not carry today.**

*First, we are comparing a known rank against an unknown one.* Simba 3.2 is #1. We do not know
where Cartesia Sonic 3.5 sits on that same leaderboard, and nobody has checked. "#1 versus
unknown" is not a comparison — it is a single data point. Sonic 3.5 could be #2. The entire
premise of the trade is unquantified.

*Second, the ranking measures the wrong thing.* Artificial Analysis TTS rank is a crowd-preference
ELO on short clips. It is not a measure of "which voice is pleasant to learn from for fifteen
minutes." Those correlate, but not perfectly, and the gap between #1 and #3 on a short-clip ELO
may be inaudible over a long conversation. **We have never listened to either candidate.** A
leaderboard is standing in for a judgement that costs one afternoon to make properly.

*Third, and most importantly: latency IS a quality attribute in a tutoring conversation.* A tutor
who takes an extra half-second to begin every reply feels hesitant, and hesitancy reads as
uncertainty — which is corrosive for a teacher persona in a way that a marginally less rich
timbre is not. The `streaming=False` sentence-gating penalty is **structural and guaranteed**;
the quality gain is **ranked but unheard**. Trading a certain latency cost for an unverified
quality gain is the wrong direction of bet.

**The bottom line on the trade:** if Simba 3.2 measures within ~100 ms of Cartesia from India,
take it — the cost saving ($220 per 1,000 sessions) and the quality rank together justify the
sentence-gating penalty comfortably. If it measures like ElevenLabs or worse, decline it, because
you would be paying 400+ ms of hesitancy per turn for a quality difference you have not verified
you can hear.

### One more thing, which is arguably bigger than the whole TTS question

**The LLM is about to become the dominant cost of this stack, and it is the component nobody is
optimising.** At ~$0.29/session it exceeds every TTS on the board except the ElevenLabs gateway
rate we are currently paying. Two levers are sitting untouched:

- **`gemini-3.1-flash-lite`** at $0.25/$1.50 per 1M is ~6× cheaper than 3.5-flash, cheaper on
  input than even the retiring 2.5-flash, and has a shutdown date of May 7 2027 so it survives
  the October cutover. Quality for tutoring is entirely unevaluated. Worth one afternoon.
- **Prompt size.** Re-sending 9,858 tokens 40 times per session is the actual cost driver. The
  ~10.2K cache floor on 3.5-flash means we sit *just below* the threshold at turn 1 — an
  irony worth acting on, since a slightly **larger** stable prefix would start caching sooner.

A 15-minute session costing $0.57 is fine. A 15-minute session costing $0.29 is better, and the
saving is larger than everything the TTS decision is arguing over.

---

## 6. What we did not verify

Explicit gap inventory. Everything here is either unverified, refuted, or needs measuring rather
than reading.

### Claims that were investigated and REFUTED — do not re-inherit these as fact

| Refuted claim | What is actually true |
|---|---|
| "Constructing `speechify.TTS(model='simba-3.2')` was tested in the user's venv and succeeded" | **This test never ran.** `livekit-plugins-speechify` is not installed in `phase2-agent/.venv` (only anthropic, google, hume, silero). Object construction also makes no network call, so it could never have proven API acceptance regardless. |
| "`t.capabilities.streaming` printed False at runtime" | Read from source, **not** executed. The conclusion is correct; the provenance was false. |
| "Implicit caching returns 0% on gemini-3.5-flash — caching is broken" | **False.** 3.5-flash caches fine above a ~10.2K token floor (70–83% measured at 11.5K–39K tokens). Vera's bare prompt sits ~370 tokens below the floor. In production shape, caching fires from turn 6 at 77–80%. |
| "The switch to 3.5-flash costs 8.7× per minute" | **Overstated.** That fused a real price change with an unverified 0%-cache assumption. Apples-to-apples the multiple is ~4.8×. |
| "Nova-3 is NOT co-located in Mumbai; only nova-2 and flux are" | **False.** LiveKit's regional table lists `deepgram/nova-3-general` with the *widest* language coverage (en, hi, multi). The India argument favours Nova-3, not Flux. |
| "LiveKit's docs contradict the code on two defaults" | **One**, not two. The guide page correctly states `voice_id` default `jack`; only the `wav_48000` encoding default is wrong. The `cliff` error lives in the in-code docstring. |
| "`turn_detection='stt'` with Nova-3 cuts users off at Deepgram's 25 ms endpointing" | **Wrong by ~20×.** Deepgram's `endpointing` only marks transcripts final; LiveKit applies its own `min_delay` floor on top (our config: 0.4 s). |
| "A `SynthesizeStream` for Speechify is not writable, regardless of effort" | **False.** LiveKit's own `StreamAdapterWrapper` is exactly that — a `SynthesizeStream` over non-duplex HTTP. Tuning headroom (`text_pacing`, custom tokenizer) exists and is untested. |
| "Speechify docs state key creation cannot be scripted" | The docs document only a console workflow; they do **not** state scripting is impossible. Absence of a documented endpoint ≠ documented absence. |
| "api.sws.speechify.com and api.speechify.ai are verified to be the same backend" | Same IP, but **separate TLS certificates** and no authenticated call was made. Same edge and auth tier is established; same downstream routing is not. |

### Unverified assumptions the cost model rests on

- **Speech volume of 5,500 chars/session** is inferred from one measured transcript of a
  *different* persona (interview-style, user-heavy). No real Vera session has been measured. This
  single assumption moves the whole TTS comparison proportionally.
- **40 turns/session and ~2,500 average history tokens** are inferred, not measured.
- **The 77–80% production cache rate** was measured with the raw `google-genai` SDK, not through
  the LiveKit `google.LLM` plugin path the agent actually runs. The plugin may restructure
  requests or inject tools in ways that change cache eligibility in either direction.
- **Bandwidth** is estimated at <$0.002/session from Opus bitrate arithmetic. Never measured, and
  it sits inside the included allotment at our volume anyway.
- **LiveKit plan tier is assumed Build/Ship.** On Scale, gateway rates drop (Cartesia $37.50/1M,
  Inworld $15/1M) and the Speechify advantage narrows. Confirming the tier is still open item #4
  in the handoff.
- **Whether ElevenLabs and Cartesia bill whitespace** — unchecked, which is why Speechify's
  whitespace exclusion was deliberately left out of the comparison tables.

### Things that need measuring, not reading

1. **Speechify Simba 3.2 per-sentence TTFB from India.** The decisive number. Free to obtain.
2. **Whether `model="simba-3.2"` is accepted end-to-end** by the endpoint the plugin POSTs to,
   and whether the `audio_format`/`output_format` field naming works.
3. **Which `*_32` voices are female, and what accent they carry.**
4. **A blind listening test** between Cartesia Sonic 3.5 and Simba 3.2, voice-matched.
5. **Where Cartesia Sonic 3.5 ranks on Artificial Analysis** — never checked, which makes the
   entire "#1 quality" premise unquantified.
6. **Whether a tuned AssemblyAI EOT threshold** removes the motivation to change STT at all.
7. **`gemini-3.1-flash-lite` quality for tutoring**, and its cache behaviour (unmeasured).
8. **Real cache hit rate through the LiveKit plugin path**, over a full multi-turn session.
9. **The ElevenLabs P95 question** from the last session (a 14× median→P95 blowup was reported
   but not reproduced in 5 runs) — still unresolved, and it matters for any provider on a locked
   screen. Needs ~100 runs.

### Things deliberately not done

- **No Speechify API call was made.** No key exists in this environment. Every Speechify claim
  here is source-reading or documentation-reading.
- **No install was performed.** `pip install livekit-plugins-speechify==1.6.4` was not run, so
  the clean-resolution claim (agents stays at 1.6.4) is PyPI-metadata inference, not observation.
- **Deepgram and AssemblyAI direct (non-gateway) rates were not checked.** Only gateway rates
  appear above, correctly labelled. The known 3× ElevenLabs TTS markup licenses no assumption
  about STT markup.
- **Speechify's separate Voice Agents product** (`/v1/agents/*`, beta, appears to be built *on*
  LiveKit, 30 concurrent) was not evaluated. It is a full-stack replacement that would mean
  giving up Gemini, Deepgram and our agent logic — almost certainly wrong for us, but it exists.
- **No Speechify docs page was reachable for several paths** (multiple 404s during research), so
  the absence of a duplex websocket TTS API is strong inference from endpoint design, not a
  confirmed negative.

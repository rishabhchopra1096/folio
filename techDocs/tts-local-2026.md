# Local / in-browser TTS — state of the art, Aug 2026

**Research date: 2026-08-18.** Companion to `techDocs/tts-web-research-2026.md` (cloud APIs),
`techDocs/superwhisper-tts-postmortem.md` (the previous Kokoro attempt), and
`techDocs/folio-integration-constraints.md`.

**How to read the evidence labels:**

- **VERIFIED** — I fetched the artifact and inspected it: parsed the ONNX protobuf, ran the model
  on this machine, read the shipped JS source, or hit a live API endpoint. Reproducible.
- **INFERRED** — reasoned from adjacent verified facts. Stated with the reasoning shown.
- **MARKETING** — a vendor claim with no independent measurement behind it. Treated as unproven.

---

## TL;DR — is there anything that beats macOS Premium voices without losing word timing?

**No. Nothing in Aug 2026 clears both bars at once, and the reason is structural rather than
incidental.**

1. **The browser platform gave text-to-speech nothing since 2024.** Every byte of new Web Speech
   API spec surface in 2025–2026 is speech *recognition*. Synthesis is untouched. VERIFIED.
2. **Apple's good voices are locked away from the web, permanently-looking.** Siri voices are
   blocked at the `AVSpeechSynthesizer` layer, so Chrome and Safari both inherit the block.
   Personal Voice needs a native TCC entitlement no browser can grant per-site. Ava/Zoe Premium
   *is* the ceiling, and Folio is already standing on it. VERIFIED.
3. **The one honest listening test says Kokoro is still the best open model, by a margin of
   nothing.** On the live TTS Arena V2 leaderboard, the top open-weights entry (Chatterbox, ELO
   1480) beats Kokoro (ELO 1478) by **2 ELO points** across ~1.8k and ~1.0k votes. That is noise.
   Meanwhile the top *closed* model sits at 1574. VERIFIED — fetched the live endpoint.
4. **The models that genuinely are more expressive cannot emit timings, by construction.** The
   2025–2026 expressiveness jump came from putting an LLM backbone in front of a discrete audio
   codec (Chatterbox, Orpheus, VibeVoice, Higgs, Qwen3-TTS). Those models generate audio tokens
   autoregressively. There is no duration predictor to read. There is no alignment to extract.
   You would be trading a hard guarantee for a probabilistic one. VERIFIED by reading the
   architectures and the shipped inference code.
5. **They are also 1–10 GB.** Chatterbox needs ~1.50 GB of ONNX before it makes a sound. Orpheus
   is ~1.9 GB for the language model alone. Qwen3-TTS's smallest int4 export is ~1.29 GB and
   targets `onnxruntime-genai`, which has no browser build. VERIFIED by summing the actual file
   sizes on the Hub.
6. **The one genuinely new and relevant thing is KittenTTS v0.8** (Feb–Mar 2026). Same StyleTTS2
   family as Kokoro, 15M params, **41–78 MB**, and it emits **exact per-token durations**. I ran
   it: `sum(duration) × 600 == waveform.length`, exactly, every time. **RTF 0.060 on CPU** — an
   order of magnitude faster than Kokoro. It is not more expressive than Kokoro; it is smaller and
   much faster with the same timing guarantee. VERIFIED by execution.
7. **Correction to our own prior record.** `superwhisper-tts-postmortem.md` §1b says Kokoro's
   `speed` ONNX input is a no-op producing "byte-identical audio." **That is wrong.** I ran the
   model at 0.5/1.0/1.5/2.0 and got four different SHA-256 hashes with durations scaling exactly
   inverse-linearly. The old finding was a caller bug, not a model limitation. VERIFIED.

**The practical shape of the answer:** if the complaint is *expressiveness*, no local model fixes
it — the open-weights band tops out roughly where Kokoro already is, and the ~94 ELO gap to the
commercial frontier is only closable with a cloud API. If the complaint is *cost, latency, or
model size*, KittenTTS v0.8 Nano is a real and measurable upgrade over Kokoro that keeps the
timing guarantee intact.

---

## A. Browser platform changes since 2024

### A.1 Web Speech API: all the 2025–2026 work went to recognition. VERIFIED.

I fetched the live spec at <https://webaudio.github.io/web-speech-api/>. It is a **"Draft Community
Group Report, 10 August 2026"** — still not standards-track, but it did move from WICG to the
WebAudio Working Group.

Everything new in it is `SpeechRecognition`-side:

| New surface | What it does |
|---|---|
| `processLocally` | Force on-device recognition, no audio leaves the machine |
| `SpeechRecognitionPhrase` / `phrases` | Contextual biasing — hint domain vocabulary |
| `install()` / `available()` | Download and query language packs |
| `AvailabilityStatus` | `unavailable` / `downloadable` / `downloading` / `available` |
| `SpeechRecognitionQuality` | `command` / `dictation` / `conversation` tiers |

**`SpeechSynthesis` gained nothing.** I fetched
<https://github.com/WebAudio/web-speech-api/issues> and there is **not one open synthesis issue** —
every open item is about recognition availability, result timestamps, language-pack installation,
or session management.

The SSML language in the spec (`text` "may be either plain text or a complete, well-formed SSML
document") is unchanged and predates 2024. It has always been optional: engines that don't support
a tag must strip it. macOS is the notorious failure case —
[mdn/browser-compat-data#15663](https://github.com/mdn/browser-compat-data/issues/15663) documents
that macOS **reads the SSML aloud as literal text** instead of stripping it. So SSML is not a
prosody lever on this platform; it is a way to make the reader say "prosody rate equals slow."

### A.2 New browser-native speech APIs in 2026? Recognition only. VERIFIED.

Chrome 139 (Aug 2025) shipped the on-device Web Speech API
([chromestatus 6090916291674112](https://chromestatus.com/feature/6090916291674112),
[Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM/m/gwbtzV-lAQAJ)).
That is **speech-to-text**. As of Jan 2026 Chrome Platform Status was tracking
"Web Speech API: On-Device Recognition Quality" — again recognition.

There is no synthesis analogue: no Origin Trial, no WICG proposal, no shipped-but-obscure API for
neural TTS, prosody control, or expressive markup. The browser AI investment in 2025–2026 went to
the built-in Prompt/Writer/Rewriter family and to STT. TTS was skipped.

### A.3 macOS: Siri voices and Personal Voice are structurally out of reach. VERIFIED.

This is worth stating precisely, because it is a *permanent-looking* wall rather than a missing
feature:

- **Siri voices are blocked at the AVFoundation layer, not the browser layer.** Apple does not
  expose Siri voices to `AVSpeechSynthesizer` at all; if a Siri voice is the user's selected
  system voice, the OS silently substitutes a fallback voice of the same language code
  ([Apple Developer Forums thread 682438](https://developer.apple.com/forums/thread/682438),
  [thread 676726](https://developer.apple.com/forums/thread/676726)). The stated rationale is
  anti-impersonation. Because Chrome and Safari on macOS both bridge `speechSynthesis` to
  AVSpeech/NSSpeech, **neither browser can reach Siri quality.** No browser-side change fixes
  this.
- **Nobody has moved on it in over two years.**
  [HadrienGardeur/web-speech-recommended-voices#22](https://github.com/HadrienGardeur/web-speech-recommended-voices/issues/22),
  "Apple should allow the use of Siri voices through the WebSpeech API," was opened **6 May 2024**,
  is still **open**, is labelled `external-issue`, and has no 2025 or 2026 activity.
- **Personal Voice needs `kTCCServiceVoiceBanking`** — a native TCC authorization
  (`AVSpeechSynthesisPersonalVoiceAuthorizationStatus`) granted per-application
  ([Apple Developer Forums thread 757828](https://developer.apple.com/forums/thread/757828)).
  There is no web-facing permission for it, and there is no plausible design where a browser hands
  a website the user's cloned voice. macOS 26 Tahoe cut Personal Voice enrolment from 150 phrases
  to 10 ([AppleVis](https://www.applevis.com/blog/macos-tahoe-new-features-changes-improvements-bugs-blind-deafblind-low-vision-users)),
  which makes it easier to *create* — and changes nothing about web access.
- **Enhanced and Premium voices do appear in `getVoices()` once downloaded.** Folio already uses
  Ava and Zoe Premium, which is the empirical proof. That is the ceiling.

One caution worth carrying: iOS 26.0/26.1 shipped a regression where
`AVSpeechSynthesisVoice(language:)` ignores the user's Accessibility-selected voice and returns the
system default
([Apple Developer Forums thread 804648](https://developer.apple.com/forums/thread/804648)).
Whether the equivalent lands on macOS and leaks into `speechSynthesis.getVoices()` is
**UNVERIFIED** — I did not test it. If Folio ever ships voice selection that silently falls back,
this is the first thing to check.

### A.4 Does Chrome on macOS expose anything better than AVSpeechSynthesis? No. VERIFIED.

Chrome's `speechSynthesis` on macOS is a thin bridge to the system engine. There is no Google
neural voice path on desktop macOS (the Chrome-supplied `Google *` network voices are a
Chrome OS / Android arrangement). The `chrome.tts` / `chrome.ttsEngine` extension APIs let an
*extension* register as a voice provider — irrelevant to a Vercel-hosted static site, and it
would not add quality by itself, only a place to plug a different engine in.

**Net: A is a dead end.** The platform did not move. If Folio's read-aloud gets better, it gets
better because Folio ships a model or calls an API — not because Chrome shipped something.

---

## B. Local model comparison

### B.1 The table

"Browser path" means: loadable from a CDN as ESM with **no npm, no bundler, no emscripten**.
Sizes are the actual bytes you must download before first audio, summed from the Hub file listing.

| Model | Browser path (no build step?) | Size | Word timings | Expressive? | Long-form quality |
|---|---|---|---|---|---|
| **Kokoro-82M v1.0 `-timestamped`** | ✅ `AutoModel` via transformers.js CDN, or raw `onnxruntime-web` | 92.4 MB (q8) / 86 MB (q8f16) / 326 MB (fp32) | ✅ **`durations` float[1, seq] — per phoneme token, fractional** (VERIFIED, ran it) | Baseline. ELO 1478 on TTS Arena V2 | Proven — this is what the previous attempt shipped |
| **KittenTTS Nano v0.8** | ✅ `onnxruntime-web`; `model_type` is `style_text_to_speech_2` | **56.8 MB** fp32 + 3.3 MB voices | ✅ **`duration` int64[seq], `sum × 600 == samples` exactly** (VERIFIED, ran it) | Same StyleTTS2 family; 8 "expr-voice" voices; **not on any leaderboard** | Untested at length. **RTF 0.060 CPU** |
| **KittenTTS Mini v0.8** | ✅ same | 78.3 MB fp32 | ✅ same, exact | same | RTF 0.403 CPU |
| **KittenTTS Micro v0.8** | ✅ same | **41.4 MB** fp32 | ✅ **same, exact** (VERIFIED, ran it) | same | RTF 0.201 CPU |
| **Supertonic 3** | ✅ `web/` dir uses plain `onnxruntime-web`; also `pipeline('text-to-speech')` for v1 | ~398 MB (v3) / ~263 MB (v1), **fp32 only** | ❌ **`duration` is float[batch] = utterance total**, used only to trim padding (VERIFIED — parsed graph *and* read `web/helper.js`) | 31 languages, 10 voices; **not on any leaderboard** | Claimed RTF 0.3 on a Raspberry Pi (MARKETING) |
| **Piper (VITS)** | ✅ `piper-tts-web@1.1.2` | ~63 MB / voice | ❌ **graph emits `output` only** (VERIFIED — parsed `en_US-lessac-medium.onnx`) | Below Kokoro | n/a |
| **Chatterbox** | ⚠️ transformers.js v4 supports it, but **not** via `pipeline()` — needs `ChatterboxModel` + `ChatterboxProcessor` by hand | **~1.50 GB** (q4f16 LM; `speech_encoder` 591 MB and `conditional_decoder` 534 MB have **no** quantized variants) | ❌ autoregressive audio tokens; `exaggeration` is a forward param, alignment is not | **Top open model: ELO 1480** — +2 over Kokoro | Unknown; zero-shot cloning model, not a narrator |
| **Orpheus 3B** | ❌ ONNX exists but every variant is ~1.9–2.1 GB, and that is the **LM only** (no SNAC decoder) | ~1.94 GB min | ❌ autoregressive | Not on the leaderboard | ❌ |
| **Qwen3-TTS 0.6B / 1.7B** | ❌ ONNX targets **`onnxruntime-genai`** (no browser build); transformers.js support = **0 grep hits** | ~1.29 GB (int4, 7 graphs) | ❌ autoregressive | Not on the leaderboard. Claims instruction-driven emotion + 97 ms latency (MARKETING) | ❌ |
| **VibeVoice 1.5B** | ❌ PyTorch only, no ONNX | — | ❌ next-token diffusion | Designed for **podcasts**, 4 speakers, 90 min. Not on the leaderboard | Long-form *conversational*, MIT but "research purpose use" only |
| **Higgs (v2 / tts-3-4b)** | ❌ no usable browser export | — | ❌ | Not on the leaderboard | **Licence is research-and-non-commercial** — disqualifying |
| **Sesame CSM-1B** | ❌ PyTorch, and now **`gated: auto`** (access-restricted) | — | ❌ | Not on the leaderboard | Conversational, not narration |
| **IndexTTS-2 / 2.5** | ❌ PyTorch only | — | ❌ | Not on the leaderboard | Custom bilibili licence |
| **F5-TTS / E2-TTS** | ❌ PyTorch only, last touched 2025-03 | — | ❌ (flow-matching, no exposed durations) | Not on the leaderboard | — |
| **Fish / OpenAudio S1, s2-pro** | ❌ no ONNX | — | ❌ | OpenAudio **S2 ELO 1522, S1 ELO 1512** — but those are the **hosted API** entries | **Fish research licence** |
| **Dia 1.6B, Zonos, MegaTTS3, Maya1, Marvis, Kani** | ❌ PyTorch only | — | ❌ | Only Maya1 is on the board, at **ELO 1411** (below Kokoro) | — |

### B.2 What I actually ran, and the numbers

I installed nothing new — `onnxruntime` 1.23.2 and `numpy` 2.2.2 were already present. Identical
124-token input, native ORT CPU on Apple Silicon, best of 3 after a warm-up run:

| Model | File | Audio out | Synth time | **RTF** | Timing integrity check |
|---|---|---|---|---|---|
| KittenTTS Nano v0.8 | 56.8 MB fp32 | 8.45 s | 0.51 s | **0.060** | `sum(duration) × 600 == samples` — **exact** |
| KittenTTS Micro v0.8 | 41.4 MB fp32 | 15.53 s | 3.12 s | 0.201 | **exact** |
| KittenTTS Mini v0.8 | 78.3 MB fp32 | 6.03 s | 2.43 s | 0.403 | **exact** |
| Kokoro-82M `-timestamped` | 92.4 MB q8 | 8.75 s | 6.21 s | 0.709 | 597.7 samples per unit (durations are float) |

(Audio lengths differ because the inputs are random token ids — the models disagree about how long
each phoneme should be. The RTF column is the comparable number; the integrity column is the one
that matters.)

**Caveat, stated plainly:** this is *native* ORT CPU, not ORT-web WASM in a browser tab. Browser
WASM will be meaningfully slower; WebGPU should be faster. These numbers rank the models against
each other correctly; they are not a promise about in-tab throughput. The right way to settle that
is the RTF probe the previous attempt already wrote
(`reader-extension/offscreen.js:57-70` in the superwhisper repo — time a warm-up synthesis and
flag `RTF ≥ 0.6` as a silent WASM fallback). That instinct was correct: **measure the backend you
got, don't trust the one you asked for.**

### B.3 How the timing outputs actually differ — this is the crux

I parsed the ONNX protobufs by hand rather than trusting the model cards, because **the model
cards are wrong or silent about this in every single case.**

**Kokoro `-timestamped`** — decoded the raw ValueInfo bytes at offset 3604135 of
`model_q8f16.onnx`:

```
inputs : input_ids int64[1, sequence_length], style float[1, 256], speed float[1]
outputs: waveform float[1, num_samples]
         num_samples
         durations float[1, sequence_length]     <-- per phoneme token, FRACTIONAL
```

The base `onnx-community/Kokoro-82M-v1.0-ONNX` at the same offset has **only** `waveform` and
`num_samples`. The `-timestamped` repo is the whole difference, and its README is a **verbatim
copy of the base card that never mentions `durations`** — which is why this is hard to find. It
has 3,672 downloads and 8 likes, and was last touched **2025-02-21**.

One trap: `model_quantized.onnx` exposes **two** outputs (`waveform`, `durations`), while
`model_q8f16.onnx` exposes **three** (adds `num_samples`). Do not index outputs positionally
across dtypes — read `session.outputNames`.

**KittenTTS v0.8** — `config.json` is literally `{"model_type": "style_text_to_speech_2"}`, the
same architecture family:

```
inputs : input_ids int64[1, sequence_length], style float[1, 256], speed float[1]
outputs: waveform float[num_samples]
         duration int64[sequence_length]         <-- per phoneme token, INTEGER FRAMES
```

I ran it at 14, 32, 63 and 124 tokens. `len(duration) == len(input_ids)` every time, and
`sum(duration) × 600 == waveform.length` **exactly** every time. One duration unit = 600 samples
at 24 kHz = **25 ms**. Kokoro's frame is the same 600 samples but the values are fractional
(1.392, 2.005, …), so Kokoro is sub-frame precise while KittenTTS quantizes to 25 ms. For
highlighting, 25 ms is far below perceptual threshold — irrelevant.

**Supertonic — the false lead worth documenting.** Its `text_encoder.onnx` has an output literally
named `durations`, which looks like exactly what we want. It is not. The shape is
`float[batch_size]` — **one scalar per utterance**. Supertone's own browser code confirms the
semantics:

```js
// github.com/supertone-inc/supertonic/blob/main/web/helper.js
const duration = Array.from(dpOutputs.duration.data);   // :182
...
durCat = duration[0];                                    // :286   total seconds, index = batch item
durCat += duration[0] + silenceDuration;                 // :291
```

transformers.js does the same thing for Supertonic v1 — `_postprocess_waveform` uses
`durationsData[i]` where `i` is the **batch index**, purely to trim padding (dist line ~33088).
So the name is a trap: `durations` on Kokoro means alignment; `durations` on Supertonic means
"how long is this clip."

There is one genuinely interesting property buried in Supertonic though. It **has no phonemizer
at all** — it tokenizes by raw Unicode code point:

```js
const codePoint = text.codePointAt(j);
row[j] = (codePoint < this.indexer.length) ? this.indexer[codePoint] : -1;
```

Token index maps 1:1 to a character index in the NFKD-normalized source string. If Supertone ever
exported a per-token duration, it would be the **best possible alignment story for this app** —
timings directly in source-character space, no phoneme-to-word reconciliation at all. Today it
does not. Worth re-checking on each Supertonic release.

### B.4 The JS ecosystem, and one thing that will bite

VERIFIED against the npm registry and jsDelivr on 2026-08-18:

| Package | Latest | Published | Verdict |
|---|---|---|---|
| `@huggingface/transformers` | 4.2.0 | 2026-04-22 | Actively maintained. The only real option. |
| `kokoro-js` | 1.2.1 | **2025-05-03** | **15 months stale.** |
| `piper-tts-web` | 1.1.2 | 2025-07-08 | Works, but Piper has no timings. |
| `phonemizer` | 1.2.1 | 2025-01-16 | eSpeak-NG WASM. Stale but functional; ~1.3 MB bundled. |
| `supertonic` | 0.0.1 | 2025-12-11 | Node-only shape — `main: index.js`, no `module`, no `exports`, no `browser` field. |
| `@diffusionstudio/vits-web` | 1.0.3 | 2024-09-09 | Dead. |

**The thing that will bite: `kokoro-js` cannot give you the timings.** I read
`types/kokoro.d.ts` at version 1.2.1:

```ts
generate(text: string, { voice, speed }?: GenerateOptions): Promise<RawAudio>;
stream(text, opts): AsyncGenerator<{ text: string; phonemes: string; audio: RawAudio }, void, void>;
```

`generate()` returns audio and nothing else. `stream()` yields per-sentence `{text, phonemes,
audio}` — still no durations. The library was written before the `-timestamped` export existed and
has not been updated since. **To get `durations` you must bypass `kokoro-js`** and either drive
`onnxruntime-web` directly or use `AutoModel` from transformers.js, which returns the full output
dict:

```js
import { AutoModel } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const model = await AutoModel.from_pretrained(
  'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped',
  { dtype: 'q8', device: 'webgpu' }
);
const out = await model({ input_ids, style, speed });
// out.waveform, out.durations   <-- the pipeline API throws durations away; this does not
```

That is the no-build-step path. Note the transformers.js TTS *pipeline* is not the route:
`_call_text_to_waveform` does `const { waveform } = await this.model(inputs)` and discards
everything else (dist line ~33129).

**One genuinely useful v4 addition:** `ModelRegistry.get_file_metadata()` lets you compute the
exact download size before committing, `is_pipeline_cached()` checks the cache, and
`env.useWasmCache = true` makes the app work fully offline after first load. For a "download a
57 MB model?" consent prompt, that is exactly the API you want.

### B.5 The stuff nobody can evaluate

**Of every model on that list, only Kokoro, Chatterbox and Maya1 appear on any independent
listening test at all.** Supertonic, KittenTTS, VibeVoice, Higgs, IndexTTS, Qwen3-TTS, F5-TTS,
Dia, Zonos, MegaTTS3, Orpheus, CSM-1B, Marvis and Kani are **absent from TTS Arena V2 entirely**.

For those models, everything you can read about their quality is the authors' own demo page. That
is not evidence. Supertonic's "RTF 0.3× on a Raspberry Pi" and Qwen3-TTS's "97 ms end-to-end
latency" are speed claims, not quality claims, and neither is independently reproduced.

Two more things to note about the field's direction:

- **Kokoro is frozen.** `hexgrad/Kokoro-82M` was last modified **2025-04-10**. hexgrad's only
  other repos are `Kokoro-82M-v1.1-zh` (2025-03-04), `kLegacy`, and `styletts2`. There is no v2.
  With 12.5M downloads and 6,705 likes it remains the most-used open TTS model by a very wide
  margin — but it is a finished artifact, not a live project.
- **KittenML inherited the small-StyleTTS2 lane.** nano / micro / mini v0.8 all landed
  2026-02-19/20, with an `onnx-community` port on 2026-03-20. That is where the maintained
  browser-scale work is now.

---

## C. What "context-aware" means in 2026, and whether it matters for long-form reading

### C.1 The definition

"Context-aware TTS" in 2026 means: **an LLM reads the text, and its hidden states condition audio
generation** — so prosody is a function of what the sentence *means*, not just how it is spelled.
The architecture is consistent across the frontier:

- **VibeVoice** (Microsoft, MIT): Qwen2.5-1.5B backbone + a 123M-param diffusion head, continuous
  acoustic/semantic tokenizers at **7.5 Hz**, trained on a curriculum up to **65,536 tokens** of
  context. The card is explicit — the LLM exists "to understand textual context and dialogue
  flow." VERIFIED from the model card.
- **Chatterbox** (Resemble, MIT): a language model over discrete speech tokens, with an
  `exaggeration` scalar exposed as a forward parameter for emotion intensity. VERIFIED by reading
  `ChatterboxPreTrainedModel.forward_params` in transformers.js.
- **Orpheus, Higgs, Qwen3-TTS, CSM-1B**: same family. Qwen3-TTS adds natural-language style
  instructions ("speak in a very happy tone").

The tell is always the same: `past_key_values`, a `generate()` loop, discrete audio tokens.
**The property that makes them expressive is the same property that destroys alignment.** A
duration predictor is a non-autoregressive component — it says "this phoneme lasts 3 frames"
*before* any audio exists. An LLM emitting audio tokens one at a time has no such object to read.
This is not an export gap that a better ONNX conversion could fix; there is nothing to export.

### C.2 Is there a real quality gap for long-form document reading?

**Smaller than the marketing suggests, and pointed the wrong way for this use case.**

The evidence is the live TTS Arena V2 leaderboard, fetched 2026-08-18 from
`https://tts-agi-tts-arena-v2.hf.space/api/leaderboard` (42 entries, human blind pairwise
preference):

| Rank | Model | ELO | Votes | Open weights? |
|---:|---|---:|---:|---|
| 1 | Luna TTS | 1574 | 493 | closed |
| 2 | CastleFlow v1.0 | 1560 | 1643 | closed |
| 3 | Inworld TTS MAX | 1558 | 1468 | closed |
| 9 | Hume Octave | 1527 | 1128 | closed |
| 14 | OpenAudio S2 | 1522 | 496 | closed — entry links to `fish.audio`, i.e. the **hosted API**, not `openaudio-s1-mini` weights |
| 15 | Eleven Turbo v2.5 | 1511 | 1131 | closed |
| 29 | Eleven v3 | 1508 | 517 | closed |
| **32** | **Chatterbox** | **1480** | 1767 | **open (MIT)** |
| **33** | **Kokoro v1.0** | **1478** | 1033 | **open (Apache-2.0)** |
| 35 | Magpie Research Preview | 1474 | 448 | NVIDIA licence |
| 36 | NeuTTS Max | 1440 | 755 | — |
| 39 | Maya 1 | 1411 | 467 | open (Apache-2.0) |
| 41 | Veena | 1364 | 510 | open |

Read that carefully:

- **The top 31 entries are all closed commercial APIs.** Every one.
- **The best open-weights model beats Kokoro by 2 ELO points.** With 1,767 and 1,033 votes and
  stated uncertainties in the ±20–30 range, that difference is indistinguishable from zero.
  Eighteen months of open-weights TTS research produced, on the only public human listening test,
  **no measurable improvement over Kokoro-82M.**
- **The gap that is real is open-vs-closed:** 1574 vs 1480, roughly 94 ELO, about a 63% win rate.
  That gap is closed by paying for an API, not by downloading a bigger local model.

One honest caveat about this data: the `open` boolean in the API is applied inconsistently — only
Kokoro and Veena carry it, even though Chatterbox is MIT-licensed open weights. Treat the flag as
unreliable; the ELO numbers and vote counts are the signal.

And a caveat about the *methodology*, which matters a lot here: **the Arena tests short utterances,
which is not this app's use case.** A model that wins on a dramatic ten-second clip can be actively
worse over ninety minutes — expressiveness that reads as "alive" in a demo reads as "distracting"
in paragraph 400. There is **no public benchmark for long-form narration fatigue.** So the honest
statement is: the Arena shows no open model beats Kokoro on short-form preference, and nobody has
measured long-form at all.

### C.3 Anything tuned specifically for audiobook / long-form narration?

**One, and it is aimed at a different target.** VibeVoice is the only model in this survey built
for long-form: ~90 minutes of generation, 64K context, up to 4 speakers. But it is explicitly a
**podcast / conversational dialogue** model — multi-speaker turn-taking is the headline feature —
not single-voice document narration. It has no ONNX export, the card restricts it to "research
purpose use," and Microsoft has **disabled** the VibeVoice-Large weights.

Everything else in the 2025–2026 wave optimizes for the opposite of what Folio needs: zero-shot
voice cloning from a few seconds of reference audio, emotional range, conversational latency. For
"steady, natural, non-fatiguing for ninety minutes," a small deterministic non-autoregressive
model is arguably the *better* architecture — it cannot wander, cannot hallucinate a repeated
phrase, cannot drift in speaker identity across chunk boundaries. Those are real, documented
failure modes of autoregressive TTS on long inputs, and they get worse the longer the document.

**This is the part of the analysis I would push back on hardest.** The stated complaint is
"not expressive, doesn't understand sentence context." For a 20,000-word document that someone
reads for ninety minutes, expressiveness is not obviously the thing to optimize. Audiobook
narrators are trained to be *even*. The models that would fix the complaint are the ones most
likely to make a long read worse.

---

## D. Timing options if the best model has none

### D.1 Models that emit alignment natively — the complete list

After parsing every ONNX graph I could reach, the list is short:

1. **`onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`** — `durations` float[1, seq], fractional,
   per phoneme token. 86–326 MB. VERIFIED by execution.
2. **`onnx-community/KittenTTS-{Nano,Micro,Mini}-v0.8-ONNX`** — `duration` int64[seq], integer
   frames of exactly 600 samples, per phoneme token. 41–78 MB. **VERIFIED by execution for all
   three**; `sum(duration) × 600 == waveform.length` held exactly in every run.

That is it. Not Piper (parsed it — audio output only). Not Supertonic (per-utterance total). Not
any LLM-backbone model (structurally impossible). Both survivors are StyleTTS2, and both are
`model_type: style_text_to_speech_2`, so **one integration handles both** — swapping between them
is a URL change.

**The catch that killed the last attempt, restated because it has not gone away:** these durations
are in **phoneme-token space**, not source-character space. The eSpeak phonemizer expands `Dr.` →
*doctor*, `$5` → *five dollars*, `1990` → *nineteen ninety*, drops standalone punctuation, and
splits hyphenates. The previous implementation maintained a monotonic `wordCursor` across the whole
document (`offscreen.js:131` in the superwhisper repo) and **every mismatch shifted it permanently**
— perfect on sentence one, a full sentence behind by the end.

Native durations solve the *timing* problem and do not touch the *indexing* problem. The fix is
architectural, not numerical:

- Phonemize and synthesize **one sentence at a time**, and **re-anchor the cursor to the sentence's
  known source offset at every sentence boundary.** Error cannot accumulate past one sentence.
- Within a sentence, split the token run on the space token (Kokoro vocab id `16`) to get
  per-word spans — this works, I did it, the derived boundaries were clean and monotonic
  (`/hˌaʊ/` 0.346–0.528 s, `/kʊd/` 0.578–0.666 s, … `/bˈɔːɹn./` 7.440–8.264 s, total 8.250 s).
- When the phoneme-word count and the source-word count for a sentence **disagree**, do not guess
  per word — fall back to proportional interpolation **within that one sentence only**, and let the
  next sentence boundary resynchronize. A bounded, self-healing error instead of an unbounded one.

This is strictly better than what `speechSynthesis` gives today in resolution, and strictly worse
in indexing: `onboundary`'s `charIndex`/`charLength` point **into Folio's own source string in
UTF-16 units**, which is a guarantee no local model can offer. That trade is the whole decision.

### D.2 Sentence chunking with proportional interpolation — the accuracy you can expect

If you use a model with no durations at all, this is the fallback. You get, per chunk, the exact
source text and the exact audio duration — `kokoro-js`'s `stream()` yields precisely
`{text, phonemes, audio}` per sentence, and Supertonic's `web/helper.js` chunks English at 300
characters. Then you distribute words within the chunk.

**Realistic accuracy, and I want to be clear this is INFERRED rather than measured:** distributing
by character count (not word count — "a" and "extraordinarily" are not equal) over a ~15-word
sentence gives per-word error on the order of **±100–250 ms**, worst at the sentence's midpoint and
zero at its edges. Speech rate varies within a sentence by considerably more than character count
predicts — stressed syllables stretch, function words compress, and a comma inserts a pause that
character count cannot see.

For a **word-level** highlight that is visibly wrong: at a typical 150 wpm each word occupies about
400 ms, so a 200 ms error is half a word — the highlight sits between two words for a noticeable
fraction of the time.

For a **sentence-level** highlight it is exact by construction, because the chunk boundary *is* the
sentence boundary.

So the honest framing: **if you cannot get real durations, drop to sentence-level highlighting
rather than shipping word-level highlighting that is half a word off.** A correct sentence
highlight reads as deliberate. A wrong word highlight reads as broken.

### D.3 In-browser forced alignment — Whisper is still dead, but there is another door

**The Whisper path is confirmed dead.** I fetched
[huggingface/transformers.js#1739](https://github.com/huggingface/transformers.js/issues/1739)
through the GitHub API on 2026-08-18:

- Title: *"Whisper ASR pipeline leaks ~650 MB of GPU memory per 30 s chunk on WebGPU (both
  `return_timestamps` modes)"*
- **State: open.** Created **2026-08-03**. **Zero comments. Zero labels. Never updated.**
- Reproduced on `@huggingface/transformers` 4.2.0 + `onnxruntime-web` 1.26.0, Chrome 150, macOS,
  Apple Silicon, 24 GB unified memory: ~1.6 GB after pipeline init → **~8.1 GB after 300 s of
  audio**, and still ~7.8 GB at rest. On a 12 GB RTX 3060 it dies mid-run with
  `failed to call OrtRun ... [Invalid Buffer]`.
- Both `return_timestamps: true` and `return_timestamps: "word"` leak identically, so it is **not**
  the DTW/token-timestamps path — it is the pipeline itself.

Extrapolating to a 2.5-hour document: ~300 chunks × 650 MB. The tab dies long before the document
ends. The prior investigation's conclusion stands, and the issue being two weeks old with zero
maintainer response means it is not about to be fixed.

**But there is a second forced-alignment route that the prior investigation did not consider:
CTC forced alignment with wav2vec2.** This is what `torchaudio.functional.forced_align` does, and
it is a fundamentally lighter operation than Whisper:

- **The model exists in ONNX and transformers.js supports the class.** `Xenova/wav2vec2-base-960h`
  and `onnx-community/wav2vec2-base-960h-ONNX` ship `model_q4f16.onnx` at **66.5 MB** and
  `model_int8.onnx` at 95.3 MB. `Wav2Vec2ForCTC` is present in transformers.js 4.2.0. VERIFIED.
- **The alignment itself is ~50 lines of your own JS.** Run the encoder to get a CTC emission
  matrix `[T, vocab]`, then Viterbi that matrix against the *known* transcript. You already have
  the transcript — that is the whole point of forced alignment versus transcription. transformers.js
  has **no** `forced_align` helper (grep = 0 hits), so you write the dynamic program yourself.
- **The leak probably does not apply.** wav2vec2-base is **encoder-only with no KV cache and no
  autoregressive decode loop** — the structure most likely responsible for the Whisper leak.
  This is **INFERRED**, not verified: I did not run wav2vec2 in a browser for 2.5 hours. It is
  a hypothesis worth an afternoon of testing, not a claim to build on.

**When would this be worth it?** Only if a model with no native durations were otherwise
compelling. Given that Kokoro and KittenTTS both give exact durations for free, spending 66 MB and
an extra inference pass to recover what a 57 MB model hands you directly is hard to justify.
**File it as the escape hatch if a future no-timings model is good enough to be worth the trouble.**

---

## Honest verdict for this app

**Stay on `speechSynthesis` with Ava/Zoe Premium as the default. Nothing here is worth the
regression.**

The reasoning, in order of weight:

1. **The expressiveness complaint has no local fix.** The best open-weights model on the only
   independent human listening test beats Kokoro-82M by 2 ELO points — noise. If Ava/Zoe are not
   expressive enough, Kokoro is not the answer and neither is anything else that fits in a browser
   tab. The 94-ELO gap that would actually be audible is only bridged by a commercial API, which
   `tts-web-research-2026.md` already costed out.
2. **You would be trading a guarantee for an approximation.** `onboundary` gives `charIndex` and
   `charLength` **into Folio's own source string, in JS UTF-16 units**. Nothing else in this
   document can do that. Every local model reports timing in phoneme-token space and requires a
   reconciliation step that has already failed once in this codebase, for well-understood reasons
   (`superwhisper-tts-postmortem.md`). Re-anchoring per sentence bounds the error, but bounded
   error is still worse than no error.
3. **The cost is 57–92 MB and a first-run wait, per user, forever.** For a 20,000-word document
   the model download is a real UX event on a static site with no backend.

**Two things that would change the recommendation:**

- **If the real goal is cutting cloud cost or working offline** — not expressiveness — then
  **KittenTTS Nano v0.8** is a genuine and measurable win over the Kokoro path the previous attempt
  took: **56.8 MB instead of 92.4 MB**, **RTF 0.060 instead of 0.709** on identical input, exact
  integer per-token durations that satisfy `sum × 600 == samples` with no rounding, and
  `model_type: style_text_to_speech_2` so it is architecturally interchangeable with Kokoro. That
  is the only unambiguous upgrade this entire survey found.
- **If `onboundary` proves unreliable in practice** — MDN still flags desktop Chrome as a partial
  implementation with *"the `boundary` event does not fire as expected"* (crbug 40715888), though
  [mdn/browser-compat-data#28419](https://github.com/mdn/browser-compat-data/issues/28419) disputes
  that flag — then the calculus inverts, because the incumbent's one decisive advantage evaporates.
  **That is a 20-minute empirical test on the actual documents, and it should be run before any of
  this matters.**

**What I would do next, cheapest first:**

1. Instrument the current `speechSynthesis` path on a real 20k-word document and count
   `onboundary` firings against expected word count. If it holds, this whole document is a
   confirmation that you are already at the local optimum.
2. Re-read the complaint. If "not expressive" means "flat and robotic," compare Ava/Zoe against a
   short ElevenLabs or Inworld sample and decide whether the ~94 ELO gap is worth the money and the
   character-level-timing downgrade documented in `tts-web-research-2026.md` §B.1.
3. Only if 1 fails and 2 says no: prototype **KittenTTS Nano v0.8** with per-sentence
   re-anchoring, and measure highlight drift over 1,000 words before building any UI on it.

---

## What I did NOT do

- **I did not run any model in an actual browser.** All RTF numbers are native ORT CPU on Apple
  Silicon. Browser WASM will be slower and WebGPU faster, by amounts I did not measure. Nothing
  here is a promise about in-tab throughput.
- **I did not listen to a single audio sample.** Every expressiveness claim is either the TTS
  Arena V2 ELO or explicitly labelled marketing. I have no first-hand opinion on how any of these
  models sound.
- **I did not test KittenTTS or Kokoro with a real phonemizer.** I used the Kokoro README's real
  phoneme-id sequence for the timing-derivation test, and random valid token ids for the
  benchmarks. Duration *lengths* and the sample-accounting identity are exact and real; the
  duration *values* under random ids are not meaningful speech.
- **I did not test whether the Whisper leak also affects wav2vec2.** The reasoning (encoder-only,
  no KV cache) is sound but unproven. Treat D.3's alternative as a hypothesis.
- **I did not measure long-form narration quality for anything.** No public benchmark exists, and
  I did not build one. The claim that autoregressive models drift over long inputs is a documented
  general property, not something I observed in these specific models.
- **I did not check Firefox or Safari behaviour** for anything in section A beyond the Apple voice
  question. Folio targets Chrome on macOS.
- **WebSearch budget was exhausted early** (200/200 calls) so sections A and C lean on primary
  sources I could fetch directly — specs, GitHub APIs, the Hub API, npm, and shipped source —
  rather than on secondary reporting. That is a better evidence base, but it does mean I may have
  missed a 2026 model that has no Hub presence and no ONNX export. Given that no-ONNX already
  disqualifies a model here, the practical risk is low.
- **I did not evaluate the macOS 26 voice-selection regression** (Apple Forums 804648) against
  `speechSynthesis.getVoices()`. If Folio ships voice selection, verify it.

---

## Sources

**Specs and browser platform**
- Web Speech API spec (Draft Community Group Report, 10 Aug 2026) — <https://webaudio.github.io/web-speech-api/>
- Web Speech API issue tracker (no open synthesis issues) — <https://github.com/WebAudio/web-speech-api/issues>
- On-device Web Speech API, Chrome 139 — <https://chromestatus.com/feature/6090916291674112>
- Intent to Ship: On-device Web Speech API — <https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM/m/gwbtzV-lAQAJ>
- SSML not stripped on macOS — <https://github.com/mdn/browser-compat-data/issues/15663>
- `boundary` event partial-implementation dispute — <https://github.com/mdn/browser-compat-data/issues/28419>

**Apple voices**
- "Apple should allow the use of Siri voices through the WebSpeech API" (open since 2024-05-06) — <https://github.com/HadrienGardeur/web-speech-recommended-voices/issues/22>
- Siri voice unavailable to AVSpeechSynthesizer — <https://developer.apple.com/forums/thread/682438>, <https://developer.apple.com/forums/thread/676726>
- Personal Voice `kTCCServiceVoiceBanking` — <https://developer.apple.com/forums/thread/757828>
- iOS 26 voice-selection regression — <https://developer.apple.com/forums/thread/804648>
- macOS Tahoe accessibility changes — <https://www.applevis.com/blog/macos-tahoe-new-features-changes-improvements-bugs-blind-deafblind-low-vision-users>

**Listening test**
- TTS Arena V2 live leaderboard API (fetched 2026-08-18) — <https://tts-agi-tts-arena-v2.hf.space/api/leaderboard>
- TTS Arena V2 Space — <https://huggingface.co/spaces/TTS-AGI/TTS-Arena-V2>

**Models (all file sizes and graph signatures verified against these)**
- <https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped>
- <https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX>
- <https://huggingface.co/onnx-community/KittenTTS-Nano-v0.8-ONNX> · [Mini](https://huggingface.co/onnx-community/KittenTTS-Mini-v0.8-ONNX) · [Micro](https://huggingface.co/onnx-community/KittenTTS-Micro-v0.8-ONNX)
- <https://huggingface.co/Supertone/supertonic-3> · <https://huggingface.co/onnx-community/Supertonic-TTS-ONNX>
- <https://github.com/supertone-inc/supertonic> (`web/helper.js` duration semantics)
- <https://huggingface.co/onnx-community/chatterbox-ONNX> · <https://huggingface.co/ResembleAI/chatterbox>
- <https://huggingface.co/onnx-community/orpheus-3b-0.1-ft-ONNX>
- <https://huggingface.co/onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice>
- <https://huggingface.co/microsoft/VibeVoice-1.5B> · [tech report](https://arxiv.org/abs/2508.19205)
- <https://huggingface.co/rhasspy/piper-voices> (`en_US-lessac-medium.onnx`)
- <https://huggingface.co/Xenova/wav2vec2-base-960h>
- <https://huggingface.co/models?other=onnx&pipeline_tag=text-to-speech&sort=trending>

**JS runtime**
- transformers.js v4.0.0 release notes — <https://github.com/huggingface/transformers.js/releases>
- transformers.js v3.8.0 (Supertonic TTS) — PR [#1459](https://github.com/huggingface/transformers.js/pull/1459)
- transformers.js v4 (Chatterbox) — PR [#1592](https://github.com/huggingface/transformers.js/pull/1592)
- **Whisper WebGPU memory leak, still open** — <https://github.com/huggingface/transformers.js/issues/1739>
- `kokoro-js` 1.2.1 API surface — <https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/types/kokoro.d.ts>
- npm registry metadata for `kokoro-js`, `@huggingface/transformers`, `piper-tts-web`, `phonemizer`, `supertonic`, `@diffusionstudio/vits-web`

**Working notes** — raw search log, byte dumps and benchmark scripts: `.notes/tts-local-2026-research.md`

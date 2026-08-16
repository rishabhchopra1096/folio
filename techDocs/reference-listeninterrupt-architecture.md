# Interruptible AI Document Reader — Architecture & Build Research

**What it is:** Paste a document → press play → lock the phone → it reads to you (Speechify Simba
TTS) through the locked screen while you're at the gym (EarPods **or** AirPods). You interrupt by
*speaking*. It stops, handles you like an intern taking dictation, then resumes. At session end, the
interruptions become structured thinking notes.

**Status:** first-principles architecture below (this doc). Six deep-research agents are filling in
each hard component; their findings get collated into the numbered sections.

---

## First principles: it's TWO machines with one gate between them

The whole system is two modes and a transition:

- **READ mode** — cheap, one-way, mostly on-device. TTS plays the document. An **on-device gate**
  listens for "the user wants in." No cloud STT running. Cost ≈ TTS only (~$0.4/hr).
- **CONVERSE mode** — expensive, two-way, cloud. Activated **only** when the gate fires. STT + LLM
  handle the interrupt, then hand control back to READ. Cost ≈ pennies per interrupt.

Everything hard about this product is one of three things: **(1) making the gate reliable in gym
noise, (2) making the READ↔CONVERSE handoff seamless (pause → handle → resume-at-exact-position),
and (3) the position math for rewind.** Get those three right and the rest is glue.

This two-mode split is also the cost answer: the same on-device gate that rejects gym noise is what
lets us avoid paying for always-on cloud STT → ~$0.5/hr instead of ~$2/hr (≈4× cheaper). Your
"the call starts when I interrupt" instinct is the correct architecture.

## The state machine (the "intern" model)

```
                 ┌───────────────────────────────────────────────┐
                 │                                               │
                 ▼                                               │
   ┌─────────┐  gate fires   ┌────────┐   STT    ┌───────────┐   │
   │ READING │──(your voice)─▶│ PAUSED │─────────▶│  ROUTE     │   │
   │ (TTS)   │  pre-roll flush└────────┘          │ (classify) │   │
   └─────────┘                                    └─────┬──────┘   │
        ▲                                               │          │
        │                    ┌──────────────────────────┼──────────┼────────────┐
        │                    ▼                          ▼          ▼            │
        │            NAVIGATION                    RESEARCH        NOTE          │
        │        go back (=15s default)         "what does       "take a        │
        │        go back N seconds              that mean /       note"          │
        │        go back a paragraph            research that"   auto-anchor     │
        │        go forward                          │           to current ¶    │
        │            │                               ▼           + categorize    │
        │      change playhead                 answer (RAG/web)       │          │
        │            │                          + TTS the answer      │          │
        │            │                               │               │          │
        │            │                        ASK "resume?" ──yes────┤          │
        └────────────┴───────────────────────────────┴───────────────┘  RESUME  │
                                                                         at saved │
                                                                         playhead─┘
```

**Resume policy:** navigation resumes **immediately** at the new position. A note resumes
**automatically** at the same spot. A research answer **asks first** ("want me to keep reading?")
and resumes on "yes" — because after a research tangent you may want to keep talking.

**"Go back" grammar:** bare "go back" = −15s. "go back 30 seconds" = −30s. "go back to the previous
paragraph" = paragraph boundary. "go forward [N]" = +. Anything not about navigation and not "take
a note" → treated as a question/research.

---

## Component map (what has to exist)

| # | Component | Role | Reuses from our stack? |
|---|---|---|---|
| 1 | **On-device interrupt gate** | detect *your* intentional speech in gym noise; open cloud only then | new (Silero VAD + Picovoice Eagle speaker-verify + optional wake word) |
| 2 | **Simba TTS player + position** | synthesize per-¶, cache audio+marks, track playhead, rewind | Speechify Simba (have) + speech marks |
| 3 | **Intent router** | classify interrupt → nav / research / note; extract params | new (grammar + fast LLM) |
| 4 | **Reader state machine** | pause/resume, the confirm-resume flow, drive TTS deterministically | LiveKit agent control (have) |
| 5 | **iOS client audio** | locked-screen playback + continuous on-device mic + LiveKit-on-trigger, EarPods/AirPods | CallKit + background audio (have) |
| 6 | **Intelligence handlers** | research/RAG + web-call, note anchoring/categorization, end-session synthesis | Gemini + notes pipeline (have) |

## The cost model (from prior research)

READ ≈ Simba TTS ~$0.4/hr (dominant, unavoidable — it's premium voice) + on-device gate ~$0.
CONVERSE ≈ only during interrupts (STT ~$0.008/min-of-interrupt + a cheap Gemini call). Ten 30s
interrupts ≈ ~$0.05. **All-in ≈ ~$0.5/hr, ~4× cheaper than an always-on agent (~$2/hr).**

## The crux, stated bluntly

The make-or-break is component #1 on a **bare pocketed phone** — worst-case far-field muffled mic in
a loud gym; it *will* misfire. **EarPods (wired) and AirPods move the mic near-field** and change the
odds a lot (AirPods add beamforming + Voice Isolation; wired EarPods at least sit near the collar).
The design targets **headset-first**, bare-pocket best-effort. This is the ONE thing to field-test
before building anything else.

---

## 1. On-device interrupt gate — ✅ RESEARCHED (the make-or-break)

**Verdict: a headset is effectively REQUIRED; bare-pocket is a NO-GO as the primary path. The gate is
a layered on-device chain, and its biggest risk (Eagle's noise accuracy) is unpublished → field-test
it FIRST, before building any cloud.**

**The layered gate (cheapest-first, one 16kHz/512-sample/16-bit tap feeds all stages):**
```
(0) iOS VoiceProcessingIO  — free AEC+NS+AGC. MANDATORY on bare-speaker path (echo).
(1) Silero VAD             — "speech energy now?" <1ms/32ms chunk, ~1-2MB, threshold ~0.6-0.7,
                             min_speech_duration ≥250ms (discards single-frame clangs).
                             Rejects silence/clangs. Does NOT reject other humans or vocal music.
(2) Porcupine wake word    — OPTIONAL but RECOMMENDED. The ONLY stage with published noise robustness:
    "hey <word>"             97.3% detect @ <1 false-alarm/10hr @ 10dB SNR *with background speech*.
                             Rejects ambient chatter/music/incidental owner speech. Low sensitivity,
                             ≥6-phoneme phrase.
(3) Picovoice Eagle        — owner speaker-verification. 4.5MB, EER 0.18% on CLEAN data.
    (speaker verify)         ⚠ NOISE accuracy UNPUBLISHED = the gate's #1 risk. NO React-Native SDK
                             (needs a native bridge). Licensing: free=3 users/mo (dev only), beyond =
                             enterprise, 12-mo min, no public price.
(4) Flush 2-3s pre-roll ring buffer → connect LiveKit + publish mic. Audio leaves the device ONLY here.
```

**WHY bare-pocket fails (the non-obvious killer):** it's not mainly far-field muffling — it's
**self-echo**. TTS plays through the phone's loudspeaker; the open mic hears your own reading voice and
the **VAD self-triggers continuously**. Killing that needs AEC, which iOS tunes for near-field calls
and which degrades badly at loud speaker volume. **A headset makes the problem vanish** (TTS goes into
the ears, not the mic).

**Per-mic ranking: AirPods ≫ wired EarPods ≫ bare pocket.**
- **Wired EarPods = the minimum VIABLE config, and it genuinely beats bare pocket** for two independent
  reasons: (a) no self-echo (TTS in the ears), (b) mic at the collar ~20–30cm = near-field, unmuffled →
  keeps Eagle out of its bad-EER regime (near-field EER ~2.3% vs ~6–15% far-field/reverberant). No
  beamforming, so ambient still gets in → rejection rests on the wake word + Eagle.
- **AirPods = best** — H2 does owner-voice isolation + beamforming in *hardware*, before your app sees
  the stream. **UNKNOWN (device-test): whether a 3rd-party `AVAudioSession` capture actually receives
  the Voice-Isolation-processed stream, or if it's reserved for system call audio** — this could
  downgrade AirPods to "EarPods with no echo."
- **Product decision: require a headset; design for EarPods/AirPods; bare-pocket = unsupported/degraded.**
  The headset requirement isn't a UX compromise — it's what makes the gate physically work.

**Noise suppression is mostly the wrong tool:** speech-preserving denoisers (RNNoise/DeepFilterNet)
*keep all speech* → they can't reject other people's voices (only Eagle can). Use the free iOS
`VoiceProcessingIO` for quality; gate with VAD+Eagle; for clangs use a transient/refractory guard, not
a denoiser swap. (Krisp Background *Voice* Cancellation can reject voices but assumes a near-field
primary speaker — wrong for a pocket; also enterprise-priced.)

**Locked-screen legality:** ✅ the constraint is process-state, not the lock — a session **started in
the foreground** (you're already playing TTS) keeps the mic alive when pocketed/locked. You never
cold-start mic from background. First-party precedent: iOS 18 Vocal Shortcuts (always-listening
on-device keyword detection). Orange mic dot on the whole session (unavoidable). Silero: use
**FluidAudio** (CoreML/ANE, built for always-on) on iOS.

**Battery: UNKNOWN — measure.** VAD itself is negligible (~3% duty cycle, ANE-offloaded); the real
draw is TTS playback + mic I/O ≈ a podcast app + a voice-call's mic path.

### ⭐ THE GO/NO-GO FIELD TEST (run this BEFORE building anything else)
**"Silent-reading-through-the-gym":** run the full on-device gate with **NO cloud attached**. Enroll
the owner in Eagle; owner wears **wired EarPods** (the minimum viable config); phone locked, TTS
reading at real gym volume, 30–60 min; owner **silent except 10 scripted "hey <word>, go back"
interrupts**. Log Silero/Porcupine/Eagle + every gate *decision*, hand-label vs ground truth. **Two
numbers decide the whole product:** false-opens/hour (target ~0–1) and missed interrupts (target
~0/10). **Go if both are low on wired EarPods.** This costs $0 (no cloud/STT), and it directly
measures the one thing every vendor left unpublished — Eagle's real-world noise EER on your mic. A gate
that opens on the gym is a cloud bill on every false open; no downstream cleverness fixes it.
## 2. Simba TTS player, position tracking & rewind — ✅ RESEARCHED

**Verdict: Simba gives us exactly what's needed, and rewind is free by construction.**

**Speech marks (the position substrate).** Simba returns **word-level timing in milliseconds AND
character start/end indices into your input text**, with a sentence/paragraph parent:
```
NestedChunk (word): { start_time, end_time: ms; start, end: char index; value: string }
SpeechMarks (sentence/¶): { start, end, start_time, end_time, value, chunks: NestedChunk[] }
```
Two ways to get them: **batch `POST /v1/audio/speech`** (all models) and **streaming
`POST /v1/audio/stream/with-timestamps`** (SSE, **simba-3.0/3.2 only** — legacy voices 400).
Use **simba-3.2** (the `_32` voices, e.g. `geffen_32`), stream `output_format: pcm_24000`.

**Rewind is $0.** Speechify bills per *character sent to the API*; replaying cached audio = zero
calls = zero charge. The only re-charge risk is eviction+re-synth → kill it with a **persistent disk
cache keyed on `hash(text|voice|model|format)`**.

**Caching strategy:** synthesize **per paragraph** (merge headings; split >~800 chars); stream the
current ¶, **prefetch 2–3 ¶ ahead**; keep **all marks for the whole doc in memory** (tiny JSON) +
audio in an LRU memory cache **and** the disk cache. Never synth the whole doc up front.

**The mapping math (playhead ↔ char-index):** build a global timeline `docStartMs[p] = Σ durations`;
`globalPlayhead = docStartMs[current] + player.currentTime`. Resolve "word at time t" as the **last
word with `startTime ≤ t`** (binary-search FLOOR — never a range test, marks have gaps).
- "go back" (=−15s) / "go back N s": `target = max(0, H − N·1000)` → floor to the word → resume at
  its `startTime` (word boundary). ✅ matches your "start_time ≤ target" spec.
- "previous paragraph": restart current ¶ unless within ~1.2s of its top, else jump to `p−1` top
  (music-player "previous track" feel).
- "go forward [N]": symmetric, clamped to the synthesized frontier.

**iOS player: AVAudioEngine + AVAudioPlayerNode + PCM buffers** → sample-accurate seek
(`scheduleSegment(buffer, startingFrame:)`) and gapless ¶ chaining, all off the cache. (Note:
`playerTime` resets on each schedule — store `baseLocalMs` at each seek.)

**Gotchas (verified against docs):**
1. Leading silence — first word `start_time ≠ 0`; always drive off actual `startTime`.
2. Marks have gaps — resolve with `≥`/floor, never `start ≤ t ≤ end`.
3. SSML entity-escaping shifts char indices — **send plain text, store the exact string sent** as
   `paragraph.text` so marks index 1:1.
4. `text_normalization` (on by default in batch, off in streaming): "$5"→"five dollars" spoken, but
   char anchors still point at "$5" — highlighting stays right; keep it on for natural reading.
5. Per-¶ synthesis resets times+char indices → offset by `docStartMs[p]` + `charOffsetInDoc` for
   doc-global position.
6. Streaming marks are **absolute ms from synth start** — concatenate audio in arrival order, pool
   all marks; which chunk a mark arrives on is meaningless.

**Cost/latency:** ~$0.27–0.55 per listening-hour (per-char, ~45–55k chars/hr); **rewind $0**.
Simba-3.2 marketed "lowest TTFB" but **no numeric figure documented** (~200–300ms is an *unconfirmed*
estimate). Stream the current ¶ for fast first-audio; batch only for far-ahead prefetch.

**OPEN (verify with a live call before coding):** exact SSE `speech.chunk` body field names
(`audio_data`/`speech_marks` inferred, not seen verbatim); the real TTFB number; the `type` enum on
marks. → **first build step: one live streaming call, log a raw event.**
## 3. Intent classification & routing — ✅ RESEARCHED

**Verdict: hybrid router. On-device grammar for nav (instant, offline, free); one-shot LLM
tool-call for everything else (which you need anyway).**

**The key reframe: the classifier is NOT the latency bottleneck — endpointing + STT stabilization
are (200–500ms, the biggest killers).** A local regex/fuzzy classify is ~1–5ms, noise on the budget.
So the <300ms target is won by attacking turn-detection, not routing.

**Architecture (sequential, grammar-first):** barge-in → STT partial→final → run local nav grammar
(<5ms) → **high-confidence nav executes the seek immediately, NO LLM call** → miss/low-confidence →
**one-shot LLM tool-call** (`navigate` / `answer_question` / `take_note`). Don't fire the LLM
speculatively in parallel (costs +50–70% LLM calls; RabbitWhole is cost-sensitive).

**Nav commands are self-delimiting — exploit it:** "go back" is complete the instant those words hit
the partial transcript, so you can **trigger on the stable partial and beat end-of-turn detection
entirely** (a latency win unique to the closed nav set; guard with ~150–250ms debounce + idempotent
**absolute** seek so "go back…to the start" doesn't fire early on "go back").

**The nav grammar** (regex over the normalized STT transcript, after number-parsing):
- Direction: BACK = `back|go back|rewind|reverse|previous|last`; FORWARD = `forward|ahead|skip|next`.
- Unit: `second(s)` (default), `minute(s)`→×60, `paragraph|section`, `sentence|line`.
- Defaults: bare "go back" → **15s** (spec); "previous paragraph" → unit=paragraph,1; **[OPEN: go
  forward default, and "go back one" ambiguity — product decisions]**.
- **Precision guards (critical):** require short/imperative (≤~6 tokens) OR utterance-initial; REJECT
  if a question word is present or the nav phrase is embedded ("why did they *go back* to…?" must NOT
  navigate). Tune for **precision, not recall** — the LLM catches anything the grammar rejects.

**Number parsing:** `word2number` (wrap it — it throws on no-number, ignores units) + regex span
extraction + an idiomatic map ("a minute"→60, "half a minute"→30, "a couple"→2–3s) + clamps
(sec∈[1,300]) + compute ONE absolute seek target (idempotency vs partial-then-final).

**STT robustness in gym noise** (layered matcher, first confident hit wins): exact/regex → RapidFuzz
(`partial_ratio`, ~80–85) → Double Metaphone (sound-alikes) → **explicit alias dict for voiced/
unvoiced swaps** phonetics miss (`pack/black→back`, `dirty/thirdy→thirty`, `for word→forward`).
Feed word-level STT confidence in if available; low-confidence amount slot → drop to LLM.

**LLM fallback = one-shot fused call** (classify+extract+begin-handling in one round-trip): tools
`navigate(direction, amount, unit)`, `answer_question(query)`, `take_note(text)`. Gemini Flash-Lite
short-prompt TTFT ~240–290ms (NOT the misleading 5.54s AA figure — that's a 10k-input artifact).

**Confidence policy:** auto-act >0.85; below → route to LLM (don't ask a clarifying question — the
LLM's tool-choice IS the disambiguator, and satisfies "ambiguous → default to question"). **Bias
toward acting over asking** — nav is cheap/reversible; a wrong 15s jump costs one "go forward",
whereas confirming on every ambiguous utterance is maddening.

**Failure modes:** question-misrouted-as-nav (→ precision guards, top priority); premature partial
action (→ debounce + absolute seek); "note that" vs "no, that's" homophone (→ require "take a note");
LLM outage (→ nav still works offline, good isolation). **OPEN:** verify our STT (LiveKit/AssemblyAI)
exposes partial transcripts + word confidence — the eager-partial-trigger optimization depends on it.
## 4. Reader state machine, pause/resume & LiveKit control — ✅ RESEARCHED

**Verdict: the reader is a CLIENT-SIDE deterministic player, never LLM-driven; LiveKit connects only
for the CONVERSE turn. This aligns with the on-device gate and keeps READ at ~zero cloud cost.**

**Never read via the LLM** (`llm_node`/`generate_reply`): LLMs paraphrase (won't emit verbatim), you'd
pay tokens for the whole doc on every resume, and streamed tokens have no stable playhead. Reading a
fixed doc is deterministic *playback*, not generation.

**Topology B (RECOMMENDED) — client-side player:**
- **READ:** the client synthesizes/plays Simba TTS locally and owns the playhead
  `(chunkIdx, word/charOffset, elapsedMs)` — **exact and free**, no framework estimation. LiveKit is
  NOT in the audio loop. On-device gate fires → client pauses **instantly (0 cloud RTT)**, snapshots
  the playhead.
- **CONVERSE:** on interrupt, stream mic into the LiveKit `AgentSession` (STT→route→handle→confirm).
  **Pre-warm the room at session start but keep input muted** (`session.input.set_audio_enabled(False)`
  during READ; `True` on interrupt) to dodge per-interrupt reconnect latency.
- **RESUME:** `set_audio_enabled(False)` + resume local playback from the snapshot.
- (Topology A — a server-side `session.say()` reader — is simpler but needs always-on cloud STT for
  barge-in = exactly the cost the on-device gate avoids. Rejected given the gate.)

**Interruption is a CANCEL, not a pause** (`clear_buffer()` drops buffered audio; no native
resume-from-offset). The only auto-resume, `resume_false_interruption`, fires **only for noise
false-positives and re-synthesizes the tail** (not bit-exact). → **implement resume yourself**: client
resumes local playback from the snapshot. (Trivial in Topology B; in A you'd `say(remaining_text)`.)

**The state-machine hook** (both topologies): override `on_user_turn_completed(turn_ctx, msg)` →
`classify()` → for nav/note: handle + `raise StopResponse()` (suppresses the default auto-reply) then
resume; for research: fall through to `generate_reply()`, then run the confirm-resume. **Gotcha:
`commit_user_turn()` ALWAYS auto-replies (issue #5026) — `on_user_turn_completed` + `StopResponse` is
the supported way to gate it.**

**Confirm-resume sub-dialogue** ("keep reading?"): use LiveKit's typed **`AgentTask[bool]`** with
`@function_tool keep_reading()/stop_reading()` → returns a clean bool; run it **only on the research
branch** (nav/note resume automatically after a brief ack).

**Latency:** `preemptive_generation` (default on) starts the answer LLM before end-of-turn is
confirmed → the answer begins the instant the user stops. Lower `min_endpointing_delay` (0.5→0.3s) for
the CONVERSE turn. **`use_tts_aligned_transcript` = accurate spoken-so-far IF the TTS emits word
timestamps — Simba does (§2)**, so even the server topology could get an exact playhead; but the
client player is exact for free.

**Key config defaults (v1.6.x):** `allow_interruptions` True, `min_interruption_duration` 0.5s,
`min_interruption_words` **0** (lets noise interrupt — raise it, or rely on the on-device gate),
`min_endpointing_delay` 0.5s. **OPEN:** whether a warm session with input disabled incurs residual STT
billing (verify); the public API to read `PlaybackFinishedEvent` at session level (needs-verify).
## 5. iOS client audio architecture (locked-screen mic + playback + LiveKit) — ✅ RESEARCHED

**Verdict — the fix for the three-way audio fight we bled on:**
1. **One session owner: your app** (`registerGlobals({autoConfigureAudioSession:false})`), configured
   once and held. **Both** `isAutomaticConfigurationEnabled` **and** `isAutomaticDeactivationEnabled`
   OFF (different levers — the RN flag only covers the first).
2. **Do NOT use CallKit.** Continuous background mic is already legal via `UIBackgroundModes=audio` +
   `.playAndRecord`; CallKit re-introduces the manual-audio coordination that burned us, and its
   call-UI/Recents semantics are wrong for a reader (App-Review risk). Residual cost = G1 below.
3. **Run ONE audio engine — LiveKit's.** `AudioManager.startLocalRecording()` runs the mic **with no
   room connected** → buffers to `capturePostProcessingDelegate` for on-device VAD + speaker-verify;
   push Simba PCM into the same engine via `mixer.capture(appAudio:)`. **Single I/O graph = no
   second-engine contention** (the root cause of our prior CallKit-vs-LiveKit pain). AEC is then free
   (TTS + mic share one voice-processing unit).
4. **Hold `.playAndRecord` constant across READ↔CONVERSE; never `setActive(false)` or category-swap.**
   That handshake is what causes route thrash, the A2DP↔HFP flip, and the stuck-session bug.

**Locked-screen:** `.playAndRecord` + mode `.spokenAudio` (couples to AEC choice), `UIBackgroundModes=
audio`, `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` (map skip fwd/back to paragraph). **Trap:
audio must keep flowing — pausing BOTH TTS and the mic tap → iOS suspends you in seconds**; keep the
tap running during a pause.

**Continuous mic legality:** legal without CallKit, BUT (a) must **start in the foreground** (can't
cold-start mic from a background launch), (b) the **orange mic dot is on the whole READ session and
can't be hidden** (privacy fact to design around), (c) `NSMicrophoneUsageDescription` + honest App
Review disclosure. Note: LiveKit's "prewarm muted" mode = engine warm but **muted** (no gate audio) —
the gate needs an **un**muted tap, hence the dot.

**EarPods vs AirPods (you said design for both):**
- **Wired EarPods = the easy/best path** — separate in/out lines, full-quality playback + simultaneous
  mic, lowest latency, no Bluetooth penalty.
- **AirPods = hard** — a BT headset holds ONE profile: A2DP (hi-fi, output-only) OR HFP (bidirectional,
  call-grade). A live gate mic forces **HFP → TTS drops to call quality** — UNLESS **iOS 26 + H2
  AirPods (4 / Pro 2)** where `bluetoothHighQualityRecording` gives a better-than-HFP link. **iOS 26
  build break:** `.allowBluetooth` → `.allowBluetoothHFP` (guard `#if compiler(>=6.2)`); set both it +
  `.bluetoothHighQualityRecording`.
- Handle `routeChangeNotification` (unplug auto-pauses; on new device re-apply `setPreferredInput`,
  re-query `isEchoCancelledInputAvailable`, re-arm the gate).

**The interrupt transition (race-free because nothing deactivates):** gate fires → pause TTS (fade
`mixer.appVolume`, snapshot playhead) → `room.connect()` + `setMicrophone(true)` (engine+mic already
up, session already `.playAndRecord` → **no route change, no setActive**) → converse → `setMicrophone
(false)` + `room.disconnect()` (session stays put) → re-arm gate + resume from playhead.

**Gotchas that WILL bite:** **G1** a real phone call while locked can strand the session
(`setActive` fails 560557684, "permanently interrupted" until foreground) — the price of no CallKit;
detect + recover on next foreground, tell the user a call pauses the reader. **G3** gate self-triggers
on its own TTS without shared AEC → single-engine routing or `setPrefersEchoCancelledInput` (narrow:
iOS 18.2+, `.playAndRecord`+`.default`, 2024+ iPhones only). **G5** mic permission must be resolved
before engine start. **G6** orange dot always on + audio-must-flow. **OPEN (soak-test):** single-engine
local-recording + app-audio injection running for HOURS under lock (battery/thermals/OS-interruption
survival) is each-piece-documented but the *combination at multi-hour* is unverified; and RN-bridge
parity for `startLocalRecording`/`mixer.capture`/`isAutomaticDeactivationEnabled` (likely needs a small
native module).
## 6. Intelligence: research/RAG, note anchoring, end-session synthesis — ✅ RESEARCHED

**(D) RAG substrate — NO vector index.** A pasted doc is 2k–40k tokens = 3–5% of Gemini 3.6's 1M
window; RAG only wins when relevance drops <20% (huge corpus) — a doc you're actively reading is
~100% relevant. **Stuff the whole doc into context**, chunk by paragraph (aligned 1:1 with the TTS
paragraphs; each `{para_id, start_byte, end_byte, text}`), pass a `<<CURRENT PARAGRAPH: para_id=N>>`
marker. **Context-cache the doc once at session start ($0.15/1M)** — every interrupt + the synthesis
reuse it instead of re-sending → the single biggest COGS lever. Add embeddings ONLY for cross-doc
questions or docs >150–200k tokens.

**(A) Research / "what does that mean" handler.** Use **Gemini's native `google_search` tool in AUTO
mode as the gate** — one call: it answers from the in-context doc directly (no search, fast), and
only escalates to a web query when the answer needs external facts. That IS your "local-first,
escalate only when needed" — the model gates it in one round-trip (beats a hand-rolled two-stage
gate, which doubles latency on exactly the slow queries). Self-routed fallback if it over-searches or
grounding's off your tier: **Brave Search (669ms, best agent score)**; **avoid Perplexity/Parallel
(11s+ — a dropped session mid-workout)**.
- **Keep the spoken answer SHORT:** system prompt ("2–3 sentences, <50 words, no lists/markdown/URLs,
  plain spoken, end by asking to resume") + **hard `max_output_tokens ≈ 80–120`** (belt+suspenders) +
  stream tokens straight into streaming TTS.
- **Mask search latency:** on a search decision, immediately play a cached filler ("one sec, let me
  check that…") so audio starts <300ms while the 3–5s search runs.
- **Hand-back:** make "…keep going?" the last clause of the generated answer; arm a yes/no listener;
  "yes/continue" resumes TTS from the interrupt anchor, anything else = a follow-up (loop back to A).

**(B) "Take a note" handler + auto-anchoring (the crux — offset semantics).**
- Anchor to the **audio PLAYBACK position** `t_ms` (not the synthesis cursor — synth runs ahead) →
  speech mark with greatest `time ≤ t_ms` → its byte offset → the paragraph enclosing it.
- **GOTCHAS that silently corrupt anchoring:** (1) speech-mark offsets are **UTF-8 BYTES, not chars**
  — any emoji/curly-quote/em-dash desyncs; index paragraphs in bytes. (2) TTS-input ≠ source text
  (SSML/normalization) → need the TTS-input↔source map. (3) **Human reaction lag** — the user reacts
  to what they heard ~0.5–1.5s ago; anchor to `t_ms − ~700ms` and **capture a ±1 paragraph window**
  so a slightly-off anchor still holds the referenced idea.
- **Categorize with enum-constrained structured output** (`response_schema`, category = Literal
  `question|disagreement|idea|todo|highlight`) so it's *always* a valid label — and **pass the source
  excerpt** so "that's wrong" (disagreement) vs "important" (highlight) is disambiguable. Confirm
  briefly ("Noted. Keep going?"), save-first-confirm-async, don't read the note back.

**(C) End-of-session synthesis → structured thinking notes.** Collate the ordered interrupts (notes,
Q&A, citations) + their anchored source excerpts → Gemini → Markdown with sections **Themes / Open
Questions / Answers Captured / Disagreements & Tensions / Follow-ups to Research**. Anti-hallucination
is structural: **only-provided-material, forbid outside knowledge, every bullet MUST end with a
`[[para:id]]` / `[[note:n]]` backlink, "None recorded" escape hatch**, + a free programmatic check
that every bullet has a resolvable backlink. Readwise-Ghostreader pattern (tap a bullet → jump to the
source paragraph via the `para_id → offset` map). **Output a `{session_id}_synthesis.md` into the
same `transcripts/` folder the launchd watcher already writes to** — reuses the existing Gemini client
+ file-writer; it's "one more Gemini call + one file write" at session end.

**OPEN:** exact 2026 Gemini SDK field names (Interactions API vs classic — pin the SDK); confirm
`google_search` grounding is enabled on our direct key + its per-query price; realistic max doc size
(flips the no-vector-index call if users paste books).

## Consolidated risk register (prioritized — what will actually kill or hurt this)

| # | Risk | Severity | Mitigation / where |
|---|---|---|---|
| 1 | **Eagle speaker-verify accuracy in real gym noise is UNPUBLISHED** | 🔴 product-defining | The §1 go/no-go field test measures it directly. Everything rides on this. |
| 2 | **Bare-pocket self-echo** (mic hears own TTS → VAD self-triggers) | 🔴 | **Require a headset**; bare-pocket unsupported/degraded (§1). |
| 3 | **AirPods Voice-Isolation may not reach 3rd-party capture** | 🟠 | Device test; if not, AirPods ≈ EarPods (still viable) (§1). |
| 4 | **AirPods HFP downgrade** — live mic → call-grade TTS | 🟠 | iOS26+H2 `bluetoothHighQualityRecording`; else accept, or prefer wired/EarPods (§5). |
| 5 | **iOS 3-way audio-session fight** (the thing we bled on) | 🟠 | Single LiveKit engine, NO CallKit, `.playAndRecord` held constant, both auto-flags off (§5). |
| 6 | **Real phone call strands the locked session** (G1) | 🟠 | Price of no-CallKit; detect failed reactivate, recover on foreground (§5). |
| 7 | **Byte-vs-char offset → notes anchor to wrong ¶** on non-ASCII | 🟠 | Index paragraphs in UTF-8 bytes; +700ms reaction-lag correction (§6). |
| 8 | **Gemini over-searches** (3–5s mid-workout) | 🟡 | AUTO grounding + "prefer the doc" prompt + monitor `queries`; filler audio (§6). |
| 9 | **Synthesis hallucinates beyond sources** | 🟡 | Only-provided-material + mandatory `[[para:id]]` backlinks + programmatic check (§6). |
| 10 | **Multi-hour locked soak** (battery/thermals/engine survival) | 🟡 | Unverified combo — soak-test before committing (§5). |
| 11 | **RN bridge gaps** (Eagle has no RN SDK; LiveKit mixer/local-recording) | 🟡 | Small native modules likely required (§1, §5). |
| 12 | **Interrupt latency** (gate + STT round-trip) | 🟡 | 2–3s pre-roll ring buffer + `preemptive_generation` (§1, §4). |

## Build sequence (de-risk in this order — cheapest kill first)

- **Phase 0 — GO/NO-GO ($0, no cloud):** the §1 gate field test on wired EarPods. **If false-opens/hr
  or missed-interrupts are high, the product concept is dead — stop here.** This is the single most
  important thing to do, and it costs nothing.
- **Phase 1 — the reader half (no cloud):** Simba streaming + speech-marks → `AVAudioEngine` player
  with exact playhead + the 4 nav commands + rewind-from-cache (§2), driven by the client state
  machine (§4). Proves "read + navigate" end to end. One live Simba streaming call first to confirm
  the SSE shape (§2 open item).
- **Phase 2 — the interrupt loop:** wire the gate (§1) → single-engine audio transition (§5) →
  LiveKit CONVERSE turn → intent router (§3) → nav/research/note handlers → resume. This is where the
  audio-session architecture (§5) and the state machine (§4) get proven on-device.
- **Phase 3 — intelligence:** RAG/grounding + short spoken answers, note anchoring + categorization,
  end-session synthesis written into the existing `transcripts/` folder (§6).

**The whole bet rides on Phase 0.** Everything downstream is known-solvable engineering (mostly on
our existing stack); the gate in real gym noise is the one genuine unknown, and it's testable for free
today.

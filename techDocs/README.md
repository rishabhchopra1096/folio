# techDocs

Reference notes for things Folio talks to, written against **what Folio actually
does** rather than the vendor's happy path. Where a detail matters, the note
says how it was verified — and says so plainly when it was not.

**No API key belongs in any file here.** This repo is public, and `sk_…`,
`AIzaSy…` and `gsk_…` are exactly what secret scanners match. Keys live in
`localStorage`, entered through Settings.

## Read-aloud / TTS

| file | what it is |
|---|---|
| [`speechify-phase0-measured.md`](speechify-phase0-measured.md) | **Start here.** The live Simba 3.2 calls, measured 24 Aug 2026. Latency, the code-point offset finding, speed routes, buffering headroom. Supersedes doc-readings elsewhere. |
| [`IMPLEMENTATION-PLAN-read-aloud.md`](IMPLEMENTATION-PLAN-read-aloud.md) | The architecture plan. Still the reference for highlighting and chunking; its §3 batch endpoint and §5 UTF-16 assumption are **corrected** by the Phase 0 doc. |
| [`superwhisper-tts-postmortem.md`](superwhisper-tts-postmortem.md) | Forensics on the attempt that failed, with file:line. Six root causes, each producing a rule. |
| [`api-speechify-raw.md`](api-speechify-raw.md) | Raw Speechify API reference, incl. the verified CORS preflight. |
| [`api-azure-speech-raw.md`](api-azure-speech-raw.md) | Fallback provider reference. |
| [`speechify-simba-findings.md`](speechify-simba-findings.md) | Everything mined from the user's own rabbitwhole research. |
| [`tts-web-research-2026.md`](tts-web-research-2026.md) | Provider comparison, spec citations, chunking strategy. |
| [`tts-hosted-2026.md`](tts-hosted-2026.md) · [`tts-local-2026.md`](tts-local-2026.md) | Landscape surveys, hosted and local. |
| [`folio-integration-constraints.md`](folio-integration-constraints.md) | Folio-specific constraints. |
| `reference-*.md` | Copied verbatim from `rabbitwhole`; originals unmodified. |

Plan: [`.notes/simba-integration-plan.md`](../.notes/simba-integration-plan.md).

## Ask mode / chat

| file | what it covers | verdict |
|---|---|---|
| [`vercel-ai-sdk.md`](vercel-ai-sdk.md) | Vercel AI SDK, evaluated for the chat feature | **Not usable here.** React-only UI layer, ESM packages, assumes a bundler. |
| [`gemini-chat-rest.md`](gemini-chat-rest.md) | Multi-turn chat against the endpoint Folio already uses | **Use this.** Same endpoint as transcription, ~40 lines. |

Plan: [`.notes/ask-mode-plan.md`](../.notes/ask-mode-plan.md).

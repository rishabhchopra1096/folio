# techDocs

Reference notes for things Folio talks to, written against **what Folio actually
does**, not against the vendor's happy path. Each file records what was checked
and when, so a later reader can tell fact from assumption.

These are my notes, not copies of the vendors' documentation — the vendor docs
change, and a verbatim copy would rot silently. Where a detail matters, the note
says how it was verified.

| file | what it covers | verdict |
|---|---|---|
| [vercel-ai-sdk.md](vercel-ai-sdk.md) | Vercel AI SDK — evaluated for the ask-mode chat feature | **Not usable here.** React-only UI layer, ESM packages, assumes a bundler. |
| [gemini-chat-rest.md](gemini-chat-rest.md) | Multi-turn chat against the endpoint Folio already uses | **Use this.** Same endpoint as transcription, ~40 lines. |

Checked 21 August 2026.

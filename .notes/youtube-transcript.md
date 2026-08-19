# YouTube video + timestamped transcript — working doc

Branch `youtube-transcript`, from `main` (429d9f3).

## Goal
Paste a YouTube URL → the video embeds, a timestamped transcript appears below
it, and while watching you press Option to dictate a comment that attaches to
**the segment currently being spoken**.

## Verified before starting

**Gemini CORS is open.** Preflight from the production origin:
```
access-control-allow-origin: https://folio-six-sigma.vercel.app
access-control-allow-headers: content-type,x-goog-api-key
```
So the browser calls it directly — no proxy, same shape as the Groq key.

**Gemini transcribes a YouTube URL directly, with timestamps.** Live call
against `gemini-3.7-flash` with a `file_data.file_uri` part returned:
```json
[{"start": 0.0, "text": "Dude."},
 {"start": 1.0, "text": "All right, so here we are, in front of the elephants."},
 {"start": 4.5, "text": "And the cool thing about these guys is ..."}]
```
Seconds, split at natural sentence boundaries — exactly the granularity needed
to answer "which paragraph was just spoken".

## The key insight

This is the read-aloud architecture with a different clock.

| Read-aloud | YouTube |
|---|---|
| speech engine reports `charIndex` | player reports `currentTime` |
| highlight word + sentence | highlight transcript segment |
| Option → pause, highlight, dictate, resume | identical |

So highlighting, dictation, comment storage and the offline retry queue are all
reused rather than rebuilt.

## Data model

A video document is just a normal Folio document:

- one `video` block — `{ provider: "youtube", videoId, url, title }`
- N `paragraph` blocks, each carrying `data.t` = segment start in seconds

Keeping the transcript as ordinary paragraph blocks means highlights, comments,
export, search and even read-aloud all work on it **for free**. Editor.js block
`data` is free-form, so the extra `t` field rides along and persists through the
existing store with no schema change.

Sync is then: find the last block whose `t` <= `player.getCurrentTime()`.

## Constraints

- **API key never touches the repo.** Folio's GitHub is public and Google keys
  (`AIzaSy…`) are auto-detected by secret scanning. Stored in localStorage
  under `folio_gemini_key`, same pattern as `folio_groq_key`.
- **IFrame Player API is required**, not a plain `<iframe>` embed — we need
  `getCurrentTime()`, `pauseVideo()` and `playVideo()`.
- Long videos cost time and tokens. Needs a progress state and an honest
  warning rather than a silent multi-minute hang.

## Phases
- [ ] 1. Paste a URL → doc with embed + transcript fetched from Gemini
- [ ] 2. Live segment highlighting as the video plays
- [ ] 3. Option → pause, attach comment to the current segment, resume

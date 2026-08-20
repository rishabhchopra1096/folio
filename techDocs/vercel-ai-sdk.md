# Vercel AI SDK — evaluated for Folio's ask mode

Researched 21 August 2026 because the ask-mode feature was specified as "using
the Vercel chat SDK". **The honest answer is that it does not fit this codebase,
and adopting it would cost more than the feature is worth.** This note records
why, so the question doesn't get re-opened from memory.

## TL;DR

- The SDK has two halves: **AI SDK Core** (talk to models) and **AI SDK UI**
  (chat hooks). The chat behaviour everyone means when they say "Vercel chat
  SDK" lives in the UI half.
- **AI SDK UI is React-only.** The hook is imported from `@ai-sdk/react` and
  every documented example begins with `'use client'`.
- **Every documented path assumes a build system.** There is no script-tag
  build. The packages are ESM on npm.
- **Folio has no build system and no React.** Verified: `package.json` has zero
  runtime dependencies, `index.html` loads 23 plain `<script src>` tags, and
  there are no `type="module"` tags and no bundler config at all.
- Adopting it means adding npm + a bundler + React to a codebase whose stated
  design rule is "no build step" — to replace **one `fetch` call** that Folio
  has already proven works from the browser.
- **Recommendation: don't.** Use the REST endpoint Folio already ships against.
  See [gemini-chat-rest.md](gemini-chat-rest.md).

## What the SDK actually is

Three surfaces, per the introduction page:

1. **AI SDK Core** — a unified API for generating text, structured objects and
   tool calls across providers.
2. **AI SDK UI** — chat/generative-UI hooks. Described as "framework-agnostic",
   which in practice means React, Vue, Svelte and Angular each get a package.
3. **AI SDK Harnesses** — a uniform API over agent harnesses.

Getting-started guides exist for Next.js, Svelte, Vue/Nuxt, Node.js, Expo and
TanStack Start. **A plain browser page is not among them, and no CDN or UMD
build is offered.**

## The three blockers, in order of severity

### 1. `useChat` is React

The chatbot documentation imports the hook from `@ai-sdk/react` and marks every
example `'use client'`. Folio has no React and no JSX. Adding React for a
sidebar chat panel is not a proportionate trade.

### 2. It needs a bundler

The packages are ESM npm modules. Folio's vendored libraries are all UMD builds
copied into `vendor/` precisely so that no bundler is needed:

```
vendor/editorjs.umd.min.js   vendor/marked.min.js   vendor/header.umd.min.js …
```

`CLAUDE.md` states the rule outright: *"There are no tests, no linter, no
TypeScript, no bundler. Edits to `js/*.js` or `css/*.css` show up on reload — no
build step."* Introducing a bundler for this feature would change how every
other file in the project is developed and deployed.

### 3. Its default architecture wants a server route

The documented shape is a client posting `UIMessage[]` to an API route, with the
server replying via `createUIMessageStreamResponse`. Folio has no backend — it
is static files on Vercel plus localStorage.

There is an escape hatch: `DirectChatTransport` lets the browser call the model
without an HTTP endpoint. But it still arrives through the ESM packages, so
blockers 1 and 2 remain. Notably, the docs describing it **say nothing about
client-side API-key exposure**, which is the one thing that route makes
unavoidable.

## What was verified, and how

| claim | how it was checked | result |
|---|---|---|
| Folio has no dependencies | `package.json` → `dependencies` | `[]` — only `electron` + `electron-builder` in dev |
| Folio has no ESM | `grep 'type="module"' index.html` | 0 matches, against 23 `<script src>` tags |
| Folio has no bundler | looked for webpack/vite/rollup/esbuild config | none |
| `useChat` is React | ai-sdk.dev chatbot docs | imported from `@ai-sdk/react`, all examples `'use client'` |
| No script-tag build | ai-sdk.dev introduction | framework guides only; no CDN/UMD build mentioned |

## The part worth stealing

The SDK is not useless here — its **ideas** are good even though its code can't
be loaded. Three are worth copying by hand into `js/chat.js`:

1. **A message array as the single source of truth**, with the transport
   rebuilding the request from it every turn. It makes retry, edit and delete
   trivial, and it maps cleanly onto localStorage.
2. **Separating transport from UI state.** Folio's version: `Chat.ask()` knows
   about Gemini, `renderChat()` knows about the DOM, and they share only the
   message array.
3. **A `status` per message** (`streaming` / `done` / `error`) rather than a
   single global "is loading" flag. A failed answer should be visible and
   retryable in place, not a toast that vanishes.

## If this is ever revisited

The reasons above are structural, not temporary — they'd only change if Folio
adopted a build step for other reasons. If that ever happens, revisit. Until
then the 40-line REST call is not a compromise; it is the smaller, more
appropriate tool.

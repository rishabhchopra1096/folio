# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Folio ships as **two apps from the same source tree**:

1. **Web app** — `index.html` at the repo root, deployed to Vercel (see `vercel.json`). SPA with hash routing.
2. **macOS Electron panel** — `index-electron.html` + `electron/` directory. A tray app that lives as an 8px strip at the right screen edge and expands to a 400px panel on Cmd+Shift+N. Hidden from the Dock.

Both load the same `js/` and `css/` files. The Electron build adds `electron/panel.css` (overrides) and the Notion sync module, which is a no-op in the web build (guarded by `window.folio.isElectron` in `js/notion-sync.js:42`).

## Commands

```bash
npm start               # Run the Electron panel locally (electron .)
npm run build           # Package the macOS DMG via electron-builder
vercel --prod           # Deploy the web version (vercel.json rewrites all routes to index.html)
```

There are no tests, no linter, no TypeScript, no bundler. Edits to `js/*.js` or `css/*.css` show up on reload — no build step.

**Note:** `npm run download-vendor` references `scripts/download-vendor.js`, which does not exist in the repo. The `vendor/` directory (Editor.js plugins + marked) is checked in.

## Architecture

### Module pattern

Every file in `js/` is a vanilla-JS IIFE that exports a single namespace on `window`. No ES modules, no imports — files are loaded as `<script>` tags in dependency order by the two HTML entry points. The namespaces are:

- `FolioStore` (`js/store.js`) — localStorage CRUD for documents, highlights, comments, settings
- `App` (`js/app.js`) — router, view switching, global shortcuts, module initialization
- `SidebarUI` (`js/sidebar.js`) — page tree, search, context menus, file import
- `Editor` (`js/editor.js`) — Editor.js wrapper with debounced auto-save
- `Reader` (`js/reader.js`) — read-mode rendering
- `Highlights`, `Comments`, `Settings` — self-explanatory
- `NotionSync` (`js/notion-sync.js`) — two-way Notion sync (Electron-only stub in web)

When wiring a new feature, follow the same pattern: IIFE + `return { publicFn, ... }` at the bottom. `App.init()` in `js/app.js:224` is the single entry point that initializes every module on `DOMContentLoaded`.

### Data model — all in localStorage

There is no backend. Keys under `folio_*`:

- `folio_documents` — array of doc metadata (`{id, title, icon, parentId, order, createdAt, updatedAt}`)
- `folio_doc_{id}` — Editor.js JSON blocks for each doc (this is the source of truth, **not** markdown)
- `folio_highlights_{id}`, `folio_comments_{id}` — per-doc
- `folio_settings` — theme, font size, sidebar state
- `folio_notion_token`, `folio_notion_pages` — Electron-only Notion sync state

Nested pages are modeled by `parentId` on the metadata record. `null` parent = top-level. `SidebarUI.renderPageTree()` recurses over this.

**Content format is Editor.js JSON, not markdown.** When importing `.md` files (drag-and-drop or "Add from Notion"), convert markdown → blocks via `SidebarUI.markdownToBlocks`. When pushing to Notion, convert blocks → markdown. Never store markdown as the canonical representation.

### Routing

Hash-based, parsed in `App.route()` at `js/app.js:46`:

- `#/` — welcome view
- `#/doc/{id}` — reader mode
- `#/doc/{id}/edit` — editor mode

The three view containers (`#view-welcome`, `#view-editor`, `#view-reader`) share the app shell; `showView()` just toggles an `.active` class. Editor.js must be torn down via `Editor.hide()` before rendering the reader, or you'll get leftover DOM/listeners.

### Electron specifics

`electron/main.js` is the main process. Key behaviors:

- **Single-instance lock** (`main.js:42`) — second launches focus the existing instance.
- **Always-on-top, frameless, transparent window** pinned to the right screen edge. Starts at `EDGE_TAB_WIDTH` (8px); `expandPanel()` / `collapsePanel()` animate between 8px and `PANEL_WIDTH` (400px) by calling `win.setBounds()` and sending `panel-expand` / `panel-collapse` IPC events to the renderer for the CSS transition.
- **Close is intercepted** — the window never actually closes; it collapses. Quit via the tray menu sets `app.isQuitting = true` first.
- **Notion calls are proxied** through IPC (`notion:search`, `notion:fetch-page`, `notion:push-page`, `notion:get-meta` in `main.js:262`) because the renderer can't call `api.notion.com` directly (CORS). The renderer talks to `window.folio.*` from `electron/preload.js`, which forwards via `ipcRenderer.invoke`. When adding Notion functionality, add both the `ipcMain.handle` in main **and** the `contextBridge` export in preload.
- **Tray icon** uses `tray-iconTemplate.png` (macOS template image — auto-adapts to menu bar appearance).

### Notion sync flow

`js/notion-sync.js` (Electron-only) keeps a registry of `{notionPageId, folioDocId, lastSyncedAt, lastNotionEditedAt}` in `folio_notion_pages`. On panel show and every 2 minutes it compares `last_edited_time` from Notion against `lastNotionEditedAt`; if Notion is newer, it pulls markdown and replaces blocks. On local save it debounces a push. Conflict policy: **last-write-wins with Notion as source of truth.**

## Writing code in this repo

- Keep the narrative teaching-style comments that exist throughout — this codebase uses the full-file-header + section-banner convention already. New files should follow it.
- Add new Electron IPC in both `electron/main.js` (handler) and `electron/preload.js` (bridge) — they must stay in sync.
- When editing a JS module, remember both HTML entry points load it. Check `index.html` **and** `index-electron.html` when changing the DOM contract (element IDs, order of `<script>` tags).
- localStorage is the only persistence. Don't introduce IndexedDB or a service worker without discussing — the whole app assumes synchronous reads from `FolioStore`.

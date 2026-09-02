# A global reader for macOS, built on Folio's engine

Started 2 September 2026. Research and plan; nothing built.

**The goal:** select text anywhere on the Mac, press a shortcut, and have it
read aloud with the same speech quality and the same cost discipline Folio now
has — no runaway Speechify bill.

## Part 1 — what Folio actually has (established, not delegated)

### The single most important fact

**`js/speechify.js` contains no DOM references at all.** 1,490 lines, and the
only outside things it touches are:

| API | uses | what for |
|---|---|---|
| `localStorage` | 18 | key, voice, log, running totals, timing memory |
| `indexedDB` | 2 | the audio store |
| `navigator.storage` | 5 | asking for durable storage |
| `new Audio` | 1 | playback |
| `fetch` | 4 | synthesis |
| `AbortController` | 3 | queue-level cancellation |
| `requestAnimationFrame` | 2 | the word-timing loop |

Every one of those exists in an Electron renderer. **The engine ports across
unchanged** — not adapted, not rewritten. That is the whole reason this is worth
doing rather than starting again.

### What the engine gives you

Its entire public surface is one call:

```js
speak(text, opts) -> { stop(), setRate(r) }
//   opts: { rate, voice, startOffset, next,
//           onWord(charIndex, charLength), onEnd(), onError(msg, err), onStatus(info) }
```

`text` is a plain string. `onWord` reports **character offsets into that
string**. It has no opinion about where the text came from or what is displayed.
A clipboard selection satisfies it exactly as well as a rendered document.

### The cost machinery, all of which comes along

This is the part that took a week of measurement, and none of it is
Folio-specific:

| Behaviour | Why it exists |
|---|---|
| One request at a time, queued | The plan allows exactly 1 concurrent request — measured, the API says so in the 429 body |
| Retry with the server's `Retry-After` | 429s and 5xx clear on their own |
| **Never abort an in-flight request** | Measured: aborting does not stop the server generating, so an abandoned request is billed in full and yields nothing |
| Drop *queued* jobs whose caller left | Those have not been sent, so this genuinely saves the charge |
| Audio + timings cached as one unit | The model samples; the same request twice returns different audio *and* different timings |
| IndexedDB store, 250MB, LRU | A passage is paid for once and replays free after a reload — proven end to end |
| `navigator.storage.persist()` | Otherwise Safari clears it after ~7 days and Chrome evicts under pressure |
| In-flight counts as "already have it" | Closes the pause-and-resume window that bought the same chunk twice |
| Head/tail split, head size **solved** not guessed | `H ≥ (0.80 + 0.00705·C) / (0.051/rate + 0.00705)` — the head must out-speak its own tail's download |
| Lookahead queued *after* the current chunk | Otherwise it jumps the queue and you wait ~7s longer for the first sound |
| Persistent log + `costReport()` | Characters billed, characters saved, and **paid-for-but-never-heard** |

Real measured outcome on a 73-minute session: **21,789 characters billed for
21,789 characters of distinct audio — exactly 1.00×**, with 145,857 characters
served free from cache. 87% of the reading cost nothing.

### What does NOT port, and why

| Folio piece | Where it lives | Why it cannot come |
|---|---|---|
| Document index (`buildIndex`) | `js/tts.js:176` | Maps character offsets to live DOM nodes. There is no DOM for text selected in Notes.app. |
| CSS Custom Highlight painting | `js/tts.js` + `css/highlights.css` | You cannot paint inside another application's window. |
| Comment anchoring, highlights | `js/comments.js`, `js/highlights.js` | Bound to Folio's storage and its documents. |
| Chunking (`groupIntoChunks`) | `js/tts.js:~300` | **Partly portable.** Its content-defined boundaries are worth keeping; its sentence input comes from the DOM index and would need a plain-text equivalent. |

### The architectural consequence

The post-mortem in `techDocs/superwhisper-tts-postmortem.md` is blunt about the
capture path: it "yields *text only* — no screen coordinates, no character
offsets. In-place highlighting is therefore structurally impossible."

That is not a limitation to work around. It is a design decision made for us:

> **Show the captured text in our own window and highlight it there.**

Which also means the one genuinely hard problem Folio solved — mapping character
offsets back onto live DOM nodes — becomes *easy*, because we render the text
ourselves and therefore control the DOM it lives in.

### The rule the post-mortem exists to enforce

> "The single most expensive mistake in the whole history was **separating the
> audio clock from the highlighter across a process boundary.**"

So: the `<audio>` element and the thing drawing the highlight must live in the
**same renderer**. Folio already does this — the rAF loop reads
`audio.currentTime` directly. Any design that puts synthesis in the main process
and highlighting in a renderer repeats the mistake that killed the last attempt.

---

## Part 2 — superwhisper-clone as it stands today

The app is called **Converse** — a menu-bar dictation tool with three separate
read-aloud attempts bolted on. Mapped file-by-file; the findings that matter:

### The good news: the shell already exists

| Piece | Where | State |
|---|---|---|
| Tray / menu-bar app | `src/menuBar.js:25` | Works |
| Floating always-on-top windows | `src/main.js:420-428` | Works, and encodes real macOS knowledge (`"floating"` vs `"screen-saver"`, `showInactive()` to avoid stealing focus) |
| **Selection capture from any app** | `src/menuBar.js:448-474` | Works — AppleScript fakes ⌘C, reads the pasteboard, restores it |
| A reading pane with karaoke highlighting | `src/stage/` | Works, but see below |
| `highlighter.js` | `read-aloud/highlighter.js` | **The best code in the repo.** Zero dependencies, no DOM mutation, deliberately provider-agnostic. Four byte-identical copies exist. |

**None of that has to be rebuilt.** It is exactly the shell Folio's engine needs.

### The bad news, in order of severity

1. **The global read-aloud hotkey is disabled at source.**
   `src/main.js:2737` — `if (false && shortcuts?.speakSelection)`. It was turned
   off deliberately when ⌥S was handed to a Chrome extension. The only surviving
   trigger is a tray menu item whose accelerator is decorative (tray accelerators
   are labels, not registrations).
2. **`src/stage/` is untracked.** `git ls-files src/stage` returns nothing. The
   most recent real work in the project is in **no commit at all**, one
   `rm -rf` from gone.
3. **The Stage cannot be packaged as-is.** `stage.js:55-67` overrides the voice
   and dictionary URLs but not `transformersModule`, so it inherits a jsdelivr
   CDN default and a HuggingFace model download. The Chrome extension already
   solved this by bundling; the Stage did not.
4. **Signed builds will fail at the AppleScript.** `entitlements.mac.plist` has
   four keys, none of them `com.apple.security.automation.apple-events`, and
   there is no `NSAppleEventsUsageDescription`. Both the selection capture and
   the dictation paste depend on exactly that.
5. **Every failure message is invisible.** `showNotification` is defined twice in
   `src/menuBar.js` (`:400` real, `:537` a console stub) and the stub wins. "No
   text selected" and the Accessibility prompt reach the terminal only.
6. **`.env` with four live API keys is bundled into the DMG** —
   `package.json:39-43` lists it in `files`.
7. **`nodeIntegration: true, contextIsolation: false` on every window**,
   including the Stage, which loads remote code from a CDN. Remote script with
   full Node privileges.

### Three TTS lineages, and what to do with each

| Lineage | What | Verdict |
|---|---|---|
| **A** — UnrealSpeech + Web Speech, `src/services/` (~2,200 lines) | Cloud synthesis, plus Node-side playback via `speaker`/`wav`/`fluent-ffmpeg` | **Delete.** It mixes synthesis and playback on a PCM pipe with no `currentTime`, no `playbackRate`, no seek — the root of every broken transport control. It also drags native modules into every rebuild, and its only user-facing entry point is already disconnected. |
| **B** — `tts-reader/` | Web Speech prototype | Dead. No inbound references. |
| **C** — Kokoro/HeadTTS in three forks (`reader-extension/`, `read-aloud/`, `src/stage/`) | Local ML synthesis | **Keep the shells, replace the engine.** The streaming design in `stage.js` (`BUFFER_AHEAD`, sentence-first) is genuinely good and is the same idea as Folio's head/tail split. |

### What this means

Converse has the half Folio lacks (global capture, tray, floating windows) and
lacks the half Folio has (a working, cheap, high-quality engine). The
`src/stage/` window is already the "render it in a space we own" answer that
Part 1 concluded was necessary.

**So this is a transplant, not a build:** put `js/speechify.js` into the Stage,
delete Lineage A, and re-enable the hotkey.

## Part 3 — capturing a selection anywhere on macOS

Researched from primary sources: Electron and Chromium source, Apple docs,
package registries, issue trackers.

### The finding that decides the approach

**Nobody ships pure Accessibility. Nobody ships pure clipboard. Every shipping
app converged independently on AX-first-with-clipboard-fallback.** Neither
alone clears roughly 70% of Mac apps.

And there is a specific reason pure-AX cannot work for a hotkey. Chromium-based
apps *and every Electron app* — Chrome, Slack, VS Code, Discord, Notion — do not
build an accessibility tree until an assistive client asks for it, and the ask
is debounced. From Electron's own `shell/browser/mac/electron_application.mm`:

```objc
// we'll delay that action until there are no more state
// change requests within a two-second window.
const float kTwoSecondDelay = 2.0;
```

Chrome carries byte-identical code. **So the first press against Chrome or Slack
fails, and keeps failing for two seconds.** The clipboard fallback is what
carries that first hit.

### The three approaches, compared

| | Permission | Reaches | Breaks on |
|---|---|---|---|
| **Synthetic ⌘C** → pasteboard → restore | Accessibility only (via `CGEventPost`; the AppleScript variant *also* needs Automation — two prompts) | Anything with a Copy command, incl. Terminal and Preview PDFs | Password fields (Secure Input blocks event taps system-wide), non-standard ⌘C bindings, apps with no Copy handler (system beep), promised clipboard data lost forever, ~100ms latency, and **any early return destroys the user's clipboard** |
| **Accessibility API** (`kAXSelectedText`) | Accessibility, and it **cannot be granted programmatically** — the user must toggle it and usually restart | Native Cocoa reliably | Chrome/Electron/VS Code for the first 2s; JetBrains (Java); vim, emacs, Alacritty; Unity3D/Citrix/Parallels; password fields. An out-of-range `kAXSelectedTextRange` **aborts your process** unless clamped |
| **Services menu** (`NSServices`) | **None at all** | — | **Unreachable from Electron.** Verified: electron#36439 and #25652 both closed unanswered; Electron never calls `setServicesProvider:`. Also needs `/Applications` + a logout, and is greyed out in exactly the apps where the other two fail |

### The recommendation: `selection-hook`

`selection-hook` (`0xfullex`), **v2.1.1 shipped 2026-08-31**, MIT. It is the only
actively maintained option, and it already implements every hard part:

- the AX ladder — focused element → `kAXSelectedText` → children → **walk up
  `kAXParent` 10 levels** (browsers report a multi-node selection only on an
  ancestor `AXWebArea`) → `kAXValue` sliced by range, **clamped** so
  `CFStringCreateWithSubstring` cannot abort the process
- the `AXManualAccessibility` poke that turns Chromium's tree on
- `changeCount`-based race detection — never string comparison, because copying
  the same text twice is invisible to a diff
- all-format clipboard backup and restore, via
  `prepareForNewContentsWithOptions:` so Universal Clipboard does not fire
- **N-API prebuilds for darwin x64 and arm64**, so `electron-rebuild` never
  enters the build

Alternatives are worse: `node-get-selected-text` is 2.3 years stale and has a
weaker AX path; `robotjs` is key synthesis only and NAN-based; `@nut-tree/nut-js`
is unpublished.

### Four things that must be right

1. **Read the selection BEFORE showing the window.** Focusing our own window
   makes us frontmost — the AX read then targets *us*, and the clipboard
   fallback refuses same-process outright ("the JS thread that must handle the
   key event is the one blocked here"). Capture first, then show, and prefer
   `showInactive()`.
2. **`getCurrentSelection()` is synchronous and can block ~100ms+**, stalling the
   main process. Either accept the hitch or move it to a utility process.
3. **Cache which method worked, per app.** OpenAI Translator keeps a 100-entry
   LRU keyed by app name; it avoids paying the failed-AX cost on every press.
4. **Surface failures.** PopClip's published non-working list — vim, emacs,
   JetBrains, Alacritty, Unity3D, Citrix, Parallels — is the honest expectation.
   "Nothing happened" is the worst possible response.

### Global hotkeys need no permission

Verified in `electron_api_global_shortcut.cc:40`: the only accessibility check is
for **media keys**. Underneath it is Carbon `RegisterEventHotKey()`, which
requires no TCC grant. If another app already owns the combination,
`register()` returns **false** — a real, usable signal that must be surfaced
rather than swallowed. There is no API to learn *which* app took it.

---

## Part 4 — the plan

### Where this should live: Folio's own Electron app, not Converse

This is the decision that matters, and the evidence points one way.

**Folio's Electron panel already is a menu-bar app with the engine in it:**

| Already there | Where |
|---|---|
| Tray icon + context menu | `electron/main.js:14` |
| `globalShortcut` registration | `electron/main.js:23` |
| Always-on-top panel, expands from the screen edge | `electron/main.js:61-167` |
| **`js/speechify.js` and `js/tts.js` loaded** | `index-electron.html:415-416` |
| Settings for key, voice, cost log, audio cache | `index-electron.html:219-231` |
| Runtime npm dependencies | **zero** |

**What Converse would make us inherit first**, before writing a line of the
feature: an untracked `src/stage/`, `.env` with four live keys bundled into the
DMG, `nodeIntegration: true` on a window that loads remote CDN code, ~2,200
lines of dead UnrealSpeech with native `speaker`/`ffmpeg` deps, notifications
that reach only the terminal, missing Apple Events entitlements, and docs that
are thirteen months stale.

Converse contributes exactly one thing we need — selection capture — and
`selection-hook` does that better than its AppleScript, in about twenty lines.

**So: build it in Folio's Electron app. Take the ideas from Converse, not the
code.** Specifically worth stealing: the floating-window recipe
(`showInactive()` + `"floating"` level, `src/main.js:420-428`), and
`read-aloud/highlighter.js` — provider-agnostic, no DOM mutation, the best code
in that repo.

### What has to be built

**1. Capture (main process).** `selection-hook`, a new global shortcut, read
before showing. Falls back to the clipboard, caches the winning method per app,
and says so out loud when a source app is one of the known-unsupported ones.

**2. A reading view (renderer).** A new view in `index-electron.html` that takes
a plain string, renders it as paragraphs, and highlights as it reads. This is
where Part 1's conclusion lands: we render it, so we own the DOM, so the
offset→node mapping is trivial — no `buildIndex` needed.

**3. A plain-text chunker.** Folio's `groupIntoChunks` takes sentences from the
DOM index. The same content-defined boundary logic — FNV-1a hash, 1-in-4,
600/1800 min/max — needs a version that segments a plain string with
`Intl.Segmenter`. Perhaps 40 lines, and it should be shared with `js/tts.js`
rather than copied.

**4. Nothing else.** `js/speechify.js` is used as-is. The cost log, the cache,
the queue, the rate handling all come along unchanged, which is the entire point.

### Permissions and packaging

- Accessibility, for `selection-hook`. Cannot be granted programmatically —
  detect, explain, and deep-link to the Settings pane.
- If the AppleScript fallback is ever used, add
  `com.apple.security.automation.apple-events` and
  `NSAppleEventsUsageDescription`, or a signed build fails at that call.
- `globalShortcut` itself needs nothing.

### Edge cases that need a defined behaviour

| Case | Behaviour |
|---|---|
| Nothing selected | Say so visibly. Do not silently do nothing. |
| Selection in a password field | Secure Input blocks capture entirely — say why. |
| Source app is JetBrains / vim / Alacritty | Known-unsupported; name the app and suggest copying manually. |
| First press against Chrome or Slack | AX will miss for 2s; the clipboard fallback carries it. |
| Enormous selection (a whole book) | Cap it, or warn with the character count and the cost before synthesising. |
| Selection is code, or a URL list | Reading punctuation aloud is noise — consider detecting and warning. |
| Hotkey already taken | `register()` returns false. Surface it. |
| Same text selected again later | Free — the disk cache is keyed on text + voice + model. |
| Folio panel already open and reading | Decide: replace, queue, or refuse. |
| No Speechify key configured | Fall back to the system voice, as the web app already does. |

### Build order

1. **Capture alone.** Wire `selection-hook` to a hotkey and log what it returns
   across ten apps — Chrome, Slack, Notes, Terminal, Preview, VS Code, Mail,
   Safari, Notion, Pages. **Report the compatibility table before building any
   UI.** This is the part most likely to disappoint, so it gets tested first.
2. **Reading view.** Render captured text, read it with the existing engine,
   highlight from `audio.currentTime` in the same renderer.
3. **The chunker**, shared with `js/tts.js`.
4. **Polish:** per-app method cache, failure messages, cost readout, the
   already-reading case.


---

## Step 1 result — capture works, and it is proven not assumed

`selection-hook@2.1.1` installed with a **prebuilt `darwin-arm64` binary**: no
compilation, no `electron-rebuild`. It is Folio's first runtime dependency; the
web build is unaffected because Vercel serves static files and never sees
`node_modules`.

First real capture, from a live app:

```
app                   method      chars  coords  preview
com.google.Chrome     CLIPBOARD    1044  yes    "Wait, I just skimmed throu"
```

Three things that confirms:

1. **Capture works end to end** — 1,044 characters out of Chrome.
2. **The research was right about Chromium.** It came back via `CLIPBOARD`, not
   `AXAPI`, exactly as predicted by the two-second accessibility-tree debounce
   in Electron's and Chrome's own source. Had we shipped pure-AX, this would
   have returned nothing.
3. **Coordinates come back too** — which contradicts the post-mortem's premise
   that the capture path "yields text only — no screen coordinates". It gives no
   per-word offsets, so in-place karaoke is still impossible and the
   render-it-ourselves decision stands. But the reading window can open **beside
   the selection** instead of at a fixed screen edge.

`npm run capture-test [seconds]` runs the harness. It samples the current
selection, records one row per app+method pair, and prints a compatibility
summary. It synthesises nothing and bills nothing.

### The failure design, settled

AX first, then synthetic ⌘C, and only if both fail does it say so — naming the
app. `selection-hook` does the first two internally; `enableClipboard: true`
turns the fallback on.

Worth correcting an earlier framing in this document: PopClip's non-working list
is about **automatic** detection via I-beam cursor tracking, not about explicit
triggers. PopClip's own guidance for JetBrains is that it "can be made to appear
by using the keyboard shortcut". With a hotkey plus clipboard fallback, most of
that list should work. The genuinely unreachable cases are narrower:

- **password fields** — Secure Input blocks synthetic events system-wide, by
  design, and reading a password aloud is not a feature anyway
- **apps with no Copy command** — the synthetic ⌘C produces a system beep
- **VMs (Parallels, Citrix, VMWare)** — the copy goes to the guest OS

Which apps really fall into those is an empirical question, and that is what
`npm run capture-test` is for.


---

## Step 1, run automatically — the real compatibility picture

Driven by `tools/capture-matrix.js`, which opens its own scratch files, sends
⌘A, and asks what was captured. **It verifies the CONTENT, not just that
something came back** — the first run reported three false positives, all
carrying the same 1,044 characters from an earlier test, because the clipboard
fallback happily returns stale pasteboard data. Comparing lengths would have
shipped a wrong conclusion.

| app | result | method | note |
|---|---|---|---|
| TextEdit | **captured**, 169 ch | AXAPI | native Cocoa |
| Google Chrome | **captured**, 169 ch | AXAPI | Chromium |
| Cursor | **captured**, 169 ch | AXAPI | **Electron** |
| Visual Studio Code | **captured**, 169 ch | AXAPI | **Electron** |
| Sublime Text | nothing | — | custom-drawn text |
| Safari | nothing | — | test artefact, see below |
| Preview | skipped | — | PDF generation failed locally |

All four successes reported **screen coordinates**.

### Three findings that change the design

**1. The two-second debounce is real but it warms up.** Chrome, Cursor and VS
Code all answered through the **accessibility API**, not the clipboard — because
this test waits 3.5 s before asking. An earlier ad-hoc test of Chrome, asking
immediately, came back through the clipboard instead. So: **the first press
against a Chromium or Electron app will miss AX; later ones will not.** The
fallback carries the cold case, and the design must not assume either one.

**2. `selection-hook`'s clipboard fallback does NOT fire on
`getCurrentSelection()` in passive mode.** Diagnosed directly against Sublime
Text:

```
Sublime Text:
  selection:              null
  clipboard now:          ""                          <- fallback never copied
  after explicit Cmd+C:   "The quick brown fox ..."   <- but the text IS reachable
```

The text is right there; the library simply does not reach for it on the
on-demand path. **So we implement that step ourselves** — if
`getCurrentSelection()` returns null, send our own ⌘C and read the pasteboard.
That is exactly the fallback described earlier in this document, and it now has
a measured reason to exist rather than a theoretical one.

**3. Safari was a test artefact, not an incompatibility.** It returned 86
characters — `file:///private/var/folders/...`, the URL. ⌘A had gone to the
address bar, because focus lands in the toolbar when a window opens. Safari is
**unverified**, not broken; testing it properly needs a click into the page
first.

### What this means for the build

The capture layer is now specified by measurement rather than by hope:

```
1. hook.getCurrentSelection()      — AX. Works in native Cocoa, and in
                                     Chromium/Electron once warm.
2. if null → synthetic ⌘C          — our own, because the library will not do
                                     it here. Reaches Sublime and anything else
                                     with a Copy command.
3. if still nothing → say so       — naming the app, per the agreed design.
```

Steps 1 and 2 together cover every app tested where the text is reachable at
all. Step 3 is honest about the rest.

# Drive mode — Folio for a phone in a car cradle

*Built 28 October 2026. Status: **BUILT, not DONE.** Everything below that says PASS was
proven in a real browser on this Mac. The things only an iPhone can answer are listed, by
name, in "What only your phone can tell us" — and until you have run those, the headline
claim of this feature (that it keeps playing with the screen locked) is a design intention
and not a fact.*

## TL;DR

- **A second, much smaller front end at `/drive`.** Five controls: play/pause, back 15s,
  forward 15s, slower, faster — and one enormous button in the middle that records a
  thought and files it against the paragraph that was being read when you pressed it.
- **Two views, one toggle.** *Focus* is the big button and nothing else. *Words* shows the
  sentence being read, large, with the ones around it dimmed — the lyrics idea from Apple
  Music, and tapping a line jumps there. Both keep the same transport and the same
  one-button recording, so switching never changes what a control does.
- **The whole document is fetched and joined into ONE MP3 before it plays.** This is the
  central design decision and everything else follows from it. iOS will not let a
  backgrounded page start a *new* audio element, so the reader's chunk-by-chunk playback
  would go silent about thirty seconds after you lock the phone. One file has no chunk
  boundaries to cross, so there is nothing for iOS to refuse.
- **MP3 concatenation really does work** — three separate blobs joined end to end play as
  one 2.97-second file and seek correctly. Measured in Chrome, not assumed.
- **Already-paid-for audio is reused.** The drive cuts a document into exactly the same
  pieces the reader does, proven two ways: in jsdom against `js/tts.js`'s own code, and in
  the browser against the reader's live chunk offsets for the same document.
- **Nothing you say is ever lost.** A recording is written to IndexedDB *before* anything
  is attempted with it, so a failed upload, a dead zone, or a reloaded page all leave the
  audio intact. It sends itself when the signal comes back.
- **Nothing has to come off the laptop.** **Paste a page** takes whatever is on the
  clipboard and makes it a page you can listen to in a few seconds. **Open a file** takes
  a markdown file — or a Folio backup, recognised by what is in it rather than by what it
  is called, because a backup AirDropped off a Mac arrives named whatever it arrives
  named. **Voice keys** is where the two keys go in, since nothing is read aloud without
  the first one.
- **A pasted page reads exactly like one that came over in a backup**, because both go
  through the same converter — `js/markdown.js`, which used to live inside the desktop
  sidebar and was moved out rather than copied. Where that code puts a block boundary is
  where the voice pauses and where a dictated note can attach itself, so two copies of it
  would have drifted into two different readings of the same file.
- **98 browser assertions, 1,023 jsdom assertions, 0 failing.** Eleven mutation proofs —
  one of which failed nothing, which is how the missing assertion below was found.
- **Eight real bugs were found by the tests and the screenshots and fixed**, listed below
  with what each would have cost you on the road.

## Document map

- **How to use it** — the three things to do before you drive.
- **The two views** — what each is for, and how following the words is possible at all.
- **Why one joined file** — the decision the whole design rests on, and the evidence.
- **What was built** — the files, and what each one is for.
- **User stories** — every story, its lane, and whether it passed.
- **Bugs the tests found** — eight, each with what it would have cost, plus one bug in a
  test and one assertion that was missing.
- **The designer pass** — the layout faults found by looking at screenshots rather than
  asserting about them.
- **What only your phone can tell us** — the honest gap, as a walkthrough.
- **Known limits** — things that are true and not going to change today.
- **What I did not do.**

## How to use it

**Three things, and the first two only ever have to be done once.**

1. **On the iPhone, in Safari** — not added to the home screen, see Known limits — open
   **https://folio-six-sigma.vercel.app/drive** and tap **Voice keys**. Paste the
   Speechify key (and the Groq one, if you want to dictate notes). Nothing is read aloud
   without the first.
2. **Get something to listen to**, whichever is nearer to hand:
   - **Paste a page** — copy anything, paste it in, tap *Add it*. It opens straight into
     the player.
   - **Open a file** — a markdown file from Files or iCloud.
   - **Open a file**, pointed at a backup — on the laptop, Folio → Settings → Backup →
     **Export all**, AirDrop it over. This is the only one that brings your whole library,
     your existing notes AND both keys in one go, so if the laptop is to hand it is still
     the best first move.
3. **Before you set off:** pick the page. Wait for the status line at the bottom to say
   **"Whole document ready — safe to lock the screen."** Then press play once, and lock
   the phone if you want to.

While driving: the big button in the middle records. Press it, say the thing, press it
again. Reading pauses while you talk and starts again by itself.

## The two views

**Focus is for driving. Words is for the moment you stop.**

*Focus* is the default: one enormous button, because the only thing you should be doing
with this screen at speed is pressing it without looking.

*Words* lays the document out one sentence per line and lights the one being spoken,
dimming the rest — the same idea as a music app's lyrics screen, for the same reason. At a
standstill, or as a passenger, it answers "where are we?" in a glance instead of a guess
from a progress bar. Tapping a line jumps there, which is the one thing focus cannot do:
"go back to where he started on pricing" becomes a look and a tap rather than hammering
the fifteen-second button and listening for it.

**Following along is possible because Speechify already tells us when each word is
spoken** and we were throwing it away. Every chunk comes back with marks — the time each
word starts, and where that word sits in the chunk's text — at no extra cost. Two binary
searches over those turn "412 seconds in" into "this sentence", and back again for the
tap. Where marks are missing the position is spread evenly across the chunk's measured
duration, which is accurate to a sentence or two rather than to a word.

**A sentence is the unit, not a word or a paragraph.** A paragraph is too big to tell you
anything at a glance; a word moves too fast to be worth looking at and would invite you to
watch it. A sentence changes every few seconds, which is about as often as it is safe to
look at anything.

**It does not fight your thumb.** Touch the list and it stops scrolling itself for six
seconds, so reading ahead is possible. Without that, looking ahead was impossible — it
snatched the list back every few seconds.

## Why one joined file

**The reader plays a document one chunk at a time, creating a new audio element for each.
On a locked iPhone that is fatal, and silently so.**

WebKit will not let a page that is backgrounded or behind the lock screen start a new
media load. The reader's design — perfectly good on a desktop — would therefore play for
about thirty seconds after you lock the phone and then stop, with no error and no way to
tell what happened until you unlocked it.

The way out is a property of the format: **an MP3 is a sequence of self-contained frames,
so joining the bytes of two MP3s produces one valid MP3 that plays straight through.**
Speechify returns MP3. So the drive player fetches every chunk, concatenates the blobs,
and hands the result to one audio element as one source. As far as iOS is concerned it is
a podcast episode, and a podcast episode plays with the screen locked.

That claim was tested rather than believed, in headless Chrome:

```
PASS decodeAudioData works  dur=0.993
PASS loadedmetadata dur=0.990375
PASS three joined chunks play as one file dur=2.971125
PASS seek inside the joined file t=1.71
```

Three one-second blobs became one 2.97-second file. The seek landed at 1.71 rather than
1.50 because MP3 seeking snaps to a frame boundary — irrelevant for fifteen-second skips,
worth knowing if anything ever needs sample accuracy.

**While a document is still being fetched** the player plays what it has and rebuilds the
file as more arrives. A rebuild is a new media load, i.e. the exact thing a locked phone
forbids, so it only happens while the screen is on — and the status line says, in those
words, whether it is safe to lock yet.

## What was built

| File | What it is for |
|---|---|
| `drive.html` | The page. Deliberately loads eight scripts, not fourteen. |
| `css/drive.css` | Dark-first, nothing interactive under 72px, record button 68vw. |
| `js/drive.js` | The player, the lock-screen wiring, voice notes, the outbox. |
| `js/chunker.js` | **New shared module.** Cuts a rendered document into chunks. |
| `js/markdown.js` | **Moved out of `js/sidebar.js`.** Markdown → Editor.js blocks, for every way a page gets in. |
| `js/speechify.js` | One addition: `fetchChunk()`, the cache-aware audio getter. |
| `vercel.json` | `/drive` serves `drive.html`. |
| `test/chunker-parity.selftest.js` | 21 assertions: the chunker matches `js/tts.js` exactly. |
| `test/browser/drive.probe.html` | 98 assertions against the real page in a real browser. |
| `test/browser/drive.shot.html` | Stages the screen so it can be looked at. |
| `tools/shoot.js` | **New.** CDP screenshots that wait for the page and can emulate dark mode. |
| `tools/mutate-drive.sh` | Breaks one thing, runs the probe, restores — and proves it restored. |

**`js/markdown.js` is the opposite decision to `js/chunker.js`, for a reason worth
writing down.** When the paste box needed a markdown converter there were three options:
load the whole 36KB sidebar on a phone for one function, write a smaller converter for
the drive screen, or move the converter somewhere both can reach. The converter had
exactly one test file depending on it, so moving it was cheap — and the second option was
the dangerous one, because where that code puts a block boundary is where the voice pauses
and where a dictated note anchors. Two converters would have meant a pasted page reading
differently from the same file dragged in on the laptop, which is not a difference anybody
would think to look for. The sidebar still exports `markdownToBlocks` and now forwards to
it, so the drag-and-drop path and its test did not have to change.

**`js/chunker.js` is a deliberate duplication, and the test is what makes that safe.**
Where a chunk begins and ends decides the cache key the audio is stored under, so a drive
that cut a document even one character differently would re-buy every chunk — the same
words, paid for twice. The algorithm therefore has to be identical to `js/tts.js`'s.
Refactoring 2,000 lines of player to share it, while a trip was waiting, was the riskier
move; reproducing it and pinning the two together with
`test/chunker-parity.selftest.js` was not. That test compares docText, block ranges,
sentence ranges and every chunk's text character for character, and also checks the three
tuning constants still agree. **If you change a rule in one file, change it in the other;
the test will tell you if you forget.**

## User stories

**Lane: `browser` was run and recorded here. `phone` can only be answered on your iPhone
and has NOT been answered.**

| # | Story | Lane | Result |
|---|---|---|---|
| D-1 | I pick a page and it is read to me | browser | PASS |
| D-2 | Play and pause from the screen | browser | PASS |
| D-3 | Back and forward fifteen seconds | browser | PASS |
| D-4 | Faster and slower, and it says which | browser | PASS |
| D-5 | I stop for petrol and come back to where I was | browser | PASS |
| D-31 | A toggle switches between the big button and the words | browser | PASS |
| D-32 | There is a line for every sentence, headings included | browser | PASS |
| D-33 | The lit line is the one being spoken | browser | PASS |
| D-34 | Tapping a line jumps to where it is spoken | browser | PASS |
| D-35 | Which view I chose is remembered | browser | PASS |
| D-36 | In the words view nothing overlaps anything else | browser | PASS |
| D-37 | Scrolling ahead is not snatched back | browser | **not run** |
| D-6 | The document plays through with no gap between chunks | browser | PASS |
| D-7 | Reaching the end says so rather than going quiet | browser | PASS |
| D-8 | The lock screen shows this read | phone | **not run** |
| D-9 | Play/pause from the lock screen | phone | **not run** |
| D-10 | Skip fifteen seconds from the lock screen | phone | **not run** |
| D-11 | It keeps playing when the screen locks | phone | **not run** |
| D-12 | It keeps playing when I switch to Maps | phone | **not run** |
| D-13 | One tap records, the next tap saves | browser | PASS |
| D-14 | Reading pauses while I talk and resumes after | browser | PASS |
| D-15 | The note is filed against the paragraph being read | browser | PASS |
| D-16 | The note has a highlight, so it reads like any other note | browser | PASS |
| D-17 | A note recorded with no signal is not lost | browser | PASS |
| D-18 | Held notes send themselves when signal returns | browser | PASS |
| D-19 | Held notes survive the page being reloaded | browser | PASS |
| D-20 | Audio I already heard in the reader is not bought again | browser | PASS |
| D-21 | A fetch failure keeps what is already buffered | browser | PASS (by construction) |
| D-22 | It tells me when it is safe to lock the screen | browser | PASS |
| D-23 | A phone that has never seen Folio can import a backup | browser | PASS |
| D-24 | The import brings the voice keys, not just the pages | browser | PASS |
| D-38 | I paste a page in and it is on the list, with no laptop involved | browser | PASS |
| D-39 | A pasted page keeps its headings, lists, quotes and bold | browser | PASS |
| D-40 | Its first heading becomes its name, so the list stays readable | browser | PASS |
| D-41 | A pasted page goes straight into the player | browser | PASS |
| D-42 | A markdown file opens into the paste box rather than being refused | browser | PASS |
| D-43 | A backup is recognised by what is in it, not by being called .json | browser | PASS |
| D-44 | I can type the two voice keys straight into the phone | browser | PASS |
| D-45 | Reopening the keys screen shows what is already saved | browser | PASS |
| D-46 | No field is small enough to make Safari zoom in and stay there | browser | PASS |
| D-47 | An empty list names every way forward, and each one is a real control | browser | PASS |
| D-25 | With no Speechify key it says exactly what is missing | browser | PASS |
| D-26 | With no Groq key the record button says so | browser | **not run** |
| D-27 | Recording works on iOS Safari at all | phone | **not run** |
| D-28 | Playback is not quieter or re-routed after a recording | phone | **not run** |
| D-29 | The screen stays awake while reading | phone | **not run** |
| D-30 | The layout is right around the notch and home bar | phone | **not run** |

**D-21 is marked "by construction" and not PASS**, because what is actually asserted is
that a fetch error stops the loop and leaves `ready` where it was; no test interrupts a
real fetch midway. **D-26 has no assertion** — the code path exists and is one line, but
one line is exactly what tends to be wrong, so it is listed as untested rather than
quietly counted.

**D-46 is a browser check standing in for a phone one.** It measures that every field is
at least 16px, which is the threshold at which Safari on iOS stops zooming the page in on
focus. Headless Chrome never zooms, so what is proven is the condition, not the absence of
the zoom — that one is still really a `phone` story.

## Bugs the tests found

**All four were in code I had just written and believed was correct.**

1. **The module is called `SpeechifyProvider`, not `Speechify`.** Every call in `drive.js`
   was to an undefined name. *Cost on the road:* the page would have thrown on opening any
   document. Found by the first probe run, in seconds.

2. **`getDocument()` returns `{ meta, content }`, not the metadata.** Reading `.title` off
   it gave `undefined`, so every page was called "Untitled". *Cost:* you would not have
   known which document you were listening to, and the lock screen would have said
   "Untitled" too.

3. **Finishing the fetch started playback.** The last rebuild passed "resume" as true, so
   the moment preparation completed the document began playing on its own — and the first
   tap on the play button then *paused* it. *Cost:* a button that does the opposite of
   what it says, which while driving is worse than one that does nothing.

4. **Importing a backup left the phone mute.** `importAll` in merge mode deliberately
   copies pages and not settings, so a new phone got 46 pages and neither the Speechify
   key nor the Groq key. *Cost:* the whole point of the feature, on exactly the device it
   was built for. `adoptCredentials()` now fills the gap, and only the gap — a key already
   on the phone always wins.

5. **The words view pushed every control off the screen.** It was given 80vh of vertical
   padding to centre the current line — and padding is part of a box and cannot shrink, so
   the list was 682px tall inside a 529px parent whatever flex said. The sentences lay
   across the transport and the record bar fell off the bottom. *Cost:* a view in which
   nothing can be pressed. **Every functional assertion still passed**, which is the whole
   argument for looking at a screenshot. The room now comes from spacer elements inside
   the scrolling list, which are content and have no hold over the box.

6. **`min-height: 100dvh` let the page grow instead of scrolling.** Same screenshot, same
   cause once removed: the screen is now exactly the viewport and the list inside it is
   what scrolls.

7. **An empty list told you about three buttons, directly above those three buttons.**
   Four sentences of explanation sitting over controls labelled "Paste a page", "Open a
   file" and "Voice keys". *Cost:* nothing breaks — it is just the screen you meet first,
   making you read a paragraph to learn what the buttons say. Cut to the one thing the
   buttons cannot tell you: nothing speaks until there is a Speechify key.

8. **Centred on the wrong axis.** Moving that message to the middle of the screen was
   written as `align-items: center` — but the list is a flex COLUMN, so that is the
   sideways axis, and on a full-width paragraph it did precisely nothing. The screenshot
   was identical to the one before it, which is the only reason it was noticed.
   `justify-content` is the one that centres a column.

**And one bug in the test itself, which is worth more than the others.** The import test
first called `FolioStore.importAll` directly and passed, while the real button was still
leaving the phone with no keys. It was testing the library, not the feature. It now drives
the actual file input, and bug 4 above is what that change exposed.

**And one assertion that was missing, found by a mutation that did not fail.** Changing the
file router to trust the filename instead of reading the contents broke nothing: 98 of 98
still passed. The whole reason it reads the contents is a backup AirDropped off a Mac
arriving called "Backup Oct 28" with no extension at all — and nothing covered that. A
test that imports a backup under exactly that name now does, and re-running the same
mutation fails it.

### The mutation proofs

| What was broken | What failed |
|---|---|
| Join only the first chunk instead of all of them | 6 assertions, including the joined-file duration |
| Stop writing the recording to IndexedDB before upload | 16 assertions, including every outbox one |
| Register `previoustrack`/`nexttrack` | the one assertion that forbids them |
| Stop carrying the voice keys on import | the one assertion that requires them |
| Put the 80vh padding back on the words list | the overlap guard |
| Bypass the shared markdown converter on the paste screen | 2 assertions: the block shape, and the bold |
| Make the file router trust the extension instead of the contents | the no-extension backup (added because the first run of this mutation failed nothing) |
| Never recognise a backup at all | 8 assertions across import and paste |
| Save the typed Speechify key under a name nothing reads | 2 assertions: the save, and reopening the screen |
| Drop every field below 16px | the Safari-zoom guard |
| Remove the `<strong>`→`<b>` mapping in `js/markdown.js` | 8 assertions, including the pasted page's bold |

`tools/mutate-drive.sh` exists because the first attempt at this left `js/drive.js`
mutated in the working tree: the restoring `cp` ran from the wrong directory and failed
silently. Restoring is now a trap that fires however the script exits, and it checks.

**One honest limit of the parity test:** raising `CHUNK_MIN_CHARS` from 600 to 700 did not
change the chunks on the fixture, so only the constants comparison caught it. A logic
change the fixture happens not to exercise could still slip through. The constants check
is there precisely because the tuning knobs are the likeliest thing to be nudged.

## The designer pass

**Six faults, none of which any assertion would ever have caught, all found by taking a
screenshot at 393×852 and looking at it.**

1. **The "awake" toggle was a native checkbox in the accent colour** — a minor setting
   rendered as the second-brightest thing on the screen, louder than the play button. Now
   a pill that recedes, with a small green dot.
2. **About 250px of dead space under the record button.** On a screen whose only job is to
   be hit without looking, unused space belongs to the target: the cap went from 240px to
   272px.
3. **The toast lay across the status line and the outbox count** — so the moment you most
   needed to read "1 note waiting to send" was the moment "Note saved" was covering it. It
   now sits in the empty band under the clock, where no control ever goes.
4. **Both forms stranded their one button in the middle of the screen**, with half a
   screen of black underneath, because it sat directly below the last field. The button
   you have to press is now pinned to the bottom where a thumb already is — one line,
   `margin-top: auto`, which resolves to nothing once the keyboard is up and the form
   needs to scroll.
5. **The paste box did not grow.** A fixed twelve rows left ~400px of nothing beneath the
   button. It now takes whatever room is left. Its drag-to-resize grabber went too: a
   desktop affordance that on a phone is a smudge in the corner of the field.
6. **The empty list read like a failure.** The message sat at the top of a tall black
   screen, which looks like a list that did not load rather than one with nothing in it
   yet. Centred, the same words read as deliberate — see bug 8 above for the two attempts
   that took.

**A fourth fault, found the same way and worth separating out**, is bugs 5 and 6 above:
the words view hid every control behind the text, and not one of the sixty-eight
assertions noticed. It is now guarded by a check that walks the seven rows of the layout
and fails if any one starts before the previous one ends.

Shots are in `docs/drive-mode/images/` (`picker-dark`, `empty-dark`, `add-dark`,
`keys-dark`, `player-dark`, `recording-dark`, `pending-dark`, `words-dark`). Regenerate
with:

```
node test/browser/serve.js &
NODE_PATH=<a node_modules with ws> node tools/shoot.js drive.shot.html out.png "?state=player" dark
```

**`tools/shoot.js` had to be written** because `chrome --screenshot` could not do this
job. It cannot wait for work that is neither a timer nor a network request, so the first
screenshot was taken mid-preparation and showed a progress bar at zero and a status line
that looked like a bug that was not there; and headless Chrome always reports a light
colour preference, so a dark-first design could not be photographed in the mode it was
designed for. The page now declares `window.__shotReady` and the tool waits for it, and
emulates the colour scheme over CDP.

## What only your phone can tell us

**Nine stories (D-8 to D-12, D-27 to D-30) have not been run, and five of them are the
reason this feature exists.** Headless Chrome has no lock screen, does not background a
page the way iOS does, and has a different media stack. Per the testing method, these are
the device lane and they are yours.

Fifteen minutes, parked, before you set off:

**Step 1 — get it onto the phone.**
1. On the laptop, open Folio, go to Settings, and export a backup.
2. AirDrop the file to the phone.
3. On the iPhone open Safari and go to `folio-six-sigma.vercel.app/drive`.
4. Tap **Open a file** and choose the backup.
   - *Works if:* the list fills with your pages, and a message says it imported your
     Speechify and Groq keys.
   - *Broken if:* it says the phone ran out of room. Tell me — Safari gives about five
     megabytes and your library is near that.
   - *Also worth telling me:* whether the file appears at all in the picker iOS shows
     you. iOS can hide a file whose type it does not recognise, and a backup AirDropped
     across can arrive with no extension.

**Step 1b — the two things that do not need the laptop at all (one minute).**
1. Copy a few paragraphs from anywhere — Notes, Safari, a message.
2. Back on the drive screen tap **Paste a page**, tap in the big box, and paste.
   - *Works if:* the keyboard comes up and **the page does not zoom in**. This is the one
     thing the browser tests cannot answer: they measure that every field is at least
     16px, which is the size at which Safari stops zooming — but Chrome never zooms, so
     only you can see whether it actually behaves.
   - *Broken if:* the screen zooms in on focus and stays zoomed. Everything after that is
     off the edge of the screen.
3. Tap **Add it**.
   - *Works if:* it goes straight into the player and starts preparing.
   - *Broken if:* the title is wrong, or the headings have come through as literal `#`
     characters.
4. Tap back, then **Voice keys**.
   - *Works if:* the key you already have is shown in the field, and the page does not
     zoom when you tap into it.

**Step 2 — prepare one document.**
1. Tap a page.
2. Watch the status line at the bottom.
   - *Works if:* it counts up and ends with "Whole document ready — safe to lock the
     screen."
   - *Broken if:* it stays on a percentage, or names an error.

**Step 3 — the lock screen. This is the one that matters.**
1. Press the big play button once. Listen for a second.
2. Press the phone's side button to lock the screen.
3. Wait **ninety seconds** without touching it. (Thirty is not enough: the failure this
   is looking for happens at a chunk boundary, and the old design would have failed at
   about thirty seconds.)
   - *Works if:* it is still reading.
   - *Broken if:* it goes quiet. Note roughly how many seconds in.
4. Wake the screen without unlocking. Look at the lock screen.
   - *Works if:* the document's title is there with a play/pause button and two
     fifteen-second skip arrows.
   - *Broken if:* there is nothing, or there are previous/next track buttons instead of
     the skip arrows.
5. Press pause on the lock screen, then play, then skip forward.
   - *Works if:* all three do what they say.

**Step 4 — switching apps.**
1. Unlock, open Maps, start any directions.
   - *Works if:* Folio keeps reading underneath.
   - *Broken if:* it stops, or does not come back after Maps speaks.

**Step 5 — a voice note.**
1. Back in Folio, press the big button, say a sentence, press it again.
   - *Works if:* reading resumes by itself and a message says the note was saved.
   - *Broken if:* nothing records, or the message mentions the microphone.
2. **Listen to the volume for the next thirty seconds.** This is the subtle one: asking
   iOS for the microphone changes the audio session, and playback afterwards can come back
   quieter or out of the earpiece instead of the speaker.
   - *Works if:* it sounds exactly as it did before.
   - *Broken if:* it is quieter, or coming out of the earpiece.
3. Put the phone in Airplane Mode, record a second note, turn Airplane Mode off.
   - *Works if:* "1 note waiting to send" appears and then goes away.

**Step 6 — back at the laptop.** Open the same page in Folio and open the comments panel.
   - *Works if:* both notes are there, each attached to a highlighted paragraph that is
     roughly what was being read when you spoke.

## Known limits

- **Use it in a Safari tab, not from the home screen.** Added to the home screen, iOS runs
  it as a standalone web app, and standalone is where background-audio restrictions are
  reported to bite hardest — several accounts have the same page working in a tab and
  failing in the standalone copy. `drive.html` deliberately does not declare itself
  web-app capable.
- **Preparation costs real money the first time** for any passage you have not heard in
  the reader. Everything you *have* heard is free, from disk.
- **The whole document's audio is held in memory** as one blob. A one-hour read is roughly
  20MB, which is fine; something many hours long would not be.
- **Safari gives an origin about five megabytes of storage.** Your library compresses to
  around 3.7MB, so it should fit, but it is close enough to be worth knowing.
- **Note anchoring is accurate to a sentence or two**, not to a word. It interpolates
  across the measured duration of the chunk you were in.
- **A pasted page lands on the phone and nowhere else.** The drive screen writes to this
  browser's storage, and nothing syncs. To get a pasted page back onto the laptop, export
  a backup from the phone — or paste it into Folio on the laptop as well.
- **There is no way to delete a page from the drive screen.** A mistaken paste stays in
  the list until you clear it from the laptop. Deliberate: a delete button is the last
  thing that should be reachable by a thumb in a moving car.
- **No sentence-level skip buttons.** Fifteen seconds is what a thumb expects and what the
  lock screen offers. The words view gives you sentence-level jumps by tapping instead.
- **The words view follows the audio to the sentence, not the word.** Apple highlights a
  word at a time; this lights a whole line. Word-level is possible with the same marks and
  was not done today.

## What I did not do

- **I did not test any of it on iOS.** Nine stories are untested and five of them are the
  feature's reason for existing. Everything above is Chrome.
- **I did not refactor `js/tts.js` to use the shared chunker.** Thirteen test files load
  `tts.js` by evaluating it, and each would have needed a new global. The duplication is
  real and the parity test is the mitigation.
- **I did not add drive mode to the main app's navigation.** You reach it by typing the
  URL. If it earns its place, it should get a link.
- **I did not handle a document being edited between preparing it and listening.** The
  chunks are planned once when you open it.
- **I did not test that scrolling ahead in the words view is not snatched back** (D-37).
  The suppression is six lines and is the kind of thing that works until it does not.
- **I did not test the voice-key screen against a real key.** The assertion is that what
  you type is saved under the name the reader reads, and that reopening the screen shows
  it. Whether a key typed on a phone keyboard actually authenticates is a `phone` story.
- **I did not handle a paste bigger than the browser will store.** The quota error is
  caught and named, but nothing offers to split the page or to drop something else first.
- **I did not look at the light-mode screenshots**, only dark. Light mode exists and the
  tokens are defined, but I judged the night case the one that mattered and only inspected
  that.
- **I did not investigate the "Block «paragraph» skipped because saved data is invalid"
  errors** in the console log you pasted earlier. There were hundreds of them. They are
  unrelated to this work but they may mean some content is not being read, which would
  affect what you hear on the drive. Worth a look when you are back.

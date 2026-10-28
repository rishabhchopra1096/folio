# Drive mode — every issue, for ever

**This is the only list.** If an issue about the drive screen is not in here, it is not
tracked. Ids are permanent: `DRIVE-3` means the same thing in a year.

**Status means six things.** `OPEN` nothing done · `DOING` being worked on · `BUILT` changed
AND verified by the strongest means short of his phone · `ASSUMED` changed but not verified
at all, never counted as progress · `DONE` he has seen it work on the device · `DECIDE`
waiting on him.

| id | cat | his words | status |
|---|---|---|---|
| DRIVE-1 | FN | "as soon as I press the microphone, it takes like about 2 seconds to start recording" | **OPEN** |
| DRIVE-2 | FN | "if I just have a small thing to say, it sometimes doesn't get recorded" | **OPEN** |
| DRIVE-3 | UX | "I have to wait 2 seconds till it starts recording. That is the problem." | BUILT |
| DRIVE-4 | UX | "I never see what was transcribed. So I like the lyrics view. We have to figure out how I can see what was transcribed." | BUILT |
| DRIVE-5 | LIKED | "I like the lyrics view." | LIKED |
| DRIVE-6 | LIKED | "it's working well. It's actually working well." | LIKED |
| DRIVE-8 | FN | "it was working just fine, and now it shows that the phone will not play audio. It is not supported." · then, after the first fix: "It still shows that it will not start playing audio. I don't know." | BUILT |
| DRIVE-7 | FN | "It just doesn't auto scroll... to center the sentence that I have to read" — then: "It is auto scrolling. I don't know why it was not. Maybe... when I have messed with it or like scrolled manually." | BUILT |

---

## DRIVE-1 — about two seconds before it starts recording

**His words:** *"as soon as I press the microphone, it takes like about 2 seconds to start
recording"*

**Screenshot:** `images/player/2026-10-28_no-audio-captured-after-short-press.png`

**What is actually happening.** Every press asks the operating system for the microphone
from scratch:

```
press → pause the reading → navigator.mediaDevices.getUserMedia(...)  ← the wait
      → new MediaRecorder(stream) → recorder.start() → only NOW does the button change
```

On iOS that middle step is not a formality. The phone is playing audio, so its audio
session is in a playback configuration; granting a microphone forces it into a
record-and-play configuration, and that switch is what costs the time. It happens on
**every** press, not just the first.

**~~Status: BUILT. The microphone is now kept warm between notes.~~**

**Status: OPEN, and the attempted fix caused DRIVE-8.** Holding the microphone open between
notes removed the wait in Chrome and stopped his iPhone playing audio at all within half an
hour. The two seconds are still there and are not going away without an iPhone to test on.

**What WAS fixed is DRIVE-3**, which turned out to be most of what he was asking for: he
now knows the exact moment it starts listening, instead of staring at a button that does
not change.

## DRIVE-2 — a short thought is sometimes not recorded at all

**His words:** *"if I just have a small thing to say, it sometimes doesn't get recorded"*

**Screenshot:** the second one — "No audio captured — try holding a bit longer."

**Same cause as DRIVE-1, and worth its own row** because it is a different failure to live
with: DRIVE-1 is an annoyance, this is a thought that is gone. He begins speaking as soon
as he has pressed, which is the only sensible thing to do, and the first two seconds of
what he says are not being captured by anything.

**Status: OPEN.** Same cause as DRIVE-1 and the same failed fix.

**He is right that it is the lesser of the two**, in his words *"which is okay, I will
never have a 2 second voice note"* — but it also means every note he does make is missing
its opening words, which is not visible from a toast that says the note was saved.



## DRIVE-3 — the waiting itself is the problem

**His words:** *"I have to wait 2 seconds till it starts recording. That is the problem."*

**This is the sharpest thing in the message and it is not the same complaint as DRIVE-1.**
Two seconds would be survivable if the screen said what was happening. It does not: the
button is written only AFTER the await resolves, so for those two seconds pressing the
largest control on the screen produces no change whatsoever. There is no way to tell
whether it heard you, so the only safe move is to wait and watch — which is precisely what
he should not be doing in a car.

**Status: BUILT.** The button now changes on the press itself, and changes again, clearly,
at the exact moment the microphone is live.

## DRIVE-4 — the transcript is never shown

**His words:** *"I never see what was transcribed. So I like the lyrics view. We have to
figure out how I can see what was transcribed."*

**Screenshot:** `images/player/2026-10-28_note-saved-toast-no-transcript.png` — the toast
reads *Note saved to "How the Pitch Gets Written"*, which tells him a note exists and
nothing about whether it is the note he meant.

**Why this matters more than it looks.** Dictation gets things wrong, and a wrong note you
never see is worse than no note: you drive on believing the thought is saved. Today the
only way to find out is to open the page on the laptop afterwards.

**Status: BUILT**, two ways — the toast now shows the words themselves, and the words view
keeps every note in place under the sentence it was taken against.

## DRIVE-5 — he likes the words view

**His words:** *"So I like the lyrics view."*

**Recorded so a later change cannot quietly destroy it.** The dimmed-neighbours reading
view stays; the note display in DRIVE-4 is built INTO it rather than replacing it.

## DRIVE-6 — it works

**His words:** *"problems, it's working well. It's actually working well."*

**Recorded because it is the first real-road report.** Playback, buffering, the wake lock,
the transport and the note capture all held up on an iPhone on 4G. The two problems above
are both about the moment of recording, not about the reading.

## DRIVE-7 — the words view sometimes stops following the line

**His words, first:** *"the syncing of the sentences, like the lyrics view works fine. It
just doesn't auto scroll, basically, to center the what's been the sentence that I have to
read."*

**His words, minutes later:** *"It is auto scrolling. I don't know why it was not. Maybe
when it doesn't auto scroll sometimes when I have messed with it or like scrolled
manually. I don't know. Maybe it's fine."*

**~~The cause is `scrollIntoView` failing silently inside a nested scroller on iOS.~~**
That was my first diagnosis and it was wrong — he corrected it before I finished acting on
it. It does scroll. **The real cause is the thing he guessed: having touched the list.**

The list stops following for six seconds after it is touched, so that looking ahead
deliberately is not yanked back. Two faults in how that was armed:

1. **It armed on touch, not on movement.** A stationary tap — including the tap that seeks
   to a line — froze the view for six seconds.
2. **A tap that landed between two lines never cleared it.** The clearing lived inside the
   handler that seeks, after an early return for "you did not hit a line", so a miss left
   the freeze in place with nothing on screen to say so.

Together those are exactly "it doesn't auto scroll sometimes when I have messed with it".

**Status: BUILT.** The hold now arms on actual dragging — four points of travel, so a thumb
that is not perfectly still on a tap does not count — and any tap anywhere in the list
clears it.

**Kept from the wrong diagnosis, on its own merits:** the scroll itself now sets the
container's `scrollTop` directly instead of calling `scrollIntoView({ block: "center" })`.
That method asks every scrollable ancestor to move and can scroll the page rather than the
list. It was not what he was seeing, but it is a real hazard on iOS and the direct version
can only ever move the one box.

## DRIVE-8 — the phone refuses to start the audio

**His words:** *"it was working just fine, and now it shows that the phone will not play
audio. It is not supported. What the fuck is happening? It was just working before this
deployment."*

**And after my first fix:** *"It still shows that it will not start playing audio. I don't
know."*

### My first diagnosis was wrong, and I shipped it

I blamed the warm microphone — the change in that same deploy that held the mic open for
ninety seconds after a note, which on iOS puts the audio session into record-and-play and
can stop an `<audio>` element starting. It was the only change that touched anything near
the audio system, so I reverted the deploy, removed the warm mic, and shipped again.

**It was still broken.** The second screenshot proves the new code was running — it shows
"5 notes saved", which only the new build draws.

**What I should have done first was read the screenshot properly**, which took two minutes
once I stopped theorising:

- The remaining time showed a bare **"—"**. That string appears nowhere in the code that
  writes the clock; it is the value in the HTML. So the clock had never been written since
  the page loaded, which means `loadedmetadata` never fired, which means **the audio source
  never loaded at all**.
- But the error came from `play()`, which is only reached once something has been stitched.

So: a file was built, handed to the element, and the element could not read it.

### The real cause, which predates every deploy

`durationOf()` measured each piece by decoding it, and wrapped the whole thing in a
`try/catch` that fell back to `blob.size / 6000` — bytes divided by a bitrate.

That fallback was written for a browser with no `AudioContext`. What it actually did was
swallow **both** cases: no decoder available, and *the decoder refusing these bytes*. A
piece that could not be decoded was therefore waved through with an invented duration,
joined into the single MP3 — and **one unreadable piece makes the whole joined file
unreadable**. The message then names the document, not the piece, which is why it sounded
catastrophic.

**And it could not recover.** The audio cache is keyed on the paragraph's text, so every
reload, every retry, every reopen was served the same unreadable bytes from disk. That is
why it stayed broken rather than failing once.

**The rule it broke** was already written down in this very directory: *a mechanism that
exists is not a mechanism that is sufficient*. `decodeAudioData` refusing is the single
best evidence available that bytes are not playable audio, and it was being used as
"never mind".

### What was done

1. **`durationOf` no longer swallows a decode failure.** No `AudioContext` at all is still
   a capability gap and still estimates; a decode that fails now throws.
2. **Nothing enters the file until the browser has proved it can decode it.** A piece that
   fails is thrown away, **forgotten from the cache** so the next attempt is not handed the
   same bytes, and fetched once more from the network. Only if the fresh copy also fails is
   it a real error — which separates bad stored bytes from a decoder that hiccuped.
3. **A blob under 1KB is rejected without bothering the decoder**, because an error page or
   a truncated download arrives looking like that and real speech never does.
4. `SpeechifyProvider.forget(text)` is new, and exists precisely because a cache keyed on
   text turns one bad response into a permanent one.

**Status: BUILT.** Four new assertions, and the mutation that restores the old
`try/catch` fails two of them. One of those two is a length check rather than a
playability check, deliberately: Chrome will happily play a file with rubbish spliced into
it where iOS will not, so **length is how this environment can see a consequence that only
his phone can hear.**

### What this says about the testing

The browser probe had 115 assertions about this screen and not one of them ever fed it a
piece of audio that would not decode. Every chunk in every test was a real, valid,
generated MP3. The one failure mode that takes the whole feature down had no test because
the test fixtures were all well-formed — the same shape as a fixture written to make the
component look right.

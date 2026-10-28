# Drive mode — every issue, for ever

**This is the only list.** If an issue about the drive screen is not in here, it is not
tracked. Ids are permanent: `DRIVE-3` means the same thing in a year.

**Status means six things.** `OPEN` nothing done · `DOING` being worked on · `BUILT` changed
AND verified by the strongest means short of his phone · `ASSUMED` changed but not verified
at all, never counted as progress · `DONE` he has seen it work on the device · `DECIDE`
waiting on him.

| id | cat | his words | status |
|---|---|---|---|
| DRIVE-1 | FN | "as soon as I press the microphone, it takes like about 2 seconds to start recording" | BUILT |
| DRIVE-2 | FN | "if I just have a small thing to say, it sometimes doesn't get recorded" | BUILT |
| DRIVE-3 | UX | "I have to wait 2 seconds till it starts recording. That is the problem." | BUILT |
| DRIVE-4 | UX | "I never see what was transcribed. So I like the lyrics view. We have to figure out how I can see what was transcribed." | BUILT |
| DRIVE-5 | LIKED | "I like the lyrics view." | LIKED |
| DRIVE-6 | LIKED | "it's working well. It's actually working well." | LIKED |
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

**Status: BUILT.** The microphone is now kept warm between notes, so only the first press
in a burst pays for the switch. See FIXES.md.

## DRIVE-2 — a short thought is sometimes not recorded at all

**His words:** *"if I just have a small thing to say, it sometimes doesn't get recorded"*

**Screenshot:** the second one — "No audio captured — try holding a bit longer."

**Same cause as DRIVE-1, and worth its own row** because it is a different failure to live
with: DRIVE-1 is an annoyance, this is a thought that is gone. He begins speaking as soon
as he has pressed, which is the only sensible thing to do, and the first two seconds of
what he says are not being captured by anything.

**He is right that it is the lesser of the two**, in his words *"which is okay, I will
never have a 2 second voice note"* — but it also means every note he does make is missing
its opening words, which is not visible from a toast that says the note was saved.

**Status: BUILT**, by the same fix.

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

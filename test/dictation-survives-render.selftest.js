/* Voice notes must survive a transcription running underneath them.

   The bug: a streaming transcript wrote every 1.5s, every write called
   Reader.renderDocument, that called TTS.attach -> detach -> cancelDictation,
   and cancelDictation threw the audio away. Recording while a transcription
   was in progress was impossible, and the recording was destroyed with no way
   to get it back. */
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const tts = fs.readFileSync(REPO + "/js/tts.js", "utf8");
const video = fs.readFileSync(REPO + "/js/video.js", "utf8");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };

console.log("\n=== teardown never destroys a recording ===");
const detachBody = tts.slice(tts.indexOf("function detach()"),
                             tts.indexOf("function detach()") + 1400);
ok("detach no longer cancels the dictation", !/^\s*cancelDictation\(\);/m.test(detachBody),
   (detachBody.match(/.*cancelDictation.*/) || [""])[0].trim());
ok("it finishes and saves it instead",
   /if \(micState === "recording"\) \{[\s\S]{0,200}finishDictation\(\)/.test(detachBody));
// The comment wraps, so match across the line break rather than the literal.
ok("and the reason is written down so it is not undone",
   /silently destroyed voice[\s*]+notes/.test(tts));
ok("including that it made recording during transcription impossible",
   /Recording during transcription was simply impossible/.test(tts));

console.log("\n=== the note is filed against the right document ===");
ok("the document is pinned when recording starts", /micDocId = attachedDocId;/.test(tts));
ok("saving uses the pinned document", /addComment\(highlightId, text, micDocId \|\| attachedDocId/.test(tts));
ok("so does the offline retry queue", /docId: micDocId \|\| attachedDocId/.test(tts));
// detach() clears attachedDocId, so relying on it alone would misfile the note.
ok("detach still clears the live document reference", /attachedDocId = null;/.test(tts));

console.log("\n=== the page holds still while you are talking ===");
ok("TTS reports whether a dictation is in flight", /function isDictating\(\)/.test(tts));
ok("recording and uploading both count",
   /micState === "recording" \|\| micState === "transcribing"/.test(tts));
ok("isDictating is exported", /^\s*isDictating,$/m.test(tts));
ok("the transcript write checks it", /TTS\.isDictating && TTS\.isDictating\(\)/.test(video));
ok("and defers the re-render", /deferredRenderDoc = docId;\n      return;/.test(video));

console.log("\n=== but nothing is lost while it is deferred ===");
const wb = video.slice(video.indexOf("function writeBlocks(docId, blocks)"),
                       video.indexOf("function flushDeferredRender"));
const storeAt = wb.indexOf("FolioStore.updateDocument");
const deferAt = wb.indexOf("deferredRenderDoc = docId");
ok("storage is written BEFORE the deferral check", storeAt > -1 && storeAt < deferAt,
   `store@${storeAt} defer@${deferAt}`);
ok("so a reload mid-dictation still has the lines", /updateDocument\(docId, \{ content:/.test(wb));

console.log("\n=== the held-back render runs when the dictation ends ===");
ok("saving a dictation announces the end", /announceDictationEnd\(\);/.test(tts));
ok("cancelling announces it too, so a render is never stranded",
   (tts.match(/announceDictationEnd\(\);/g) || []).length >= 2);
ok("the event is a plain DOM event", /new CustomEvent\("folio:dictation-end"\)/.test(tts));
ok("video listens for it", /addEventListener\("folio:dictation-end"/.test(video));
ok("and flushes the deferred render", /setTimeout\(flushDeferredRender, 0\)/.test(video));
ok("flushing clears the pending doc so it cannot loop",
   /const docId = deferredRenderDoc;\n    deferredRenderDoc = null;/.test(video));
ok("and it will not render a document you have navigated away from",
   /if \(Reader\.getCurrentDocId\(\) !== docId\) return;/.test(video));

console.log("\n=== the 'done' signal can never be forgotten ===");
/* Four error paths used to set micState directly and announce nothing. A
   render deferred while dictating was then stranded permanently: the lines
   were safely in storage but the page said "Transcribing…" forever. */
// The `let micState = "idle"` declaration matches too, so exclude it.
const idleAssignments = (tts.match(/(?<!let )micState = "idle"/g) || []).length;
ok("exactly one place returns the mic to idle", idleAssignments === 1,
   idleAssignments + " assignments outside the declaration");
ok("and it lives inside micIdle()",
   /function micIdle\(\) \{\s*micState = "idle";\s*announceDictationEnd\(\);/.test(tts));
ok("every other path goes through it", (tts.match(/micIdle\(\);/g) || []).length >= 5);
ok("the failure it prevents is written down", /stranded a deferred render/.test(tts));

console.log("\n=== the audio still has its other safety nets ===");
ok("a failed upload is queued rather than dropped", /queueForRetry\(blob, targetHighlight\)/.test(tts));
ok("capture is separate from upload, so a network error cannot bin the audio",
   /stopRecordingRaw/.test(fs.readFileSync(REPO + "/js/voice.js", "utf8")));
ok("only an explicit cancel discards", /toast\("Discarded", 1400\)/.test(tts));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

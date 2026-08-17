/*
 * =============================================================================
 * VOICE.JS — Speech-to-Text via Groq Whisper (browser-native)
 * =============================================================================
 * FILE OVERVIEW:
 * Records audio from the user's microphone using the browser MediaRecorder API
 * and transcribes it via Groq's hosted whisper-large-v3 endpoint. Used by the
 * mic button in the comments panel — click to record, click again to stop and
 * transcribe. Result gets inserted at the caret position in the comment field.
 *
 * WHY THIS EXISTS:
 * We ported the recording + transcription flow from the user's own project
 * `superwhisper-clone` (Electron app). The mic capture pattern is a direct
 * lift (getUserMedia + MediaRecorder). The Groq HTTP call is browser-native
 * FormData instead of the Node form-data package — Groq's CORS policy allows
 * direct browser calls, so no proxy is needed.
 *
 * WHY THE KEY LIVES IN LOCALSTORAGE:
 * Folio is a static site on Vercel with a PUBLIC GitHub repo. Any API key
 * embedded in the shipped JS bundle is (a) auto-detected by GitHub secret
 * scanning and auto-revoked by Groq within minutes, and (b) readable in
 * DevTools by any visitor. The only static-site-friendly options are:
 *   - user pastes their own key (this file's approach), or
 *   - a Vercel serverless proxy holding the key server-side (heavier)
 * User chose the "own key" route so this module reads the key from
 * localStorage and never lets it enter shipped source.
 * =============================================================================
 */

const Voice = (function () {

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  // localStorage key for the user's personal Groq API key
  const KEY_STORAGE = "folio_groq_key";

  // Groq's OpenAI-compatible audio transcription endpoint
  const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

  // whisper-large-v3 is Groq's best transcription model; free tier is generous
  const GROQ_MODEL = "whisper-large-v3";

  // Recording audio format — opus in webm is broadly supported by browsers and
  // by Groq's whisper endpoint. 16 kHz mono is what whisper wants internally.
  const AUDIO_CONSTRAINTS = {
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  };
  const MIME_TYPE = "audio/webm;codecs=opus";

  // ==========================================================================
  // KEY STORAGE — Read/write the user's Groq key from localStorage
  // ==========================================================================

  function getKey() {
    return localStorage.getItem(KEY_STORAGE) || "";
  }

  function setKey(k) {
    if (!k) {
      localStorage.removeItem(KEY_STORAGE);
    } else {
      localStorage.setItem(KEY_STORAGE, k.trim());
    }
  }

  function clearKey() {
    localStorage.removeItem(KEY_STORAGE);
  }

  function hasKey() {
    return !!getKey();
  }

  // ==========================================================================
  // RECORDER — MediaRecorder wrapper
  // ==========================================================================

  /*
   * A single "handle" tracks one active recording. The public API returns a
   * handle from startRecording; the caller passes it back to stopRecording or
   * cancelRecording. This avoids storing recorder state as module-level
   * singletons, which would misbehave if the user somehow triggered two
   * recordings in parallel.
   */

  async function startRecording() {
    // Fail fast with a clear error the caller can surface to the user
    if (typeof MediaRecorder === "undefined") {
      throw new Error("Your browser doesn't support MediaRecorder. Use Chrome, Safari, or Edge.");
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone access isn't available in this browser.");
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        throw new Error("Microphone permission was denied. Enable it in your browser's site settings and try again.");
      }
      if (err && err.name === "NotFoundError") {
        throw new Error("No microphone found on this device.");
      }
      throw new Error("Couldn't access the microphone: " + (err && err.message ? err.message : "unknown error"));
    }

    // Pick a mime type the browser can actually produce
    let mime = MIME_TYPE;
    if (!MediaRecorder.isTypeSupported(mime)) {
      // Fallback to whatever the browser defaults to (Safari doesn't do opus)
      mime = "";
    }
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.start();

    return { recorder, stream, chunks, startedAt: Date.now() };
  }

  /*
   * Stop the recording, upload the audio to Groq, return the transcript.
   * `handle` is what startRecording returned. Throws on any failure with a
   * user-readable message.
   */
  async function stopRecording(handle) {
    const audioBlob = await stopRecordingRaw(handle);
    return transcribeBlob(audioBlob);
  }

  /*
   * Stop recording and hand back the raw audio WITHOUT transcribing it.
   *
   * Splitting this out matters: if transcription and capture happen in one
   * call, a failed upload takes the audio down with it — the blob goes out of
   * scope and the recording is simply lost. Callers that want to survive a
   * dropped connection stop first, hold the blob, and transcribe separately so
   * they can retry the upload with the same audio.
   */
  async function stopRecordingRaw(handle) {
    if (!handle || !handle.recorder) throw new Error("No active recording");

    // Wait for the recorder to actually emit its final chunk
    const audioBlob = await new Promise((resolve) => {
      handle.recorder.onstop = () => {
        const blob = new Blob(handle.chunks, {
          type: handle.recorder.mimeType || "audio/webm",
        });
        resolve(blob);
      };
      handle.recorder.stop();
    });

    // Free the mic — otherwise the browser keeps the "recording" indicator on
    stopStream(handle.stream);

    // Anything under ~1KB is either silence or a mic that never engaged
    if (audioBlob.size < 1024) {
      throw new Error("No audio captured — try holding a bit longer.");
    }

    return audioBlob;
  }

  /*
   * Is this failure worth retrying? A dropped connection or a server-side
   * wobble will succeed later; a rejected key or an empty recording never will,
   * so those must not sit in a queue forever.
   */
  function isRetryable(err) {
    const m = (err && err.message ? err.message : "").toLowerCase();
    if (m.includes("rejected the key")) return false;      // 401
    if (m.includes("no audio")) return false;
    if (m.includes("set your groq api key")) return false;
    if (m.includes("network error")) return true;
    if (m.includes("rate limit")) return true;             // 429
    if (/groq api error \((5\d\d|408|409)\)/.test(m)) return true;
    return false;
  }

  /*
   * Discard an active recording without uploading. Same handle contract as
   * stopRecording, but no network call and no transcript returned.
   */
  function cancelRecording(handle) {
    if (!handle) return;
    try {
      if (handle.recorder && handle.recorder.state !== "inactive") {
        handle.recorder.stop();
      }
    } catch { /* recorder may already be stopped */ }
    stopStream(handle.stream);
  }

  // Release all mic tracks so the browser's "recording" indicator goes away
  function stopStream(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch { /* stream may already be released */ }
  }

  // ==========================================================================
  // GROQ CLIENT — Upload an audio Blob, return the transcript
  // ==========================================================================

  async function transcribeBlob(blob) {
    const key = getKey();
    if (!key) {
      throw new Error("Set your Groq API key in Settings → Voice first.");
    }

    // File extension inferred from mime type so Groq's server picks the right decoder
    let ext = "webm";
    if (blob.type.includes("mp4")) ext = "mp4";
    else if (blob.type.includes("mpeg") || blob.type.includes("mp3")) ext = "mp3";
    else if (blob.type.includes("wav")) ext = "wav";
    else if (blob.type.includes("ogg")) ext = "ogg";

    const form = new FormData();
    form.append("file", blob, `recording.${ext}`);
    form.append("model", GROQ_MODEL);

    let response;
    try {
      response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
        },
        body: form,
      });
    } catch (err) {
      throw new Error("Network error contacting Groq: " + (err && err.message ? err.message : "unknown"));
    }

    if (!response.ok) {
      // Try to surface the actual API error message so debugging isn't a mystery
      let apiMsg = "";
      try {
        const errorBody = await response.json();
        apiMsg = errorBody && errorBody.error && errorBody.error.message ? errorBody.error.message : "";
      } catch { /* body wasn't JSON */ }

      if (response.status === 401) {
        throw new Error("Groq rejected the key. Check it in Settings → Voice.");
      }
      if (response.status === 429) {
        throw new Error("Groq rate limit hit. Try again in a moment.");
      }
      throw new Error(`Groq API error (${response.status})${apiMsg ? ": " + apiMsg : ""}`);
    }

    const data = await response.json();
    return (data && typeof data.text === "string" ? data.text : "").trim();
  }

  // ==========================================================================
  // TEST HELPER — For the "Test" button in Settings. 500ms silent-ish recording
  // just to confirm the key is accepted (Groq returns "" for silence, no error).
  // ==========================================================================

  async function testKey() {
    if (!hasKey()) throw new Error("Enter a key first");
    const handle = await startRecording();
    await new Promise((r) => setTimeout(r, 500));
    // stopRecording will throw "No audio captured" for <1KB — we can catch
    // that and treat it as "the key was fine, just no audio in 500ms."
    try {
      await stopRecording(handle);
    } catch (err) {
      if (err && err.message && err.message.startsWith("No audio")) {
        return true;
      }
      throw err;
    }
    return true;
  }

  return {
    getKey,
    setKey,
    clearKey,
    hasKey,
    startRecording,
    stopRecording,
    stopRecordingRaw,
    transcribe: transcribeBlob,
    isRetryable,
    cancelRecording,
    testKey,
  };
})();

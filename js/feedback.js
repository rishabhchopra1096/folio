/*
 * =============================================================================
 * FEEDBACK.JS — The box at the bottom left for telling Folio what is wrong
 * =============================================================================
 * FILE OVERVIEW:
 * Every other module in Folio is about the thing being read. This one is about
 * Folio itself. It puts a small round button at the bottom left of the reading
 * area; pressing it opens a card where you write a bug or an idea, paste a
 * screenshot, and press one button.
 *
 * THE PROBLEM THIS SOLVES, AND IT IS NOT "THERE IS NOWHERE TO TYPE":
 * The point of writing the note is to be able to say, later, "please fix the
 * things I asked for" and have that be enough. Folio has no server, and
 * localStorage cannot be read from outside the browser — so a note that only
 * lives in localStorage is visible to the person who wrote it and invisible to
 * the person who has to act on it. The note has to reach a FILE.
 *
 * So pressing save does two things in this order, and the order matters:
 *   1. SEND — write every note as one JSON bundle into the Downloads folder.
 *   2. STORE — keep the note in localStorage so the list survives a reload.
 * Sending first means that if the browser refuses to store the note (which it
 * really can — screenshots are big and the quota is about five megabytes for
 * everything Folio owns) the feedback has already left the building. Losing the
 * record is survivable. Losing the feedback is the one thing that must not
 * happen, because then it gets reported again, and that is the whole failure
 * this box exists to stop.
 *
 * HOW IT WORKS — the components:
 *   1. pictureFromBlob  — turns a pasted or dropped image into a small data URL
 *   2. buildBundle      — assembles every note into the JSON that gets sent
 *   3. sendBundle       — downloads that JSON, named with the time
 *   4. submit           — the save button: validate, send, store, redraw
 *   5. renderList       — the notes you have already written, with their ids
 *   6. openCard / closeCard / renderShots — the card and its thumbnail strip
 *   7. init             — wires the button, the keys, and the global paste
 *
 * THE FLOW:
 * Take a screenshot. Press Cmd-V anywhere in Folio — the card opens with the
 * picture already attached. Type what is wrong. Press Cmd-Enter. A file lands
 * in Downloads, the note appears in the list with an id like FB-3, and Claude
 * reads it with `node tools/feedback-inbox.js`.
 * =============================================================================
 */

const Feedback = (function () {

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  /*
   * The longest side any attached picture is allowed to have.
   *
   * 1800 is not an aesthetic choice. Claude Code refuses an image over 2000px
   * on a side when several are sent together, so a screenshot kept at its
   * original Retina size is a screenshot that cannot actually be looked at.
   * 1800 leaves a margin under that limit. It also happens to cut a 5MB grab
   * down to a few hundred kilobytes, which is the difference between the
   * bundle being emailable and not.
   */
  const MAX_EDGE = 1800;

  /*
   * Above this many characters of base64, re-encode as JPEG instead of PNG.
   * ~700k characters is about half a megabyte of actual bytes. Below it PNG is
   * worth keeping, because screenshots are mostly flat colour and text, and
   * PNG keeps the text crisp. Above it the picture is photographic enough that
   * PNG is just wasting room.
   */
  const PNG_BUDGET = 700000;

  // Module state. `draft` is the note being written; null when the card is shut.
  let draft = null;
  let cardOpen = false;

  // ==========================================================================
  // PICTURES — paste or drop an image, get back something small enough to keep
  // ==========================================================================

  /*
   * WHAT THIS FUNCTION DOES:
   * Takes a raw image file (from the clipboard, a drop, or the file picker)
   * and returns a promise for a record describing a shrunken copy of it.
   *
   * WHY WE NEED IT:
   * A screenshot off a Retina display is roughly 3000x2000 and several
   * megabytes. Three of those would exceed everything localStorage will hold,
   * and none of them could be sent to Claude anyway (see MAX_EDGE). So nothing
   * is ever stored at its original size.
   *
   * HOW IT WORKS:
   * 1. Load the file into an <img> through a temporary blob URL.
   * 2. Work out the scale needed to bring the longest side to MAX_EDGE, never
   *    scaling UP — a small screenshot stays exactly as it is.
   * 3. Draw it into a canvas at that size and read it back as a data URL.
   * 4. If the PNG came out bigger than PNG_BUDGET, do step 3 again as JPEG.
   */
  function pictureFromBlob(blob) {
    return new Promise(function (resolve, reject) {
      if (!blob || !/^image\//.test(blob.type || "")) {
        reject(new Error("that was not a picture"));
        return;
      }

      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onerror = function () {
        URL.revokeObjectURL(url);
        console.warn("[feedback] could not decode the pasted picture", blob.type);
        reject(new Error("could not read that picture"));
      };

      img.onload = function () {
        URL.revokeObjectURL(url);

        // Never enlarge: a 600px screenshot is already small enough.
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        /*
         * A white backdrop before drawing, because a PNG with transparency
         * re-encoded as JPEG turns its transparent pixels BLACK, and a
         * screenshot with a black bar through it reads as a rendering bug in
         * Folio rather than as an artefact of the attachment.
         */
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        let type = "image/png";
        let bytes = canvas.toDataURL(type);
        if (bytes.length > PNG_BUDGET) {
          type = "image/jpeg";
          bytes = canvas.toDataURL(type, 0.88);
        }

        console.log("[feedback] attached a picture " + img.width + "x" + img.height +
                    " -> " + w + "x" + h + " as " + type + ", " +
                    Math.round(bytes.length / 1024) + "kb of base64");

        resolve({
          name: blob.name || "screenshot",
          type: type,
          w: w,
          h: h,
          bytes: bytes,
          sent: false,
        });
      };

      img.src = url;
    });
  }

  /*
   * Pull every image out of a paste or a drop.
   *
   * A clipboard carries several representations of the same thing at once — a
   * screenshot usually arrives as both an image and an HTML fragment — so this
   * walks the items and keeps only the actual files.
   */
  function imagesFrom(dataTransfer) {
    if (!dataTransfer) return [];
    const out = [];
    const items = dataTransfer.items;
    if (items && items.length) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file" && /^image\//.test(items[i].type || "")) {
          const f = items[i].getAsFile();
          if (f) out.push(f);
        }
      }
    }
    // Some browsers only populate .files on a drop, so fall back to that.
    if (!out.length && dataTransfer.files) {
      for (let i = 0; i < dataTransfer.files.length; i++) {
        if (/^image\//.test(dataTransfer.files[i].type || "")) out.push(dataTransfer.files[i]);
      }
    }
    return out;
  }

  // ==========================================================================
  // CONTEXT — what was on screen when the note was written
  // ==========================================================================

  /*
   * WHAT THIS FUNCTION DOES:
   * Records where you were when you pressed the button, so the note arrives
   * with its surroundings attached.
   *
   * WHY WE NEED IT:
   * "The highlighting is the wrong colour" is a different bug in read mode
   * than in edit mode, on the Night theme than on Paper, and on read 3 than on
   * read 1. Asking afterwards wastes a round trip, and by then nobody
   * remembers. Everything here is free to collect at the moment it is true.
   */
  function captureContext() {
    const ctx = {
      href: location.href,
      hash: location.hash || "",
      mode: /\/edit$/.test(location.hash || "") ? "edit"
          : /^#\/doc\//.test(location.hash || "") ? "read" : "home",
      theme: document.documentElement.getAttribute("data-theme") || "default",
      viewport: window.innerWidth + "x" + window.innerHeight,
      ua: navigator.userAgent || "",
      app: (window.folio && window.folio.isElectron) ? "electron" : "web",
    };

    // Which document, and which pass through it — both only exist if one is open.
    try {
      const docId = (typeof Reader !== "undefined" && Reader.getCurrentDocId)
        ? Reader.getCurrentDocId() : null;
      if (docId) {
        ctx.docId = docId;
        const doc = FolioStore.getDocument(docId);
        if (doc && doc.meta) ctx.docTitle = doc.meta.title || "";
        const read = FolioStore.getCurrentRead ? FolioStore.getCurrentRead(docId) : null;
        if (read) ctx.readLabel = FolioStore.readLabel(read);
      }
    } catch (err) {
      // Context is a nicety. A note with no context still beats no note.
      console.warn("[feedback] could not read the document context", err);
    }

    return ctx;
  }

  // ==========================================================================
  // THE BUNDLE — the file that actually reaches Claude
  // ==========================================================================

  /*
   * WHAT THIS FUNCTION DOES:
   * Builds the JSON object that gets written into the Downloads folder.
   *
   * WHY IT CARRIES EVERY NOTE AND NOT JUST THE NEW ONE:
   * Because then the newest file in Downloads is always a complete picture of
   * what you have asked for, and nothing depends on an earlier file still
   * being there. The one thing a bundle can lack is the BYTES of a picture
   * attached to a note that was already sent, because those bytes are dropped
   * from storage straight after their own send. The ingest tool therefore
   * reads every bundle it finds rather than only the newest, and takes each
   * picture from whichever bundle still has it.
   */
  function buildBundle(notes) {
    return {
      kind: "folio-feedback",
      version: 1,
      exportedAt: new Date().toISOString(),
      origin: location.origin + location.pathname,
      items: notes,
    };
  }

  /*
   * Write the bundle out as a download.
   *
   * The filename carries the time to the second, so files sort chronologically
   * and the browser never has to invent a "(1)" suffix — which it does
   * silently, and which would make the newest file the hardest one to find.
   */
  function sendBundle(notes) {
    const bundle = buildBundle(notes);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = "folio-feedback-" + stamp + ".json";

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log("[feedback] sent " + notes.length + " note(s) as " + name);
    return name;
  }

  // ==========================================================================
  // SAVING — the one button, and the order it does things in
  // ==========================================================================

  /*
   * WHAT THIS FUNCTION DOES:
   * Turns whatever is in the card into a stored, sent note.
   *
   * HOW IT WORKS:
   * 1. Refuse an empty note — with a reason, not a silent no-op.
   * 2. Give it the next permanent number, so it has an id you can quote.
   * 3. SEND first: download the bundle including this note, with its pictures.
   * 4. THEN store: drop the picture bytes and write the list to localStorage.
   * 5. Redraw, and say so.
   *
   * Steps 3 and 4 are in that order on purpose — see the file header.
   */
  function submit() {
    if (!draft) return { ok: false, reason: "no-draft" };

    const text = (draft.text || "").trim();
    if (!text && !(draft.shots || []).length) {
      notice("Write something, or paste a screenshot — an empty note tells nobody anything.");
      return { ok: false, reason: "empty" };
    }

    const note = {
      id: FolioStore.generateId("fb"),
      n: FolioStore.nextFeedbackNumber(),
      kind: draft.kind === "idea" ? "idea" : "bug",
      text: text,
      shots: (draft.shots || []).slice(),
      context: captureContext(),
      createdAt: new Date().toISOString(),
      sentAt: null,
      status: "open",
    };

    const notes = FolioStore.getFeedback();
    notes.push(note);

    /*
     * SEND BEFORE STORE. If the download fails the note is not marked sent and
     * nothing is lost — it stays in the list with a "not sent" marker and the
     * "Send all again" button will pick it up. If the STORE fails afterwards,
     * the bundle is already on disk, which is the copy that matters.
     */
    let sentName = null;
    try {
      sentName = sendBundle(notes);
      note.sentAt = new Date().toISOString();
    } catch (err) {
      console.error("[feedback] could not write the bundle to Downloads", err);
      notice("Saved here, but the file could not be written to Downloads. " +
             "Press “Send all again” to retry.");
    }

    // Only now drop the bytes — after they have been written out.
    if (note.sentAt) FolioStore.pruneFeedbackBytes(note);

    try {
      FolioStore.saveFeedback(notes);
    } catch (err) {
      console.error("[feedback] could not store the note", err);
      notice(note.sentAt
        ? "FB-" + note.n + " was sent, but this browser would not keep a copy — " +
          "its storage is full. Nothing was lost."
        : "This browser would not keep the note and it could not be sent. " +
          "Copy your words somewhere safe before closing.");
    }

    console.log("[feedback] FB-" + note.n + " (" + note.kind + ") saved" +
                (sentName ? " and sent in " + sentName : " but NOT sent") +
                " with " + note.shots.length + " picture(s)");

    draft = null;
    renderList();
    renderCount();
    closeCard();
    notice(note.sentAt
      ? "FB-" + note.n + " saved and sent. Say “fix what I asked for” any time."
      : "FB-" + note.n + " saved here, but not sent yet.");

    return { ok: true, id: note.id, n: note.n };
  }

  /*
   * Send every note again, pictures and all for anything still holding them.
   *
   * This exists for two situations that both really happen: the Downloads
   * folder got cleared, and a download that failed the first time. It is
   * deliberately a separate button rather than something automatic, because a
   * file appearing in Downloads with no action behind it is alarming.
   */
  function resendAll() {
    const notes = FolioStore.getFeedback();
    if (!notes.length) {
      notice("Nothing to send yet.");
      return { ok: false, reason: "empty" };
    }
    try {
      const name = sendBundle(notes);
      const now = new Date().toISOString();
      notes.forEach((f) => { if (!f.sentAt) f.sentAt = now; });
      notes.forEach(FolioStore.pruneFeedbackBytes);
      FolioStore.saveFeedback(notes);
      renderList();
      notice("Sent " + notes.length + " note" + (notes.length === 1 ? "" : "s") + " as " + name);
      return { ok: true, name: name, count: notes.length };
    } catch (err) {
      console.error("[feedback] resend failed", err);
      notice("Could not write the file to Downloads.");
      return { ok: false, reason: "download-failed" };
    }
  }

  /* Mark a note done, or put it back. You own this column, not Claude — there
   * is no way to write into your browser from outside it, so a fix landing
   * cannot tick anything here. It stays honest by being yours. */
  function setStatus(id, status) {
    const notes = FolioStore.getFeedback();
    const note = notes.find((f) => f.id === id);
    if (!note) return false;
    note.status = status === "done" ? "done" : "open";
    FolioStore.saveFeedback(notes);
    console.log("[feedback] FB-" + note.n + " is now " + note.status);
    renderList();
    renderCount();
    return true;
  }

  function removeNote(id) {
    const notes = FolioStore.getFeedback();
    const i = notes.findIndex((f) => f.id === id);
    if (i === -1) return false;
    const gone = notes[i];
    notes.splice(i, 1);
    FolioStore.saveFeedback(notes);
    /*
     * The number is NOT reused. Numbers come from a counter that only goes up,
     * so deleting FB-3 leaves a gap rather than renaming FB-4 to FB-3 behind
     * your back. A gap is confusing for a second; a renumber is wrong for ever.
     */
    console.log("[feedback] deleted FB-" + gone.n + " (number not reused)");
    renderList();
    renderCount();
    return true;
  }

  // ==========================================================================
  // THE CARD — opening it, closing it, and the thumbnail strip
  // ==========================================================================

  function el(id) { return document.getElementById(id); }

  function openCard(withPictures) {
    const card = el("feedback-card");
    if (!card) return;

    if (!draft) draft = { kind: "bug", text: "", shots: [] };
    cardOpen = true;
    card.hidden = false;
    el("feedback-box").classList.add("open");

    const area = el("feedback-text");
    if (area) {
      area.value = draft.text || "";
      // Focus after the paint, or the caret lands before the card is laid out.
      setTimeout(() => area.focus(), 0);
    }
    drawKind();
    renderShots();
    renderList();

    if (withPictures && withPictures.length) attach(withPictures);
  }

  function closeCard() {
    const card = el("feedback-card");
    if (!card) return;
    // Keep whatever was typed, so a stray Escape does not throw the words away.
    const area = el("feedback-text");
    if (draft && area) draft.text = area.value;
    cardOpen = false;
    card.hidden = true;
    el("feedback-box").classList.remove("open");
  }

  function toggleCard() {
    if (cardOpen) closeCard(); else openCard();
  }

  function drawKind() {
    const kind = draft ? draft.kind : "bug";
    document.querySelectorAll(".fb-kind-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.kind === kind);
    });
    const area = el("feedback-text");
    if (area) {
      area.placeholder = kind === "idea"
        ? "What should Folio do that it doesn't?"
        : "What went wrong, and what did you expect instead?";
    }
  }

  /*
   * Add pictures to the draft, one at a time, reporting each failure.
   *
   * Shrinking is asynchronous, so the strip is redrawn as each one lands
   * rather than after all of them — pasting three screenshots should show the
   * first immediately, not nothing for a second and then everything.
   */
  function attach(files) {
    if (!draft) draft = { kind: "bug", text: "", shots: [] };
    files.forEach(function (f) {
      pictureFromBlob(f).then(function (pic) {
        draft.shots.push(pic);
        renderShots();
      }).catch(function (err) {
        notice(err && err.message ? err.message : "Could not read that picture");
      });
    });
  }

  function renderShots() {
    const strip = el("feedback-shots");
    if (!strip) return;
    const shots = (draft && draft.shots) || [];
    strip.innerHTML = "";
    strip.hidden = !shots.length;

    shots.forEach(function (s, i) {
      const item = document.createElement("div");
      item.className = "fb-shot";
      if (s.bytes) {
        const img = document.createElement("img");
        img.src = s.bytes;
        img.alt = s.w + " by " + s.h + " picture";
        item.appendChild(img);
      } else {
        // A picture already sent and pruned. Say so rather than show a gap.
        const ph = document.createElement("span");
        ph.className = "fb-shot-sent";
        ph.textContent = "sent";
        item.appendChild(ph);
      }
      const rm = document.createElement("button");
      rm.className = "fb-shot-remove";
      rm.type = "button";
      rm.title = "Remove this picture";
      rm.innerHTML = "&times;";
      rm.addEventListener("click", function () {
        draft.shots.splice(i, 1);
        renderShots();
      });
      item.appendChild(rm);
      strip.appendChild(item);
    });
  }

  // ==========================================================================
  // THE LIST — what you have already asked for, with the ids you can quote
  // ==========================================================================

  function renderList() {
    const list = el("feedback-list");
    if (!list) return;
    const notes = FolioStore.getFeedback();

    const label = el("feedback-list-label");
    if (label) {
      const open = notes.filter((f) => f.status !== "done").length;
      label.textContent = !notes.length ? "Nothing asked for yet"
        : open + " open of " + notes.length;
    }

    /* Offering to send nothing is an action that cannot do anything. */
    const resend = el("feedback-resend");
    if (resend) resend.hidden = !notes.length;

    list.innerHTML = "";
    if (!notes.length) {
      const empty = document.createElement("div");
      empty.className = "fb-empty";
      empty.textContent = "Your notes appear here with an id, so you can say " +
                          "“FB-2 is still broken” and be understood.";
      list.appendChild(empty);
      return;
    }

    // Newest first — the thing you just wrote is the thing you want to see.
    notes.slice().reverse().forEach(function (f) {
      const row = document.createElement("div");
      row.className = "fb-row" + (f.status === "done" ? " is-done" : "");

      const head = document.createElement("div");
      head.className = "fb-row-head";
      head.innerHTML =
        '<span class="fb-id">FB-' + f.n + "</span>" +
        '<span class="fb-kind-tag fb-kind-' + f.kind + '">' +
          (f.kind === "idea" ? "idea" : "bug") + "</span>" +
        ((f.shots || []).length
          ? '<span class="fb-shot-count">' + f.shots.length + " pic" +
            ((f.shots || []).length === 1 ? "" : "s") + "</span>" : "") +
        (f.sentAt ? "" : '<span class="fb-unsent" title="This note has not reached ' +
          'a file yet — press Send all again">not sent</span>');
      row.appendChild(head);

      const body = document.createElement("div");
      body.className = "fb-row-text";
      body.textContent = f.text || "(a screenshot with no words)";
      row.appendChild(body);

      const actions = document.createElement("div");
      actions.className = "fb-row-actions";

      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "fb-row-btn";
      tick.textContent = f.status === "done" ? "Reopen" : "Done";
      tick.title = f.status === "done"
        ? "Put this back on the open list"
        : "You have seen this fixed";
      tick.addEventListener("click", function () {
        setStatus(f.id, f.status === "done" ? "open" : "done");
      });
      actions.appendChild(tick);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "fb-row-btn fb-row-del";
      del.textContent = "Delete";
      del.title = "Remove this note. Its number is never given to another note.";
      del.addEventListener("click", function () { removeNote(f.id); });
      actions.appendChild(del);

      row.appendChild(actions);
      list.appendChild(row);
    });

    /*
     * Tell the stylesheet whether there is anything below the fold, so the
     * fade at the bottom of the list only appears when something is actually
     * cut off. Measured after the rows are in, because scrollHeight is
     * meaningless before that.
     */
    list.classList.toggle("is-scrollable", list.scrollHeight > list.clientHeight + 2);
  }

  /* The count on the button, so waiting notes are visible without opening it. */
  function renderCount() {
    const badge = el("feedback-count");
    if (!badge) return;
    const open = FolioStore.getFeedback().filter((f) => f.status !== "done").length;
    badge.textContent = String(open);
    badge.hidden = open === 0;
  }

  function notice(msg) {
    if (typeof TTS !== "undefined" && TTS.toast) TTS.toast(escapeHtml(String(msg)), 4200);
    else console.warn("[feedback]", msg);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ==========================================================================
  // INITIALIZATION — the button, the keys, and catching a pasted screenshot
  // ==========================================================================

  function init() {
    const box = el("feedback-box");
    if (!box) {
      console.warn("[feedback] no #feedback-box in this page; the widget is off");
      return;
    }

    el("feedback-launcher").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleCard();
    });
    el("feedback-close").addEventListener("click", closeCard);
    el("feedback-send").addEventListener("click", submit);
    el("feedback-resend").addEventListener("click", resendAll);

    document.querySelectorAll(".fb-kind-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!draft) draft = { kind: "bug", text: "", shots: [] };
        draft.kind = b.dataset.kind === "idea" ? "idea" : "bug";
        drawKind();
      });
    });

    // Keep the draft in step with the textarea, so closing never loses words.
    const area = el("feedback-text");
    area.addEventListener("input", function () {
      if (!draft) draft = { kind: "bug", text: "", shots: [] };
      draft.text = area.value;
    });
    area.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
    });

    // The file picker, for a picture that is on disk rather than in the clipboard.
    const file = el("feedback-file");
    el("feedback-attach").addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      attach(Array.prototype.slice.call(file.files || []));
      file.value = "";   // so choosing the same file twice still fires
    });

    /*
     * Pasting INTO the card attaches the picture. The textarea is inside the
     * card, so this covers the ordinary case of typing and then pasting.
     */
    box.addEventListener("paste", function (e) {
      const pics = imagesFrom(e.clipboardData);
      if (!pics.length) return;        // a text paste belongs to the textarea
      e.preventDefault();
      attach(pics);
    });

    // Dropping a picture on the card attaches it too.
    box.addEventListener("dragover", function (e) {
      if (!cardOpen) return;
      e.preventDefault();
      box.classList.add("fb-drag");
    });
    box.addEventListener("dragleave", function () { box.classList.remove("fb-drag"); });
    box.addEventListener("drop", function (e) {
      if (!cardOpen) return;
      e.preventDefault();
      box.classList.remove("fb-drag");
      const pics = imagesFrom(e.dataTransfer);
      if (pics.length) attach(pics);
    });

    /*
     * THE SHORTCUT THAT MAKES THIS WORTH USING:
     * pasting a screenshot anywhere in Folio opens the card with the picture
     * already attached. So reporting something is: grab the screenshot, press
     * Cmd-V, type, press Cmd-Enter.
     *
     * Guarded to paste targets that are not text fields, matching the YouTube
     * paste handler in app.js — pasting into the editor or a search box must
     * still mean what it has always meant. Nothing is taken away here: none of
     * the Editor.js tools Folio loads accepts a pasted image, so outside a
     * text field an image paste did nothing at all before this.
     */
    document.addEventListener("paste", function (e) {
      if (cardOpen) return;            // the card's own handler has it
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const pics = imagesFrom(e.clipboardData);
      if (!pics.length) return;
      e.preventDefault();
      console.log("[feedback] a screenshot was pasted with the card shut — opening it");
      openCard(pics);
    });

    /*
     * Cmd+Shift+F opens the card. Escape closes it, and stops there rather
     * than bubbling, so one Escape does not also shut the comments panel
     * behind it.
     */
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openCard();
        return;
      }
      if (e.key === "Escape" && cardOpen) {
        e.stopPropagation();
        closeCard();
      }
    }, true);

    // Clicking away shuts the card, the way the settings panel behaves.
    document.addEventListener("click", function (e) {
      if (cardOpen && !box.contains(e.target)) closeCard();
    });

    renderCount();
    renderList();
    console.log("[feedback] ready — " + FolioStore.getFeedback().length +
                " note(s) stored, Cmd+Shift+F to write one");
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  return {
    init,
    openCard,
    closeCard,
    toggleCard,
    submit,
    resendAll,
    setStatus,
    removeNote,
    renderList,
    renderCount,
    // Exposed for the tests: the pure pieces, so they can be checked without
    // a real clipboard or a real download.
    buildBundle,
    pictureFromBlob,
    captureContext,
    _draft: function () { return draft; },
    _setDraft: function (d) { draft = d; },
    _isOpen: function () { return cardOpen; },
  };
})();

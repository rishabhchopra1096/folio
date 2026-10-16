/* ===========================================================================
 * PASTE THIS INTO THE CHROME CONSOLE ON THE FOLIO TAB THAT SAYS "Save failed"
 * ===========================================================================
 * To open the console: View > Developer > JavaScript Console, or Cmd+Option+J.
 * Click into the console, paste all of this, press Enter.
 *
 * IT WRITES NOTHING AND CHANGES NOTHING. It does two things:
 *   1. Downloads whatever the editor is holding in memory right now, so the
 *      work that failed to save is safe on disk before anything else.
 *   2. Prints what is actually filling up the browser's storage, which is
 *      what made the save fail in the first place.
 * =========================================================================== */
(async () => {
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };

  say("── 1. RESCUING WHAT THE EDITOR IS HOLDING ──");
  try {
    const inst = (typeof Editor !== "undefined") ? Editor.getInstance() : null;
    const docId = (typeof Editor !== "undefined") ? Editor.getCurrentDocId() : null;
    if (!inst) {
      say("   No editor open on this tab, so there is nothing in memory to rescue.");
      say("   If you still have the tab with the text, run this there instead.");
    } else {
      const data = await inst.save();
      const words = JSON.stringify(data.blocks || []).split(/\s+/).length;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "folio-rescue-" + (docId || "doc") + "-" +
                   new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      say("   SAVED to your Downloads: " + a.download);
      say("   " + (data.blocks || []).length + " blocks, roughly " + words + " words.");

      /* Is what is on disk different from what is in the editor? That is the
       * difference between "the save failed" and "the save was fine". */
      const stored = localStorage.getItem("folio_doc_" + docId);
      if (!stored) {
        say("   THE STORED COPY IS MISSING ENTIRELY — the rescue file is the only copy.");
      } else {
        const sb = (JSON.parse(stored).blocks || []).length;
        say("   On disk: " + sb + " blocks. In the editor: " + (data.blocks || []).length + ".");
        say(sb === (data.blocks || []).length
          ? "   Same length, so the save may have landed after all."
          : "   DIFFERENT — the editor is holding work that never reached disk.");
      }
    }
  } catch (e) {
    say("   Rescue failed: " + (e && e.message));
  }

  say("");
  say("── 2. WHAT IS FILLING THE STORAGE ──");
  let total = 0;
  const rows = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const n = ((localStorage.getItem(k) || "").length + k.length) * 2; // UTF-16
    total += n;
    rows.push([k, n]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  say("   TOTAL: " + (total / 1048576).toFixed(2) + " MB  (the browser's limit is about 5 MB)");

  /* Grouped, because 50 documents individually tell you nothing. */
  const groups = {};
  rows.forEach(([k, n]) => {
    const g = k.startsWith("folio_doc_") ? "documents (content)"
            : k.startsWith("folio_comments_") ? "comments"
            : k.startsWith("folio_highlights_") ? "highlights"
            : k.startsWith("folio_reads_") ? "reads"
            : k === "folio_feedback" ? "FEEDBACK (screenshots live here)"
            : k.startsWith("folio_") ? "other folio"
            : "not folio";
    groups[g] = (groups[g] || 0) + n;
  });
  Object.entries(groups).sort((a, b) => b[1] - a[1]).forEach(([g, n]) => {
    say("   " + (n / 1048576).toFixed(2) + " MB  " + g);
  });

  say("");
  say("   The ten biggest single items:");
  rows.slice(0, 10).forEach(([k, n]) => say("   " + (n / 1024).toFixed(0) + " KB  " + k));

  say("");
  say("── 3. CAN IT WRITE AT ALL RIGHT NOW? ──");
  try {
    localStorage.setItem("__folio_probe__", "x".repeat(50000));
    localStorage.removeItem("__folio_probe__");
    say("   Yes — a 50 KB test write succeeded, so the storage is not full this second.");
  } catch (e) {
    say("   NO — a 50 KB test write threw " + (e && e.name) +
        ". The storage is full. This is why saving fails.");
  }

  console.log("\n\n===== COPY EVERYTHING BELOW THIS LINE AND SEND IT TO CLAUDE =====\n");
  console.log(out.join("\n"));
  console.log("\n===== END =====");
})();

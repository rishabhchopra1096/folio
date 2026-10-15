#!/usr/bin/env node
/*
 * =============================================================================
 * FEEDBACK-INBOX.JS — file the notes written in Folio into docs/feedback/
 * =============================================================================
 * FILE OVERVIEW:
 * This is the other half of the feedback box. The box (js/feedback.js) writes a
 * JSON bundle into the Downloads folder every time a note is saved. This reads
 * those bundles and turns them into the two things the feedback pipeline needs:
 * a bible of every issue, and the screenshots on disk beside it.
 *
 * RUN IT when the user says "fix what I asked for":
 *   node tools/feedback-inbox.js            # file anything new
 *   node tools/feedback-inbox.js --list     # show what is open, change nothing
 *   node tools/feedback-inbox.js --dir <d>  # look somewhere other than Downloads
 *   node tools/feedback-inbox.js --flow <d> # write somewhere else (tests only)
 *
 * WHY IT READS EVERY BUNDLE AND NOT JUST THE NEWEST:
 * Each bundle contains every note, but it carries the BYTES of a screenshot
 * only for the notes that had not been sent yet at that moment — the box drops
 * those bytes straight afterwards so that screenshots cannot eat the browser
 * storage the documents live in. So the newest bundle has all the words and
 * only the newest pictures. Reading them all, and taking each picture from
 * whichever bundle still has it, is what makes the set complete.
 *
 * HOW IT WORKS — the components:
 *   1. findBundles   — every folio-feedback-*.json in the folder, oldest first
 *   2. mergeItems    — one record per note: newest words, any picture found
 *   3. writeImages   — decode each picture to docs/feedback/folio/images/
 *   4. writeBible    — the issue table, the user's words kept verbatim
 *   5. ledger        — remember what has been filed, so re-running is safe
 *
 * THE FLOW:
 * Read the ledger. Read every bundle. Merge. For each note not already in the
 * ledger, write its pictures and append a row to the bible. Save the ledger.
 * Print the counts out loud, because a silent run is indistinguishable from a
 * broken one.
 * =============================================================================
 */

// =============================================================================
// IMPORTS — what this script needs from Node
// =============================================================================
// Reading and writing the bundles, the bible and the images.
const fs = require("fs");
// Joining paths without guessing at slashes.
const path = require("path");
// Finding the home directory, so "~/Downloads" does not have to be hardcoded.
const os = require("os");

// =============================================================================
// CONFIGURATION — where things live
// =============================================================================
// The repository root, which is the folder above this script's own folder.
const REPO = path.resolve(__dirname, "..");
/*
 * One home per flow, as the feedback pipeline requires.
 *
 * `--flow <dir>` redirects it, which exists so the test suite can run the real
 * tool without writing into the real bible. A test that needed a stand-in
 * version of this file would be testing the stand-in.
 */
const argFlow = process.argv.indexOf("--flow");
const FLOW = argFlow !== -1 && process.argv[argFlow + 1]
  ? path.resolve(process.argv[argFlow + 1])
  : path.join(REPO, "docs", "feedback", "folio");
const IMAGES = path.join(FLOW, "images");
const BIBLE = path.join(FLOW, "BIBLE.md");
// What has already been filed. Hidden, because it is bookkeeping, not content.
const LEDGER = path.join(FLOW, ".ingested.json");

// Where the browser puts its downloads, overridable with --dir for testing.
const argDir = process.argv.indexOf("--dir");
const DOWNLOADS = argDir !== -1 && process.argv[argDir + 1]
  ? path.resolve(process.argv[argDir + 1])
  : path.join(os.homedir(), "Downloads");

const LIST_ONLY = process.argv.includes("--list");

// =============================================================================
// THE LEDGER — what has already been filed
// =============================================================================
/*
 * WHAT THIS DOES:
 * Reads the record of which notes have already been written into the bible.
 *
 * WHY WE NEED IT:
 * The bundles stay in Downloads after being read, so every run sees every note
 * again. Without a ledger, running this twice would append every row twice —
 * and the whole purpose of the bible is that an issue appears in it once,
 * under one permanent id.
 */
function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  } catch {
    return { filed: {}, bundles: [] };
  }
}

function writeLedger(ledger) {
  fs.mkdirSync(FLOW, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
}

// =============================================================================
// READING THE BUNDLES
// =============================================================================
/*
 * Every bundle in the folder, oldest first.
 *
 * Sorted by the timestamp in the NAME rather than by the file's modified time,
 * because a copied or restored file carries a new mtime and would then be
 * treated as the newest thing we know, overwriting later words with older ones.
 * The name is what the box actually recorded.
 */
function findBundles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    console.error(`[inbox] cannot read ${dir}: ${err.message}`);
    return [];
  }
  return names
    .filter((n) => /^folio-feedback-.*\.json$/.test(n))
    .sort()
    .map((n) => {
      const full = path.join(dir, n);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        if (data && data.kind === "folio-feedback" && Array.isArray(data.items)) {
          return { name: n, path: full, data };
        }
        /*
         * Deliberately console.log and not console.warn. A skipped bundle is
         * part of the report: "0 new notes filed" reads as nothing-to-do, and
         * reads completely differently once you know a file was skipped. Put
         * on stderr it can be captured separately from the counts and lost,
         * which is how a thin report gets mistaken for a clean one.
         */
        console.log(`[inbox] ${n} is not a Folio feedback bundle — skipped`);
      } catch (err) {
        console.log(`[inbox] ${n} would not parse (${err.message}) — skipped`);
      }
      return null;
    })
    .filter(Boolean);
}

/*
 * WHAT THIS DOES:
 * Collapses every bundle into one record per note.
 *
 * HOW IT WORKS:
 * Walking oldest to newest, each note overwrites the previous version of
 * itself — so the words and the status come from the most recent bundle that
 * mentioned it. Pictures are the exception: a picture is kept as soon as a
 * bundle is found that still carries its bytes, and a later bundle saying
 * `bytes: null` never erases it. That is the whole reason this reads more than
 * one file.
 */
function mergeItems(bundles) {
  const byId = new Map();

  bundles.forEach((b) => {
    b.data.items.forEach((item) => {
      if (!item || !item.id) return;
      const existing = byId.get(item.id);
      const merged = Object.assign({}, existing || {}, item, {
        _bundle: b.name,
      });

      // Keep whichever version of each picture actually has its bytes.
      const oldShots = (existing && existing.shots) || [];
      const newShots = item.shots || [];
      merged.shots = newShots.map((s, i) => {
        if (s && s.bytes) return s;
        const old = oldShots[i];
        return old && old.bytes ? old : s;
      });

      byId.set(item.id, merged);
    });
  });

  // Oldest note first, so ids read in the order they were written.
  return [...byId.values()].sort(
    (a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
}

// =============================================================================
// WRITING THE IMAGES
// =============================================================================
/*
 * Decode a note's pictures onto disk and return their repository-relative paths.
 *
 * Named after the note so that a path tells a reader which issue it belongs to
 * without opening it — `FB-3_1.png`, not `IMG_7513.PNG`, which the feedback
 * pipeline names explicitly as the thing not to do.
 */
function writeImages(label, note) {
  const out = [];
  (note.shots || []).forEach((s, i) => {
    if (!s || !s.bytes) {
      // A picture whose bytes were never captured in any bundle. Say so in the
      // bible rather than pretending the note had no picture.
      out.push(null);
      return;
    }
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(s.bytes);
    if (!m) {
      console.log(`[inbox] ${label} picture ${i + 1} is not a data URL — skipped`);
      out.push(null);
      return;
    }
    const ext = m[1] === "image/jpeg" ? "jpg" : m[1] === "image/png" ? "png"
              : m[1].split("/")[1].replace("+xml", "");
    const file = `${label}_${i + 1}.${ext}`;
    fs.mkdirSync(IMAGES, { recursive: true });
    fs.writeFileSync(path.join(IMAGES, file), Buffer.from(m[2], "base64"));
    out.push(path.posix.join("images", file));
  });
  return out;
}

// =============================================================================
// WRITING THE BIBLE
// =============================================================================
/*
 * The bible's header, written once. Everything after the table marker is rows.
 */
const BIBLE_HEADER = `# Folio feedback — the bible

Every note written in the feedback box at the bottom left of Folio, filed here by
\`node tools/feedback-inbox.js\`. **The words in the "What he said" column are
verbatim and must never be paraphrased or merged** — they are the record; any
summary of them is not.

**Status means six things.** OPEN is untouched. DOING is being worked on. BUILT
means the code changed and was verified as far as it can be here, and he has NOT
seen it. ASSUMED means it was changed but could not be verified at all, and is
never counted as progress. DECIDE means it needs a decision from him. DONE is
only ever set by him, having looked at it.

Ids come from the box itself, so the id in this table is the id he saw in Folio
and can quote back. **Ids are never reused and never renumbered** — a gap in the
numbers means a note was deleted, not that something is missing here.

| id | kind | status | when | where | What he said (verbatim) | screenshots | assessment |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;

/*
 * Turn one note into one table row.
 *
 * Newlines become <br> because a markdown table row cannot contain a real line
 * break — and the alternative, joining the lines with a space, would silently
 * reshape his words, which this column exists to preserve exactly.
 */
function bibleRow(label, note, imagePaths) {
  const cell = (s) => String(s == null ? "" : s)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");

  const when = (note.createdAt || "").slice(0, 16).replace("T", " ");
  const ctx = note.context || {};
  const where = [
    ctx.docTitle ? `"${ctx.docTitle}"` : null,
    ctx.mode,
    ctx.readLabel,
    ctx.theme && ctx.theme !== "default" ? ctx.theme : null,
    ctx.app === "electron" ? "panel" : null,
  ].filter(Boolean).join(", ") || "—";

  const shots = imagePaths.length
    ? imagePaths.map((p, i) => p ? `[${i + 1}](${p})` : `${i + 1} (bytes lost)`).join(" ")
    : "—";

  return `| ${label} | ${note.kind === "idea" ? "idea" : "bug"} | OPEN | ${when} | ` +
         `${cell(where)} | ${cell(note.text)} | ${shots} | |\n`;
}

// =============================================================================
// THE MAIN FLOW
// =============================================================================
function main() {
  const bundles = findBundles(DOWNLOADS);

  if (!bundles.length) {
    console.log(`[inbox] no feedback bundles in ${DOWNLOADS}`);
    console.log("[inbox] nothing to file. If notes were written, the box may not " +
                "have been able to download them — open it and press " +
                '"Send all again".');
    return;
  }

  const items = mergeItems(bundles);
  const ledger = readLedger();

  if (LIST_ONLY) {
    console.log(`[inbox] ${bundles.length} bundle(s), ${items.length} note(s) in ${DOWNLOADS}`);
    items.forEach((it) => {
      const filed = ledger.filed[it.id] ? "filed as " + ledger.filed[it.id] : "NOT FILED";
      const shots = (it.shots || []).length;
      console.log(`  FB-${it.n} [${it.kind}] ${it.status}  ${filed}` +
                  (shots ? `  ${shots} picture(s)` : "") +
                  `\n      ${String(it.text || "").split("\n")[0].slice(0, 90)}`);
    });
    return;
  }

  fs.mkdirSync(FLOW, { recursive: true });
  if (!fs.existsSync(BIBLE)) fs.writeFileSync(BIBLE, BIBLE_HEADER);

  let rows = "";
  let filedNow = 0;
  const used = new Set(Object.values(ledger.filed));

  items.forEach((note) => {
    if (ledger.filed[note.id]) return;        // already in the bible

    /*
     * The label he saw in Folio is "FB-<n>". Numbers come from a counter per
     * browser, so two origins — the live site and a localhost port are separate
     * Folios — can both hand out FB-4. If that happens the second one gets a
     * letter, and a line is printed, because an id that means two things is
     * worse than an id that does not match what he saw.
     */
    let label = `FB-${note.n}`;
    if (used.has(label)) {
      let suffix = "b";
      while (used.has(`${label}${suffix}`)) suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
      console.log(`[inbox] FB-${note.n} already belongs to another note ` +
                  `(different browser or origin) — filing this one as ${label}${suffix}`);
      label = `${label}${suffix}`;
    }
    used.add(label);

    const imagePaths = writeImages(label, note);
    rows += bibleRow(label, note, imagePaths);
    ledger.filed[note.id] = label;
    filedNow++;

    console.log(`[inbox] filed ${label} (${note.kind}) with ` +
                `${imagePaths.filter(Boolean).length} picture(s)`);
  });

  if (rows) fs.appendFileSync(BIBLE, rows);

  bundles.forEach((b) => {
    if (!ledger.bundles.includes(b.name)) ledger.bundles.push(b.name);
  });
  writeLedger(ledger);

  // Counts out loud. A total of "done" that nobody can check is how a round of
  // feedback came back unfixed once already.
  const open = items.filter((i) => i.status !== "done").length;
  console.log(`[inbox] ${filedNow} new note(s) filed into ${path.relative(REPO, BIBLE)}`);
  console.log(`[inbox] ${items.length} note(s) known in total, ${open} not marked done by him`);
  if (!filedNow) console.log("[inbox] everything in Downloads was already filed");
}

main();

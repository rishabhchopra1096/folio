/*
 * The reported trap: a transcript that stops at 11:49 on a longer video.
 * Past that point, FORWARD used to clamp to the last line and seek BACKWARD,
 * making the rest of the video unreachable.
 */
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const src = fs.readFileSync(REPO+"/js/video.js","utf8");

// Mirror hopLine's decision rule exactly, driven by the same constants.
const RESTART = parseFloat(src.match(/RESTART_GRACE_SEC = ([\d.]+)/)[1]);
const OUTSIDE = parseFloat(src.match(/OUTSIDE_GRACE_SEC = ([\d.]+)/)[1]);

// Transcript stops at 709s (11:49); video runs to ~2700s.
const TIMES = [0, 120, 300, 480, 709];
const LAST = TIMES[TIMES.length-1];
function segmentAt(t){ let b=-1; for(let i=0;i<TIMES.length;i++){ if(TIMES[i]<=t) b=i; else break; } return b; }

function hop(t, dir) {
  if (!TIMES.length) return { nudge: dir<0?-10:10 };
  let i = segmentAt(t);
  const pastEnd = i >= TIMES.length-1 && t > LAST + OUTSIDE;
  if (pastEnd) return { nudge: dir<0?-10:10 };
  if (i < 0) { if (dir<0) return { nudge:-10 }; i = -1; }
  if (dir < 0) {
    i = (t - TIMES[i] > RESTART) ? i : i-1;
    if (i < 0) return { nudge:-10 };
  } else {
    i = i+1;
    if (i > TIMES.length-1) return { nudge:10 };
  }
  return { seek: TIMES[i] };
}

let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n+(x?"  → "+x:"")));};

console.log(`\ntranscript ends at ${LAST}s; outside grace = ${OUTSIDE}s\n`);

console.log("=== THE BUG: past the transcript, forward must not go backwards ===");
let r = hop(900, 1);          // 15:00, well past 11:49
ok("forward nudges instead of seeking back", r.nudge===10, JSON.stringify(r));
r = hop(900, -1);
ok("back nudges too", r.nudge===-10, JSON.stringify(r));
r = hop(2000, 1);
ok("far past the end still nudges", r.nudge===10, JSON.stringify(r));

console.log("\n=== it must never seek BACKWARD on a forward press ===");
let bad = [];
for (let t = 0; t <= 2400; t += 7) {
  const res = hop(t, 1);
  if (res.seek != null && res.seek < t - 0.001) bad.push({t, seek:res.seek});
}
ok("no forward press ever moves backwards", bad.length===0,
   JSON.stringify(bad.slice(0,4)));

console.log("\n=== inside the transcript, line hopping still works ===");
ok("mid-line back restarts the line", hop(400,-1).seek===300, JSON.stringify(hop(400,-1)));
ok("at a line start, back steps to previous", hop(300,-1).seek===120, JSON.stringify(hop(300,-1)));
ok("forward advances a line", hop(400,1).seek===480, JSON.stringify(hop(400,1)));
ok("forward from the second-last reaches the last", hop(500,1).seek===709, JSON.stringify(hop(500,1)));

console.log("\n=== just past the last line, still within grace, snaps back to it ===");
r = hop(LAST + 10, -1);
ok("back restarts the last line", r.seek===709, JSON.stringify(r));
r = hop(LAST + 10, 1);
ok("forward nudges (there is no next line)", r.nudge===10, JSON.stringify(r));

console.log("\n=== the source actually contains the guards ===");
ok("has an outside-the-transcript fallback", /pastEnd/.test(src));
ok("forward past the last line nudges", /if \(i > segTimes\.length - 1\) \{ nudge\(10\); return; \}/.test(src));
ok("back before the first line nudges", /if \(i < 0\) \{ nudge\(-10\); return; \}/.test(src));
ok("currentBlockEl returns null past the end", /return null;[\s\S]{0,80}return segEls\[activeIdx\]/.test(src));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

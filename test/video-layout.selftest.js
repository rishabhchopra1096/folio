/* The reading half has to be usable. Reported as: the line being spoken is cut
   off at the top, the last line disappears under the bottom edge, and there is
   a large empty band below the transcript that nothing uses. */
const fs = require("fs");
const REPO = "/Users/rishabhchopra/Documents/GitHub/folio";
const css = fs.readFileSync(REPO + "/css/highlights.css", "utf8");
const layout = fs.readFileSync(REPO + "/css/layout.css", "utf8");
const comp = fs.readFileSync(REPO + "/css/components.css", "utf8");
const vjs = fs.readFileSync(REPO + "/js/video.js", "utf8");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log("  ✓ " + n))
                            : (fail++, console.log("  ✗ " + n + (x ? "  → " + x : ""))); };
const num = (re, src) => { const m = src.match(re); return m ? parseFloat(m[1]) : NaN; };

console.log("\n=== the heights have to add up to the window, not more ===");
const topbar = num(/#topbar \{[\s\S]*?height: (\d+)px/, layout);
const wrapPad = (comp.match(/#article-wrap \{[\s\S]*?padding: ([^;]+);/) || [])[1];
ok("topbar is 48px", topbar === 48, String(topbar));
ok("the wrapper still carries a large bottom padding for normal docs",
   /120px/.test(wrapPad || ""), wrapPad);
ok("a video document drops that padding",
   /body\[data-video-doc\] #article-wrap \{\s*padding: 0;/.test(css));
ok("and claims exactly the space under the topbar",
   /height: calc\(100dvh - 48px\)/.test(css));
ok("the old arithmetic is gone", !/height: calc\(100vh - 96px\)/.test(css));

// Prove the sum: topbar + article height must not exceed the viewport.
const articleVh = num(/#article\[data-video-layout\][\s\S]*?height: calc\(100dvh - (\d+)px\)/, css);
ok("topbar + article == 100dvh exactly", topbar === articleVh,
   `topbar ${topbar} vs article offset ${articleVh}`);

console.log("\n=== both halves get usable room ===");
const videoVh = num(/--video-max-h: (\d+)vh/, css);
const minVh = num(/min-height: (\d+)vh/, css);
ok("the player is smaller than it was", videoVh <= 46, videoVh + "vh");
ok("the transcript has a floor", minVh >= 30, minVh + "vh");
ok("they fit together under 100vh with room for the control bar",
   videoVh + minVh <= 82, `${videoVh} + ${minVh} = ${videoVh + minVh}vh`);
ok("the control bar tracks the same width", new RegExp(`calc\\(${videoVh}vh \\* 16 / 9\\)`).test(css));

console.log("\n=== the empty band below the transcript is gone ===");
ok("no 40vh of dead padding", !/padding: 4px 4px 40vh/.test(css));
ok("bottom padding is modest now", /padding: 4px 4px 1\.5rem/.test(css));
ok("scroll-padding does that job instead", /scroll-padding-block/.test(css));

console.log("\n=== the flag that switches the layout is managed ===");
ok("set when the video layout is built", /document\.body\.dataset\.videoDoc = "1"/.test(vjs));
ok("and removed on teardown", /delete document\.body\.dataset\.videoDoc/.test(vjs));

console.log("\n=== the spoken line is actually brought into view ===");
/* The old test was "is it within 20%-80% of the box", which a paragraph taller
   than the box can never satisfy, and which counts a half-clipped line as fine. */
ok("a line must fit ENTIRELY in the comfortable zone",
   /er\.top >= topEdge && er\.bottom <= bottomEdge/.test(vjs));
ok("an over-tall paragraph is handled separately", /const fits = er\.height <= band \* 0\.7/.test(vjs));
ok("short lines are centred", /\(band - er\.height\) \/ 2/.test(vjs));
ok("and why the old band failed is recorded", /useless in a short one/.test(vjs));

// The comfort rule, exercised directly.
function comfortable(boxH, lineTop, lineH) {
  const br = { top: 0, height: boxH };
  const er = { top: lineTop, height: lineH, bottom: lineTop + lineH };
  const topEdge = br.top + boxH * 0.15, bottomEdge = br.top + boxH * 0.85;
  const fits = er.height <= boxH * 0.7;
  return fits ? (er.top >= topEdge && er.bottom <= bottomEdge)
              : (er.top >= topEdge && er.top <= br.top + boxH * 0.4);
}
ok("a line sitting at the very top is NOT comfortable", !comfortable(400, 2, 40));
ok("a line half under the bottom edge is NOT comfortable", !comfortable(400, 380, 40));
ok("a line in the middle is comfortable", comfortable(400, 180, 40));
ok("a paragraph taller than the box is accepted near the top",
   comfortable(400, 80, 500));
ok("but not when its top is already off-screen", !comfortable(400, -20, 500));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

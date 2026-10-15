#!/bin/bash
# Renders the feedback box in headless Chrome and saves a PNG we can look at.
#
# WHY THIS EXISTS: test/browser/feedback.probe.html proves the button is not
# under the sidebar's own buttons, that the card fits the window, and that a
# pasted screenshot is shrunk. None of that says whether the thing LOOKS right —
# whether the button is too loud for a reading app, whether the rows in the list
# are cramped, whether a 58px thumbnail reads as a picture or as a grey block.
# That needs eyes, so it needs an image.
#
# Usage: tools/shoot-feedback.sh [output.png] [?state=full&theme=dark]
set -e
cd "$(dirname "$0")/.."
OUT="${1:-docs/feedback-widget/images/feedback-closed.png}"
QUERY="${2:-}"
mkdir -p "$(dirname "$OUT")"

rm -rf /tmp/folio-fbshot
node test/browser/serve.js & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

# --virtual-time-budget lets the page's own timers finish — the iframe load, the
# staged paste, the card opening — before the shot is taken. Without it the
# screenshot lands on a blank frame.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --mute-audio \
  `# --hide-scrollbars keeps the window's own scrollbar out of the frame. It
   # also hides the notes list's scrollbar, which in the real app is the main
   # thing saying the list continues below the fold. A list that looks cut off
   # in these pictures is not necessarily cut off on screen.` \
  --hide-scrollbars \
  --user-data-dir=/tmp/folio-fbshot \
  --window-size=1180,800 \
  --virtual-time-budget=9000 \
  --screenshot="$OUT" \
  "http://localhost:8810/feedback.shot.html$QUERY" >/dev/null 2>&1 || true

# Never leave an image bigger than Claude Code will accept (2000px a side).
if command -v sips >/dev/null; then
  WIDTH=$(sips -g pixelWidth "$OUT" 2>/dev/null | awk '/pixelWidth/{print $2}')
  [ -n "$WIDTH" ] && [ "$WIDTH" -gt 1800 ] && sips --resampleWidth 1800 "$OUT" >/dev/null
fi
echo "wrote $OUT"

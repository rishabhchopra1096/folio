#!/bin/bash
# Renders the read-bar scene in headless Chrome and saves a PNG we can look at.
#
# WHY THIS EXISTS: the assertions in test/browser/reads.probe.html prove the bar
# says the right words and the chips carry the right colours. They cannot tell
# whether it LOOKS right — whether the chip collides with the buttons, whether
# the colour dot is visible against the strip, whether the bar reads as part of
# the panel or as a stray heading. That needs eyes, so it needs an image.
#
# Usage: tools/shoot-reads.sh [output.png]
set -e
cd "$(dirname "$0")/.."
OUT="${1:-docs/reads/images/read-bar.png}"
# Second argument is appended to the page URL. "?reads=4" stages enough reads
# that every chip and dot colour appears in one shot.
QUERY="${2:-}"
mkdir -p "$(dirname "$OUT")"

rm -rf /tmp/folio-readsshot
node test/browser/serve.js & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

# --virtual-time-budget lets the page's own timers (iframe load, the staged
# comments, opening the panel) finish before the shot is taken. Without it the
# screenshot lands on a blank frame.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --mute-audio \
  --hide-scrollbars \
  --user-data-dir=/tmp/folio-readsshot \
  --window-size=1280,860 \
  --virtual-time-budget=20000 \
  --screenshot="$OUT" \
  "http://localhost:8810/reads.shot.html$QUERY" >/dev/null 2>&1

echo "wrote $OUT"

#!/bin/bash
# Renders the Follow chip over the read-aloud player and saves a PNG.
#
# WHY THIS EXISTS: test/browser/scrollfollow.probe.html proves the chip appears
# on a wheel event, is clickable, and sits above the bar. It cannot say whether
# the pair LOOKS like one control surface — whether the chip is the right size
# next to the bar, whether "Follow" is the word that explains itself, whether
# the arrow reads as "back to the voice" or as "scroll down". That needs eyes.
#
# Usage: tools/shoot-follow.sh [output.png] [?theme=dark]
set -e
cd "$(dirname "$0")/.."
OUT="${1:-docs/reads/images/follow-chip.png}"
QUERY="${2:-}"
mkdir -p "$(dirname "$OUT")"

rm -rf /tmp/folio-followshot
node test/browser/serve.js & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --mute-audio \
  --hide-scrollbars \
  --user-data-dir=/tmp/folio-followshot \
  --window-size=1280,860 \
  --virtual-time-budget=20000 \
  --screenshot="$OUT" \
  "http://localhost:8810/scrollfollow.shot.html$QUERY" >/dev/null 2>&1

echo "wrote $OUT"

#!/bin/bash
# Renders the drive screen at iPhone size in headless Chrome and saves a PNG.
#
# WHY THIS EXISTS: test/browser/drive.probe.html proves the controls work. It
# cannot say whether the record button reads as the obvious thing to press,
# whether the transport row sits where a thumb lands, or whether the status line
# can be taken in at a glance from behind a steering wheel. That needs eyes.
#
# Usage: tools/shoot-drive.sh [out.png] ["?state=player&theme=dark"]
#        states: picker | player | recording | pending
set -e
cd "$(dirname "$0")/.."
OUT="${1:-docs/drive-mode/images/player.png}"
QUERY="${2:-}"
mkdir -p "$(dirname "$OUT")"

PROFILE="$(mktemp -d -t foliodriveshot)"
node test/browser/serve.js & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$PROFILE"' EXIT
sleep 1

# The window is the phone: 393x852 is an iPhone 15/16 in points, which is what
# the CSS is written against. Screenshotting at any other size would be a
# picture of a layout he will never see.
#
# --virtual-time-budget lets the page's own timers finish — the iframe load, the
# fake chunks arriving, the record button being held — before the shot is taken.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --mute-audio \
  --autoplay-policy=no-user-gesture-required \
  --hide-scrollbars \
  --force-device-scale-factor=2 \
  --user-data-dir="$PROFILE" \
  --window-size=393,852 \
  --virtual-time-budget=30000 \
  --screenshot="$OUT" \
  "http://localhost:8810/drive.shot.html$QUERY" >/dev/null 2>&1 || true

# Never leave an image bigger than Claude Code will accept (2000px a side).
if command -v sips >/dev/null; then
  W=$(sips -g pixelWidth "$OUT" 2>/dev/null | awk '/pixelWidth/{print $2}')
  H=$(sips -g pixelHeight "$OUT" 2>/dev/null | awk '/pixelHeight/{print $2}')
  if [ -n "$H" ] && [ "$H" -gt 1800 ]; then sips --resampleHeight 1800 "$OUT" >/dev/null; fi
  if [ -n "$W" ] && [ "$W" -gt 1800 ]; then sips --resampleWidth 1800 "$OUT" >/dev/null; fi
fi
echo "wrote $OUT"

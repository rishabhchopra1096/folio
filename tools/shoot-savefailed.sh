#!/bin/bash
# Photographs the save-failed banner so it can be LOOKED AT rather than
# reasoned about.
#
# WHY: test/browser/storagefull.probe.html proves the banner exists, spans the
# window, names the numbers and says what to do. None of that says whether it
# reads as alarming without being frightening, whether it is legible on the
# dark theme he actually uses, or whether the writing behind it still looks
# safe. That needs eyes, so it needs an image.
set -e
cd "$(dirname "$0")/.."
OUT="docs/bugs/images"
mkdir -p "$OUT"

node test/browser/serve.js & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1

shoot () {
  local name="$1" query="$2"
  # A FRESH PROFILE PER SHOT. Sharing one meant the previous shot's
  # localStorage — including a megabyte of deliberate ballast — was still
  # there when the next page loaded, so the second image staged a state
  # nobody asked for.
  rm -rf "/tmp/folio-sfshot-$name"
  # --virtual-time-budget lets the page's own timers finish (the iframe load,
  # the fill, the click) before the shot is taken. Without it the screenshot
  # lands on a blank frame, which is exactly what the first attempt produced.
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --no-first-run --mute-audio \
    --hide-scrollbars \
    --user-data-dir="/tmp/folio-sfshot-$name" \
    --window-size=1180,820 \
    --virtual-time-budget=12000 \
    --screenshot="$OUT/$name" \
    "http://localhost:8810/savefailed.shot.html$query" >/dev/null 2>&1 || true
  echo "  wrote $OUT/$name"
}

shoot "savefailed-01-light.png" ""
shoot "savefailed-02-dark.png" "?theme=dark"

# Never leave an image bigger than Claude Code will accept (2000px a side).
if command -v sips >/dev/null; then
  for f in "$OUT"/savefailed-*.png; do
    W=$(sips -g pixelWidth "$f" 2>/dev/null | awk '/pixelWidth/{print $2}')
    [ -n "$W" ] && [ "$W" -gt 1800 ] && sips --resampleWidth 1800 "$f" >/dev/null
  done
fi

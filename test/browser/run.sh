#!/bin/bash
# Drives the real app in headless Chrome and asserts on the resulting DOM.
# Every bug that reached production today survived a green jsdom suite; this is
# the layer that would have caught them.
cd "$(dirname "$0")"
rm -f out.log
node serve.js & SRV=$!
sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-first-run --mute-audio --autoplay-policy=no-user-gesture-required \
  --user-data-dir=/tmp/folio-browsertest-run http://localhost:8810/probe.html >/dev/null 2>&1 & CHR=$!
for i in $(seq 1 40); do grep -q DONE out.log 2>/dev/null && break; sleep 2; done
kill $CHR 2>/dev/null; kill $SRV 2>/dev/null
grep -v DONE out.log
P=$(grep -c '^PASS' out.log); F=$(grep -c '^FAIL' out.log)
echo "---"; echo "$P passed, $F failed"
[ "$F" -eq 0 ]

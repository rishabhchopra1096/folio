#!/bin/bash
# Breaks one thing in js/drive.js on purpose, runs the drive probe, and puts the
# file back — then proves it put it back.
#
# WHY THIS IS A SCRIPT AND NOT THREE COMMANDS: the first attempt at this was a
# one-liner with `cd test/browser && ... ; cd ..`, and the restoring `cp` ran
# from the wrong directory and silently failed. js/drive.js sat mutated in the
# working tree. Restoring is the step that must not be left to a shell's idea
# of where it is.
#
# Usage: tools/mutate-drive.sh "<python old string>" "<python new string>" "<label>"
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
BAK="$(mktemp -t drivebak)"
cp "$REPO/js/drive.js" "$BAK"
# Always restore, however this exits — including a failed probe or a Ctrl-C.
trap 'cp "$BAK" "$REPO/js/drive.js"; rm -f "$BAK"' EXIT

OLD="$1"; NEW="$2"; LABEL="${3:-mutation}"
echo "── $LABEL ──"

OLD="$OLD" NEW="$NEW" python3 - <<'PY'
import io, os
p = "js/drive.js"
s = io.open(p, encoding="utf-8").read()
old, new = os.environ["OLD"], os.environ["NEW"]
n = s.count(old)
assert n == 1, "the text to break appears %d times, not once — the mutation would be ambiguous" % n
io.open(p, "w", encoding="utf-8").write(s.replace(old, new))
PY
# PROVE the break landed. A mutation run that changed nothing is not evidence.
grep -q "MUTATION" "$REPO/js/drive.js" || { echo "the mutation did not land"; exit 2; }
echo "break landed."

( cd "$REPO/test/browser" && bash run.sh drive 2>&1 | grep -E "^FAIL|passed," ) || true

cp "$BAK" "$REPO/js/drive.js"
if grep -q "MUTATION" "$REPO/js/drive.js"; then echo "RESTORE FAILED"; exit 2; fi
echo "restored clean."

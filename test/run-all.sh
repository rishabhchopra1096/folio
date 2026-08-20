#!/bin/bash
# Runs every suite and REFUSES to report success for a suite that didn't run.
#
# Why this exists: `for f in test/*.selftest.js; do node "$f"; done` looks green
# when jsdom is missing, because a suite that dies on `Cannot find module` prints
# no failures. 18 of 22 suites silently no-opped that way and the run still
# looked clean. A suite that produced no tally is now a hard failure.
cd "$(dirname "$0")/.."

# jsdom isn't a project dependency (Folio ships zero), so find it wherever it is.
if [ -z "$NODE_PATH" ]; then
  for d in /private/tmp/claude-501/*/*/scratchpad/node_modules ./node_modules; do
    [ -d "$d/jsdom" ] && export NODE_PATH="$d" && break
  done
fi
[ -d "$NODE_PATH/jsdom" ] || { echo "jsdom not found — set NODE_PATH to a dir containing it"; exit 2; }

pass=0; fail=0; ran=0; problems=""
for f in test/*.selftest.js; do
  out=$(node "$f" 2>&1)
  if ! echo "$out" | grep -qE "passed, [0-9]+ failed"; then
    problems="$problems\n  DID NOT RUN  $(basename "$f")  → $(echo "$out" | tail -1 | cut -c1-70)"
    continue
  fi
  ran=$((ran + 1))
  p=$(echo "$out" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '[0-9]+')
  f2=$(echo "$out" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '[0-9]+')
  pass=$((pass + p)); fail=$((fail + f2))
  [ "$f2" != "0" ] && problems="$problems\n  FAILED       $(basename "$f")  ($f2)"
done

total=$(ls test/*.selftest.js | wc -l | tr -d ' ')
echo "ran $ran/$total suites — $pass assertions passed, $fail failed"
[ -n "$problems" ] && { echo -e "$problems"; exit 1; }
[ "$ran" -eq "$total" ] || exit 1
echo "all green"

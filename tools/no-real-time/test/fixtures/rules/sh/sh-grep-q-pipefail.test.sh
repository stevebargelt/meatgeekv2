#!/usr/bin/env bash
set -euo pipefail
if printf '%s\n' "$out" | grep -q 'ready'; then ok; fi # expect: sh-grep-q-pipefail
producer | cut -f1 | grep -Eqx 'main' && ok # expect: sh-grep-q-pipefail
cat "$log" | grep --quiet error || ok # expect: sh-grep-q-pipefail
gh api repos | egrep -qi 'HTTP 404' # expect: sh-grep-q-pipefail
# The reads-all-its-input forms: not hits.
if grep -q 'ready' <<<"$out"; then ok; fi
if grep -q 'ready' "$file"; then ok; fi
printf '%s\n' "$out" | grep -c 'ready' >/dev/null
check || grep -q 'ready' "$file"

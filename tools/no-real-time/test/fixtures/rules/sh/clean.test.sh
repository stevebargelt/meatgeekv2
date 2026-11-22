#!/usr/bin/env bash
# A clean shell test: it waits on the child's own readiness line over a FIFO,
# then on the child itself. Nothing here is a hit.
set -euo pipefail
fifo="$(mktemp -u)"
mkfifo "$fifo"
./child.sh "$fifo" &
pid=$!
read -r line < "$fifo"
[ "$line" = ready ] || exit 1
kill -TERM "$pid"
wait "$pid" || true
matches() { grep -q "$1" <<<"$2"; }
matches 'ready' "$line"

#!/usr/bin/env bash
set -u
started=$(date +%s) # expect: sh-wall-clock
SECONDS=0
run_case
if [ "$(( $(date -u +%s) - started ))" -gt 5 ]; then echo slow; fi # expect: sh-wall-clock
echo "took $SECONDS s" # expect: sh-wall-clock
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) # a timestamp for a log line, not arithmetic: not a hit

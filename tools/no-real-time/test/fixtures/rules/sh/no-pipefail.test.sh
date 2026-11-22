#!/usr/bin/env bash
# Without pipefail, grep's own status is the pipeline's: not a hit.
set -eu
if printf '%s\n' "$out" | grep -q 'ready'; then echo ok; fi

#!/usr/bin/env bash
# HAR-176 — build simdevice (apps/data-pusher) for the live proofs, from the
# Go module cache that ci.yml's `build-go (data-pusher)` job saved on main.
#
# Run from the repository root, after an actions/cache/restore step for that
# cache. Environment:
#   GO_MODULE_CACHE_HIT  'true' when the restore step matched the key exactly
#                        (its `cache-hit` output); anything else is a miss.
#   GO_MODULE_CACHE_KEY  the key the restore step looked for (for the log).
#
# Hit:  the build runs with GOPROXY=off, so Go cannot contact the module proxy:
#       it either builds from the restored cache or fails at once. A failure
#       there means the cache lacks a module (it should not; see ci.yml's
#       build-go), so the script says so as a warning and builds once more
#       with the proxy, which is what every build did before HAR-176.
# Miss: the build downloads from the module proxy and says so as a notice.
#       Go logs one `go: downloading <module>` line per module it fetches.
#       (A hit whose offline build fails logs them too, before the warning.)
set -euo pipefail

key="${GO_MODULE_CACHE_KEY:-<unset>}"

if [ "${GO_MODULE_CACHE_HIT:-}" = "true" ]; then
  echo "Go module cache hit ($key): building simdevice with GOPROXY=off, no module download."
  if GOPROXY=off make -C apps/data-pusher build; then
    test -x apps/data-pusher/dist/simdevice
    echo "simdevice built from the Go module cache; no module was downloaded."
    exit 0
  fi
  echo "::warning title=Go module cache incomplete::The restored cache ($key) could not build simdevice with GOPROXY=off (output above). Building again with the module proxy."
else
  # The message avoids Go's own download wording, so a search of the log for
  # it finds only Go's lines.
  echo "::notice title=Go module cache miss::No Go module cache '$key' on main. Fetching simdevice's modules from the module proxy; Go logs each module it fetches below."
fi

make -C apps/data-pusher build
test -x apps/data-pusher/dist/simdevice
echo "simdevice built; modules not in the cache were downloaded from the module proxy."

#!/usr/bin/env bash
# HAR-113 — the Cosmos emulator service container, as ci.yml's
# api-cosmos-emulator job and test-repeat.yml's repeat-emulator job use it. One
# script so the two jobs wait, measure and diagnose the emulator the same way.
#
#   cosmos-emulator.sh wait <container-id> <cert-file>
#       Bounded (300 s) wait for the emulator's final `Started` log line and for
#       its certificate to download into <cert-file>. Reports the start-up time
#       (container start -> `Started` line, from docker's own log timestamps)
#       with the partition count, as a notice and in the job summary.
#
#   cosmos-emulator.sh sample <container-id> <file>
#       Every 10 s until killed, appends one timestamped `docker stats` line
#       (CPU, memory, PIDs, network) for the container to <file>. Run it in the
#       background around the test step; it is a record, never a gate.
#
#   cosmos-emulator.sh diagnose <container-id> <dir>
#       For a failed step: writes the container's state (exit code, OOMKilled,
#       finish time), its full log and a stats snapshot to <dir>, copies the
#       emulator's own log directory (/tmp/cosmos/appdata/log, where it writes
#       crash reports) out of the container, and prints the state and the log
#       tail. Never fails the job itself.
set -uo pipefail

cmd=${1:-}
id=${2:-}
out=${3:-}
if [ -z "$cmd" ] || [ -z "$id" ] || [ -z "$out" ]; then
  echo "usage: $0 wait|sample|diagnose <container-id> <file-or-dir>" >&2
  exit 2
fi

partitions() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null |
    sed -n 's/^AZURE_COSMOS_EMULATOR_PARTITION_COUNT=//p'
}

case "$cmd" in
  wait)
    # shellcheck disable=SC2016 # expanded by the inner bash, from its arguments
    if ! timeout 300 bash -c '
      until docker logs "$1" 2>&1 | tr -d "\r" | grep -qx "Started"; do sleep 5; done
      until curl -skf https://localhost:8081/_explorer/emulator.pem -o "$2"; do sleep 5; done
    ' _ "$id" "$out"; then
      echo "::error::Cosmos emulator not ready within 300s"
      docker logs --tail 50 "$id" 2>&1 || true
      exit 1
    fi
    started_at=$(docker inspect -f '{{.State.StartedAt}}' "$id")
    ready_at=$(docker logs -t "$id" 2>&1 | tr -d '\r' | awk '$2 == "Started" && NF == 2 { print $1; exit }')
    seconds=$(($(date -d "$ready_at" +%s) - $(date -d "$started_at" +%s)))
    line="Cosmos emulator started in ${seconds}s (AZURE_COSMOS_EMULATOR_PARTITION_COUNT=$(partitions); container start $started_at, \`Started\` at $ready_at)"
    echo "::notice title=Cosmos emulator start-up::$line"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$line" >> "$GITHUB_STEP_SUMMARY"
    exit 0
    ;;

  sample)
    mkdir -p "$(dirname "$out")"
    while :; do
      stats=$(docker stats --no-stream --format \
        'cpu={{.CPUPerc}} mem={{.MemUsage}} mem%={{.MemPerc}} pids={{.PIDs}} net={{.NetIO}}' \
        "$id" 2>&1)
      echo "$(date -u +%FT%TZ) $stats" >> "$out"
      sleep 10
    done
    ;;

  diagnose)
    mkdir -p "$out"
    docker inspect -f '{{json .State}}' "$id" > "$out/state.json" 2>&1
    docker logs -t "$id" > "$out/container.log" 2>&1
    docker stats --no-stream "$id" > "$out/stats-at-failure.txt" 2>&1
    # The emulator writes its crash reports (and core dumps) here. docker cp
    # works on a stopped container too.
    docker cp "$id:/tmp/cosmos/appdata/log" "$out/appdata-log" > /dev/null 2>&1 ||
      echo "no /tmp/cosmos/appdata/log in the container" > "$out/appdata-log.missing"
    echo "----- Cosmos emulator state -----"
    cat "$out/state.json"
    echo
    echo "----- Cosmos emulator log (last 120 lines; full log in the artifact) -----"
    tail -n 120 "$out/container.log"
    echo "----- end of Cosmos emulator log -----"
    exit 0
    ;;

  *)
    echo "unknown command: $cmd" >&2
    exit 2
    ;;
esac

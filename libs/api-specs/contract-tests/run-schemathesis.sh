#!/usr/bin/env bash
# run-schemathesis.sh — drive the Schemathesis fuzzer against the local mock
# API server. See contract-tests/README.md for the rationale.
#
# Prerequisite: the mock server must be running on port 4010, e.g.
#   nx serve api-specs
#
# Usage:
#   bash libs/api-specs/contract-tests/run-schemathesis.sh
#   bash libs/api-specs/contract-tests/run-schemathesis.sh --workers=4
#   bash libs/api-specs/contract-tests/run-schemathesis.sh --hypothesis-max-examples=50
#
# Any flags after the script name are forwarded verbatim to schemathesis run.

set -euo pipefail

# Resolve the repository root from this script's location so the script works
# regardless of the caller's CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
SPEC_DIR="${REPO_ROOT}/libs/api-specs/spec"

if [[ ! -f "${SPEC_DIR}/openapi.yaml" ]]; then
  echo "run-schemathesis: cannot find openapi.yaml at ${SPEC_DIR}/openapi.yaml" >&2
  exit 1
fi

# host.docker.internal lets the container reach a server listening on the host's
# loopback interface. On Linux this requires --add-host=host.docker.internal:host-gateway;
# on Docker Desktop (macOS / Windows) it works out of the box.
BASE_URL="${BASE_URL:-http://host.docker.internal:4010}"
SCHEMATHESIS_IMAGE="${SCHEMATHESIS_IMAGE:-schemathesis/schemathesis:stable}"

echo "run-schemathesis: spec dir   = ${SPEC_DIR}"
echo "run-schemathesis: base url   = ${BASE_URL}"
echo "run-schemathesis: image      = ${SCHEMATHESIS_IMAGE}"
echo "run-schemathesis: extra args = $*"

# -c all runs every built-in Schemathesis check: status_code_conformance,
# content_type_conformance, response_schema_conformance,
# response_headers_conformance, not_a_server_error.
exec docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "${SPEC_DIR}:/spec:ro" \
  "${SCHEMATHESIS_IMAGE}" \
  run \
  --base-url="${BASE_URL}" \
  -c all \
  -v \
  /spec/openapi.yaml \
  "$@"

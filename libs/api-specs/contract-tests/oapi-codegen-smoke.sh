#!/usr/bin/env bash
# oapi-codegen-smoke.sh — run deepmap/oapi-codegen against the spec and emit
# Go source to /tmp/api.go. Documented smoke test for ticket #4's Go codegen
# path; not auto-invoked by nx test.
#
# Usage:
#   bash libs/api-specs/contract-tests/oapi-codegen-smoke.sh
#   OUTPUT=/tmp/custom.go bash libs/api-specs/contract-tests/oapi-codegen-smoke.sh
#
# Inspect the generated Go file for any of the failure modes documented in
# contract-tests/README.md (map[string]interface{}, missing enums, etc.).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
SPEC_PATH="libs/api-specs/spec/openapi.yaml"

if [[ ! -f "${REPO_ROOT}/${SPEC_PATH}" ]]; then
  echo "oapi-codegen-smoke: cannot find spec at ${REPO_ROOT}/${SPEC_PATH}" >&2
  exit 1
fi

OUTPUT="${OUTPUT:-/tmp/api.go}"
OAPI_CODEGEN_IMAGE="${OAPI_CODEGEN_IMAGE:-deepmap/oapi-codegen:latest}"
PACKAGE="${PACKAGE:-apispecs}"

echo "oapi-codegen-smoke: repo root = ${REPO_ROOT}"
echo "oapi-codegen-smoke: spec      = ${SPEC_PATH}"
echo "oapi-codegen-smoke: output    = ${OUTPUT}"
echo "oapi-codegen-smoke: image     = ${OAPI_CODEGEN_IMAGE}"
echo "oapi-codegen-smoke: package   = ${PACKAGE}"

docker run --rm \
  -v "${REPO_ROOT}:/work:ro" \
  "${OAPI_CODEGEN_IMAGE}" \
  -package="${PACKAGE}" \
  "/work/${SPEC_PATH}" \
  > "${OUTPUT}"

echo "oapi-codegen-smoke: wrote ${OUTPUT} ($(wc -l < "${OUTPUT}") lines)"
echo "oapi-codegen-smoke: inspect for map[string]interface{} or missing enums:"
echo "  grep -n 'map\\[string\\]interface{}' ${OUTPUT} || echo 'clean — no untyped maps'"

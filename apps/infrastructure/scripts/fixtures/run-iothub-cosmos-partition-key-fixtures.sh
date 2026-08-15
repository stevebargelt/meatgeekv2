#!/usr/bin/env bash
#
# run-iothub-cosmos-partition-key-fixtures.sh — mutation coverage for the MG-73
# IoT Hub Cosmos partition-identity contract in tf-static-checks.sh (check 20).
#
# Each case copies the Terraform inputs into an isolated tree, mutates one
# contract term, then runs the real credentialless checker. This proves the
# gate rejects missing endpoint attributes, endpoint/container drift, non-exact
# identity templates, and attempted payload references without Azure access.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA_SOURCE="$(cd "${HERE}/../.." && pwd)"
CHECKER="${INFRA_SOURCE}/scripts/tf-static-checks.sh"

[ -f "${CHECKER}" ] || { echo "run-iothub-cosmos-partition-key-fixtures: FATAL: checker not found: ${CHECKER}" >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "run-iothub-cosmos-partition-key-fixtures: FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "${WORK}"' EXIT HUP INT TERM
SOURCE_FILES="${WORK}/terraform-files"
find "${INFRA_SOURCE}" -type d \( -name '.terraform' -o -name '.nx' -o -name 'node_modules' -o -name '.git' \) -prune -o \
  -type f \( -name '*.tf' -o -name '*.tfvars' -o -name '*.hcl' \) -print | sort > "${SOURCE_FILES}" || exit 2

OUT="${WORK}/checker.out"
failures=0
checks=0

make_tree() {
  fixture_dir="$1"
  mkdir -p "${fixture_dir}" || return 1
  while IFS= read -r source_file; do
    relative_file="${source_file#${INFRA_SOURCE}/}"
    mkdir -p "${fixture_dir}/$(dirname "${relative_file}")" || return 1
    cp "${source_file}" "${fixture_dir}/${relative_file}" || return 1
  done < "${SOURCE_FILES}"
  cp "${INFRA_SOURCE}/.terraform.lock.hcl" "${fixture_dir}/.terraform.lock.hcl" || return 1
  cp "${INFRA_SOURCE}/README.md" "${fixture_dir}/README.md" || return 1
  cp -R "${INFRA_SOURCE}/bootstrap" "${fixture_dir}/bootstrap" || return 1
}

count_occurrences() {
  OLD_TEXT="$1" perl -0777 -ne '$count = () = /\Q$ENV{OLD_TEXT}\E/g; print $count' "$2"
}

replace_once() {
  target_file="$1"
  old_text="$2"
  new_text="$3"
  occurrences="$(count_occurrences "${old_text}" "${target_file}")"
  if [ "${occurrences}" != "1" ]; then
    echo "run-iothub-cosmos-partition-key-fixtures: FATAL: expected one mutation target in ${target_file}, found ${occurrences}" >&2
    return 1
  fi
  OLD_TEXT="${old_text}" NEW_TEXT="${new_text}" perl -0pi -e 's/\Q$ENV{OLD_TEXT}\E/$ENV{NEW_TEXT}/' "${target_file}"
}

mutate_case() {
  case_name="$1"
  iothub_file="$2/modules/iot-hub/main.tf"
  cosmos_file="$2/modules/cosmos-db/main.tf"
  case "${case_name}" in
    clean) ;;
    missing-name) replace_once "${iothub_file}" $'  partition_key_name     = "deviceId"\n' '' ;;
    missing-template) replace_once "${iothub_file}" $'  partition_key_template = "{deviceid}"\n' '' ;;
    endpoint-container-drift) replace_once "${iothub_file}" 'partition_key_name     = "deviceId"' 'partition_key_name     = "tenantId"' ;;
    literal-prefix) replace_once "${iothub_file}" 'partition_key_template = "{deviceid}"' 'partition_key_template = "dev-{deviceid}"' ;;
    wrong-token) replace_once "${iothub_file}" 'partition_key_template = "{deviceid}"' 'partition_key_template = "{iothub}"' ;;
    body-derived-template) replace_once "${iothub_file}" 'partition_key_template = "{deviceid}"' 'partition_key_template = "{Body.deviceId}"' ;;
    container-drift) replace_once "${cosmos_file}" 'partition_key_paths   = ["/deviceId"]' 'partition_key_paths   = ["/tenantId"]' ;;
    *) echo "run-iothub-cosmos-partition-key-fixtures: FATAL: unknown case ${case_name}" >&2; return 1 ;;
  esac
}

run_case() {
  case_name="$1"
  expected_text="$2"
  fixture_dir="${WORK}/${case_name}"
  checks=$((checks + 1))
  if ! make_tree "${fixture_dir}" || ! mutate_case "${case_name}" "${fixture_dir}"; then
    echo "  ✗ ${case_name}: fixture setup failed" >&2; failures=$((failures + 1)); return
  fi
  if bash "${CHECKER}" "${fixture_dir}" >"${OUT}" 2>&1; then result=0; else result=$?; fi
  if [ "${case_name}" = clean ]; then
    if [ "${result}" -eq 0 ] && grep -Fq "${expected_text}" "${OUT}"; then
      echo "  ✓ clean: passed with the endpoint/container partition contract"
    else
      echo "  ✗ clean: expected exit 0 and '${expected_text}', got exit ${result}" >&2; sed 's/^/      /' "${OUT}" >&2; failures=$((failures + 1))
    fi
  elif [ "${result}" -ne 0 ] && grep -Fq "${expected_text}" "${OUT}"; then
    echo "  ✓ ${case_name}: rejected with its distinguishing message"
  else
    echo "  ✗ ${case_name}: expected nonzero and '${expected_text}', got exit ${result}" >&2; sed 's/^/      /' "${OUT}" >&2; failures=$((failures + 1))
  fi
}

echo "run-iothub-cosmos-partition-key-fixtures: exercising ${CHECKER} with isolated INFRA_DIR copies"
run_case clean 'check 20: located 1/1 Cosmos endpoint and 1/1 temperatures container; endpoint partition key="deviceId", template="{deviceid}", container key=/deviceId'
run_case missing-name 'is missing partition_key_name'
run_case missing-template 'is missing partition_key_template'
run_case endpoint-container-drift 'partition_key_name "tenantId" does not match'
run_case literal-prefix 'partition_key_template must be exactly "{deviceid}"'
run_case wrong-token 'partition_key_template must be exactly "{deviceid}"'
run_case body-derived-template 'must not reference Body or a payload-derived value'
run_case container-drift 'partitions on /tenantId instead of the required /deviceId'

if [ "${checks}" -ne 8 ] || [ "${failures}" -ne 0 ]; then
  echo "run-iothub-cosmos-partition-key-fixtures: FAILED — ${failures} of ${checks} checks failed (expected 8 checks)." >&2
  exit 1
fi
echo "run-iothub-cosmos-partition-key-fixtures: all ${checks} mutation checks behaved as expected under ${BASH_VERSION}."

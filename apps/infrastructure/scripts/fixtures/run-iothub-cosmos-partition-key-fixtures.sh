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

# Count occurrences of a literal, but only inside ONE resource block selected by
# its full label (type + name). MG-53 added a second _shared container to the
# cosmos-db module whose partition_key_paths line is byte-identical to the source
# container's, so a whole-file literal now matches two places; scoping to the
# resource label keeps the mutation aimed at exactly the resource the case intends.
count_occurrences_in_resource() {
  RES_TYPE="$1" RES_NAME="$2" OLD_TEXT="$3" perl -0777 -ne '
    my $blk = "";
    if (/(resource\s+"\Q$ENV{RES_TYPE}\E"\s+"\Q$ENV{RES_NAME}\E"\s*\{.*?)(?=\nresource\s|\z)/s) { $blk = $1; }
    my $c = () = ($blk =~ /\Q$ENV{OLD_TEXT}\E/g);
    print $c;
  ' "$4"
}

# Replace exactly one literal, scoped to a single resource block chosen by label.
# The mutation is deterministic: a future resource that happens to share the same
# term cannot silently become the target, and a zero/multiple match in the
# addressed block is a loud fixture error rather than a misleading result.
replace_once_in_resource() {
  target_file="$1"
  resource_type="$2"
  resource_name="$3"
  old_text="$4"
  new_text="$5"
  occurrences="$(count_occurrences_in_resource "${resource_type}" "${resource_name}" "${old_text}" "${target_file}")"
  if [ "${occurrences}" != "1" ]; then
    echo "run-iothub-cosmos-partition-key-fixtures: FATAL: expected one mutation target in resource ${resource_type}.${resource_name} of ${target_file}, found ${occurrences}" >&2
    return 1
  fi
  # The block is anchored to this label's header, and the non-greedy .*? stops at
  # the FIRST occurrence of old_text after it — which the count above proved is
  # the only one in this block.
  RES_TYPE="${resource_type}" RES_NAME="${resource_name}" OLD_TEXT="${old_text}" NEW_TEXT="${new_text}" perl -0777 -i -pe '
    s/(resource\s+"\Q$ENV{RES_TYPE}\E"\s+"\Q$ENV{RES_NAME}\E"\s*\{.*?)\Q$ENV{OLD_TEXT}\E/"$1$ENV{NEW_TEXT}"/se;
  ' "${target_file}"
}

mutate_case() {
  case_name="$1"
  iothub_file="$2/modules/iot-hub/main.tf"
  cosmos_file="$2/modules/cosmos-db/main.tf"
  case "${case_name}" in
    clean) ;;
    # The six IoT Hub cases target the single cosmos endpoint by label. They match
    # once today, but a second azurerm_iothub_endpoint_cosmosdb_account would make a
    # whole-file replace ambiguous the same way MG-53's second container did to
    # container-drift below — scope every case so no future addition can silently
    # move the target.
    missing-name) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage $'  partition_key_name     = "deviceId"\n' '' ;;
    missing-template) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage $'  partition_key_template = "{deviceid}"\n' '' ;;
    endpoint-container-drift) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_name     = "deviceId"' 'partition_key_name     = "tenantId"' ;;
    literal-prefix) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_template = "{deviceid}"' 'partition_key_template = "dev-{deviceid}"' ;;
    wrong-token) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_template = "{deviceid}"' 'partition_key_template = "{iothub}"' ;;
    body-derived-template) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_template = "{deviceid}"' 'partition_key_template = "{Body.deviceId}"' ;;
    # check 20 is scoped to the SOURCE endpoint-to-container agreement, so this
    # mutates azurerm_cosmosdb_sql_container.temperatures explicitly. MG-53's
    # temperatures_shared carries the identical partition_key_paths line; a
    # whole-file match found 2 and aborted setup.
    container-drift) replace_once_in_resource "${cosmos_file}" azurerm_cosmosdb_sql_container temperatures 'partition_key_paths   = ["/deviceId"]' 'partition_key_paths   = ["/tenantId"]' ;;
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

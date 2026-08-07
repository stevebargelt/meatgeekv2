#!/usr/bin/env bash
#
# run-cross-module-propagation-fixtures.sh — repeatable mutation coverage for the
# MG-48 replacement-propagation checks in tf-static-checks.sh (checks 18 and 19).
#
# Every case copies only Terraform input files into a new temporary INFRA_DIR,
# mutates that copy, then invokes the real checker against it.  This is
# credentialless and never writes the checked-in infrastructure tree.
#
# Keep this runner Bash 3.2-compatible: macOS operators run the static checker
# with /bin/bash 3.2 while CI uses Bash 5.  In particular, do not use arrays,
# mapfile, or inline quoted awk patterns inside command substitutions.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA_SOURCE="$(cd "${HERE}/../.." && pwd)"
CHECKER="${INFRA_SOURCE}/scripts/tf-static-checks.sh"

[ -f "${CHECKER}" ] || { echo "run-cross-module-propagation-fixtures: FATAL: checker not found: ${CHECKER}" >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "run-cross-module-propagation-fixtures: FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "${WORK}"' EXIT HUP INT TERM
SOURCE_FILES="${WORK}/terraform-files"
find "${INFRA_SOURCE}" -type d \( -name '.terraform' -o -name '.nx' -o -name 'node_modules' -o -name '.git' \) -prune -o \
  -type f \( -name '*.tf' -o -name '*.tfvars' -o -name '*.hcl' \) -print | sort > "${SOURCE_FILES}" || {
  echo "run-cross-module-propagation-fixtures: FATAL: could not enumerate Terraform source files" >&2
  exit 2
}

OUT="${WORK}/checker.out"
failures=0
checks=0

note_failure() {
  failures=$((failures + 1))
}

# Copy just the configuration files the static checker reads.  In particular,
# never copy .terraform: it is large, irrelevant to this lexical gate, and could
# make a fixture accidentally depend on a local provider cache.
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

# Replace exactly one literal in a fixture.  Passing the literals through the
# environment avoids shell-quoting HCL and makes an accidental zero/multiple
# replacement a loud fixture error instead of a misleading checker result.
count_occurrences() {
  OLD_TEXT="$1" perl -0777 -ne '$count = () = /\Q$ENV{OLD_TEXT}\E/g; print $count' "$2"
}

replace_once() {
  target_file="$1"
  old_text="$2"
  new_text="$3"
  occurrences="$(count_occurrences "${old_text}" "${target_file}")"
  if [ "${occurrences}" != "1" ]; then
    echo "run-cross-module-propagation-fixtures: FATAL: expected one mutation target in ${target_file}, found ${occurrences}" >&2
    return 1
  fi
  OLD_TEXT="${old_text}" NEW_TEXT="${new_text}" perl -0pi -e 's/\Q$ENV{OLD_TEXT}\E/$ENV{NEW_TEXT}/' "${target_file}"
}

replace_all() {
  target_file="$1"
  old_text="$2"
  new_text="$3"
  occurrences="$(count_occurrences "${old_text}" "${target_file}")"
  if [ "${occurrences}" = "0" ]; then
    echo "run-cross-module-propagation-fixtures: FATAL: mutation target missing in ${target_file}" >&2
    return 1
  fi
  OLD_TEXT="${old_text}" NEW_TEXT="${new_text}" perl -0pi -e 's/\Q$ENV{OLD_TEXT}\E/$ENV{NEW_TEXT}/g' "${target_file}"
}

mutate_case() {
  case_name="$1"
  fixture_dir="$2"
  cosmos_file="${fixture_dir}/modules/cosmos-db/main.tf"
  iothub_file="${fixture_dir}/modules/iot-hub/main.tf"

  case "${case_name}" in
    clean)
      ;;
    missing-child-lifecycle)
      replace_once "${cosmos_file}" $'  lifecycle {\n    replace_triggered_by = [azurerm_cosmosdb_account.main.id]\n  }' ''
      ;;
    wrong-parent)
      replace_once "${cosmos_file}" 'replace_triggered_by = [azurerm_cosmosdb_account.main.id]' 'replace_triggered_by = [azurerm_iothub.main.id]'
      ;;
    bare-parent)
      replace_once "${cosmos_file}" 'replace_triggered_by = [azurerm_cosmosdb_account.main.id]' 'replace_triggered_by = [azurerm_cosmosdb_account.main]'
      ;;
    no-discovered-pairs)
      # This is intentionally broad over the throwaway tree: no configured-name
      # reference may remain for check 18 to discover.
      find "${fixture_dir}" -type f -name '*.tf' -exec perl -pi -e 's/\.name\b/.id/g' {} \;
      ;;
    below-pair-floor)
      # The clean tree records 20 pairs. Removing the five database->container
      # name links still leaves fifteen pairs, isolating the ratchet rather than
      # merely re-testing the zero-pair failure.
      replace_all "${cosmos_file}" 'database_name       = azurerm_cosmosdb_sql_database.meatgeek.name' 'database_name       = azurerm_cosmosdb_sql_database.meatgeek.id'
      ;;
    missing-cosmos-endpoint-lifecycle)
      replace_once "${iothub_file}" $'  lifecycle {\n    replace_triggered_by = [terraform_data.cosmos_target_ready.id]\n  }' ''
      ;;
    missing-cosmos-triggers-replace)
      replace_once "${iothub_file}" $'  triggers_replace = {\n    database_id  = var.cosmos_database_id\n    container_id = var.cosmos_container_id\n  }' ''
      ;;
    *)
      echo "run-cross-module-propagation-fixtures: FATAL: unknown case ${case_name}" >&2
      return 1
      ;;
  esac
}

run_case() {
  case_name="$1"
  expected_text="$2"
  fixture_dir="${WORK}/${case_name}"
  checks=$((checks + 1))

  if ! make_tree "${fixture_dir}" || ! mutate_case "${case_name}" "${fixture_dir}"; then
    echo "  ✗ ${case_name}: fixture setup failed" >&2
    note_failure
    return
  fi

  if bash "${CHECKER}" "${fixture_dir}" >"${OUT}" 2>&1; then
    result=0
  else
    result=$?
  fi

  if [ "${case_name}" = "clean" ]; then
    if [ "${result}" -eq 0 ] && grep -Fq "${expected_text}" "${OUT}"; then
      echo "  ✓ clean: passed with the non-vacuous discovered-pair count"
    else
      echo "  ✗ clean: expected exit 0 and '${expected_text}', got exit ${result}" >&2
      sed 's/^/      /' "${OUT}" >&2
      note_failure
    fi
  elif [ "${result}" -ne 0 ] && grep -Fq "${expected_text}" "${OUT}"; then
    echo "  ✓ ${case_name}: rejected with its distinguishing message"
  else
    echo "  ✗ ${case_name}: expected nonzero and '${expected_text}', got exit ${result}" >&2
    sed 's/^/      /' "${OUT}" >&2
    note_failure
  fi
}

echo "run-cross-module-propagation-fixtures: exercising ${CHECKER} with isolated INFRA_DIR copies"
run_case clean 'check 18: discovered 20 name-referenced (child, parent) pair(s) (floor 20)'
run_case missing-child-lifecycle 'declares no lifecycle { replace_triggered_by = [azurerm_cosmosdb_account.main.id] }'
run_case wrong-parent 'its replace_triggered_by names azurerm_iothub.main.id instead of azurerm_cosmosdb_account.main.id'
run_case bare-parent 'replace_triggered_by names the whole resource azurerm_cosmosdb_account.main instead of azurerm_cosmosdb_account.main.id'
run_case no-discovered-pairs "this check has stopped working (it must never pass by finding nothing)"
run_case below-pair-floor 'this scan discovered 15 name-referenced (child, parent) pair(s), below the recorded floor of 20'
run_case missing-cosmos-endpoint-lifecycle 'azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage declares no lifecycle { replace_triggered_by = [terraform_data.cosmos_target_ready.id] }'
run_case missing-cosmos-triggers-replace 'terraform_data.cosmos_target_ready declares no triggers_replace'

if [ "${checks}" -ne 8 ]; then
  echo "run-cross-module-propagation-fixtures: FAILED — ran ${checks} checks, expected 8; a case was dropped." >&2
  exit 1
fi
if [ "${failures}" -ne 0 ]; then
  echo "run-cross-module-propagation-fixtures: FAILED — ${failures} of ${checks} checks failed." >&2
  exit 1
fi

echo "run-cross-module-propagation-fixtures: all ${checks} mutation checks behaved as expected under ${BASH_VERSION}."

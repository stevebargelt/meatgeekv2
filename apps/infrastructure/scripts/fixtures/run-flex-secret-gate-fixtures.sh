#!/usr/bin/env bash
#
# run-flex-secret-gate-fixtures.sh — deterministic regression harness for the
# fail-closed plan/state secret gate (MG-24 Flex shape + MG-23 blocker 1).
#
# Exercises scripts/tf-plan-secret-inspection.sh against the committed
# terraform-show-json fixtures next to this script and asserts each expected exit
# code. No Azure, no `terraform` binary, no credentials — the gate consumes a
# `terraform show -json` document and every fixture IS one.
#
# To catch the MG-24 portable-shell regression (a gate that PASSes on bash but
# ERRORs on dash is fail-open), each case is run under BOTH bash and sh.
#
# MG-23 blocker 1 additions. Two vacuous-PASS holes were fixed in the gate and are
# pinned here so they cannot reopen:
#   * SCHEMA TYPE — a recognized key of the WRONG type (resource_changes as a
#     string/object, planned_values as a string) used to satisfy the gate's
#     PRESENCE probe while every collector reached in with jq's error-suppressing
#     `?` / `// empty` and yielded nothing. The gate walked zero resources and
#     printed PASS. Pinned by the secret-gate-*-string / -object fixtures.
#   * TEMP-FILE FAILURE — the gate stages its collected rows through `mktemp`.
#     Unchecked, a failing mktemp left the path EMPTY, redirected all three
#     inspection loops to/from "", and still printed PASS. Pinned by the
#     mktemp-failure environment case below, which needs no fixture: it forces the
#     failure with a stub `mktemp` on PATH (see that case for why NOT via TMPDIR).
#   * A valid EMPTY resource_changes array must still PASS — that is a real
#     converged no-op plan (what infra-apply-dev.yml's final drift plan emits on a
#     healthy run), and failing it would wedge the GitOps loop. Pinned by
#     secret-gate-empty-resource-changes.json.
#
# COUNTING (MG-23 blocker 1). The harness tracks checks PER SHELL and enforces a
# floor. A harness that silently runs FEWER cases than it thinks — because a
# fixture vanished, a shell was skipped, or a subshell swallowed the loop — is the
# same class of fail-open as the gate holes it exists to catch. The per-shell
# counts must each meet the floor AND be equal to each other.
#
# Exit 0 iff every case behaves as expected under every shell AND the counts hold.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${HERE}/../tf-plan-secret-inspection.sh"

[ -f "${GATE}" ] || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }

# A known-good document, reused by the environment-driven cases below: they must
# fail for the ENVIRONMENT reason, so the input has to be one the gate would
# otherwise happily PASS. Using a violation fixture here would make those cases
# vacuous (nonzero for the wrong reason).
VALID_FIXTURE="${HERE}/flex-plan-accepted.json"
[ -f "${VALID_FIXTURE}" ] || { echo "FATAL: baseline fixture missing: ${VALID_FIXTURE}" >&2; exit 2; }

# Fixture cases: "<fixture> <expectation> <mode>" rows — POSIX-portable, no arrays.
#   expectation: "pass" => gate must exit 0, "fail" => nonzero.
#   mode:        "auto" => invoke the gate with the bare path, exercising its
#                          JSON-vs-plan-binary autodetection (the MG-24 rows).
#                "json" => force --json. Required for the MG-23 rows: without it
#                          the deliberately INVALID fixture would be treated as a
#                          plan binary and its exit code would then depend on
#                          whether `terraform` happens to be on PATH, which is not
#                          a deterministic regression test.
CASES="
flex-plan-accepted.json pass auto
flex-plan-reenabled-shared-key.json fail auto
flex-plan-appsetting-key.json fail auto
flex-plan-host-storage-connstr.json fail auto
flex-plan-siteconfig-key.json fail auto
flex-plan-siteconfig-localauth-enabled.json fail auto
flex-plan-siteconfig-noncred.json fail auto
flex-plan-sas-endpoint.json fail auto
flex-plan-deploy-storage-key.json fail auto
secret-gate-empty-resource-changes.json pass json
secret-gate-resource-changes-string.json fail json
secret-gate-resource-changes-object.json fail json
secret-gate-planned-values-string.json fail json
secret-gate-invalid.json fail json
"

# 14 fixture cases + 1 redaction case + 1 positive-control shape case + 2
# environment cases. Raise this floor whenever a case is added, so the harness
# cannot quietly run fewer than it advertises.
MIN_CHECKS_PER_SHELL=18

# Resolve each shell to an ABSOLUTE path: the PATH-stripped environment case below
# cannot rely on PATH lookup to find its own interpreter.
SHELL_BINS=""
for cand in bash sh; do
  p="$(command -v "${cand}" 2>/dev/null || true)"
  [ -n "${p}" ] && SHELL_BINS="${SHELL_BINS} ${p}"
done
[ -n "${SHELL_BINS}" ] || { echo "FATAL: no shell found to run the gate under" >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "${WORK}"' EXIT
CASES_FILE="${WORK}/cases"
printf '%s\n' "${CASES}" | grep -v '^[[:space:]]*$' > "${CASES_FILE}"
OUT="${WORK}/out"

# A stub `mktemp` that always fails, for the temp-file environment case below. It
# is prepended to PATH for that one invocation only, so the gate's own bare
# `mktemp` resolves to this instead of the real binary. Shebang is /bin/sh so the
# stub itself is interpreter-independent.
STUB_BIN="${WORK}/stub-bin"
mkdir -p "${STUB_BIN}"
cat > "${STUB_BIN}/mktemp" <<'STUB'
#!/bin/sh
echo "stub mktemp: refusing to create a temp file" >&2
exit 1
STUB
chmod +x "${STUB_BIN}/mktemp"

# Report what `sh` actually resolves to. On many systems /bin/sh IS bash, in which
# case "both shells" is bash twice and the dash-portability property is NOT being
# tested here. That is a property of this harness's existing dual-shell contract,
# not something this script silently launders — so it is stated in the log.
sh_target="$(readlink -f /bin/sh 2>/dev/null || echo unknown)"
echo "run-flex-secret-gate-fixtures: /bin/sh resolves to ${sh_target}"
case "${sh_target}" in
  *bash*) echo "  NOTE: /bin/sh is bash on this host — the dash-portability leg is NOT exercised here." ;;
esac
echo

failures=0
shells_run=0
counts=""

for shell_bin in ${SHELL_BINS}; do
  echo "== running fixtures under: ${shell_bin} =="
  checks=0
  failures_before=${failures}

  # Read with `< file` (not a pipe) so the loop runs in THIS shell and the
  # `checks` / `failures` counters survive — the same dash-portable discipline the
  # gate itself uses. A piped `while` would run in a subshell and silently discard
  # every count, which is exactly the miscount this floor exists to detect.
  while IFS=' ' read -r fixture expect mode; do
    [ -z "${fixture}" ] && continue
    path="${HERE}/${fixture}"
    checks=$((checks + 1))
    if [ ! -f "${path}" ]; then
      echo "  ✗ ${fixture}: fixture file missing" >&2
      failures=$((failures + 1))
      continue
    fi
    if [ "${mode}" = "json" ]; then
      "${shell_bin}" "${GATE}" --json "${path}" >"${OUT}" 2>&1
    else
      "${shell_bin}" "${GATE}" "${path}" >"${OUT}" 2>&1
    fi
    code=$?
    if [ "${expect}" = "pass" ]; then
      if [ "${code}" -eq 0 ]; then
        echo "  ✓ ${fixture}: exit 0 as expected (accepted)"
      else
        echo "  ✗ ${fixture}: expected exit 0, got ${code}" >&2
        sed 's/^/      /' "${OUT}" >&2
        failures=$((failures + 1))
      fi
    else
      if [ "${code}" -ne 0 ]; then
        echo "  ✓ ${fixture}: nonzero (${code}) as expected (fail-closed)"
      else
        echo "  ✗ ${fixture}: expected nonzero, got 0 — FAIL-OPEN" >&2
        sed 's/^/      /' "${OUT}" >&2
        failures=$((failures + 1))
      fi
    fi
  done < "${CASES_FILE}"

  # --- POSITIVE-CONTROL SHAPE case (MG-58) -----------------------------------
  # THE ACCEPTED FIXTURE MUST ACTUALLY CARRY THE SETTING IT CLAIMS TO CLEAR.
  #
  # flex-plan-accepted.json is the harness's only "gate says yes" row, and every
  # environment case above reuses it precisely because the gate PASSes it. That
  # makes it a control, and a control that has silently drifted behind
  # modules/functions/main.tf proves nothing: MG-58 added the identity-based host
  # storage setting to the module while the fixture kept the pre-MG-58 app_settings
  # map, so "the accepted shape passes" was a claim about a shape that is no longer
  # deployed. An exit code cannot detect that — absence of a key is exactly what a
  # PASS looks like — so the shape is asserted lexically here.
  #
  # The pairing is the point. This case and the flex-plan-host-storage-connstr.json
  # row above are a MUTATION CONTROL on the one setting MG-58 introduces: the
  # account-name form must be present in the document the gate ACCEPTS, and the
  # credential-carrying connection-string form must be present in the document the
  # gate REJECTS. Assert both ends, or a fixture edit that defangs either one
  # leaves the pair green and vacuous.
  #
  # The *ServiceUri variants are asserted ABSENT from the accepted control too:
  # they are ALTERNATIVES to the account-name form, not complements, and the
  # account is on standard Azure DNS (see modules/functions/main.tf and the MG-58
  # ADR). Publishing both forms is its own defect, so the accepted shape must not
  # quietly grow one.
  checks=$((checks + 1))
  NEG_HOST_FIXTURE="${HERE}/flex-plan-host-storage-connstr.json"
  shape_err=""
  if [ ! -f "${NEG_HOST_FIXTURE}" ]; then
    shape_err="negative host-storage fixture missing: ${NEG_HOST_FIXTURE}"
  elif ! grep -q '"AzureWebJobsStorage__accountName"' "${VALID_FIXTURE}"; then
    shape_err="the ACCEPTED control does not carry AzureWebJobsStorage__accountName — it has drifted behind modules/functions/main.tf, so its PASS is a claim about a shape that is not deployed"
  elif grep -qE '"AzureWebJobsStorage"[[:space:]]*:' "${VALID_FIXTURE}"; then
    shape_err="the ACCEPTED control carries the credential-carrying bare AzureWebJobsStorage connection-string form — that document must never be a PASS"
  elif grep -qE '"AzureWebJobsStorage__(blob|queue|table|file)ServiceUri"' "${VALID_FIXTURE}"; then
    shape_err="the ACCEPTED control carries a *ServiceUri host-storage variant — the account-name form and the service-URI forms are alternatives, and publishing both is its own defect"
  elif ! grep -qE '"AzureWebJobsStorage"[[:space:]]*:.*AccountKey[[:space:]]*=' "${NEG_HOST_FIXTURE}"; then
    shape_err="the NEGATIVE host-storage fixture no longer carries a bare AzureWebJobsStorage connection string with an account key — its rejection would be for some other reason, making the pair vacuous"
  fi
  if [ -n "${shape_err}" ]; then
    echo "  ✗ [shape] ${shape_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [shape] host-storage mutation control intact: accepted fixture carries ONLY the account-name form; negative fixture carries the connection-string form"
  fi

  # --- REDACTION case (MG-23 red) --------------------------------------------
  # THE GATE MUST NOT PRINT THE SECRET IT REJECTS.
  #
  # This gate's whole job is keeping credential VALUES out of places they can be
  # read — and its own stdout/stderr is such a place: a retained, broadly readable
  # CI log. An earlier revision interpolated the extracted InstrumentationKey into
  # the foreign-conn-string rejection message, so the ONE path that fires only when
  # a live-looking credential is provably present printed that credential. The gate
  # leaked what it was deployed to protect, on its reject path.
  #
  # secret-gate-foreign-ikey-sentinel.json embeds the sentinel MGSENTINELDONOTLOG
  # in EVERY credential value and is built to drive every reject path at once
  # (foreign-ikey, export-surface output, generic marker, bare managed ikey, Flex
  # storage_access_key, inherent-key data service, azapi shared-key). So this is a
  # whole-surface assertion, not a single-message one.
  #
  # STDOUT AND STDERR ARE CAPTURED SEPARATELY, deliberately. The fixture cases
  # above merge them (`>"${OUT}" 2>&1`), which is fine when the assertion is an
  # exit code — but a redaction claim merged across both streams cannot say WHICH
  # stream leaked, and "we checked the combined blob" is a weaker statement than
  # "neither stream contains it". Both are asserted independently here.
  #
  # Nonzero is asserted too: a gate that ACCEPTED this document would trivially
  # satisfy "did not print the sentinel" while being catastrophically wrong. The
  # redaction property is only meaningful on a run that actually rejected.
  checks=$((checks + 1))
  REDACT_FIXTURE="${HERE}/secret-gate-foreign-ikey-sentinel.json"
  SENTINEL='MGSENTINELDONOTLOG'
  ROUT="${WORK}/redact.out"
  RERR="${WORK}/redact.err"
  if [ ! -f "${REDACT_FIXTURE}" ]; then
    echo "  ✗ [redact] fixture missing: ${REDACT_FIXTURE}" >&2
    failures=$((failures + 1))
  else
    "${shell_bin}" "${GATE}" --json "${REDACT_FIXTURE}" >"${ROUT}" 2>"${RERR}"
    code=$?
    # grep -c would count LINES; -o | wc -l counts OCCURRENCES, which is what a
    # leak claim is about (one line can carry several).
    hits_out="$(grep -o "${SENTINEL}" "${ROUT}" 2>/dev/null | wc -l | tr -d ' ')"
    hits_err="$(grep -o "${SENTINEL}" "${RERR}" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${code}" -eq 0 ]; then
      echo "  ✗ [redact] gate ACCEPTED a document full of live credentials — redaction is vacuous on a run that did not reject" >&2
      failures=$((failures + 1))
    elif [ "${hits_out}" != "0" ] || [ "${hits_err}" != "0" ]; then
      echo "  ✗ [redact] the gate PRINTED the credential it rejected — sentinel occurrences: stdout=${hits_out}, stderr=${hits_err}" >&2
      echo "      A reject path must print the resource ADDRESS + attribute NAME + reason, never the VALUE." >&2
      failures=$((failures + 1))
    else
      echo "  ✓ [redact] rejected (${code}) and the sentinel appears in NEITHER stdout NOR stderr"
    fi
  fi

  # --- Environment-driven cases (no fixture; MG-23 blocker 1) ----------------
  # Both assert on the REASON as well as the exit code. Nonzero alone would be a
  # weak test: a case that fails because it could not even exec the gate proves
  # nothing about the gate's fail-closed behaviour.

  # mktemp fails -> the gate must FATAL, not stage zero rows and print PASS (the
  # pre-fix behaviour was exit 0 with a clean PASS line).
  #
  # The failure is forced with a STUB `mktemp` ahead of the real one on PATH, NOT
  # by pointing TMPDIR at an unwritable directory. TMPDIR is not a portable lever:
  # GNU mktemp honours it and fails, but macOS mktemp IGNORES an unwritable TMPDIR
  # and falls back to /var/folders — so mktemp SUCCEEDS, the gate correctly accepts
  # the valid fixture, and this case reported a false red on every Darwin host
  # under every shell. Skipping the case on Darwin would assert an MG-23 blocker-1
  # fail-closed control on ONE platform; the stub exercises it on BOTH.
  #
  # A PATH stub can only intercept a BARE `mktemp`. If the gate ever called it by
  # absolute path the stub would be bypassed and this case would go green for the
  # wrong reason, so that is checked rather than assumed.
  checks=$((checks + 1))
  if grep -q '/bin/mktemp' "${GATE}"; then
    echo "  ✗ [env] mktemp failure: the gate names mktemp by ABSOLUTE path — a PATH stub cannot intercept it, so this case would be vacuous" >&2
    failures=$((failures + 1))
  else
    PATH="${STUB_BIN}:${PATH}" "${shell_bin}" "${GATE}" --json "${VALID_FIXTURE}" >"${OUT}" 2>&1
    code=$?
    if [ "${code}" -ne 0 ] && grep -q 'stub mktemp: refusing to create a temp file' "${OUT}" && grep -q 'cannot create a temp file' "${OUT}"; then
      echo "  ✓ [env] failing mktemp (stubbed on PATH): stub intercepted mktemp and the gate rendered a temp-file FATAL"
    else
      echo "  ✗ [env] failing mktemp (stubbed on PATH): expected nonzero with BOTH the stub interception marker and temp-file FATAL, got ${code}" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  fi

  # PATH stripped -> the gate's own tool preflight must FATAL. The shell is
  # invoked by ABSOLUTE path so the failure is the gate's jq/mktemp check and not
  # `env` being unable to find an interpreter (which would exit 127 and prove
  # nothing).
  checks=$((checks + 1))
  env PATH=/nonexistent "${shell_bin}" "${GATE}" --json "${VALID_FIXTURE}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -ne 0 ] && grep -qE 'jq is required|mktemp is required' "${OUT}"; then
    echo "  ✓ [env] stripped PATH: nonzero (${code}) with a required-tool FATAL"
  else
    echo "  ✗ [env] stripped PATH: expected nonzero naming the missing tool, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  echo "  -- ${shell_bin}: ${checks} checks"
  # Name the shell on STDERR too. Every ✗ above goes to stderr while the "running
  # under" header goes to stdout, so a consumer that captures the streams
  # separately (infra-security-posture.spec.ts concatenates stdout then stderr)
  # otherwise sees a pile of failed cases with no way to attribute them to a shell.
  if [ "${failures}" -ne "${failures_before}" ]; then
    echo "  ✗ ${shell_bin}: $((failures - failures_before)) case(s) above failed under THIS shell" >&2
  fi
  if [ "${checks}" -lt "${MIN_CHECKS_PER_SHELL}" ]; then
    echo "  ✗ ${shell_bin}: ran ${checks} checks, floor is ${MIN_CHECKS_PER_SHELL} — the harness silently ran fewer cases than it advertises" >&2
    failures=$((failures + 1))
  fi
  shells_run=$((shells_run + 1))
  counts="${counts} ${shell_bin}=${checks}"
done

echo
echo "run-flex-secret-gate-fixtures: shells_run=${shells_run}, per-shell checks:${counts}"

# Every shell must have run the SAME number of checks. A shell that skipped rows
# is as bad as one that never ran.
distinct="$(for c in ${counts}; do echo "${c##*=}"; done | sort -u | wc -l)"
if [ "${shells_run}" -lt 2 ]; then
  echo "run-flex-secret-gate-fixtures: FAILED — only ${shells_run} shell(s) ran; the dual-shell contract was not exercised" >&2
  exit 1
fi
if [ "${distinct}" -ne 1 ]; then
  echo "run-flex-secret-gate-fixtures: FAILED — per-shell check counts differ (${counts}); a shell skipped rows" >&2
  exit 1
fi

if [ "${failures}" -ne 0 ]; then
  echo "run-flex-secret-gate-fixtures: FAILED — ${failures} case(s) did not behave as expected" >&2
  exit 1
fi
# NOTE — the phrase "all fixtures behaved as expected" is a CONTRACT, not prose.
# infra-security-posture.spec.ts (the MG-24 fail-closed suite) matches on it to
# confirm this harness ran green. Reword it and that suite goes red for a reason
# that has nothing to do with the gate. Extend the line; do not rewrite it.
echo "run-flex-secret-gate-fixtures: all fixtures behaved as expected under every shell."
exit 0

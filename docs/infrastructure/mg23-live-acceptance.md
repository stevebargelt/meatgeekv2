# MG-23 — Live Activation, Blocking Checks & Acceptance Tests

> **Read this before you set `DEV_TF_BACKEND_READY`.** Merging the MG-23 code
> turns nothing on. This document is the complete operator procedure for
> everything the pipeline cannot do for itself: creating the apply identity,
> resolving role-definition GUIDs, creating the GitHub Environments, verifying
> the three empirical facts the ABAC condition rests on, running the T1–T7 live
> acceptance tests, tightening branch protection, activating, and proving the
> loop. You should be able to execute it end to end without reading the MG-23
> ticket.

## What the MG-23 code run did — and deliberately did not — do

The MG-23 build shipped **deterministic code only**. Specifically, it:

- **created NO live service principal** — `bootstrap_infra_apply_identity()`
  exists in [`bootstrap.sh`](../../apps/infrastructure/bootstrap/bootstrap.sh)
  but has never been executed against Azure by an agent;
- **set NO `DEV_TF_BACKEND_READY`** — every MG-23 job is gated on it and skips
  cleanly while it is unset;
- **ran NO `terraform apply`, no `terraform init` against the live backend, and
  no `az` command against the subscription.** Agent containers hold no Azure
  credential by design.

Everything below is therefore _unproven against the live tenant_ until you run
it. Several steps are written with **both outcomes designed**, because assuming
an outcome is exactly how a security control ends up decorative.

## Terminology (used precisely, here and in the code)

| Term                                            | Meaning                                                                                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MG-24 — Terraform reconciliation**            | **Operator-run.** A human runs `terraform apply` from a workstation against the persistent dev backend. This is what exists today.                                                                             |
| **MG-23 — automated dev GitOps reconciliation** | **CI-run.** A PR runs **credentialless** validation (no Azure identity at all); merging to `main` runs an automatic apply. No operator-workstation apply in the steady state. This is what you are activating. |
| **MG-25**                                       | Prod's CI-run apply. **Not this ticket.** [`infra-deploy-prod.yml`](../../.github/workflows/infra-deploy-prod.yml) stays plan-only and `workflow_dispatch`-only.                                               |

## The moving parts you are activating

| Artifact                                                                                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) → `validate-infrastructure`                | The **only** infrastructure job reachable from a pull request, and it is **CREDENTIALLESS**: `permissions: contents: read` only (no `id-token: write`), no `environment:`, no `azure/login`, no client/subscription id, and an `env:` block pinning `ARM_USE_OIDC` / `ARM_USE_CLI` / `ARM_USE_MSI` / `ARM_USE_AKS_WORKLOAD_IDENTITY` to `'false'`. Runs `assert-credentialless.sh` → `terraform fmt -check -recursive` → `terraform init -backend=false -input=false -lockfile=readonly` → `terraform validate` → `terraform test` (root) → `tf-static-checks.sh` → `bootstrap.test.sh` → destroy-guard fixtures → per-module `terraform test` (`modules/functions`, `modules/iot-hub`, `modules/monitoring`) → OTel config validate. It never reaches `tfstate-dev`.       |
| [`.github/workflows/infra-apply-dev.yml`](../../.github/workflows/infra-apply-dev.yml)                  | The automatic post-merge apply: checkout the exact CI'd SHA → OIDC login → non-interactive `init` → `plan -out` → secret gate → destroy circuit-breaker → apply **that saved plan** → post-apply state gate (**always-run, not success-gated** — see [§9.4](#94-reading-a-failed-or-partial-apply)) → final drift plan that **fails on drift**.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`bootstrap.sh`](../../apps/infrastructure/bootstrap/bootstrap.sh) → `bootstrap_infra_apply_identity()` | Creates the dev infra-apply SP: RG-scoped Contributor, **conditioned** RBAC Administrator, container-scoped state role. OIDC only, no secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`tf-managed-role-allowlist.tsv`](../../apps/infrastructure/bootstrap/tf-managed-role-allowlist.tsv)    | Single source of truth for the 8 Terraform-managed role definitions. Read by bootstrap (to build the condition) **and** by CI check 13 (to diff against the graph).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [`tf-plan-secret-inspection.sh`](../../apps/infrastructure/scripts/tf-plan-secret-inspection.sh)        | Fail-closed credential-value gate. Now an **executed** gate in both workflows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`tf-plan-destroy-guard.sh`](../../apps/infrastructure/scripts/tf-plan-destroy-guard.sh)                | Fail-closed destructive-change circuit-breaker. Fails on **any** `delete` (including replacements, and each _deposed_ object individually) and any `forget` (a `removed { destroy = false }` block, which orphans a live resource out of Terraform management) — unless `TF_DESTROY_GUARD_AUTHORIZED_CHANGES` names the exact SET of **action-qualified tokens** reviewed. A count is not an authorization (the same count is met by a different set), and neither is a bare address (`delete:X` and `forget:X` are different decisions). An action verb **outside the modeled set** (`no-op`, `create`, `read`, `update`, `delete`, `forget`) also fails — and is **not** clearable by any override, in either direction; see [§12](#the-recovery-path-workflow_dispatch). |
| [`modules/monitoring`](../../apps/infrastructure/modules/monitoring/main.tf) activity-log alerts        | Detective controls on `roleAssignments/write`, `userAssignedIdentities/write`, `sqlRoleAssignments/write`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Fixed coordinates referenced throughout:

- Workload RG: **`meatgeek-v2-dev-rg`** (West US 2)
- State RG: **`meatgeek-v2-tfstate-rg`** — deliberately a **different** RG
- State container / key: **`tfstate-dev`** / **`meatgeek-v2/dev.tfstate`**
- State account name: derived, never literal —
  `apps/infrastructure/scripts/state-account-name.sh "$SUB_ID"`

---

## 1. Activation order

Do these **in order**. Each step depends on the one before it; step 8 is the
point of no return, because after it a merge to `main` mutates live dev
infrastructure with no human in the loop.

| #   | Step                                                                                                                                                                                                                                                                                                                         | Where                                                                        | Gate         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------ |
| 1   | Run `bootstrap.sh` — creates the apply SP, its federated credential, the conditioned RBAC grant, **and BOTH `development-infra-apply` and `development-infra-apply-recovery`, each verified PROTECTED**                                                                                                                      | Operator workstation, `az login` as subscription Owner/UAA + `gh auth login` | —            |
| 2   | Resolve and **commit** the role-definition GUIDs into the allowlist                                                                                                                                                                                                                                                          | Workstation + a reviewed PR                                                  | Step 2 below |
| 3   | **DECOMMISSION the retired dev plan identity and its GitHub Environment** — code removal does not remove live objects                                                                                                                                                                                                        | Operator workstation (`az` + `gh`)                                           | §3           |
| 3b  | Settle the remaining **GitHub Environments** and their protection rules, and set the environment variables bootstrap emitted                                                                                                                                                                                                 | GitHub UI / `gh`                                                             | §2           |
| 4   | **State migration — reconcile dev state with the MG-23 graph:** `terraform state rm` the de-scoped resource (Class 1), and settle whether the newly-declared ForceNew `principal_type` replaces the nine role assignments (Class 2). Unsettled, the first plan carries DESTROYS and the circuit-breaker deadlocks activation | Operator workstation, against live dev state                                 | Step 4 below |
| 5   | Run the **blocking pre-activation checks B1–B10**                                                                                                                                                                                                                                                                             | Live tenant + GitHub                                                         | §5           |
| 6   | Run the **live acceptance tests T1–T7** as the apply SP                                                                                                                                                                                                                                                                      | Live tenant, via GitHub Actions (§6)                                         | §7           |
| 7   | **Tighten branch protection on `main`** (B7)                                                                                                                                                                                                                                                                                 | GitHub                                                                       | §5           |
| 8   | Set **`DEV_TF_BACKEND_READY=true`** as a **repository** variable                                                                                                                                                                                                                                                             | GitHub                                                                       | §8           |
| 9   | Prove the **AC7 loop** (tag-change PR → plan → merge → automatic apply → no-op drift plan → revert PR)                                                                                                                                                                                                                       | GitHub                                                                       | §9           |

> **Step 4 is not optional and it is not last.** Every later step that plans
> against live dev state — B4, B5, T1–T7, and the AC7 loop itself — sees step
> 4's pending destroys (the de-scoped budget, and possibly nine role-assignment
> replacements) until they are settled. Running them first produces a _correct_
> circuit-breaker failure that looks like a broken pipeline.

> **Step 1 needs `gh` as well as `az`.** Bootstrap creates and verifies **both**
> deployment environments' protection rules — `development-infra-apply`
> (`main`-only deployment branch policy, **no** required reviewer) and
> `development-infra-apply-recovery` (`main`-only **plus** required reviewers)
> — the protection rules that **cannot** be left to GitHub, because GitHub
> silently auto-creates an _unprotected_ environment the first time a workflow
> references one. Run `gh auth login` before `./bootstrap.sh` — this is a
> prerequisite, not a nicety.
>
> **An AUTHENTICATED `gh` is now a hard precondition (MG-42).** Bootstrap reads
> the repository's live OIDC sub-claim customization to derive every federated
> subject, and it does so **before** the state backend or any identity is
> created. An unauthenticated `gh` therefore **aborts the run with nothing
> provisioned** rather than completing the Azure side — an unauthenticated `gh`
> is indistinguishable from "this repo has no customization", and assuming the
> default prefix would rewrite all three credentials to a subject no token
> matches. Remediation: `gh auth login`, then re-run. Other abort classes —
> a transient GitHub API failure, an unreadable customization, a prefix naming
> another repository — have **different** remediations; see
> [the runbook's precondition table](bootstrap-runbook.md#preconditions-that-abort-before-anything-is-provisioned)
> before assuming any `gh`-shaped failure is a login problem.
>
> **Bootstrap EXITS NON-ZERO when either environment is not verifiably
> `PROTECTED`, and prints no success summary in that case.** A green bootstrap
> is therefore the signal that activation is safe; you are not required to
> notice a missing line. If `gh` stops working part-way through a run, the
> environments report `UNVERIFIED`, bootstrap exits non-zero and prints the
> manual `gh api` procedure — that is not a half-finished run, since the Azure
> side is idempotent and safe to re-run.
> **`DEV_TF_BACKEND_READY` may not be set true until bootstrap exits zero and
> BOTH environments report `PROTECTED`** (B9).

> **Step 3 is the one nobody remembers.** Deleting the PR plan job from the repo
> deletes _code_. It does not delete the AAD app, its service principal, its role
> assignments, its federated credential, or the `development-infra-plan` GitHub
> Environment — and **re-running bootstrap will not clean any of them up
> either**. Left alone, an unmanaged, still-federated, pull-request-reachable
> path to reading `tfstate-dev` survives the simplification that was supposed to
> remove it. See **§3**.

### Step 1 — run bootstrap

```bash
az login                                  # a subscription Owner / User Access Administrator
az account set --subscription <V2-SUBSCRIPTION-ID>
gh auth login                             # REQUIRED — bootstrap aborts without it
                                          # (OIDC sub-claim read, MG-42; also B9)
cd apps/infrastructure/bootstrap

# Optional: install someone OTHER than the authenticated gh user as the
# recovery environment's required reviewer. Defaults to you.
# export RECOVERY_APPROVAL_REVIEWER_LOGIN=<github-login>

./bootstrap.sh                            # idempotent; safe to re-run
```

`bootstrap.sh` is create-if-absent for everything it _grants_ and **reconciling**
for everything it _constrains_ — the RBAC condition and the federated-credential
subjects are read back from live and corrected on mismatch, so re-running it is
how you converge, not just how you create. **It converges only what it manages:**
an identity bootstrap no longer knows about (the retired plan identity) is
untouched, which is why §3 exists. It
**never** runs Terraform and **never** mints a client secret. It ends by printing
a summary block per identity; the MG-23 one names
`AZURE_INFRA_APPLY_CLIENT_ID`, the federated subject, and the complete grant set.
Capture that output — you need it in step 3.

If the RBAC-administrator grant already exists with a **different** condition,
bootstrap **reconciles it IN PLACE**. `ensure_conditioned_role_assignment` reads
the live condition back, normalizes, compares, and on mismatch re-reads the whole
assignment object, changes **only** `condition` and `conditionVersion`, and
`az role assignment update`s it — carrying `id`, `principalId`,
`roleDefinitionId` and `scope` through verbatim, so the update cannot silently
re-point the grant at a different principal, role or scope.

**There is no no-grant window, and that is deliberate.** An earlier revision
delete+created the assignment, which meant a bootstrap re-run that overlapped an
automatic CI apply could strip the grant mid-write and leave the stack partially
applied. The in-place update removes that window, so a bootstrap re-run is no
longer a hazard to an in-flight apply. Two consequences worth knowing before you
run it:

- **`jq` is a hard requirement, checked in the STARTUP PREFLIGHT.** It is no
  longer discovered late, on the reconcile path only: `require_tools` is the
  first thing `main()` does after its banner line, ahead of every provisioning
  call, and it verifies `jq` — along with `az`, `gh`, a sha1
  tool (`sha1sum` **or** `shasum`), `mktemp` and the coreutils bootstrap uses —
  **before anything is mutated**, reporting every missing tool at once. Its
  absence is therefore a clean no-op failure rather than an abort halfway
  through provisioning. Bootstrap **will not** degrade to delete+create when
  `jq` is missing — that would re-introduce the no-grant window on precisely the
  machine least prepared for it. Install `jq` and re-run.
- **A failed update leaves the PREVIOUS condition in force**, not an unconditioned
  grant: nothing is deleted, so the identity still holds its grant constrained to
  the previously-allowlisted role set, and an apply needing a newly-allowlisted
  role fails _closed_. Fix the cause and re-run. Do **not** work around it by
  deleting the assignment by hand while an apply may be in flight — that is
  exactly the window the in-place path exists to eliminate.

### Step 2 — resolve and commit the role-definition GUIDs

The allowlist ships with every GUID as `PENDING`. Bootstrap resolves each one
live and logs `resolved role definition: <role> -> <guid>` to stderr; it
**fails closed** if a committed non-`PENDING` GUID disagrees with the tenant.
Commit the resolved values so the condition's contents are reviewable in git:

```bash
set -euo pipefail
cd apps/infrastructure/bootstrap
SRC=tf-managed-role-allowlist.tsv
OUT=/tmp/allowlist.resolved

grep '^#' "$SRC" > "$OUT"                       # keep the header verbatim
while IFS=$'\t' read -r role _guid; do
  [ -n "${role:-}" ] || continue
  guid="$(az role definition list --name "$role" --query "[0].name" -o tsv)"
  [ -n "$guid" ] || { echo "UNRESOLVED: $role" >&2; exit 1; }
  printf '%s\t%s\n' "$role" "$guid" >> "$OUT"
done < <(grep -v '^#' "$SRC" | grep -v '^[[:space:]]*$')

diff "$SRC" "$OUT" || true                      # `|| true`: differing files are the expected outcome
```

**Read that diff before overwriting anything.** Every changed line must be a
`PENDING` → GUID substitution and nothing else; a changed *role name* means the
loop above matched something you did not intend, and this file is what authors
the ABAC condition. The overwrite is a **separate** command for that reason —
"review every line before overwriting" is not a control-flow construct, and a
`cp` sitting in the same pasted block runs whether you read the diff or not:

```bash
cp "$OUT" "$SRC"                                # only after you have read the diff
```

Then open a PR with the resolved file, and **re-run `bootstrap.sh`** after it
merges so the live condition and the committed file are provably the same
derivation.

**Never** paste a remembered GUID. Remembered Azure role GUIDs are a well-known
source of silent authorization errors, and a wrong GUID authors a condition that
does not mean what it reads.

> CI (`tf-static-checks.sh` check 13) guards role **names** only — it diffs the
> allowlist against every `role_definition_name` in the graph. **GUID
> correctness is a live, bootstrap-time property**; a credential-less CI job
> cannot re-verify it. That is why T1/T2/T4 below exist.

### Step 4 — state migration: reconcile dev state with the MG-23 graph

MG-23 changed the dev graph in **two** ways that the _first_ plan against live
dev state will show, and that the destroy circuit-breaker will — correctly —
block. Both must be settled here, before any later step plans against dev:

- **Class 1 — a de-scoped resource.** The subscription budget left the graph but
  is still in state. Resolved by `terraform state rm`, below.
- **Class 2 — a newly-declared ForceNew attribute.** `principal_type` was added
  to nine pre-existing `azurerm_role_assignment` resources. Whether that plans
  as nine **replacements** depends on a live fact no agent container could
  observe. Both outcomes are designed for, in **Class 2** below.

#### Class 1 — drop the de-scoped resource from dev state

**Why this step exists.** MG-23 removed one resource from the dev graph:
`azurerm_consumption_budget_subscription.credit_budget` is now count-guarded
behind `manage_subscription_budget`, which `dev.tfvars` sets `false`. It had to
go, because it is scoped to `/subscriptions/<id>` and an apply identity that is
Contributor only on `meatgeek-v2-dev-rg` cannot manage it — keeping it would
have meant widening the SP to subscription scope, which invalidates F18 (§11)
and with it this entire threat model.

But dev **applied** that resource under MG-24, so it is **live in dev state**.
Config says "should not exist", state says "exists" — so the first plan the
GitOps loop produces contains a **destroy**, and
`scripts/tf-plan-destroy-guard.sh` will correctly **fail the run**. That failure
is the circuit-breaker working exactly as designed, and it deadlocks activation
until you resolve the mismatch here.

`terraform state rm` **detaches Terraform's ownership without calling Azure**.
The budget keeps existing and keeps alerting; it simply stops being something
this stack manages. That is the outcome we want — subscription-scoped spend
control becomes an operator concern, which is precisely why it left the graph.

```bash
set -euo pipefail
cd apps/infrastructure

# Operator credentials — this is a state mutation, not a CI action.
az account set --subscription <V2-SUBSCRIPTION-ID>
STATE_ACCOUNT="$(scripts/state-account-name.sh "<V2-SUBSCRIPTION-ID>")"
terraform init -input=false -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$STATE_ACCOUNT"

# Confirm it really is in state before removing anything — and let that
# confirmation DECIDE, rather than print. A `grep … || echo "already absent"`
# ahead of an unconditional `state rm` is a comment: it reports, then removes
# either way. This is live dev state; the check has to be the branch.
#
# Capture first rather than piping into `grep -q`: with `set -o pipefail` above,
# `grep -q` exiting early can SIGPIPE `terraform state list` and fail the
# pipeline even on a match, which would silently skip a migration that IS needed.
STATE_ENTRY="$(terraform state list | grep consumption_budget_subscription || true)"

if [ -n "$STATE_ENTRY" ]; then
  # NOTE the module-qualified address: the resource lives INSIDE the monitoring
  # module, and it was applied WITHOUT a count, so there is no [0] index in state.
  terraform state rm 'module.monitoring.azurerm_consumption_budget_subscription.credit_budget'
else
  echo "already absent — nothing to migrate"
fi
```

**Verify the migration worked** — the whole point is that the budget destroy is
gone. Run the plan through the _same gates the workflow uses_ rather than
eyeballing it:

```bash
terraform plan -input=false -var-file=environments/dev.tfvars -out=/tmp/mg23-migrate.bin
scripts/tf-plan-secret-inspection.sh /tmp/mg23-migrate.bin
scripts/tf-plan-destroy-guard.sh     /tmp/mg23-migrate.bin
```

The destroy guard must no longer name
`module.monitoring.azurerm_consumption_budget_subscription.credit_budget`. It
may still fail naming role assignments — that is **Class 2**, handled next. If
it names anything that is neither the budget nor one of the nine addresses
enumerated in Class 2, **do not override it and do not apply**: treat it as
another instance of Class 1 and find out why it left the graph.

No `moved` block is needed: `manage_subscription_budget` is `false` in **both**
`dev.tfvars` and `prod.tfvars`, so the `[0]` index the new `count` would
introduce never materializes in either state, and the un-indexed address above is
the correct one to remove.

#### Class 2 — `principal_type` is ForceNew on nine role assignments

**What changed and why it cannot be reverted.** MG-23 declares
`principal_type = "ServicePrincipal"` explicitly on **every**
`azurerm_role_assignment` in the stack. That is load-bearing, not cosmetic: the
apply SP's ABAC condition matches on `PrincipalType`, and an attribute the
request never sends does not match, so an omitted `principal_type` fails the
condition **shut** against every apply (this is exactly what **B1** verifies).
**Do not remove `principal_type` to avoid a replacement.** Removing it trades a
one-time, reviewed, authorized replacement for a permanently broken apply path.

**Why this can plan as a destroy.** In `hashicorp/azurerm` — pinned to the
version in [`.terraform.lock.hcl`](../../apps/infrastructure/.terraform.lock.hcl)
— `principal_type` is `Optional + Computed + ForceNew`. _ForceNew_ means that if
the planned value differs from the refreshed state value, Terraform does not
update the resource in place; it plans a **replace**, i.e. `["delete","create"]`.
The destroy guard treats a replace as a protected `delete` (deliberately — a
replace destroys the original just as thoroughly as a bare delete), so nine
replacements would block the first reconcile.

**Why it probably will not.** The same field is _Computed_, and the provider's
`Read` sets it from the ARM `roleAssignments` GET response
(`d.Set("principal_type", ...)` in `role_assignment_resource.go`). Every
principal in these nine assignments is a managed identity or a service
principal, so Azure returns `ServicePrincipal`; after the refresh that precedes
the plan, state already holds `ServicePrincipal`, the config declares
`ServicePrincipal`, there is no diff and **no replacement**.

This is the _read_ half of the same live question **B1** asks of the _write_
half — does this provider version actually carry `principalType` on the wire in
both directions. If B1's Branch B turns out to be the real one (the provider
omits `principalType` from the request), expect Class 2 to be live here too: an
attribute the provider never sends is an attribute the API never stores and
never returns, so the refresh leaves it empty and the plan replaces. **Run B1
and this step against the same first plan and read them together.**

> **Do not assume either outcome.** Which one you get depends on what the ARM
> `roleAssignments` GET actually returns for these nine objects against the live
> tenant — a fact no agent container could observe, because none of them holds
> an Azure credential. **The first plan is the authority.** This is the same
> discipline as B1–B3: designing for one branch and being handed the other is
> how an activation deadlocks at the worst possible moment.

**The nine addresses.** These are the complete, exact, module-qualified set —
the _only_ role-assignment addresses that may legitimately appear as
replacements in the first plan:

| #   | Resource address                                                                          | In dev state?                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `azurerm_role_assignment.functions_eventhub_receiver`                                     | yes                                                                                                                                                                                                                                                    |
| 2   | `azurerm_role_assignment.functions_signalr`                                               | yes                                                                                                                                                                                                                                                    |
| 3   | `azurerm_role_assignment.functions_appinsights_publisher`                                 | yes                                                                                                                                                                                                                                                    |
| 4   | `azurerm_role_assignment.functions_app_deploy_publisher[0]`                               | yes — `count`-guarded on `app_deploy_principal_object_id`, which `dev.tfvars` sets                                                                                                                                                                     |
| 5   | `module.azure_functions.azurerm_role_assignment.functions_storage_blob`                   | yes                                                                                                                                                                                                                                                    |
| 6   | `module.azure_functions.azurerm_role_assignment.functions_storage_queue`                  | yes                                                                                                                                                                                                                                                    |
| 7   | `module.azure_functions.azurerm_role_assignment.deploy_principal_deployment_container[0]` | yes — same `count` guard as #4                                                                                                                                                                                                                         |
| 8   | `module.iot_hub.azurerm_role_assignment.iothub_eventhub_sender`                           | yes                                                                                                                                                                                                                                                    |
| 9   | `module.native_otlp[0].azurerm_role_assignment.collector_dcr_publisher`                   | **no** — `enable_native_otlp` is `false` in dev, so the module is not instantiated and this address does not exist in dev state. It is listed because it is in the graph and in the allowlist; it becomes relevant only if native OTLP is ever enabled |

So the dev-state maximum is **eight**, not nine. If the plan names a role
assignment that is not on this list, something other than `principal_type`
changed — **stop and investigate; do not authorize it.**

##### Branch A — the first plan shows no role-assignment replacements (expected)

Nothing to do. Do not set `authorized_changes` to anything. Continue to step 5.

##### Branch B — the first plan replaces some of the eight

Work through this in order; each step is a check, not a formality.

1. **Confirm the cause is `principal_type` and nothing else.** Filter the plan to
   role assignments only, so no other resource's attributes are rendered:

   ```bash
   terraform show -json /tmp/mg23-migrate.bin \
     | jq -r '.resource_changes[]
              | select(.type == "azurerm_role_assignment")
              | select(.change.actions | index("delete"))
              | "\(.address)  replace_paths=\(.change.replace_paths)  \(.change.before.principal_type // "<null>") -> \(.change.after.principal_type)"'
   ```

   Every line must show `replace_paths` containing `principal_type` and a
   transition to `ServicePrincipal`. A replacement driven by anything else —
   `scope`, `principal_id`, `role_definition_name` — is **not** this class and
   must not be authorized here.

   > Keep this on the operator workstation. `terraform show -json` renders the
   > whole plan, and dev state carries **live IoT Hub SAS keys**; the `jq` filter
   > above is what keeps them off your terminal. Never redirect the unfiltered
   > JSON to a file, an issue, or a PR comment.

2. **Take the token list from the gate, not from this table.** Run the guard with
   no authorization; it prints the paste-ready, action-qualified token set for
   the plan it just inspected:

   ```bash
   scripts/tf-plan-destroy-guard.sh /tmp/mg23-migrate.bin    # fails, prints the tokens
   ```

   Tokens look like
   `delete:module.azure_functions.azurerm_role_assignment.functions_storage_blob`.
   Check every printed token against the table above. Hand-building the list is
   how a token for something you did not review gets in.

3. **Run the first reconcile through the RECOVERY path — it is the only path
   that can carry an authorization.** The automatic post-merge apply sources
   `TF_DESTROY_GUARD_AUTHORIZED_CHANGES` from the `workflow_dispatch` input
   alone, precisely so an unattended apply can never destroy anything. On the
   automatic path the value is always empty, so a Branch-B first plan **will**
   fail that run — correctly. Re-run it as `workflow_dispatch` on `main` with
   `authorized_changes` set to exactly the token set from step 2, and take it
   through the `development-infra-apply-recovery` approval gate. See
   [§12, "The recovery path"](#the-recovery-path-workflow_dispatch).

4. **Authorize exactly that set — no more, no fewer.** The guard matches the
   plan's protected-change set against your tokens **exactly**: a superset fails
   (the plan grew a change since you reviewed it) and a subset fails too. That
   second half is why a "pre-authorize all nine, just in case" list is actively
   harmful — authorizing changes the plan does not contain fails the gate just
   as hard as authorizing too few, and re-running to whittle the list down
   trains exactly the reflex this gate exists to prevent.

5. **Expect a brief dev-functions OUTAGE while this apply runs — it is expected
   behaviour, not a failure.** Everything above is about what the _plan_ does.
   This step is about what the _running system_ does, and it is the part that
   looks like an incident if nobody warned you.

   A ForceNew replacement is **delete-then-create**, not an in-place edit. For
   the window between the two, the role assignment does not exist — and these
   nine assignments are how the Function App's system-assigned managed identity
   reaches everything it depends on. Addresses 5 and 6 in the table above
   (`functions_storage_blob`, `functions_storage_queue`) are its **only** path to
   its own host storage: the Flex Consumption stack runs with shared-key access
   disabled, so the managed identity's `Storage Blob Data Owner` /
   `Storage Queue Data Contributor` grants are not one credential among several,
   they are the _only_ credential. Addresses 1, 2, 3 and 8 similarly carry Event
   Hubs, SignalR and Application Insights.

   So during the replacement window the dev Function App loses its own storage
   and its downstream grants, and Azure RBAC is **eventually consistent** —
   re-propagation after the create is not instant. The observable effect:
   - dev functions fail to start, or start and fail their triggers;
   - host-storage errors and `AuthorizationPermissionMismatch` /
     `AuthorizationFailure` in the Function App logs;
   - the outage outlasts the apply step itself, because propagation continues
     after Terraform has already reported success.

   **What to do:** nothing. Do not roll back, do not re-run the apply, and do
   not "fix" it by re-granting roles by hand — a hand-made grant is exactly the
   out-of-band assignment the F5 Activity Log alerts
   ([§10, F4](#10-accepted-residuals)) are watching for, and it will also drift
   against the final plan. Wait for
   propagation, then confirm recovery from the post-apply drift plan (it must be
   a no-op) and by exercising a dev endpoint.

   **Do it deliberately, not by surprise.** Run this first reconcile at a moment
   when dev being down for a few minutes is acceptable, and tell anyone using
   dev beforehand. This is also a reason not to schedule activation immediately
   before a demo.

   **It happens exactly once.** See step 6 — after the replacement, no later
   plan replaces on `principal_type`, so no later apply takes the grants away.
   The steady-state reconcile is ForceNew-free and causes no outage.

   > This applies to **Branch B only**. In Branch A there is no replacement, so
   > no grant is ever removed and dev stays up throughout.

6. **This is a FIRST-APPLY-ONLY authorization.** Once the replacement has
   happened, `principal_type` is present in state and matches the config, so no
   later plan replaces on it — subsequent applies are ForceNew-free and the
   steady state needs no authorization at all. The token set is a
   `workflow_dispatch` input for that one run; it is **never** promoted to a
   repository or environment variable. A sticky authorization would wave through
   a later plan nobody reviewed, which is the failure mode the input form was
   chosen to prevent.

**The gate is not relaxed by any of this.** An un-audited destroy still blocks —
Branch B does not lower the bar, it documents the one destructive change that
was reviewed in advance and names it exactly.

#### Completeness of this migration

The MG-23 build was audited for both classes: across the whole
`apps/infrastructure/` diff, exactly one `count` guard was added (the budget),
**zero** `resource` blocks were deleted, and exactly one ForceNew attribute
(`principal_type`) was newly declared on pre-existing resources. Re-run all
three checks if the graph changes before you activate:

```bash
BASE=<mg23-base>
# Class 1a — resources deleted from the graph (need `terraform state rm`)
git diff "$BASE"..HEAD -- apps/infrastructure/ | grep -E '^-\s*resource "'
# Class 1b — resources newly count-guarded (may be de-scoped in this environment)
git diff "$BASE"..HEAD -- apps/infrastructure/ | grep -E '^\+.*count\s*='
# Class 2 — attributes newly declared on PRE-EXISTING resources (ForceNew candidates)
git diff -U0 "$BASE"..HEAD -- 'apps/infrastructure/**/*.tf' \
  | grep -E '^\+\s*[a-z_]+\s*=' | grep -vE '^\+\s*(count|for_each|depends_on)\s*='
```

The first two commands find resources needing their own `terraform state rm`
line, with the same module-qualified addressing as Class 1. The third is a
**candidate** list, not an answer: a `grep` cannot know whether an attribute is
ForceNew. For each line it surfaces, look the attribute up in that resource's
provider documentation — _"Changing this forces a new resource to be created"_ is
the phrase — and if it is ForceNew **and** the resource already exists in state,
it is another Class 2 case: enumerate its exact addresses here and take it
through Branch B. Filtering only for added `count`/`resource` lines is what let
`principal_type` reach a first apply unenumerated.

#### Prod carries both classes too — but not yet

`prod.tfvars` sets `manage_subscription_budget = false` as well, so if prod ever
applied the budget, prod state has the identical Class 1 mismatch; and prod's
role assignments gained `principal_type` from the same graph, so prod carries
the identical Class 2 question. Both are harmless _today_ —
[`infra-deploy-prod.yml`](../../.github/workflows/infra-deploy-prod.yml) is
plan-only and `workflow_dispatch`-only, so a destroy is merely _shown_, never
executed. They become the same activation deadlock the moment MG-25 turns prod's
CI-run apply on. Work through this whole step against prod state as part of
MG-25, not as part of MG-23; **do not touch prod state during this activation.**

---

## 2. GitHub Environments — the protection matrix

**Read this before the table, because it is the strongest claim in the MG-23
simplification and it is easy to miss:**

> ### There is no PR-time credential boundary any more — because there is no PR-time credential
>
> The earlier design ran a `terraform plan` against the persistent dev backend
> from a pull request. That forced one **pull-request-reachable** job to hold
> **read** on `tfstate-dev`, and dev state contains **live IoT Hub SAS keys** —
> the one remaining live credential in an otherwise key-free stack. A
> required-reviewer gate on a dedicated plan environment was the mitigation:
> a human had to look at every PR's Terraform, provider sources, lock file and
> `local-exec` blocks before that PR's code got a token.
>
> That entire apparatus is **gone**, and so is the thing it mitigated. PR
> validation now touches **no Azure identity at all**: `validate-infrastructure`
> holds `permissions: contents: read` only, binds **no** GitHub Environment,
> calls **no** `azure/login`, and `assert-credentialless.sh` fails the job at
> runtime if any `ARM_*`/`AZURE_*` credential material, cached `az login`, or
> OIDC token-request pair is present. The residual the reviewer gate covered —
> **disclosure of the IoT Hub SAS material in `tfstate-dev` to attacker-supplied
> PR code** — is therefore closed **by construction**, not by a human
> remembering to look.
>
> A future reviewer should read the absence of a plan environment as the
> control, not as a missing one. **Restoring a PR-time plan re-opens the
> disclosure path and re-introduces every control that was deleted with it.**
> If someone proposes it, that is a threat-model change, not a CI convenience
> change.

The reviewer gate that remains is on **recovery only**, and it protects
_destruction_, not disclosure. A reviewer on `development-infra-apply` would
protect nothing that protected-`main` has not already protected: the change was
reviewed at merge, and re-approving it at apply time just converts GitOps
reconciliation back into a manual deploy.

### The count, stated unambiguously: **FOUR environments = three federated + one approval-only**

Both numbers are correct and they describe the same set — say the whole sentence,
never half of it. "Three federated environments" on its own reads as
contradicting the four-row matrix below; "four environments" on its own hides
that one of them holds no identity at all. The set is:

| #   | Environment                        | Federated?                                                                                                                                                 |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `development-infra-apply`          | **YES** — federated OIDC, the automatic apply identity                                                                                                     |
| 2   | `development-infra-apply-recovery` | **NO — deliberately not federated.** Approval-only; bound by the `recovery_approval` job, which has no `id-token` permission and never calls `azure/login` |
| 3   | `development`                      | **YES** — the app-deploy identity (MG-36)                                                                                                                  |
| 4   | `production`                       | **YES** — the prod plan/read identity                                                                                                                      |

So: **three federated + one approval-only recovery = four environments total.**
Bootstrap creates all four explicitly and reads their protection rules back
(**B9**); see the warning after the matrix on why an auto-created environment is
worse than a missing one.

Full detail:

| Environment                            | Federated identity                                                      | Deployment branch policy       | Required reviewer                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`development-infra-apply`**          | dev **infra-apply** identity **only** (`AZURE_INFRA_APPLY_CLIENT_ID`)   | **`main` only**                | **NO** — the automatic path carries no reviewer                                                                                                                 | Governed by protected `main` (reviewed at merge) + the green CI run + the destroy circuit-breaker. A reviewer here would re-approve an already-approved change _and_ stall automatic reconciliation. **Created EXPLICITLY by bootstrap and verified `PROTECTED` (B9).**                                                                                                                                                        |
| **`development-infra-apply-recovery`** | **none — deliberately NOT federated.** Nothing logs into Azure under it | **`main` only**                | **YES — the operator**, `prevent_self_review = false`. **Created EXPLICITLY by bootstrap and verified `PROTECTED` (B9) — never left to GitHub's auto-creation** | Approval-only gate carried by the `recovery_approval` job, which binds the environment purely for its protection rules. GitHub protection rules are per-_environment_, not per-_trigger_, so the manual approval for the `workflow_dispatch` recovery path needs its own environment. That job has **no `id-token` permission** and never calls `azure/login` — it cannot touch Azure; it can only be approved or not.         |
| **`development`**                      | dev **app-deploy** identity only (`AZURE_APP_DEPLOY_CLIENT_ID`)         | per existing app-deploy policy | per existing policy                                                                                                                                             | App code publishing (MG-36). No longer shared with the infra identities. **Note:** this identity also holds read-only `Storage Blob Data Reader` on `tfstate-dev`, so the apply identity is _not_ the only principal that can read dev state — see [§11](#11-f18--closed-escalation-paths-load-bearing-preconditions). Reviewing that grant and this environment's protection rules is **MG-36 scope; MG-23 changes neither.** |
| **`production`**                       | **prod plan/read identity — SURVIVES MG-23**                            | unchanged                      | unchanged                                                                                                                                                       | [`infra-deploy-prod.yml`](../../.github/workflows/infra-deploy-prod.yml) still authenticates under `production`. It is `workflow_dispatch`-only and not PR-reachable. Unchanged by MG-23; narrowing belongs to MG-25.                                                                                                                                                                                                          |

**Why the environment (not the client id) selects the identity (F8).** Before
MG-23, _every_ dev identity federated the identical subject
`<prefix>:environment:development` — where `<prefix>` is the repository's live
sub-claim prefix, **not** a literal `repo:<owner>/<repo>` (MG-42; see
[B10](#b10--do-the-live-federated-subjects-match-the-prefix-the-repo-actually-presents)) —
and was selected only by
which client-id a job passed — so a one-line client-id edit merged to `main`
silently upgraded a low-privilege job to full apply. Now the **environment**
selects the identity: the app-deploy identity cannot authenticate to the apply
environment's subject at all, so an edited client-id fails the login closed
instead of escalating. Neither dev identity can authenticate to
`environment:production`.

> ⚠ **Never let GitHub create an environment for you.** Referencing an
> environment that does not exist does not fail the run — GitHub **auto-creates
> it with no protection rules at all**, and the workflow file still _reads_ as
> though a gate is there. For `development-infra-apply-recovery` that would turn
> the human approval in front of a destructive recovery apply into a silent
> no-op; for `development-infra-apply` it would drop the `main`-only deployment
> branch policy and let any ref mint an apply token. Bootstrap therefore creates
> **both** explicitly and reads their protection rules back; **B9** is the
> blocking check that it did, and it covers **both**. Apply the same rule by
> hand to `development` and `production`: create them, then read the protection
> rules back.

### Variables to set

| Variable                                   | Scope                                   | Value                                                                                                      |
| ------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | shared (repository or each environment) | from `az account show`                                                                                     |
| `AZURE_CLIENT_ID`                          | **`production` only**                   | prod plan/read identity, from bootstrap output. There is no dev-scoped `AZURE_CLIENT_ID` any more — see §3 |
| `AZURE_INFRA_APPLY_CLIENT_ID`              | **`development-infra-apply`**           | apply identity, from bootstrap output                                                                      |
| `AZURE_APP_DEPLOY_CLIENT_ID`               | `development`                           | app-deploy identity                                                                                        |
| `DEV_TF_BACKEND_READY`                     | **repository** — see below              | `true`, **only at activation step 8**                                                                      |

> ⚠ **`DEV_TF_BACKEND_READY` must be a REPOSITORY variable, not an
> environment variable.** Every MG-23 job gates on it in a **job-level `if`**,
> which GitHub evaluates _before_ the job's environment is bound — an
> environment-scoped value is not reliably visible there, and the practical
> result is that every job skips forever and the activation looks like it
> silently did nothing. Set it at repository scope. It is a boolean flag, not a
> credential, so repository scope leaks nothing.

None of these are secrets — they are **variables** (`vars.*`). The identities
have **no client secret**; OIDC federation is their only credential. If you find
yourself creating a `secrets.AZURE_*_CLIENT_SECRET`, stop: something has gone
wrong with the design, not with your configuration.

---

## 3. DECOMMISSION — retire the dev plan identity and its environment

> **Deleting code does not delete live objects, and re-running `bootstrap.sh`
> will NOT clean any of this up.** Bootstrap no longer knows the dev plan
> identity exists, so it neither reconciles nor removes it. If you skip this
> section, the repository will _read_ as though the pull-request-reachable path
> to `tfstate-dev` was removed while, in the tenant, an **unmanaged,
> still-federated, still-`Reader` service principal with read access to live dev
> state — and the IoT Hub SAS keys in it — silently persists.** That is strictly
> worse than the design it replaced, because nothing is watching it any more.

Do all five. Each has a verification command; a retirement you have not verified
is not a retirement. Run these as the operator (`az login` as subscription
Owner/User Access Administrator, `gh auth login`). Substitute your own values for
every `<placeholder>` — no live identifier belongs in this document.

**First, resolve the object once and keep the two ids to hand:**

```bash
PLAN_APP_NAME='<dev-plan-app-display-name>'      # e.g. the display name bootstrap used
SUB_ID='<subscription-id>'
REPO='<owner>/<repo>'
PLAN_APP_ID=''; PLAN_SP_ID=''

# ALL matches, never [0] — the same rule B10's check() states, and for a sharper
# reason: everything in §3 DELETES. Entra display names are NOT unique, and [0]
# silently picks one of two same-named apps; a later `test -n` then sees a
# perfectly resolved value, because [0] already collapsed the very ambiguity the
# test was meant to catch. Deleting the WRONG principal here is a self-inflicted
# outage, so the count is checked where the ambiguity is still visible.
APP_MATCHES="$(az ad app list --display-name "$PLAN_APP_NAME" --query '[].appId' -o tsv)"
if [ "$(printf '%s\n' "$APP_MATCHES" | grep -c .)" = 1 ]; then
  PLAN_APP_ID="$APP_MATCHES"
  SP_MATCHES="$(az ad sp list --filter "appId eq '$PLAN_APP_ID'" --query '[].id' -o tsv)"
  [ "$(printf '%s\n' "$SP_MATCHES" | grep -c .)" = 1 ] && PLAN_SP_ID="$SP_MATCHES"
fi

# The gate EVERY mutating block in §3 calls. It is a function, and a refusal
# RETURNS rather than exits: `exit 1` pasted into an interactive shell kills the
# shell and takes $SUB_ID, $REPO and the ids you just resolved with it, which is
# how an operator ends up re-resolving by hand, mid-retirement, against a
# half-deleted object.
plan_retire_ready() {
  [ -n "$PLAN_APP_ID" ] && [ -n "$PLAN_SP_ID" ] && [ -n "$SUB_ID" ] && [ -n "$REPO" ] && return 0
  echo "REFUSING: unresolved or ambiguous retirement target (app='$PLAN_APP_ID' sp='$PLAN_SP_ID' sub='$SUB_ID' repo='$REPO'). Re-run this resolve block; delete NOTHING until it comes back clean." >&2
  return 1
}
plan_retire_ready && echo "resolved: app=$PLAN_APP_ID sp=$PLAN_SP_ID"
```

Capture `$PLAN_SP_ID` **before** step 1 — once the app registration is gone the
service principal object id is much harder to recover, and steps 3 and 4 need it.

**Every deleting block below re-calls `plan_retire_ready` and does nothing if it
refuses.** The gate is deliberately repeated rather than stated once here:
operators paste sections individually, and a precondition that only ran in a
block you scrolled past is not a precondition. The read-only verification
commands are left ungated on purpose — a listing against an unresolved id prints
nothing and mutates nothing, and gating them would only hide that the resolve is
what needs fixing.

### 3.1 Delete the subscription-scoped `Reader` role assignment

Do the role assignments **before** the directory objects: an assignment whose
principal no longer exists shows as an orphaned GUID in the portal and is
awkward to find later.

```bash
if plan_retire_ready; then
  az role assignment delete --assignee "$PLAN_SP_ID" \
    --role Reader --scope "/subscriptions/$SUB_ID"
fi
```

**Verify — must print nothing:**

```bash
az role assignment list --assignee "$PLAN_SP_ID" --all \
  --query "[?roleDefinitionName=='Reader'].{role:roleDefinitionName,scope:scope}" -o tsv
```

### 3.2 Delete the `tfstate-dev` blob-data role assignment

This is the one that actually reads state. The scope is the **container**, not
the account:

```bash
# state-account-name.sh returns non-zero and prints nothing when it cannot
# derive a name; an empty $STATE_ACCOUNT would splice a scope naming an account
# that does not exist, and a delete against a scope you did not mean to name is
# not something to discover afterwards.
STATE_ACCOUNT="$(apps/infrastructure/scripts/state-account-name.sh "$SUB_ID")" || STATE_ACCOUNT=''
CONTAINER_SCOPE="/subscriptions/$SUB_ID/resourceGroups/meatgeek-v2-tfstate-rg/providers/Microsoft.Storage/storageAccounts/$STATE_ACCOUNT/blobServices/default/containers/tfstate-dev"

if plan_retire_ready && [ -n "$STATE_ACCOUNT" ]; then
  az role assignment delete --assignee "$PLAN_SP_ID" --scope "$CONTAINER_SCOPE"
else
  echo "REFUSING: state account unresolved — not deleting at a scope naming an empty account." >&2
fi
```

**Verify — must print nothing.** Use `--all`, because a scoped listing hides
assignments made at other scopes, and "no assignment at the scope I looked at"
is not "no assignment":

```bash
az role assignment list --assignee "$PLAN_SP_ID" --all \
  --query "[?contains(scope, 'tfstate-dev')].{role:roleDefinitionName,scope:scope}" -o tsv
```

Belt and braces — the whole principal should now hold nothing anywhere:

```bash
az role assignment list --assignee "$PLAN_SP_ID" --all -o tsv    # must print nothing
```

### 3.3 Delete the service principal

```bash
if plan_retire_ready; then
  az ad sp delete --id "$PLAN_SP_ID"
fi
```

**Verify — must print an empty list (`[]`):**

```bash
az ad sp list --filter "appId eq '$PLAN_APP_ID'" --query '[].id' -o json
```

### 3.4 Delete the AAD application registration

Deleting the app registration is what destroys the **federated credential** with
it. Confirm the federated credential set first, so you know exactly what you are
removing:

```bash
if plan_retire_ready; then
  az ad app federated-credential list --id "$PLAN_APP_ID" \
    --query "[].{name:name, subject:subject}" -o table
  az ad app delete --id "$PLAN_APP_ID"
fi
```

**Verify — must print an empty list (`[]`):**

```bash
az ad app list --display-name "$PLAN_APP_NAME" --query '[].appId' -o json
```

> Deleted Entra applications sit in the tenant's **deleted-items** bin for 30
> days and can be restored. If your threat model requires the trust path gone
> now rather than in 30 days, purge it:
> `az ad app delete --id "$PLAN_APP_ID"` then check
> `az rest --method get --url 'https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.application'`
> and purge the entry. A restorable app is a restorable federated credential.

### 3.5 Delete the `development-infra-plan` GitHub Environment and its variable

Deleting the environment deletes the environment-scoped variables with it, but
delete the variable explicitly first so the intent is recorded and so a partially
failed environment delete cannot leave a dangling client id behind:

```bash
if plan_retire_ready; then
  # `|| true` is deliberate HERE and only here: the variable may already be gone,
  # and that must not stop the environment delete that follows it.
  gh variable delete AZURE_CLIENT_ID --env development-infra-plan --repo "$REPO" || true
  gh api --method DELETE "repos/$REPO/environments/development-infra-plan"
fi
```

**Verify — must return HTTP 404:**

```bash
gh api "repos/$REPO/environments/development-infra-plan" 2>&1 | grep -q 'Not Found' \
  && echo 'RETIRED (404)' || echo 'STILL PRESENT — NOT RETIRED'
```

And confirm the environment list is exactly the four MG-23 environments:

```bash
gh api "repos/$REPO/environments" --jq '.environments[].name' | sort
# -> development
#    development-infra-apply
#    development-infra-apply-recovery
#    production
```

### 3.6 Final assertion — no federated credential names the retired environment

The load-bearing check. **No** application in the tenant may retain a federated
credential whose subject **ends in** `:environment:development-infra-plan` —
whatever `repo:…` head it carries. The head is the repository's live sub-claim
prefix, which on this account is id-injected rather than a bare
`repo:<owner>/<repo>` (MG-42, and [B10](#b10--do-the-live-federated-subjects-match-the-prefix-the-repo-actually-presents)),
so match on the environment suffix — as the sweep below does — and never on a
hardcoded full subject. If one does survive, an actor
who can re-create that GitHub Environment (a repository admin, or anyone who can
merge a workflow referencing it — GitHub auto-creates it unprotected) can mint a
token for whatever that credential's app still holds.

```bash
for APP in $(az ad app list --query '[].appId' -o tsv); do
  az ad app federated-credential list --id "$APP" \
    --query "[?contains(subject,'environment:development-infra-plan')].{app:'$APP',subject:subject}" -o tsv
done
# -> must print NOTHING.
```

Repeat the same sweep for the apply identity, which must retain exactly one
credential and no more:

```bash
az ad app federated-credential list --id <APPLY_APP_ID> --query "[].name" -o tsv
# -> exactly: github-infra-apply-development-infra-apply
```

### 3.7 Record it

Retirement is only complete when the evidence exists. Attach to MG-23: the six
verification outputs above (each showing empty / 404 / the expected exact set),
the date, and who ran them. **Do not set `DEV_TF_BACKEND_READY=true` (§8) until
§3.1–§3.6 all verify** — see **B8**, which is the blocking pre-activation check
for exactly this.

---

## 4. Before you start the live checks: how to act _as_ the apply SP

The apply identity is **OIDC-only and has no client secret**, so
`az login --service-principal` is **not available** — by design. The tests below
must nonetheless run _as that principal_, because the whole point is to exercise
its ABAC condition. Two supported paths:

**Path A (recommended) — a temporary, ref-scoped federated credential + a
scratch workflow.** It needs the repository's live sub-claim prefix, so paste
**both** helpers — `oidc_assert_subject_prefix` and `oidc_subject_prefix` — from
[B10](#b10--do-the-live-federated-subjects-match-the-prefix-the-repo-actually-presents)
into the shell first. The same fail-closed read, for a sharper version of the
same reason: this path does not merely *compare* against the prefix, it
**creates a credential from it**. A prefix that named another repository would
federate the apply identity — `Contributor` on the dev RG — to that
repository's workflows, so the value must come back proven, not just read.

```bash
# 1. Add a TEMPORARY federated credential for an acceptance branch.
#    The `repo:…` head is the repository's LIVE sub-claim prefix, not a literal
#    repo:<owner>/<repo> (MG-42) — read it rather than typing it, or the
#    credential matches no token and azure/login fails AADSTS700213.
#    Resolve it with the fail-closed helpers defined in B10 (paste both
#    functions first); do NOT default the prefix when the read fails, and do not
#    substitute a bare `gh api` read — that returns a string nothing has proven
#    names THIS repository. A prefix guessed during a GitHub API failure produces
#    a credential that matches nothing, and you would spend the outage debugging
#    the acceptance run instead.
#    Keep the helper's exit STATUS as well as its output: the status is how a
#    refusal is reported, and `$(...)` on its own throws it away.
PREFIX="$(oidc_subject_prefix stevebargelt/meatgeekv2)"; PREFIX_RC=$?
[ "$PREFIX_RC" -eq 0 ] && [ -n "$PREFIX" ] \
  && echo "$PREFIX"   # observed 2026-07-28: repo:stevebargelt@4857343/meatgeekv2@1304558512

# THE GATE IS THE `if`, NOT THE MESSAGE. A warning that does not stop execution
# is a comment, and these blocks get pasted whole: `[ -n "$PREFIX" ] || { echo
# …; }` neither returns nor exits, so a refused resolve — unauthenticated gh, a
# GitHub outage, an unparseable body, a TRUST-ROOT MISMATCH — would fall straight
# through into the create and federate the apply identity (Contributor on the dev
# RG) to `:ref:refs/heads/mg23-acceptance`, where it persists until cleanup. The
# create must be UNREACHABLE without a proven prefix, so it lives inside the
# conditional rather than after an advisory.
if [ "$PREFIX_RC" -eq 0 ] && [ -n "$PREFIX" ]; then
  az ad app federated-credential create --id <APPLY_APP_ID> --parameters "$(cat <<JSON
{
  "name": "tmp-mg23-acceptance",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "${PREFIX}:ref:refs/heads/mg23-acceptance",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON
)"
else
  echo "STOP: prefix unresolved (oidc_subject_prefix exited ${PREFIX_RC}) — NO credential was created, and none may be created by hand. Remediate by the abort class the helper named (B10 branch C), then re-run this block." >&2
fi
# 2. Push the scratch acceptance workflow to branch `mg23-acceptance` and run it.
# 3. CLEANUP — re-run bootstrap.sh. prune_unexpected_federated_credentials()
#    DELETES any credential outside the expected set, so the cleanup is enforced
#    by code rather than by your memory:
cd apps/infrastructure/bootstrap && ./bootstrap.sh
az ad app federated-credential list --id <APPLY_APP_ID> --query "[].name" -o tsv
#    -> must list exactly: github-infra-apply-development-infra-apply
```

While that temporary credential exists, anyone who can push to
`mg23-acceptance` can assume the apply identity. That is acceptable **only**
because it happens _before_ activation, is time-boxed to the acceptance window,
and cleanup is verified by a bootstrap re-run — not because it is harmless.
Delete the branch afterwards.

**Path B — temporarily widen the `development-infra-apply` deployment branch
policy** to include the acceptance branch, run an environment-bound scratch job,
then restore the policy to `main`-only. Equivalent exposure; choose whichever
you can verify you have reverted.

**Path C — minting a client secret on the apply app — is FORBIDDEN.** A secret
on a principal holding Contributor + RBAC Administrator is a long-lived,
exfiltratable credential, and "no client secret ever" is an asserted property of
this design (bootstrap creates none, and the bootstrap tests assert it). If you
mint one "just for testing", the threat model in §11 no longer describes reality.

All test commands below assume you are executing them inside such a job, as the
apply SP.

---

## 5. Blocking pre-activation checks (B1–B10)

**None of these may be assumed.** Each states what to run and **both** branches
of the outcome. Do not set `DEV_TF_BACKEND_READY` until every one is resolved.

### B1 — Does the azurerm provider send `principalType` in the roleAssignments request?

The write clause of the condition asserts
`@Request[...:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase{'ServicePrincipal'}`.
If the provider omits `principalType` from the request body, the attribute does
not exist in `@Request` and the clause **fails shut against every apply**.

Run T1 (§7). Watch the outcome, and check the request as seen by Azure:

```bash
export TF_LOG=DEBUG TF_LOG_PATH=/tmp/tf.log   # in the scratch job only
terraform apply -auto-approve
grep -i 'principalType' /tmp/tf.log           # do NOT print the whole log: it contains request bodies
```

- **Branch A — `principalType` IS present:** nothing to do; the clause is live.
  Keep the explicit `principal_type = "ServicePrincipal"` on all 9
  `azurerm_role_assignment` resources anyway — it makes the behaviour a property
  of _our_ configuration rather than of a provider version.
- **Branch B — it is ABSENT:** the remedy is the explicit
  `principal_type = "ServicePrincipal"` already set on every role assignment in
  the graph (MG-23 step 1), which forces the provider to send it. Re-run T1.
  If it still does not appear, the correct action is to **remove the
  PrincipalType clause and record the loss in the residuals**, not to soften it.

> **NEVER "fix" this with an `!(Exists ...) OR ...` tolerance.** That shape reads
> as defensive but is a **one-field bypass**: any caller that simply _omits_
> `principalType` satisfies the clause unconditionally, which deletes the control
> for exactly the attacker who is trying to evade it.

Note: `TF_LOG=DEBUG` output contains request bodies. Do not upload it, do not
echo it, delete it with the runner.

### B2 — Does Azure validate a caller-declared `principalType` against the directory?

The condition trusts a _caller-declared_ attribute. If Azure does not verify it
against the directory, "service principals only" is **decorative**: a caller can
declare `ServicePrincipal` while assigning to a human user.

Run **T3** (§7). It attempts to grant an allowlisted role to a **real user
object id** while declaring `--assignee-principal-type ServicePrincipal`.

- **Branch A — the request is REJECTED:** Azure cross-checks the declaration.
  The clause means what it reads.
- **Branch B — the request SUCCEEDS:** the PrincipalType clause constrains only
  honest callers. Record it in the residuals as **"principal-type is advisory,
  not enforced"**, keep the clause (it still blocks accidental human grants),
  and rely on the RoleDefinitionId allowlist as the real constraint. This does
  **not** block activation — but it must be written down, because the
  difference between "SP-only" and "SP-only unless you lie" is the whole
  security claim.

### B3 — Does `GuidEquals` match a full ARM `roleDefinitionId` path?

The allowlist holds bare GUIDs; the provider may send
`/subscriptions/.../providers/Microsoft.Authorization/roleDefinitions/<guid>`.

Run **T1**.

- **Branch A — T1 permits all 8 roles:** `GuidEquals` extracts the GUID from the
  path. Done.
- **Branch B — T1 is denied with `AuthorizationFailed`/condition-not-satisfied
  on every role:** the condition **fails shut**, which is the correct direction
  but blocks all applies. Re-author the write/delete clauses against
  `StringEqualsIgnoreCase` on the **full role-definition resource id** (build
  the id from the subscription id + GUID in
  `build_rbac_admin_condition`), re-run bootstrap, re-run T1 **and** T2 (a
  string comparison must still reject Owner/Contributor). Do not loosen to a
  substring match.

### B4 — Can the apply SP `terraform init` the dev backend at all?

`environments/backend-dev.hcl` names `resource_group_name = "meatgeek-v2-tfstate-rg"`,
and the apply SP holds **only a container-scoped data role** on `tfstate-dev` —
no control-plane read on the state account or its RG. Every init to date ran as
the operator, so **this exact path is untested**. (Nothing in CI's PR path inits
a backend at all now — `validate-infrastructure` runs
`terraform init -backend=false`, so this is the _only_ dev backend init that
matters.)

```bash
cd apps/infrastructure
STATE_ACCOUNT="$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
terraform init -input=false -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$STATE_ACCOUNT"
```

- **Branch A — init succeeds:** nothing to change. `use_azuread_auth = true`
  means the backend reaches the blob via the data-plane role alone.
- **Branch B — init fails** (typically a control-plane `ResourceGroupNotFound`
  or authorization error while resolving the account):
  - **B4-a (preferred):** grant the apply SP **Reader scoped to the state
    STORAGE ACCOUNT** (not the RG, not the subscription). F18 survives: this is
    still a resource-scoped grant outside the workload RG, and it confers no
    data access beyond the container role it already has. Add it to
    `bootstrap_infra_apply_identity()` _and_ to the bootstrap-test out-of-RG
    grant inventory, or the next bootstrap-test run fails.
  - **B4-b:** drop `resource_group_name` from `backend-dev.hcl` so the backend
    resolves the account purely on the data plane. Cheaper, but it changes a
    file the operator's own workstation init also uses — re-verify both paths.

  Choose one, commit it in a reviewed PR, and re-run this check.

### B5 — Does RG-only Contributor suffice for the whole graph?

Two known subscription-scoped hazards were removed in the MG-23 build:
`azurerm_consumption_budget_subscription` is now count-guarded
(`manage_subscription_budget = false` in `dev.tfvars`), and the provider block
sets `resource_provider_registrations = "none"`.

**Run the state migration (§1 step 4) first — both classes.** Until it is done
this plan contains the pending budget destroy (Class 1) and possibly the nine
`principal_type` role-assignment replacements (Class 2), the destroy guard below
fails, and you learn nothing about the RG boundary.

**Run the IDENTICAL gated sequence the workflow uses — never a bare or
`-auto-approve` apply.** This check runs against **live dev state**, and at this
point in activation your shell may still hold the operator's subscription
Owner/UAA credentials from step 1, so an ungated destroy here would actually
execute rather than being refused. The gates are not ceremony: they are the same
two scripts that stand between a bad plan and live dev infrastructure in CI, and
a verification step that skips them is verifying a path nobody will ever run.

```bash
# As the apply SP, in the scratch job (§4) — NOT as the operator.
terraform plan -input=false -var-file=environments/dev.tfvars -out=/tmp/b5.bin
scripts/tf-plan-secret-inspection.sh /tmp/b5.bin   # pre-apply gate  — fail-closed
scripts/tf-plan-destroy-guard.sh     /tmp/b5.bin   # circuit-breaker — fail-closed
terraform apply -input=false /tmp/b5.bin           # THAT EXACT saved plan
```

If either gate fails, **stop**. Do not pass the destroy-guard override, and do
not re-plan with `-auto-approve` to get past it — a failing gate here is the
finding, not an obstacle to it.

- **Branch A — plan, both gates, and apply all succeed:** the RG boundary holds
  for the real graph.
- **Branch B — a resource fails with `AuthorizationFailed`:** identify it and
  resolve it **in the graph**, not by widening the SP. Widening to subscription
  scope invalidates F18 (§11) and therefore this entire threat model. The
  established pattern is a `count` guard on a root variable defaulting **off**
  for dev, with the subscription-scoped concern recorded as an operator action.
  Note that a newly count-guarded resource that is already live in dev state
  also needs a `terraform state rm` (§1 step 4) — the graph edit alone leaves a
  pending destroy that the circuit-breaker will correctly refuse. That two-part
  shape — guard it out of the graph, _then_ detach it from state — is exactly
  how the budget resource was handled, and the graph half of it is already done.
- **Also expect:** any _unregistered_ resource provider now fails the apply
  rather than being silently registered. **Registering resource providers is an
  operator precondition.** Register them once, as the operator:
  `az provider register --namespace Microsoft.<X>`.

### B6 — Does GitHub support operator SELF-APPROVAL on the recovery environment?

`development-infra-apply-recovery` is the only environment in MG-23 carrying a
required reviewer, and this repo has effectively one maintainer. If the reviewer
cannot approve their own run, the recovery path is unusable — and an unusable
recovery path gets bypassed with a workstation apply, which is the thing MG-23
exists to stop.

Check the environment's protection rules for the _"Prevent self-review"_ setting
on the required-reviewers rule (it must be **off** — bootstrap sets
`prevent_self_review: false` deliberately), and confirm your plan/billing tier
exposes required reviewers on this repository at all.

- **Branch A — self-approval is possible:** `prevent_self_review = false`, you
  are the reviewer, done. Each _recovery dispatch_ — not each PR, and not each
  automatic apply — costs you one deliberate click.
- **Branch B — self-approval is NOT possible** (the tier does not offer
  environment protection rules, or self-review cannot be permitted): **do not
  activate the recovery dispatch path.** Remove `workflow_dispatch` from
  `infra-apply-dev.yml` and treat recovery as an operator-workstation action
  (MG-24 style) until a second reviewer exists. Do **not** "solve" it by
  dropping the reviewer requirement: that would turn a destructive,
  operator-supplied `authorized_changes` apply into a one-click unreviewed
  destroy.

  The automatic reconciliation path is **unaffected** either way —
  `development-infra-apply` carries no reviewer by design.

  Record the rationale verbatim: _the only human gate left in MG-23 guards
  destruction on the recovery path; PR-time credential disclosure needs no gate
  because PR validation holds no credential (§2)._

### B7 — Branch protection on `main` (F1)

**This is out of pipeline scope and is the single hardest activation
prerequisite.** `main` currently permits unreviewed direct pushes
(`enforce_admins` off, no required reviewers), and MG-23 wires `main` to an
**automatic apply**. Until this is tightened, a direct push to `main` is a
direct, unreviewed mutation of live dev infrastructure by an identity holding
Contributor + RBAC Administrator.

Required before activation:

- `enforce_admins` **on** for `main`;
- required pull-request reviews on `main`;
- required status check: the CI workflow, **including `validate-infrastructure`**
  (`infra-apply-dev.yml` triggers only on a _successful_ CI run, so this is what
  makes the triple gate meaningful — and with no PR-time plan,
  `validate-infrastructure` is the entire pre-merge infrastructure gate);
- the `development-infra-apply` environment's deployment branch policy limited
  to `main`;
- the `development-infra-apply-recovery` environment's deployment branch policy
  limited to `main`, with its required reviewer live (B9).

**The single-maintainer conflict, stated plainly:** `enforce_admins` removes the
owner's own bypass, and required reviewers imply a second human. On a solo repo
you must pick one of:

1. add a second reviewer (best);
2. `enforce_admins` on, required reviews on, and rely on your own second-pass
   review with self-approval where permitted;
3. accept unreviewed direct pushes to `main` — in which case **do not activate
   MG-23**, because the automatic apply has no other control in front of it.

Resolving this is a **host-side operator step**; the MG-23 code run neither
attempted nor could attempt it.

### B8 — Is the retired dev plan identity fully DECOMMISSIONED?

**This check exists because merging the MG-23 simplification changes nothing in
the tenant.** The dev plan identity, its subscription `Reader`, its
`tfstate-dev` blob-data role, its federated credential and the
`development-infra-plan` GitHub Environment all survive a code deletion, and
`bootstrap.sh` does **not** remove them — it no longer manages them at all. Until
§3 is executed and verified, the pull-request-reachable read path into
`tfstate-dev` still exists; it is simply no longer described anywhere.

Run §3 in full, then confirm all four Azure-side facts at once:

```bash
# 1. The app registration is gone.
az ad app list --display-name '<dev-plan-app-display-name>' --query '[].appId' -o json   # -> []

# 2. The service principal is gone.
az ad sp list --filter "appId eq '<retired-plan-app-id>'" --query '[].id' -o json        # -> []

# 3+4. No role assignment survives at ANY scope (subscription Reader, or the
#      tfstate-dev container blob-data role). --all, not a scoped list.
az role assignment list --assignee '<retired-plan-sp-object-id>' --all -o tsv            # -> nothing

# 5. No federated credential anywhere still names the retired environment.
for APP in $(az ad app list --query '[].appId' -o tsv); do
  az ad app federated-credential list --id "$APP" \
    --query "[?contains(subject,'environment:development-infra-plan')].subject" -o tsv
done                                                                                      # -> nothing
```

And the GitHub side:

```bash
gh api "repos/<owner>/<repo>/environments/development-infra-plan"    # -> HTTP 404
```

- **Branch A — every command above returns empty / 404:** check passes. Record
  the outputs per §3.7.
- **Branch B — anything is still present:** **do not set
  `DEV_TF_BACKEND_READY=true`.** A surviving federated credential plus a
  re-creatable (and auto-created-_unprotected_) GitHub Environment is a live
  token-minting path for a principal nothing in the repo describes any more.
  Finish §3 first.

### B9 — Are BOTH apply environments explicitly created AND protected?

**This is the check that stops a protection rule from being a decoration.**
`infra-apply-dev.yml` binds `environment: development-infra-apply` on the apply
job and `environment: development-infra-apply-recovery` on the `recovery_approval`
job. If either environment does not exist, GitHub **auto-creates it on first
reference with no protection rules at all** — the run then proceeds, and the
workflow file still reads as though a gate stood in front of it. Nothing turns
red. That is the failure mode this check exists for, and it has two distinct
consequences:

- an unprotected **`development-infra-apply`** loses its `main`-only deployment
  branch policy, so any ref that reaches the workflow can mint a token for an
  identity holding Contributor + conditioned RBAC Administrator on the dev RG;
- an unprotected **`development-infra-apply-recovery`** makes the approval in
  front of a destructive, `authorized_changes`-bearing recovery apply pass
  instantly and silently.

Bootstrap (step 1) creates **both** explicitly — the branch policy on each, the
required reviewer on the recovery one — and reads the rules back, reporting
`PROTECTED` / `UNPROTECTED` / `UNVERIFIED` for each. **`DEV_TF_BACKEND_READY` may
not be set true until BOTH report `PROTECTED`.** Confirm yourself before
activation:

```bash
REPO='<owner>/<repo>'

# (a) development-infra-apply — main-only branch policy, and NO required reviewer.
gh api "repos/$REPO/environments/development-infra-apply" \
  --jq '{policy: .deployment_branch_policy,
         reviewers: [.protection_rules[]? | select(.type=="required_reviewers")] | length}'
# -> policy must be non-null (custom/protected branches limited to `main`)
# -> reviewers MUST be 0. A reviewer here gates the AUTOMATIC apply and stalls
#    reconciliation — see §10, "Concurrency".
gh api "repos/$REPO/environments/development-infra-apply/deployment-branch-policies" \
  --jq '.branch_policies[].name'
# -> exactly: main

# (b) development-infra-apply-recovery — main-only AND a live required reviewer.
gh api "repos/$REPO/environments/development-infra-apply-recovery" \
  --jq '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]?] | length'
# -> must print a number >= 1. Empty, 0, or a 404 is a FAILED check.
gh api "repos/$REPO/environments/development-infra-apply-recovery/deployment-branch-policies" \
  --jq '.branch_policies[].name'
# -> exactly: main
```

- **Branch A — bootstrap reported `PROTECTED` for both** (`gh` was installed and
  authenticated): the commands above agree. Check passes. Note that bootstrap
  sets `prevent_self_review: false` deliberately on the recovery environment, so
  a solo maintainer can approve their own recovery run; the gate is "a human
  deliberately clicked", not "a second person exists".
- **Branch B — either reported `UNVERIFIED` or `UNPROTECTED`** (`gh` stopped
  working part-way through the run, or a PUT failed — a `gh` that was
  unauthenticated at the *start* aborts the run before this point, see step 1):
  bootstrap prints a blocking banner with the exact `gh api` commands. Run them,
  then re-run the verification above. `UNVERIFIED` is **not** a pass — it means
  nobody has looked.

> **`DEV_TF_BACKEND_READY` must not be set true until BOTH environments pass.**
> This is the only pre-activation check whose subject is a GitHub protection rule
> rather than an Azure permission, which is exactly why it is easy to skip: no
> Azure command fails if you do. **Neither environment may be left to GitHub's
> auto-creation.** Re-verify after any change to repository or environment
> settings — an environment deleted in the UI comes back **unprotected** on the
> next run that references it.

### B10 — Do the live federated subjects match the prefix the repo actually presents?

**This is the check whose absence let a subject mismatch reach a live
`azure/login` failure (MG-42).** A federated credential can be present, correctly
named, attached to the right app, and bound to a subject **no GitHub token will
ever carry** — nothing in Azure or GitHub reports that as an error until a
workflow tries to log in and fails `AADSTS700213`. B1–B9 do not look at it.

The `repo:…` head of every subject is the repository's **live sub-claim
prefix**, not `repo:<owner>/<repo>`. This account's org customizes the OIDC `sub`
claim to inject the numeric owner-id and repo-id, so the prefix must be **read**,
never assumed:

```bash
REPO='stevebargelt/meatgeekv2'

# The authority. `sub_claim_prefix` decides the subject where it is present and
# non-empty — `use_default` describes the claim-KEY list and does NOT override
# it. Both may be set at once; on this repo they are.
gh api "repos/$REPO/actions/oidc/customization/sub"
# observed 2026-07-28:
# {"use_default":true,"use_immutable_subject":false,
#  "sub_claim_prefix":"repo:stevebargelt@4857343/meatgeekv2@1304558512"}
```

**Resolve the prefix the way `bootstrap.sh` does — fail-closed.** A one-liner
that defaults to `repo:$REPO` whenever the read does not produce a prefix is
**wrong in the unsafe direction**: it defaults on a 403, a rate limit, an expired
token, a proxy error page — every case that says *nothing* about this
repository's configuration — and then reports MISMATCH against a subject the
repo never presents, which is an invitation to "correct" three healthy live
credentials into the MG-42 outage. `resolve_oidc_subject_prefix()` treats
**exactly one** non-200 answer as a fact (an anchored `404` status line, behind a
proven `gh` session) and aborts on all the rest.

**Reading the response is only half of it.** Bootstrap never assigns
`OIDC_SUBJECT_PREFIX` from a value it has merely *classified*: every candidate —
the API's `sub_claim_prefix` **and** the default it falls back to — goes through
`assert_oidc_subject_prefix()`, which proves the string structurally names the
committed `GITHUB_REPO` before it can become a trust binding. An authenticated
but misrouted or proxied response carrying `repo:attacker/meatgeekv2` is a
perfectly well-formed 200; without that gate the check below would compare three
live credentials against **another repository's** subject and print MATCH or
MISMATCH about the wrong trust root, where bootstrap aborts. The helper mirrors
both halves — fetch/classify, then prove:

```bash
# Mirrors assert_oidc_subject_prefix() in apps/infrastructure/bootstrap/bootstrap.sh.
# THE GATE: everything the fetch does is CLASSIFY the response; this is the half
# that PROVES the answer names the repository you asked about. Refuses by return,
# never exit, so a bad answer does not kill an interactive shell.
#
# `$REPO` plays the role bootstrap's committed GITHUB_REPO constant plays: it is
# the trust root, and its authority comes from YOU having typed it at the top of
# this section. Never re-derive it from the response — a gate whose expectation
# comes from the thing it is checking proves nothing.
oidc_assert_subject_prefix() { # <prefix> <owner/repo> <origin>
  local prefix="$1" repo="$2" origin="$3"
  local want_owner="${repo%%/*}" want_repo="${repo##*/}"
  local rest got_owner got_repo id

  [ -n "$prefix" ] || {
    echo "ABORT: the subject prefix resolved EMPTY (${origin}). A subject composed from it would be ':environment:<env>', which matches no token GitHub can mint." >&2
    return 1
  }
  case "$prefix" in
    repo:*/*) ;;
    *) echo "ABORT: the subject prefix '${prefix}' (${origin}) is not of the form 'repo:<owner>/<repo>'. The subject IS the OIDC trust binding, so an unrecognised shape is refused rather than guessed at. Expected a prefix naming ${repo}." >&2
       return 1 ;;
  esac

  rest="${prefix#repo:}"
  got_owner="${rest%%/*}"
  got_repo="${rest#*/}"

  # Strip the OPTIONAL numeric id GitHub injects into either half, each one
  # independently optional. `@` followed by anything that is not all digits is
  # not an id — it is a shape this check does not recognise, and an unrecognised
  # shape is not something to guess at when the answer becomes a trust binding.
  case "$got_owner" in
    *@*) id="${got_owner##*@}"; got_owner="${got_owner%@*}"
         case "$id" in ''|*[!0-9]*)
           echo "ABORT: the subject prefix '${prefix}' (${origin}) has a non-numeric owner id ('@${id}'). Only GitHub's '@<digits>' owner-id/repo-id injection is recognised." >&2
           return 1 ;;
         esac ;;
  esac
  case "$got_repo" in
    *@*) id="${got_repo##*@}"; got_repo="${got_repo%@*}"
         case "$id" in ''|*[!0-9]*)
           echo "ABORT: the subject prefix '${prefix}' (${origin}) has a non-numeric repo id ('@${id}'). Only GitHub's '@<digits>' owner-id/repo-id injection is recognised." >&2
           return 1 ;;
         esac ;;
  esac

  # EQUALITY on the split halves. NOT a regex built from the repo name (the name
  # may contain `.`, a metacharacter, so `meatgeek.v2` would match `meatgeekXv2`)
  # and NOT a contains test (that accepts `repo:attacker/meatgeekv2-fork`, a
  # different repository that CONTAINS the right name). Extra claim segments —
  # `repo:o/r:ref:refs/heads/main`, `:job_workflow_ref:…` — survive into
  # `got_repo` and fail here, which is deliberate and matches bootstrap: the
  # comparison below appends `:environment:<env>` itself, so a prefix already
  # carrying claims would compose a subject nobody designed.
  [ "$got_owner" = "$want_owner" ] && [ "$got_repo" = "$want_repo" ] || {
    echo "ABORT: OIDC TRUST-ROOT MISMATCH — the subject prefix '${prefix}' (${origin}) names '${got_owner}/${got_repo}', not '${repo}'. Comparing the live credentials against another repository's subject would report MATCH or MISMATCH about the wrong trust root; bootstrap dies here rather than provision anything (F16). Do not compare, do not edit a credential." >&2
    return 1
  }
}

# Mirrors resolve_oidc_subject_prefix() in apps/infrastructure/bootstrap/bootstrap.sh.
# A function, so a refusal returns instead of killing an interactive shell.
oidc_subject_prefix() { # <owner/repo>
  local repo="$1" raw status=0 status_line http_code body prefix use_default origin

  # 1. Prove the SESSION, not just the binary. An unauthenticated gh 404s on a
  #    private repo's endpoints exactly like a repo with no customization, so a
  #    404 is only readable as a fact behind this gate.
  gh auth status >/dev/null 2>&1 || {
    echo "ABORT: gh is not authenticated. Run 'gh auth login', then re-check." >&2
    return 1
  }

  # 2. `-i` prints the response STATUS LINE ahead of the body, and that line is
  #    the only authoritative statement of what THIS request returned. gh's exit
  #    status is one bit and its stderr is a human diagnostic: a proxy error page
  #    or an unrelated nested 404 both CONTAIN the text "HTTP 404" while saying
  #    nothing about this endpoint. Match the status ANCHORED, first line only.
  raw="$(gh api -i "repos/${repo}/actions/oidc/customization/sub" 2>/dev/null)" || status=$?
  status_line="$(printf '%s\n' "$raw" | sed -n '1p' | tr -d '\r')"
  http_code="$(printf '%s' "$status_line" | sed -n \
    -e 's|^HTTP/[0-9][0-9.]* \([0-9][0-9][0-9]\)$|\1|p' \
    -e 's|^HTTP/[0-9][0-9.]* \([0-9][0-9][0-9]\) .*$|\1|p')"
  [ -n "$http_code" ] || {
    echo "ABORT: no HTTP status line for this request (gh exited ${status}; first line was '${status_line}') — this request has NO authoritative status, so it cannot be read as 'no customization configured'." >&2
    return 1
  }

  if [ "$http_code" = "404" ]; then
    # The ONE response read as a fact rather than an outage: GitHub's "no
    # sub-claim customization is configured".
    prefix="repo:${repo}"
    origin="HTTP 404 — GitHub reports no sub-claim customization; default prefix"
  elif [ "$http_code" != "200" ] || [ "$status" -ne 0 ]; then
    echo "ABORT: HTTP ${http_code} (gh exited ${status}) — a REAL GitHub error (auth / permission / throttling / network), NOT 'no customization configured'; only an exact 404 means that. Retry or check GitHub status; do not assume a prefix." >&2
    return 1
  else
    # 3. The body is everything after the first blank line the headers ended
    #    with. An empty body is an UNREADABLE prefix, not an absent customization.
    body="$(printf '%s\n' "$raw" | tr -d '\r' | awk 'seen { print; next } /^$/ { seen = 1 }')"
    [ -n "$body" ] || {
      echo "ABORT: HTTP ${http_code} with an EMPTY body — the prefix is unreadable, which is not 'no customization configured'." >&2
      return 1
    }
    use_default="$(printf '%s' "$body" | jq -r '(.use_default // false) | tostring')" \
      && prefix="$(printf '%s' "$body" | jq -r '.sub_claim_prefix // ""')" || {
      echo "ABORT: the response is not parseable JSON, so it cannot be read as 'no customization configured' either. Body: ${body}" >&2
      return 1
    }

    # 4. THE AUTHORITY: a present, non-empty sub_claim_prefix decides the subject
    #    whatever use_default says — on this repo use_default is `true` alongside
    #    the custom prefix, and letting it win here is the MG-42 outage. `// ""`
    #    already turns a JSON null into the empty string; the literal "null" test
    #    catches the other spelling, a STRING "null" configured by hand.
    if [ -n "$prefix" ] && [ "$prefix" != "null" ]; then
      origin="sub_claim_prefix read from repos/${repo}/actions/oidc/customization/sub (use_default=${use_default}, which describes the claim-KEY list and does not override it)"
    elif [ "$use_default" = "true" ]; then
      # No prefix AND use_default=true is the only "default" the 200 path
      # accepts — both halves required.
      prefix="repo:${repo}"
      origin="use_default=true with no sub_claim_prefix; default prefix"
    else
      # use_default=false with no readable prefix is GitHub positively stating a
      # customization exists whose prefix cannot be read; that says exactly as
      # much about the subject as a 403 does, and aborts for the same reason.
      echo "ABORT: use_default=false with NO readable sub_claim_prefix — a customization GitHub says exists but whose prefix is unreadable. Falling back here would rewrite all three credentials to a subject no token carries (AADSTS700213). Body: ${body}" >&2
      return 1
    fi
  fi

  # 5. THE GATE, on EVERY path — the API's answer and the default alike, exactly
  #    as bootstrap gates both before assigning OIDC_SUBJECT_PREFIX. Classifying
  #    the response says the read succeeded; it says nothing about WHICH
  #    repository the string names.
  oidc_assert_subject_prefix "$prefix" "$repo" "$origin" || return 1
  printf '%s\n' "$prefix"
}

PREFIX="$(oidc_subject_prefix "$REPO")" \
  || echo "STOP: the prefix did not resolve. B10 CANNOT be evaluated — do not compare, do not edit any credential, do not set DEV_TF_BACKEND_READY. See branch C below."
echo "$PREFIX"
```

Then compare, **for all three federated identities**, the subject each
credential actually carries against `$PREFIX:environment:<env>`:

```bash
check() { # <app-display-name> <cred-name> <github-env>
  # An unresolved PREFIX would compare against ':environment:<env>' and report
  # three spurious MISMATCHes — the same refusal federated_environment_subject()
  # makes rather than composing a subject from an empty prefix.
  [ -n "$PREFIX" ] \
    || { echo "PREFIX unresolved — refusing to compare (see branch C)"; return 1; }
  # ALL matches, never [0]: Entra display names are NOT unique, and silently
  # picking one of two same-named apps is the ambiguity bootstrap dies on.
  APP_ID="$(az ad app list --display-name "$1" --query '[].appId' -o tsv)"
  [ "$(printf '%s\n' "$APP_ID" | grep -c .)" = 1 ] \
    || { echo "AMBIGUOUS/ABSENT $1: [$APP_ID] — resolve before continuing"; return 1; }
  GOT="$(az ad app federated-credential list --id "$APP_ID" \
    --query "[?name=='$2'].subject | [0]" -o tsv)"
  WANT="${PREFIX}:environment:$3"
  [ "$GOT" = "$WANT" ] && echo "MATCH   $2" \
    || echo "MISMATCH $2: live='$GOT' expected='$WANT'"
}

# Display names are bootstrap's defaults; if you overrode AAD_APP_NAME /
# AAD_DEPLOY_APP_NAME / AAD_INFRA_APPLY_APP_NAME, substitute yours.
check meatgeek-v2-github-infra-apply github-infra-apply-development-infra-apply development-infra-apply
check meatgeek-v2-github-appdeploy   github-appdeploy-development              development
check meatgeek-v2-github-oidc        github-production                         production
# -> all three must print MATCH. Any MISMATCH — or AMBIGUOUS/ABSENT — is a
#    FAILED check.
```

- **Branch A — all three `MATCH`.** Check passes. The subjects the credentials
  carry are the subjects GitHub will present.
- **Branch B — any `MISMATCH`.** **Do not hand-edit the credential, and do not
  set `DEV_TF_BACKEND_READY`.** Re-run `./bootstrap.sh`: it resolves the prefix
  from this same endpoint and reconciles each credential **on subject** —
  no-op if the subject matches, delete-and-recreate if it has drifted — so the
  re-run is the repair. Then re-run the comparison. If bootstrap
  aborts instead, read which abort class it reports — the remediations differ
  (see [the runbook's precondition table](bootstrap-runbook.md#preconditions-that-abort-before-anything-is-provisioned));
  a GitHub API outage is **not** an auth problem and `gh auth login` will not
  fix it.
- **Branch C — `oidc_subject_prefix` printed `ABORT`.** The check is
  **not evaluated** — neither passed nor failed — because the subject the
  repository presents is unknown. **Change nothing**: do not compare, do not
  hand-edit a credential, do not re-run `./bootstrap.sh` expecting a repair (it
  reads the same endpoint and aborts in the same class, before provisioning
  anything). Remediate by the class the message names — they map one-to-one onto
  [the runbook's precondition table](bootstrap-runbook.md#preconditions-that-abort-before-anything-is-provisioned)
  — then re-run the resolver. `DEV_TF_BACKEND_READY` stays unset until B10 has
  actually produced three `MATCH`es.
  - **`OIDC TRUST-ROOT MISMATCH` is the one abort in this set that is not a
    retry.** The read *succeeded*; the answer named a **different repository**
    (or a shape that is not a plain `repo:<owner>/<repo>` with GitHub's optional
    `@<digits>` ids). Retrying and re-authenticating change nothing. Bootstrap
    refuses the same value for the same reason, so the remediation is the
    runbook's trust-root row — a **reviewed edit to `GITHUB_REPO`** in a commit
    if the repository genuinely moved or you forked it, and otherwise an
    investigation of why this endpoint answered for another repository at all.

> **The trap this check exists to close.** A live credential whose subject does
> **not** look like `repo:stevebargelt/meatgeekv2:environment:<env>` is almost
> certainly **correct** on this account. Older revisions of this document and the
> runbook published that un-prefixed form as the expected value; an operator
> comparing the live tenant against it concludes the credentials are
> misconfigured and "corrects" them back — which is precisely the outage. The
> expected value is `$PREFIX:environment:<env>` computed from the API **at the
> time you check**, never a string copied out of a document.

---

## 6. Running the acceptance tests

Prerequisites: §4 path chosen; the apply SP created (step 1); the GUIDs
committed and bootstrap re-run (step 2); the **state migration done (§1 step 4),
both Class 1 and Class 2** — otherwise every test that plans the real graph sees
the pending budget destroy, or the nine `principal_type` replacements, and the
destroy guard fails for a reason that has nothing to do with the test.
Run the tests **as the apply SP**.

**T1 must run through TERRAFORM, never through `az`.** The `az` CLI always sends
`principalType`, so an `az`-based T1 **false-greens B1** — it would prove the
condition accepts a request shape the provider may never send. T2–T5 use `az`
deliberately: there we are probing the condition itself, and an explicit,
attacker-shaped request is exactly what we want to send.

Use a scratch directory (`/tmp/mg23-acceptance/`) with its **own local state**
for T1 so nothing touches `meatgeek-v2/dev.tfstate`. Target a throwaway
principal you control for the grantee — the simplest safe choice is the apply
SP's **own object id** (a self-grant of a data role is harmless and is deleted
in T4).

**Preflight: resolve `$SUB` and `$APPLY_SP_OBJECT_ID` here, and assert them.**
Every test below splices both into a scope or an assignee. Unset, they do not
make the tests fail — they make the tests **pass wrongly**. A scope of
`/subscriptions//resourceGroups/meatgeek-v2-dev-rg` is malformed, Azure rejects
it, and T2, T4a and T5 print `rejected (expected)` on that rejection exactly as
they would on a real condition denial. The core escalation test would report
success having probed nothing at all — the one false green this section cannot
afford, because its outcome is what unblocks activation.

```bash
SUB="$(az account show --query id -o tsv)"
APPLY_SP_OBJECT_ID='<apply-sp-object-id>'   # az ad sp list --filter "appId eq '<APPLY-APP-ID>'" --query '[].id' -o tsv

# The gate each mutating T-block calls. A function, so a refusal returns instead
# of killing the scratch-job shell mid-suite.
t_ready() {
  [ -n "$SUB" ] && [ -n "$APPLY_SP_OBJECT_ID" ] && return 0
  echo "REFUSING: \$SUB / \$APPLY_SP_OBJECT_ID unresolved — a T-test run now probes a malformed scope and reports 'rejected (expected)' for the wrong reason. Re-run this preflight; do not record the result of an ungated run." >&2
  return 1
}
t_ready && echo "preflight OK: sub=$SUB sp=$APPLY_SP_OBJECT_ID"
```

---

## 7. Live acceptance tests T1–T7

| ID  | Proves                                                       | Expected                                    |
| --- | ------------------------------------------------------------ | ------------------------------------------- |
| T1  | All 8 allowlisted roles can be granted **via Terraform**     | PERMIT                                      |
| T2  | Privileged roles cannot be granted at the dev RG             | REJECT                                      |
| T3  | A declared-`ServicePrincipal` grant to a real **user** (B2)  | REJECT (or documented residual)             |
| T4  | Delete is constrained by the same allowlist                  | REJECT non-allowlisted / PERMIT allowlisted |
| T5  | The SP cannot revoke its own Contributor / RBAC-Admin grants | REJECT                                      |
| T6  | Allowlist changes actually reconcile the live condition      | Condition CHANGES                           |
| T7  | Scope reality check — an allowlisted role at RG scope        | PERMIT (accepted, documented)               |

### T1 — PERMIT all 8 allowlisted roles, via Terraform

```hcl
# /tmp/mg23-acceptance/main.tf
provider "azurerm" {
  features {}
  resource_provider_registrations = "none"
}

variable "rg_id"        { type = string }  # /subscriptions/<sub>/resourceGroups/meatgeek-v2-dev-rg
variable "principal_id" { type = string }  # the apply SP's own object id

locals {
  roles = [
    "Azure Event Hubs Data Receiver",
    "SignalR Service Owner",
    "Monitoring Metrics Publisher",
    "Website Contributor",
    "Storage Blob Data Owner",
    "Storage Queue Data Contributor",
    "Storage Blob Data Contributor",
    "Azure Event Hubs Data Sender",
  ]
}

resource "azurerm_role_assignment" "allowlisted" {
  for_each             = toset(local.roles)
  scope                = var.rg_id
  role_definition_name = each.value
  principal_id         = var.principal_id
  principal_type       = "ServicePrincipal"   # matches the graph; see B1
}
```

```bash
cd /tmp/mg23-acceptance
terraform init -backend=false     # LOCAL state only — never the dev backend
if t_ready; then
  terraform apply -auto-approve \
    -var="rg_id=/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg" \
    -var="principal_id=$APPLY_SP_OBJECT_ID"
fi
```

- **Expected:** all 8 assignments created.
- **False green to watch for:** running this with `az role assignment create`
  instead of Terraform. `az` always sends `principalType`; the provider may not
  (B1). An `az`-based pass tells you nothing about whether the real apply works.
- **On failure:** read the error. `RoleAssignmentUpdateNotPermitted`/condition
  failure on **every** role points at B3 (GUID vs path); failure on **one** role
  points at a wrong GUID for that row of the allowlist.

Keep the 8 assignments in place — T4 consumes them.

### T2 — REJECT the privileged roles at the dev RG

```bash
RG="/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg"
if t_ready; then
  for ROLE in "Owner" "Contributor" "User Access Administrator" "Role Based Access Control Administrator"; do
    echo "== $ROLE"
    az role assignment create --assignee-object-id "$APPLY_SP_OBJECT_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" --scope "$RG" \
      && echo "!!! PERMITTED — THIS IS A FAILURE" || echo "rejected (expected)"
  done
fi
```

- **Expected:** all four **rejected** (`AuthorizationFailed`, or an explicit
  condition-not-satisfied error).
- **This is the core escalation test.** A PERMIT on any of the four means the
  condition is not constraining the write action at all — most likely it was
  authored with an empty or malformed GUID list. **Stop activation.**
- **False green:** running these as _yourself_ rather than as the SP. You are an
  Owner; they will all succeed and prove nothing. Confirm the identity first:
  `az account show --query user`.

### T3 — REJECT an allowlisted role granted to a real USER, declared as a service principal

```bash
USER_OBJ="$(az ad user show --id <a-real-user-upn> --query id -o tsv)"
if t_ready && [ -n "$USER_OBJ" ]; then
  az role assignment create --assignee-object-id "$USER_OBJ" \
    --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Owner" \
    --scope "/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg"
else
  echo "REFUSING: user object id unresolved — an empty assignee proves nothing about the PrincipalType clause." >&2
fi
```

- **Expected (Branch A of B2):** rejected — Azure cross-checks the declared
  principal type against the directory.
- **If PERMITTED (Branch B of B2):** the PrincipalType clause is **advisory,
  not enforced**. Delete the assignment immediately, record it in the residuals
  (§10), and note that the RoleDefinitionId allowlist is the only real
  constraint. Activation may proceed — the claim being recorded is the point.
- **False green:** using a _service principal's_ object id here. It must be a
  **user** object id, or the test asserts nothing.

Clean up if it succeeded — with the scope written out, **not** `"$RG"`. `$RG` is
set in T2's block; if you ran T3 on its own it is empty, and an empty `--scope`
does not mean "no scope" to the CLI — it falls back to a broader default, so a
tidy-up delete can act somewhere you never named:

```bash
if t_ready && [ -n "$USER_OBJ" ]; then
  az role assignment delete --assignee-object-id "$USER_OBJ" \
    --role "Storage Blob Data Owner" \
    --scope "/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg"
fi
```

### T4 — DELETE is constrained too

The delete clause is not optional: without it, the identity could revoke the
Function App managed identity's role assignments at RG scope and take dev down
without ever escalating — an **outage primitive**.

```bash
# 4a — REJECT deleting a NON-allowlisted assignment.
# Pick any pre-existing assignment in the RG whose role is not in the allowlist
# (e.g. a Reader or Monitoring Reader grant made by the operator).
az role assignment delete --ids "<NON_ALLOWLISTED_ASSIGNMENT_ID>" \
  && echo "!!! PERMITTED — THIS IS A FAILURE" || echo "rejected (expected)"

# 4b — PERMIT deleting an allowlisted assignment (one of T1's).
if t_ready; then
  az role assignment delete --assignee-object-id "$APPLY_SP_OBJECT_ID" \
    --role "Azure Event Hubs Data Sender" \
    --scope "/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg"
fi
```

- **Expected:** 4a rejected, 4b permitted.
- **If 4a is PERMITTED:** the delete clause is missing or matched nothing —
  check that `build_rbac_admin_condition` emitted **both** clauses and that the
  live condition (`az role assignment list --query "[0].condition"`) contains a
  `roleAssignments/delete` clause. **Stop activation**: an unconstrained delete
  at RG scope is exactly the outage primitive the second clause exists for.
- **If 4b is REJECTED:** the delete clause is too tight — `@Resource` may not
  expose `RoleDefinitionId` as expected. Terraform _destroys_ role assignments
  during normal reconciliation (a count guard flipping off, a resource being
  replaced), so a blanket delete-deny will break future applies. Fix and re-run.

### T5 — REJECT deleting the SP's own privileged grants

```bash
if t_ready; then
  for ROLE in "Contributor" "Role Based Access Control Administrator"; do
    az role assignment delete --assignee-object-id "$APPLY_SP_OBJECT_ID" \
      --role "$ROLE" --scope "/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg" \
      && echo "!!! PERMITTED — THIS IS A FAILURE ($ROLE)" || echo "rejected (expected)"
  done
fi
```

- **Expected:** both rejected — neither role is in the allowlist, so the delete
  clause refuses.
- **If PERMITTED:** the identity can disarm itself (and, combined with T2's
  failure mode, re-arm differently). Worse, it can lock itself out and leave dev
  unreconcilable until an operator restores the grants with `bootstrap.sh`.
  **Stop activation.**

Then run T1's Terraform again to restore the `Azure Event Hubs Data Sender`
assignment deleted in T4b, and finally `terraform destroy` the scratch config to
clean up all 8.

### T6 — Allowlist reconcile regression (the frozen-condition bug)

Proves `ensure_conditioned_role_assignment` actually reconciles rather than
seeing a matching `(assignee, role, scope)` tuple and declaring success while
the live condition stays frozen at its first-ever value.

```bash
RG="/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg"
RBAC_ADMIN="Role Based Access Control Administrator"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ALLOWLIST="$REPO_ROOT/apps/infrastructure/bootstrap/tf-managed-role-allowlist.tsv"

# Capture BOTH the condition and the assignment ID. The id is what proves the
# reconcile was IN PLACE rather than a delete+recreate.
BEFORE="$(az role assignment list --assignee "$APPLY_SP_OBJECT_ID" --scope "$RG" \
  --query "[?roleDefinitionName=='$RBAC_ADMIN'].condition | [0]" -o tsv)"
BEFORE_ID="$(az role assignment list --assignee "$APPLY_SP_OBJECT_ID" --scope "$RG" \
  --query "[?roleDefinitionName=='$RBAC_ADMIN'].id | [0]" -o tsv)"

# AN EMPTY CAPTURE IS NOT A BASELINE, and the comparison below cannot tell the
# difference: `[ "" != "$AFTER" ]` is TRUE, so an unauthenticated or mis-scoped
# read prints "PASS — condition reconciled" having compared nothing — and prints
# it only after bootstrap has already rewritten the live condition. Nothing is
# mutated until the baseline exists.
if t_ready && [ -n "$BEFORE" ] && [ -n "$BEFORE_ID" ]; then
  # Add a 9th role to the allowlist TEMPORARILY (do not commit this):
  printf 'Monitoring Reader\tPENDING\n' >> "$ALLOWLIST"
  # Subshell: the re-run and the revert below both resolve paths from the repo
  # root, so this must not leave you sitting in the bootstrap directory.
  (cd "$REPO_ROOT/apps/infrastructure/bootstrap" && ./bootstrap.sh)   # as the operator, not the SP
else
  echo "REFUSING: no baseline condition/id captured — T6 would report PASS against an empty BEFORE. Fix the read first; the allowlist is untouched." >&2
fi

AFTER="$(az role assignment list --assignee "$APPLY_SP_OBJECT_ID" --scope "$RG" \
  --query "[?roleDefinitionName=='$RBAC_ADMIN'].condition | [0]" -o tsv)"
AFTER_ID="$(az role assignment list --assignee "$APPLY_SP_OBJECT_ID" --scope "$RG" \
  --query "[?roleDefinitionName=='$RBAC_ADMIN'].id | [0]" -o tsv)"

[ "$BEFORE" != "$AFTER" ] && echo "PASS — condition reconciled" || echo "FAIL — condition frozen"
[ "$BEFORE_ID" = "$AFTER_ID" ] && echo "PASS — same assignment, updated IN PLACE" \
                              || echo "FAIL — assignment was delete+recreated (no-grant window)"

# Revert the allowlist and re-run bootstrap to restore the 8-role condition.
# The path is ABSOLUTE via $REPO_ROOT because `git checkout -- <pathspec>`
# resolves against your CWD: the repo-relative form run from inside the bootstrap
# directory fails with "did not match any file(s) known to git", exits non-zero,
# and reverts NOTHING — after which an unconditional re-run would re-apply the
# NINE-role condition you just finished proving, leaving the apply identity's
# allowlist permanently widened while the log reads as a clean revert. So the
# revert has to succeed before the restore re-runs.
if git checkout -- "$ALLOWLIST"; then
  (cd "$REPO_ROOT/apps/infrastructure/bootstrap" && ./bootstrap.sh)
else
  echo "STOP: allowlist revert FAILED — do NOT re-run bootstrap; it would re-apply the 9-role condition. Restore $ALLOWLIST by hand, confirm with 'git diff --exit-code', then re-run bootstrap." >&2
fi
```

- **Expected:** the live condition **changes**, then changes back — and the
  **assignment id is identical throughout**. Both assertions must pass.
- **Why the id check matters:** the reconcile must be an in-place
  `az role assignment update`, never a delete+recreate. A changed id means the
  grant was momentarily **absent**, which is the window that can strip the apply
  identity's RBAC-administrator grant mid-write if a bootstrap re-run overlaps an
  automatic CI apply. Condition-changed alone would pass for both
  implementations, so it is not sufficient evidence.
- **False green:** comparing the _emitted_ condition instead of the _live_ one.
  Read it back from Azure, as above.
- **`jq` is a STARTUP PREFLIGHT requirement, not a late check on this path.**
  `require_tools` runs at the top of `main()`, ahead of every provisioning call,
  and verifies it before anything is mutated — so a missing `jq` is a clean
  no-op failure at the _top_ of the run
  rather than an abort partway through the reconcile. If bootstrap dies naming
  `jq`, install it and re-run; do not read it as a T6 failure.
- Note `tf-static-checks.sh` check 13 will (correctly) fail while the 9th role
  is in the file and not in the graph — that is the check working, not a
  problem. Do not commit the temporary row.

### T7 — Scope reality check (documented, accepted behaviour)

```bash
if t_ready; then
  az role assignment create --assignee-object-id "$APPLY_SP_OBJECT_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Owner" \
    --scope "/subscriptions/$SUB/resourceGroups/meatgeek-v2-dev-rg"
fi
```

- **Expected: this SUCCEEDS**, and that is **accepted, documented behaviour**,
  not a failure. An ABAC condition constrains **which** role and **which**
  principal type — it **cannot** constrain **where**. Capture the output as
  evidence for residual **F4** (§10).
- Delete the assignment afterwards.

### Evidence to capture for T1–T7

For each test: the command, the identity it ran as (`az account show --query
user`), the raw result (permitted/rejected + the Azure error code), and the live
condition string read back from Azure at the time. Store it with the MG-23
ticket. **Redact nothing except the subscription id and object ids** — the point
of the record is that someone can later tell whether the control was ever
actually verified.

---

## 8. Activation

Only after **every** B-check (B1–B10) is resolved and T1–T7 pass (with T3/T7
outcomes recorded either way). Four of them are easy to leave un-run because
nothing fails while they are outstanding — confirm all four explicitly here:

- **B7** — branch protection on `main` is tightened. Without it, a direct push to
  `main` is an unreviewed apply.
- **B8** — the retired dev plan identity is **decommissioned** (§3), verified:
  no app, no service principal, no role assignment at any scope, no federated
  credential naming the retired environment, and the GitHub Environment returns 404. Without it, the pull-request-reachable read path into `tfstate-dev` that
  MG-23 claims to have removed is still live in the tenant.
- **B9** — **BOTH** `development-infra-apply` **and**
  `development-infra-apply-recovery` report `PROTECTED`:
  `development-infra-apply` with a `main`-only deployment branch policy and **no**
  required reviewer; `development-infra-apply-recovery` with a `main`-only policy
  **and** a live required-reviewer rule. **Neither may be left to GitHub's
  auto-creation**, and `DEV_TF_BACKEND_READY` may not be set true until both
  verify. Without this the recovery approval passes everything and the apply
  environment's branch restriction does not exist.
- **B10** — all three federated credentials carry the subject the repository
  **actually presents**, compared against
  `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` rather than
  against any string in this document. Without it, a credential can be present
  and correctly named while binding a subject no token matches; nothing turns
  red until the first `azure/login` fails `AADSTS700213` — with
  `DEV_TF_BACKEND_READY` already true and the apply loop live.

```bash
gh variable set DEV_TF_BACKEND_READY --body true    # REPOSITORY scope — see §2
```

To **deactivate** (any time, no code change): set it to `false` or delete it.
Every MG-23 job then skips cleanly — a skipped job, never a red one — and dev
returns to MG-24 operator-run reconciliation. This is the intended emergency
stop; use it before you start debugging a misbehaving apply.

---

## 9. AC7 — proving the loop

The proof must be a **representative, reversible, in-place** change. A tag
addition is ideal: it touches nearly every resource, destroys nothing, and
reverts cleanly.

### 9.1 Forward pass

1. **Branch and change** — in `apps/infrastructure/main.tf`, add one entry to
   `locals.common_tags`:

   ```hcl
   common_tags = {
     Project     = "MeatGeek V2"
     Environment = var.environment
     ManagedBy   = "Terraform"
     Repository  = "stevebargelt/meatgeekv2"
     GitOps      = "MG-23"     # AC7 loop proof — reverted in 9.2
   }
   ```

2. **Open the PR.** Expect: **`validate-infrastructure` goes green** — there is
   no deployment approval to wait for, because the PR path binds no environment
   and holds no identity.
3. **Confirm the PR half is credentialless, not merely passing.** In the
   `validate-infrastructure` log:
   - the **"Assert credentialless (no Azure reach)"** step ran **first** and
     passed (no `ARM_*`/`AZURE_*` credential material, no cached `az login`, no
     `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` pair);
   - `terraform init` ran with `-backend=false -input=false -lockfile=readonly`
     — **no backend, therefore no state credential**;
   - `terraform validate`, root `terraform test`, `tf-static-checks.sh`,
     `bootstrap.test.sh`, the destroy-guard fixtures and the per-module
     `terraform test` loop all ran;
   - there is **no** `azure/login` step, **no** `Environment` shown on the job,
     and no plan output — because no plan is taken.
4. **Read the diff, not a plan.** With no PR-time remote-state plan, the
   pre-merge signal is the diff plus the static checks. The authoritative plan is
   the one taken post-merge in `infra-apply-dev.yml`, against real state, behind
   the secret gate and the destroy circuit-breaker.
5. **Merge to `main`.** CI runs on the push; when it goes green,
   `infra-apply-dev.yml` fires automatically via `workflow_run`.
6. **Observe the apply run** and confirm, in order:
   - the **stale-SHA guard** ran **before `azure/login`** and printed
     `pinned to:` / `current main:` with the two SHAs **equal**, then
     `Pinned commit IS the current main tip — proceeding`;
   - checkout ref equals the **exact CI'd SHA** (`workflow_run.head_sha`), not
     `main`'s tip;
   - `azure/login` used `AZURE_INFRA_APPLY_CLIENT_ID`;
   - `terraform init` ran with `-input=false` and **without `-upgrade`**;
   - the pre-apply secret gate ran and passed;
   - the **destroy circuit-breaker** ran and reported **0 destroys**;
   - the **final freshness gate** (`Re-verify main tip`) ran **immediately before
     apply** and reported `Still the current main tip — applying`;
   - `terraform apply` consumed `tfplan.bin` (never a bare apply);
   - the post-apply **state** secret gate ran and passed (it is **always-run**, not
     success-gated — on a _clean_ apply that distinction is invisible; see
     [§9.4](#94-reading-a-failed-or-partial-apply) for why it matters);
   - the **final drift plan** printed `CONVERGED — post-apply plan reports no changes.`
   - there is **no** `upload-artifact` step and no plan/state JSON in the log.

> **Do not mis-diagnose a clean skip as a failure.** If you merge a second
> change while the first apply is still running, the superseded run reports
> `main advanced past the CI'd commit — this run is SUPERSEDED` and ends
> **green, having applied nothing**. That is the stale-SHA guard working, not a
> broken loop — see [§12](#superseded-runs-the-two-freshness-gates). For a clean
> AC7 proof, merge the forward pass and the revert pass **one at a time** and let
> each apply finish, or you will be reading a skipped run's log looking for a
> `CONVERGED` line that was never supposed to be there.

7. **Confirm in Azure:** `az group show -n meatgeek-v2-dev-rg --query tags` (or
   any resource) shows `GitOps=MG-23`.

### 9.2 Reverse pass

Open a revert PR removing the tag and repeat 2–7. The apply must converge again
and the final drift plan must again report no changes. A loop that only works in
one direction is not reconciliation.

### 9.3 Evidence to capture

- PR URLs (forward + revert) and, for each, the green `validate-infrastructure`
  run showing the credentialless assertion step and the `-backend=false` init
  (there is **no** approval record to capture — the PR path has no environment);
- CI run URL and the apply run URL, with the resolved `head_sha` visible;
- the apply job log showing the six gated steps in order, the destroy-breaker's
  0-destroy line, and the `CONVERGED` line;
- the `az group show --query tags` output before/after each pass;
- the Activity Log entries for the run (see §10, F5 alerts).

Attach to MG-23. Until 9.1–9.3 exist, MG-23's AC7 is **not** met, whatever the
code says.

### 9.4 Reading a FAILED or PARTIAL apply

You will eventually see a red apply run. Read it in this order, because the
steps deliberately do **not** all stop when `terraform apply` fails.

**The post-apply state secret gate is always-run (`if: always()`), not
success-gated and not `!cancelled()`.** A `terraform apply` that fails part-way
through **has already mutated state**: every resource it created before the
failure is written to `meatgeek-v2/dev.tfstate` together with its computed
attributes. A partial apply is therefore _exactly_ the case where a credential
can land in state — and a success-gated inspection would be the one run that
never looks. Inspecting only clean applies inspects only the runs least likely to
have a problem.

`always()` also means the gate runs **on cancellation and on timeout**, which is
the case it most needs to cover. The dominant source of cancellation at this
point in the job is `timeout-minutes: 90` firing, and a timeout kill is not a
clean stop — it is the wedged-mid-write case: a `terraform apply` still holding
the state lease with a partly-written state blob behind it, which is precisely
the state most likely to hold a freshly-computed credential. `!cancelled()`
would skip the inspection exactly there, so it is **not** used on this step. (The
"a rejected recovery deployment should stop everything" reasoning is the _job's_,
and it stays on the job's `if:`; by the time execution reaches this step the
apply has already been authorized and attempted, so there is no approval left to
honour.)

What that does **not** mean:

- **It does not make a failed apply green.** The apply step's own failure already
  reddens the job, there is no `continue-on-error` anywhere on this path, and the
  gate failing adds a second failure rather than replacing the first. Always-run
  means "always **inspect**", never "always **pass**".
- **It does not inspect state a superseded run never touched.** The gate is
  deliberately **not** conditioned on the `freshness` step outputs — a timeout
  kill can land before `freshness_final` ever records an output, and a step
  conditioned on an output that was never written does not run, which would
  reintroduce the same hole one level down. "Did this run touch state at all?" is
  answered _inside_ the step instead, from the runner's actual state: the
  `apps/infrastructure/.terraform/` directory exists only once `terraform init`
  has bound the backend, so its **absence** is positive proof that the run never
  reached a backend and cannot have mutated state (clean exit 0), while its
  **presence** means state was reachable and gets inspected, whatever else the
  run did.

The four outcomes to distinguish in the log:

| Gate output                                            | Meaning                                                                                                                  | Action                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Gate passed, resources listed                          | Mutated state was inspected and holds no credential values                                                               | Fix the apply failure; no disclosure follow-up                                      |
| `No initialized backend in the workspace…`             | The run never bound the backend (it failed or was killed at or before `terraform init`), so it cannot have mutated state | Fix the failure; nothing was written                                                |
| `State holds no resources — nothing was written…`      | The apply failed before writing anything (init/plan-stage failure); nothing could have leaked                            | Fix the apply failure                                                               |
| `Could not read state to inspect it — failing closed.` | **Inconclusive** — state could not be read _at all_, which is not the same as "nothing to see"                           | Treat as a possible exposure until you have inspected state by hand as the operator |

**The final drift plan will also fail after a partial apply — that is correct.**
Half of a plan applied means reality and the tree disagree, which is precisely
what the drift step exists to report. Do not read it as a second, separate
incident, and do not mask it: there is exactly one problem (the failed apply) and
it must be resolved before anything else merges. The emergency stop
(`DEV_TF_BACKEND_READY=false`, §8) is the right move if you need merges to `main`
to stop driving applies while you investigate.

**A red run is a report, not a rollback.** Nothing in this workflow undoes a
committed apply — see the drift-scope residual in §10. Recovery from a partial
apply is an operator action (re-run to converge if the cause is transient, or fix
the graph and merge; the branch-restricted `workflow_dispatch` recovery path
exists for the case where you need an apply without a merge).

---

## 10. Accepted residuals

These are **real, known gaps**. They are accepted deliberately. **The condition
does not cover them, and nothing in this design should be read as claiming it
does.**

### F4 — The condition constrains _which_ role, never _where_

An allowlisted role can be re-granted **resource-group-wide** inside
`meatgeek-v2-dev-rg` — T7 proves this empirically. The practical consequence:
the apply identity (or anyone who compromises the pipeline) can broaden a data
role and obtain **code execution as the Function App's managed identity**.

**Why it is accepted:** this is **persistence and stealth, not a boundary
break** — it does not exceed the apply identity's own Contributor on the same
RG. An attacker who controls the apply identity already controls everything in
that RG; F4 lets them keep that access in a less obvious place.

**Compensating control:** the Azure Activity Log alert on
`Microsoft.Authorization/roleAssignments/write` scoped to the workload RG
(`meatgeek-v2-dev-role-assignment-write`, wired to the existing action group).
This is **detective, not preventive**. If those alerts are removed, this residual
becomes materially worse and the threat model needs revisiting.

### F6 — Cosmos data-plane `sqlRoleAssignments`

`Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments` are granted by
**Contributor**, are **invisible to a `Microsoft.Authorization` ABAC condition**
entirely, and **accept USER principals**. This is the clearest gap versus the
"service principals only" story the condition tells: the apply identity can
grant a _human_ full Cosmos data-plane access and no condition, gate or drift
plan will notice.

**Why it is accepted:** dev Cosmos holds 7-day-TTL test data. **Do NOT** abandon
stock Contributor for a hand-rolled custom role in dev to close this — a custom
role is a large, drifting, poorly-tested surface whose failure mode is a broken
apply, traded against a residual whose worst case is exposure of throwaway test
telemetry. Prod is a different calculation and is MG-25's problem.

**Compensating control:** the Activity Log alert on
`sqlRoleAssignments/write` (`meatgeek-v2-dev-cosmos-sql-role-assignment-write`).

### F17 — `PrincipalType ServicePrincipal` is a weak partition

The clause excludes **humans and groups**. It **cannot** exclude ordinary
application service principals, and **managed identities are not separable from
service principals — they _are_ service principals**. So "SP/MI-only" means
"not a human", not "only the identities this stack created".

**PrincipalId pinning is not a workable substitute:** the Function App's and IoT
Hub's principal ids are **apply-time-computed**, so they cannot be baked into a
condition authored at bootstrap time without a second bootstrap pass that
re-reads them after every recreate — a fragile coupling whose failure mode is a
blocked apply.

**If B2 lands on Branch B**, this residual is strictly worse: the principal type
is then _caller-declared and unverified_, so even the human/group exclusion is
advisory. Record the B2 outcome here when you have it.

### Concurrency: convergence yes, per-commit auditability no

`concurrency: {group: infra-apply-dev-development-infra-apply, cancel-in-progress: false}`
means an in-flight apply is never killed mid-mutation — but GitHub keeps at most
**one pending run per group**, so a burst of merges **silently drops the
intermediate SHAs**. Only the newest queued run executes.

- **Convergence holds _when the surviving run executes_:** it applies the newest
  tree, which is what `main` says the world should look like, and the final drift
  plan proves it. That qualifier is load-bearing — the surviving run only ever
  fires off a CI run that concluded `success`, so a red CI on the newest commit
  leaves the queue-dropped SHAs unreconciled too. See the
  [MG-38 residual](#mg-38--a-superseded-skip-behind-a-red-ci-stalls-reconciliation-silently)
  below.
- **Per-commit auditability does not:** you may **not** conclude "an apply ran
  for commit X" from the fact that X reached `main`. If you need that, check the
  workflow run list, not the commit list.

**The group is on the apply JOB, not the workflow — deliberately.** There is no
workflow-level `concurrency:` block. A job waiting on a deployment protection
rule has _already acquired_ its concurrency group, so a workflow-scoped group
would let a recovery run **parked on a human reviewer** hold the
infrastructure-apply slot indefinitely and stall automatic post-merge
reconciliation — with the dropped automatic runs silent, per the queue-depth-1
behaviour above. Scoping the group to the apply job means the
`recovery_approval` job holds **nothing** while it waits. Once approved,
recovery and automatic applies contend for the **same** group and the **same**
state lease, so they still serialize against `meatgeek-v2/dev.tfstate` — the
mutual exclusion is preserved, only the _parked_ case is released.

> This is why `development-infra-apply` **must not** gain a required reviewer
> (see the [§2 matrix](#2-github-environments--the-protection-matrix)). Adding
> one would re-create exactly this stall one job later, and would also gate the
> automatic apply, which MG-23 rules out. The one required reviewer in MG-23
> belongs on `development-infra-apply-recovery`, and nowhere else.

**A dropped run is not a stale apply.** Queue-depth-1 dropping is a
_completeness_ gap, never a _correctness_ one: the two freshness gates below mean
a run that survives the queue but is no longer `main`'s tip **skips cleanly
rather than applying a superseded tree**.

### MG-38 — a superseded skip behind a red CI stalls reconciliation silently

The freshness gates in [§12](#superseded-runs-the-two-freshness-gates) make a
superseded automatic run **skip cleanly**, which is correct — it must never apply
stale trunk. The convergence claim that pairs with it is bounded, and this
document does **not** claim more than the bound:

> A superseded run skips cleanly; the next reconcile off a **green-required-CI**
> `main` SHA converges. **EXCEPT:** if the superseding commit's CI is **red**, no
> apply occurs for _either_ commit until some later green-CI SHA reconciles.

**Why the gap exists.** `infra-apply-dev.yml` triggers on `workflow_run` filtered
to `conclusion == 'success'`. So the superseded commit skipped by design, and the
superseding commit **never triggered an apply at all**. Both outcomes are
individually correct; together they leave the last applied SHA behind `main` with
**no red job anywhere in the repo** and **no catch-up trigger**. It is a
_fail-safe_ gap — nothing wrong is shipped — but it is a **silent** one, and a
silently stalled GitOps loop reads as a converged one.

**Do not confuse it with the intentionally-blocked case.** If `main`'s tip has
red CI but the last _green-CI_ SHA is already applied, the system is correctly
withholding a bad apply — that is the loop working, not a miss. The
missed-reconciliation condition is specifically: _the latest main SHA with
successful required CI is ahead of the last-applied SHA._

**Why it is accepted for MG-23.** Closing it needs a periodic out-of-band checker
comparing last-applied SHA against latest-green-CI SHA — a new scheduled surface
that MG-23 does not build. It was deferred deliberately, per operator
disposition, as a fail-safe (not wrong-ship, not data-loss) gap.

**Compensating control: none automated today.** Until MG-38 lands, this is a
**manual** check. Both operator-facing surfaces state the bound honestly rather
than promising convergence: the stale-SHA guard's log output names the residual
when it skips, and so does the workflow's step-1 comment. After a red CI on
`main`, **confirm the eventual green SHA actually reconciled** — check the
`infra-apply-dev` run list, do not infer it from the commit list.

**Tracked as MG-38** (`backlog/stories/MG-38-dev-gitops-reconciliation-drift-alert-green-ci-mai.md`):
a scheduled check that alerts (or auto-triggers a catch-up through this same
gated sequence) when a green-CI `main` SHA is ahead of the last-applied SHA, and
that does _not_ false-positive on an intentionally-blocked `main`.

### There is NO PR-time plan — the accepted trade

MG-23 removed the pull-request `terraform plan` against live dev state, together
with the identity that made it possible. The cost is real and is stated here
rather than glossed:

- **A reviewer cannot see the concrete resource diff before merge.** The
  pre-merge signal is the HCL diff plus the credentialless checks
  (`terraform validate`, `terraform test` against mock providers,
  `tf-static-checks.sh`, `bootstrap.test.sh`, the destroy-guard fixtures).
- **The authoritative plan is post-merge**, in `infra-apply-dev.yml`: taken
  against real state under the apply identity, screened by the fail-closed
  pre-apply secret gate and the destroy circuit-breaker, applied as _that exact
  saved plan_, then proven convergent by the final drift plan.
- **Nothing about correctness depends on the missing PR plan.** A destructive
  change that a PR plan would have revealed is refused post-merge by the
  circuit-breaker instead — later, but fail-closed, and the emergency stop
  (`DEV_TF_BACKEND_READY=false`) is one command away.

What is _gained_ is the whole reason for the trade: no pull-request-reachable job
holds an Azure identity, so attacker-supplied PR code has no path to
`tfstate-dev` or the IoT Hub SAS material in it. See §2.

**Do not "restore visibility" by adding a PR plan back.** It cannot be done
without granting a PR-reachable identity read on live state, which re-opens the
disclosure path and drags back every control that was deleted with it (a
dedicated environment, a required reviewer, a read-only-vs-write state-role
argument, and a shared-key bypass to keep closed). That is a threat-model change.

The apply path **does** lock. Every `terraform plan` and `terraform apply` in
`infra-apply-dev.yml` passes `-lock-timeout=5m`, so a contending operation —
another apply that slipped the concurrency group, or an operator planning from a
workstation — **waits** for the lease rather than failing immediately on
`Error acquiring the state lock`. (`terraform init` does not take the lock and
does not carry the flag.)

What you should **not** mis-diagnose during the AC7 proof (§9): an **apply** that
fails with a lock error after ~5 minutes is a real problem — a lease is held
longer than an apply should take. Check for an abandoned run before
force-unlocking, and never `terraform force-unlock` a lease whose holder you have
not confirmed is dead; breaking a live apply's lease is how state corruption
happens.

Prod is deliberately **not** changed by MG-23: [`infra-deploy-prod.yml`](../../.github/workflows/infra-deploy-prod.yml)
still authenticates under the `production` environment as the **prod plan/read
identity**, which therefore **survives** this simplification along with its
write-capable state role (it takes a locked plan). It is `workflow_dispatch`-only
and **not PR-reachable**, so it is not on the boundary MG-23 closed. Narrowing it
belongs with MG-25, where that workflow changes. The asymmetry is stated rather
than smoothed over.

### The final drift plan proves control-plane convergence only

A green `CONVERGED` line means Terraform-**managed control-plane** resources
match the tree. It says nothing about:

- **out-of-band role assignments** (not in state → never in a plan),
- **Cosmos `sqlRoleAssignments`** (F6),
- **managed identities created out of band.**

The compensating controls for all three are the three Activity Log alerts —
detective, not preventive.

**A red drift step is a REPORT, not a rollback.** By the time it runs, the apply
has already executed, so there is nothing for the workflow itself to undo. That is
still the right behaviour — a reconcile that did not converge is not worth calling
green — but note the failure mode it implies. A **benign perpetual provider
diff** (a resource the provider re-plans on every run even when nothing changed)
would turn **every** merge red with nothing downstream to fix.

If that ever happens, **fix it at the resource**: pin the attribute, add the
`ignore_changes` the provider actually needs, or upgrade the provider. Do **not**
weaken the step into tolerating exit 2 — that silently retires the convergence
proof for every future run in order to quiet one resource — and "dev converges"
is the entire claim MG-23 makes.
**No such perpetual diff is known in this stack today** (MG-24's
operator-run applies converged clean), so this is a note for whoever hits the
first one, not a live exception to plan around.

### OIDC token lifetime — a long apply can 401 mid-write

**The mechanism.** The apply job authenticates through `azure/login` with a
federated OIDC assertion: GitHub mints a **short-lived** token for the job, the
login exchanges it once for an Azure access token, and the terraform provider
uses that access token for every ARM call it makes. The GitHub assertion is
**spent** by that exchange. There is nothing left to re-present, so the Azure
access token **cannot be refreshed** for the rest of the job.

**The consequence, stated plainly.** An apply that runs longer than the access
token's lifetime starts getting `401` on its remaining writes. Terraform fails
part-way through, and the stack is left **partially applied** — some resources
created or changed, some not. State is not corrupted (what was written is
recorded), but the tree and reality disagree until the next run reconciles them.

**Accepted for dev, on these grounds:**

- Dev applies complete in **minutes**, comfortably inside the token lifetime.
  MG-24's operator-run applies over this same graph are the evidence.
- The failure is **loud and self-correcting**: the apply step fails, the job goes
  red, the final drift plan never runs, and the next green merge re-applies from
  a fresh token. Nothing is silently skipped.
- The partial-apply case is already covered on the inspection side — the
  post-apply state secret gate is `always()`-run precisely so a failed apply's
  mutated state still gets inspected.

**What `timeout-minutes: 90` does and does not do here.** It bounds a **hung**
apply — one wedged on a lease or a provider retry loop — which would fail
regardless of tokens. It is **not** a token-lifetime control: an apply that
reaches the token's expiry fails on its own, well before 90 minutes, and the
timeout never enters into it. Do not read the timeout as mitigating this.

**Revisit if dev applies ever approach the token lifetime.** The trigger to watch
is apply *duration*, not failure count — by the time a 401 shows up the residual
has already been accepted for too long. If dev grows to that point, the options
are token refresh (re-authenticating mid-job, which needs a second assertion) or
a materially shorter apply timeout paired with splitting the apply. Neither is
warranted at dev's current size; both become warranted together.

> This applies to the **recovery dispatch** path identically — it runs the same
> authentication and the same sequence. A recovery apply parked on its approval
> gate is not affected, because `azure/login` runs *after* the gate clears.

### Provider pinning — RESOLVED, not residual

`apps/infrastructure/.terraform.lock.hcl` **is committed** (azurerm 4.81.0,
azapi 2.11.0, time 0.14.0, with `h1:`/`zh:` hashes for linux and darwin), and
`.gitignore` no longer excludes it. The apply workflow runs `terraform init`
with **`-lockfile=readonly`** and without `-upgrade`, so the lock binds the
provider builds that execute with Contributor + RBAC Administrator.

The two flags are not interchangeable, and the distinction matters when reading
the workflow: omitting `-upgrade` only declines to **ask** for newer providers —
`init` will still amend the lock on its own (a provider missing from it, a
platform hash not recorded). `-lockfile=readonly` is what makes the committed
lock **authoritative**: init **fails** rather than rewriting it. That is the flag
doing the work in the highest-privilege job in the repo, where any rewrite would
be discarded with the runner and no reviewer would ever see the hashes of the
providers that then ran.

**Keep it that way.** Verify at activation:

```bash
cd apps/infrastructure && terraform init -backend=false
git diff --exit-code .terraform.lock.hcl      # must be clean
```

If that diff is ever dirty in CI, a provider resolved outside the lock — treat it
as a supply-chain event, not a formatting nit.

### Dev plan identity — REMOVED from the design, PENDING removal from the tenant

There is no dev plan identity in this design any more. Nothing in the repository
grants it, federates it, or authenticates as it; the environment that selected it
is gone from every workflow.

**That is a statement about the code, not about Azure.** The live app
registration, service principal, subscription `Reader`, `tfstate-dev` blob-data
role, federated credential and `development-infra-plan` GitHub Environment all
survive a code deletion, and **`bootstrap.sh` does not remove them** — it no
longer manages them at all, so re-running it is not a cleanup.

Until **§3** has been executed and **B8** verified, treat the following as a
**live residual**: an unmanaged, still-federated principal with read access to
`tfstate-dev` and the IoT Hub SAS keys in it, reachable by anyone who can
re-create a GitHub Environment that GitHub will auto-create _unprotected_ on
first reference. After §3 and B8, this residual is closed and the verification
outputs are the evidence.

The **prod** plan/read identity is a different principal and is **unaffected** —
it survives, federated to `production` only. Do not decommission it.

---

## 11. F18 — closed escalation paths (load-bearing preconditions)

The apply identity holds **Contributor** and a **conditioned RBAC
Administrator** on `meatgeek-v2-dev-rg` and runs **unattended**. That is an
acceptable blast radius **only** because three escalation paths are closed:

1. **NO Microsoft Graph permissions.** The identity cannot create or modify
   directory objects, so it cannot mint itself a new principal, add a federated
   credential, or manufacture a second identity to grant.
2. **NO subscription-scoped role assignments.** Contributor and RBAC
   Administrator stop at the resource-group boundary. Nothing the apply does
   reaches another resource group or the subscription. (This is also why the
   provider sets `resource_provider_registrations = "none"` and why RP
   registration is an operator precondition — see B5.)
3. **The Terraform state account lives in a SEPARATE resource group**
   (`meatgeek-v2-tfstate-rg`). The apply identity holds only a container-scoped
   `Storage Blob Data Contributor` role on `tfstate-dev`; it is not Contributor
   over the state account and cannot rewrite state's access control to hide its
   tracks. **No pull-request-reachable job holds any state role at all** — read
   or write — because no pull-request-reachable job holds an Azure identity
   (§2). That is stronger than the read-only-plan-identity arrangement it
   replaced, and it is contingent on §3/B8 actually retiring the old principal.

> **The apply identity is NOT the only principal with access to `tfstate-dev`,
> and this design does not claim it is.** The dev **app-deploy** identity also
> holds `Storage Blob Data Reader` on the `tfstate-dev` container
> (bootstrap-managed, granted in `bootstrap_deploy_identity()`, read-only — it
> reads Terraform outputs to resolve publish targets). So dev state — including
> the live IoT Hub SAS material in it — is readable by **two** identities, not
> one.
>
> What MG-23's boundary actually says is narrower and still holds: **no
> pull-request-reachable job holds any state role**. The app-deploy identity is
> bound to the `development` environment and is reachable only from the
> app-publish path, not from attacker-supplied PR code.
>
> **Reviewing that grant, and the protection rules on the `development`
> environment, is MG-36 scope — not MG-23.** MG-23 changes neither. Do not
> "tidy" the app-deploy identity's state access or the `development`
> environment's rules while executing this runbook; if the grant looks
> broader than the publish path needs, that is a finding to record against
> MG-36, not an edit to make here.

> **ANY future change that adds a Microsoft Graph permission, adds subscription
> scope, or moves the state account into the dev resource group INVALIDATES THIS
> THREAT MODEL AND REQUIRES A FRESH ONE.** This is not advisory and it is not a
> tuning knob: the reasoning that makes an unattended apply with RBAC-write
> rights acceptable rests on all three simultaneously. A ticket that needs one of
> them needs a security review first, not a scope widening.

Two automated guards keep the _graph_ honest — but they are graph-only:

- `tf-static-checks.sh` **check 13** — allowlist drift (names only);
- `tf-static-checks.sh` **check 14** — rejects any `azurerm_role_assignment`
  whose scope resolves to a subscription or to an RG other than the workload RG.

The genuinely out-of-RG grants are **bootstrap-managed and invisible to an HCL
scan**; their inventory is asserted in
[`bootstrap.test.sh`](../../apps/infrastructure/bootstrap/bootstrap.test.sh).
If you add a grant outside the workload RG (e.g. B4 branch A), you must add it
to that inventory in the same commit or the bootstrap tests fail — which is the
intended friction.

---

## 12. Recovery limit — CI reconciles; it cannot rebuild

With the apply identity scoped to the resource group, **Terraform can only
ADOPT `meatgeek-v2-dev-rg`** — it cannot create it. `azurerm_resource_group.main`
is in the graph, but creating or recreating the RG is a **subscription-scoped**
operation the apply identity cannot perform.

Therefore:

- If `meatgeek-v2/dev.tfstate` is lost or corrupted, **the GitOps loop cannot
  recover it.** Recovery is an operator action (state restore from the storage
  account's blob versioning/soft-delete, or a re-import).
- If `meatgeek-v2-dev-rg` is deleted, **the GitOps loop cannot rebuild dev.** An
  operator must recreate the RG, re-run `bootstrap.sh` (the RG-scoped grants are
  destroyed with the RG), and run an operator-side apply to repopulate — MG-24
  style — before CI reconciliation resumes.

**"CI reconciles dev infrastructure" does not imply a rebuild capability.** Do
not plan a disaster-recovery exercise on the assumption that a merge to `main`
recreates a deleted environment. It does not.

### The recovery path (`workflow_dispatch`)

`infra-apply-dev.yml` exposes `workflow_dispatch` as a **branch-restricted
recovery entry only** (`main` only). It is not a shortcut: it enters the **same
single apply job**, so it runs the identical
plan → pre-gate → destroy-breaker → apply-saved-plan → post-gate → final-plan
sequence. It differs from the automatic path in exactly three ways:

1. it requires a **manual deployment approval** on
   `development-infra-apply-recovery` — an environment bootstrap creates
   **explicitly**, with its required reviewer, and whose protection **B9**
   verifies before activation. Never rely on GitHub's auto-creation: an
   auto-created environment has no protection rules, so the approval would pass
   instantly while still reading like a gate;
2. it accepts an `authorized_changes` input, which populates
   `TF_DESTROY_GUARD_AUTHORIZED_CHANGES`;
3. when it is **superseded** it **fails** instead of skipping cleanly (below).

**While it waits for your approval it holds no locks.** The approval is carried
by a separate `recovery_approval` job; the infrastructure-apply concurrency group
is acquired by the apply job only _after_ approval. A recovery run left parked
overnight therefore does not stall automatic post-merge reconciliation. Once
approved it serializes against automatic applies normally.

**Use it when:** the automatic run was dropped by the concurrency queue, or the
apply failed transiently, or a merge legitimately requires destructive changes.

**`authorized_changes` is the EXACT SET of ACTION-QUALIFIED change TOKENS** —
not a count, not a bare address, and there is no wildcard, no boolean, no `all`.
Each token is:

```text
<action>:<address>[#deposed=<key>]
```

Read the failing run's destroy-guard output. It prints a **paste-ready token
list** for the plan it just inspected; review every token, then dispatch with
that list comma-separated, e.g.:

```text
delete:module.native_otlp.azurerm_container_app.collector,delete:module.native_otlp.azapi_resource.otlp_dcr
```

**Why the action is part of the token.** `delete:X` destroys X. `forget:X`
drops X out of Terraform management and leaves it running — that is what a
`removed { destroy = false }` block plans, and it is the more dangerous of the
two under MG-23 because _every downstream control stays green_: the post-apply
state gate inspects a smaller state and finds no secrets, and the final drift
plan compares a smaller configuration and reports CONVERGED. A live,
data-bearing resource can be orphaned out of the GitOps loop on a fully green
run. An approval for one action therefore never clears the other, in either
direction.

**Why the deposed key is part of the token.** When a create-before-destroy
replacement fails part-way, Terraform keeps the old object in state as a
_deposed_ object, and the next plan carries a change for the current object
**and a separate change for each deposed one, all sharing a single address**.
Deposed objects are real, live infrastructure holding real data. Keyed on the
address alone they would collapse into one authorization unit — approving the
current object's destroy would silently authorize the deposed ones, and you
would never see them enumerated. Each is listed and authorized individually.

The guard fails unless the plan's protected-change set is **exactly** that set:
a superset fails (the plan grew a change since you reviewed it), a subset fails
(the plan is no longer the plan you reviewed), and a **different set of the same
size fails**. That last case is the reason this is a set and not a count: a
count authorizes an _arity_, and an authorization issued for two disposable
Container Apps would be spent just as happily on the Cosmos account and the IoT
Hub. The tokens are the authorization.

**One protected class `authorized_changes` can NEVER clear: an UNMODELED action
verb.** The gate's modeled vocabulary is exactly `no-op`, `create`, `read`,
`update`, `delete`, `forget` — the complete `resource_changes[].change.actions`
vocabulary of the Terraform plan JSON format. (`replace` is not an action; it is
expressed as the pair `["delete","create"]`, or `["create","delete"]` for
create-before-destroy.) If a plan carries any other verb — a future Terraform
release introducing one, or a hand-edited plan document — the gate cannot
classify it, so it cannot describe what applying it would do, so it refuses to
present it for review. It fails with **exit 1**, and after its normal enumeration
it prints a second block naming the offending addresses with their **full action
arrays** — that second block, headed `carries action verb(s) this gate has no
model of`, is the one that decides the outcome.

> **Do not paste the token list on this failure.** The gate's enumeration runs
> _before_ the unmodeled-verb screen, so a run that ends this way still prints a
> `paste-ready authorization set` above the failure — and that set is **not
> usable**. Feeding it back produces exit 1 again, identically. Read to the
> **bottom** of the output: if the last block names an unmodeled verb, no
> dispatch input will clear the run, and re-dispatching with the pasted tokens
> only burns an approval. This is verified behaviour, not a caution — see the
> transcripts below.

Passing `obliterate:<address>` does not clear it. Neither does passing a
**modeled** verb that the same entry also carries — an entry with actions
`["delete","obliterate"]` is _not_ cleared by `delete:<address>`, even though
`delete:<address>` is exactly what the paste-ready block above the failure will
have offered you. That second case is the one a naive fix misses: the operator
authorizes `delete` in good faith and the apply proceeds while a verb nobody can
reason about rides along.

**Recovery here is out-of-band.** An operator reviews and applies the plan by
hand, and the gate is _taught_ the new verb — its modeled set in
`tf-plan-destroy-guard.sh` plus fixtures in
`apps/infrastructure/scripts/fixtures/` covering it — before the automatic loop
is trusted again. This is deliberately not something a dispatch input can wave
through: an authorization is only meaningful over a change the gate can present
for review.

Both refusals are reproducible **offline, with no credentials**, against the
committed fixtures — run these before trusting the paragraphs above:

```bash
# The unmodeled verb is not clearable under its own verb.
TF_DESTROY_GUARD_AUTHORIZED_CHANGES='obliterate:module.iot_hub.azurerm_iothub.main' \
  bash apps/infrastructure/scripts/tf-plan-destroy-guard.sh \
       apps/infrastructure/scripts/fixtures/destroy-guard-unknown-action.json
# -> exit 1, and NO "DESTRUCTIVE APPLY AUTHORIZED" line.

# Nor under a modeled verb the same entry also carries — note this is the exact
# token the paste-ready block one screen up offers for this plan.
TF_DESTROY_GUARD_AUTHORIZED_CHANGES='delete:module.native_otlp.azurerm_container_app.collector' \
  bash apps/infrastructure/scripts/tf-plan-destroy-guard.sh \
       apps/infrastructure/scripts/fixtures/destroy-guard-unknown-action-composite.json
# -> exit 1, and NO "DESTRUCTIVE APPLY AUTHORIZED" line.
```

Both hold under `dash` as well as `bash`; the gate is POSIX sh and CI runs the
fixture harness under both.

Both retired variables are rejected **on sight** rather than ignored — a stale
form must fail loudly, not silently behave as "nothing authorized":

- `TF_DESTROY_GUARD_EXPECTED_DESTROYS` — the count form.
- `TF_DESTROY_GUARD_AUTHORIZED_DESTROYS` — the action-unqualified address form.

It is deliberately **not** a repository variable: a variable is sticky, and an
authorization left switched on after the merge it was written for would wave
through a later plan nobody reviewed.

**Exit codes.** The guard exits `1` for a _verdict_ (protected changes exist and
are not exactly authorized) and `2` when it could not _inspect_ the plan at all.
The distinction is load-bearing: exit 2 happens before the authorization logic,
so **no override can clear it**. If a routine plan ever produces exit 2, the
GitOps loop is wedged with no in-band recovery — treat it as a bug in the gate,
not as something to override.

### Superseded runs: the two freshness gates

**The hazard.** A queued or slow run applies a tree that is no longer `main`.
Because `workflow_run` runs are queued behind the apply concurrency group, and
because `init` + `plan` + two gates take minutes, `main` can advance _after_ CI
went green and _before_ `terraform apply` starts. Applying then would **roll back
whatever was merged in between**, unattended, and the final drift plan would
cheerfully report `CONVERGED` against the stale tree — a green run that silently
reverted trunk.

`infra-apply-dev.yml` therefore checks the pinned commit against `main`'s tip
**twice**, comparing against a fail-closed 40-hex validation (an unresolvable pin
or tip **refuses to apply** rather than comparing empty strings, which would read
as "fresh"):

| Gate                 | When                                     | Purpose                                                                                      |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Stale-SHA guard`    | **before `azure/login`**                 | A superseded run never mints an OIDC token at all. Uses only the read-scoped `GITHUB_TOKEN`. |
| `Re-verify main tip` | **immediately before `terraform apply`** | Closes the TOCTOU window that `init` + `plan` + the gates open.                              |

**Only a definitive answer decides either gate.** Both resolve `main`'s tip
through the GitHub API, and a transient API failure is not evidence that the run
is stale _or_ fresh. Each lookup therefore retries with backoff (5 attempts,
~37s of waiting at worst) and exits the loop the moment one attempt returns a
well-formed 40-hex SHA. This matters most at the **second** gate: it runs after
the plan and the state lease have been taken, so a single un-retried API blip
there would fail a reconcile _while holding the lease_. If all attempts come back
inconclusive the run **refuses to apply** — fail-closed, because the alternative
is comparing against an empty string, which would read as "fresh".

The residual window is the apply's **own runtime**, which no check can close —
Terraform is mid-write by then, and stopping would be worse than finishing.

**What each trigger does when superseded** — the split is deliberate:

- **Automatic (`workflow_run`) → SKIPS CLEANLY, green.** Nothing is applied.
  There is nothing to alert a human about _at this point_; failing here would
  train people to ignore red on this workflow, which is the one workflow whose
  red must mean something. The next reconcile that runs off a **green-required-CI
  main SHA** converges the tree.

  > **Do not over-read this as "a newer run always reconciles it."** It does not
  > hold when the superseding commit's CI is red — see the
  > [MG-38 residual](#mg-38--a-superseded-skip-behind-a-red-ci-stalls-reconciliation-silently)
  > in §10.

- **Recovery (`workflow_dispatch`) → FAILS, red.** The operator chose a specific
  moment and reviewed a specific plan, **possibly with a destroy authorization
  attached to it**. Silently skipping would leave them believing a recovery ran.
  They must see it refuse and **start a NEW recovery run against current `main`**
  — which re-reviews the plan, and re-issues the `authorized_changes` token set
  against the plan that will actually be applied.

A recovery run that fails either gate applied **nothing**; the message says so
explicitly. Do not "retry" it from the run page — re-dispatch it, so the plan and
the authorization are recomputed against the current tip.

### If the apply job times out

The apply job is bounded at `timeout-minutes: 90`. A timeout does **not**
force-unlock anything, deliberately: `terraform force-unlock` run by automation
is a state-corruption primitive, because it releases a lease whose holder may
still be mid-write and lets the next run interleave against it.

Recovery is an **operator action**:

1. Read the timed-out run's log and determine whether `terraform apply` had
   started. If it had, some resources may have been changed.
2. Confirm no apply is still in flight (check the Actions tab for a running job,
   and the Activity Log for the dev RG for in-progress operations).
3. Inspect the lease on the state blob before touching it:

   ```bash
   az storage blob show \
     --account-name "$(cd apps/infrastructure && scripts/state-account-name.sh "<V2-SUBSCRIPTION-ID>")" \
     --container-name tfstate-dev --name meatgeek-v2/dev.tfstate \
     --auth-mode login --query "properties.lease"
   ```

   A lease still in `status: locked` with no running job is a stranded lock.

4. Only then, with operator credentials, `terraform force-unlock <LOCK-ID>`
   using the ID Terraform printed in the failing run.
5. Re-run through the **recovery dispatch**, not by applying from a workstation
   — the point of MG-23 is that the gated sequence is the only apply path.

---

## 13. Related documents

- [Bootstrap & greenfield acceptance runbook](bootstrap-runbook.md) — the
  operator-run bootstrap and the MG-24 greenfield proof.
- [Terraform setup](terraform-setup.md) — backend, workflow, and local usage.
- [`apps/infrastructure/README.md`](../../apps/infrastructure/README.md) — stack
  layout and the required pre-apply gate.
- [`tf-managed-role-allowlist.tsv`](../../apps/infrastructure/bootstrap/tf-managed-role-allowlist.tsv)
  — the allowlist and why it, not the HCL, is authoritative.
- [MG-24 Flex Consumption ADR](../../learnings/decisions/mg-24-flex-consumption-hosting-model.md)
- [MG-24 App Insights key-in-state ADR](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md)

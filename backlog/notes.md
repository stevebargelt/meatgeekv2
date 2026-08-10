**Last session ended 2026-08-10.**

**Where we left off:** MG-58 shipped across TWO commits and is CLOSED with a full
acceptance-evidence grid. It stopped being "a missing app setting" partway through: the azurerm
provider (v4.81.0) composes and injects a scalar `AzureWebJobsStorage` connection string with an
EMPTY `AccountKey` on every Function App create AND update, and conceals it on read by routing it
into `storage_access_key` — so it is absent from HCL, plan and state BY CONSTRUCTION, it shadows
the identity form the host would otherwise use, and it re-breaks host storage on any future update
for any unrelated reason. The first commit (`e785a74`, PR #42) added the correct
`AzureWebJobsStorage__accountName` setting and SHIPPED A NON-FIX past eleven green checks and two
clean convergence plans — every gate was telling the truth about the configuration while the
deployed site stayed broken. The second (`f21f89f`, PR #43) added the only thing that can see it: a
fail-closed live post-apply gate against the deployed site. All five live proofs pass on evidence
taken after both landed. **MG-53 is now unblocked.**

**Picked up next:**

1. **MG-53 — the Cosmos shared-throughput migration.** `implementation_full`. This is what MG-58
   was clearing the way for, and its blocker is gone. Its topology language was CORRECTED this
   session and that correction is what makes it safe to run: the Function health endpoint is a
   DATABASE-LEVEL reader, the business API routes are NOT Cosmos readers or writers at all, and IoT
   Hub is the only live document writer. Step 7 and its AC now demand two independent proofs —
   `/api/health/cosmos` healthy against the NEW database name, AND live IoT telemetry landing as
   NEW documents in the destination. Neither is evidence for the other. Do not let a plan claim API
   persistence; there is none. MG-54 remains the separate destructive authorization point and must
   not be folded in.
2. **MG-59 — the API persistence gap.** Filed this session, and it must stay sequenced AFTER
   MG-53/MG-54. Implementing it first introduces brand-new writers to the source database exactly
   while MG-53 is copying and reconciling counts, which destroys the reconciliation. It is a
   production-activation blocker (MG-25) and larger than it looks: `libs/azure-client` imports no
   Cosmos SDK, every method is a `console.log` TODO, its `healthCheck()` returns a hardcoded
   `'healthy'`, and no handler imports it at all.
3. **MG-60 and MG-61 — both fell out of MG-58 and both depend on it having landed.** MG-60: whether
   the Flex runtime genuinely needs the Storage Queue Data Contributor grant (a red-wide finding
   objected to pruning it; a prune needs an allowlist edit plus a privileged `bootstrap.sh` re-run
   AFTER the apply). MG-61: `DEPLOYMENT_STORAGE_CONNECTION_STRING`, the provider's SECOND injection,
   found by MG-58's own gate on its first live run — its value has never been inspected.
4. **MG-47's alerting half is still untouched** and remains the ticket's more important failure.
   Four defects are diagnosed and recorded on the ticket. Unchanged from the last two sessions.

**External state to remember:**

- **Dev is healthy and the fix is durable, but understand WHY it is currently clean.** The scalar
  key was removed by a one-time hand-run `az functionapp config appsettings delete` during
  diagnosis. Terraform does NOT and CANNOT remove it. What makes this durable is the committed
  post-apply gate (`apps/infrastructure/scripts/assert-live-host-storage.sh` +
  `.github/workflows/infra-apply-dev.yml`), which remediates ONLY when the key is present and then
  FAILS the run. **A red dev apply naming the live host-storage gate is the system working, not a
  regression** — it means the provider re-injected.
- **Live dev is the MG-58 build published manually as the OPERATOR identity** to
  `meatgeek-v2-dev-func-259d4bf5b628`. EIGHT functions now registered — the seven HTTP ones plus
  `storageHeartbeat`, a permanent 15-minute timer (`0 0,15,30,45 * * * *`). Still not reproducible
  from CI; MG-36 (automated dev app deploy) is still open.
- **`storageHeartbeat` is load-bearing, do not delete it as "just a probe".** A timer cannot fire
  without host storage (schedule state + singleton lease live there), so it is the continuous
  host-storage signal dev otherwise lacks — App Insights emits nothing in dev (MG-37).
- **There is no "Healthy" row to look for.** The platform logs `Process reporting unhealthy` ONLY
  when unhealthy and stays silent when healthy. An acceptance criterion demanding a positive Healthy
  row is unsatisfiable and one was corrected this session. The real positive signals are
  `Host lock lease acquired` (a blob lease IN the host storage account) and a `storageHeartbeat`
  execution — both proof-by-consequence.
- **`func azure functionapp publish` is NOT an injector.** Proven by capturing host-storage setting
  NAMES before and after a publish: identical, `__accountName` only. Terraform's update path is the
  sole injector.
- **Prod inherits the identical injection at its FIRST apply** and a plan-only pipeline cannot see
  it. Recorded in the `infra-deploy-prod.yml` header as an MG-25 activation precondition.
- The MG-21 manual deploy recipe still holds: `npx nx build api` →
  `npm install --omit=dev --ignore-scripts` inside `dist/apps/api` →
  `func azure functionapp publish <fa> --javascript --no-build`. Bare `nx deploy api` does NOT work
  on Flex.
- Dev Function logs live in Log Analytics, NOT App Insights (that is MG-37): workspace
  `meatgeek-v2-dev-logs`, guid `6632bb13-0766-4250-9423-622e00be3482`, 3-5 minute ingestion lag,
  2 GB/day cap (`dataIngestionStatus: RespectQuota`, not currently blocking).
- Terraform init still needs the derived state-account name:
  `-backend-config="storage_account_name=$(bash scripts/state-account-name.sh "$SUB")"` alongside
  `-backend-config=environments/backend-dev.hcl`. `SUB=c7e800cb-0ee6-4175-9605-a6b97c6f419f`.
- **`set -euo pipefail` pasted into an interactive zsh KILLS THE SESSION** (nounset fires on the
  prompt's own expansions). Runbook blocks that begin with it must be saved to a file and run as a
  script, never pasted.
- `az functionapp show --query` returns nulls here — pipe to `jq`. `az account show` reads a cached
  profile — always `az account list --refresh`.
- `~/meatgeek-v1-archive/` (84 MB) is still OFF-REPO and SINGLE-COPY on one Mac.
- Soft-deleted Key Vault `meatgeekkv` auto-purges 2026-11-04. Free, no action.

**Decisions worth not relitigating:**

- **Two fixes for the scalar key were eliminated with evidence, not preference.** Declaring it in
  `app_settings` suppresses the injection on the wire but the read-side concealment makes refreshed
  state permanently disagree with config — a perpetual plan diff that breaks the fail-on-any-drift
  gate every run. A second `azapi` writer would delete the provider's other injected settings,
  because that ARM sub-resource is replace-the-whole-collection. Do not revisit either.
- **The live gate fails the run even after successfully remediating** (operator decision, option A).
  A silent self-heal would reproduce the exact invisibility that let the non-fix ship, and would
  mask a provider upgrade changing the behaviour. Remediation is gated on actual presence so
  ordinary pushes are a no-op.
- **The one-key remediation is a client-side read-modify-write with no ETag.** The ADR now records
  that it NARROWS the collateral-loss window rather than eliminating it — an earlier claim that it
  was hazard-free was wrong and is corrected in place. The workflow asserts the setting-name set
  differs by exactly the removed key.
- **The `~> 4.0` azurerm constraint is deliberately left floating.** The live assertion catches a
  behaviour change in either direction, which beats pinning to a known-buggy version.
- **No role was touched by MG-58** and none should be as a side effect of MG-60: the host acquired a
  blob lease and ran a timer under the existing grants, so the identity's permissions were never the
  problem.
- **The queue-role prune was pulled OUT of MG-58 twice** — once from the assessment, once from the
  plan — and is MG-60. Removing a storage role while repairing storage auth makes any failure
  ambiguous between the two changes.

**Operational notes for driving forge here:**

- **Container agents CANNOT read ticket bodies.** `backlog/*.md` is stale and the DB is unreachable
  from inside the container, so the `--brief` passed to `forge new` is the ENTIRE contract, and it is
  frozen at run creation. Editing a ticket mid-run reaches nobody. The `request-changes` gate
  rationale is the only channel that reaches the next agent — an `advance` rationale does not (a
  build pass rewrote `backlog/notes.md` against an explicit advance-gate instruction).
- **The feature pipeline commits onto local `main`.** It did so on both MG-58 runs. Branch the work
  off and `git branch -f main origin/main` before pushing.
- **A fix pass on a multi-step plan reliably fans out into children that duplicate each other's work
  and then collide** (`integration_blocked`), twice on MG-58. "Do it in one pass" in the rationale
  does not bind the fanout. Recovery is cheap: every child publishes its own branch, so compare them
  and take the strongest — both times one child was a strict superset.

**Shipped (for reference):**

- **MG-58** — dev Function host storage now authenticates by managed identity; the provider's
  re-injection is caught by a committed fail-closed live post-apply gate that remediates and fails
  loudly. Two commits: `e785a74` (PR #42) and `f21f89f` (PR #43). Closed with an evidence grid.
- **MG-59, MG-60, MG-61** — FILED this session, none started.
- MG-53 / MG-54 topology language corrected; MG-54's unsatisfiable "application reading and writing"
  precondition replaced with evidence for the paths that actually exist.

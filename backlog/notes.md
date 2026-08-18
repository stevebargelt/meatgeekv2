**Last session ended 2026-08-17.**

**Where we left off:** MG-62 (cosmos dev cutover) SHIPPED and CLOSED. The IoT Hub cosmos-storage
routing endpoint and route now address meatgeek-v2-dev-shared-db; the Function App
COSMOSDB_DATABASE_NAME cut over. Merged as a544fd3; applied live via the infra-apply-dev.yml
workflow_dispatch RECOVERY path (run 32083576526) with an operator 3-token destroy authorization.
All four live proofs pass (see the MG-62 Acceptance Evidence grid). The temporary Cosmos Data
Reader grant used for the send-fixture read-back was created and REVOKED; baseline restored (2
assignments, none for the operator identity).

**Picked up next:**

1. **MG-54 — delete the superseded source dedicated-throughput containers and apply the 1000 RU/s
   free-tier account ceiling.** This is the ONLY destructive phase and what stops the source's
   2000 RU/s (the dominant ongoing cost now). Its authorization covers disposing of all synthetic
   documents, including the ones MG-62 and MG-67 wrote. Run it PROMPTLY.
2. **MG-77 — the api-interfaces required check is RED repo-wide.** run-flex-secret-gate-fixtures
   mktemp-stub portability broke on the current GitHub runner (MG-40/MG-44 class). It blocks every
   PR merge and the GitOps auto-apply. MG-62 was override-merged past it with operator authorization
   since it is unrelated + fail-safe. Fix before the next merge that cannot be overridden.
3. **MG-76** — check-20 (and the other infra fixture harnesses') in-lane provability; RF-3's fix
   shipped and was proven manually (12/12 under bash 3.2) but the review lane cannot see the harness
   run, so it settled deferred. Same wall as MG-53 RF-1/RF-2.

**External state to remember:**

- **Cutover applied + converged.** Endpoint databaseName=meatgeek-v2-dev-shared-db (live),
  partition /deviceId, template {deviceid}, identityBased. Post-cutover send-fixture landed 3/3 in
  the destination in 1 poll / 70ms (baseline was source, 3 docs, 2 polls, 5144ms).
- **Account still at 2400 RU/s** (2000 source + 400 destination) until MG-54. Free tier covers the
  first 1000. The source's ~1000 billable RU/s accrues until MG-54 — reason to run it promptly.
- **The MG-62 apply went red BY DESIGN on the MG-58 host-storage gate** (azurerm v4.81.0 injects the
  scalar AzureWebJobsStorage on every Function App update; the gate deletes it and fails the run).
  Remediation held; the rerun's host-storage gate PASSED. Two rerun attempts then failed at PLAN on
  a transient SignalR listKeys network flake ("HTTP response was nil; connection may have been
  reset") — unrelated to the cutover; infra is converged. If GitOps reconciliation stays red on
  SignalR, it may need a look, but it read as transient.
- **No standing Azure permissions.** The temporary Cosmos Data Reader grant pattern (create right
  before a live data-plane read, revoke right after, verify baseline restored) was used again and
  cleaned up. Cosmos account: mgv2-dev-f640e19ae7ab / meatgeek-v2-dev-rg / VSE02
  (c7e800cb-0ee6-4175-9605-a6b97c6f419f).
- **Health-endpoint proof requires an Entra bearer** (scope api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user);
  az account get-access-token from the operator session works (CLI public client is pre-authorized).

**Operational lessons that cost time this session:**

- **Never run forge next synchronously for a phase that dispatches a container** — the 2m Bash
  timeout SIGTERM-swept the verify container (FG-535); it left a result (19/19 passed) that had to
  be reconciled with forge show --reconcile. Launch every phase durably.
- **The migrated feature pipeline build gate is settled by the evidence-led ledger, not verdicts.**
  It needs forge review start/continue against a COMMITTED branch (the pipeline leaves the diff on an
  integration branch — assemble a clean feature branch off origin/main first). Contract lenses must
  be from wide|narrow|frontend|backend|security (the tech-lead wrote "platform"; remap to wide).
- **Acceptance claims for the shipping review** are a bare JSON ARRAY of {ref, verdict, evidence},
  and a "met" claim's evidence must be a structured executed-evidence object (e.g.
  replayed_reproduction {kind, command, output}) — a plain string downgrades to unproven.
- **Environment approvals** for the RECOVERY apply: gh api .../pending_deployments with
  -F "environment_ids[]=<int>". gh run rerun --failed re-runs only the failed job and skips the
  already-approved recovery_approval gate.

**Shipped (for reference):**
- **MG-62** (merge a544fd3; RECOVERY apply run 32083576526) — the live cutover to the shared-throughput
  destination, with a ten-row acceptance-evidence grid. RF-1 accepted_risk authorized the 3 routing
  replaces; RF-3 fix shipped (provability deferred to MG-76).
- **MG-77** (filed) — the repo-wide red api-interfaces required check.

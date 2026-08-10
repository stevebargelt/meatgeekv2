**Last session ended 2026-08-10.**

**Where we left off:** MG-49 is code-complete but deliberately unmerged. PR #44
(`feat/mg-49-cosmos-export-aad-auth`, head `cb7ad5e`) is 11/11 green. Its three commits implement
AAD auth and harden error redaction, split the CI tiers, and reconcile docs. Merge remains gated on
a host-executed read-only AAD smoke proving that `DefaultAzureCredential` actually authenticates.

**Picked up next:**
1. Complete MG-49's smoke using the operator decisions below. If it passes, persist the acceptance
   grid, squash-merge PR #44, watch main CI green, and close MG-49 against the merge SHA. If it
   fails, repair PR #44 before merge.
2. Dispatch rescoped MG-53 as `implementation_full`: create the shared-throughput destination,
   reproduce five container definitions, ship import/reconcile and fail-closed comparison tooling,
   then perform the host copy and reconciliation. Nothing may point at the destination when MG-53
   closes.
3. MG-62 performs cutover only after MG-53 evidence is accepted. MG-54 follows MG-62 and remains
   the sole destructive/rollback-ending authorization.
4. MG-59 stays after MG-53, MG-62 and MG-54. Implementing API persistence earlier would create new
   writers during migration and invalidate reconciliation.
5. MG-60 and MG-61 are non-blocking follow-ups. Return to MG-47's alerting half after the migration
   chain; its four diagnosed alerting defects remain untouched.

**External state to remember:**
- MG-49 smoke target is V2 dev account `mgv2-dev-f640e19ae7ab`, database
  `meatgeek-v2-dev-db`, container `temperatures`. This is the honest target because
  `disableLocalAuth: true` forces AAD, and `temperatures` is known nonempty with TTL-bounded live
  telemetry. Use a filtered export, not a full-account export.
- The host orchestrator is explicitly authorized to grant and revoke the signed-in operator
  principal a temporary Cosmos DB Built-in Data Reader assignment
  (`00000000-0000-0000-0000-000000000001`) scoped to
  `/dbs/meatgeek-v2-dev-db`. Record the principal, role-assignment ID, create command, smoke
  command/result, and delete command/result. Wait for propagation; revoke immediately after the
  smoke, whether it passes or fails. No agent container receives Azure credentials.
- Run export and `--verify` into a temporary local directory. Do not commit exported documents or
  expose document contents in logs/artifacts.
- Dev host storage remains healthy under the committed MG-58 post-apply gate. Live dev contains
  the manually published MG-58 build and its load-bearing `storageHeartbeat` timer.

**Decisions worth not relitigating:**
- MG-53/create-copy, MG-62/cutover and MG-54/destruction are separate lifecycle boundaries. Saving a
  review cycle is not grounds to combine them.
- MG-54 is the only ticket allowed to delete the superseded database/containers or apply the
  1000-RU/s ceiling.
- MG-63 records an accepted redaction limitation. Do not reintroduce a benign-key exemption; that
  exemption was weaponizable through quoted key names and caused a live key leak.
- Scope-discovery rule for MG-53: fix inline only when a finding is reachable through the surface
  being introduced or modified, violates an invariant required to ship that phase safely, and has
  a bounded fix in the same component and proof surface. Stop and split when the finding is
  pre-existing/unrelated, changes authority or lifecycle phase, adds live behavior/resources,
  needs an independent review/proof, or can be deferred without shipping an exploitable or
  data-corrupting defect. At the first material discovery, re-baseline scope once and record the
  decision; do not repeatedly absorb findings silently.
- Applied to MG-49: fixing the secret leaks was substantively correct because the modified
  `describeError` path could expose live keys and the AAD work exercised that path. The process
  defect was repeatedly expanding the ticket without an explicit re-scope/split decision after the
  first material finding. MG-53's larger surface should default to splitting.
- MG-64 owns the stale V1 subscription-date statement. Do not guess external subscription state
  from source.
- The current DB-authoritative MG-25 must explicitly carry the MG-58 production-injection
  protection as a hard precondition before first prod apply; do not rely only on MG-58 closeout.

**Shipped (for reference):**
- MG-58 — durable managed-identity host-storage repair and post-apply live gate; all five live proofs
  passed after both commits landed.
- MG-51 — Terraform-owned Cosmos database name plus deployed API-level health proof.
- MG-40 — portable mktemp-failure fixture restored the local review lifecycle.

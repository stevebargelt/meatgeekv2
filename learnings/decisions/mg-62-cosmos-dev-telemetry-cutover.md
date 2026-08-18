# The IoT Hub Cosmos routing endpoint and the Function App's `COSMOSDB_DATABASE_NAME` are repointed onto the MG-53 shared-throughput destination as a matched set, and `tf-static-checks` check 20 is re-keyed to resolve its target through the root wiring instead of a pinned resource label

- **Status:** Accepted (config-only; no live apply — the automated dev GitOps
  apply that follows merge to `main` is the actual cutover event, not a later
  manual step; see _Honest boundary_)
- **Date:** 2026-08-17
- **Ticket:** MG-62 (cut over dev telemetry to the shared-throughput Cosmos
  database). Follows MG-53 (create the destination, create-only) and precedes
  MG-54 (delete the source), neither of which is in scope here.
- **Scope:** `apps/infrastructure/main.tf` (`module.iot_hub`'s
  `cosmos_database_name`, `cosmos_container_name`, `cosmos_database_id` and
  `cosmos_container_id`; `module.azure_functions`'s `cosmos_database_name`),
  `apps/infrastructure/scripts/tf-static-checks.sh` (check 20's resolution
  chain and its module-directory scoping), and
  `apps/infrastructure/scripts/fixtures/run-iothub-cosmos-partition-key-fixtures.sh`
  (mutation cases for the resolved destination container, unresolvable wiring,
  a renamed output, and a same-labeled container in an unrelated module).

## Context

MG-53 created the shared-throughput destination database and five
definition-faithful `*_shared` containers but left them **unwired**: the IoT
Hub Cosmos routing endpoint and the Function App still addressed the source
database and its `temperatures` container via
`module.cosmos_db.database_name` / `container_names.temperatures` /
`database_id` / `container_ids.temperatures`. MG-53's own ADR named the
repoint as future work and flagged, by name, that `tf-static-checks` check 20
(MG-73) keyed on the literal resource label
`azurerm_cosmosdb_sql_container.temperatures` and was "structurally blind" to
the differently-labeled destination container — a forward gap the backlog
note that opened this ticket carried forward explicitly: once the endpoint's
target moved, the pinned-label check would keep validating the now-orphaned
source container and read green, silently dropping the
authentication-anchored partition guard at the exact moment it started
mattering.

## Decision

Two changes land together, because they are one matched cutover, not two
independent ones:

**1. The five repointed expressions in `main.tf`.** `module.iot_hub`'s
`cosmos_database_name`, `cosmos_container_name`, `cosmos_database_id` and
`cosmos_container_id` all move from the source `module.cosmos_db.database_name`
/ `container_names.temperatures` / `database_id` / `container_ids.temperatures`
to the `destination_*` equivalents in the same commit — never partially, since
a partial repoint (e.g. the database name moved but the container id left on
the source) would silently split the endpoint's database/container pair
across two Cosmos databases. `module.azure_functions`'s `cosmos_database_name`
moves the same way, so the API and the IoT ingest path cannot drift onto two
different database names (MG-51's original guarantee, now pointed at the new
destination). `terraform_data.cosmos_target_ready` (the MG-48 anti-orphan
existence/replacement handle) already depends on and replaces against
whichever container `cosmos_container_id` resolves to, so repointing that one
input is what carries the anti-orphan protection over to the new target — the
handle itself needed no separate change.

**2. Check 20 is re-keyed from a pinned label to wiring resolution**, not
re-pinned to the new label — re-pinning would only defer the identical
forward-gap to the next repoint. The check now follows the same chain the
live endpoint follows: root `main.tf`'s `module "iot_hub"`
`cosmos_container_id` input → the referenced module's output → that output's
map key → the `<type>.<name>.id` it names → that resource's own source
directory, where its `partition_key_paths` is read and compared against the
endpoint's `partition_key_name`. Every hop that fails to resolve (missing
wiring, a renamed or missing output, a target container absent from its own
module, a non-literal `partition_key_paths`) **FAILS** the check rather than
skipping it, preserving the original MG-73 anti-vacuity guarantee.

The resolved label is a bare `type.name`, which is **not unique** across the
whole `INFRA_DIR` — a different module could declare a resource with the same
label. The first version of this change scanned the whole directory tree for
that label, which meant a same-labeled container in an unrelated module could
satisfy the check vacuously even though it was never the endpoint's actual
target. A review round caught this and scoped the lookup to the *resolved
module's own* `.tf` files (`cw_mod_dir`), so a foreign same-labeled block can
neither substitute for the real target nor break the check; a mutation
fixture (`unrelated-module-same-label`) proves the scoped check rejects that
case (see _Honest boundary_).

Config-only: this ticket creates and destroys nothing. No live apply is run
as part of authoring it.

## Consequences

- Once this merges and the automated dev apply converges, the IoT Hub Cosmos
  route and the Function App's Cosmos reads target the shared-throughput
  destination (`meatgeek-v2-dev-shared-db` and its `*_shared` containers)
  instead of the source database's dedicated-throughput containers — dev
  telemetry starts landing in the destination from that point on.
- The source database, its containers, and the synthetic documents currently
  in the source `temperatures` container are untouched by this ticket; MG-54
  disposes of them, not this one. Account-level RU/s stays at the sum of both
  (source + destination) until MG-54 removes the source.
- Check 20 now automatically follows any future repoint of the routing
  endpoint's target container, so this specific class of forward-gap cannot
  recur the next time the wiring moves — a future consumer change no longer
  requires a matching check-20 edit to keep the partition-identity guard live.
- The mutation fixture harness grew from 8 to 12 cases: `resolved-container-drift`,
  `nonliteral-target-paths`, `missing-container-wiring` and `renamed-output`
  prove the new resolution chain fails closed at each hop; the review-round
  addition `unrelated-module-same-label` proves the module-scoping fix.

## Honest boundary

**Verified in this pass, statically, in this environment:**
`bash apps/infrastructure/scripts/fixtures/run-iothub-cosmos-partition-key-fixtures.sh`
passes all 12 mutation checks, including the `clean` case confirming check 20
resolves the endpoint via the root wiring to
`azurerm_cosmosdb_sql_container.temperatures_shared` (database
`azurerm_cosmosdb_sql_database.meatgeek_shared`) rather than the source label.
`bash apps/infrastructure/scripts/tf-static-checks.sh` passes end to end
against the repointed `main.tf`, and its own check 20 line reports the same
resolved destination container and database. `terraform` is not available in
this environment, so `terraform validate` / `fmt` / `test` were not re-run
here — that verification is the CI `validate-infrastructure` job's
responsibility on this PR.

**Not yet verified — pending merge and the automated dev apply that follows
it:** that the live dev apply actually converges against the repointed
wiring, and that a device telemetry message routed after the cutover lands in
the destination's `temperatures_shared` container with the same
authenticated-identity partition contract proven pre-cutover (see the
[MG-67 device fixture verification](../../docs/infrastructure/mg67-device-fixture-verification.md),
§11, MG-62 row). Until that post-cutover document is observed, the repoint is
authored and statically proven, not live-confirmed.

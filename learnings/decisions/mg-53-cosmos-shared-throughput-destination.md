# A newly-created, parallel shared-throughput Cosmos database (`meatgeek_shared`, 400 RU/s at the database level) replaces the source database's per-container throughput model; the source is left untouched and the repoint is a separate ticket

- **Status:** Accepted (authored + static-validated; live creation happens on
  the automated dev apply that follows merge — see _Honest boundary_)
- **Date:** 2026-08-17
- **Ticket:** MG-53 (create the 400 RU/s shared-throughput database and five
  definition-faithful containers). Precedes MG-62 (cutover/repoint) and MG-54
  (delete the source), neither of which is in scope here.
- **Scope:** `apps/infrastructure/modules/cosmos-db/main.tf` (the new
  `azurerm_cosmosdb_sql_database.meatgeek_shared` and five `*_shared`
  containers, plus two corrected comments on the source database and source
  `devices` container), `apps/infrastructure/modules/cosmos-db/outputs.tf`
  (the `destination_*` outputs), `apps/infrastructure/outputs.tf`
  (`cosmos_account_name`, `destination_database_name`), the module's
  `tests/shared_throughput_destination.tftest.hcl`,
  `apps/infrastructure/scripts/cosmos-definition-parity.sh`,
  `apps/infrastructure/scripts/collect-live-shared-throughput.sh`,
  `apps/infrastructure/scripts/assert-live-shared-throughput.sh` and their
  fixture harnesses, and the two new gates wired into `.github/workflows/ci.yml`
  (credential-less fixtures) and `.github/workflows/infra-apply-dev.yml` (the
  live post-create gate).

## Context

The source database, `azurerm_cosmosdb_sql_database.meatgeek`, was created with
no database-level throughput and a comment reading "No throughput at database
level - containers will have individual throughput for minimal usage." Its
`devices` container likewise carried a comment reading "No throughput - will
share from temperatures container." **Both comments describe a mechanism Cosmos
does not have.** There is no way for one Cosmos container to draw on a
sibling container's throughput; the only sharing mechanism is a single manual
or autoscale offer placed on the *database*, which up to 25 containers beneath
it can then share. A database with no database-level offer does not pool
anything — each container that itself declares no throughput silently receives
its own separate 400 RU/s minimum manual offer. With five such containers
(`devices`, `temperatures`, `cooks`, `users`, `recipes`), the source database
was provisioning roughly 2000 RU/s, not the 400 RU/s the comments' authors
evidently intended.

Compounding this, Azure **cannot convert an existing dedicated-throughput
container to shared throughput in place**, and a database created without a
shared offer cannot acquire one later. The existing `meatgeek` database and its
containers cannot be repaired into a shared-throughput shape by editing them.

## Decision

Create a **new, parallel destination** — `azurerm_cosmosdb_sql_database.meatgeek_shared`
(named `${var.resource_prefix}-shared-db`) with a single manual
`throughput = 400`, and five `*_shared` containers (`devices_shared`,
`temperatures_shared`, `cooks_shared`, `users_shared`, `recipes_shared`) that
declare **no** throughput of their own, so all five draw on the one
database-level 400 RU/s offer.

Each destination container is a **definition-faithful twin** of its source
sibling: identical `partition_key_paths`, `partition_key_version`, indexing
policy (included/excluded paths, composite indexes), `default_ttl`, and unique
keys. The only intended differences are the absence of per-container
throughput and the presence of the database-level offer. The composite indexes
are carried over verbatim and are **not** redesigned here even though they may
not all serve the routed envelope's fields well — that mismatch is recorded for
MG-59, not fixed in this ticket.

**This ticket is CREATE-ONLY.** No source resource is edited, replaced, or
repointed, and no consumer (the IoT Hub Cosmos routing endpoint, the Function
App's `COSMOSDB_DATABASE_NAME`) is switched to the destination. The applied
plan adds resources only. The two false comments on the source database and
source `devices` container are corrected in place (comment-only) so the wrong
mental model is not read as intent by a future reader, but the resources
themselves — and their per-container throughput — are unchanged. The
destination's outputs (`destination_database_id`, `destination_database_name`,
`destination_database_throughput`, `destination_container_names`,
`destination_container_ids`, `destination_partition_keys`) are published but
deliberately left **unwired to any consumer**, so MG-62's eventual repoint is a
one-line consumer change rather than a schema change.

### Why the temperatures container's partition key is pinned to `/deviceId`

The destination `temperatures_shared` container's `partition_key_paths` is
`["/deviceId"]`, matching the source and the IoT Hub Cosmos routing endpoint's
`partition_key_name = "deviceId"` (the identity contract settled in MG-73). A
container's partition key path is **create-only** on Azure — it cannot be
repaired after the container exists, so a destination created with the wrong
partition key would have to be rebuilt, not edited. `tf-static-checks` check 20
already guards the *source* contract but keys on the source container's
resource label and is structurally blind to the differently-labeled
`temperatures_shared`; it is not extended to the destination. Two separate nets
guard the destination's partition key instead: the module's
`tests/shared_throughput_destination.tftest.hcl` (a `command = plan` check with
a mocked provider) and `scripts/assert-live-shared-throughput.sh` (the live
post-create gate, described below).

### Verification architecture: a collector/gate seam, mirroring MG-58

Three properties of the destination exist only on live Azure and are invisible
to any config-surface (plan-time) check:

1. Whether the database-level offer actually exists at 400 RU/s.
2. Whether each of the five containers holds **no** dedicated offer of its own
   (`throughput` on `azurerm_cosmosdb_sql_container` is Optional+Computed, so
   an unset value plans as unknown and cannot be asserted true/false at plan
   time — verified against the provider schema; `command = apply` is banned in
   any tftest by `tf-static-checks` check 15, which rules out resolving it in
   a module test either).
3. Whether the destination's five definitions are genuinely faithful to their
   sources as Azure actually materialised them (Azure canonicalises a
   container definition on create — e.g. it drops the `_etag` exclusion from
   the readable indexing policy — so a config-vs-live comparison would produce
   perpetual phantom diffs; the comparison must be live-vs-live).

These are asserted post-create by a two-script seam, split the same way as the
MG-58 host-storage gate:

- **`scripts/collect-live-shared-throughput.sh`** (the collector) holds all
  the Azure coupling: it runs `az cosmosdb sql database throughput show`,
  `az cosmosdb sql container throughput show` per container, and
  `az cosmosdb sql container show` against both the destination and source
  databases, and assembles a single JSON "read-back bundle." A throughput
  probe that exits nonzero is classified `offerFound=false` (the healthy
  no-offer case) **only** when its stderr carries a recognised not-found
  marker; any other nonzero exit (auth, network, throttle, a 5xx) is
  classified `queryOk=false` — "could not tell" is never conflated with "no
  offer."
- **`scripts/assert-live-shared-throughput.sh`** (the gate) is a pure function
  of that bundle — no Azure, no `az`, no credentials — which is what lets it
  run credential-less in CI against fixtures. It asserts all four properties
  (database offer present at 400, no container holds a dedicated offer,
  `temperatures_shared` is on `/deviceId`, all five definitions are faithful
  via `scripts/cosmos-definition-parity.sh`) and reaches PASS only when every
  assertion provably ran to a recognised verdict — never by an assertion that
  silently skipped.
- `.github/workflows/ci.yml` runs three fixture harnesses
  (`run-cosmos-definition-parity-fixtures.sh`,
  `run-assert-live-shared-throughput-fixtures.sh`,
  `run-collect-live-shared-throughput-fixtures.sh`) credential-lessly on every
  PR, each driving the real scripts against canned/fake `az` output.
  `.github/workflows/infra-apply-dev.yml` runs the live collector piped into
  the live gate, `always()`, after the apply step, resolving the account and
  both database names from `terraform output` (never a literal) and failing
  closed — including when the destination was never created by this run (a
  plan-only push), in which case the step is a deliberate no-op rather than a
  false failure.

Throughput is **scoped out** of `cosmos-definition-parity.sh`'s comparison by
design: `az cosmosdb sql container show` does not even return throughput (it
is a separate offer resource), and the source `temperatures` container
carries a dedicated 400 RU/s offer while its destination twin carries none —
that difference is intentional and must never register as a definition diff.

## Consequences

- Provisioning the destination adds roughly 400 RU/s (one shared offer) rather
  than duplicating the source's ~2000 RU/s of dedicated per-container offers,
  once MG-62 eventually repoints consumers and MG-54 removes the source.
- Nothing observable to an operator or a consumer changes as a result of this
  ticket landing: the IoT Hub route and the Function App continue to address
  the source database and its dedicated-throughput containers exactly as
  before. The shared-throughput database exists in the account afterward but
  is inert until MG-62.
- The false "will share throughput" comments no longer exist to mislead a
  future reader into thinking the source database already pools throughput.
- MG-59 (a to-be-designed indexing policy for the routed envelope's actual
  fields) inherits the destination's composite indexes unchanged; they are
  known to not necessarily fit the envelope shape and that is intentionally
  deferred, not resolved, here.

### Honest boundary

**Verified in this pass, statically:** the module change is authored and its
plan-time test (`tests/shared_throughput_destination.tftest.hcl`) asserts the
database-level 400 RU/s offer against a mocked provider; the three fixture
harnesses exercise `cosmos-definition-parity.sh`,
`assert-live-shared-throughput.sh`, and `collect-live-shared-throughput.sh`
credential-lessly against canned/fake `az` output; `tf-static-checks` check 20
continues to guard the source partition-key contract unchanged. `terraform`
is not available in this environment, so `terraform validate`/`fmt`/`test`
were not re-run here as part of this reconciliation pass — that verification
is the CI `validate-infrastructure` job's responsibility on this PR.

**Not yet verified — pending the automated dev apply that follows merge:**
that `azurerm_cosmosdb_sql_database.meatgeek_shared` and its five containers
are actually created against the live dev account, that the live post-create
gate (`assert-live-shared-throughput.sh` fed by `collect-live-shared-throughput.sh`)
passes against that real destination, and that the destination's five
definitions are genuinely faithful to the live source as Azure materialised
it. Until `infra-apply-dev.yml` runs this gate against the live tenant, no
shared-throughput destination has been proven live.

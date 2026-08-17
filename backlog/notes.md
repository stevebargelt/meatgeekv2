**Last session ended 2026-08-17.**

**Where we left off:** MG-53 shipped and CLOSED. The V2 dev shared-throughput destination exists,
was verified live, and the fail-closed gate that certifies it had two fail-open paths closed. The
last operator direction was to work autonomously; the session ended clean with nothing in flight.
**MG-62 (cutover) is the next active work.**

**Picked up next:**

1. **MG-62 — cut over and prove a new post-cutover telemetry document.** Blocked by nothing now.
   Repoints the IoT Hub Cosmos routing endpoint and the Function App `COSMOSDB_DATABASE_NAME` to
   `meatgeek-v2-dev-shared-db`. It inherits MG-67's fixture, its read-back contract, and a
   pre-cutover baseline (3/3 confirmed in 2 polls, 5144ms) that makes a post-cutover failure
   attributable. **Merging MG-62's Terraform IS the cutover** — GitOps applies on merge, so the
   merge is the live event, not a later manual step. Plan the rollback commit before merging.
   - **Carry the check-20 forward gap into MG-62's scope.** `tf-static-checks.sh` check 20 keys on
     the exact resource label `azurerm_cosmosdb_sql_container.temperatures`. Once the endpoint
     addresses the `*_shared` container, check 20 validates the WRONG container and reads green —
     silently dropping the authentication-anchored partition guard at the exact moment it starts
     mattering. Extend it to the container the endpoint actually addresses.
2. **MG-54 — delete promptly** after MG-62. Its authorization covers disposing of all synthetic
   documents, including the MG-73 differential one. This is the only destructive phase and it is
   what stops the source's 2000 RU/s.
3. **MG-76 — the review lane cannot prove a named test ran.** Filed this session. Worth doing before
   the next big review rather than after, since it is why two correctly-fixed findings had to settle
   as `deferred` instead of `resolved`.

**External state to remember:**

- **Account is at 2400 RU/s** — 2000 source (five dedicated offers) + 400 destination. Free tier
  covers the first 1000. The source's 2000 accrues until MG-54; that delay, not the destination, is
  the dominant cost of a slow cutover.
- **The destination is EMPTY and that is CORRECT** — measured `TOTAL=0` across all five containers.
  The 10 synthetic documents remain in the SOURCE deliberately and are MG-54's to dispose of. Do not
  read the emptiness as data loss.
- Source `temperatures` still holds exactly 10 synthetic documents, expiring 2026-08-21..08-23.
  A smaller count later is expected TTL expiry; anything unmarked, or a count ABOVE 10, is a HALT.
- **No standing Azure permissions.** A temporary Cosmos Data Reader grant was created immediately
  before the emptiness count and revoked immediately after; baseline verified restored (2
  assignments, identical ids, no leftover reader). Same pattern for any future live read.
- `main` = `84066e7`, clean, synced, CI green, dev apply converged (`0 added/changed/destroyed`).
- Branch protection on `main` requires 11 checks but `enforce_admins` is off, so backlog-only direct
  pushes still land — the "11 of 11 required status checks are expected" remote message is
  informational, NOT a rejection.

**Decisions worth not relitigating:**

- **The cross-partition sweep can never confirm.** Non-success diagnostics only.
- **`Body.deviceId` is never trusted** for identity, authorization or partition evidence. Only
  `SystemProperties[iothub-connection-device-id]` and the root partition value stamped from it.
- **`--device` is pinned** to the fixture constant. Do not add an override flag.
- **Definition parity deliberately EXCLUDES throughput.** The destination's absent dedicated offer is
  the POINT of MG-53, not a mismatch against the source's 400 RU/s.
- **MG-53's RF-1/RF-2 are `deferred`, not unfixed.** Both code defects are merged in `3ddd088`; only
  their in-lane provability is outstanding, and that is MG-76.

**Operational lessons that cost real time this session:**

- **Never commit onto a branch under review outside the coordinator's fix cycle.** It stranded
  MG-53's review candidate three commits behind the merge and the shipping review refused
  `blocked_environment`. The fix was to re-anchor a NEW review at the merged sha — which is what
  found the two fail-open paths. Checking out the stale candidate to "unblock" would have shipped
  both.
- **`gh run list --commit <short-sha>` silently returns EMPTY** — it needs the full 40-char sha. A
  monitor built on the short form waited 60 minutes on a run set that was green the whole time.
- **`forge review --add-lens` widenings do not survive a refused stage.** A refused
  `confirm_contract` writes nothing, so every widening must be passed again in ONE invocation.
- **A green suite is not evidence a named test ran.** Jest's default reporter prints suite-level
  `PASS` only, and this repo's infra harnesses run in `ci.yml` alone. That is MG-76.
- **`forge gate <id> <decision>` is positional** — there is no `--advance` flag.
- **Monitors still cannot be enumerated.** The task-output directory is not a way to find them
  either: every Bash call writes there too, so the "newest file" is almost always your own last
  command. Track armed ids in-conversation and stop each one.

**Shipped (for reference):**

- **MG-53** (`e720931` create, `3ddd088` gate hardening) — the 400 RU/s shared-throughput database
  and five definition-faithful containers holding no dedicated offer. Closed with a nine-row
  acceptance-evidence grid.
- **MG-76** (filed, open) — infra fixture harnesses and per-test identity are invisible to the
  local/review verification lane; includes the finding that CI *does* run them with per-test
  identity, so fixing the CI evidence pairing may be the cheaper half.

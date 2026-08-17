**Last session ended 2026-08-17.**

**Where we left off:** MG-53 shipped and CLOSED. The V2 dev shared-throughput destination exists,
was verified live, and the fail-closed gate that certifies it has had two fail-open paths closed.
**MG-62 (cutover) is the next active work.**

**Picked up next:**

1. **MG-62 — cut over and prove a new post-cutover telemetry document.** Waits on nothing now.
   It repoints the IoT Hub Cosmos routing endpoint and the Function App `COSMOSDB_DATABASE_NAME`
   to `meatgeek-v2-dev-shared-db`. It inherits MG-67's fixture, its read-back contract, and a
   pre-cutover baseline (3/3 confirmed in 2 polls, 5144ms) that makes a post-cutover failure
   attributable. **Merging MG-62's Terraform IS the cutover** — GitOps applies on merge, so the
   merge is the live event, not a later manual step.
   - **Carry the check-20 forward gap.** `tf-static-checks.sh` check 20 keys on the exact resource
     label `azurerm_cosmosdb_sql_container.temperatures`. Once the endpoint addresses the
     `*_shared` container, check 20 validates the WRONG container and reads green. Extend it to the
     container the endpoint actually addresses, or check 20 silently stops guarding the
     authentication-anchored partition contract at the exact moment it starts mattering.
2. **MG-54 — delete promptly** after MG-62. Its authorization covers disposing of all synthetic
   documents, including the MG-73 differential one.
3. **MG-59 — after the whole chain.** Persisted shape is specified: the envelope is authoritative,
   `Body` is advisory, identity comes from the authenticated system property.

**What shipped this session:**

- **MG-53** (`e720931` create, `3ddd088` gate hardening) — `meatgeek-v2-dev-shared-db` with a single
  400 RU/s database-level offer and five definition-faithful containers holding no dedicated offer.
  Verified live; the post-apply gate re-asserts it every dev apply and passed on the real
  destination with full parity across all eight scoped fields.

**Live state:**

- `main` = `3ddd088`, CI green, dev apply converged (`No changes`, `0 added/changed/destroyed`).
- **Account total is 2400 RU/s** — 2000 source (five dedicated offers) + 400 destination. Free tier
  covers the first 1000. The source's 2000 accrues until MG-54; that delay is the dominant cost of a
  slow cutover, not the destination.
- **Destination is EMPTY and that is correct** — measured `TOTAL=0` across all five containers. The
  10 synthetic documents remain in the SOURCE deliberately and are MG-54's to dispose of.
- Source `temperatures` still holds exactly 10 synthetic documents, expiring 2026-08-21..08-23.
- **No standing Azure permissions.** A temporary Data Reader grant was created immediately before
  the emptiness count and revoked immediately after; baseline verified restored (2 assignments,
  identical ids, no leftover reader).

**Open follow-ups:** MG-76 (NEW — infra harnesses and per-test identity invisible to the review
lane), MG-68, MG-69, MG-70, MG-71, MG-74, MG-75.

**Decisions worth not relitigating:**

- **The cross-partition sweep can never confirm.** Non-success diagnostics only.
- **`Body.deviceId` is never trusted** for identity, authorization or partition evidence. Only
  `SystemProperties[iothub-connection-device-id]` and the root partition value stamped from it.
- **`--device` is pinned** to the fixture constant. Do not add an override flag.
- **Parity deliberately excludes throughput.** The destination's absent dedicated offer is the
  POINT of MG-53, not a mismatch against the source's 400 RU/s.

**Operational lessons that cost real time this session:**

- **Never commit onto a branch under review outside the coordinator's fix cycle.** Doing so stranded
  MG-53's review candidate three commits behind the merge, and the shipping review then refused
  `blocked_environment`. The fix was to re-anchor a NEW review at the merged sha — which is what
  found RF-1 and RF-2, two fail-open paths that did not exist at the stale candidate. Checking out
  the stale candidate to "unblock" the review would have shipped both.
- **`gh run list --commit <short-sha>` silently returns EMPTY.** It needs the full 40-char sha. A
  monitor built on the short form waited 60 minutes on a run set that was green the whole time.
- **`forge review`'s `--add-lens` widenings do not persist across a refused stage.** A refused
  `confirm_contract` writes nothing, so every widening must be passed again in ONE invocation.
- **A green suite is not evidence a named test ran.** Jest's default reporter prints suite-level
  `PASS` only, and this repo's infra fixture harnesses run in `ci.yml` alone — so the rechecker
  correctly recorded `not_executed` for two assertions that genuinely passed. That is MG-76.
- **`forge gate <id> <decision>`** is positional; there is no `--advance` flag.

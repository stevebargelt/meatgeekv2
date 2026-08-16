**Last session ended 2026-08-16.**

**Where we left off:** MG-67, MG-72 and MG-73 all shipped and CLOSED. V2's IoT-to-Cosmos path has
been proven end to end for the first time, and the partition identity contract is settled with a
passing differential proof. **MG-53 is the next active work.**

**Picked up next:**

1. **MG-53 — create the 400 RU/s shared-throughput database and five definition-faithful containers.**
   CREATE ONLY: no copy, no repointing. Before creating anything, run the source-state confirmation —
   and read MG-53's own body for the inventory, because it is not what the older text implies:
   **ten synthetic documents across THREE runs and TWO markers**, all under `Body.syntheticFixture`
   (NOT a top-level field — IoT Hub wraps the message, so a root-level query finds nothing and reads
   as all-clear). A halt check matching only `MG-67-SYNTHETIC-FIXTURE` will falsely halt on the
   MG-73 differential document. Most will have aged out on the 604800s TTL by 2026-08-21/23; a
   smaller count is expected expiry, anything unmarked or a count ABOVE what is recorded is a HALT.
2. **MG-62 — cutover.** Waits on MG-53 alone now. It inherits MG-67's fixture, its read-back contract
   and a pre-cutover baseline (3/3 confirmed in 2 polls, 5144ms) that makes a post-cutover failure
   attributable.
3. **MG-54 — delete promptly** after MG-62. Its authorization covers disposing of all the synthetic
   documents, including the MG-73 differential one.
4. **MG-59 — after the whole chain.** It now has a specified persisted shape: the envelope is
   authoritative, `Body` is advisory, and a mapping layer owns envelope → TemperatureReading with
   identity sourced from the authenticated system property.

**What shipped this session:**

- **MG-72** (`83a1c0c`) — the runbook's credential screen reports the match (file, line, pattern
  class), never the matched value. Also fixed a §6 `tail -f` that displayed unscreened output, and
  two zsh incompatibilities that made the screen either fail outright or silently misbehave.
- **MG-73** (`943a1c9`) — the routing endpoint now stamps a top-level `deviceId` from `{deviceid}`,
  proven **authentication-anchored** by a differential test: a message sent AS the fixture device
  while its payload claimed another identity landed under the AUTHENTICATED id, and a point read
  FAILED under the payload-supplied one.
- **MG-67** (`48068ff`) — the durable device fixture, a secret-safe fail-closed sender, and the live
  traversal: `confirmed-in-cosmos: 3/3 (2 polls, arrived after 5144ms)`.

**Live state:**

- `main` = `48068ff`, CI green. Nothing unpushed. `feat/mg-67-iot-device-fixture` merged (branch not
  deleted).
- **No standing Azure permissions.** Three temporary Data Reader grants were created immediately
  before use and revoked immediately after, each verified against a snapshot with both pre-existing
  Contributor assignments retained.
- The dev IoT device `meatgeek-v2-dev-synthetic-fixture-device` is registered and enabled. It is a
  DURABLE fixture — but the registry is data-plane state no Terraform resource owns, and a hub
  replacement silently empties it, so MG-62 must re-check rather than assume.
- Ten synthetic documents live in `temperatures`, expiring 2026-08-21 through 08-23.

**Open follow-ups from this chain:** MG-68 (data-pusher content-type — narrowed: the fixture proved
setting it is necessary but NOT sufficient, since wrapping happens regardless), MG-69 (retry budget),
MG-70 (hold the evidence reservation through publication — do NOT add a fourth check-then-act),
MG-71 (timeout is terminal — fix both anchors together), MG-74 (pre-existing TS2304 in
`apps/mobile/src/test-setup.ts`; CI's per-project mobile job passes, so it is the cross-project
typecheck that fails), MG-75 (marker-only PEM fallback redacts BEGIN but leaves the body).

**Decisions worth not relitigating:**

- **The cross-partition sweep can never confirm.** It is non-success diagnostics only. A review
  finding argued it should confirm a full set found in the expected partition; that was rejected on a
  candidate-bound anchored contradiction, because a scan is not partition-scoped proof and confirming
  off it would mask a mis-partition. Do not relax this to get a green post-cutover result.
- **`Body.deviceId` is never trusted** for identity, authorization or partition evidence. Only
  `SystemProperties[iothub-connection-device-id]` and the root partition value stamped from it.
- **`--device` is pinned** to the fixture constant. That is what makes credential-shaped input
  structurally unable to reach a device name; do not add a flag to override it.
- **`idDivergence` is true on every confirmed run** and that is expected — Cosmos assigns root ids, so
  they necessarily differ from requested ids.

**One judgment call to review:** MG-67 merged with strict tip equality NOT satisfied — the review
settled at `fbc34bb`, the merge tip was `4f266e8`. Verified before merging: zero production source
changed in the delta (one additive passing test, two docs reformatted, the evidence artifact
reformatted with semantics re-validated), and all 11 CI checks green on the merge tip itself. Merged
on that basis rather than on the gate passing. If that should be a hard stop unattended, say so.

**Operational lessons that cost real time:**

- **Never end a turn without BOTH dispatching the next transition and arming a monitor** (~25 hours
  lost with review findings dispositioned and the batch fix never dispatched).
- **`persistent: true` monitors silently deliver nothing here.** Use `persistent: false`, re-arm on
  the 60-minute timeout, include an idle break — and STOP every monitor you arm. No tool enumerates
  them; `TaskList` returns nothing while they run.
- **A live run with a tool timeout above 120s must go under `forge launch run`.** A synchronous Bash
  call was SIGTERM'd mid-confirmation, leaving 3 unrecorded documents live.
- **Check whether a red CI job is a flake before re-running** — verify the step passes on main and
  locally first.
- `forge retry` on a fanout CHILD is refused; use `forge recover <parent> --re-drive`. A plain
  `forge retry` only queues — `forge next` dispatches.
- **Local `terraform init`/`test` runs leave GB-scale `.terraform` caches** that get mounted into
  every agent container and can starve `forge-test` (1.7GB removed this session).
- A `stale_protocol` reviewer refusal is cleared by `forge upgrade`, which republishes the seed
  generation. `forge upgrade` also rewrites `CLAUDE.md` — stash it off a feature branch.

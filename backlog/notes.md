**Last session ended 2026-08-15.**

**Where we left off:** MG-73 shipped, applied and CLOSED. The IoT-to-Cosmos partition identity
contract is settled with a passing live differential proof. **MG-67 is the next active work — not
MG-53.**

**Picked up next:**

1. **MG-67 — unblocked, and the only thing ready to run.** Two parts:
   (a) update the fixture's read-back contract to MG-73's verified shape — **partition-scoped
   discovery** under the AUTHENTICATED device id correlated on `Body.fixtureRunId`, then an **exact
   point read** on (root `id`, root partition value). A pure point read is impossible: Cosmos assigns
   the root `id`. The existing cross-partition sweep stays valid as NON-SUCCESS diagnostics only —
   it must never be an acceptance path, because a scan masks a mis-partition.
   (b) run the final live proof: the traversal, the recorded evidence artifact, credential
   non-emission from captured stdout/stderr, applied-state no-change confirmation, and the temporary
   role closeout. The device fixture is registered and durable; MG-72 fixed the runbook.
2. **MG-53** — waits on MG-67 (its source-state confirmation reads MG-67's recorded ids/count).
3. **MG-62** — waits on MG-67 then MG-53.
4. **MG-54** — after MG-62, promptly. Its disposal section now also covers the six MG-67 synthetic
   documents, matched on `Body.syntheticFixture` (NOT a top-level field).
5. **MG-59** — after the whole chain. It now has a specified persisted shape to build against.

**What MG-73 established — do not relitigate:**

- **IoT Hub WRAPS the device message.** The routed document is an envelope: `Body` (device payload),
  `Properties`, `SystemProperties`, a **Cosmos-assigned** root `id`, `iothub-name`, `_ts`.
- **The endpoint now stamps a top-level `deviceId`** via `partition_key_name = "deviceId"` +
  `partition_key_template = "{deviceid}"` (`943a1c9`, applied through GitOps).
- **`{deviceid}` is AUTHENTICATION-ANCHORED** — proven differentially: a message sent AS the fixture
  device with `Body.deviceId` deliberately claiming another identity landed with the AUTHENTICATED id
  as its root partition value. Point read FOUND under the authenticated id, NOT FOUND under the
  payload id. That failure half is the security property.
- **Four identities, four trust levels:** root `id` addresses (never identity); `Body.id` /
  `Body.fixtureRunId` correlate (never authorize); `SystemProperties[iothub-connection-device-id]` is
  the ONLY value trustable for authorization or partition; **`Body.deviceId` is never trusted.**
- **The persisted document is the envelope, not a `TemperatureReading`.** MG-59 needs a mapping
  layer; the envelope structurally cannot satisfy that schema (`additionalProperties: false`,
  `cookId` absent).
- Evidence: `docs/infrastructure/evidence/mg73-differential-partition-proof.json` and
  `mg73-observed-routed-document.json`.

**Live state:**

- `main` = `d74d4a5`, CI green, dev apply green and converged. Nothing unpushed.
- `feat/mg-67-iot-device-fixture` = `83a1c0c` + an evidence commit (`fb26932`) that DUPLICATES what
  is now on main via `cc2632a`. **Drop that commit when rebasing MG-67 onto main** — identical
  content, and it belongs to MG-73.
- MG-67's PR is NOT open. Open it only when all eight review checks can be green.
- Six MG-67 synthetic documents plus one MG-73 differential document are live in `temperatures`,
  expiring on the measured 604800s TTL (~2026-08-21). Let them expire; do not delete early.
- **No standing Azure permissions.** Both temporary Data Reader grants (MG-67's and MG-73's) were
  created immediately before use and revoked immediately after, each verified against a snapshot with
  the two pre-existing Contributor assignments retained.

**MG-67's review state (unchanged, still valid):** evidence-led review `review-76d2e8b423b8`, ledger
settled, 6 of 8 shipping checks green. The two blocks are real: one acceptance criterion unmet
(host-phase runbook, now fixed by MG-72) and one unproven (fail-closed, MG-71). Re-run the shipping
review on the evidenced tip after the live proof.

**Open follow-ups from this chain:** MG-68 (data-pusher content-type — narrowed: the fixture proved
setting it is necessary but not sufficient, since wrapping happens regardless), MG-69 (retry budget),
MG-70 (hold the evidence reservation through publication — do NOT add a fourth check-then-act),
MG-71 (timeout is terminal — fix both anchors together), MG-72 (CLOSED), MG-74 (pre-existing TS2304
in `apps/mobile/src/test-setup.ts`; note CI's per-project mobile job passes, so it is the
cross-project typecheck that fails).

**Operational lessons that cost real time this session:**

- **Never end a turn without BOTH dispatching the next transition and arming a monitor.** ~25 hours
  were lost with review findings dispositioned and the batch fix never dispatched.
- **`persistent: true` monitors silently deliver nothing here.** Use `persistent: false`, re-arm on
  the 60-minute timeout, and include an idle break.
- **A live run with a 180s tool timeout must go under `forge launch run`.** A synchronous Bash call
  was SIGTERM'd at 120s mid-confirmation, leaving 3 unrecorded documents live. The per-run
  reservation is what kept them identifiable.
- **Check whether a red CI job is a flake before re-running** — this one was a genuine
  `connection reset by peer` on a provider download, confirmed by the step passing on main and all 34
  module tests passing locally.
- `forge retry` on a fanout CHILD is refused; use `forge recover <parent> --re-drive`. A plain
  `forge retry` only queues — `forge next` dispatches.

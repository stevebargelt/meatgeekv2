# MG-67 — Dev IoT Device Fixture: Host-Phase Verification Runbook

> **Nothing in this document has been run against the live tenant.** The build
> pipeline that produced `apps/infrastructure/scripts/iot-fixture/` runs in a
> container with **no Azure credential**, so every command below is **unexecuted**
> until an operator runs it. No device has been registered, no container
> definition has been read, no role assignment has been made, and **no document
> has ever been written to `meatgeek-v2-dev-db`**. The tool and its tests are the
> pipeline's deliverable; the **proof** is this procedure, and it is outstanding.
>
> Read the whole document before running step 1. The steps are ordered because
> each depends on the state the previous one establishes, and §5 (removing the
> temporary role assignment) is a **deliverable step, not cleanup**.

## What this ticket proves, in one sentence

That a message sent from a registered device to
`meatgeek-v2-dev-iothub-259d4bf5b628` traverses the existing `cosmos-storage`
route and lands as a **specific, newly identified document** that can be **read
back out of** the `temperatures` container in `meatgeek-v2-dev-db` — something no
one has ever observed, because as measured on **2026-08-10** all five containers
in that database held **zero documents and zero bytes** and the hub had **zero
registered devices**.

The routing is not broken and is not being changed. Endpoint `cosmos-storage`
(`authenticationType: identityBased`) and route `cosmos-storage-route`
(`source: DeviceMessages`, `condition: true`, `isEnabled: true`) are already
correct in `apps/infrastructure/modules/iot-hub/main.tf`. The path has simply
never carried a message.

## Fixed coordinates

Every command below uses these. They come from the MG-67 brief and from the
Terraform in this repo; confirm the two marked ones with `terraform output`
rather than trusting the literal.

| Thing                 | Value                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload RG           | `meatgeek-v2-dev-rg` (West US 2)                                                                                                                           |
| IoT Hub               | `meatgeek-v2-dev-iothub-259d4bf5b628`                                                                                                                      |
| Cosmos account        | `mgv2-dev-f640e19ae7ab` — no output publishes the bare name; confirm with `terraform output -raw cosmos_db_endpoint` (the account name is its first label) |
| Database              | `meatgeek-v2-dev-db` — confirm with `terraform output -raw cosmos_db_database_name`                                                                        |
| Destination container | `temperatures` (the container the route targets)                                                                                                           |
| Fixture device id     | `meatgeek-v2-dev-synthetic-fixture-device` (`FIXTURE_DEVICE_ID`)                                                                                           |
| Synthetic marker      | `syntheticFixture` = `MG-67-SYNTHETIC-FIXTURE`                                                                                                             |
| Per-run correlator    | `fixtureRunId` — a fresh uuid per invocation                                                                                                               |
| Messages per run      | **3** (`MESSAGES_PER_RUN`, a constant, deliberately not a flag)                                                                                            |
| Declared dev TTL      | `temperature_data_ttl_days = 7` → **604800s** — the _comparand_, never a fallback                                                                          |
| The tool              | `apps/infrastructure/scripts/iot-fixture/send-fixture.mjs`                                                                                                 |

```bash
# Paste this block first; every later block assumes it.
set -uo pipefail            # NOT -e: several steps below read an exit code deliberately
SUB=<V2-SUBSCRIPTION-ID>
RG=meatgeek-v2-dev-rg
HUB=meatgeek-v2-dev-iothub-259d4bf5b628
ACCOUNT=mgv2-dev-f640e19ae7ab
DATABASE=meatgeek-v2-dev-db
CONTAINER=temperatures
DEVICE=meatgeek-v2-dev-synthetic-fixture-device
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

az account set --subscription "$SUB"
az extension add --name azure-iot --only-show-errors   # idempotent; required by `az iot`
```

### Permissions you need, and the two planes they live on

| Step                    | Plane                    | What it needs                                                                          |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| §2 device registration  | IoT Hub **registry**     | Contributor on the hub, or `IoT Hub Registry Contributor` / `IoT Hub Data Contributor` |
| §3 container definition | Cosmos **control** plane | Reader on the account (this is `az cosmosdb sql container show`)                       |
| §4/§6 read-back         | Cosmos **data** plane    | `Cosmos DB Built-in Data Reader` at account scope — **granted in §4, removed in §5**   |
| §6 the send             | IoT Hub **registry**     | same as §2; `az` resolves the device credential itself (see below)                     |

**Control-plane RBAC does not grant Cosmos data-plane access.** Subscription
Owner alone gets a `403` on the read-back that reads exactly like a tool bug.
That is what §4 exists for. The tool classifies that `403` as **exit 4 (auth
failure)** and says so explicitly, precisely so it is never mistaken for "the
route didn't deliver".

---

## 1. What you must NOT do, stated before you start

These are scope boundaries from the brief, and each one is live infrastructure or
another ticket's surface:

- **Do not create, modify or delete any Cosmos database or container.** This
  procedure touches the source database _only_ by causing documents to arrive
  through the route that already exists.
- **Do not repoint the `cosmos-storage` endpoint or `cosmos-storage-route`.**
- **Do not change the Terraform-published Function App database-name setting.**
- **Do not add Cosmos persistence to the business API or `libs/azure-client`** —
  that is MG-59.
- **Do not modify `apps/infrastructure/scripts/cosmos-export/`** or its
  absence-handling semantics — that is MG-66.
- **Do not print, copy, store or paste any device key, connection string, SAS
  token or certificate**, anywhere, at any point in this procedure. In
  particular, **do not run `az iot hub device-identity connection-string show`**
  — nothing in this procedure needs its output, and running it puts a live
  credential into your terminal scrollback and your shell history for no benefit.

---

## 2. Register the durable fixture device (idempotent)

### 2a. The command

```bash
az iot hub device-identity show \
  --hub-name "$HUB" --device-id "$DEVICE" --only-show-errors -o none 2>/dev/null \
  || az iot hub device-identity create \
       --hub-name "$HUB" --device-id "$DEVICE" --only-show-errors -o none

# Confirm registration WITHOUT printing anything credential-bearing:
az iot hub device-identity list --hub-name "$HUB" \
  --only-show-errors --query "[].{deviceId:deviceId,status:status}" -o table
```

`show || create` is what makes this **safe to re-run at any time**: a device that
already exists is left exactly as it is, and a device that does not is created.
Re-running it never rotates a key and never disturbs a device the fixture already
established.

> The `list` query above projects **`deviceId` and `status` only**, on purpose.
> The full device document carries `authentication.symmetricKey`. Do not widen
> that projection, do not drop the `--query`, and do not redirect the unfiltered
> output anywhere.

`az` creates the device with a platform-generated symmetric key held **in the
hub**. That key is never read by this repo, never passed to the sender, and never
needs to be seen by you — see §6.

### 2b. The device name is deliberately not an appliance name

`meatgeek-v2-dev-synthetic-fixture-device` reads unmistakably as a test fixture.
Someone finding it in the registry in six months, or finding its documents in
`temperatures`, can tell at a glance that it is not a real BBQ appliance. Do not
rename it: the name is a constant in `fixture-core.mjs`, it is recorded in the
evidence artifact, and MG-53 and MG-54 match on it.

### 2c. "Durable" means re-establishable, NOT indestructible — MG-62 must re-check

**The device registry is data-plane state that no Terraform resource owns.**
`apps/infrastructure/modules/iot-hub/main.tf` declares the hub, its endpoints,
its routes and its consumer group — and **nothing at all** about registered
devices. There is no `azurerm_iothub_device` resource in this stack, and none
exists in the provider.

The consequence is specific and worth stating plainly: **replacing the hub
silently empties the registry.** Hub replacement is not hypothetical here — the
module header notes that IoT Hub `location` is ForceNew, so a single-token edit
plans the hub as a destroy-and-recreate, and the route resources carry
`replace_triggered_by` on `azurerm_iothub.main.id` precisely because that has
been a live concern. After any such apply, this device is **gone**, no drift
signal reports it, and nothing in CI notices.

So "durable fixture" here means **re-establishable on demand by re-running §2a**,
not "guaranteed present". **MG-62 must re-run §2a and confirm the device exists
before relying on it for the post-cutover proof — never assume it survived.**

---

## 3. Measure the live `temperatures` container definition

HR4 of this ticket is one word: **measure**. Nothing in the tool hardcodes a
partition key path or a TTL, and nothing falls back to one. Produce the
definition with `az`, and hand it to the tool as text:

```bash
az cosmosdb sql container show \
  --account-name "$ACCOUNT" \
  --resource-group "$RG" \
  --database-name "$DATABASE" \
  --name "$CONTAINER" \
  --only-show-errors -o json > "/tmp/mg67-${CONTAINER}-${STAMP}.json"

# Read the two numbers this ticket turns on, before running anything:
jq '{partitionKey: .resource.partitionKey.paths, defaultTtl: .resource.defaultTtl}' \
  "/tmp/mg67-${CONTAINER}-${STAMP}.json"
```

This is a **control-plane** read. It carries no key material — a container
definition is a shape, not a credential — so the file is safe to keep and safe to
attach to the ticket.

**Expected:** `partitionKey.paths == ["/deviceId"]` and `defaultTtl == 604800`
(the declared `temperature_data_ttl_days = 7`).

**If `defaultTtl` differs from 604800**, that is **configuration drift** and the
tool reports it: the run continues, the **measured** value is what gets used and
recorded, and a `ttl-drift` entry appears in the evidence record's `findings`
array with both numbers. Surface it in the ticket. Do not "fix" it here and do
not adopt the declared value.

**If the document is malformed, or has no `defaultTtl`, or has no partition key
path**, the tool **refuses** with **exit 8 (container definition refusal)** and
substitutes nothing. That refusal is correct: a guessed TTL is
indistinguishable, downstream, from "the write never happened".

**Exit 8 also covers a document describing the wrong container.** The tool
cross-checks the definition's own container name against `--container` and
refuses a mismatch rather than measuring it — the easy way to hit this is
reusing a stale `/tmp` definition from another container, which would record a
retention and a partition key that do not apply to `temperatures`. Re-run the
`az` command above for the container you are actually sending to.

**Exit 8 also covers a partition key path this fixture cannot spell** — a
hierarchical or nested path, or a field name that is not a plain identifier
(`/device-id`, `/2deviceId`) or that collides with a contract field (`/id`,
`/syntheticFixture`, `/fixtureRunId`, `/ticket`). It is a fact about the measured
container, not about your command line, so it is reported as a measurement
refusal (**exit 8**) and never as a usage error. Halt and report it: the fixture
writes one flat body field and nothing between the device and Cosmos injects a
partition key.

You can pipe the document straight in instead of writing a file — pass
`--container-definition -` and the tool reads stdin.

---

## 4. Grant the TEMPORARY Cosmos data-plane role assignment

The read-back authenticates with **Entra ID via `DefaultAzureCredential`** and
nothing else — the account runs `local_authentication_enabled = false`, so key
auth could not work even if the tool offered it (it does not). Data-plane access
is a **separate** grant from control-plane RBAC.

> **This account is shared live infrastructure.** Your principal may **already**
> hold a Cosmos data-plane assignment that somebody else's work depends on, and
> §5 deletes something. So §4 does two things before it grants anything: it takes
> a **snapshot** of every assignment that exists on the account, and it decides
> whether a grant is needed at all. Everything §5 is allowed to delete is
> established **here**, at creation time — §5 never searches for "the assignment
> that looks like ours".
>
> **§4a decides; §4b obeys.** §4a sets `MG67_GRANT_DECISION`, and §4b's create
> path runs **only** when that decision is `grant`. Run them in the **same
> shell**, in order: with no decision in scope §4b creates nothing and stops,
> because a grant made without §4a's snapshot is a grant §5 cannot prove it
> removed cleanly.

### 4a. Snapshot what already exists, and decide whether to grant at all

```bash
az login   # if you have not already; DefaultAzureCredential picks this up

PRINCIPAL_ID=$(az ad signed-in-user show --query id -o tsv)
echo "principal: $PRINCIPAL_ID"        # a guid, not a credential — safe to record

# Built-in Cosmos data-plane role definition guids. Fixed, and the same in every
# account. …0001 = Data READER (all this tool needs), …0002 = Data Contributor
# (already held by the IoT Hub's system-assigned identity via Terraform — never
# granted here).
DATA_READER=00000000-0000-0000-0000-000000000001

# Two files that outlive your terminal. §5 reads BOTH; losing them means §5
# refuses to delete anything, which is the correct outcome, not a nuisance.
BEFORE="/tmp/mg67-role-assignments-before-${STAMP}.json"
MG67_STATE="/tmp/mg67-role-assignment-${STAMP}.env"

# The snapshot. This is the ground truth for "what existed before I touched
# anything" — §5 proves against it that it removed exactly one assignment.
unset MG67_GRANT_DECISION 2>/dev/null || true    # no stale decision from an earlier attempt
az cosmosdb sql role assignment list \
  --account-name "$ACCOUNT" --resource-group "$RG" --only-show-errors \
  -o json > "$BEFORE"

# The snapshot must be a NON-EMPTY file holding a JSON ARRAY before anything is
# read out of it. A failed or truncated `az` leaves an empty file, an empty file
# reads as "you hold no assignment", and that would decide `grant` off a snapshot
# §5 cannot use. The `-s` test is not redundant: `jq -e` exits 0 on empty input,
# because the filter never runs. An unusable snapshot sets NO decision at all,
# and §4b then refuses.
if [ -s "$BEFORE" ] && jq -e 'type == "array"' "$BEFORE" >/dev/null 2>&1; then
  jq -r '.[] | [.name, .principalId, .roleDefinitionId, .scope] | @tsv' "$BEFORE"

  # Does your principal ALREADY hold an account-scope data-plane assignment?
  # Account scope is the account resource id with no /dbs/ segment appended.
  EXISTING=$(jq -r --arg p "$PRINCIPAL_ID" '
    [ .[]
      | select(.principalId == $p)
      | select((.scope | test("/dbs/")) | not)
      | select(.roleDefinitionId | test("00000000-0000-0000-0000-00000000000[12]$"))
      | .name ] | join(" ")' "$BEFORE")

  # THE DECISION. §4b reads this variable and nothing else. It is set here, in
  # one place, so that "you already hold a grant" actually GATES the create
  # rather than merely printing a suggestion above it.
  if [ -n "$EXISTING" ]; then
    MG67_GRANT_DECISION=skip
  else
    MG67_GRANT_DECISION=grant
  fi
  echo "pre-existing account-scope data-plane assignment(s) for you: ${EXISTING:-none}"
  echo "decision for §4b: $MG67_GRANT_DECISION"
else
  echo "STOP: the role-assignment snapshot in '$BEFORE' is not a JSON array."
  echo "      Check 'az login' and your Reader access on $ACCOUNT, then re-run §4a."
  echo "      No decision was set, so §4b will refuse to grant."
fi
```

**A non-empty `EXISTING` means no grant is made.** You can already read the
container, and granting a second assignment only manufactures something for §5 to
get wrong. That pre-existing assignment is **not yours to remove**, in this ticket
or any other. If you believe it is stale, that is a **finding to raise**, not a
step in this runbook.

### 4b. Create the temporary assignment — ONLY if §4a decided to grant

Paste this whole block. The `case` is the gate: on `skip` it creates **nothing**
and records the skip, and with no decision in scope (§4a not run in this shell)
it creates nothing either. There is no path through this block that grants
without §4a's snapshot, because §5's proof is written against that snapshot.

```bash
case "${MG67_GRANT_DECISION:-unset}" in

  skip)
    # You already hold one. Record that, and leave the account exactly as found.
    {
      echo "MG67_CREATED=no"
      echo "MG67_ASSIGNMENT_NAME="
      echo "MG67_PRE_EXISTING=$EXISTING"
    } > "$MG67_STATE"
    echo "SKIPPED the grant: you already hold $EXISTING. §5 has NOTHING to remove."
    echo "Nothing was created. Go to §6."
    ;;

  grant)
    # Mint the assignment's own id first, so the thing §5 deletes is a value this
    # procedure chose rather than one it looked up afterwards.
    MG67_ASSIGNMENT_NAME=$(
      (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null \
        || python3 -c 'import uuid; print(uuid.uuid4())') | tr 'A-Z' 'a-z'
    )

    # It must not already name an assignment on this account. A collision is
    # vanishingly unlikely and catastrophic if unnoticed (§5 would delete somebody
    # else's grant), so it is checked rather than assumed.
    if jq -e --arg n "$MG67_ASSIGNMENT_NAME" 'any(.[]; .name == $n)' "$BEFORE" >/dev/null; then
      echo "STOP: the minted id already exists on this account. Do not proceed."
    else
      # Reader, not Contributor: this tool only ever reads. The WRITES come from
      # the IoT Hub's own system-assigned identity, which Terraform already grants
      # Built-in Data Contributor (…0002) in apps/infrastructure/main.tf.
      CREATED_NAME=$(az cosmosdb sql role assignment create \
        --account-name "$ACCOUNT" \
        --resource-group "$RG" \
        --role-definition-id "$DATA_READER" \
        --principal-id "$PRINCIPAL_ID" \
        --scope "/" \
        --role-assignment-id "$MG67_ASSIGNMENT_NAME" \
        --only-show-errors --query name -o tsv)

      if [ -z "$CREATED_NAME" ]; then
        echo "STOP: the create returned no assignment id. Something was possibly created that this"
        echo "      procedure cannot identify — inspect '$BEFORE' against a fresh list BY HAND and"
        echo "      remove nothing until you can name exactly what changed."
      else
        [ "$CREATED_NAME" = "$MG67_ASSIGNMENT_NAME" ] \
          || echo "NOTE: az assigned '$CREATED_NAME' rather than the minted id; the returned one governs."
        {
          echo "MG67_CREATED=yes"
          echo "MG67_ACCOUNT=$ACCOUNT"
          echo "MG67_RG=$RG"
          echo "MG67_PRINCIPAL_ID=$PRINCIPAL_ID"
          echo "MG67_ASSIGNMENT_NAME=$CREATED_NAME"
          echo "MG67_BEFORE=$BEFORE"
        } > "$MG67_STATE"
        cat "$MG67_STATE"    # PASTE THIS INTO THE TICKET NOW — §5 cannot proceed without it
      fi
    fi
    ;;

  *)
    echo "STOP: §4a did not run in this shell, so there is no snapshot and no decision."
    echo "      REFUSING to grant: an assignment created without \$BEFORE is one §5 cannot"
    echo "      prove it removed cleanly. Re-run §4a, then re-run this block."
    ;;
esac
```

**A skip is a recorded outcome, not a silent one.** `MG67_CREATED=no` in the
state file is what tells §5 there is nothing of this run's to delete, and it is
what you paste into the ticket in place of an assignment id.

**Capture, do not search.** The assignment id is recorded at the moment of
creation, because the only alternative — finding it afterwards by matching on
principal and role — cannot tell your new assignment apart from one that was
already there. A grant is a guid; none of these values is a credential, so all of
them are safe to paste into the ticket.

**Account scope (`--scope "/"`) is required**, not a convenience: the same
narrower-scope gap that MG-66 tracks for the export tool applies to any
data-plane read here. Use account scope, and then **remove it** (§5).

**Propagation takes a minute or two**, and Azure RBAC is eventually consistent. A
run started too early fails with **exit 4 (auth failure)** on the tool's
**pre-flight read**, _before anything is sent_ — which is the whole reason the
pre-flight exists. If that happens: wait ~2 minutes and re-run §6. **Nothing was
sent**, so there is nothing to clean up and nothing unrecorded left behind.

---

## 5. REMOVE the temporary role assignment — a deliverable step, not cleanup

**This step is part of the ticket's definition of done.** Run it as soon as §6
and §7 are complete.

> **Delete by the id §4 captured, and by nothing else.** A removal that finds its
> target by name shape, by principal, or by "the Data Reader one" can delete a
> **pre-existing** assignment instead of this run's — silently revoking, on shared
> live infrastructure, access somebody else depends on and that nothing in this
> repo will report missing. Every gate below is a refusal: if the id is absent, or
> the live assignment does not match it, **stop and report**. A leftover
> assignment is a finding somebody can act on; a wrong deletion is an outage
> nobody can attribute.

```bash
# Everything the deletion is allowed to know comes from §4, not from a search.
. "$MG67_STATE"

REMOVE_OK=yes
if [ "${MG67_CREATED:-no}" != "yes" ]; then
  echo "§4 created nothing (you already held ${MG67_PRE_EXISTING:-an assignment})."
  echo "NOTHING TO REMOVE. Do not delete a pre-existing assignment — it is not this ticket's."
  REMOVE_OK=no
elif [ -z "${MG67_ASSIGNMENT_NAME:-}" ]; then
  echo "STOP: no assignment id was captured. REFUSING to guess which assignment to remove."
  echo "      Report the assignment as outstanding on the ticket instead."
  REMOVE_OK=no
elif jq -e --arg n "$MG67_ASSIGNMENT_NAME" 'any(.[]; .name == $n)' "$MG67_BEFORE" >/dev/null; then
  echo "STOP: $MG67_ASSIGNMENT_NAME existed BEFORE §4 ran, so it is not the assignment this run"
  echo "      created. REFUSING to delete it. Report this and remove nothing."
  REMOVE_OK=no
else
  # It must exist, exactly once, with the principal and role §4 granted. Any other
  # answer means the id does not identify what this procedure created.
  MATCH=$(az cosmosdb sql role assignment list \
    --account-name "$MG67_ACCOUNT" --resource-group "$MG67_RG" --only-show-errors \
    --query "length([?name=='$MG67_ASSIGNMENT_NAME' && principalId=='$MG67_PRINCIPAL_ID' && ends_with(roleDefinitionId, '00000000-0000-0000-0000-000000000001')])" \
    -o tsv)
  if [ "$MATCH" != "1" ]; then
    echo "STOP: $MG67_ASSIGNMENT_NAME matched $MATCH assignment(s), expected exactly 1."
    echo "      REFUSING to delete. Report it; do not fall back to a principal or name match."
    REMOVE_OK=no
  fi
fi

if [ "$REMOVE_OK" = yes ]; then
  az cosmosdb sql role assignment delete \
    --account-name "$MG67_ACCOUNT" \
    --resource-group "$MG67_RG" \
    --role-assignment-id "$MG67_ASSIGNMENT_NAME" \
    --yes --only-show-errors -o none
fi
```

**Then prove that exactly one assignment went, and it was yours:**

```bash
AFTER="/tmp/mg67-role-assignments-after-${STAMP}.json"
az cosmosdb sql role assignment list \
  --account-name "$MG67_ACCOUNT" --resource-group "$MG67_RG" --only-show-errors \
  -o json > "$AFTER"

# 1. Yours is gone. Expect: true
jq --arg n "$MG67_ASSIGNMENT_NAME" 'any(.[]; .name == $n) | not' "$AFTER"

# 2. NOTHING ELSE went with it. Expect: EMPTY OUTPUT.
#    Any name printed here existed before §4 and no longer exists — collateral
#    damage, and a halt.
jq -r --slurpfile after "$AFTER" '[.[].name] - [$after[0][].name] | .[]' "$MG67_BEFORE"
```

Record both outputs on the ticket. The second one is the actual deliverable:
"the temporary grant is gone" and "nothing else was touched" are two different
claims, and only the second one rules out the failure this section is written to
prevent.

### Why nothing in the system will notice if you skip this

`azurerm` manages **exactly two** `azurerm_cosmosdb_sql_role_assignment`
resources on this account — `iot_hub_writer` and `functions_cosmos`, both in
`apps/infrastructure/main.tf`. Terraform manages what it declares and **will
never prune a third**, so a hand-made assignment is not drift, produces no plan
diff, and turns no gate red. `bootstrap/tf-managed-role-allowlist.tsv` does not
cover it either: its own header records that Cosmos **data-plane**
`sqlRoleAssignments` are Contributor-granted and invisible to the control-plane
role gate.

So a standing personal data-plane Reader grant on the dev Cosmos account is
**permanently invisible to every automated signal in this repo**. The only thing
that removes it is you, running the command above. Record the deletion in the
ticket alongside the evidence.

---

## 6. The live run

```bash
# --evidence-out is a DIRECTORY. The tool derives the file name inside it from
# the run's own unique id (mg67-fixture-evidence-<runId>.json), so every run
# exclusively owns one immutable artifact and two runs can never collide.
EVIDENCE_DIR="docs/infrastructure/evidence"
mkdir -p "$EVIDENCE_DIR"

# CAPTURE the run's output. This is not convenience logging: §7c inspects these
# two files, and they are the ONLY evidence that can discharge this ticket's
# credential non-emission criterion ("none is emitted on any output path
# including failures"). An uncaptured run cannot prove it, and a run you watched
# scroll past is an uncaptured run. They land in /tmp first and are promoted to
# the evidence directory only AFTER §7c passes.
RUN_OUT="/tmp/mg67-run-${STAMP}.stdout.log"
RUN_ERR="/tmp/mg67-run-${STAMP}.stderr.log"

node apps/infrastructure/scripts/iot-fixture/send-fixture.mjs \
  --hub "$HUB" \
  --device "$DEVICE" \
  --account "$ACCOUNT" \
  --database "$DATABASE" \
  --container "$CONTAINER" \
  --container-definition "/tmp/mg67-${CONTAINER}-${STAMP}.json" \
  --timeout 180000 \
  --poll-interval 5000 \
  --evidence-out "$EVIDENCE_DIR" \
  >"$RUN_OUT" 2>"$RUN_ERR"
RUN_EXIT=$?
echo "send-fixture exit=$RUN_EXIT"     # RECORD THIS — it is half the proof
cat "$RUN_OUT" "$RUN_ERR"

# Capture THIS run's artifact by its correlation id — NEVER by "the newest
# matching file". The file name is derived from the run id, and a `ls -1t | head`
# would hand you a DIFFERENT, concurrent run's artifact whenever two fixtures
# overlap against this directory (which the tool explicitly supports). The tool
# prints the run id on its reservation line, early and on every path that reached
# a send:
#
#   iot-fixture: evidence destination reserved for run <runId>: <path> (...)
#
# Read that id back out of THIS run's own stdout and rebuild the SAME derived name
# the tool used (mg67-fixture-evidence-<runId>.json). Tying the capture to the run
# id is what makes it impossible to pick up another run's file.
RUN_ID=$(sed -n 's/.*evidence destination reserved for run \([^:]*\):.*/\1/p' "$RUN_OUT" | head -1)
if [ -z "$RUN_ID" ]; then
  echo "STOP: could not read this run's correlation id from $RUN_OUT."
  echo "      Do NOT fall back to selecting the newest evidence file — under an"
  echo "      overlapping run that captures the WRONG artifact. Re-inspect the"
  echo "      captured stdout for the 'evidence destination reserved for run' line."
  EVIDENCE=
else
  EVIDENCE="$EVIDENCE_DIR/mg67-fixture-evidence-${RUN_ID}.json"
  echo "run id: $RUN_ID"
  echo "evidence artifact: $EVIDENCE"
fi
```

`$RUN_ID` is `mg-67-run-<uuid>`; it carries no `:` and no `.`, so the `sed`
capture is exact and the scrubber never touches it. `$RUN_ID` also names the two
promoted log files in §7c, so all three files of one run carry the same
correlation id and belong to it unambiguously — see §7c.

**The two streams are captured to two files, with a redirect rather than a
`tee` pipeline, on purpose.** Separately, because the criterion is about stdout
**and** stderr and a merged file cannot show which one a line came from — and
the failure paths this criterion is really about write to stderr. By redirect,
because `$?` after a pipeline is the pipeline's status, and `RUN_EXIT` has to be
the tool's own exit code exactly: it is the half of the proof that says which
outcome you got. The run waits up to `--timeout`, so nothing prints for a while;
`tail -f "$RUN_ERR"` in a second terminal if you want to watch it.

**Do not delete these files if the run fails.** A failed run's output is the
more interesting of the two for §7c — the criterion covers **every** failure
path, and a clean success exercises almost none of them.

`node .../send-fixture.mjs --help` is the authoritative flag reference; the flags
above are the complete set you need. `--timeout` and `--poll-interval` are shown
explicitly rather than defaulted so the **bound actually used** is visible in your
shell history next to the result. The defaults are the same values (180000 ms /
5000 ms) if you omit them.

### What the tool does, in order — and where it can stop

1. **Reserves this run's evidence file** inside the `--evidence-out` **directory**
   — **before anything live happens**. `--evidence-out` names a directory; the
   tool derives the file name from this run's own unique id
   (`mg67-fixture-evidence-<runId>.json`), so **every run exclusively owns one
   destination** and two runs can never name the same file. The reservation proves
   the directory exists and is usable, exercises the **actual** publication
   primitive (a write and a rename, with disposable probe files) so a directory
   that cannot support it is caught now rather than after the send, and then
   **atomically claims** the derived file. All of that is purely local, so an
   unusable directory — or a **reused** destination, i.e. that exact derived file
   already existing — is a **usage error (exit 1)** while nothing has been sent,
   rather than three documents in the live container that the tool then refuses to
   record.

   Two properties worth knowing before you read a refusal, both the same
   discipline the rest of the tool applies to Cosmos, turned on its own
   filesystem:
   - **An unreadable directory is refused, not assumed free.** Only an explicit
     "no such file" counts as _absent_. A `stat` that fails any other way — a
     permission error, a dead mount, an I/O error — is a **refusal (exit 1)**, and
     the message names the code it got. The tool never proceeds to send onto a
     destination it could not read, because "I could not tell" silently becoming
     "nothing is there" is precisely the error-as-absence conflation this tool
     exists to refuse.
   - **Evidence artifacts are immutable and per-run.** There is **no `--overwrite`
     flag and no mode that replaces a record** — a file already at the derived
     name means a genuinely reused destination and the run refuses to start.
     Because the name is derived from a unique run id, two runs cannot collide, so
     there is nothing to coordinate: **you may run overlapping fixtures against the
     same `--evidence-out` directory freely** — they own different files.

2. **Measures** the container from §3's document. Refuses on anything it cannot
   read (**exit 8**); never defaults.
3. **Reads the container BEFORE sending**, requiring this run's freshly minted
   `fixtureRunId` to be absent. This is what makes the proof a _newly identified_
   document rather than an assumption, and it surfaces a missing/unpropagated
   role assignment (**exit 4**) while **nothing has been sent**.
4. **Sends 3 D2C messages** via `az iot device send-d2c-message`, each carrying
   `syntheticFixture=MG-67-SYNTHETIC-FIXTURE`, this run's `fixtureRunId`, a
   `fixtureSequence`, `ticket`, the partition field measured in §3 and a
   `timestamp` — and each declaring `$.ct=application/json` and `$.ce=utf-8` as
   system properties. Any nonzero `az` exit aborts the run (**exit 2**) — after
   recording, for every message it attempted, whether `az` accepted it or left
   its acceptance **unknown**.
5. **Polls** for the full set within the bound, scoped to the fixture device's
   partition. Timeout is **exit 3**, a document without the marker is **exit 6**,
   and a partial or ambiguous read is **exit 7** — never conflated, never
   reported as an absence.
6. **Sweeps cross-partition once** if the scoped polls found nothing, before
   reporting any absence — otherwise a document that landed under a partition
   value nobody expected would be reported as "the route didn't deliver". The
   sweep's verdict is read **off the partition value the returned documents
   carry**, not off which query found them:
   - full set, all carrying the **expected** partition value → **exit 0**. They
     arrived during the round trip after the last scoped poll; that is a timing
     artefact of your `--timeout`, not a partition anomaly, and the recorded
     arrival delay says to raise the bound.
   - full set, one or more **not** carrying the expected partition value →
     **exit 9**. The outcome text distinguishes the two ways that happens, because
     they are different facts about the route needing different repairs: a
     document under a **different** `deviceId`, and a document carrying **no
     `deviceId` field at all** — which is the architect's top-ranked risk here,
     since nothing between the device and Cosmos injects a partition key, so a
     body that omits the field produces a document under **no** partition key
     rather than under some other one. That second case points at the message
     body the sender built, not at the routing target. Both are recorded
     separately in `observedPartitionValues`; neither is collapsed into the other
     or into an empty list (§7a).
   - a **partial** cross-partition set → **exit 7**, not exit 9: with most of the
     run unaccounted for, nothing has established where it landed, and a routing
     diagnosis nobody witnessed must not enter the artifact MG-53 parses.
7. **Writes the evidence artifact** (§7) — on **every** outcome that attempted a
   send, confirmed or not. If that write cannot happen, the run exits **10** and
   prints the ids for you to record by hand; it never reports a run that changed
   the live container as though nothing had happened.

### There is no credential to supply, and none is accepted

`az iot device send-d2c-message` addresses the hub and the device **by name** and
resolves the device credential **itself**, server-side, under your
already-authenticated `az` identity. The sender therefore never reads, holds,
stores or can leak one. There is no key mode, no connection-string mode, no SAS
mode and no certificate mode anywhere in the tool — not as a fallback, not behind
a flag — and every spelling of such a flag is **refused by name** with a usage
error (**exit 1**) _before_ its value is read.

The tool also never passes `--debug` or `--verbose` to `az` and refuses them if
you try: under verbosity `az` prints request signatures, and it persists
invocations under `~/.azure` regardless — disk this repo's redaction posture
cannot reach. The child's raw argv and raw stderr are never echoed; child stderr
passes through the tool's scrubber before any operator-facing line exists.

**Do not work around any of this.** If a run fails in a way that tempts you to
supply a credential by hand, that is stop condition 2 (§9) — halt and report.

#### Name validation is a per-field allowlist, each rule as narrow as the field needs

The five names you pass (`--hub`, `--device`, `--account`, `--database`,
`--container`) are each validated against a **per-field allowlist** — a value is
accepted only if it satisfies **its own field's rule**, and the tool applies a
**different** rule to each because the five name the same thing to nobody. Each
rule is pinned to **what this fixture actually needs**, not to the widest string
Azure would accept. A value that fails is refused with a **usage error (exit 1)**
_before_ its value is read, sent, logged or written anywhere.

What each field validates, exactly:

| Flag          | Accepts                                                                                | Rejects (among other things)                                                       |
| ------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--device`    | letters, digits and **interior hyphens** only, ≤128 chars — a plain identifier         | **dots (so a JWT), whitespace, and every connection-string separator** — see below |
| `--hub`       | letters, digits and hyphens, 3–50 chars, no leading/trailing hyphen (IoT Hub rule)     | dots, `/`, `;`, `:` and other separators                                           |
| `--account`   | **lowercase** letters, digits and hyphens, 3–44 chars (Cosmos account rule)            | uppercase, dots, separators                                                        |
| `--database`  | any Cosmos id: ≤255 chars, no `/ \ # ?`, no control chars, no trailing whitespace      | `/`, `\`, `#`, `?`                                                                  |
| `--container` | same Cosmos id rule as `--database` — **dots ARE legal here** (e.g. `a01.store.west`)   | `/`, `\`, `#`, `?`                                                                  |

Two things follow:

- **`--device` is pinned deliberately below the Azure-legal device set.** Azure's
  device registry would accept a device id containing dots — and therefore would
  accept a **JWT** (three dot-separated base64url segments) as a legal device id.
  This tool does not, because `--device` names a **fixture device whose name the
  tool itself chooses** (it defaults to `FIXTURE_DEVICE_ID` and needs nothing
  wider than a simple identifier). Rejecting dots means **a JWT is refused in the
  `--device` slot by construction** — refused _before_ that text could be logged,
  passed to the `az` argv, or (because `deviceId` is the container's partition
  key) **embedded in a Cosmos document body**. That is the specific hazard this
  narrowing closes. The dotted-name case that Cosmos ids legitimately need
  (`analytics01.eventstore1.replicaWest`) lives only in `--database` / `--container`
  above, and is **not** a reason the device rule is permissive — the two do not
  share a rule.
- **A rejection never echoes what you typed.** The message names the **flag** and
  the **rule it broke**, never the offending value — so an operator who mistyped a
  name learns the rule, and an operator who pasted a secret into a name field does
  not see it reflected back onto the terminal, into shell history, or into any
  captured log. The value the tool goes on to log and send is a **validated** one.

**What this does and does not claim.** A recognisable credential _shape_ — a JWT,
a connection string, a SAS token — no longer passes **any** of these five slots: a
connection string carries `/` and `;`, which every rule rejects, and a JWT carries
dots, which the `--device`, `--hub` and `--account` rules reject. What a naming
rule still cannot tell apart is an **opaque token already shaped like a legal id**
— for instance a 32-character hex key passed as `--container`, which is a legal
Cosmos container id. That residue does **not** apply to `--device` (a dot-free key
long enough to be a JWT is not a JWT, and a JWT is refused regardless), and it does
not matter anywhere, because **the tool never accepts, holds, or requires a
credential at all**: `az` resolves the device key itself under your identity and
the read-back is AAD-only, so there is no credential input for the tool to screen
in the first place. **Do not paste a secret into a name field** — this is the exact
hazard stop condition 2 (§9) exists for: if a step ever seems to want a credential
where a name belongs, halt and report.

### Exit codes — the operator contract

| Code | Meaning                         | What it tells you                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | confirmed-in-cosmos             | **The only success.** 3 marker-carrying, run-correlated documents were read back out of `temperatures`, and the evidence was written.                                                                                                                                                                                                                                                                                                            |
| 1    | usage error                     | Bad/missing arguments, a refused credential-bearing flag (`--key`, `--connection-string`, `--sas`, …), a **name that fails its per-field rule** (each of the five is validated against its own rule, as narrow as the field needs — a JWT in `--device` fails here; the value is not echoed back), or an **unusable or reused `--evidence-out`** caught by the reservation. **Nothing live happened** — the tool re-reports a usage failure that arrives after a send as **7**, never as 1.                                                                    |
| 2    | send failure                    | `az iot device send-d2c-message` failed. Check `az login` and `az extension add --name azure-iot`.                                                                                                                                                                                                                                                                                                                                               |
| 3    | confirmation timeout            | The bound elapsed with the documents not found. **Not an absence, not a success.**                                                                                                                                                                                                                                                                                                                                                               |
| 4    | auth failure                    | 401/403, or no credential could be acquired. **Says nothing about whether the route delivered.** Usually §4 not propagated.                                                                                                                                                                                                                                                                                                                      |
| 5    | transport abort                 | Retries exhausted on a transport error.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6    | synthetic marker violation      | A read-back document lacked the marker — a defect in the sender, not an acceptable variant.                                                                                                                                                                                                                                                                                                                                                      |
| 7    | correlation ambiguity           | Fewer documents than sent, a duplicate correlator, or an unreadable result. Also the code for a run that concluded a state this tool cannot name — see below. **Stop condition 3 (§9).**                                                                                                                                                                                                                                                         |
| 8    | container definition refusal    | §3's document could not be measured. No default was substituted.                                                                                                                                                                                                                                                                                                                                                                                 |
| 9    | delivered, unexpected partition | The full set **arrived**, and one or more documents do **not carry the expected partition value** — read off the documents, not inferred from which query found them. The route works; the partition assumption does not. "Under a **different** `deviceId`" and "carrying **no** `deviceId` field at all" are stated and recorded separately (§6, §7a). Report it with `observedPartitionValues` — do not re-run hoping for a different answer. |
| 10   | evidence unrecorded             | **A send happened and no record of it survives.** See below — this one needs an action before any diagnosis.                                                                                                                                                                                                                                                                                                                                     |

#### There is no default success — an unnameable outcome exits 7

**Exit 0 requires a confirmation that positively established arrival.** A run
that concluded neither a confirmation nor a named failure is a state the tool
does not anticipate, and it exits **7 (correlation ambiguity)** with an explicit
unanticipated-state line on stderr — never 0. That is the right code rather than
one of its own: "the run concluded nothing I can name" **is** a failure to
correlate anything to this run, which is exactly what exit 7 means to a reader.

You should never see it. If you do, it is a defect in the tool and the
documents may be live: record the ids from the evidence artifact (§7a) or from
the stderr lines, report it, and **do not read it as a success or as an
absence**.

#### Exit 10 — read this before doing anything else

Exit 10 means the live container **changed** and the evidence file could not be
written or built (a permissions problem, a destination that became unusable
between the reservation and the write, a serialization refusal). The reservation
in step 1 of the ordered list above catches the common causes — a missing or
unusable directory, a reused destination — as **exit 1** while nothing has been
sent, so exit 10 is rarer than it was. It has not gone away: the run owns its
reserved file, but the publication write itself can still fail (a full disk, an
unmounted volume) after the send. It is deliberately **not** exit 1: exit 1 means "bad
arguments, nothing live happened", and being told nothing happened while
documents sit in `temperatures` is the one failure MG-53 cannot diagnose — an
unrecorded document is indistinguishable there from the unknown-writer finding
its halt exists to catch.

The tool prints, on stderr, the run id, the marker and **every document id that
is (or may be) live**, followed by `RECORD THESE IDS BY HAND`. Do exactly that,
into the ticket, **before** re-running. A re-run against the **same
`--evidence-out` directory** just works — it mints a fresh run id and names a
fresh file — and the run that failed to record still counts toward what the
source contains.

Exit 10 **takes precedence over the confirmation's own code**, which is printed
on the lines immediately above it (`confirmation timeout`, `auth failure`, and so
on) and is not lost. Recording the ids is the action that has to come first;
diagnosing the route is the action that comes second.

#### A send failure is AMBIGUOUS, and the record says so

**`az` reporting failure does not establish that IoT Hub rejected the message.**
The CLI can fail _after_ the hub accepted it — a nonzero exit on teardown, a
killed process, a lost response. So a failed send is ambiguous **by
construction**, and the tool never records one as definitively not-sent.

That applies to the **first** message as much as the third. If `az` fails on
message 1 of 3, the run exits **2 (send failure)** and still writes an evidence
artifact: one id in `requestedIds` and in `ambiguousIds`, `uncertain: true`, and
an `ambiguous-acceptance` finding. **Read that as "this id may be in the
container", never as "nothing was written"** — treat it as accounted-for when
MG-53 reconciles the source, exactly like a confirmed one.

The per-message send lines carry the ids as they go, too, so a run killed
mid-flight leaves them in your terminal even if it never reached the artifact.

### Running it twice

Each invocation mints a **new** `fixtureRunId` and a fresh set of message ids, and
reads no state a prior run wrote. Two runs therefore produce two independently
identified document sets. **Point every run at the same `--evidence-out`
directory** and let the tool name the files: the file name is derived from the
run's unique id, so two runs can never collide, and there is nothing to
coordinate.

#### Evidence artifacts are immutable and per-run

There is **no `--overwrite` flag and no mode that replaces a record**. Each run
exclusively owns one file, whose name is derived from its unique id, and that file
is claimed by an atomic reservation **before the send**. A file already at that
derived name is a genuinely reused destination and the run refuses to start
(**exit 1**, nothing sent). This is deliberate: a committed evidence record
accounts for documents that are **still in the container**, and there is no
supported way to destroy it.

Two consequences worth internalising:

- **Overlapping runs are fine — and never share a destination.** Because the file
  name is derived from a unique run id, two concurrent runs against the same
  `--evidence-out` directory own **different** files. There is no shared-writer
  coordination to get wrong, no `.partial` interleave, and no way for one run's
  record to end up under another run's name.
- **Re-running after a failure just works.** Point the re-run at the same
  directory; it mints a fresh run id and names a fresh file. The failed run's
  documents may well be live (exit 2 and exit 10 both leave that open), and its
  record — under its own run-id-named file — is the only thing that accounts for
  them, so leave it in place.

---

## 7. The evidence to capture, and where it goes

Two artifacts. They are not interchangeable.

### 7a. The machine-readable artifact — the one MG-53 and MG-54 consume

`--evidence-out` is a **directory**; the tool writes **one JSON document** into it,
named `mg67-fixture-evidence-<fixtureRunId>.json`, atomically. Commit that exact
file (the run printed its path — see §6) and reference it from the ticket. **This
file, not this runbook, is what downstream tickets parse** — a prose procedure
that drifts is a documentation bug; a machine-readable record that drifts is a
wrong deletion.

**A neighbouring filename you may see.** The write goes to a per-run temporary file
first and is renamed into place over the run's own reservation, so no reader ever
sees a half-written record:

| Filename                                                         | What it is                                                                                                                                                                       | What to do                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mg67-fixture-evidence-<fixtureRunId>.json.<runId>.partial`      | The per-run temp file for the write. It exists only for the instant between writing the record and renaming it into place; a failed write removes it rather than leaving debris. | Nothing in a normal run. If one lingers, read the run id out of the name: known crashed run → delete deliberately; unaccounted-for → §9, report it. |
| `mg67-fixture-evidence-<fixtureRunId>.json` (**empty, 0 bytes**) | A reservation whose run reserved a destination and then wrote nothing (a refused pre-send read, an interrupted settlement). The tool removes it on exit; a leftover is inert.    | Nothing. It is not a record (an empty file is not valid JSON). Delete it if it bothers you.                                                         |

The committed artifact is the **non-empty** JSON file named for the run. Commit
that and nothing else.

Fields, by their real names. It is **`schemaVersion: 2`**; MG-53 and MG-54 check
that first and must refuse a version they were not written against.

| Field                                                                                                 | What it carries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `kind`, `ticket`, `tool`, `toolVersion`                                              | Provenance. MG-53/MG-54 check `schemaVersion` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `runId`, `runInstant`                                                                                 | The per-run correlator and the absolute wall-clock instant of the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `confirmed`, `uncertain`, `attempted`, `outcome`, `exitCode`, `exitLabel`, `outcomeReason`, `scope`   | The outcome. `confirmed: true` only ever accompanies `exitCode: 0`. `outcome` is the stable slug to branch on. `scope` is `expected-partition`, `cross-partition`, `aborted-after-read-back` or `not-attempted`, and says which read found the documents — **not** where they landed. `scope: cross-partition` with `exitCode: 0` is a confirmed run whose documents the sweep found in the **expected** partition; where they landed is `observedPartitionValues`.                                                                                                              |
| `marker` → `field`, `value`, `runIdField`                                                             | `syntheticFixture` / `MG-67-SYNTHETIC-FIXTURE` / `fixtureRunId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `deviceId`                                                                                            | The fixture device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `target` → `hub`, `account`, `database`, `container`                                                  | Where the documents are. Names only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `containerName`, `partitionKeyPath`, `partitionKeyField`, `partitionValue`, `observedPartitionValues` | The measured shape and the partition actually used/observed. `observedPartitionValues` records a document carrying **no** partition key field as the reserved token `<no-partition-key-field>`, and one whose value is present but empty or not a string as `<unusable-partition-key-value>` — **recorded states, not an absence**. An empty list would throw away the one fact separating "landed under a different key" from "landed under no key at all", and the second is the predicted failure mode for this route. Neither token is a legal device id this fixture mints. |
| **the four id sets** — see below                                                                      | `requestedIds`, `acceptedIds`, `ambiguousIds`, `observedIds`, each with its `…Count`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **`accountableIds`**, **`accountableCount`**                                                          | **Everything that is, or MAY BE, in the container** — accepted ∪ ambiguous ∪ observed, unioned once, here. **This is the set MG-53 must account for.**                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `anomalousIds`, `anomalousCount`                                                                      | Documents **the correlated read-back** returned that this run cannot claim — they carry this run's `fixtureRunId` but not the marker, or name a foreign run: a sender defect or a correlator collision. Kept strictly apart from the run's own ids. **This is NOT stop condition 1** — see below.                                                                                                                                                                                                                                                                                |
| **`unknownWriterCheck`**                                                                              | A constant `checked: false`, `by: "operator-unfiltered-enumeration"`. The record saying **in itself** that stop condition 1 is not evaluated by this tool, and naming what does evaluate it (§9).                                                                                                                                                                                                                                                                                                                                                                                |
| **`ids`**, **`count`**                                                                                | Schema-v1 aliases for `observedIds` / `observedCount` — the same array, so they cannot disagree. **This is the list MG-54 cites for disposal.**                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `expectedCount`, `idDivergence`                                                                       | What the run expected, and whether a **witnessed** observed document carried an id the sender did not request. Divergence is an observation, not a failure — and never inferred from a count shortfall.                                                                                                                                                                                                                                                                                                                                                                          |
| **`measuredDefaultTtl`**, `declaredDefaultTtl`, `ttlExpires`, `ttlDriftFinding`, **`expiryInstant`**  | HR4. The **measured** retention, the declared comparand, any drift, and when these documents age out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `waitBoundMs`, `pollIntervalMs`, `observedArrivalMs`, `elapsedMs`, `polls`, `crossPartitionSweepRun`  | The wait actually used and how long arrival really took.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `findings`                                                                                            | `ttl-drift`, `id-divergence`, `ambiguous-acceptance`, `unattributable-documents`, `partition-landing`, `no-ttl-expiry`, `unconfirmed-run` — each with `kind`, `measured`, `declared`, `message`. `partition-landing` names each landing state separately and appears on a **confirmed** run too: a confirmed run whose documents carry an odd partition value is still confirmed, and the oddity is recorded rather than dropped.                                                                                                                                                |

#### The four id sets are not interchangeable

Do not collapse them, and do not read one as a proxy for another:

| Set            | Means                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestedIds` | The sender **attempted** this message. Recorded before the attempt, so a process killed mid-send still accounts for it.                                                                     |
| `acceptedIds`  | `az` reported success. The message is IoT Hub's problem from there.                                                                                                                         |
| `ambiguousIds` | `az` reported failure and acceptance is **UNKNOWN**. The CLI can fail _after_ the hub took the message. **Never read this as "not written."**                                               |
| `observedIds`  | **Read back out of Cosmos.** Monotonic — once a document has been observed, no later failure discards it, so a run that saw documents and _then_ aborted on auth still records what it saw. |

`uncertain: true` means this run does **not** know what the container holds —
because something's acceptance was never established, or no confirmation
completed. **`count: 0` alongside `uncertain: true` is not "nothing arrived".**
The only record that asserts the full expected set is present is `confirmed:
true`, and `confirmed: true` alongside `uncertain: true` is a legitimate
combination: the proof holds _and_ some message's acceptance was never
established. Both facts are true; collapsing either loses a halt condition.

#### `anomalousIds` is NOT the unknown-writer check — do not gate on it

An earlier revision of this runbook told MG-53 to read a non-empty `anomalousIds`
as stop condition 1. **That was wrong, and it is retracted here.**

The tool's read-back is a single query filtered to this run's own correlator:

```sql
SELECT * FROM c WHERE c.fixtureRunId = @runId
```

A document an **unknown writer** put in the container does not carry this run's
freshly minted `fixtureRunId`, so the query never returns it, so it can **never**
reach `anomalousIds` — on any path, including the cross-partition sweep, which
uses the same predicate. `anomalousCount: 0` therefore says **nothing whatsoever**
about unknown writers. It is not weak evidence of their absence; it is no evidence
at all, and a consumer that reads it as a cleared stop condition proceeds on a
vacuous proof of exactly the kind this ticket exists to eliminate.

So the record carries a permanent, explicit retraction instead:

```json
"unknownWriterCheck": {
  "kind": "not-performed-by-this-tool",
  "checked": false,
  "by": "operator-unfiltered-enumeration"
}
```

**`checked` is a constant `false`.** No input to the tool can flip it, because
nothing the tool does enumerates the container without the run-id predicate.
**Stop condition 1 is checked by the operator's UNFILTERED enumeration in §9, and
by nothing else** — compared against `accountableIds` recorded here. MG-53 must
perform that enumeration itself rather than trusting a zero in this file.

What `anomalousIds` **does** mean is narrower and still worth acting on: a
document that carries **this run's** correlator while failing to carry the marker
(a sender-side defect) or naming a foreign run (a correlator collision). Both are
real, both are recorded by id because nobody can investigate a document nobody
named, and neither is an unknown writer.

Two things to read out of it immediately:

- **`observedArrivalMs`** is the calibration every later ticket inherits. It is
  the first real measurement of how long this route takes; MG-62 should size its
  wait from this number rather than re-guessing.
- **`expiryInstant` is an UPPER bound.** Cosmos starts the TTL clock when the
  _document_ is written, up to `observedArrivalMs` before the record's clock was
  read. Near the boundary, treat
  `[expiryInstant − observedArrivalMs, expiryInstant]` as indeterminate.

> The record has a **closed key set** and is scanned for credential-shaped keys
> and values at build **and** write time; a hit refuses the write rather than
> redacting. It is safe to commit and safe to attach to the ticket.

**A record is written on EVERY outcome that attempted a send** — timeout, auth,
transport, marker violation, ambiguity, send failure — carrying an
`unconfirmed-run` finding. Only a run that refused **before its first attempt**
(bad arguments, an unmeasurable container, a refused pre-send read) exits without
one, and that is the only case where "nothing was written" is a fact rather than
a guess. A non-`confirmed` record is a record of what was observed and what may
exist. **It is not proof.**

That holds for a **partial send** as well, and for a failure on message 1. The
record carries the attempted ids in `requestedIds`, the ones of unknown fate in
`ambiguousIds`, and their union with anything observed in `accountableIds`. Read
it as _"these ids may be in the container"_ and treat them as accounted-for when
MG-53 reconciles the source. **No record this tool writes ever asserts that
nothing was written when something was attempted** — an error reported as a known
absence is the MG-66 conflation, and this is the write side of it.

It also holds for a run that **observed documents and then aborted**. Auth or
transport failing on a later poll does not discard what an earlier poll already
saw: those ids stay in `observedIds`, and `scope` reads
`aborted-after-read-back` rather than `not-attempted`.

If the record itself cannot be written, the run exits **10** and prints the ids —
see §6's exit-code table. There is no path on which this tool sends a document
and then stays silent about it.

### 7b. What to paste into the ticket

- The `send-fixture` **exit code** (`$RUN_EXIT`) and the command line you ran.
- **The captured run log from §6** (`$RUN_OUT` and `$RUN_ERR`), inspected and
  promoted per **§7c**, which is where the two files go and what has to be true
  before they go there. They carry the measured container line, the
  evidence-destination line, the pre-send line, the per-message send lines and
  the final `CONFIRMED …` line. Every one is scrubbed by construction, and
  failure output names the device, the hub, the outcome and the exit label,
  never a secret — **but that is the claim, and §7c is what checks it.** Capture
  the log even on a failed run; especially on a failed run.
- The path and content of the evidence artifact from §7a.
- The registered `deviceId` (from §2a's `list`).
- The §4 state file (`MG67_ASSIGNMENT_NAME` and the principal), and the §5
  removal proof — **both** checks: yours is gone, and the before/after name diff
  is empty. If §4b took the `skip` branch, record that state file
  (`MG67_CREATED=no` and the pre-existing id) instead — a skip is a recorded
  outcome, and "nothing was created" is a claim the ticket needs made explicitly.
- **The three §9 enumeration queries and their outputs, per container.** This is
  the check for stop condition 1; the evidence artifact does not perform it and
  says so (`unknownWriterCheck.checked: false`).
- Any `findings` entry, especially `ttl-drift`, `ambiguous-acceptance` and
  `unattributable-documents` — reading the last one as an unknown-writer result
  is the misreading §7a retracts.

### 7c. The captured run log — the credential non-emission proof

This ticket's acceptance says no credential "is emitted on any output path
including failures". **Reading the source proves the tool is built not to emit
one; only the captured output of a live run proves it did not.** The pipeline
cannot produce this evidence — it holds no credential and makes no live call —
so it is yours, and without it the criterion closes on a code review rather than
on an observation. That is the substitution §8 exists to reject.

#### Inspect before you commit anything

Run this against **both** captured streams from §6:

```bash
# Every shape the tool's own scrubber matches, plus the ones this ticket names.
# The pattern is a SHAPE, not a secret — no value appears in it, which is why it
# is safe to keep in this document.
CRED_SHAPES='SharedAccessKey|AccountKey|SharedAccessSignature|BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9]|[?&](sig|se|skn|sr)=|[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(key|token|secret|password|credential|sig)[A-Za-z0-9_-]*[=:][^[:space:]]'

grep -nEi "$CRED_SHAPES" "$RUN_OUT" "$RUN_ERR"
```

**Hits are EXPECTED, and a hit is not by itself a failure.** The scrubber
replaces a matched value with the literal `[redacted]` and leaves the key name
standing, so `…key=[redacted]` matches this pattern by design. What you are
checking is one thing:

> **Every hit's VALUE must be `[redacted]`.** A hit whose value is anything else
> — a base64 blob, a hex string, a signature, a token, a `Host…=…;…Key=…`
> connection string — is a live credential in a log file.

Two consequences of the scrubber's design make this sweep readable rather than
noisy. It over-redacts on purpose (the accepted MG-63 limitation: a
credential-shaped **key name** always redacts, so a benign
`partitionKey=deviceId` reads
`partitionKey=[redacted]`), and it replaces values **whole** — never a prefix,
never a length, never a hash, because each of those is still a fact about the
secret. So the expected reading of this grep is a short list of `[redacted]`
placeholders and nothing else.

#### Second sweep: a credential with no key name in front of it

The pattern above finds a secret by the **name next to it**. A bare blob on its
own line — a key echoed with no label, a token on a continuation line — has no
name to match, so run this too:

```bash
grep -nE '[A-Za-z0-9+]{32,}={0,2}' "$RUN_OUT" "$RUN_ERR"
```

**Expect this one to be completely empty**, and treat any hit as a finding to
explain before you promote anything. Nothing this tool prints legitimately
contains a 32-character unbroken alphanumeric run: the ids it emits are
uuid-shaped (dashes break the run), the paths contain `/`, the instants contain
`-` and `:`, and the device, hub, database and container names all contain `-`.
That is what makes an empty result meaningful here rather than merely likely.

Between them the two sweeps cover a credential that has a name and one that does
not. Neither is a proof of absence — no grep is — but a leaked credential that
evades **both** would have to carry no credential-shaped name **and** no
32-character unbroken run, which no key, token, signature or connection string
this system handles does.

#### An unexplained hit from either sweep is stop condition 2 — halt, do not commit

That means: a first-sweep hit whose value is **not** `[redacted]`, or **any**
second-sweep hit you cannot account for. In order:

1. **Do not commit the log**, do not paste it into the ticket, and do not paste
   the matching line anywhere. Committing it is what turns a transient leak into
   a permanent one, and this document's own no-credential guarantee with it.
2. **Halt the procedure.** This is stop condition 2 (§9): "do not ship a weaker
   variant". Do not scrub it by hand and carry on — a hand-scrubbed log proves
   nothing about the tool, which is the thing under test.
3. **Report it** on the ticket, by **file, line number and which stream** — the
   shape that leaked, never the value.
4. **Treat the credential as exposed.** It reached a file on your disk, your
   terminal scrollback and possibly your shell history. If it is device key
   material, the device is re-creatable: delete and re-register it via §2a
   rather than rotating by hand.
5. Delete the captured files once the report is filed.

#### Where the capture goes when it passes

```bash
# ONLY after BOTH sweeps pass: the first showing nothing but [redacted]
# placeholders, the second showing nothing at all. Named for THIS run's
# correlation id ($RUN_ID, from §6) — the same id the artifact's name derives
# from — so the three files belong to this run unambiguously and cannot be
# confused with an overlapping run's logs.
test -n "$RUN_ID" || { echo "STOP: \$RUN_ID is unset (see §6); do not promote logs under a guessed name."; }
cp "$RUN_OUT" "docs/infrastructure/evidence/mg67-fixture-run-${RUN_ID}.stdout.log"
cp "$RUN_ERR" "docs/infrastructure/evidence/mg67-fixture-run-${RUN_ID}.stderr.log"
```

Alongside the machine-readable artifact and named for the **same run id**, so the
three files of one run sort together and a reader can tell which log belongs to
which record. Commit them with the artifact and reference them from the ticket.

**Order matters and is not a formality: inspect, then promote.** The reverse —
commit and then check — is the failure this section exists to prevent, because a
credential that reaches a commit is in the history whether or not the next
command deletes it.

**These logs are evidence, not the artifact.** MG-53 and MG-54 parse §7a's JSON
and must never parse these; prose that drifts is a documentation bug, a
machine-readable record that drifts is a wrong deletion (§7a).

---

## 8. Rejected proofs — what does NOT count as evidence

**Only one thing is accepted as proof: a specific, newly identified,
marker-carrying document, not present before the run, read back out of the
`temperatures` container after being sent from the registered device.** That is
exit 0, and it is the only thing exit 0 means.

Each of the following is **rejected**, individually and in combination:

- **A green IoT Hub metric** (`d2c.telemetry.ingress.success`, connected devices,
  message counts). It observes a message reaching the _hub_. It observes no
  document.
- **A green route metric** (`d2c.endpoints.egress.*`, latency, delivery counts).
  It observes the hub's _attempt_ to deliver. It observes no document.
- **A green `/api/health/cosmos`.** That endpoint performs a **database-level
  metadata read**: it reads no container and no document. It was green during the
  entire period in which zero documents existed.
- **A container `DocumentCount` metric moving.** A count is not a document: it
  cannot tell you the document carries the marker, belongs to this run, or is one
  of yours at all. Useful as a screening signal in §9; never as proof.
- **The absence of an error.** The tool is built so that an absence of an error
  is never success — a timeout, an ambiguous read and an auth failure each have
  their own nonzero exit code and none of them can present as an absence.

### Why this section exists

This repo has shipped broken work behind green signals **twice**.

- **MG-24** carried a conditional ("keys disabled ONLY IF host storage is fully
  managed-identity; VERIFY first") that was not verified against the running
  system.
- **MG-58** is the sharper precedent: the dev Function App's host storage was
  **completely dead** — no host lock lease, no timer schedule status,
  `Process reporting unhealthy` every ~30 seconds — while **eleven green checks**,
  a clean Terraform plan and seven HTTP endpoints returning `200` all reported
  health. The defect was structurally invisible to every configuration-level
  gate. What finally proved the fix was a **blob lease** and a **timer execution**:
  effects that are _impossible_ unless the thing being tested actually works.
  See [`mg58-host-storage-verification.md`](./mg58-host-storage-verification.md).

A document read back out of the destination container is this ticket's
equivalent: an effect that cannot be manufactured by a healthy-looking signal.
**Do not offer a metric or a health check in its place, and do not accept one.**

---

## 9. Stop conditions — halt and report, do not work around

Operator-set, quoted verbatim from the MG-67 brief. Any of these means **stop and
report** rather than proceeding or improvising:

> 1. ANY unexpected document found in the source containers — that is, any
>    document that is not one this fixture's own sends produced. It would mean an
>    unknown writer exists, contradicting the topology analysis above. Report it
>    as a finding.
> 2. ANY design or implementation that risks credential exposure in source or in
>    logs, on any path including failures. Do not ship a weaker variant.
> 3. ANY inability to correlate a sent message with a SPECIFIC Cosmos document.
>    If the correlation cannot be established deterministically, the fail-closed
>    contract cannot be honored — stop and report rather than substituting a
>    count delta, a metric, or a timestamp heuristic.

### Checking stop condition 1 — an UNFILTERED enumeration, and it is yours to run

> **The tool does not check this stop condition and cannot.** Its read-back is
> filtered to this run's own `fixtureRunId`, so a document an unknown writer
> produced is never returned by it and never appears in any of its id sets —
> including `anomalousIds`, which is a **different** finding (§7a). The evidence
> record says so in itself: `unknownWriterCheck.checked` is a constant `false`
> with `by: "operator-unfiltered-enumeration"`. **This section is that
> enumeration. If you skip it, stop condition 1 is unchecked — not cleared.**

The topology analysis says there is **no other writer**: the business API serves
inline mock data, `libs/azure-client` contains no database code at all (MG-59),
and the only application code that touches Cosmos is `/api/health/cosmos`, which
reads database-level metadata and no document. So every document in
`meatgeek-v2-dev-db` should be one of yours. That is the claim this step tests
rather than assumes.

Enumerate all five containers — `devices`, `temperatures`, `cooks`, `users`,
`recipes`. `az` has no data-plane query command, so use the **portal Data
Explorer** for the observation itself. Run all three **per container**:

```sql
-- 1. The unfiltered total. Nothing in the predicate; that is the point.
SELECT VALUE COUNT(1) FROM c

-- 2. Anything WITHOUT the synthetic marker. This is the unknown-writer check.
--    ANY NONZERO RESULT IS A HALT.
SELECT VALUE COUNT(1) FROM c WHERE NOT IS_DEFINED(c.syntheticFixture)

-- 3. The marked documents, BY ID, to reconcile against the evidence records.
SELECT c.id, c.fixtureRunId, c.deviceId FROM c WHERE IS_DEFINED(c.syntheticFixture)
```

Query 2 is the halt. Query 3 is the reconciliation: **every id it returns must
appear in the `accountableIds` of one of your committed evidence records.** An id
that appears in neither — marked or not — is an unaccounted-for document and is
also a halt.

**Reconcile against `accountableIds`, not against `ids`.** `ids` is what was read
back; `accountableIds` additionally covers everything a run accepted or left of
unknown acceptance, which is the set that may exist. Reconciling against the
narrower one manufactures an unaccounted-for document out of a run that recorded
it honestly. A **smaller** count than recorded is expected TTL expiry — check
`expiryInstant` in the evidence before concluding anything else.

Record all three outputs on the ticket. Query 1's unfiltered total is the number
MG-53 needs and the tool structurally cannot supply: it is the only figure that
covers documents no correlator of ours would ever match.

A container `DocumentCount` metric can be used to screen quickly, but read §8
first: it tells you a number, never what the documents are — and a count cannot
distinguish an unknown writer's document from one of yours, which is the whole
question here.

### Checking stop conditions 2 and 3

Stop condition 3 is what **exit 7** (correlation ambiguity) and **exit 6** (marker
violation) mean. If you get either, **do not re-run to get a cleaner number and
do not reason from counts** — report the exit code, the evidence artifact and the
tool's output as a finding.

Stop condition 2 has no partial form, and it is checked in **two** places.

_Before the fact_: if any step here appears to require supplying a key, a
connection string, a SAS token or a certificate, **stop**. The tool is designed
so that no such step exists; needing one means something else is wrong.

_After the fact_: **§7c is the observation** — the captured stdout and stderr of
the live run, swept for credential shapes. It is the only step in this procedure
that can tell you a credential was emitted rather than that one could have been,
and it is the only evidence that discharges this ticket's no-emission
criterion. **Skipping §7c leaves stop condition 2 unchecked, not cleared** — the
same distinction §9's enumeration draws for stop condition 1. An unexplained hit
halts the procedure, and the log is not committed.

---

## 10. Findings recorded here, deliberately NOT fixed

Each of these is real, each is out of this ticket's scope, and each is recorded
so it is not rediscovered from scratch.

### 10a. The real producer sets no content type — this proof covers the FIXTURE's message shape only

IoT Hub writes a **queryable JSON document** to a Cosmos endpoint only when the
D2C message declares `$.ct=application/json` and `$.ce=utf-8`. Without them the
payload lands opaque.

The fixture sets both, explicitly. **`apps/data-pusher` sets neither.**
`buildPublishProperties` (`apps/data-pusher/cmd/main.go`) emits exactly
`messageId`, `correlation.id` and `traceparent`, and `buildPublishTopic`
(`internal/iothub/client.go`) URL-encodes those onto the MQTT topic — no `$.ct`,
no `$.ce`.

**So a green run of this procedure proves the route carries the _fixture's_
message shape. It does not prove the data-pusher's messages land as JSON
documents.** That is a latent defect, and it is genuinely separate work: fixing a
live producer under cover of a verification ticket is how unreviewed producer
changes ship. File it and cite this section.

### 10b. The same messages also fan out to `eventhub-realtime-route`

`cosmos-storage-route` is not the only route with `source = DeviceMessages` and
`condition = "true"`. `eventhub-realtime-route` matches identically, so **every**
fixture message is **also** delivered to the Event Hub
(`message_retention = 1` — one day) which today has **no consumer**.

Nothing to do about it; nothing breaks. Know it so a duplicate-delivery
observation on the real-time path is not mistaken for a defect, and so the
synthetic messages are not a surprise if a consumer is attached within a day.

### 10c. Any measured TTL drift

If §3 measured a `defaultTtl` other than 604800, the tool records a `ttl-drift`
finding naming both numbers and uses the **measured** value throughout. Report it
with the evidence. Do not reconcile it here — changing the container is out of
scope, and the measured number is the one that governs when these documents
disappear.

---

## 11. Sequencing and related tickets

| Ticket            | Relationship                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MG-53**         | Reads this run's evidence artifact as a **program input**. It confirms the source contains **only** these recorded documents before creating anything; any unmarked or unrecorded document halts its sequence. **It must run §9's unfiltered enumeration itself** — the artifact's `unknownWriterCheck.checked` is a constant `false`, and `anomalousCount: 0` is not an unknown-writer clearance (§7a). |
| **MG-54**         | Its destructive authorization explicitly covers disposing of these documents, **citing the `ids` and `count` recorded here**.                                                                                                                                                                                                                                                                            |
| **MG-62**         | Reuses this device for its post-cutover proof. Must **re-run §2a and re-check** that the device exists (§2c) — a hub replacement empties the registry silently. Should size its confirmation wait from this run's `observedArrivalMs`.                                                                                                                                                                   |
| **MG-59**         | Adds Cosmos persistence to the business API / `libs/azure-client`. Explicitly out of scope here. The fixture body deviates from `libs/api-specs` `TemperatureReading` (`additionalProperties: false`) by carrying the marker fields; that is an accepted **fixture-only** deviation flagged to MG-59, and the schema is not edited.                                                                      |
| **MG-66**         | Owns `scripts/cosmos-export/` and its absence-handling semantics — untouched here. The narrow-scope data-plane role gap noted in §4 is its.                                                                                                                                                                                                                                                              |
| **MG-63**         | The known, accepted over-redaction limitation in the existing scrubber. **Not reopened and not "fixed" here.**                                                                                                                                                                                                                                                                                           |
| **MG-58 / MG-24** | The green-signal precedents §8 exists because of.                                                                                                                                                                                                                                                                                                                                                        |

---

## 12. Sign-off checklist

| #   | Item                                                                                                                                                             | Evidence to record                                  | State       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------- |
| 1   | Fixture device registered on `meatgeek-v2-dev-iothub-259d4bf5b628` (§2)                                                                                          | the `deviceId` + `status` row                       | **NOT RUN** |
| 2   | Live `temperatures` definition read; partition key path and `defaultTtl` measured (§3)                                                                           | the `jq` output                                     | **NOT RUN** |
| 3   | Temporary account-scope Data Reader assignment created **under a captured id**, or the `skip` branch taken because you already held one (§4)                     | the §4 state file, `MG67_CREATED` either way        | **NOT RUN** |
| 4   | `send-fixture.mjs` exits **0** (§6)                                                                                                                              | the exit code + the command line                    | **NOT RUN** |
| 5   | Evidence artifact written and committed, `schemaVersion: 2`, with non-empty `ids`, `count == 3`, empty `anomalousIds`, and `measuredDefaultTtl` (§7a)            | the file path + its contents                        | **NOT RUN** |
| 5b  | Run stdout **and** stderr captured, inspected for credential shapes, and promoted alongside the artifact (§7c) — **the only proof of the no-emission criterion** | the grep output + the two committed log files       | **NOT RUN** |
| 6   | **Unfiltered** enumeration of all five source containers run, and they hold **only** the documents `accountableIds` accounts for (§9)                            | all three Data Explorer queries, per container      | **NOT RUN** |
| 7   | Temporary role assignment **removed by its captured id**, and **nothing else removed** (§5) — or `MG67_CREATED=no`, so nothing was created to remove             | both §5 proofs: yours gone, before/after diff empty | **NOT RUN** |
| 8   | Findings 10a / 10b / any TTL drift raised on the ticket                                                                                                          | the finding text                                    | **NOT RUN** |

**MG-67 closes when every line above is recorded — and not before.** Line 4 is
the traversal; lines 5 and 7 are what the downstream tickets and the security
posture depend on. **Line 6 is the only check of stop condition 1 anywhere in
this ticket** — no field of the evidence artifact performs it, and the artifact
says so. **Line 5b is the only check of the credential non-emission criterion**:
the code review says the tool cannot emit a credential, and only a captured live
run says it did not. A green metric on any of them is not a substitute (§8).

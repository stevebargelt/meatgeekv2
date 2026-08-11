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
az cosmosdb sql role assignment list \
  --account-name "$ACCOUNT" --resource-group "$RG" --only-show-errors \
  -o json > "$BEFORE"
jq -r '.[] | [.name, .principalId, .roleDefinitionId, .scope] | @tsv' "$BEFORE"

# Does your principal ALREADY hold an account-scope data-plane assignment?
# Account scope is the account resource id with no /dbs/ segment appended.
EXISTING=$(jq -r --arg p "$PRINCIPAL_ID" '
  [ .[]
    | select(.principalId == $p)
    | select((.scope | test("/dbs/")) | not)
    | select(.roleDefinitionId | test("00000000-0000-0000-0000-00000000000[12]$"))
    | .name ] | join(" ")' "$BEFORE")
echo "pre-existing account-scope data-plane assignment(s) for you: ${EXISTING:-none}"
```

**If `EXISTING` is non-empty, do NOT create anything.** You can already read the
container, and granting a second assignment only manufactures something for §5 to
get wrong. Record the skip and move to §6:

```bash
if [ -n "$EXISTING" ]; then
  {
    echo "MG67_CREATED=no"
    echo "MG67_ASSIGNMENT_NAME="
    echo "MG67_PRE_EXISTING=$EXISTING"
  } > "$MG67_STATE"
  echo "SKIPPING the grant: you already hold $EXISTING. §5 has NOTHING to remove."
fi
```

That pre-existing assignment is **not yours to remove**, in this ticket or any
other. If you believe it is stale, that is a **finding to raise**, not a step in
this runbook.

### 4b. Create the temporary assignment under an id YOU mint

```bash
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
  # Reader, not Contributor: this tool only ever reads. The WRITES come from the
  # IoT Hub's own system-assigned identity, which Terraform already grants
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
    cat "$MG67_STATE"      # PASTE THIS INTO THE TICKET NOW — §5 cannot proceed without it
  fi
fi
```

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
mkdir -p docs/infrastructure/evidence
EVIDENCE="docs/infrastructure/evidence/mg67-fixture-run-${STAMP}.json"

node apps/infrastructure/scripts/iot-fixture/send-fixture.mjs \
  --hub "$HUB" \
  --device "$DEVICE" \
  --account "$ACCOUNT" \
  --database "$DATABASE" \
  --container "$CONTAINER" \
  --container-definition "/tmp/mg67-${CONTAINER}-${STAMP}.json" \
  --timeout 180000 \
  --poll-interval 5000 \
  --evidence-out "$EVIDENCE"
RUN_EXIT=$?
echo "send-fixture exit=$RUN_EXIT"     # RECORD THIS — it is half the proof
```

`node .../send-fixture.mjs --help` is the authoritative flag reference; the flags
above are the complete set you need. `--timeout` and `--poll-interval` are shown
explicitly rather than defaulted so the **bound actually used** is visible in your
shell history next to the result. The defaults are the same values (180000 ms /
5000 ms) if you omit them.

### What the tool does, in order — and where it can stop

1. **Measures** the container from §3's document. Refuses on anything it cannot
   read (**exit 8**); never defaults.
2. **Reads the container BEFORE sending**, requiring this run's freshly minted
   `fixtureRunId` to be absent. This is what makes the proof a _newly identified_
   document rather than an assumption, and it surfaces a missing/unpropagated
   role assignment (**exit 4**) while **nothing has been sent**.
3. **Sends 3 D2C messages** via `az iot device send-d2c-message`, each carrying
   `syntheticFixture=MG-67-SYNTHETIC-FIXTURE`, this run's `fixtureRunId`, a
   `fixtureSequence`, `ticket`, the partition field measured in §3 and a
   `timestamp` — and each declaring `$.ct=application/json` and `$.ce=utf-8` as
   system properties. Any nonzero `az` exit aborts the run (**exit 2**) — after
   recording, for every message it attempted, whether `az` accepted it or left
   its acceptance **unknown**.
4. **Polls** for the full set within the bound. Timeout is **exit 3**, a document
   without the marker is **exit 6**, a partial or ambiguous read is **exit 7**,
   and documents found only outside the expected partition are **exit 9** —
   never conflated, never reported as an absence.
5. **Writes the evidence artifact** (§7) — on **every** outcome that attempted a
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

### Exit codes — the operator contract

| Code | Meaning                         | What it tells you                                                                                                                                                             |
| ---- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | confirmed-in-cosmos             | **The only success.** 3 marker-carrying, run-correlated documents were read back out of `temperatures`, and the evidence was written.                                         |
| 1    | usage error                     | Bad/missing arguments, or a refused credential-shaped flag. **Nothing live happened** — the tool re-reports a usage failure that arrives after a send as **7**, never as 1.   |
| 2    | send failure                    | `az iot device send-d2c-message` failed. Check `az login` and `az extension add --name azure-iot`.                                                                            |
| 3    | confirmation timeout            | The bound elapsed with the documents not found. **Not an absence, not a success.**                                                                                            |
| 4    | auth failure                    | 401/403, or no credential could be acquired. **Says nothing about whether the route delivered.** Usually §4 not propagated.                                                   |
| 5    | transport abort                 | Retries exhausted on a transport error.                                                                                                                                       |
| 6    | synthetic marker violation      | A read-back document lacked the marker — a defect in the sender, not an acceptable variant.                                                                                   |
| 7    | correlation ambiguity           | Fewer documents than sent, a duplicate correlator, or an unreadable result. **Stop condition 3 (§9).**                                                                        |
| 8    | container definition refusal    | §3's document could not be measured. No default was substituted.                                                                                                              |
| 9    | delivered, unexpected partition | The documents **arrived**, but not under the expected partition. The route works; the partition assumption does not. Report it — do not re-run hoping for a different answer. |
| 10   | evidence unrecorded             | **A send happened and no record of it survives.** See below — this one needs an action before any diagnosis.                                                                  |

#### Exit 10 — read this before doing anything else

Exit 10 means the live container **changed** and the evidence file could not be
written or built (a missing directory, a path the tool refused to overwrite, a
permissions problem). It is deliberately **not** exit 1: exit 1 means "bad
arguments, nothing live happened", and being told nothing happened while
documents sit in `temperatures` is the one failure MG-53 cannot diagnose — an
unrecorded document is indistinguishable there from the unknown-writer finding
its halt exists to catch.

The tool prints, on stderr, the run id, the marker and **every document id that
is (or may be) live**, followed by `RECORD THESE IDS BY HAND`. Do exactly that,
into the ticket, **before** fixing the path and re-running. Then re-run with a
**new** `--evidence-out` path; the run that failed to record still counts toward
what the source contains.

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
identified document sets. Use a **new** `--evidence-out` path each time: the tool
refuses to overwrite an existing evidence file unless you pass `--overwrite`,
because that file records an earlier run whose documents are **still in the
container**, and destroying the record of them manufactures exactly the
unrecorded-document condition that halts MG-53.

---

## 7. The evidence to capture, and where it goes

Two artifacts. They are not interchangeable.

### 7a. The machine-readable artifact — the one MG-53 and MG-54 consume

`--evidence-out` writes **one JSON document**, atomically. Commit it at
`docs/infrastructure/evidence/mg67-fixture-run-<UTC>.json` and reference it from
the ticket. **This file, not this runbook, is what downstream tickets parse** — a
prose procedure that drifts is a documentation bug; a machine-readable record
that drifts is a wrong deletion.

Fields, by their real names. It is **`schemaVersion: 2`**; MG-53 and MG-54 check
that first and must refuse a version they were not written against.

| Field                                                                                                 | What it carries                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `kind`, `ticket`, `tool`, `toolVersion`                                              | Provenance. MG-53/MG-54 check `schemaVersion` first.                                                                                                                                                              |
| `runId`, `runInstant`                                                                                 | The per-run correlator and the absolute wall-clock instant of the run.                                                                                                                                            |
| `confirmed`, `uncertain`, `attempted`, `outcome`, `exitCode`, `exitLabel`, `outcomeReason`, `scope`   | The outcome. `confirmed: true` only ever accompanies `exitCode: 0`. `outcome` is the stable slug to branch on. `scope` is `expected-partition`, `cross-partition`, `aborted-after-read-back`, or `not-attempted`. |
| `marker` → `field`, `value`, `runIdField`                                                             | `syntheticFixture` / `MG-67-SYNTHETIC-FIXTURE` / `fixtureRunId`.                                                                                                                                                  |
| `deviceId`                                                                                            | The fixture device.                                                                                                                                                                                               |
| `target` → `hub`, `account`, `database`, `container`                                                  | Where the documents are. Names only.                                                                                                                                                                              |
| `containerName`, `partitionKeyPath`, `partitionKeyField`, `partitionValue`, `observedPartitionValues` | The measured shape and the partition actually used/observed.                                                                                                                                                      |
| **the four id sets** — see below                                                                      | `requestedIds`, `acceptedIds`, `ambiguousIds`, `observedIds`, each with its `…Count`.                                                                                                                             |
| **`accountableIds`**, **`accountableCount`**                                                          | **Everything that is, or MAY BE, in the container** — accepted ∪ ambiguous ∪ observed, unioned once, here. **This is the set MG-53 must account for.**                                                            |
| `anomalousIds`, `anomalousCount`                                                                      | Documents the correlated read-back returned that this run **cannot claim**. Kept strictly apart from its own. Non-empty is **stop condition 1** (§9).                                                             |
| **`ids`**, **`count`**                                                                                | Schema-v1 aliases for `observedIds` / `observedCount` — the same array, so they cannot disagree. **This is the list MG-54 cites for disposal.**                                                                   |
| `expectedCount`, `idDivergence`                                                                       | What the run expected, and whether a **witnessed** observed document carried an id the sender did not request. Divergence is an observation, not a failure — and never inferred from a count shortfall.           |
| **`measuredDefaultTtl`**, `declaredDefaultTtl`, `ttlExpires`, `ttlDriftFinding`, **`expiryInstant`**  | HR4. The **measured** retention, the declared comparand, any drift, and when these documents age out.                                                                                                             |
| `waitBoundMs`, `pollIntervalMs`, `observedArrivalMs`, `elapsedMs`, `polls`, `crossPartitionSweepRun`  | The wait actually used and how long arrival really took.                                                                                                                                                          |
| `findings`                                                                                            | `ttl-drift`, `id-divergence`, `ambiguous-acceptance`, `unattributable-documents`, `no-ttl-expiry`, `unconfirmed-run` — each with `kind`, `measured`, `declared`, `message`.                                       |

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
- The tool's stdout/stderr lines: the measured container line, the pre-send line,
  the per-message send lines and the final `CONFIRMED …` line. These are safe by
  construction — every one is scrubbed, and failure output names the device, the
  hub, the outcome and the exit label, never a secret.
- The path and content of the evidence artifact from §7a.
- The registered `deviceId` (from §2a's `list`).
- The §4 state file (`MG67_ASSIGNMENT_NAME` and the principal), and the §5
  removal proof — **both** checks: yours is gone, and the before/after name diff
  is empty. If §4 skipped the grant, record that instead.
- Any `findings` entry, especially `ttl-drift`, `ambiguous-acceptance` and
  `unattributable-documents`.

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

### Checking stop condition 1

The topology analysis says there is **no other writer**: the business API serves
inline mock data, `libs/azure-client` contains no database code at all (MG-59),
and the only application code that touches Cosmos is `/api/health/cosmos`, which
reads database-level metadata and no document. So every document in
`meatgeek-v2-dev-db` should be one of yours.

Screen the five containers — `devices`, `temperatures`, `cooks`, `users`,
`recipes` — for anything unexpected. `az` has no data-plane query command, so use
the **portal Data Explorer** for the observation itself:

```
SELECT VALUE COUNT(1) FROM c                                    -- per container
SELECT VALUE COUNT(1) FROM c WHERE NOT IS_DEFINED(c.syntheticFixture)
```

The second query is the one that matters: **any nonzero result is a halt.** Also
halt if `temperatures` holds more marked documents than your evidence records
account for.

**Reconcile against `accountableIds`, not against `ids`.** `ids` is what was read
back; `accountableIds` additionally covers everything a run accepted or left of
unknown acceptance, which is the set that may exist. Reconciling against the
narrower one manufactures an unaccounted-for document out of a run that recorded
it honestly. A **smaller** count than recorded is expected TTL expiry — check
`expiryInstant` in the evidence before concluding anything else.

The tool also screens for this itself: any document its correlated read-back
returned that the run cannot claim goes into the record's `anomalousIds` with an
`unattributable-documents` finding, kept strictly apart from the run's own ids. A
non-empty `anomalousIds` **is** this stop condition, already named for you.

A container `DocumentCount` metric can be used to screen quickly, but read §8
first: it tells you a number, never what the documents are.

### Checking stop conditions 2 and 3

Stop condition 3 is what **exit 7** (correlation ambiguity) and **exit 6** (marker
violation) mean. If you get either, **do not re-run to get a cleaner number and
do not reason from counts** — report the exit code, the evidence artifact and the
tool's output as a finding.

Stop condition 2 has no partial form. If any step here appears to require
supplying a key, a connection string, a SAS token or a certificate, **stop**. The
tool is designed so that no such step exists; needing one means something else is
wrong.

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

| Ticket            | Relationship                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MG-53**         | Reads this run's evidence artifact as a **program input**. It confirms the source contains **only** these recorded documents before creating anything; any unmarked or unrecorded document halts its sequence.                                                                                                                      |
| **MG-54**         | Its destructive authorization explicitly covers disposing of these documents, **citing the `ids` and `count` recorded here**.                                                                                                                                                                                                       |
| **MG-62**         | Reuses this device for its post-cutover proof. Must **re-run §2a and re-check** that the device exists (§2c) — a hub replacement empties the registry silently. Should size its confirmation wait from this run's `observedArrivalMs`.                                                                                              |
| **MG-59**         | Adds Cosmos persistence to the business API / `libs/azure-client`. Explicitly out of scope here. The fixture body deviates from `libs/api-specs` `TemperatureReading` (`additionalProperties: false`) by carrying the marker fields; that is an accepted **fixture-only** deviation flagged to MG-59, and the schema is not edited. |
| **MG-66**         | Owns `scripts/cosmos-export/` and its absence-handling semantics — untouched here. The narrow-scope data-plane role gap noted in §4 is its.                                                                                                                                                                                         |
| **MG-63**         | The known, accepted over-redaction limitation in the existing scrubber. **Not reopened and not "fixed" here.**                                                                                                                                                                                                                      |
| **MG-58 / MG-24** | The green-signal precedents §8 exists because of.                                                                                                                                                                                                                                                                                   |

---

## 12. Sign-off checklist

| #   | Item                                                                                                                                                  | Evidence to record                                  | State       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------- |
| 1   | Fixture device registered on `meatgeek-v2-dev-iothub-259d4bf5b628` (§2)                                                                               | the `deviceId` + `status` row                       | **NOT RUN** |
| 2   | Live `temperatures` definition read; partition key path and `defaultTtl` measured (§3)                                                                | the `jq` output                                     | **NOT RUN** |
| 3   | Temporary account-scope Data Reader assignment created **under a captured id** — or deliberately skipped (§4)                                         | the §4 state file (or the skip note)                | **NOT RUN** |
| 4   | `send-fixture.mjs` exits **0** (§6)                                                                                                                   | the exit code + the command line                    | **NOT RUN** |
| 5   | Evidence artifact written and committed, `schemaVersion: 2`, with non-empty `ids`, `count == 3`, empty `anomalousIds`, and `measuredDefaultTtl` (§7a) | the file path + its contents                        | **NOT RUN** |
| 6   | Source containers hold **only** the documents `accountableIds` accounts for (§9)                                                                      | the two Data Explorer queries                       | **NOT RUN** |
| 7   | Temporary role assignment **removed by its captured id**, and **nothing else removed** (§5)                                                           | both §5 proofs: yours gone, before/after diff empty | **NOT RUN** |
| 8   | Findings 10a / 10b / any TTL drift raised on the ticket                                                                                               | the finding text                                    | **NOT RUN** |

**MG-67 closes when every line above is recorded — and not before.** Line 4 is
the traversal; lines 5 and 7 are what the downstream tickets and the security
posture depend on. A green metric on any of them is not a substitute (§8).

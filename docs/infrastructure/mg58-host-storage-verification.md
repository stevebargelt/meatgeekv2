# MG-58 — Host-Storage Managed Identity: Verification Runbook

> **Read this before you merge the MG-58 branch.** The code change is one app
> setting. The _proof_ is not, and it cannot be produced from CI or from an agent
> container — no automated job in this repo holds a credential that can restart
> the dev Function App, run `func publish`, or query Log Analytics. This document
> is the complete operator procedure for the three proofs the MG-58 ticket
> requires, plus the one pre-merge check that keeps the dev GitOps loop green.
>
> Everything below is **unproven against the live tenant** until an operator runs
> it. Where a query or command could not be executed from the build container, it
> is written to be read and adjusted, not pasted blind.

## What the code change is

`apps/infrastructure/modules/functions/main.tf` now publishes exactly **one**
host-storage app setting on the Flex Consumption Function App:

```hcl
"AzureWebJobsStorage__accountName" = local.functions_storage_account_name
```

That is the identity-based, **account-name** form. It carries a name, not a
credential, so it coexists with `allowSharedKeyAccess = false` on the storage
account. The credential-carrying `AzureWebJobsStorage` connection-string form and
every `AzureWebJobsStorage__*ServiceUri` variant stay **absent** — the two forms
are alternatives, not complements, and publishing both is its own defect. The
service-URI form is for accounts the host cannot reach over standard Azure DNS
(sovereign clouds, custom or private endpoints); this account has none of those.
The reasoning is recorded in
[the MG-58 ADR](../../learnings/decisions/mg-58-host-storage-managed-identity.md),
not just the choice, because MG-34's secure off-VNet edge would invalidate it.

Fixed coordinates used throughout:

| Thing                   | Value                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Workload RG             | `meatgeek-v2-dev-rg` (West US 2)                                                                                               |
| Function App            | `meatgeek-v2-dev-func-259d4bf5b628` — confirm with `terraform output -raw function_app_name` rather than trusting this literal |
| Log Analytics workspace | `meatgeek-v2-dev-logs`, guid `6632bb13-0766-4250-9423-622e00be3482`                                                            |
| Diagnostic setting      | `meatgeek-v2-dev-functions-diag` → `FunctionAppLogs`                                                                           |
| Timer probe             | `storageHeartbeat`, NCRONTAB `0 */15 * * * *`, log marker `storage-heartbeat`                                                  |

---

## 1. Sequence — this ticket is a SINGLE dev GitOps apply

**MG-58 is one apply and nothing else.** One app setting is added to a resource
that already exists; the change plans as an in-place update of
`azurerm_function_app_flex_consumption.main` and nothing more.

Consequently, and stated affirmatively so nobody goes looking for a step that
does not exist: **no role-assignment change, no allowlist edit and no
`bootstrap.sh` re-run is required in this ticket.** `functions_storage_blob` and
`functions_storage_queue` are unchanged, `tf-managed-role-allowlist.tsv` is
unchanged, and no privileged subscription Owner / User Access Administrator step
belongs anywhere in this work. If the verification below shows that a role must
be **added**, that is a finding to file — not something to apply here, and not a
reason to add a second apply to this runbook.

| #   | Step                                                                 | Where                  |
| --- | -------------------------------------------------------------------- | ---------------------- |
| 1   | Two-plan convergence against dev, **out of band, before merge** (§2) | Operator workstation   |
| 2   | Merge the PR → automatic dev apply reconciles the setting            | GitHub Actions (MG-23) |
| 3   | Deploy the app build carrying the timer probe (§3)                   | Operator workstation   |
| 4   | **Proof 1** — a positive `webjobs.storage` Healthy row (§4)          | Log Analytics          |
| 5   | **Proof 2** — `func publish` with no unhealthy warning (§5)          | Operator workstation   |
| 6   | **Proof 3** — a timer invocation observed in the logs (§6)           | Log Analytics          |

---

## 2. Pre-merge two-plan convergence — out of band, BEFORE main

Do this **before the change reaches `main`**, from an operator workstation:
apply against dev, then plan again, and confirm the second plan reports **no
changes**. Only then merge.

**Why this is not optional.** The dev GitOps workflow
[`infra-apply-dev.yml`](../../.github/workflows/infra-apply-dev.yml) ends with a
final drift plan that runs `terraform plan -detailed-exitcode` **in the same run
that applied**, and treats exit code 2 — "changes present" — as a failed run. A
change that does not converge on the second plan therefore turns the merge red
after the apply has already happened, in a workflow with no human in the loop.

**This stack has already been bitten by exactly this class of behaviour, on
exactly this resource.** `APPLICATIONINSIGHTS_CONNECTION_STRING` was set as an
`app_setting`, and the Flex provider reflected it back into the **native computed
field** `site_config.application_insights_connection_string` — producing a
perpetual second-plan diff on both `app_settings` and `site_config` until it was
moved to the native field. The story and the fix are recorded in
`apps/infrastructure/modules/functions/main.tf` (the comment at ~lines 289-301
and the native field at ~line 346). `AzureWebJobsStorage__accountName` is a
setting on the same resource, added the same way, so the same question is open
until a real second plan answers it.

```bash
set -euo pipefail
cd apps/infrastructure

SUB=<V2-SUBSCRIPTION-ID>
az account set --subscription "$SUB"
STATE_ACCOUNT="$(bash scripts/state-account-name.sh "$SUB")"
terraform init -input=false -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$STATE_ACCOUNT"

# Plan 1 — apply this one through the same gates the workflow uses.
terraform plan -input=false -var-file=environments/dev.tfvars -out=/tmp/mg58-1.bin
scripts/tf-plan-secret-inspection.sh /tmp/mg58-1.bin
scripts/tf-plan-destroy-guard.sh     /tmp/mg58-1.bin
terraform apply -input=false -auto-approve /tmp/mg58-1.bin

# Plan 2 — this is the convergence proof. Exit 0 is the only acceptable result.
terraform plan -input=false -var-file=environments/dev.tfvars -detailed-exitcode
```

`terraform plan -detailed-exitcode` returns **0** for no changes, **2** for
changes present, **1** for an error. **Exit 0 is the gate.** Exit 2 means the
change does not converge — do not merge it.

> **If exit 2 happens, the fix belongs AT THE RESOURCE — never in the drift
> gate.** Read the second plan, find what Azure added or reflected back, and own
> it: declare the companion configuration in the module, move the value to the
> native field the provider actually reads, or add the **narrowest**
> `ignore_changes` the provider genuinely needs on that one attribute. The
> workflow's own comment forbids weakening the final drift plan to tolerate exit
> 2, and it is right to: that step is this stack's only automated drift signal,
> and retiring it for every future run to quiet one resource is a much larger
> change than the one that provoked it. Nothing in this runbook asks for that
> step to be relaxed.

> Keep this on the workstation. Dev state carries live IoT Hub SAS material —
> never redirect unfiltered `terraform show -json` output to a file, an issue or
> a PR comment.

Once plan 2 is clean, merge. The post-merge automatic apply should be a no-op or
near no-op against the state you just converged; its final drift plan is the
second, independent convergence signal.

---

## 3. Deploy the app build carrying the timer probe

Proofs 2 and 3 both need the MG-58 app build live. Use the **MG-21 recipe**, the
one that actually works on Flex — the bare `nx deploy api` target does **not**:

```bash
set -euo pipefail
cd <repo-root>

npx nx build api
(cd dist/apps/api && npm install --omit=dev --ignore-scripts)

FA=$(cd apps/infrastructure && terraform output -raw function_app_name)
func azure functionapp publish "$FA" --javascript --no-build
```

Both `--javascript` and the self-contained package produced by the `--omit=dev`
install inside `dist/apps/api` are required. Keep the tail of this command's
output — it is Proof 2 (§5).

> `az functionapp show --query defaultHostName` silently returns `null` with the
> CLI version in use here (the payload is wrapped under `properties`). Pipe to
> `jq` instead, or take the name from `terraform output` as above.

---

## 4. Proof 1 — `webjobs.storage` Healthy, sustained across a host restart

### The requirement, stated exactly

The proof is a **POSITIVE row** in `FunctionAppLogs` showing
`azure.functions.webjobs.storage` **Healthy**, with a `TimeGenerated`
**after** a deliberate host restart, and continuing across that restart.

**The absence of `Unhealthy` rows is NOT the proof.** Two independent reasons,
both live in this workspace:

- The dev workspace has a **hard 2 GB/day ingestion cap**
  (`environments/dev.tfvars`, `ingestion_cap_gb = 2`). When the cap is hit,
  ingestion **stops**, and "no Unhealthy rows" becomes indistinguishable from
  "no rows at all".
- The current defect emits an `Unhealthy` row roughly **every 30 seconds**. Those
  rows are themselves ingestion volume. Fixing the defect removes that volume —
  so the one query that would look most like success (nothing found) is also
  exactly what a capped workspace, a broken diagnostic setting, or a deleted app
  produces.

Ingestion lag is **3-5 minutes**. Do not conclude anything from an immediate
query.

### Step 4a — restart the host deliberately

```bash
RG=meatgeek-v2-dev-rg
FA=$(cd apps/infrastructure && terraform output -raw function_app_name)

date -u +%Y-%m-%dT%H:%M:%SZ      # RECORD THIS — it is the "after" boundary
az functionapp restart --resource-group "$RG" --name "$FA"
```

Wait at least 10 minutes: ~5 for the host to come up and start reporting, plus
the 3-5 minute ingestion lag.

### Step 4b — the health query

```bash
WS=6632bb13-0766-4250-9423-622e00be3482

az monitor log-analytics query -w "$WS" --analytics-query '
FunctionAppLogs
| where TimeGenerated > ago(2h)
| where Message has "webjobs.storage"
| project TimeGenerated, Level, HostInstanceId, Message
| order by TimeGenerated asc
' -o table
```

**Read it like this:**

- Rows containing `Healthy` with `TimeGenerated` **later than the restart
  timestamp you recorded** — that is the proof. Confirm the `HostInstanceId` on
  those rows **differs** from the pre-restart rows; a same-instance Healthy row
  means the restart did not take and you are looking at the old host.
- Any `Unhealthy` / `AuthenticationFailed` row after the restart timestamp —
  **the fix did not work.** Go to §7.
- **No rows at all** — this is NOT a pass. Run step 4c before concluding
  anything.

To narrow to health-state transitions only when the volume is noisy:

```kusto
FunctionAppLogs
| where TimeGenerated > ago(2h)
| where Message has "webjobs.storage"
| where Message has_any ("Healthy", "Unhealthy", "AuthenticationFailed")
| summarize first=min(TimeGenerated), last=max(TimeGenerated), rows=count()
    by HostInstanceId, State=extract(@"(Healthy|Unhealthy)", 1, Message)
| order by first asc
```

"Sustained across the restart" is satisfied when the post-restart
`HostInstanceId` shows a `Healthy` band whose `last` is close to now and which is
accompanied by **no** `Unhealthy` band on that same instance.

### Step 4c — confirm the workspace was NOT capped during the proof window

**Mandatory, not optional** — this is what converts "no rows" from ambiguous into
readable, and it is the reason a negative query result cannot be signed off.

```bash
az monitor log-analytics query -w "$WS" --analytics-query '
Usage
| where TimeGenerated > ago(2d)
| where IsBillable == true
| summarize IngestedGB = round(sum(Quantity) / 1024.0, 3) by bin(TimeGenerated, 1d)
| order by TimeGenerated asc
' -o table
```

Any day at or near **2 GB** is at the cap. Then check for an explicit
cap-reached operation — the daily-cap event is written as a log-management
operation record:

```bash
az monitor log-analytics query -w "$WS" --analytics-query '
_LogOperation
| where TimeGenerated > ago(2d)
| where Category has_any ("Ingestion", "Data collection")
   or Detail has_any ("daily cap", "daily limit", "OverQuota")
| project TimeGenerated, Category, Level, Operation, Detail
| order by TimeGenerated asc
' -o table
```

> If `_LogOperation` is empty or unavailable in this workspace, fall back to the
> legacy `Operation` table with the same filters, and cross-check the daily cap
> in the portal under the workspace's **Usage and estimated costs → Daily cap**.
> The column set of these operational tables is not something the build container
> could verify against the live workspace; adjust the projection if the query
> errors on an unknown column, but do **not** skip the check.

**A proof window that overlaps a capped day is not a proof.** Raise the cap
temporarily or wait for the next UTC day, then re-run §4a onward.

---

## 5. Proof 2 — `func publish` completes with no unhealthy warning

Re-run the §3 publish (or read the output you kept). The pass condition:

**`func azure functionapp publish` completes and its output contains no
`app appears to be unhealthy` warning.**

That warning is the CLI reporting the same host-health signal §4 queries
directly, from the outside. It is a weaker signal than Proof 1 — it is a snapshot
at one moment, not a sustained state — which is why it is a proof _alongside_
§4 and not instead of it.

```bash
func azure functionapp publish "$FA" --javascript --no-build 2>&1 | tee /tmp/mg58-publish.log
grep -i 'unhealthy' /tmp/mg58-publish.log && echo "PROOF 2 FAILED" || echo "PROOF 2 PASSED — no unhealthy warning"
```

Publish before the §4 restart if you like — a publish restarts the host anyway —
but if you do, run §4a's explicit restart afterwards regardless. The proof
requires a **deliberate** restart with a recorded timestamp, so that "after the
restart" is a boundary you can point at rather than one you infer.

---

## 6. Proof 3 — a storage-dependent execution actually runs

Proofs 1 and 2 both read a **health flag**. Proof 3 exercises a path that
genuinely cannot work while host storage is broken, which is the point: the
Functions host persists a timer's **schedule status** and its **singleton lease**
in `AzureWebJobsStorage`, so the timer cannot fire at all if the host cannot
authenticate to that account. Every other function in this app is an HTTP
trigger, which needs no host storage — which is exactly why all seven of them
answered `200` for weeks while the host sat `Unhealthy`.

The probe is `storageHeartbeat` (`apps/api/src/functions/health/storage-heartbeat.ts`),
a permanent function on a `0 */15 * * * *` NCRONTAB schedule. Wait for a quarter
hour to pass after the §3 deploy, plus ingestion lag, then:

```bash
az monitor log-analytics query -w "$WS" --analytics-query '
FunctionAppLogs
| where TimeGenerated > ago(2h)
| where FunctionName == "storageHeartbeat" or Message has "storage-heartbeat"
| project TimeGenerated, Level, FunctionName, Message
| order by TimeGenerated asc
' -o table
```

**Pass condition:** at least one row whose `Message` carries the
`storage-heartbeat` marker, timestamped after the deploy. The line reads:

```
storage-heartbeat: timer fired, so the Functions host holds its schedule status and
singleton lease in AzureWebJobsStorage (MG-58) — invocation=<id> pastDue=<bool>
lastRun=<iso|unknown> nextRun=<iso|unknown>
```

**Read `lastRun` / `nextRun` — they are the stronger half of this proof.** Those
values are the host's persisted schedule status, which it **reads back from host
storage**. Concrete ISO timestamps there mean the read succeeded. `unknown` on
the very first invocation after a deploy is expected (there is no prior run
recorded yet); `unknown` on a **second and subsequent** invocation means the host
is not persisting schedule status, and Proof 3 has **not** passed even though an
invocation appeared. Wait for a second heartbeat and check again.

`STORAGE_HEARTBEAT_MARKER` is pinned by
`apps/api/src/functions/health/storage-heartbeat.spec.ts` precisely so this
query does not rot. If you change the marker, change it here too.

---

## 7. Rollback — restoring shared keys is NOT the rollback

If `Healthy` does not appear after §4:

1. **Revert the setting.** Remove `AzureWebJobsStorage__accountName` from
   `modules/functions/main.tf` and re-run the §2 sequence. That returns dev to
   the state it has been in — broken host storage, working HTTP triggers — which
   is a known, survivable position, not a good one.
2. **Reopen MG-58 with concrete evidence.** The reopened ticket must name the
   **specific element of this app's configuration that managed identity cannot
   support** — a network path, an account feature, a Flex platform constraint,
   quoted from the failing log line and the Microsoft documentation that governs
   it.
3. **Do NOT restore shared keys as the remediation.** Flex Consumption fully
   supports managed identity for host storage and Microsoft recommends it, and
   this app already authenticates by the same identity to Cosmos, SignalR and
   Application Insights successfully — so the identity itself demonstrably works
   and any failure here is specific to the storage account's data plane. "MI was
   harder" is not evidence. Key restoration would also have to defeat three
   deliberate controls (`allowSharedKeyAccess = false` in the azapi body,
   `tf-static-checks.sh`, and `tf-plan-secret-inspection.sh`), each of which
   exists to make precisely this retreat a conscious, reviewed decision rather
   than a quiet one.

Before reverting, check the cheap causes first: Azure RBAC is eventually
consistent, so a `Storage Blob Data Owner` grant that was recently (re)created
can take minutes to propagate; and confirm §4c did not just tell you the
workspace was capped.

---

## 8. Sequencing and related tickets

| Ticket    | Relationship                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MG-53** | **MG-58 lands FIRST.** MG-53 is the Cosmos shared-throughput migration + cutover. Running it while the host storage-plane identity is broken makes any cutover failure ambiguous between the two causes. |
| **MG-60** | **Depends on MG-58 landing.** Owns the open question of whether `Storage Queue Data Contributor` is required by the Flex host. MG-58 makes no role change and takes no position on the answer.           |
| **MG-24** | Its explicit conditional ("keys disabled ONLY IF host storage is fully managed-identity; VERIFY first") is resolved by this ticket, in the managed-identity branch. See the MG-58 ADR.                   |
| **MG-34** | Would move this app behind private endpoints / VNet integration, which is the one change that would invalidate the account-name form and require the service-URI form instead.                           |
| **MG-37** | App Insights emits nothing in dev, which is why every query above targets Log Analytics `FunctionAppLogs` and not App Insights.                                                                          |

---

## 9. Sign-off checklist

| #   | Proof                                                                                           | Evidence to record                              |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0   | Two-plan convergence: `terraform plan -detailed-exitcode` exits **0** before merge (§2)         | exit code + timestamp                           |
| 0b  | Post-merge dev apply green, including its own final drift plan                                  | workflow run URL                                |
| 1   | Positive `webjobs.storage` **Healthy** row, timestamped after a recorded restart (§4)           | the row, the restart timestamp, the instance id |
| 1b  | Workspace **not capped** during the proof window (§4c)                                          | the `Usage` daily total                         |
| 2   | `func publish` completes with **no** `app appears to be unhealthy` warning (§5)                 | the publish output tail                         |
| 3   | `storage-heartbeat` invocation observed, with concrete `lastRun`/`nextRun` on a repeat run (§6) | the log line                                    |

All six lines pass, or MG-58 is not done.

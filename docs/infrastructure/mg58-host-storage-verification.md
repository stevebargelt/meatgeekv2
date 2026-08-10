# MG-58 — Host-Storage Managed Identity: Verification Runbook

> **Read this before you merge the MG-58 branch, and again before you sign it
> off.** The code change is small. The _proof_ is not, and most of it cannot be
> produced from CI or from an agent container — no automated job in this repo
> holds a credential that can restart the dev Function App, run `func publish`,
> or query Log Analytics. This document is the complete operator procedure for
> the proofs MG-58 requires, plus the pre-merge check that keeps the dev GitOps
> loop green and the post-merge CI gate that is now the only thing in the system
> able to see the defect at all.
>
> Everything marked as an operator proof is **unproven against the live tenant**
> until an operator runs it. Where a query or command could not be executed from
> the build container, it is written to be read and adjusted, not pasted blind.

## What actually broke — read this before any of the procedures

PR #42 added the identity-based host-storage setting and it was **correct**. The
dev Function App nevertheless carried, at the same time, a **scalar
`AzureWebJobsStorage` connection string** whose `AccountKey` was **empty**,
against a storage account with `allowSharedKeyAccess = false`. The Functions host
resolves the connection-string form **first** and never reaches the identity
form, so it authenticated with an unusable key and host storage was dead: no host
lock lease, no timer schedule status, `Process reporting unhealthy` roughly every
30 seconds. **The setting that shipped was not wrong; it was shadowed.**

**No gate in this repo could have caught that, and none of them was broken.** The
scalar key appears in **zero** `.tf` files — grep and confirm. `hashicorp/azurerm`
v4.81.0 (pinned in `apps/infrastructure/.terraform.lock.hcl`) **composes and
writes that key itself**, on the Function App create **and on every Update**, and
on **read** routes it out of `app_settings` into the `storage_access_key`
attribute. It is therefore structurally absent from HCL, from the saved plan
document and from post-apply state; no diff on it is representable; and the
provider can never prune it either. It is **not drift and not a human edit**.

So the authority splits, deliberately (the reasoning, and the two eliminated
alternatives, are in
[the MG-58 ADR](../../learnings/decisions/mg-58-host-storage-managed-identity.md)):

| Property                                      | Authoritative surface                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AzureWebJobsStorage__accountName` is PRESENT | The desired state — `modules/functions/main.tf` plus the module's `terraform test` guards                            |
| The scalar `AzureWebJobsStorage` is ABSENT    | The **post-apply live gate** (§2b) — `apps/infrastructure/scripts/assert-live-host-storage.sh`, run against the site |

Guards 1-3 (the module tftests, the plan/state secret inspection, the lexical HCL
scan) remain regression fences against a **human** reintroducing the key in HCL.
Only the live gate can observe the defect that actually shipped.

## What the code change is

`apps/infrastructure/modules/functions/main.tf` publishes exactly **one**
host-storage app setting on the Flex Consumption Function App:

```hcl
"AzureWebJobsStorage__accountName" = local.functions_storage_account_name
```

That is the identity-based, **account-name** form. It carries a name, not a
credential, so it coexists with `allowSharedKeyAccess = false` on the storage
account. The credential-carrying `AzureWebJobsStorage` connection-string form and
every `AzureWebJobsStorage__*ServiceUri` variant stay **absent from the desired
state** — the two forms are alternatives, not complements, and publishing both is
its own defect. The service-URI form is for accounts the host cannot reach over
standard Azure DNS (sovereign clouds, custom or private endpoints); this account
has none of those. The reasoning is recorded in the ADR, not just the choice,
because MG-34's secure off-VNet edge would invalidate it.

Fixed coordinates used throughout:

| Thing                   | Value                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Workload RG             | `meatgeek-v2-dev-rg` (West US 2)                                                                                               |
| Function App            | `meatgeek-v2-dev-func-259d4bf5b628` — confirm with `terraform output -raw function_app_name` rather than trusting this literal |
| Host storage account    | `mgv2dev13bd19e9f03d` — confirm with `terraform output -raw storage_account_name`                                              |
| Log Analytics workspace | `meatgeek-v2-dev-logs`, guid `6632bb13-0766-4250-9423-622e00be3482`                                                            |
| Diagnostic setting      | `meatgeek-v2-dev-functions-diag` → `FunctionAppLogs`                                                                           |
| Timer probe             | `storageHeartbeat`, NCRONTAB `0 */15 * * * *`, log marker `storage-heartbeat`                                                  |
| Live gate               | `apps/infrastructure/scripts/assert-live-host-storage.sh` (§2b)                                                                |

---

## 1. Sequence — one dev GitOps apply, then the live proofs in ORDER

**MG-58 remains one apply and nothing else.** No functional HCL change is made by
the corrective work: the module already declares the right setting, and the
scalar key cannot be declared away (§2b). **Expect the dev apply to be a NO-OP or
a Function App in-place update.** A no-op apply is the **success** condition
here, not a sign that nothing happened — the manual CLI deletion already moved
live state to match the corrected desired state. If you find yourself looking at
a plan that **replaces** the Function App, any Cosmos container, or any IoT Hub
route / endpoint / consumer group, **stop** and report it rather than approving.

Stated affirmatively so nobody goes looking for a step that does not exist: **no
role-assignment change, no allowlist edit and no `bootstrap.sh` re-run is
required in this ticket.** `functions_storage_blob` and `functions_storage_queue`
are unchanged, `tf-managed-role-allowlist.tsv` is unchanged, `allowSharedKeyAccess`
is unchanged, and no privileged subscription Owner / User Access Administrator
step belongs anywhere in this work. The RBAC branch is **disproven**: under the
existing grants the host took a blob lease and ran a timer (§4, §5).

**The live proofs must be run in this order.** Each one depends on the state the
previous one establishes, and the last one is the outstanding gate.

| #   | Step                                                                         | Where                  |
| --- | ---------------------------------------------------------------------------- | ---------------------- |
| 1   | Two-plan convergence against dev, **out of band, before merge** (§2)         | Operator workstation   |
| 2   | Merge the PR → automatic dev apply reconciles, then the live gate runs (§2b) | GitHub Actions (MG-23) |
| 3   | Deploy the app build carrying the timer probe (§3)                           | Operator workstation   |
| 4   | **Restart the host**, recording the boundary timestamp (§4a)                 | Operator workstation   |
| 5   | **Proof 1** — `Host lock lease acquired` after that boundary, sustained (§4) | Log Analytics          |
| 6   | **Proof 2** — a `storageHeartbeat` execution after that boundary (§5)        | Log Analytics          |
| 7   | **Proof 3 / T4** — exact-SHA `func publish`, no unhealthy warning (§6)       | Operator workstation   |
| 8   | Capture the FULL live settings **NAME** list immediately after T4 (§6b)      | Operator workstation   |

**T4 is the ONE proof still outstanding.** Convergence, the dev apply, sustained
storage health and the timer execution have all already passed against the live
tenant. T4 — the publish — **failed on the pre-fix deploy**, and MG-58 closes
only when T4 joins the other four.

---

## 2. Pre-merge two-plan convergence — out of band, BEFORE main

Do this **before the change reaches `main`**, from an operator workstation:
apply against dev, then plan again, and confirm the second plan reports **no
changes**. Only then merge.

**Why this is not optional.** The dev GitOps workflow
[`infra-apply-dev.yml`](../../.github/workflows/infra-apply-dev.yml) runs a
final drift plan with `terraform plan -detailed-exitcode` **in the same run that
applied**, and treats exit code 2 — "changes present" — as a failed run. A change
that does not converge on the second plan therefore turns the merge red after the
apply has already happened, in a workflow with no human in the loop.

**This stack has already been bitten by exactly this class of behaviour, on
exactly this resource.** `APPLICATIONINSIGHTS_CONNECTION_STRING` was set as an
`app_setting`, and the Flex provider reflected it back into the **native computed
field** `site_config.application_insights_connection_string` — producing a
perpetual second-plan diff on both `app_settings` and `site_config` until it was
moved to the native field. The story and the fix are recorded in
`apps/infrastructure/modules/functions/main.tf`. That precedent is also why the
scalar `AzureWebJobsStorage` key is **not** declared in `app_settings` to
suppress the provider's injection: doing so would trade a live defect for a
**permanent** drift-plan failure on every future run, which is the same shape of
mistake with a wider blast radius.

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

Note that **plan 1 will not show the scalar key either**, in any form. That is
not reassurance; it is the defect's defining property. Convergence proves
Terraform agrees with itself, which is precisely the thing that was green while
the site was broken. §2b is what checks the site.

Once plan 2 is clean, merge.

---

## 2b. The post-merge CI live host-storage gate

`infra-apply-dev.yml`'s apply job now ends with a **live host-storage gate**,
placed **after** the final drift plan and **before** the plan shred. It is the
only assertion in this repo made against the **deployed site** rather than
against configuration text.

### What it does

1. Resolves the resource group, the Function App and the expected storage account
   **from `terraform output`** — from the desired state, never from a literal, so
   the account-name comparison is live-versus-desired and not live-versus-itself.
2. Pipes `az functionapp config appsettings list` **straight into**
   `scripts/assert-live-host-storage.sh` — no file, no `tee`, no artifact, no
   `echo`. That document carries app setting **values**, connection strings among
   them, and the job's log is retained and broadly readable.
3. The gate asserts, and prints setting **NAMES** and fixed reasons only:
   - the **exact** scalar key `AzureWebJobsStorage` is **absent**;
   - the **exact** key `AzureWebJobsStorage__accountName` is present exactly once
     and **equals** the expected storage account name;
   - the full live setting NAME list is printed for operator diagnosis, including
     any stray deployment-storage connection-string setting.
4. If the scalar key **is** present, the step deletes **exactly that one setting
   on exactly that one app**, re-reads, re-asserts — and then **fails the run
   anyway**.

### Why it fails the run after remediating

A silent self-heal would leave the pipeline green, which reproduces **the exact
property that let a non-fix ship past eleven green checks**: an invisible defect
behind a green pipeline. It would also mask the moment a provider upgrade changes
this behaviour, in either direction. The cost is stated honestly rather than
hidden: **`main` goes red after any change that updates the Function App**, until
the provider behaviour changes upstream. Remediation is conditional on presence,
so the steady state on the many pushes that touch no infrastructure is zero
deletions and zero red runs.

The delete is bounded to one key on one app on purpose. The app-settings
sub-resource is **replace-the-whole-collection**, so a broader delete would strip
provider-injected settings the module never declares — health-check ping-failure,
the App Insights connection string, deployment storage — and the loss would be
invisible in HCL for precisely the reason the original defect was.

### It runs in CI, but deliberately NOT on the PR

**The live assertion CAN run in CI, and it does** — in the **post-merge dev apply
job**, which already holds `id-token: write`, the `development-infra-apply`
environment and an `azure/login`, and whose identity already has what both the
read and the one-key delete need. **No new job, no new permission and no RBAC
change of any kind was required.**

It is deliberately **not** attached to the PR job. `ci.yml`'s
`validate-infrastructure` job is **credentialless by design** — `contents: read`
only, no `id-token: write`, no GitHub Environment, no `azure/login`, backend-less
init — and that is proven **at runtime** by
`apps/infrastructure/scripts/assert-credentialless.sh`, not merely asserted in a
comment. Attaching an Azure identity there would trade a load-bearing security
invariant for a gate that already has a correct home. What the PR job **does**
run is the credentialless fixture harness
`apps/infrastructure/scripts/fixtures/run-live-host-storage-fixtures.sh`, which
proves the gate's own logic — including, by mutation, that reintroducing the
scalar key turns it **red**.

### What to do when the gate fires

1. **Do not "fix" it in HCL.** Declaring the key produces a permanent drift-gate
   failure; a second Terraform writer on the app-settings sub-resource would
   silently delete the provider's other injected settings. Both routes are
   eliminated on evidence in the ADR.
2. The gate has already deleted the key and confirmed the site is clean. **Re-run
   §4 and §5** to prove the host actually recovered — a clean settings list is a
   configuration fact, not an operational one.
3. Record the run URL. A gate firing means the Function App was **updated** by
   that apply, which is useful forensic information in its own right.

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
output — the final, exact-SHA run of it is Proof 3 / T4 (§6).

> `az functionapp show --query defaultHostName` silently returns `null` with the
> CLI version in use here (the payload is wrapped under `properties`). Pipe to
> `jq` instead, or take the name from `terraform output` as above.

---

## 4. Proof 1 — sustained host storage health across a deliberate restart

### The requirement, stated exactly

The proof is a **`Host lock lease acquired`** entry in `FunctionAppLogs` with a
`TimeGenerated` **after** a deliberate host restart whose timestamp you recorded,
**together with** the disappearance of the `Process reporting unhealthy` traffic
across that same boundary.

**Why the lease is the right positive signal, and a stronger one than any log
flag.** The host lock lease is a **blob lease taken IN the host storage account**.
It cannot be acquired without working **data-plane** access to that account. Its
appearance is therefore proof **by consequence**: the host did a thing that is
impossible while host storage is unauthenticated. A log line asserting a health
state is a claim; a lease is an effect.

### There is no positive health log line to look for — do not reintroduce one

An earlier version of this section asked for a **positive log entry** reporting
`azure.functions.webjobs.storage` as `Healthy`, sustained across a restart.
**That criterion was unsatisfiable, and it has been removed.** The platform emits
`azure.functions.webjobs.storage: Process reporting unhealthy` **only while the
host is unhealthy**, and stays **silent** otherwise. No corresponding positive
line is ever emitted, so no operator could ever have produced the evidence that
criterion demanded. **Do not restore it.** If you find yourself unable to satisfy
an acceptance criterion here, check first that the criterion is satisfiable at
all — that is the mistake this paragraph exists to prevent from recurring.

**The instinct behind the old criterion was right, though: proof by absence is
still NOT accepted.** Two independent reasons, both live in this workspace:

- The dev workspace has a **hard 2 GB/day ingestion cap**
  (`environments/dev.tfvars`, `ingestion_cap_gb = 2`). When the cap is hit,
  ingestion **stops**, and "nothing unhealthy found" becomes indistinguishable
  from "nothing found at all".
- The defect emitted an unhealthy entry roughly **every 30 seconds**. Those are
  themselves ingestion volume. Fixing the defect removes that volume — so the one
  query that would look most like success (nothing found) is also exactly what a
  capped workspace, a broken diagnostic setting, or a deleted app produces.

The replacement signals — the lease (§4) and the timer (§5) — close that hole
because both are **positive** and both are **effects that require working host
storage**, so neither can be manufactured by an absence of data.

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

### Step 4b — the lease query

```bash
WS=6632bb13-0766-4250-9423-622e00be3482

az monitor log-analytics query -w "$WS" --analytics-query '
FunctionAppLogs
| where TimeGenerated > ago(2h)
| where Message has "Host lock lease" or Message has "webjobs.storage"
| project TimeGenerated, Level, HostInstanceId, Message
| order by TimeGenerated asc
' -o table
```

**Read it like this:**

- At least one `Host lock lease acquired` entry whose `TimeGenerated` is **later
  than the restart timestamp you recorded** — that is the proof. Confirm the
  `HostInstanceId` **differs** from the pre-restart instances; a same-instance
  lease means the restart did not take and you are looking at the old host.
- **Zero** `Process reporting unhealthy` entries after the restart boundary,
  sustained for at least 30 minutes. One every ~30 seconds is the defect
  signature; a handful in the first seconds of host start-up is not, but they
  must stop.
- **No entries at all** — this is NOT a pass. Run step 4c before concluding
  anything.

To summarise the bands when the volume is noisy:

```kusto
FunctionAppLogs
| where TimeGenerated > ago(2h)
| where Message has_any ("Host lock lease", "reporting unhealthy", "AuthenticationFailed")
| summarize first=min(TimeGenerated), last=max(TimeGenerated), entries=count()
    by HostInstanceId, Signal=case(
        Message has "Host lock lease", "lease",
        Message has "AuthenticationFailed", "authfail",
        "unhealthy")
| order by first asc
```

"Sustained across the restart" is satisfied when the post-restart
`HostInstanceId` shows a `lease` band and **no** `unhealthy` or `authfail` band
on that same instance, with `last` close to now.

**Reference observation — this proof has already passed once, by hand.** Against
a recorded restart boundary of **2026-08-09T22:22:17Z**, after the scalar key was
deleted manually: **zero** unhealthy entries where the defect had produced one
every 30 seconds continuously, and **two** `Host lock lease acquired` entries at
**22:27:18Z** and **22:28:47Z**. That is what a pass looks like.

### Step 4c — confirm the workspace was NOT capped during the proof window

**Mandatory, not optional** — this is what converts an empty result from
ambiguous into readable, and it is the reason a negative query result cannot be
signed off.

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

## 5. Proof 2 — a storage-dependent execution actually runs

Proof 1 observes a lease. Proof 2 exercises an application path that genuinely
cannot work while host storage is broken, which is the point: the Functions host
persists a timer's **schedule status** and its **singleton lease** in
`AzureWebJobsStorage`, so the timer cannot fire at all if the host cannot
authenticate to that account. Every other function in this app is an HTTP
trigger, which needs no host storage — which is exactly why all seven of them
answered `200` for weeks while host storage sat dead.

Like the lease, this is proof **by consequence**, and for the same reason it
cannot be forged by an absence of log data.

The probe is `storageHeartbeat` (`apps/api/src/functions/health/storage-heartbeat.ts`),
a permanent function on a `0 */15 * * * *` NCRONTAB schedule. Wait for a quarter
hour to pass after the §4a restart, plus ingestion lag, then:

```bash
az monitor log-analytics query -w "$WS" --analytics-query '
FunctionAppLogs
| where TimeGenerated > ago(2h)
| where FunctionName == "storageHeartbeat" or Message has "storage-heartbeat"
| project TimeGenerated, Level, FunctionName, Message
| order by TimeGenerated asc
' -o table
```

**Pass condition:** at least one entry carrying the `storage-heartbeat` marker,
timestamped **after the restart boundary you recorded in §4a**. The line reads:

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
is not persisting schedule status, and Proof 2 has **not** passed even though an
invocation appeared. Wait for a second heartbeat and check again.

`STORAGE_HEARTBEAT_MARKER` is pinned by
`apps/api/src/functions/health/storage-heartbeat.spec.ts` precisely so this
query does not rot. If you change the marker, change it here too.

**Reference observation — this proof has also already passed once, by hand.**
After the manual deletion and restart, `Executed 'Functions.storageHeartbeat'
(Succeeded)` in **32 ms** at **2026-08-09T22:30:00Z**. The same timer had **failed
to fire at all** at 21:45, 22:00 and 22:15 while the scalar key was still
shadowing the identity form. The contrast across a single boundary is the whole
argument.

---

## 6. Proof 3 (T4) — the exact-SHA publish completes with no unhealthy warning

**This is the one proof still outstanding, and it is the last thing MG-58 waits
on.** It **failed on the pre-fix deploy** — that failure is what T4 is named
after — so re-running it is not a formality.

Run it **after** §4 and §5 have passed, not before. It must be the **exact merged
SHA**, built and published by the §3 recipe:

```bash
git rev-parse HEAD          # RECORD THIS — T4 is a proof about a specific build
func azure functionapp publish "$FA" --javascript --no-build 2>&1 | tee /tmp/mg58-publish.log
grep -i 'app appears to be unhealthy' /tmp/mg58-publish.log \
  && echo "T4 FAILED" \
  || echo "T4 PASSED — no unhealthy warning"
```

**Pass condition:** `func azure functionapp publish` completes and its output
contains **no** `app appears to be unhealthy` warning.

That warning is the CLI reporting the host-health signal from the outside. It is
a weaker signal than Proofs 1 and 2 — a snapshot at one moment rather than a
sustained state or an effect — which is why it is a proof _alongside_ them and
not instead of them. It earns its place for a different reason: it is the only
proof that exercises the **deployment path**, and the deployment path is one of
the candidate injectors this ticket had to rule out.

### 6b. Capture the FULL live settings NAME list, immediately after T4

**Run this within a minute or two of the publish finishing.** Do not skip it and
do not defer it — its value is entirely in its proximity to the publish.

```bash
RG=meatgeek-v2-dev-rg
FA=$(cd apps/infrastructure && terraform output -raw function_app_name)
SA=$(cd apps/infrastructure && terraform output -raw storage_account_name)

az functionapp config appsettings list \
  --resource-group "$RG" --name "$FA" --only-show-errors --output json \
  | bash apps/infrastructure/scripts/assert-live-host-storage.sh --account-name "$SA"
```

> **Pipe it straight in, exactly as written.** `az functionapp config appsettings
list` returns **values**, connection strings among them. Do not redirect it to
> a file, `tee` it, echo it, or paste it into a ticket. The gate prints setting
> **NAMES** and reasons only, which is what makes its output safe to keep.

Two things to read out of the NAME list:

1. **Is `AzureWebJobsStorage` back?** If it is, `func azure functionapp publish`
   is a **second injector** and the deployment path is itself part of the problem
   — which would mean the CI gate alone cannot hold the line, and MG-58 needs
   reopening with that evidence. If it is absent, publish is exonerated and the
   azurerm provider's create/Update path is the sole injector, as the ADR
   concludes.
2. **Is a deployment-storage connection-string setting present?** The module
   declares no such setting. The provider's **Update** path injects one, so its
   presence is forensic evidence that an **UPDATE** — not a create, and not a
   publish — was the injector. The gate flags it as a NOTE without failing on it:
   it is diagnostic, not part of guard 4's contract.

---

## 7. Rollback — and what the recorded connection string is NOT

If §4 or §5 do not pass:

1. **Do NOT restore shared keys as the remediation.** Flex Consumption fully
   supports managed identity for host storage and Microsoft recommends it, and
   this app already authenticates by the same identity to Cosmos, SignalR and
   Application Insights successfully — so the identity itself demonstrably works,
   and the host has now taken a blob lease and run a timer under the existing
   grants. "MI was harder" is not evidence. Key restoration would also have to
   defeat three deliberate controls (`allowSharedKeyAccess = false` in the azapi
   body, `tf-static-checks.sh`, and `tf-plan-secret-inspection.sh`), each of which
   exists to make precisely this retreat a conscious, reviewed decision rather
   than a quiet one.
2. **Do NOT remove `AzureWebJobsStorage__accountName`.** An earlier version of
   this section offered that as step 1 of the rollback. **It is strictly worse
   than the defect being fixed**: it returns dev to a Function App whose host
   storage is dead **and** removes the only setting that could make it work,
   leaving nothing for the live gate to assert and no path back that does not
   involve re-deriving this entire investigation. There is no configuration state
   reachable by deleting that setting which is better than the current one.
3. **Reopen MG-58 with concrete evidence.** The reopened ticket must name the
   **specific element of this app's configuration that managed identity cannot
   support** — a network path, an account feature, a Flex platform constraint —
   quoted from the failing log line and the Microsoft documentation that governs
   it. If §6b showed the scalar key returning after a publish, say so: that is a
   different root cause than the one the ADR records and it changes the fix.

Before concluding anything, check the cheap causes first: Azure RBAC is
eventually consistent, so a `Storage Blob Data Owner` grant that was recently
(re)created can take minutes to propagate; and confirm §4c did not just tell you
the workspace was capped.

### The recorded connection-string value is a FINGERPRINT, not a restore path

The scalar setting observed on the live site carried exactly this value:

```
DefaultEndpointsProtocol=https;AccountName=mgv2dev13bd19e9f03d;AccountKey=;EndpointSuffix=core.windows.net
```

**Read that `AccountKey=` carefully: it is EMPTY.** This value **never
authenticated and never could have**, and not only because the key is missing —
the account has `allowSharedKeyAccess = false`, so a populated key would not have
worked either.

It is recorded here for exactly one purpose: it is the **forensic fingerprint of
provider injection**. `hashicorp/azurerm` v4.81.0 composes the host-storage
connection string from its `StorageStringFmt` template, filling the account name
in from the storage container endpoint and the key in from the
`storage_access_key` attribute — which is **empty** under
`storage_authentication_type = SystemAssignedIdentity`. Rendering that template
with an empty key produces this string, character for character. Seeing this
exact value on a site is how you identify the injector without reading provider
source again.

**It is NOT a restore value and must never be reapplied.** Writing it back would
reinstate the shadowing that broke host storage in the first place, using a
credential that is empty, against an account that rejects shared keys. There is
no scenario in which putting this string back improves anything.

---

## 8. Sequencing and related tickets

| Ticket    | Relationship                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MG-53** | **MG-58 lands FIRST.** MG-53 is the Cosmos shared-throughput migration + cutover. Running it while the host storage-plane identity is broken makes any cutover failure ambiguous between the two causes.                                                                                                                                                                                                                     |
| **MG-60** | **Depends on MG-58 landing.** Owns the open question of whether `Storage Queue Data Contributor` is required by the Flex host. MG-58 makes no role change and takes no position on the answer.                                                                                                                                                                                                                               |
| **MG-25** | **Carries an activation precondition from this ticket.** Prod uses the same provider and the same module, so it will inherit the identical injection at its FIRST apply — invisibly, because a plan-only pipeline cannot see a key that is absent from the plan by construction. Prod's apply may not be activated until prod carries the same post-apply live assertion. Recorded in the header of `infra-deploy-prod.yml`. |
| **MG-24** | Its explicit conditional ("keys disabled ONLY IF host storage is fully managed-identity; VERIFY first") is resolved by this ticket, in the managed-identity branch. See the MG-58 ADR.                                                                                                                                                                                                                                       |
| **MG-34** | Would move this app behind private endpoints / VNet integration, which is the one change that would invalidate the account-name form and require the service-URI form instead.                                                                                                                                                                                                                                               |
| **MG-37** | App Insights emits nothing in dev, which is why every query above targets Log Analytics `FunctionAppLogs` and not App Insights.                                                                                                                                                                                                                                                                                              |

---

## 9. Sign-off checklist

| #   | Proof                                                                                                           | Evidence to record                                  | State           |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------- |
| 0   | Two-plan convergence: `terraform plan -detailed-exitcode` exits **0** before merge (§2)                         | exit code + timestamp                               | **PASSED**      |
| 0b  | Post-merge dev apply green, including its own final drift plan — a **no-op** apply is a pass (§1)               | workflow run URL                                    | **PASSED**      |
| 0c  | The post-apply live host-storage gate reports the site clean (§2b)                                              | the gate's PASS line from the run log               | to record       |
| 1   | `Host lock lease acquired` after the recorded restart boundary, with no unhealthy traffic after it (§4)         | the entries, the restart timestamp, the instance id | **PASSED**      |
| 1b  | Workspace **not capped** during the proof window (§4c)                                                          | the `Usage` daily total                             | **PASSED**      |
| 2   | `storageHeartbeat` execution after the restart boundary, with concrete `lastRun`/`nextRun` on a repeat run (§5) | the log line                                        | **PASSED**      |
| 3   | **T4** — exact-SHA `func publish` with **no** `app appears to be unhealthy` warning (§6)                        | the publish output tail + the SHA                   | **OUTSTANDING** |
| 3b  | Full live settings **NAME** list captured immediately after T4 (§6b)                                            | the gate's NAME list output                         | to record       |

**MG-58 closes when T4 passes and joins the convergence, apply, storage-health
and timer proofs above — and not before.** Every other line is already in hand;
this ticket is waiting on one publish.

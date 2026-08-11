# MeatGeek V2 Infrastructure

Terraform Infrastructure as Code for the MeatGeek V2 cloud-based BBQ
temperature monitoring system.

> **This is a greenfield V2 stack.** It creates and **owns** every resource it
> needs — including its own Cosmos DB account. It has **no** dependency on the
> legacy V1 system. Never import, adopt, modify, rename, or delete a V1 resource
> from this project (MG-24 hard safety).

## Overview

This Terraform project provisions all Azure resources required for MeatGeek V2:

- **Azure IoT Hub** — device-to-cloud messaging with parallel routing
- **Cosmos DB** — V2-owned document database for telemetry and application data
- **Azure Functions** — serverless API and event processing
- **SignalR Service** — real-time client communication
- **Application Insights + Log Analytics** — monitoring and observability
- **Event Hub** — real-time data processing pipeline

## Architecture

```
Device Data → IoT Hub → Parallel Routing:
                       ├─→ Cosmos DB (V2-owned, direct storage)
                       └─→ Event Hub → Azure Functions → SignalR
```

## Naming convention — the single source of truth

Every resource is named from one prefix, `local.resource_prefix`:

```
meatgeek-v2-${environment}-*        # e.g. meatgeek-v2-dev-func
```

The `v2` segment makes each resource unambiguously the V2 stack so it can never
be confused with — or accidentally target — the legacy V1 system. The **Function
App name** (`meatgeek-v2-${environment}-func-<suffix>`, where `<suffix>` is the
subscription-derived global-uniqueness suffix — see below) is exposed as the
Terraform output `function_app_name` and is the **one** authoritative name the
app deploy consumes — there is no independently-hardcoded Function App name
anywhere.

The V2-owned Cosmos account uses a deterministic, globally-unique,
subscription-derived name (`mgv2-${environment}-<hash>`) decoupled from the
prefix so it stays globally unique and stable across plans.

**Global-uniqueness suffix (MG-24 item 9).** Every resource whose name must be
unique across all of Azure — not just within the resource group — carries a
deterministic, subscription-derived suffix so a greenfield apply into a fresh
subscription can never collide with a name already taken elsewhere. The suffix
is `substr(sha1("<subscription-id>-global"), 0, 12)` computed once in `main.tf`
and threaded into the modules as `global_suffix`:

| Globally-scoped resource     | Name shape                                        |
| ---------------------------- | ------------------------------------------------- |
| Remote-state storage account | `meatgeekv2tf<12-hex>` (see below)                |
| Function App                 | `meatgeek-v2-${environment}-func-<suffix>`        |
| IoT Hub                      | `meatgeek-v2-${environment}-iothub-<suffix>`      |
| Event Hubs namespace         | `meatgeek-v2-${environment}-eventhub-ns-<suffix>` |
| SignalR Service              | `meatgeek-v2-${environment}-signalr-<suffix>`     |
| Cosmos DB account            | `mgv2-${environment}-<hash>` (own derivation)     |

The Functions **storage** account uses the same subscription-derived approach
(`tf-static-checks.sh` check 10 enforces it). The `function_app_name` output
still carries the suffix, so the app deploy consumes the exact global name.

## Prerequisites

- **Terraform** ≥ 1.9
- **Azure CLI**, authenticated (`az login`)
- Access to the V2 Azure subscription (the subscription id is **never**
  hardcoded — it comes from `ARM_SUBSCRIPTION_ID` / OIDC, or the ambient
  `az` context for local runs, or the optional `subscription_id` variable)
- The run-once **bootstrap** completed (remote state + OIDC identity) —
  see below

## State backend model (remote-only, per environment)

V2 Terraform **always** uses the `azurerm` remote backend with a
**per-environment** state key. There is **no supported local-state path** —
an apply against ephemeral local state would try to create/recreate live infra.

`main.tf` declares an empty backend block for partial configuration:

```hcl
terraform {
  backend "azurerm" {}
}
```

Per-environment values live in dedicated partial-config files, with **distinct**
state keys **and distinct per-environment containers** so dev and prod state can
never collide and each identity's state access is RBAC-scoped to its own
container:

| Env  | Config file                     | Container      | State key                  |
| ---- | ------------------------------- | -------------- | -------------------------- |
| dev  | `environments/backend-dev.hcl`  | `tfstate-dev`  | `meatgeek-v2/dev.tfstate`  |
| prod | `environments/backend-prod.hcl` | `tfstate-prod` | `meatgeek-v2/prod.tfstate` |

Both point at the V2-owned state account (RG `meatgeek-v2-tfstate-rg`) stood up
by the bootstrap. The state **account name is not hardcoded** — it is derived
from the subscription id by the single sourced helper
`scripts/state-account-name.sh` (`meatgeekv2tf` + first 12 hex chars of
`sha1(subscription-id)` = 24 chars, the storage-account maximum) so it stays
globally unique, and it is injected at `terraform init` as an extra
`-backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"`.
That single derivation is shared by the bootstrap, the CI workflows, and the
runbook, so the name can never drift. The `backend-*.hcl` files therefore carry
`resource_group_name`, `container_name`, `key`, and `use_azuread_auth` — but
**not** `storage_account_name`. State-blob access is **identity-based**
(`use_azuread_auth = true`) and RBAC is **container-scoped** (Storage Blob Data
role on the env's own container only — not account-scoped). The legacy V1 shared
state account is deliberately **not** used.

## Quick Start

### 1. Run the one-time bootstrap (per subscription)

Stands up the remote-state storage and the OIDC deployment identity. Idempotent.

```bash
cd apps/infrastructure/bootstrap
./bootstrap.sh
```

Full details and safety notes: **[bootstrap runbook](../../docs/infrastructure/bootstrap-runbook.md)**.

### 2. Initialize against the per-environment remote backend

```bash
# AzureRM v4 REQUIRES an explicit subscription id — `az account set` alone is
# insufficient. Export it before any init/plan/apply:
export ARM_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"

# Delete any stale local state FIRST (never migrate it into remote state)
rm -f terraform.tfstate terraform.tfstate.backup && rm -rf .terraform

# Clean init bound to the dev state key, with the derived state-account name
# injected from the single sourced helper (ARM_SUBSCRIPTION_ID must be exported).
# `nx init` binds only the .hcl and does NOT inject storage_account_name, so it
# cannot bind the remote backend on its own — init it directly:
terraform init -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
```

> **Never use `terraform init -migrate-state`** on first init — it would pull
> V1-bound local state into the V2 remote backend.

### 3. Plan / apply the dev environment

```bash
nx plan infrastructure --args="--env=dev"      # terraform plan -var-file=environments/dev.tfvars
nx apply infrastructure     # bootstrap/recovery only — see below
nx output infrastructure
```

**Steady-state dev infrastructure reconciles through CI**, not from a
workstation. Under **MG-23** (_automated dev GitOps reconciliation_, CI-run) a
change goes: PR → `ci.yml`'s `validate-infrastructure` job runs the
**credentialless** sequence (`assert-credentialless.sh` → `fmt -check` →
`terraform init -backend=false -input=false -lockfile=readonly` → `validate` →
`terraform test` → `tf-static-checks.sh` → `bootstrap.test.sh` → destroy-guard
fixtures → cross-module propagation fixtures → **live host-storage gate
fixtures (MG-58)** → V1 Cosmos export tool tests (MG-48, `run-tests.mjs`) →
dev IoT device fixture tests (MG-67, `iot-fixture/run-tests.mjs`) → per-module
`terraform test`) → review → merge to `main` →
`.github/workflows/infra-apply-dev.yml` runs the fail-closed pre-apply secret
gate and destroy circuit-breaker, applies the exact saved plan, fails the run on
any drift, and then asserts host storage against the **deployed site** (the live
post-apply gate — see _Verifying the absence of secrets_ below). Applying dev by
hand races that loop.

There is deliberately **no PR-time `terraform plan` and no PR-reachable Azure
identity**: the PR job holds `permissions: contents: read` only, binds no GitHub
Environment, and opens no backend, so nothing reachable from a pull request can
read `tfstate-dev` or the live IoT Hub SAS material in it. The authoritative plan
is the post-merge one.

A local apply is for the cases CI does not own: the **greenfield creation**
(MG-24's 10-step dev proof, in the runbook), the bootstrap, resource-group
creation, subscription-scoped configuration, and recovery. **Prod** is still
operator-applied — `infra-deploy-prod.yml` is plan-only until **MG-25** activates
CI-run prod reconciliation.

Activation of the dev loop is operator-gated: see
[MG-23 live acceptance & activation](../../docs/infrastructure/mg23-live-acceptance.md).

## Environment Configuration

### Development (`environments/dev.tfvars`)

- IoT Hub **S1** (required for message routing; F1 does not support routing)
- V2-owned Cosmos DB, autoscale 400→1000 RU, 7-day telemetry TTL
- Azure Functions **Flex Consumption** (`FC1` plan), **scale-to-zero** (`always_ready = 0`)
- SignalR Free (F1) tier
- Permissive IP ranges, backups off, low budget — cost-optimized

### Production (`environments/prod.tfvars`)

- Higher-tier SKUs, extended retention, tighter security
- Activated separately under **MG-25** (prod environment secret +
  `PROD_DEPLOY_ENABLED`)

> Staging is **out of scope** for MG-24 — there is no `staging.tfvars` and the
> `environment` variable admits only `dev` and `prod`.

## Module Structure

| Module                | Responsibility                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/iot-hub/`    | IoT Hub, Event Hub namespace, parallel routing, devices                                                                                                                                |
| `modules/cosmos-db/`  | **V2-owned** Cosmos account, database, containers, outputs                                                                                                                             |
| `modules/functions/`  | Flex Consumption Function App (`azurerm_function_app_flex_consumption`) on an `FC1` `azurerm_service_plan` + its own storage account (MI blob deployment container, length-safe names) |
| `modules/signalr/`    | SignalR Service (identity-based access; no secret outputs)                                                                                                                             |
| `modules/monitoring/` | Alerts, budgets, Log Analytics wiring                                                                                                                                                  |

The Cosmos module **creates** the account (`azurerm_cosmosdb_account`) — it does
**not** read a shared V1 account via a data source. There is no adoption of a pre-existing shared Cosmos account
anywhere in the stack.

The Functions module creates an **`azurerm_function_app_flex_consumption`** app
(MG-24 hosting revision) — a **single Flex Consumption** model for **both** dev
and prod, replacing the inherited `Y1`(dev)/`EP1`(prod) `azurerm_linux_function_app`
split. Flex still **requires** a service plan, so the `azurerm_service_plan` is
**retained** but repurposed to SKU **`FC1`** (the Flex plan) — its id is a required
argument on the flex resource; it is **not** removed. The deployment package is
read from an **MI-authenticated blob container** (no Azure Files content share, no
shared key), which is why the functions storage account keeps
`shared_access_key_enabled = false`. The Node runtime is **24**, the region is
**West US 2** (a Flex-supported region; see the ADR for the whole-stack relocation
caveat), and the scale profile is tuned per-env via `instance_memory_in_mb` /
`maximum_instance_count` / `always_ready` (dev `always_ready = 0` scale-to-zero,
prod `always_ready >= 1`). The former `functions_app_service_plan_sku` var is
**removed**. See
[ADR: Flex Consumption hosting model](../../learnings/decisions/mg-24-flex-consumption-hosting-model.md).

## Provider pinning & lock files

Pinning has **two halves and needs both**: a `required_providers` version
constraint gives the resolver a range, and a committed `.terraform.lock.hcl`
gives it the exact version and `h1:`/`zh:` hashes inside that range. The root
module **and every module under `modules/`** carry both. All of them constrain
`azurerm ~> 4.0`, and every provider a module locks resolves to the same build
the root locks — azurerm **4.81.0**, azapi **2.11.0**, time **0.14.0**.

That is not preventive hygiene. `modules/iot-hub` declared no `azurerm`
constraint at all, so CI's `terraform init` resolved whatever the registry served
that minute. On **2026-08-03** that became azurerm **v5.0.1**, whose breaking
`azurerm_eventhub` schema (`namespace_name`/`resource_group_name` →
`namespace_id`) turned `validate-infrastructure` red on every PR — and left
`main` latent-red — without a single line of this repo having changed. A gate
whose result depends on the registry clock is not a gate. The stack stays on
**azurerm 4.x** deliberately; moving to v5 is separate, deliberate work, not
something a fresh `init` gets to decide.

**Adding a `*.tftest.hcl` to a module makes it CI-invoked, and that carries an
obligation.** `tf-static-checks.sh` **check 16** fails the build when a
test-bearing module has no committed `.terraform.lock.hcl`, has one that exists
on disk but is **untracked** (it would simply be absent from the CI checkout), or
uses a provider — the `<prefix>` of any `resource "<prefix>_…"` /
`data "<prefix>_…"` block — that it declares no version constraint for.
Discovery is the same `find` on `*.tftest.hcl` that `ci.yml` uses to select
modules, so a module cannot start being CI-invoked without also being gated.

Locks are **multi-platform, on the same four platforms** everywhere:
`linux_amd64` (the GitHub runners), `darwin_arm64` (Apple-silicon workstation),
`darwin_amd64` (Intel Mac fallback) and `linux_arm64` (arm64 build/review
containers). `init` only trusts a provider whose hash for the _current_ platform
is already recorded, so regenerating with fewer platforms both dirties the tree
and hands the dropped platforms an unpinned resolution. Always pass all four —
from the module directory, or from `apps/infrastructure` for the root:

```bash
terraform init -backend=false
terraform providers lock \
  -platform=linux_amd64 -platform=linux_arm64 \
  -platform=darwin_arm64 -platform=darwin_amd64
```

Verify a regeneration two ways before committing it: `terraform providers lock`
must report "All checksums for this platform were already tracked" for every
platform, and a following `terraform init -backend=false` must leave the file
byte-identical. `ci.yml` inits the root **and** every test-bearing module with
`-lockfile=readonly`, so an init that would have to amend a lock **fails**
instead of quietly rewriting it. A dirty `git diff` on any `.terraform.lock.hcl`
is a provider that resolved outside the lock — treat it as a supply-chain event,
not a formatting nit.

## Terraform / Nx Commands

```bash
nx run infrastructure:init --args="--env=dev"  # terraform init -reconfigure -backend-config=environments/backend-dev.hcl
                                               #   NOTE: hcl-only — does NOT inject storage_account_name, so it cannot
                                               #   bind the remote backend alone. Init directly (see the Bootstrap block above).
nx validate infrastructure                     # terraform validate
nx run infrastructure:format                   # terraform fmt -recursive
nx plan infrastructure --args="--env=dev"      # terraform plan -var-file=environments/dev.tfvars -out=tfplan
nx apply infrastructure                        # terraform apply tfplan   (bootstrap/recovery — dev steady state is CI-run)
nx output infrastructure                       # terraform output
nx destroy infrastructure --args="--env=dev"   # terraform destroy (careful!)
nx test infrastructure                         # node scripts/cosmos-export/run-tests.mjs (MG-48) — the
                                               #   dependency-free tier only; `run-tests.mjs --sdk` is a
                                               #   second tier CI runs separately in lint-and-test, after
                                               #   `npm ci` (see the cosmos-export section below) —
                                               #   also picked up by `nx run-many -t test --all`
                                               # NOT the whole of scripts/: this target runs cosmos-export
                                               #   ONLY. The MG-67 iot-fixture suites have their own
                                               #   wrapper and their own two CI steps, and `nx test` does
                                               #   not reach them — run them directly (below).

# MG-67 iot-fixture, both tiers — run these directly; `nx test infrastructure` does not.
# Repo-root paths, the same two invocations ci.yml runs.
node apps/infrastructure/scripts/iot-fixture/run-tests.mjs          # dependency-free tier (no npm ci, no network, no credential)
node apps/infrastructure/scripts/iot-fixture/run-tests.mjs --sdk    # real-SDK tier — needs `npm ci` first
```

Three invocation rules, each of which fails in a different and non-obvious way
if ignored:

- **Pass the environment as `--args="--env=<env>"`, never as a bare `--env=<env>`.**
  `env` is a reserved `nx:run-commands` option typed as an _object_, so passing
  it bare is rejected before Terraform runs with
  `Property 'env' does not match the schema. 'dev' should be a 'object'.`
- **`init` and `format` must use the `nx run <project>:<target>` form.** Bare
  `nx init …` and `nx format …` collide with Nx's **built-in** `init` and
  `format` commands — they launch the workspace initializer / Prettier and the
  Terraform target never runs at all.
- **`apply` takes no environment argument.** Its command is `terraform apply
tfplan`, which has no `{args.*}` placeholder, so a trailing `--args="--env=dev"`
  is forwarded verbatim as `terraform apply tfplan --env=dev` and Terraform
  rejects it. The environment is already baked into `tfplan` by the preceding
  `nx plan`.

Static validation (no Azure, no credentials, no state produced):

```bash
terraform init -backend=false && terraform validate
terraform fmt -check -recursive
scripts/tf-static-checks.sh            # asserts the V2 greenfield invariants
```

`tf-static-checks.sh` fails CI on: a hardcoded subscription id, a `timestamp()`
call **anywhere** under the sources (including wrapped in `formatdate()` — the
budget-window drift fix, MG-24 item 7), any leftover V1 shared-Cosmos adoption
reference, missing per-env state keys, a stray local `*.tfstate`, a missing
`meatgeek-v2-` prefix, a secret OUTPUT (best-effort — direct or obfuscated-index
reference), a secret value in the Function App app*settings (with the one coupled
App Insights exemption — the full conn string is allowed **only** when
`local_authentication_enabled = false`), a SAS-based IoT Hub route,
(check 16) a CI-invoked module that floats its providers — no committed or no
tracked `.terraform.lock.hcl`, or a provider it uses with no explicit version
constraint (see [Provider pinning & lock files](#provider-pinning--lock-files)) —
and (check 12) a README that stops documenting the fail-closed
`scripts/tf-plan-secret-inspection.sh` as a REQUIRED pre-apply gate. It runs in
the `validate-infrastructure` job. Note: the secret-output/app_settings scans are
a best-effort lexical guard; the authoritative secret-in-state guarantee is the
fail-closed `scripts/tf-plan-secret-inspection.sh` inspection (it parses
`terraform show -json` and EXITS NONZERO on any prohibited credential VALUE),
documented under \_Verifying the absence of secrets* below.

## Key Outputs

Every output is **non-secret**. There are **no** connection-string / primary-key
outputs — the former `cosmos_db_connection_string`, `iot_hub_connection_string`,
`signalr_connection_string`, and `environment_config` aggregate outputs were
**removed** (MG-24 S1), so no runtime credential is ever surfaced as an output or
placed in app settings. (Note: each data service's key still exists as an
inherent _computed attribute_ in state — see "No runtime secret is USED …" under
Security Notes for the full posture and how local-auth-disable renders those keys
non-authenticating.) Consumers reach every service **identity-based** (managed
identity + RBAC) via the non-secret endpoints below.

```bash
terraform output -raw function_app_name          # the single deploy target name
terraform output -raw cosmos_db_endpoint         # non-secret; access is identity-based
terraform output -raw eventhub_namespace_fqdn    # non-secret IoT telemetry (Event Hubs) namespace
terraform output -raw signalr_service_uri        # non-secret; access is identity-based
terraform output development_urls                # non-secret endpoint URLs
```

### How the app gets access (no secrets)

The Function App runs under a **system-assigned managed identity** and is granted
narrowly-scoped data-plane RBAC by the root module:

| Service       | Non-secret endpoint (app setting)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Role granted to the Function App identity |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Cosmos DB     | `COSMOSDB__accountEndpoint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Cosmos DB Built-in Data Contributor       |
| IoT telemetry | `IOTHUB_EVENTS__fullyQualifiedNamespace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Azure Event Hubs Data Receiver            |
| SignalR       | `AzureSignalRConnectionString__serviceUri`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | SignalR Service Owner                     |
| App Insights  | `APPLICATIONINSIGHTS_CONNECTION_STRING` — the FULL TF-managed connection string (`InstrumentationKey=…;IngestionEndpoint=…` — Microsoft requires the ikey as the destination-resource identifier even under Entra) wired via the **native** `site_config.application_insights_connection_string` field, **not** an app setting (Azure surfaces it to the host unchanged as this env var); plus the `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD` app setting. The ikey **cannot authenticate**: `local_authentication_enabled = false` on the App Insights resource forces AAD-only ingestion. | Monitoring Metrics Publisher              |

The IoT Hub's own system-assigned identity likewise writes to Cosmos (Built-in
Data Contributor) and sends to the Event Hubs routing endpoint (Azure Event Hubs
Data Sender) — the Event Hubs route is **identity-based**, so no SAS connection
string is generated or stored in state.

### Verifying the absence of secrets in state/plan

Three layers, with clearly different strengths — and, importantly, different
**surfaces**. Layers 1 and 2 read the CONFIGURATION (sources, plan, state).
Layer 3 reads the DEPLOYED SITE, and it is the only one of the three that can
see a setting Terraform never declared:

1. **`scripts/tf-static-checks.sh` — best-effort static guard.** It flags secret
   OUTPUTS in any module/root `outputs.tf` (direct secret-attribute tokens AND
   the common obfuscated forms — a resource reference indexed with a
   dynamically-assembled key such as
   `azurerm_application_insights.main[format("%s_%s","connection","string")]`),
   confirms the IoT Hub routing endpoint is identity-based (no SAS), and checks
   the Function App app*settings for secret values. Because it is a lexical
   `grep`, it **cannot** semantically prove the absence of \_every* obfuscation —
   it is a fast fail-early guard, not the guarantee.

2. **`scripts/tf-plan-secret-inspection.sh` — the AUTHORITATIVE, FAIL-CLOSED,
   REQUIRED pre-apply gate.** It parses `terraform show -json`, walks every
   resource across the root and all child modules plus every root output, and
   inspects the actual sensitive **VALUES** (distinguishing field NAMES from
   VALUES — the field key `APPLICATIONINSIGHTS_CONNECTION_STRING` / the
   `site_config.application_insights_connection_string` field it is now wired
   through is never itself a finding; only the string bound to it is). It
   **rejects** every
   credential VALUE (connection string / SAS / account|access|primary key / a
   bare instrumentation key) reaching `app_settings` or outputs, and additionally
   inspects the **inherent computed key attributes** of the data-service
   resources themselves. It accepts a residual **only** when auth cannot use it:
   - the full App Insights connection string in a Function App telemetry sink —
     its `app_settings` map or its Flex `site_config` block (it is wired via the
     native `site_config.application_insights_connection_string` field, not an
     app setting) — **only** when the plan's `azurerm_application_insights` sets
     `local_authentication_enabled = false` (the coupled invariant);
   - the inherent in-state key of an `azurerm_cosmosdb_account` /
     `azurerm_signalr_service` / `azurerm_storage_account` /
     `azurerm_eventhub_namespace`, **only** when that
     resource disables local/key auth in the plan
     (`local_authentication_enabled = false` / `local_auth_enabled = false` /
     `shared_access_key_enabled = false` / `local_authentication_enabled = false`)
     — otherwise the in-state key is a live credential and it is a **VIOLATION**;
   - `azurerm_iothub` key attributes as the **acknowledged exception** (accepted
     with a printed note — device SAS auth is intentionally kept, mitigated by
     restricted state access; MG-24 ADR).

   It **EXITS NONZERO** on any violation, and
   also fail-closed on any operational failure (missing `jq`, unparseable JSON,
   no input). It replaces the old always-green one-liner (a `terraform show -json`
   result fed into `grep` and neutralized with a trailing `or-echo "ok"`), which
   swallowed its own failure and so could never block an apply. **This inspection
   is REQUIRED before the first apply and MUST come up clean** — `tf-static-checks.sh`
   check 12 fails CI if this README stops documenting it as the required
   pre-apply gate.

3. **`scripts/assert-live-host-storage.sh` — the LIVE POST-APPLY gate (MG-58).**
   The **only** gate in this system capable of _observing_ the MG-58 defect
   class. Stated plainly, because the alternative reading has already cost a
   release.

   **The defect class.** The pinned provider (hashicorp/azurerm **4.81.0**)
   composes and **writes** the scalar `AzureWebJobsStorage` connection string on
   every Function App create **and every update** — with an empty `AccountKey`
   under `storage_authentication_type = SystemAssignedIdentity` — and on read
   routes that key out of `app_settings` into `storage_access_key`. The key is
   therefore absent from HCL, from `terraform show -json` and from state **by
   construction**: it cannot be declared away, cannot be pruned, and no plan
   diff on it is representable. The host resolves the scalar connection-string
   form **first** and never reaches `AzureWebJobsStorage__accountName`, so it
   authenticates with an unusable key against an account whose shared keys are
   disabled, and host storage is dead. That state coexisted with a **fully green
   pipeline**: every check this repo had asserted the key was absent from the
   CONFIGURATION, where it genuinely was, and nothing asserted anything about
   the deployed site.

   **Where it runs — the post-merge dev apply job**
   (`.github/workflows/infra-apply-dev.yml`), placed **after** the final drift
   plan (so Terraform's convergence proof is measured against live state this
   step has not yet perturbed) and **before** the plan shred. It is
   `if: always()`: a partially-failed apply is the case _most_ likely to have
   updated the Function App and re-injected the key, so it must still be
   inspected. It runs inside the **existing** apply job under its existing
   `id-token: write` and `development-infra-apply` environment — no new job, no
   new permission, no second login, and **no RBAC change**.

   **Why it cannot run on a PR — the credentialless invariant, not a missing
   credential.** Asserting against the deployed site needs an Azure identity.
   `ci.yml`'s `validate-infrastructure` job deliberately holds none
   (`contents: read` only, no GitHub Environment, no `azure/login`, backend-less
   init), and `scripts/assert-credentialless.sh` proves that at runtime. Adding
   an identity there would trade a load-bearing security invariant for a gate
   that already has a correct home post-merge. What the PR job **does** run is
   the gate's regression harness,
   `scripts/fixtures/run-live-host-storage-fixtures.sh` — every fixture _is_ a
   settings document, so it needs no Azure, no credentials, no `az` and no
   `terraform` binary.

   **What it asserts**, against the live
   `az functionapp config appsettings list` document, with the app and the
   expected storage account resolved from `terraform output` rather than any
   literal (which is what makes it a live-versus-desired assertion rather than a
   tautology): the exact scalar key `AzureWebJobsStorage` is **absent**, and
   `AzureWebJobsStorage__accountName` is **present and exactly equal** to the
   desired storage account name. Matching is exact in both directions — the
   identity form never satisfies, nor trips, the scalar check by prefix. It
   **fails closed** on an unreadable, empty or wrong-typed document ("cannot
   tell" is never "nothing to see"), and prints setting **NAMES** and fixed
   reasons only, never a value. The live document is piped **straight into the
   gate's stdin** — no file, no `tee`, no artifact, no echo — because it carries
   connection-string values and the job log is retained and broadly readable.

   **It remediates exactly one key, and then FAILS THE RUN.** On finding the
   scalar key, the workflow deletes **that one setting** on **that one app**,
   re-reads, re-asserts — and fails anyway. Fail-loud is a deliberate policy
   choice: a silent self-heal would reproduce the precise invisibility that let
   a non-fix ship past eleven green checks, and would mask the moment a provider
   upgrade changes this behaviour in either direction. The cost is stated
   honestly in the ADR — `main` goes red after any change that updates the
   Function App, until the provider is fixed upstream. Remediation is
   conditional on presence, so the steady state on the many pushes that touch no
   infrastructure is zero deletions and zero red runs. The blast radius is
   bounded on purpose: the app-settings sub-resource is
   replace-the-whole-collection, so a broader delete would strip
   provider-injected settings the module never declares.

   **What layers 1 and 2 are actually for here.** The module's `terraform test`
   assertions and the config-surface fixture gates — the scalar form absent from
   the declared settings, exactly one `AzureWebJobsStorage*` key and it the
   identity form equal to `var.storage_account_name`, and a mutation
   reintroducing the scalar key turning them red — are **regression fences
   against a human reintroducing the key in HCL**. They are not, and never were,
   detectors of the defect that actually shipped: that key was never in HCL.
   Authority splits accordingly — **the desired state stays authoritative for
   the identity form's PRESENCE; this live post-apply gate is authoritative for
   the scalar form's ABSENCE.** See
   [ADR: MG-58 host storage managed identity](../../learnings/decisions/mg-58-host-storage-managed-identity.md)
   for the eliminated alternatives (declaring the key produces a permanent
   drift-gate failure; a second Terraform writer on the app-settings
   sub-resource would silently delete the provider's other injected settings),
   and the
   [host-storage verification runbook](../../docs/infrastructure/mg58-host-storage-verification.md)
   for the operator proof sequence.

   **Prod is not covered, and that is recorded rather than forgotten.** The same
   provider and the same module build the prod Function App, so prod inherits
   the identical injection at its first apply, invisibly to a plan-only
   pipeline. `infra-deploy-prod.yml` carries that as a named **MG-25 activation
   precondition**.

```bash
# Layer 1 — best-effort static guard (fails CI early on the common patterns):
scripts/tf-static-checks.sh

# Layer 2 — AUTHORITATIVE, REQUIRED pre-apply, FAIL-CLOSED: exits nonzero on any
# prohibited credential VALUE in app_settings/outputs. Do NOT apply until clean.
terraform plan -var-file=environments/dev.tfvars -out=tfplan
terraform show -json tfplan | scripts/tf-plan-secret-inspection.sh
#   or point it at the plan binary directly:
#   scripts/tf-plan-secret-inspection.sh tfplan

# Layer 3 — LIVE POST-APPLY, FAIL-CLOSED (MG-58). CI runs this in the post-merge
# dev apply job; reproducing it by hand needs an identity that can read the app.
# Pipe the document STRAIGHT in — it carries VALUES, so never tee/redirect/save it.
az functionapp config appsettings list \
  --resource-group "$(terraform output -raw resource_group_name)" \
  --name "$(terraform output -raw function_app_name)" \
  --only-show-errors --output json \
  | scripts/assert-live-host-storage.sh \
      --account-name "$(terraform output -raw storage_account_name)"
#   exit 0 = clean; exit 3 = the scalar AzureWebJobsStorage key is PRESENT
#     (delete that ONE setting on that ONE app, re-read, re-assert);
#   exit 1 = any other violation, or any operational failure.

# The gate's own regression harness — no Azure, no credentials, no terraform
# binary; CI-wired into the credentialless validate-infrastructure job:
bash scripts/fixtures/run-live-host-storage-fixtures.sh
```

## Security Notes

- **OIDC, no long-lived secrets.** CI authenticates via GitHub Actions OIDC with
  federated credentials scoped **per GitHub Environment** — the presented OIDC
  subject is `<the repository's live sub-claim prefix>:environment:<github-env>`,
  and the bootstrap creates a federated credential whose subject matches each
  environment name **exactly** (a job declares
  `environment: development-infra-apply`, so a bare `dev` would never match). No
  dev identity can authenticate to prod.
  - **The `repo:…` head is not a constant (MG-42).** This account's GitHub org
    customizes the OIDC `sub` claim to inject numeric owner/repo ids, so the
    prefix is a fact about the repository that `resolve_oidc_subject_prefix()`
    **reads at run time** — before anything is provisioned — and
    `federated_environment_subject()` composes every subject from it. A literal
    `repo:<owner>/<repo>` is the pre-MG-42 form and matches no token here.
    Never compare a live credential against a subject copied out of a document,
    and never hand-"correct" one to a string a document published: read the
    prefix, then compare. The procedure is
    [B10](../../docs/infrastructure/mg23-live-acceptance.md#b10--do-the-live-federated-subjects-match-the-prefix-the-repo-actually-presents),
    and the abort classes around the read are in the
    [bootstrap runbook](../../docs/infrastructure/bootstrap-runbook.md#preconditions-that-abort-before-anything-is-provisioned).
- **Two separate dev identities, two privilege levels (MG-24 item 4, split
  further by MG-23).** The **environment**, not the client id a job passes, is
  what selects the identity — before MG-23 the dev identities federated the
  identical `environment:development` subject, so a one-line client-id edit could
  silently upgrade a low-privilege job to full apply. **Neither is reachable from
  a pull request**: MG-23 removed the PR-time plan identity and its environment
  outright, and the PR job now holds no Azure identity at all.
  - `development-infra-apply` → the **dev INFRA-APPLY** identity (MG-23),
    OIDC-only with no client secret ever: `Contributor` and a **conditioned**
    `Role Based Access Control Administrator` scoped **only** to
    `meatgeek-v2-dev-rg`, plus `Storage Blob Data Contributor` on the
    `tfstate-dev` container. **No** subscription-wide permissions and **no**
    Microsoft Graph. Surfaced as `AZURE_INFRA_APPLY_CLIENT_ID`.
  - `development` → the **APP-DEPLOYMENT** identity: a `Reader` cannot publish a
    Function App, so publishing uses this distinct identity granted
    least-privilege publish (`Website Contributor`) scoped to **its Function App
    only** — surfaced as `AZURE_APP_DEPLOY_CLIENT_ID`.

  (The **prod** deploy identity and a prod infra-apply identity are **MG-25**
  deliverables, out of scope here.)

- **The resource-group boundary is load-bearing.** No identity inside
  `meatgeek-v2-dev-rg` holds a role outside it; the state account lives in a
  **separate** resource group (`meatgeek-v2-tfstate-rg`); there is no Microsoft
  Graph permission and no subscription-scoped write anywhere. Those are closed
  escalation paths the dev GitOps threat model depends on — a change that adds
  Graph or subscription scope, or moves the state account into the dev RG,
  **invalidates** that model and needs a fresh one. See
  [MG-23 live acceptance & activation](../../docs/infrastructure/mg23-live-acceptance.md).
- **No hardcoded subscription id** — resolved from the authenticated environment.
- **State store hardened** — TLS 1.2 floor, no public blob access, HTTPS-only,
  blob versioning + soft delete.

- **No runtime secret is USED or surfaced; in-state keys are made
  non-authenticating (IoT Hub is the documented exception).** Cosmos /
  IoT-telemetry (Event Hubs) / SignalR access is identity-based (managed identity
  - RBAC + non-secret endpoints); the Function App's host storage uses its
    managed identity. **No connection-string or primary-key VALUE is placed in app
    settings or surfaced as a Terraform output.** The accurate posture about
    _state itself_, however, is NOT "no keys in state": every TF-managed data
    service exposes its key/connection-string as a **computed attribute** that
    Terraform reads back into state by construction (no `azurerm` argument
    suppresses it) — exactly like App Insights. The control is to make those keys
    **inert for authentication** by disabling local/key auth where safe:
    `local_authentication_enabled = false` on Cosmos, `local_auth_enabled = false`
    on SignalR, `shared_access_key_enabled = false` on the Functions storage
    account (host storage is fully managed-identity), and
    `local_authentication_enabled = false` on the Event Hubs namespace (its
    auto-created `RootManageSharedAccessKey` is unused — the IoT Hub produces to it
    identity-based and the Function App consumes via _Azure Event Hubs Data
    Receiver_). With local auth off, the
    in-state key is a **present-but-non-authenticating residual**.
    **IoT Hub is the SOLE deliberate exception:** devices, the data-pusher, and the
    device-controller authenticate with **SAS keys**, so key auth is intentionally
    kept enabled and its in-state SAS keys are live — mitigated by restricted,
    container-scoped state access and documented in the MG-24 ADR. The coupled
    invariant (Cosmos/SignalR/Storage/Event Hubs namespace local auth must stay
    disabled) is machine-enforced by the fail-closed
    `scripts/tf-plan-secret-inspection.sh` gate, which flags any of those services
    as a violation if local auth is re-enabled and accepts the IoT Hub keys with a
    note. **Application Insights
    telemetry ingestion is
    AAD-authenticated:** the Function App authenticates via its managed identity —
    `APPLICATIONINSIGHTS_AUTHENTICATION_STRING = "Authorization=AAD"` plus a
    `Monitoring Metrics Publisher` role assignment on the App Insights resource.
    The **full** TF-managed App Insights connection string (with the
    `InstrumentationKey`) is wired via the native
    `site_config.application_insights_connection_string` field — **not** an app
    setting (moved there to kill a perpetual second-plan diff; Azure surfaces it to
    the host unchanged as the `APPLICATIONINSIGHTS_CONNECTION_STRING` runtime env
    var, so `apps/api` telemetry is unaffected) — **because Microsoft requires
    the connection string as the destination-resource identifier even under
    Entra** — but the embedded ikey **cannot authenticate**: the App Insights
    resource sets `local_authentication_enabled = false`, which forces AAD-only
    ingestion and disables ikey/local auth. The connection string / instrumentation
    key is therefore present in that `site_config` field and (as a computed attribute of
    `azurerm_application_insights.main`) in Terraform state, but it is a
    **present-but-non-authenticating** residual: **safe ONLY while local auth is
    disabled**. That coupled invariant is machine-enforced — `tf-static-checks.sh`
    check 9 rejects the full conn string reaching the Function module (now the
    `site_config` field) unless
    `local_authentication_enabled = false`, and the fail-closed
    `scripts/tf-plan-secret-inspection.sh` gate enforces the same over the real
    plan. See
    [ADR: App Insights key in Terraform state](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md).

## Deploy Alignment (Function App name)

The app deploy (`apps/api/project.json` + `.github/workflows/app-deploy-prod.yml`)
reads the Function App name from `terraform output -raw function_app_name` rather
than hardcoding it, so a naming change in Terraform can never desync the publish
target.

## V1 Cosmos export tool (MG-48)

`scripts/cosmos-export/` is a standalone, read-only export CLI for the
**legacy V1** Cosmos DB account — unrelated to the V2 stack this Terraform
project provisions. It exists because V1 was deleted to reclaim cost and free
the subscription's Cosmos free-tier slot, which V2 dev now claims (MG-48;
`cosmos_enable_free_tier = true` in `environments/dev.tfvars`, not yet
applied), and V1's continuous backup would have died with the account, so a
static export had to exist first. Run
`node scripts/cosmos-export/cosmos-export.mjs --help` for full usage; only
what `--help` doesn't already cover is captured below.

**No live Azure run has happened.** The dependency-free tier (87 tests across
3 files, `nx test infrastructure`, CI-wired above) runs entirely against an
injected fake client — the V1 subscription is disabled until 2026-08-06 and
the build environment holds no credentials. A second, smaller tier
(`run-tests.mjs --sdk`, 2 tests, CI-wired into `lint-and-test` after `npm ci`)
constructs the **real** `CosmosClient` and `DefaultAzureCredential` to prove
the auth wiring actually builds — that is construction only, no network call
and no credential ever used, so the no-live-Azure-run claim holds for both
tiers, but only the first tier runs against the fake. A test that imports a
real Azure package belongs in the second tier and is routed there by file
name alone — name it `*.sdk.test.mjs` or it fails in the dependency-free job,
which has no `node_modules`.

**Auth.** The account key is read **only** from the `COSMOS_EXPORT_KEY`
environment variable; passing it as a CLI argument is refused, since arguments
land in shell history and `ps` output for every user on the box. Prefer a
**read-only** key — the tool only ever reads. AAD via `DefaultAzureCredential`
(`--auth aad`) is also supported and is the default once `COSMOS_EXPORT_KEY`
is unset — it is the only mode that works against an account with
`disableLocalAuth: true` (V2's dev Cosmos account is one; that requirement is
why `--auth aad` had to work at all). It needs a Cosmos DB **data-plane** role
assignment — the built-in Data Reader is enough — which is separate from, and
not granted by, control-plane RBAC: subscription Owner alone still gets a 403
that reads like a tool bug. The assignment must be **account-scoped**
(`--scope "/"`) — even for a `--database`- or `--container`-filtered export —
because the tool reads account-level metadata before applying any filter. A
narrower `/dbs/<database>` assignment does **not** work today; that gap is
tracked as **MG-66**. `--help` carries the exact
`az cosmosdb sql role assignment create` invocation to fix that; it isn't
repeated here.

**Error output is redacted.** Any error text this tool prints is scrubbed
first: the value of any key matching
`/key|token|secret|password|credential|sig/i` is replaced with `[redacted]`,
unconditionally, with no exemption list — so ordinary diagnostics are caught
along with real secrets (`partitionKey=deviceId` prints as
`partitionKey=[redacted]`), and redaction runs to the end of the line, so text
_after_ a credential on the same line is lost too (`sig=[redacted]` can
swallow a trailing " failed"). This is deliberate, not a bug: an exemption for
benign key names was tried and caused an actual secret leak (a quote inside a
credential-shaped key defeated the match), so the rule is now that no fragment
of a credential may survive — over-redaction is acceptable, under-redaction is
not. See MG-63 before reintroducing an exemption; it explains why that leak
recurs by construction.

**Exit codes — the operator contract.** Scripts that wrap this tool key off
the exit code, so treat it as stable:

| Code | Meaning                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | verified-complete                                                                                                                                                                                                       |
| 1    | usage error — includes a `--database`/`--container` filter that matched nothing in the account; that is deliberately a failure, not an empty success                                                                    |
| 2    | reconciliation failure — written count doesn't match the pre-export `SELECT VALUE COUNT(1)`, the account has zero containers to export, or (in `--verify`) an on-disk hash/size/line-count mismatch or live-count drift |
| 3    | throttling abort — 429 with retries exhausted                                                                                                                                                                           |
| 4    | auth failure — a 401/403 from the service, or a credential that could not be acquired at all (matched by exact `@azure/identity` error-class name, e.g. `AggregateAuthenticationError`)                                 |
| 5    | transport abort mid-pagination — also covers a non-credential error whose class name merely resembles one (e.g. `CredentialTransportError` from an `ECONNRESET`), which is deliberately excluded from exit 4            |

**Safety semantics.**

- `manifest.json` is written only once **every** container in scope has
  reconciled, so a failed run never leaves behind anything that could be
  mistaken for a finished export.
- A container that fails to reconcile keeps its output as `*.jsonl.partial`
  rather than the final `.jsonl` name.
- `--verify` re-checks the manifest against both the on-disk files (hash,
  size, line count) and the live account (current counts). Run it again,
  possibly days after the export, immediately before the account is deleted.
- The per-container count query runs **before** pagination starts, so the
  account should be quiesced during export — a concurrent write during export
  will correctly trip reconciliation rather than being silently included.

---

## Dev IoT device fixture — device → IoT Hub → route → Cosmos (MG-67)

`scripts/iot-fixture/` is the standing **dev test fixture** for the product's only
write path. It registers nothing by itself: it sends a fixed set of **3**
synthetic D2C messages from the durable fixture device
`meatgeek-v2-dev-synthetic-fixture-device`, then **proves they arrived** by
reading them back out of the `temperatures` container the `cosmos-storage` route
targets. Run `node scripts/iot-fixture/send-fixture.mjs --help` for full usage;
only what `--help` doesn't already cover is captured below.

**The operator procedure is the [MG-67 device-fixture verification
runbook](../../docs/infrastructure/mg67-device-fixture-verification.md)** —
device registration, reading the live container definition, the temporary Cosmos
data-plane role assignment **and its removal**, the live run, the evidence to
capture, the stop conditions and the rejected proofs. Read it before running
anything against dev.

**No live Azure run has happened.** The build container holds no credentials, so
every step in that runbook is unexecuted, and as measured on 2026-08-10 all five
containers in `meatgeek-v2-dev-db` held **zero documents**. The tests run against
an injected fake reader and an injected fake spawn — no `az` binary, no Azure
package, no network. As with the cosmos-export tool, tests split into two tiers by
**file name alone**: `run-tests.mjs` is the dependency-free tier that runs in the
credentialless `validate-infrastructure` job, and `run-tests.mjs --sdk` (matching
`*.sdk.test.mjs`) constructs the **real** `CosmosClient` / `DefaultAzureCredential`
to prove the auth wiring builds, and so runs in `lint-and-test` after `npm ci`.
Both wrappers floor the discovered-file and executed-test counts — `node --test`
exits 0 when it discovers nothing, and a suite that passes by discovering nothing
is worse than no suite.

**Auth — there is no credential to supply, and none is accepted.** The send is
`az iot device send-d2c-message`, which addresses the hub and the device **by
name** and resolves the device key **itself**, server-side, under the operator's
already-authenticated identity. The tool therefore never reads, holds or can leak
one: there is **no key, connection-string, SAS or certificate mode at all**, not
as a fallback and not behind a flag, and every spelling of such a flag is refused
**by name** before its value is read. The argv handed to `az` is re-scanned
against the tool's own scrubber before the spawn, so a future edit that grows a
credential argument fails there rather than at review — that matters because `az`
persists invocations under `~/.azure` and prints request signatures under
verbosity, which is disk this repo's redaction posture cannot reach (`--debug`
and `--verbose` are never passed and are refused if supplied). Child `stderr` is
scrubbed before any operator-facing line exists. The Cosmos read-back is **AAD-only
via `DefaultAzureCredential`**; the account runs `local_authentication_enabled =
false`, so a key mode could not work and could only leak. Data-plane access needs
an **account-scoped** (`--scope "/"`) Cosmos Built-in Data **Reader** assignment —
the runbook carries both the create and the matching delete, because `azurerm`
manages only the two declared `azurerm_cosmosdb_sql_role_assignment` resources and
will never prune a third. **The removal targets the assignment id captured at
creation time and refuses to guess**: this is a shared live account, your
principal may already hold a data-plane grant somebody else's work depends on, and
a delete that finds its target by principal or role shape can revoke **that** one
instead. The runbook snapshots every assignment on the account first and sets a
single decision variable from that snapshot; **the create path is gated on it**,
so a principal that already holds a grant creates nothing and therefore has
nothing to remove, and a shell with no snapshot in scope refuses to grant at all.
Afterwards it proves that exactly one assignment — yours — went.

**Exit codes — the operator contract.** Exit **0 means exactly one thing**: 3
marker-carrying, run-correlated documents were **read back out of** the
destination container within an explicit, reported wait bound, and the evidence
recording them was written. Absence of an error is never success.

| Code | Meaning                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | confirmed-in-cosmos                                                                                                                                                                                                                                                                          |
| 1    | usage error — includes a refused credential-shaped or verbosity flag, and an unusable `--evidence-out` caught by the pre-flight **before anything is sent**                                                                                                                                   |
| 2    | send failure — `az iot device send-d2c-message` itself failed. **Ambiguous by construction**: `az` can fail after the hub took the message, so every attempted id is recorded first, as accepted or as of **unknown** acceptance — including a failure on message 1 of 3                     |
| 3    | confirmation timeout — the bound elapsed with the documents not found                                                                                                                                                                                                                        |
| 4    | auth failure — a 401/403, or a credential that could not be acquired; **never retried**, and it says nothing about whether the route delivered                                                                                                                                               |
| 5    | transport abort — retries exhausted                                                                                                                                                                                                                                                          |
| 6    | synthetic marker violation — a read-back document lacked the marker; a defect in the sender, not an acceptable variant                                                                                                                                                                       |
| 7    | correlation ambiguity — fewer documents than sent, a duplicate run id, an unreadable result. A failure, never an absence. Also the code for a run concluding a state the tool cannot name: **exit 0 requires positive confirmation**, so an unanticipated state exits here rather than defaulting to success |
| 8    | container definition refusal — the partition key path or `default_ttl` could not be measured. **No default is ever substituted**                                                                                                                                                             |
| 9    | delivered, unexpected partition — the full set arrived and one or more documents do **not carry** the expected partition value. Read off the returned documents, never off which query found them: a full set the cross-partition sweep finds in the **expected** partition is a **confirmation** (exit 0, a timing artefact of the wait bound), and a **partial** cross-partition set is exit 7, not a partition claim. A working route is never reported as broken. "Under a **different** `deviceId`" and "carrying **no** `deviceId` field at all" are stated and recorded separately (the latter is the predicted failure mode here, since nothing between the device and Cosmos injects a partition key) |
| 10   | evidence unrecorded — a send happened and the record of it could not be written or built. **Never exit 1**, which means "nothing live happened"; the ids are printed for the operator to record by hand, and this code takes precedence over the confirmation's own (still printed above it) |

**Safety semantics.**

- The partition key path and the `default_ttl` are **measured** from an
  `az cosmosdb sql container show` document at runtime (HR4). There is no
  hardcoded `/deviceId` and no hardcoded retention anywhere in the tool; a
  measured value that differs from the declared `temperature_data_ttl_days = 7`
  (604800s) is recorded as a **drift finding**, and the measured number is the one
  used.
- A **pre-send read** runs before anything is sent, requiring this run's freshly
  minted correlator to be absent — that is what makes the proof a _newly
  identified_ document, and it surfaces an unpropagated role assignment while
  nothing has yet been written that could not then be confirmed.
- The **`--evidence-out` destination is pre-flighted** — directory, writability,
  the no-overwrite rule and a concurrent-run check — **before the first send**, so
  an unusable path is a usage error (exit 1) while nothing is live, rather than 3
  documents in the container the tool then refuses to record. It is re-checked at
  write time; the pre-flight is an addition to that check, not a replacement for
  it.
- **The evidence write never destroys or interleaves a record, and never reports
  success when it might have.** Three rules, because that record is what MG-53 and
  MG-54 consume to decide whether to halt a migration. **(1) A stat error is not
  an absence** — only an explicit `ENOENT` reads as "nothing there"; any other
  `stat` failure, and a directory that cannot be enumerated, is a refusal, never
  an assumption that the path is free. That is the same error/absence conflation
  the MG-66 analysis names, applied to the tool's own filesystem. **(2) The
  temporary file is named per run, not per destination** —
  `<evidence-file>.<fixtureRunId>.partial` — so two runs sharing a destination
  cannot interleave on one temp path and leave one run's record under the other
  run's name, which is a wrong-record-under-the-right-name failure and therefore
  undetectable downstream. **(3) `--overwrite` replaces your own prior record; it
  does not defeat the concurrency guard** — a destination carrying a **foreign**
  `.partial` is refused with the flag as well as without it. No flag on this tool
  authorises destroying a record another run is still writing.
- **The operator captures the live run's stdout and stderr to files, inspects
  them for credential shapes, and commits them alongside the evidence artifact**
  (runbook §7c). This is the **only** evidence that discharges the ticket's
  no-emission criterion: reading the source proves the tool _cannot_ emit a
  credential; only a captured run proves it _did not_. The pipeline cannot
  produce it — it holds no credential and makes no live call. Expect the
  inspection to hit credential-shaped **key names** followed by `[redacted]`;
  what it must never hit is a key name followed by a value.
- Every document carries `syntheticFixture=MG-67-SYNTHETIC-FIXTURE` plus a unique
  per-run `fixtureRunId`, so a specific document ties to a specific run.
- `--evidence-out` writes **one machine-readable JSON record** — the observed
  document ids and count, the marker, the partition key path, the measured
  `default_ttl`, the wait bound used, the observed arrival delay and the
  run/expiry instants. MG-53 and MG-54 read that file as a **program input**; the
  runbook is prose and must never be the thing they parse. The record has a closed
  key set and is scanned for credential shapes at build and write time — a hit
  **refuses the write** rather than redacting. It is written atomically and will
  not overwrite an existing file without `--overwrite`.
- **The evidence-emission contract: one path, every outcome.** A record is written
  on **every** outcome that attempted a send — timeout, auth, transport, marker
  violation, ambiguity, send failure — carrying an `unconfirmed-run` finding; only
  a run that refused **before its first attempt** exits without one. It never
  claims a success the confirmation did not reach, and it **never asserts that
  nothing was written when something was attempted**. If the record itself cannot
  be written or built, the run exits **10** and prints the ids to record by hand.
  There is no path on which this tool causes a document to exist and then stays
  silent about it.
- **Four id sets (`schemaVersion: 2`), not one.** `requestedIds` (attempted),
  `acceptedIds` (`az` reported success), `ambiguousIds` (`az` reported failure and
  acceptance is **UNKNOWN** — the CLI can fail _after_ IoT Hub took the message, so
  a send failure is ambiguous by construction and is never recorded as not-sent),
  and `observedIds` (read back out of Cosmos, **monotonic** — a later auth or
  transport abort never discards what an earlier poll saw). `accountableIds` is
  their union minus nothing: the set a downstream ticket must account for.
  `uncertain: true` means the run does not know what the container holds — `count:
0` alongside it is **not** "nothing arrived". `idDivergence` is **witnessed**
  (an observed document under an unrequested id), never inferred from a count
  shortfall: asserting a platform renaming nobody saw, in the one artifact MG-53
  and MG-54 parse mechanically, makes a downstream ticket act on a fabricated
  claim. Documents the read-back returned that the run cannot claim go to
  `anomalousIds`, kept strictly apart from its own.
- **The record declares what it does NOT check.** The read-back is filtered to the
  run's own correlator, so a document written by an **unknown writer** can never
  appear in any of its id sets — `anomalousIds` included, which means a document
  carrying this run's correlator but not the marker, and is a **different**
  finding. `anomalousCount: 0` is therefore no evidence at all about unknown
  writers, and a permanently-empty field read as a cleared stop condition is the
  vacuous proof this tool exists to prevent. So the record carries a constant
  `unknownWriterCheck: { checked: false, by: "operator-unfiltered-enumeration" }`,
  and the runbook's **unfiltered enumeration** of all five containers is the only
  thing that checks it.
- A green hub metric, a green route metric and a green `/api/health/cosmos` are
  **each rejected as proof** — none of them observes a document (MG-24 and MG-58
  are the precedents). The tool consults none of them.

---

## Further Reading

- **[Bootstrap & greenfield acceptance runbook](../../docs/infrastructure/bootstrap-runbook.md)** — the operator procedure
- **[MG-67 device-fixture verification runbook](../../docs/infrastructure/mg67-device-fixture-verification.md)** — the host-phase procedure for the dev IoT device fixture (device registration, the live run, the temporary data-plane role assignment **and its removal**, the evidence, the stop conditions)
- **[Terraform setup](../../docs/infrastructure/terraform-setup.md)** — configuration reference
- **[CI/CD pipeline](../../docs/development/ci-cd.md)** — the authoritative deploy model

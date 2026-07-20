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
App name** (`meatgeek-v2-${environment}-func`) is exposed as the Terraform output
`function_app_name` and is the **one** authoritative name the app deploy
consumes — there is no independently-hardcoded Function App name anywhere.

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
nx plan infrastructure --env=dev      # terraform plan -var-file=environments/dev.tfvars
nx apply infrastructure --env=dev     # OPERATOR-run only, never CI
nx output infrastructure
```

Apply is an **operator** action run locally — CI is plan-only. The full
greenfield acceptance (MG-24's 10-step dev proof) is in the runbook.

## Environment Configuration

### Development (`environments/dev.tfvars`)

- IoT Hub **S1** (required for message routing; F1 does not support routing)
- V2-owned Cosmos DB, autoscale 400→1000 RU, 7-day telemetry TTL
- Azure Functions Consumption (Y1) plan
- SignalR Free (F1) tier
- Permissive IP ranges, backups off, low budget — cost-optimized

### Production (`environments/prod.tfvars`)

- Higher-tier SKUs, extended retention, tighter security
- Activated separately under **MG-25** (prod environment secret +
  `PROD_DEPLOY_ENABLED`)

> Staging is **out of scope** for MG-24 — there is no `staging.tfvars` and the
> `environment` variable admits only `dev` and `prod`.

## Module Structure

| Module                | Responsibility                                             |
| --------------------- | ---------------------------------------------------------- |
| `modules/iot-hub/`    | IoT Hub, Event Hub namespace, parallel routing, devices    |
| `modules/cosmos-db/`  | **V2-owned** Cosmos account, database, containers, outputs |
| `modules/functions/`  | Linux Function App (`azurerm_linux_function_app`) on a Linux `azurerm_service_plan` + its own storage account (length-safe names) |
| `modules/signalr/`    | SignalR Service (identity-based access; no secret outputs) |
| `modules/monitoring/` | Alerts, budgets, Log Analytics wiring                      |

The Cosmos module **creates** the account (`azurerm_cosmosdb_account`) — it does
**not** read a shared V1 account via a data source. There is no adoption of a pre-existing shared Cosmos account
anywhere in the stack.

The Functions module creates an **`azurerm_linux_function_app`** on a **Linux
`azurerm_service_plan`** (`os_type = "Linux"`) — **not** a Flex Consumption app
(`azurerm_function_app_flex_consumption`). The plan SKU comes from
`functions_app_service_plan_sku`, which the root validation admits as only `Y1`,
`EP1`, `EP2`, or `EP3`: dev uses **`Y1` (Consumption)** and prod uses **`EP1`
(Elastic Premium)**. The Node runtime is pinned to **20**.

## Terraform / Nx Commands

```bash
nx init     infrastructure --env=dev   # terraform init -reconfigure -backend-config=environments/backend-dev.hcl
                                       #   NOTE: hcl-only — does NOT inject storage_account_name, so it cannot
                                       #   bind the remote backend alone. Init directly (see the Bootstrap block above).
nx validate infrastructure             # terraform validate
nx format   infrastructure             # terraform fmt -recursive
nx plan     infrastructure --env=dev   # terraform plan -var-file=environments/dev.tfvars -out=tfplan
nx apply    infrastructure --env=dev   # terraform apply tfplan   (operator-run only)
nx output   infrastructure             # terraform output
nx destroy  infrastructure --env=dev   # terraform destroy (careful!)
```

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
`local_authentication_disabled = true`), a SAS-based IoT Hub route, and
(check 12) a README that stops documenting the fail-closed
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
**removed** (MG-24 S1), so no runtime credential is ever written to Terraform
state. Consumers reach every service **identity-based** (managed identity +
RBAC) via the non-secret endpoints below.

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

| Service       | Non-secret endpoint (app setting)                                                                                                                                                                                                                                                                                                                                                                                   | Role granted to the Function App identity |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Cosmos DB     | `COSMOSDB__accountEndpoint`                                                                                                                                                                                                                                                                                                                                                                                         | Cosmos DB Built-in Data Contributor       |
| IoT telemetry | `IOTHUB_EVENTS__fullyQualifiedNamespace`                                                                                                                                                                                                                                                                                                                                                                            | Azure Event Hubs Data Receiver            |
| SignalR       | `AzureSignalRConnectionString__serviceUri`                                                                                                                                                                                                                                                                                                                                                                          | SignalR Service Owner                     |
| App Insights  | `APPLICATIONINSIGHTS_CONNECTION_STRING` (the FULL TF-managed connection string, `InstrumentationKey=…;IngestionEndpoint=…` — Microsoft requires the ikey as the destination-resource identifier even under Entra) + `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD`. The ikey **cannot authenticate**: `local_authentication_disabled = true` on the App Insights resource forces AAD-only ingestion. | Monitoring Metrics Publisher              |

The IoT Hub's own system-assigned identity likewise writes to Cosmos (Built-in
Data Contributor) and sends to the Event Hubs routing endpoint (Azure Event Hubs
Data Sender) — the Event Hubs route is **identity-based**, so no SAS connection
string is generated or stored in state.

### Verifying the absence of secrets in state/plan

Two layers, with clearly different strengths:

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
   inspects the actual sensitive **VALUES** (distinguishing setting NAMES from
   VALUES — the app-setting key `APPLICATIONINSIGHTS_CONNECTION_STRING` is never
   itself a finding; only the string bound to it is). It allows **only** the one
   operator-accepted App Insights residual — the full AI connection string in a
   Function App `app_setting`, and **only** when the plan's
   `azurerm_application_insights` sets `local_authentication_disabled = true`
   (the coupled invariant) — and **rejects** every other credential VALUE
   (connection string / SAS / account|access|primary key / a bare instrumentation
   key, in `app_settings` or outputs). It **EXITS NONZERO** on any violation, and
   also fail-closed on any operational failure (missing `jq`, unparseable JSON,
   no input). It replaces the old always-green one-liner (a `terraform show -json`
   result fed into `grep` and neutralized with a trailing `or-echo "ok"`), which
   swallowed its own failure and so could never block an apply. **This inspection
   is REQUIRED before the first apply and MUST come up clean** — `tf-static-checks.sh`
   check 12 fails CI if this README stops documenting it as the required
   pre-apply gate.

```bash
# Layer 1 — best-effort static guard (fails CI early on the common patterns):
scripts/tf-static-checks.sh

# Layer 2 — AUTHORITATIVE, REQUIRED pre-apply, FAIL-CLOSED: exits nonzero on any
# prohibited credential VALUE in app_settings/outputs. Do NOT apply until clean.
terraform plan -var-file=environments/dev.tfvars -out=tfplan
terraform show -json tfplan | scripts/tf-plan-secret-inspection.sh
#   or point it at the plan binary directly:
#   scripts/tf-plan-secret-inspection.sh tfplan
```

## Security Notes

- **OIDC, no long-lived secrets.** CI authenticates via GitHub Actions OIDC with
  federated credentials scoped **per GitHub Environment** (`development`,
  `production`) — the presented OIDC subject is
  `repo:<owner>/<repo>:environment:development | production`, and the bootstrap
  creates a federated credential whose subject matches each environment name
  **exactly** (the workflow declares `environment: development`, so bare `dev`
  would never match). The development CI identity can never authenticate to prod.
- **Two separate identities (MG-24 item 4).** The CI **Terraform PLAN** identity
  is **plan/read-only** — `Reader` at subscription scope + a `Storage Blob Data`
  role scoped to **its own per-environment state container only**
  (`tfstate-dev` / `tfstate-prod`), never account-scoped. It has no write/apply
  role, so an accidental CI apply fails closed. A `Reader` **cannot publish** a
  Function App, so app deployment uses a **distinct APP-DEPLOYMENT identity**
  granted least-privilege publish (`Website Contributor`) scoped to **its
  Function App only** — surfaced as the `AZURE_APP_DEPLOY_CLIENT_ID` GitHub
  variable. The plan identity is labeled a _plan/read_ identity, not a
  _deployment_ identity. (The **prod** deploy identity + role assignment is an
  **MG-25** deliverable, out of scope here.)
- **No hardcoded subscription id** — resolved from the authenticated environment.
- **State store hardened** — TLS 1.2 floor, no public blob access, HTTPS-only,
  blob versioning + soft delete.

- **No runtime secrets in state.** Cosmos / IoT-telemetry (Event Hubs) / SignalR
  access is identity-based (managed identity + RBAC + non-secret endpoints); the
  Function App's host storage uses its managed identity (shared-key access
  disabled). No connection strings or primary keys are placed in app settings or
  surfaced as Terraform outputs. **Application Insights telemetry ingestion is
  AAD-authenticated:** the Function App authenticates via its managed identity —
  `APPLICATIONINSIGHTS_AUTHENTICATION_STRING = "Authorization=AAD"` plus a
  `Monitoring Metrics Publisher` role assignment on the App Insights resource.
  The **full** TF-managed `APPLICATIONINSIGHTS_CONNECTION_STRING` (with the
  `InstrumentationKey`) is placed in app settings **because Microsoft requires
  the connection string as the destination-resource identifier even under
  Entra** — but the embedded ikey **cannot authenticate**: the App Insights
  resource sets `local_authentication_disabled = true`, which forces AAD-only
  ingestion and disables ikey/local auth. The connection string / instrumentation
  key is therefore present in app settings and (as a computed attribute of
  `azurerm_application_insights.main`) in Terraform state, but it is a
  **present-but-non-authenticating** residual: **safe ONLY while local auth is
  disabled**. That coupled invariant is machine-enforced — `tf-static-checks.sh`
  check 9 rejects the full conn string in `app_settings` unless
  `local_authentication_disabled = true`, and the fail-closed
  `scripts/tf-plan-secret-inspection.sh` gate enforces the same over the real
  plan. See
  [ADR: App Insights key in Terraform state](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md).

## Deploy Alignment (Function App name)

The app deploy (`apps/api/project.json` + `.github/workflows/app-deploy-prod.yml`)
reads the Function App name from `terraform output -raw function_app_name` rather
than hardcoding it, so a naming change in Terraform can never desync the publish
target.

---

## Further Reading

- **[Bootstrap & greenfield acceptance runbook](../../docs/infrastructure/bootstrap-runbook.md)** — the operator procedure
- **[Terraform setup](../../docs/infrastructure/terraform-setup.md)** — configuration reference
- **[CI/CD pipeline](../../docs/development/ci-cd.md)** — the authoritative deploy model

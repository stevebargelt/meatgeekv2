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
state keys so dev and prod state can never collide:

| Env  | Config file                     | State key                  |
| ---- | ------------------------------- | -------------------------- |
| dev  | `environments/backend-dev.hcl`  | `meatgeek-v2/dev.tfstate`  |
| prod | `environments/backend-prod.hcl` | `meatgeek-v2/prod.tfstate` |

Both point at the V2-owned state account `meatgeekv2tfstate`
(RG `meatgeek-v2-tfstate-rg`, container `tfstate`) stood up by the bootstrap.
The legacy V1 shared state account is deliberately **not** used.

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
# Delete any stale local state FIRST (never migrate it into remote state)
rm -f terraform.tfstate terraform.tfstate.backup && rm -rf .terraform

# Clean init bound to the dev state key
nx init infrastructure --env=dev
#   or directly:
#   terraform init -reconfigure -backend-config=environments/backend-dev.hcl
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
| `modules/functions/`  | Function App + service plan + storage (length-safe names)  |
| `modules/signalr/`    | SignalR Service (identity-based access; no secret outputs) |
| `modules/monitoring/` | Alerts, budgets, Log Analytics wiring                      |

The Cosmos module **creates** the account (`azurerm_cosmosdb_account`) — it does
**not** read a shared V1 account via a data source. There is no adoption of a pre-existing shared Cosmos account
anywhere in the stack.

## Terraform / Nx Commands

```bash
nx init     infrastructure --env=dev   # terraform init -reconfigure -backend-config=environments/backend-dev.hcl
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

`tf-static-checks.sh` fails CI on: a hardcoded subscription id, `timestamp()`
tag drift, any leftover V1 shared-Cosmos adoption reference, missing per-env
state keys, a stray local `*.tfstate`, or a missing `meatgeek-v2-` prefix. It
runs in the `validate-infrastructure` job.

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

| Service       | Non-secret endpoint (app setting)          | Role granted to the Function App identity |
| ------------- | ------------------------------------------ | ----------------------------------------- |
| Cosmos DB     | `COSMOSDB__accountEndpoint`                | Cosmos DB Built-in Data Contributor       |
| IoT telemetry | `IOTHUB_EVENTS__fullyQualifiedNamespace`   | Azure Event Hubs Data Receiver            |
| SignalR       | `AzureSignalRConnectionString__serviceUri` | SignalR Service Owner                     |

The IoT Hub's own system-assigned identity likewise writes to Cosmos (Built-in
Data Contributor) and sends to the Event Hubs routing endpoint (Azure Event Hubs
Data Sender) — the Event Hubs route is **identity-based**, so no SAS connection
string is generated or stored in state.

### Verifying the absence of secrets in state/plan

```bash
# No secret OUTPUTS in any module or root outputs.tf, and the IoT Hub routing
# endpoint is identity-based (no SAS). Both are enforced statically:
scripts/tf-static-checks.sh

# Inspect the plan for any connection string / key before the first apply:
terraform plan -var-file=environments/dev.tfvars -out=tfplan
terraform show -json tfplan | grep -iE 'connection_string|primary_key|SharedAccessKey' || echo "no secrets in plan ✓"
```

## Security Notes

- **OIDC, no long-lived secrets.** CI authenticates via GitHub Actions OIDC with
  federated credentials scoped **per GitHub Environment** (`dev`, `production`) —
  the dev CI identity can never authenticate to prod. The CI role is
  **plan/read-only** (`Reader` + `Storage Blob Data Contributor` on the state
  account only); apply is never granted to CI.
- **No hardcoded subscription id** — resolved from the authenticated environment.
- **State store hardened** — TLS 1.2 floor, no public blob access, HTTPS-only,
  blob versioning + soft delete.

- **No runtime secrets in state.** Cosmos / IoT-telemetry (Event Hubs) / SignalR
  access is identity-based (managed identity + RBAC + non-secret endpoints); the
  Function App's host storage uses its managed identity (shared-key access
  disabled). No connection strings or primary keys are placed in app settings or
  surfaced as Terraform outputs. The only sensitive app setting is the App
  Insights connection string (telemetry ingestion, not a data-plane credential),
  wired directly from the resource attribute and never exported as an output.

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

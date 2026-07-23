# Terraform Infrastructure Setup

## Overview

The MeatGeek V2 infrastructure is managed entirely with **Terraform** as
Infrastructure as Code, organized within the Nx monorepo. This is a **greenfield
V2 stack**: it creates and **owns** every resource it needs (including its own
Cosmos DB account) and has **no** dependency on the legacy V1 system.

> **Hard safety (MG-24).** Never import, adopt, modify, rename, or delete a V1
> Azure resource from this project. V2 always uses the `azurerm` **remote**
> backend with a per-environment state key — there is no supported local-state
> path. Apply is an **operator** action; CI is plan-only.

For the end-to-end operator procedure (bootstrap + the greenfield dev
plan/apply acceptance with evidence capture) see the
**[bootstrap runbook](./bootstrap-runbook.md)**.

## Directory Structure

```
apps/infrastructure/
├── bootstrap/
│   └── bootstrap.sh            # run-once: remote state + OIDC identity
├── scripts/
│   └── tf-static-checks.sh     # deterministic static gate (no Azure)
├── environments/
│   ├── dev.tfvars              # dev variable values
│   ├── prod.tfvars             # prod variable values
│   ├── backend-dev.hcl         # dev remote-state partial config
│   └── backend-prod.hcl        # prod remote-state partial config
├── modules/                    # reusable Terraform modules
│   ├── iot-hub/
│   ├── cosmos-db/              # CREATES and OWNS the V2 Cosmos account
│   ├── functions/
│   ├── signalr/
│   └── monitoring/
├── main.tf                     # root module (backend, provider, locals, modules)
├── variables.tf                # input variable definitions
├── outputs.tf                  # output value definitions
├── project.json                # Nx project configuration
└── README.md                   # infrastructure documentation
```

> There is **no** `staging.tfvars` — staging is out of scope for MG-24 and the
> `environment` variable admits only `dev` and `prod`.

## Core Configuration

### Remote-state backend (partial config, per environment)

`main.tf` declares an empty `azurerm` backend for partial configuration; the
per-environment values are supplied at init time. This keeps **distinct** state
keys so dev and prod state can never collide.

```hcl
# main.tf
terraform {
  backend "azurerm" {}   # values come from environments/backend-<env>.hcl
}
```

```hcl
# environments/backend-dev.hcl — storage_account_name is DELIBERATELY absent
resource_group_name = "meatgeek-v2-tfstate-rg"
container_name      = "tfstate-dev"
key                 = "meatgeek-v2/dev.tfstate"
use_azuread_auth    = true
```

```hcl
# environments/backend-prod.hcl — storage_account_name is DELIBERATELY absent
resource_group_name = "meatgeek-v2-tfstate-rg"
container_name      = "tfstate-prod"
key                 = "meatgeek-v2/prod.tfstate"
use_azuread_auth    = true
```

dev and prod use **distinct, per-environment containers** (`tfstate-dev` /
`tfstate-prod`) — not one shared `tfstate` container — so their state can never
collide and each CI identity's data-plane state access is RBAC-scoped to its own
container only.

The state-account **name** is **deliberately not** in the `backend-*.hcl` files
and is **not** a hardcoded literal: it is **derived** from the subscription id
by the single sourced helper `scripts/state-account-name.sh` (`meatgeekv2tf` +
first 12 hex of `sha1(subscription-id)` = 24 chars), so it is globally unique
per subscription and identical everywhere it is used (bootstrap, CI, the
runbook). Having exactly one derivation is what guarantees the bootstrap, the
backend init, and every workflow can never bind divergent account names. The
state account is created **once** by the bootstrap
(`apps/infrastructure/bootstrap/bootstrap.sh`) — you do **not** create it by
hand, and the legacy V1 shared state account is deliberately **not** used.

Initialize with a **clean** init, injecting the derived account name as an extra
`-backend-config` (never migrate local state):

```bash
rm -f terraform.tfstate terraform.tfstate.backup && rm -rf .terraform
terraform init -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
```

(`ARM_SUBSCRIPTION_ID` must be exported first — see the runbook Prerequisites.)

### Provider configuration

```hcl
terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

provider "azurerm" {
  # No hardcoded subscription. Resolved from ARM_SUBSCRIPTION_ID / OIDC, the
  # ambient az CLI context for local runs, or the optional subscription_id
  # variable (default null).
  subscription_id = var.subscription_id

  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}
```

### Naming & tags (single source of truth, no drift)

```hcl
locals {
  # V2 naming: meatgeek-v2-{environment}-{service}. One prefix, cascaded to
  # every module, so V2 can never be confused with V1.
  resource_prefix = "meatgeek-v2-${var.environment}"

  # No wall-clock-derived tag (no CreatedDate = timestamp()) — a dynamic value
  # would change on every plan and churn tags on unchanged resources.
  common_tags = {
    Project     = "MeatGeek V2"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Repository  = "stevebargelt/meatgeekv2"
  }
}
```

The **Function App** is named `${var.resource_prefix}-func-${var.global_suffix}`
(`meatgeek-v2-${environment}-func-<suffix>`, e.g. `meatgeek-v2-dev-func-abc123def456`)
and exposed as the `function_app_name` output — the single name the app deploy
consumes. The trailing `<suffix>` is the deterministic, subscription-derived
`global_name_suffix` (a 12-char `sha1` of `${subscription_id}-global`) shared with
the IoT Hub, Event Hubs namespace, and SignalR; it guarantees the globally-scoped
Function App name cannot collide with a pre-existing resource on a greenfield apply.

### V2-owned Cosmos DB

The Cosmos module **creates** the account — it does not read a shared V1 account
via a data source, and there is **no** V1 shared-Cosmos adoption input anywhere:

```hcl
# main.tf — the owned account name is globally-unique, deterministic, and
# decoupled from the human-readable prefix so it can never collide with V1.
locals {
  cosmos_account_name = "mgv2-${var.environment}-${substr(sha1("${data.azurerm_client_config.current.subscription_id}-cosmos"), 0, 12)}"
}

module "cosmos_db" {
  source = "./modules/cosmos-db"

  resource_prefix     = local.resource_prefix
  environment         = var.environment
  cosmos_account_name = local.cosmos_account_name   # V2 owns this account
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  # ... throughput / ttl / tags
}
```

## Nx Integration

`project.json` wraps the Terraform commands. The `init` target is **env-aware**
and passes `-reconfigure` so switching environments re-binds the backend. Note it
binds **only** the `-backend-config=environments/backend-{env}.hcl` file and does
**not** inject the derived `storage_account_name` — so it is not sufficient to bind
the remote backend by itself (see the caveat under Common Nx commands below):

```jsonc
{
  "targets": {
    "init": {
      "command": "terraform init -reconfigure -backend-config=environments/backend-{args.env}.hcl",
    },
    "plan": { "command": "terraform plan -var-file=environments/{args.env}.tfvars -out=tfplan" },
    "apply": { "command": "terraform apply tfplan" },
    "destroy": { "command": "terraform destroy -var-file=environments/{args.env}.tfvars" },
    "validate": { "command": "terraform validate" },
    "format": { "command": "terraform fmt -recursive" },
    "output": { "command": "terraform output" },
  },
}
```

### Common Nx commands

```bash
nx init     infrastructure --env=dev     # binds the hcl only — see caveat below
nx plan     infrastructure --env=dev
nx apply    infrastructure --env=dev     # operator-run only, never CI
nx validate infrastructure
nx destroy  infrastructure --env=dev
```

> **`nx init` does not bind the remote backend on its own.** The `init` wrapper
> runs `terraform init -reconfigure -backend-config=environments/backend-{env}.hcl`
> **without** the derived `storage_account_name`, which the `backend-*.hcl` files
> deliberately omit — so on a clean checkout it cannot resolve the state account.
> To bind the remote backend, run `terraform init` directly with **both**
> `-backend-config` flags (as shown above and in the [bootstrap runbook](./bootstrap-runbook.md),
> and as the CI/CD workflows do). Once the backend is bound, `nx plan` / `nx apply`
> operate against it normally.

## Environment Management

### Development (`environments/dev.tfvars`)

Cost-optimized:

```hcl
environment = "dev"
location    = "West US 2"   # Flex-supported region (MG-24). NOTE: location fans out
                            # to the whole stack — see the Flex ADR relocation caveat.

iot_hub_sku_name     = "S1"   # S1 required for message routing (F1 cannot route)
iot_hub_sku_capacity = 1

cosmos_database_throughput     = 400    # V2-owned account
cosmos_database_max_throughput = 1000
temperature_data_ttl_days      = 7

# Azure Functions: SINGLE Flex Consumption model (FC1) for both envs — the former
# functions_app_service_plan_sku (Y1/EP1) is REMOVED (MG-24). Tuned by scale knobs:
instance_memory_in_mb  = 2048
maximum_instance_count = 100
always_ready           = 0   # dev: scale-to-zero (~$0 idle). prod sets >= 1.
signalr_sku_name = "Free_F1"
```

### Production (`environments/prod.tfvars`)

Higher-tier SKUs, extended retention, tighter security. Production is **activated
separately under MG-25** (the `production` GitHub Environment secret +
`PROD_DEPLOY_ENABLED`).

## CI/CD Integration

CI **never** runs `terraform apply`. The authoritative model:

- **`.github/workflows/ci.yml`** — the `validate-infrastructure` job runs
  `terraform validate`, `terraform fmt -check`, and `scripts/tf-static-checks.sh`.
  The `deploy-dev` job is **plan-only**.
- **`.github/workflows/infra-deploy-prod.yml`** — authenticates via **OIDC**
  (`id-token: write`, `azure/login` with the per-environment federated
  credential; no long-lived service-principal secret), binds prod remote state
  (`terraform init -reconfigure -backend-config=environments/backend-prod.hcl`
  plus `-backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"`),
  runs under the `production`
  GitHub Environment gate, and **ends at `terraform plan`**. There is **no**
  `apply`.
- **`.github/workflows/app-deploy-prod.yml`** — reads
  `terraform output -raw function_app_name` and passes it to the `nx deploy api`
  step so the publish target can never desync from the Terraform name.

See **[CI/CD Pipeline](../development/ci-cd.md)** for the full model.

### OIDC deployment identity

The GitHub Actions identity uses **federated credentials scoped per GitHub
Environment** — the canonical subject scheme
`repo:<owner>/<repo>:environment:<github-env>` where `<github-env>` is the exact
`environment:` the deploy job declares (`repo:stevebargelt/meatgeekv2:environment:development`
for dev and `:environment:production` for prod), not per branch — so the dev CI
identity can never authenticate to prod. dev and prod are SEPARATE identities
(no shared SP). It holds a **plan/read-only** role (`Reader` +
`Storage Blob Data Contributor` on that env's state container only). Apply is
never granted to CI. The identities are created by the bootstrap (see the
runbook), and the workflow↔bootstrap subject alignment is asserted in CI by
`oidc-subject-consistency.spec.ts`.

## Getting Started

### Prerequisites

1. **Azure CLI** installed and authenticated (`az login`)
2. **Terraform** ≥ 1.9
3. **Node.js** + **Nx** for the monorepo commands
4. Access to the V2 Azure subscription

### Initial setup

1. **Clone and install**

   ```bash
   git clone https://github.com/stevebargelt/meatgeekv2
   cd meatgeekv2
   npm install
   ```

2. **Run the one-time bootstrap** (remote state + OIDC identity — idempotent):

   ```bash
   cd apps/infrastructure/bootstrap
   ./bootstrap.sh
   ```

   Do **not** create the state storage account by hand — the bootstrap owns it.

3. **Initialize and plan the dev environment** (clean init):

   ```bash
   cd apps/infrastructure
   rm -f terraform.tfstate terraform.tfstate.backup && rm -rf .terraform
   # Bind the remote backend with the derived state-account name (the `nx init`
   # wrapper does NOT inject storage_account_name, so init it directly):
   terraform init -reconfigure \
     -backend-config=environments/backend-dev.hcl \
     -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
   nx plan infrastructure --env=dev
   # apply is operator-run per the runbook, after human plan review
   ```

The full greenfield acceptance (MG-24's 10-step dev proof with evidence capture)
is in the **[bootstrap runbook](./bootstrap-runbook.md)**.

## Authentication Integration

MeatGeek V2 authenticates callers with **Azure Entra (App Service Easy Auth)** at
the platform layer — there is **no** Supabase and **no** external auth provider.
The Function App enables `auth_settings_v2` with an `active_directory_v2` identity
provider (`modules/functions/main.tf`) and is **fail-closed**: a module
precondition refuses to deploy unless the Entra API registration is configured, so
an anonymous Function App can never ship. Every request is validated at the
platform layer **before any function runs** — `require_authentication = true` with
`unauthenticated_action = "Return401"`, so a missing/invalid bearer token is
rejected with 401 regardless of a function's own `authLevel`.

This is **bearer-token validation only**, not an interactive sign-in flow:

- **No client secret** is set — Easy Auth only *validates* inbound tokens, it never
  performs a login redirect or holds a credential.
- **`allowed_audiences`** carries the exact **API App ID URI** (`api://<api-app-id>`) —
  the token's `aud` must match the dev Entra API registration.
- **`allowed_applications`** validates the **calling client's** `appid`/`azp` claim
  (the pre-authorized client — the Azure CLI public client by default, or a dedicated
  dev client). A token minted by any other client is rejected.
- **`token_store_enabled = false`** — no token is persisted at rest.

The Entra API registration (the delegated `access_as_user` scope on
`api://<api-app-id>`) is created by the **[bootstrap](./bootstrap-runbook.md)**, not
Terraform; the operator wires its coordinates into `environments/dev.tfvars`
(`functions_auth_client_id`, `functions_auth_tenant_id`,
`functions_auth_allowed_audiences`, `functions_auth_allowed_client_app_ids`). Acquire
an operator token for the authenticated smoke test with:

```bash
APP_ID_URI=$(az ad app show --id <api-app-id> --query 'identifierUris[0]' -o tsv)
az account get-access-token --scope "${APP_ID_URI}/access_as_user"
```

No `SUPABASE_*` (or any other auth-provider) app settings exist on the Function App —
authentication is enforced entirely by the platform via the Entra identity provider.
See the **[bootstrap runbook](./bootstrap-runbook.md)** for the full Entra registration
and authenticated-smoke-test procedure.

> **Identity-based service access (MG-24).** The Function App runs under a
> **system-assigned managed identity**, and access to Cosmos DB, IoT/Event Hub
> telemetry, SignalR, and its own host storage is granted by **RBAC role
> assignments** on that identity. App settings carry only **non-secret
> endpoints** (`COSMOSDB__accountEndpoint`,
> `IOTHUB_EVENTS__fullyQualifiedNamespace`,
> `AzureSignalRConnectionString__serviceUri`) — **no connection-string or
> primary-key VALUE is injected as an app setting or surfaced as a Terraform
> output**, so there is no plaintext secret to route through Key Vault. Each data
> service's key does still exist as an inherent **computed attribute** in state
> (true of any TF-managed resource); the control is to render those keys
> non-authenticating by disabling local/key auth where safe
> (`local_authentication_enabled = false` on Cosmos, `local_auth_enabled = false` on
> SignalR, `shared_access_key_enabled = false` on host storage,
> `local_authentication_enabled = false` on the Event Hubs namespace), with **IoT
> Hub the SOLE documented exception** (device SAS auth kept; restricted state
> access as the mitigation). The coupling is enforced by the fail-closed
> `scripts/tf-plan-secret-inspection.sh` gate. See
> [ADR: data-service keys in Terraform state](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md)
> and
> [Azure Functions API → Application Settings](../api/azure-functions.md#application-settings).

## Static Validation

Run without any Azure credentials — produces no state:

```bash
cd apps/infrastructure
terraform init -backend=false && terraform validate
terraform fmt -check -recursive
scripts/tf-static-checks.sh
```

`tf-static-checks.sh` fails on: a hardcoded subscription id, `timestamp()` tag
drift, any leftover V1 shared-Cosmos adoption reference, missing per-env state
keys, a stray local `*.tfstate`, or a missing `meatgeek-v2-` prefix.

## Benefits of This Setup

- **Greenfield & self-owned** — no V1 dependency; V2 owns its Cosmos account
- **Per-environment isolated state** — dev/prod state can never collide
- **No long-lived secrets** — OIDC federation, plan/read-only CI role
- **Deterministic** — no `timestamp()` drift; a second plan is a NO-OP
- **Single source of truth** — one naming prefix; the Function App name flows
  from a Terraform output into the deploy
- **Nx integration** — consistent tooling with the rest of the monorepo

---

> **Next steps:** run the **[bootstrap runbook](./bootstrap-runbook.md)**, then
> configure applications from the Terraform outputs.

# MeatGeek V2 Infrastructure — Bootstrap & Greenfield Acceptance Runbook

> **Scope (MG-24).** MeatGeek **V2 is greenfield** — there is no V2 Azure
> infrastructure and no V2 Terraform state to recover. `meatgeek-dev-rg` was
> deliberately deleted. Every remaining MeatGeek Azure resource belongs to the
> legacy **V1** system and is **out of scope**: never import, adopt, modify,
> rename, or delete a V1 resource. This runbook takes an operator from an empty
> subscription to a fully-created V2 environment, then reconciles incrementally.

This is the authoritative procedure for two operator-run activities that live
**outside** the CI pipeline:

1. The **run-once bootstrap** — stand up remote state + the OIDC deployment
   identity that everything else depends on.
2. The **greenfield DEV plan/apply proof** (MG-24's 10-step acceptance) — create
   the complete V2 dev stack from empty state and capture the evidence.

CI never runs `terraform apply`. Apply is an operator action, run locally with
the operator's own elevated credentials, against the durable **remote** backend.

---

## Hard safety rules

These are non-negotiable (MG-24 safety constraints):

- **Never touch a V1 resource.** No import, adopt, modify, rename, or delete.
- **Never `terraform apply` against ephemeral local state.** An apply against
  empty local state would try to create/recreate live infrastructure. V2 always
  uses the `azurerm` remote backend with a per-environment state key.
- **Never create V2 Azure resources by hand.** Terraform (and the one bootstrap
  script) own resource creation.
- **Never use `terraform init -migrate-state`** on the first init. Migrating
  would pull any stale, V1-bound local state into the V2 remote backend. Always
  do a **clean** init after deleting local state (Step 2 below).

---

## Prerequisites

- **Terraform** ≥ 1.9
- **Azure CLI** (`az`), authenticated as a subscription **Owner** /
  **User Access Administrator** for the bootstrap (it creates an AAD app,
  a role assignment, and storage). Day-to-day plan/apply needs less.
- The V2 Azure **subscription id** (obtained from `az account show`, never
  hardcoded in Terraform).
- Repo checked out; `apps/infrastructure` is the Terraform root.

---

## Part 1 — Run-once bootstrap (per subscription)

The main Terraform stack cannot create the two things it depends on at
`terraform init` time — the remote-state storage and the deployment identity.
`apps/infrastructure/bootstrap/bootstrap.sh` stands both up. It keeps **no**
long-lived Terraform state of its own; it is an idempotent Azure CLI procedure
(create-if-absent everywhere), so re-running it is safe.

```bash
az login                                        # as Owner / User Access Administrator
az account set --subscription <V2-subscription-id>

cd apps/infrastructure/bootstrap
./bootstrap.sh                                  # idempotent; safe to re-run
```

What it creates (and nothing else):

1. **Durable remote-state storage** — a dedicated V2 state resource group,
   storage account, and container:

   | Resource        | Default name             |
   | --------------- | ------------------------ |
   | Resource group  | `meatgeek-v2-tfstate-rg` |
   | Storage account | `meatgeekv2tfstate`      |
   | Container       | `tfstate`                |

   These match the committed `environments/backend-dev.hcl` /
   `environments/backend-prod.hcl` exactly. The account is hardened (TLS 1.2
   floor, no public blob access, HTTPS-only, blob versioning + 30-day soft
   delete). All names are overridable via environment variables
   (`STATE_RG`, `STATE_STORAGE_ACCOUNT`, `STATE_CONTAINER`, `STATE_LOCATION`) —
   if you override them, update the `backend-*.hcl` files to match.

2. **The GitHub Actions OIDC deployment identity** — a SEPARATE Azure AD
   application + service principal PER environment, each with a **federated
   credential scoped per GitHub Environment**, **not** per branch. Because trust
   is bound to the GitHub Environment (and its protection rules), the dev CI
   identity can never mint a token accepted by the prod federated credential.
   **No client secret is ever created** — OIDC issues short-lived tokens at run
   time.

   **Canonical subject scheme (must not drift):**

   ```
   subject = repo:<owner>/<repo>:environment:<github-env>
   ```

   `<github-env>` is the EXACT `environment:` value the deploy job declares, so
   the credential the bootstrap creates equals the OIDC subject GitHub presents.
   The two environments and their (short) Terraform/state names:

   | GitHub Environment (workflow `environment:` + OIDC subject) | Federated subject                                       | tf env / state container |
   | ----------------------------------------------------------- | ------------------------------------------------------- | ------------------------ |
   | `development` (ci.yml `deploy-dev`)                          | `repo:stevebargelt/meatgeekv2:environment:development`  | `dev` / `tfstate-dev`    |
   | `production` (infra-deploy-prod / app-deploy-prod)           | `repo:stevebargelt/meatgeekv2:environment:production`   | `prod` / `tfstate-prod`  |

   The full-word GitHub-Environment names (`development`, `production`) are what
   the workflows declare — a deploy job with `environment: development` presents
   the subject `…:environment:development`, so the bootstrap federates that exact
   subject (never a bare `…:environment:dev`, which would silently never match).
   A jest guard (`oidc-subject-consistency.spec.ts`, in CI) and the bootstrap
   tests (`bootstrap.test.sh`) assert this alignment so it cannot drift.

   The CI identity is granted least-privilege **`Reader`** (plan/read-only) at
   subscription scope plus **`Storage Blob Data Contributor` on the state
   account only** (so plan can read/lock the tfstate blob). It has **no** write
   or apply role — an accidental CI apply fails closed.

A **V1-safety guard** (`assert_v2_name`) refuses to operate on any name that is
not unambiguously `meatgeek-v2` / `meatgeekv2`, and explicitly rejects the known
V1 identifiers (`meatgeek-shared`, `meatgeekterraformstate`). This is the last
line of defense against a mistyped override pointing the bootstrap at V1.

### Wire the OIDC coordinates into GitHub

The script prints the non-secret coordinates to register as **GitHub
Environment** variables/secrets (one set per environment — the GitHub
Environments named `development` and `production`):

```
AZURE_CLIENT_ID        = <appId>
AZURE_TENANT_ID        = <tenantId>
AZURE_SUBSCRIPTION_ID  = <subscriptionId>
```

These are identifiers, not secrets. The prod-activation wiring (enabling the
`production` environment secret + `PROD_DEPLOY_ENABLED`) is tracked under
**MG-25** and is out of scope for MG-24.

---

## Part 2 — Greenfield DEV plan/apply proof (MG-24 10-step acceptance)

This is the operator's out-of-pipeline acceptance for MG-24. It creates the
complete V2 dev stack from empty state and captures evidence. Run it once the
bootstrap (Part 1) has completed.

Set up a directory to collect evidence:

```bash
cd apps/infrastructure
mkdir -p /tmp/mg24-evidence
```

### Step 1 — Start from nothing

Confirm there are **no** V2 dev resources and the remote dev state is empty
(a fresh `meatgeek-v2/dev.tfstate` blob, or none yet). Do not proceed if a prior
V2 dev environment already exists — this proof is for greenfield creation.

### Step 2 — Delete any local state (MANDATORY pre-init)

Stale on-disk state is V1-bound and must never reach the V2 remote backend.
Delete it **before** the first init:

```bash
rm -f terraform.tfstate terraform.tfstate.backup
rm -rf .terraform
```

> The repo currently contains a legacy `apps/infrastructure/terraform.tfstate`
> from V1-era experimentation. Deleting it here is required and safe — it is not
> V2 state.

### Step 3 — Clean init against the per-environment remote backend

```bash
terraform init -reconfigure -backend-config=environments/backend-dev.hcl
```

- **Never add `-migrate-state`.** A clean init binds the empty
  `meatgeek-v2/dev.tfstate` key with no migration of local state.
- `-reconfigure` is required when switching environments (dev ↔ prod) so the
  backend is re-bound to the new state key rather than reusing a cached one.
- Equivalent Nx target: `nx init infrastructure --env=dev`.

### Step 4 — Plan the complete stack

```bash
terraform plan -var-file=environments/dev.tfvars -out=tfplan \
  | tee /tmp/mg24-evidence/dev-plan-1.txt
```

The plan must propose the **complete** V2 dev stack — resource group,
Log Analytics + Application Insights, IoT Hub, the **V2-owned** Cosmos account
(not the V1 shared account), Azure Functions (including the Function App
`meatgeek-v2-dev-func`), SignalR, and monitoring. Nothing should reference V1.

### Step 5 — Human plan review

A human reviews the plan for **scope** (only expected V2 resources), **security**
(no V1 adoption, no hardcoded subscription id, connection strings handled
sanely), and **cost** (SKUs/throughput/retention match `dev.tfvars`). Do not
apply without this review.

### Step 6 — Apply (operator-run, never CI)

```bash
terraform apply tfplan | tee /tmp/mg24-evidence/dev-apply.txt
```

Apply must successfully **create** the complete V2 dev infrastructure, including
the Function App. Confirm the Function App name equals the Terraform output —
this is the single source of truth the deploy consumes:

```bash
terraform output -raw function_app_name   # → meatgeek-v2-dev-func
```

### Step 7 — Second plan is a NO-OP

```bash
terraform plan -var-file=environments/dev.tfvars \
  | tee /tmp/mg24-evidence/dev-plan-2-noop.txt
```

This **must** report `No changes. Your infrastructure matches the
configuration.` A non-empty second plan means non-deterministic config (e.g.
`timestamp()`-driven tag drift) — investigate before continuing. The static
gate (`scripts/tf-static-checks.sh`) guards against the known cause.

### Step 8 — Representative incremental change

Make a small, representative infrastructure change in Git (e.g. adjust a
retention value or a tag in `dev.tfvars`/`main.tf`), commit it, then:

```bash
terraform plan -var-file=environments/dev.tfvars \
  | tee /tmp/mg24-evidence/dev-plan-3-incremental.txt
```

The plan must propose **only** that incremental change.

### Step 9 — Apply the change, then confirm NO-OP again

```bash
terraform apply -var-file=environments/dev.tfvars \
  | tee /tmp/mg24-evidence/dev-apply-incremental.txt

terraform plan -var-file=environments/dev.tfvars \
  | tee /tmp/mg24-evidence/dev-plan-4-noop.txt   # must be No changes.
```

### Step 10 — Capture evidence

Collect and attach to the MG-24 ticket:

- The **state key** in use (`meatgeek-v2/dev.tfstate`) and the state account
  (`meatgeekv2tfstate` / RG `meatgeek-v2-tfstate-rg`).
- The **plan/apply logs** captured above (`/tmp/mg24-evidence/*.txt`).
- The **resource inventory**:

  ```bash
  terraform state list | tee /tmp/mg24-evidence/dev-resource-inventory.txt
  az resource list --resource-group meatgeek-v2-dev-rg -o table \
    | tee /tmp/mg24-evidence/dev-azure-inventory.txt
  ```

Prod (MG-25) follows the same procedure with `backend-prod.hcl` /
`prod.tfvars` and the `meatgeek-v2/prod.tfstate` key, but is a separate,
gated activation.

---

## What CI does (and does not) do

- `.github/workflows/ci.yml` (`validate-infrastructure`) runs
  `terraform validate`, `terraform fmt -check`, and
  `scripts/tf-static-checks.sh`. The `deploy-dev` job is **plan-only**.
- `.github/workflows/infra-deploy-prod.yml` authenticates via **OIDC**, binds
  the prod remote state (`-backend-config=environments/backend-prod.hcl`), runs
  under the `production` GitHub Environment gate, and **ends at
  `terraform plan`** — there is **no** `apply` in CI.

Never add auto-apply to CI. Apply stays an operator action per this runbook.

---

## Deferred / out of scope (flagged, not fixed here)

- **Prod alert-email + budget wiring** — the production activation (enabling the
  `production` environment secret and `PROD_DEPLOY_ENABLED`, plus prod-specific
  alert/budget values) is tracked under **MG-25**, not MG-24.
- **Key Vault vs plaintext Function-App connection strings** — the Functions
  module currently injects connection strings directly as app settings. Whether
  to route them through Key Vault references is a **human security review**
  decision, deliberately left open here.

---

## Troubleshooting

- **`Backend initialization required, please run "terraform init"`** after
  switching env — you skipped `-reconfigure`. Re-run Step 3 with it.
- **A second plan is not a NO-OP** — look for a non-deterministic value
  (a `timestamp()`, a `random_*` without keepers). `scripts/tf-static-checks.sh`
  catches `timestamp()` tag drift; run it locally:
  `apps/infrastructure/scripts/tf-static-checks.sh`.
- **`init` wants to migrate state** — you still have local state. Go back to
  Step 2 and delete it; never accept `-migrate-state`.
- **State lock stuck** — `terraform force-unlock <lock-id>` (verify no other
  apply is running first).

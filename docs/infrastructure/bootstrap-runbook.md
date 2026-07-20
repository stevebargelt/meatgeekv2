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

> **Export `ARM_SUBSCRIPTION_ID` before any Terraform command.** AzureRM
> **provider v4 requires an explicit subscription id** — selecting it with
> `az account set --subscription <id>` alone is **not** sufficient for
> `terraform init/plan/apply` (they read `ARM_SUBSCRIPTION_ID`, not the `az`
> CLI's active-subscription state). Set it once per shell:
>
> ```bash
> export ARM_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
> ```
>
> The same value is also what `scripts/state-account-name.sh` uses to derive the
> remote-state storage-account name (below), so exporting it up front makes the
> init command copy-pasteable.

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
   storage account, and **two per-environment containers**:

   | Resource        | Name                                                                          |
   | --------------- | ----------------------------------------------------------------------------- |
   | Resource group  | `meatgeek-v2-tfstate-rg`                                                      |
   | Storage account | derived — `meatgeekv2tf` + first 12 hex of `sha1(subscription-id)` (24 chars) |
   | dev container   | `tfstate-dev`                                                                 |
   | prod container  | `tfstate-prod`                                                                |

   The storage-account name is **not** a hardcoded literal — it is derived from
   the subscription id by the single sourced helper
   `scripts/state-account-name.sh`, so it is globally unique per subscription and
   identical everywhere it is used (bootstrap, CI, this runbook). It is
   **deliberately absent** from `backend-dev.hcl` / `backend-prod.hcl` (those
   files pin only `resource_group_name`, `container_name`, `key`,
   `use_azuread_auth`); the name is injected at `terraform init` as an extra
   `-backend-config` (see Step 3). dev and prod use **distinct containers**
   (`tfstate-dev` / `tfstate-prod`) so their state can never collide and each
   identity's state access is RBAC-scoped to its own container. The account is
   hardened (TLS 1.2 floor, no public blob access, HTTPS-only, blob versioning +
   30-day soft delete). The RG / storage location are overridable via
   `STATE_RG` / `STATE_LOCATION`. The state-account **name** is **not** an
   operator override — it is **derived** from the subscription id by the single
   sourced helper `scripts/state-account-name.sh` (the single source of truth),
   so the bootstrap, the `backend-*.hcl` init, and every workflow all resolve the
   **same** account and the single-derivation guarantee (item 9) cannot drift.
   Likewise **`STATE_CONTAINER` is not a supported override** — the
   per-environment container names (`tfstate-dev` / `tfstate-prod`) are fixed to
   match the committed `backend-*.hcl` files and the container-scoped RBAC grants.

2. **The GitHub Actions OIDC identities (two roles per environment)** — SEPARATE
   Azure AD applications + service principals, each with a **federated credential
   scoped per GitHub Environment**, **not** per branch. Because trust is bound to
   the GitHub Environment (and its protection rules), the dev CI identity can
   never mint a token accepted by the prod federated credential. **No client
   secret is ever created** — OIDC issues short-lived tokens at run time.

   MG-24 item 4 separates the two jobs a pipeline actually does — _plan_ and
   _publish_ — into **two least-privilege identities**, because they need
   different, non-overlapping permissions:

   - **Terraform PLAN / read identity** — `Reader` at subscription scope +
     `Storage Blob Data` on its **own state container only** (`tfstate-dev` /
     `tfstate-prod`). It can read every resource and read/lock its tfstate blob,
     but has **no** write/apply role. This is emitted as `AZURE_CLIENT_ID`. (It
     is a _plan/read_ identity — the earlier "deployment identity" label was a
     misnomer; a `Reader` cannot deploy anything.)
   - **APP DEPLOYMENT identity** — a **distinct** SP granted least-privilege
     publish (`Website Contributor`) scoped to **its Function App only**, plus
     `Storage Blob Data Reader` on the state container (to read the
     `function_app_name` output). A `Reader` **cannot** publish a Function App,
     which is exactly why this is a separate identity. Emitted as
     `AZURE_APP_DEPLOY_CLIENT_ID`; `app-deploy-prod.yml`'s func-publish
     `azure/login` uses it, not `AZURE_CLIENT_ID`.

     > **The `Website Contributor` role is created by Terraform, in the same
     > apply that creates the Function App** (MG-24 item 4). The Function App
     > only exists **after** the greenfield apply, so the bootstrap (which runs
     > **before** the apply) cannot grant a role on it — instead it **emits this
     > SP's OBJECT ID** as `AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID`. The operator
     > sets that value into `environments/dev.tfvars`
     > (`app_deploy_principal_object_id`) **before Step 4/6**, and the single
     > apply provisions the Function App **and** grants it `Website Contributor`
     > scoped to that Function App alone (root `azurerm_role_assignment`
     > `functions_app_deploy_publisher`, guarded by `count` on the var). That
     > makes the **automated/CI** publish path — `app-deploy-prod.yml` (and, when
     > MG-23 lands, the dev `app-deploy` workflow) authenticating **as this OIDC
     > SP** — work immediately, with **no** separate post-apply grant step and
     > **no** bootstrap re-run. This SP is **OIDC-only** (no client secret, no
     > local `az login`), so it is **not** used to publish from an operator's
     > machine — the manual MG-21 dev proof publishes as the operator's own dev
     > identity instead (Step 6a). Leaving the var empty still
     > validates/plans (the assignment is skipped); it is **required** for any
     > environment you deploy code to via CI. The bootstrap still grants this identity's
     > read-only `Storage Blob Data Reader` on the state container directly (that
     > container exists before the apply and is not Terraform-managed).

   > The **prod** app-deployment identity + its Function-App-scoped role
   > assignment are an **MG-25** deliverable and are out of scope for MG-24 —
   > flagged, not created here.

   **Canonical subject scheme (must not drift):**

   ```
   subject = repo:<owner>/<repo>:environment:<github-env>
   ```

   `<github-env>` is the EXACT `environment:` value the deploy job declares, so
   the credential the bootstrap creates equals the OIDC subject GitHub presents.
   The two environments and their (short) Terraform/state names:

   | GitHub Environment (workflow `environment:` + OIDC subject) | Federated subject                                      | tf env / state container |
   | ----------------------------------------------------------- | ------------------------------------------------------ | ------------------------ |
   | `development` (ci.yml `deploy-dev`)                         | `repo:stevebargelt/meatgeekv2:environment:development` | `dev` / `tfstate-dev`    |
   | `production` (infra-deploy-prod / app-deploy-prod)          | `repo:stevebargelt/meatgeekv2:environment:production`  | `prod` / `tfstate-prod`  |

   The full-word GitHub-Environment names (`development`, `production`) are what
   the workflows declare — a deploy job with `environment: development` presents
   the subject `…:environment:development`, so the bootstrap federates that exact
   subject (never a bare `…:environment:dev`, which would silently never match).
   A jest guard (`oidc-subject-consistency.spec.ts`, in CI) and the bootstrap
   tests (`bootstrap.test.sh`) assert this alignment so it cannot drift.

   The CI **plan/read** identity is granted least-privilege **`Reader`** at
   subscription scope plus a **`Storage Blob Data` role on its own state
   container only** (`tfstate-dev` / `tfstate-prod`) — **container-scoped, not
   account-scoped** (so a dev plan identity cannot read prod state, and neither
   can read anything else in the account). It has **no** write or apply role — an
   accidental CI apply fails closed. Publishing is the separate
   `AZURE_APP_DEPLOY_CLIENT_ID` identity's job (above).

A **V1-safety guard** (`assert_v2_name`) refuses to operate on any name that is
not unambiguously `meatgeek-v2` / `meatgeekv2`, and explicitly rejects the known
V1 identifiers (`meatgeek-shared`, `meatgeekterraformstate`). This is the last
line of defense against a mistyped override pointing the bootstrap at V1.

### Wire the OIDC coordinates into GitHub

The script prints the non-secret coordinates to register as **GitHub
Environment** variables/secrets (one set per environment — the GitHub
Environments named `development` and `production`):

```
AZURE_CLIENT_ID             = <plan/read appId>
AZURE_APP_DEPLOY_CLIENT_ID  = <app-deployment appId>   # distinct SP; CI/OIDC func-publish only
AZURE_TENANT_ID             = <tenantId>
AZURE_SUBSCRIPTION_ID       = <subscriptionId>
```

These are identifiers, not secrets. The prod-activation wiring (enabling the
`production` environment secret + `PROD_DEPLOY_ENABLED`, and the **prod**
app-deployment identity) is tracked under **MG-25** and is out of scope for
MG-24.

### Wire the app-deploy SP object id into `dev.tfvars` (publish role)

The bootstrap also prints the app-deployment identity's **service principal
OBJECT ID** (distinct from its `appId`/client id above):

```
AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID = <app-deploy SP object id>
```

Set it in `environments/dev.tfvars` **before Step 4 (plan) / Step 6 (apply)**:

```hcl
app_deploy_principal_object_id = "<AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID>"
```

This is what lets the **single** greenfield apply create the Function App **and**
grant that identity `Website Contributor` scoped to the Function App alone, so
`func publish` works immediately after Step 6 — no post-apply grant, no bootstrap
re-run. Leaving it empty still validates and plans (the role assignment is
skipped via `count`), but the resulting Function App has nothing that can publish
to it, so it is **required** for a deployable dev environment. It is an
identifier, not a secret.

### Dev app / API authentication registration (item 3)

To unblock the MG-21 **authenticated** smoke test, the bootstrap also provisions
a **separate dev Entra API auth registration** — distinct from the OIDC
plan/deploy apps above (do **not** reuse the deployment OIDC registration as the
app's user/API identity). It exposes the delegated scope `access_as_user`,
pre-authorizes the **calling** smoke-test client(s), lives in the single dev
tenant, and has **no client secret**. The script prints its coordinates:

```
DEV_API_CLIENT_ID   = <api appId>
DEV_API_TENANT_ID   = <tenantId>
DEV_API_APP_ID_URI  = api://<api appId>   # the audience Easy Auth validates
functions_auth_allowed_client_app_ids = [<calling client(s)>]   # allowed_applications
```

`DEV_API_APP_ID_URI` is the value the Step 6a token-acquisition scope needs. It is
**not** a Terraform output — the dev API registration is created by `bootstrap.sh`
(Azure CLI), not by Terraform — so for an already-bootstrapped environment
re-derive it directly from the registration rather than re-running the bootstrap:

```bash
az ad app show --id <DEV_API_CLIENT_ID> --query 'identifierUris[0]' -o tsv
#   → api://<DEV_API_CLIENT_ID>
```

Populate `functions_auth_client_id` / `functions_auth_tenant_id` /
`functions_auth_allowed_audiences` in `environments/dev.tfvars` with these
values post-bootstrap so Easy Auth activates a **real** Entra identity provider
(until then the Function App stays default-deny). The operator
token-acquisition + authenticated-invocation procedure is in **Step 6a** below.

**Caller vs. callee — the corrected `allowed_applications` model (item 1).**
Easy Auth pins two DIFFERENT things:

- `client_id` + `allowed_audiences` identify the **API registration** (the
  callee) — the App ID URI a valid token's `aud` must match.
- `allowed_applications` validates the **CALLING client's** `appid`/`azp` claim —
  i.e. *which app minted the token*, never the API.

For the operator token flow below,
`az account get-access-token --scope "<App ID URI>/access_as_user"`, the caller
is the **Azure CLI public client** `04b07795-8ddb-461a-bbee-02f9e1bf7b46`. So
`functions_auth_allowed_client_app_ids` **defaults to that client** (override with
a dedicated dev client's app id), and the bootstrap **pre-authorizes** exactly
those client id(s) for `access_as_user` (`SMOKE_TEST_CLIENT_IDS` →
`preAuthorizedApplications`) so acquisition needs no consent prompt. A token
minted by **any other client** — even with the correct audience — is **rejected**
by `allowed_applications`. Keep the tfvars list and `SMOKE_TEST_CLIENT_IDS` in
sync: the allowed caller and the pre-authorized caller must be the same set.

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

> **No `terraform.tfstate` is tracked or present in the repo** — the tree is
> clean of local state, and `tf-static-checks.sh` check 5 fails CI on **any**
> `*.tfstate` on disk (tracked, untracked, or git-ignored). This step is a
> defensive pre-init hygiene step: if a prior local run left an on-disk state
> file, it is V1-bound and must be removed **before** the first init so it can
> never reach the V2 remote backend. There is no committed legacy state to
> delete.

### Step 3 — Clean init against the per-environment remote backend

The state-account name is **not** in `backend-dev.hcl`; derive it from the
subscription id and inject it as an extra `-backend-config` (single source of
truth: `scripts/state-account-name.sh`). `ARM_SUBSCRIPTION_ID` must already be
exported (see Prerequisites):

```bash
terraform init -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
```

- **Never add `-migrate-state`.** A clean init binds the empty
  `meatgeek-v2/dev.tfstate` key (in the `tfstate-dev` container) with no
  migration of local state.
- `-reconfigure` is required when switching environments (dev ↔ prod) so the
  backend is re-bound to the new state key/container rather than reusing a
  cached one.
- The injected `storage_account_name` matches the account the bootstrap created
  from the **same** derivation, so init can never bind a divergent account name.
- **Do not substitute `nx init infrastructure --env=dev` here.** The Nx `init`
  wrapper runs `terraform init -reconfigure -backend-config=environments/backend-dev.hcl`
  **without** the derived `storage_account_name`, so it cannot bind the remote
  backend on its own — run the `terraform init` above (both `-backend-config`
  flags) directly. Once the backend is bound, `nx plan` / `nx apply` operate
  against it normally.

### Step 4 — Plan the complete stack

> **First set `app_deploy_principal_object_id` in `environments/dev.tfvars`**
> (the bootstrap-emitted `AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID` — see "Wire the
> app-deploy SP object id into `dev.tfvars`" above). With it set, this plan
> includes the `Website Contributor` role assignment on the Function App, so the
> single apply below leaves the app immediately publishable. Left empty the plan
> still succeeds (the assignment is skipped) but the resulting app cannot be
> published to.

```bash
terraform plan -var-file=environments/dev.tfvars -out=tfplan \
  | tee /tmp/mg24-evidence/dev-plan-1.txt
```

The plan must propose the **complete** V2 dev stack — resource group,
Log Analytics + Application Insights, IoT Hub, the **V2-owned** Cosmos account
(not the V1 shared account), Azure Functions (including the Function App
`meatgeek-v2-dev-func`), SignalR, and monitoring. With
`app_deploy_principal_object_id` set, it also includes the app-deploy identity's
`Website Contributor` role assignment scoped to that Function App. Nothing should
reference V1.

### Step 5 — Human plan review

A human reviews the plan for **scope** (only expected V2 resources), **security**
(no V1 adoption, no hardcoded subscription id, connection strings handled
sanely), and **cost** (SKUs/throughput/retention match `dev.tfvars`). Do not
apply without this review.

### Step 5a — REQUIRED fail-closed secret inspection (pre-apply gate)

**This is a hard gate — do NOT apply until it exits 0.** Before any apply, run
the fail-closed plan/state inspection over the **binary plan** produced in
Step 4. It parses `terraform show -json`, walks every resource across the root
and all child modules plus every root output, and **EXITS NONZERO** if any
prohibited credential VALUE reached a Function App `app_setting` or an output
(connection string / SAS / account|access|primary key / a bare instrumentation
key). It allows **only** the one operator-accepted App Insights residual — the
full AI connection string in an `app_setting`, and **only** when the plan's
`azurerm_application_insights` sets `local_authentication_disabled = true` (the
coupled invariant). It also fails closed on any operational failure (no `jq`,
unparseable JSON, no input) — an inspection that cannot run must not report
success.

```bash
scripts/tf-plan-secret-inspection.sh tfplan \
  | tee /tmp/mg24-evidence/dev-secret-inspection-plan.txt
echo "inspection exit: ${PIPESTATUS[0]}"   # MUST be 0 before proceeding
#   equivalently:  terraform show -json tfplan | scripts/tf-plan-secret-inspection.sh
```

The gate unions every sink across `.planned_values`, `.resource_changes[].change.after`
(the per-resource plan deltas — where a **computed / known-after-config** secret
VALUE can first appear, which a `planned_values`-only scan would miss), and outputs.

**Run it TWICE — plan AND post-apply state (REQUIRED).** A pre-apply plan cannot
inspect `after_unknown` values (unknown until apply), so those are a blind spot at
plan time. After the apply (Step 6) re-run the SAME gate against the concrete
`terraform show -json` STATE, where every value is materialized:

```bash
# Post-apply (after Step 6): inspect the real STATE — after_unknown is now concrete.
terraform show -json | scripts/tf-plan-secret-inspection.sh \
  | tee /tmp/mg24-evidence/dev-secret-inspection-state.txt
echo "state inspection exit: ${PIPESTATUS[0]}"   # MUST also be 0
```

Both runs **must exit 0**. This **replaces** the old always-green README one-liner
(a `terraform show -json` result fed into `grep` and neutralized with a trailing
`or-echo` — which swallowed its own failure and could never block an apply). If
either inspection reports a violation, **stop**: a runtime credential is
materializing into state. The same gate runs in CI via `tf-static-checks.sh`
check 12, which fails the build if this runbook/README stops documenting it as the
required pre-apply step.

### Step 6 — Apply (operator-run, never CI)

```bash
terraform apply tfplan | tee /tmp/mg24-evidence/dev-apply.txt
```

Apply must successfully **create** the complete V2 dev infrastructure, including
the Function App. Confirm the Function App name equals the Terraform output —
this is the single source of truth the deploy consumes:

```bash
terraform output -raw function_app_name   # → meatgeek-v2-dev-func-<suffix>
```

The Function App name now carries the global-uniqueness suffix (item 9); it is
still the single source of truth the app deploy consumes.

Because `app_deploy_principal_object_id` was set (Step 4), this **same** apply
also granted the app-deployment identity `Website Contributor` on that Function
App. This is the **automated/CI publish path** — the OIDC
`AZURE_APP_DEPLOY_CLIENT_ID` SP that `app-deploy-prod.yml` (and, when MG-23 lands,
the dev `app-deploy` workflow) uses to `nx deploy api` / `func publish`. That SP
is **OIDC-only** (no client secret, no local `az login`), so you do **not**
publish as it from your machine — the manual MG-21 dev proof publishes as your own
dev identity (Step 6a). Confirm the CI-path assignment exists:

```bash
FUNC_ID="$(terraform state show module.azure_functions.azurerm_linux_function_app.main | awk '/^ *id /{print $3; exit}')"
az role assignment list --scope "$FUNC_ID" \
  --query "[?roleDefinitionName=='Website Contributor'].principalId" -o tsv
#   → the app-deploy SP object id (== app_deploy_principal_object_id)
```

### Step 6a — Publish the app, then run the authenticated smoke test (unblocks MG-21)

The MG-21 dev integration proof has two parts, **both run manually by the operator
using the operator's own authenticated dev session** — *not* the app-deploy OIDC
service principal: first **publish** the packaged Functions artifact to the dev
Function App, then run an **authenticated smoke test** against it.

> **Why not the app-deploy SP?** The `AZURE_APP_DEPLOY_CLIENT_ID` identity is
> **OIDC-only** — it has **no client secret and no local `az login` path**, so
> there is no way to run `func publish` / `nx deploy api` **as it** from a local
> machine. It is the **automated/CI** publish identity (exercised for real when
> MG-23's dev `app-deploy` workflow lands); the `Website Contributor` grant
> confirmed in Step 6 is what enables **that** path. Do **not** try to "publish as
> the app-deploy SP" locally — the manual proof publishes as **you**.

**Publish as your own dev identity.** You are already `az login`-ed as your dev
identity from the bootstrap/apply. That identity needs publish rights on the dev
Function App — either you already have them (e.g. Contributor/Owner on the dev
resource group), **or** temporarily assign yourself `Website Contributor` scoped
to the dev Function App:

```bash
FUNC="$(terraform output -raw function_app_name)"
FUNC_ID="$(terraform state show module.azure_functions.azurerm_linux_function_app.main | awk '/^ *id /{print $3; exit}')"

# Only if you don't already have publish rights on the dev FA:
ME="$(az ad signed-in-user show --query id -o tsv)"
az role assignment create --assignee-object-id "$ME" \
  --assignee-principal-type User \
  --role "Website Contributor" --scope "$FUNC_ID"
```

Then publish the packaged artifact to the dev Function App **as yourself**:

```bash
# Build + publish the API package — the Nx target CI runs, invoked locally under
# your own dev session (NOT the app-deploy OIDC SP):
npx nx deploy api --functionApp="$FUNC"
#   … or the raw Core Tools publish against the built package:
#   func azure functionapp publish "$FUNC"
```

This proves the packaged artifact deploys to the MG-24-created dev Function App.
Capture the publish output as evidence.

**Then run the authenticated smoke test.** The Function App is **default-deny**
with Easy Auth bound to the dev Entra API registration (Step "Dev app / API
authentication registration"). Once `environments/dev.tfvars` carries the
`functions_auth_*` values and the apply has activated the provider, acquire a
delegated user token for the API's audience — with the **same** dev session — and
invoke the app. **Never log or paste the raw token** — capture only the HTTP
status.

```bash
FUNC="$(terraform output -raw function_app_name)"

# The dev API App ID URI is the audience Easy Auth validates. It is emitted by
# the bootstrap as DEV_API_APP_ID_URI, but the dev API registration is NOT
# Terraform-managed (it is created by bootstrap.sh via the Azure CLI), so there
# is NO `terraform output` for it. Re-derive it straight from the registration —
# no bootstrap re-run, no hand-typed placeholder:
API_APP_ID="$(az ad app list --display-name meatgeek-v2-dev-api --query '[0].appId' -o tsv)"
APP_ID_URI="$(az ad app show --id "$API_APP_ID" --query 'identifierUris[0]' -o tsv)"
#   → api://<DEV_API_CLIENT_ID>  (equals the emitted DEV_API_APP_ID_URI)

# 1. No token → MUST be rejected (default-deny proven). `/api/devices` is a real,
#    idempotent GET route (function getDevices in apps/api/src/main.ts); there is
#    NO health endpoint and no anonymous carve-out, so an unauthenticated call is
#    rejected at the platform layer before the function runs:
curl -s -o /dev/null -w '%{http_code}\n' "https://${FUNC}.azurewebsites.net/api/devices"
#   → 401/403

# 2. Acquire a delegated user token for the API audience (interactive az user):
TOKEN="$(az account get-access-token \
  --scope "$APP_ID_URI/access_as_user" \
  --query accessToken -o tsv)"

# 3. Valid token, correct audience → MUST be 2xx:
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${FUNC}.azurewebsites.net/api/devices"
#   → 200

# 4. Wrong audience → MUST be rejected (401/403). Acquire a token for a DIFFERENT
#    scope (e.g. ARM) and confirm Easy Auth rejects it:
WRONG="$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer ${WRONG}" \
  "https://${FUNC}.azurewebsites.net/api/devices"
#   → 401/403
```

Capture the three status codes (no-token 401, valid-token 2xx, wrong-audience
rejected) — plus the Function **invocation log** entry for the authenticated call
(e.g. `az webapp log tail --name "$FUNC" --resource-group meatgeek-v2-dev-rg`, or
the invocation from the portal/Application Insights) — as the MG-21
authenticated-smoke evidence — **redact the token from every log**. Actual token acquisition and invocation require the live dev tenant,
the populated `functions_auth_*` values, and a deployed app, so this step is
**static-validated, operationally-unverified (operator live run)**.

> **Wrong CALLING CLIENT is also rejected (item 1).** `allowed_applications`
> validates the token's `appid`/`azp` (the caller), so a token minted by a client
> NOT in `functions_auth_allowed_client_app_ids` — even with the correct
> `access_as_user` audience — is rejected at the platform layer. Step 3 succeeds
> only because the Azure CLI public client
> (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) is both allowed and pre-authorized. To
> demonstrate caller-pinning, acquire the same-scope token from a client that is
> NOT in the allowlist (e.g. a second app registration) and confirm a 401/403.

### Step 7 — Second plan is a NO-OP

```bash
terraform plan -var-file=environments/dev.tfvars \
  | tee /tmp/mg24-evidence/dev-plan-2-noop.txt
```

This **must** report `No changes. Your infrastructure matches the
configuration.` A non-empty second plan means non-deterministic config (e.g.
`timestamp()`-driven drift) — investigate before continuing. The known cause was
the monitoring module's budget `start_date`, which used
`formatdate("YYYY-MM-01…", timestamp())` and silently recomputed to the current
month on every plan — so a second plan **across a month boundary** was not a
no-op. That is fixed (MG-24 item 7): the start date is now anchored to a
persisted `time_static` resource, fixed at first apply. `tf-static-checks.sh`
check 2 fails CI on **any** `timestamp()` call (including wrapped in
`formatdate()`), so the drift cannot creep back. The cross-month no-op holds by
construction; the live proof is **operationally-unverified (operator live run)**.

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

- The **state key** in use (`meatgeek-v2/dev.tfstate`), the **container**
  (`tfstate-dev`), and the state account — the **subscription-derived** name
  `scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID"` (RG
  `meatgeek-v2-tfstate-rg`).
- The **plan/apply logs** captured above (`/tmp/mg24-evidence/*.txt`).
- The **MG-21 dev proof** evidence from Step 6a: the operator-run publish output
  and the authenticated-smoke result (no-token 401, valid-token 2xx,
  wrong-audience rejected, plus the invocation log) — token redacted.
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
  the prod remote state (`terraform init -reconfigure -backend-config=environments/backend-prod.hcl`
  plus `-backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"`),
  runs under the `production` GitHub Environment gate, and **ends at
  `terraform plan`** — there is **no** `apply` in CI.

Never add auto-apply to CI. Apply stays an operator action per this runbook.

---

## Deferred / out of scope (flagged, not fixed here)

- **Prod alert-email + budget wiring** — the production activation (enabling the
  `production` environment secret and `PROD_DEPLOY_ENABLED`, plus prod-specific
  alert/budget values) is tracked under **MG-25**, not MG-24.
- **Prod app-deployment identity** — the prod counterpart of the dev
  `AZURE_APP_DEPLOY_CLIENT_ID` identity (a distinct SP) is an **MG-25**
  deliverable, out of scope for MG-24. The role-assignment **mechanism** is
  already environment-agnostic: once that identity exists, MG-25 sets
  `app_deploy_principal_object_id` in `prod.tfvars` and the prod apply grants it
  `Website Contributor` scoped to the prod Function App via the same guarded
  `functions_app_deploy_publisher` assignment — no new Terraform is needed.
- **Function-App runtime credentials** — resolved by MG-24: the Functions
  module accesses Cosmos, host Storage, the IoT-telemetry Event Hub, and
  SignalR **identity-based** (system-assigned managed identity + RBAC over
  non-secret endpoints), so no connection strings or primary keys land in
  `app_settings` or Terraform outputs. The former "route plaintext secrets
  through Key Vault references" question is therefore moot — there are no
  such secrets to route. Application Insights is wired via the **full**
  TF-managed connection string (InstrumentationKey included — Microsoft requires
  it as the destination-resource identifier even under Entra), but the embedded
  ikey **cannot authenticate**: `local_authentication_disabled = true` on the
  App Insights resource forces AAD-only ingestion (`Monitoring Metrics
Publisher` + `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD`).
  The connection string is a **present-but-non-authenticating** residual, safe
  ONLY while local auth is disabled — a coupled invariant enforced by
  `tf-static-checks.sh` check 9 and the fail-closed
  `scripts/tf-plan-secret-inspection.sh` gate. See the
  [ADR](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md).

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

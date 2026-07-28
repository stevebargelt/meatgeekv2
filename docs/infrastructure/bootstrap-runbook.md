# MeatGeek V2 Infrastructure — Bootstrap & Greenfield Acceptance Runbook

> **Scope (MG-24).** MeatGeek **V2 is greenfield** — there is no V2 Azure
> infrastructure and no V2 Terraform state to recover. `meatgeek-dev-rg` was
> deliberately deleted. Every remaining MeatGeek Azure resource belongs to the
> legacy **V1** system and is **out of scope**: never import, adopt, modify,
> rename, or delete a V1 resource. This runbook takes an operator from an empty
> subscription to a fully-created V2 environment, then reconciles incrementally.

This is the authoritative procedure for two operator-run activities that live
**outside** the CI pipeline:

1. The **run-once bootstrap** — stand up remote state + the OIDC identities that
   everything else depends on.
2. The **greenfield DEV plan/apply proof** (MG-24's 10-step acceptance) — create
   the complete V2 dev stack from empty state and capture the evidence.

> **Where the steady-state apply lives (read this before applying by hand).**
> This runbook is the **first-creation and recovery** path, not the day-to-day
> one. Once the dev stack exists, **dev infrastructure reconciles through CI**:
> **MG-23** (*automated dev GitOps reconciliation*, CI-run) validates every
> infrastructure PR **credentiallessly** in `ci.yml`'s `validate-infrastructure`
> job — no Azure identity, no GitHub Environment, no remote state — and applies
> automatically on merge to `main` via
> `.github/workflows/infra-apply-dev.yml`. Do **not** run
> a steady-state dev apply from a workstation — you would be racing CI, and the
> next CI run's drift plan will fail on whatever you left behind. **MG-24**
> (*Terraform reconciliation*, operator-run) is what this runbook proves, and it
> remains the path for the greenfield creation below, for prod (until **MG-25**
> activates CI-run prod reconciliation), and for recovery.
>
> Bootstrap, creation of `meatgeek-v2-dev-rg` itself, subscription-scoped
> configuration and disaster recovery stay **operator** actions in every
> environment. Activation of the dev GitOps loop — including its blocking
> pre-activation checks and the live acceptance tests — is in
> **[MG-23 live acceptance & activation](./mg23-live-acceptance.md)**.

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

## Function App hosting — Flex Consumption (MG-24, 2026-07-23)

The Function App runs on **Azure Functions Flex Consumption**, a **single**
hosting model for **both** dev and prod. This **supersedes** the inherited
Y1(dev)/EP1(prod) split (operator-directed hosting revision, 2026-07-23). Flex is
viable on the pinned `azurerm` v4.81.0 — **no** provider upgrade — and resolves
the Y1 MI-storage apply failure because Flex deploys from an **MI-authenticated
BLOB container**, not an Azure Files content share that requires a shared key.
The full decision record is the
[Flex Consumption ADR](../../learnings/decisions/mg-24-flex-consumption-hosting-model.md).

What this changes for an operator:

- **Region is `West US 2`** (a Flex-supported region), set via `var.location` in
  both `environments/dev.tfvars` and `environments/prod.tfvars`.
  > **⚠ `location` relocates the WHOLE stack, not just the Function App.**
  > `var.location` fans out `var.location → local.location →
azurerm_resource_group.main.location` and every module reads the RG location,
  > so changing it destroys **and recreates the entire V2 stack** — Cosmos, IoT
  > Hub, SignalR, App Insights, Log Analytics, storage — **with Cosmos DATA
  > LOSS**. On an already-applied environment this is **not** an in-place move:
  > it is an **operator-gated destroy+recreate that requires a Cosmos-migration
  > plan** before the live re-apply. The greenfield proof below starts from empty
  > state, so there is nothing to migrate on first create; the caveat matters for
  > any environment that already holds data.
  >
  > **There is NO destroy guard in the shared modules — by design.** Do not read
  > the caveat above as "prod is protected." A location change is `ForceNew` on
  > Cosmos (and IoT Hub), and the modules deliberately set **no**
  > `prevent_destroy` / destroy guard: `prevent_destroy` is a static literal that
  > cannot be env-gated (dev must stay freely re-creatable), and MG-24 is
  > greenfield with no data to protect yet. The only protection at the live
  > re-apply is the **operator human gate** (plan review + this runbook's
  > Cosmos-migration step) — not any code guard. **Real prod data-loss protection
  > (`prevent_destroy` / backup policy / approval gate for the prod Cosmos + IoT
  > Hub) is tracked in MG-35**, not delivered here.
- **Runtime is Node 24** (`runtime_name = "node"`, `runtime_version = "24"`) —
  matches the API's `engines.node` and the CI `NODE_VERSION`.
- **A service plan is still present — SKU `FC1`, not `Y1`/`EP1`.** Flex requires a
  plan (`azurerm_function_app_flex_consumption.service_plan_id` is a required
  argument on the pinned provider), so `azurerm_service_plan.functions` is
  **retained and repurposed to the Flex `FC1` SKU** — it is **not** removed. There
  is no standalone `Y1`/`EP1` consumption/premium plan anymore; billing is the
  per-execution GB-s / always-ready model below.
- **The plan change forces destroy+recreate of the Function App resources.**
  There is **no in-place migration** from the old plan/region to Flex — the
  operator handles the destroy+recreate at the live re-apply (out of scope for
  the deterministic pipeline that lands this code).
- **Deployment is Flex OneDeploy to the MI blob container** — `func azure
functionapp publish` / `nx deploy api` (via azure-functions-core-tools) writes
  the package ZIP to the **`deployment-package` blob container** on the functions
  storage account, authenticated by managed identity. There is **NO** Kudu
  zip-deploy, **NO** `WEBSITE_RUN_FROM_PACKAGE`, and **NO** Azure Files content
  share (the Flex-deprecated `WEBSITE_NODE_DEFAULT_VERSION` / `WEBSITE_CONTENT*` /
  `WEBSITE_TIME_ZONE` settings are pruned). `function_app_name` (Terraform
  output, carrying the global-uniqueness suffix) **stays the single source of
  truth** the deploy consumes — unchanged by the hosting move.

### Storage identities on the one functions account

The functions storage account is created via **azapi over the ARM control plane**
(`Microsoft.Storage/storageAccounts`) and keeps shared key disabled via the azapi
body's **`allowSharedKeyAccess = false`** — Flex does not need a shared key, so the
no-shared-key posture (MG-24 point 5) is preserved. Three DISTINCT principals touch
the deployment blob container, each least-privilege:

- **Function App managed identity** — reads the deployment package at runtime.
  Terraform grants it `Storage Blob Data Owner` + `Storage Queue Data Contributor`
  on the functions storage account (same apply that creates the app).
- **App-deploy principal** (`var.app_deploy_principal_object_id`) — **writes** the
  package ZIP during Flex OneDeploy. Terraform grants it a **`Storage Blob Data
Contributor` role on the `deployment-package` container** (in ADDITION to its
  `Website Contributor` on the Function App), guarded by `count` on the var so a
  bare `validate`/plan with an empty var still validates.
- **Apply/CI principal** — CREATES **both** the storage **account**
  (`Microsoft.Storage/storageAccounts`) **and** the `deployment-package` container
  (`Microsoft.Storage/.../blobServices/containers`) over the ARM **control plane**
  (the module uses `azapi_resource` for both, not `azurerm_storage_account` /
  `azurerm_storage_container`). It needs only its existing **resource-management**
  role (Contributor on the RG) — **NO storage data-plane role and NO pre-apply
  grant**. The provider does **not** set `storage_use_azuread` (MG-24 reds 2f5154 /
  b08ced, then the live-apply 403): the `azurerm_storage_account` resource performs
  its OWN key-auth storage **data-plane** reads that **403** on a shared-key-disabled
  account with `storage_use_azuread` unset, and a data-plane container create against
  an account **this same apply creates** would be a chicken-and-egg 403; creating
  both the account and the container over the control plane sidesteps every storage
  data-plane op, so the **first Flex apply is executable with no manual pre-grant**.

### Cost expectations (Flex billing)

- **dev — scale-to-zero.** `always_ready = 0`, so idle cost is **~$0** (no
  always-ready instances; you pay only per-execution GB-s). Comfortably inside the
  **$50 dev RG budget**.
- **prod — always-ready baseline.** `always_ready ≥ 1` keeps a warm HTTP instance
  so the first request after idle is not cold. The always-ready baseline GB-s is
  **materially below the EP1 floor** the old split billed 24/7, while still paying
  per-execution GB-s above the warm baseline.

---

## Prerequisites

- **Terraform** ≥ 1.9
- **Azure CLI** (`az`), authenticated as a subscription **Owner** /
  **User Access Administrator** for the bootstrap (it creates an AAD app,
  a role assignment, and storage). Day-to-day plan/apply needs less.
- **GitHub CLI** (`gh`), installed **and** authenticated — run `gh auth login`
  *before* `./bootstrap.sh`. Authentication is now a **hard precondition**, not
  a nicety: bootstrap reads the repository's live OIDC sub-claim customization
  before it provisions anything, and aborts if it cannot. See
  [Preconditions that abort before anything is provisioned](#preconditions-that-abort-before-anything-is-provisioned).
- **`jq`**, and a **sha1** tool: `sha1sum` on Linux, `shasum` on macOS.
  Bootstrap accepts **either** and derives the **same** scope id from both, so a
  Linux and a macOS operator re-running bootstrap do not mint duplicate
  delegated-permission scopes.
- **`mktemp`** and the coreutils bootstrap uses: `awk`, `sed`, `sort`, `tr`,
  `cut`, `grep`, `wc`, `paste`, `rm`.
- The V2 Azure **subscription id** (obtained from `az account show`, never
  hardcoded in Terraform).
- Repo checked out; `apps/infrastructure` is the Terraform root.

> **Bootstrap fails fast on a missing tool, before mutating anything.**
> `require_tools` is the first statement in `main()` and checks **every** command
> above in one pass, reporting **all** missing tools together rather than one
> re-run at a time. This matters because the tools are not all used up front: the
> sha1 tool, for example, is first needed by the dev API registration, which runs
> *after* every RBAC grant and *before* the deployment environments are created.
> Discovering it missing there would abort the run exactly mid-mutation — every
> grant live, zero protected environments. macOS is the case that actually bites,
> since it ships `shasum` but **not** `sha1sum`.

> **Bootstrap now EXITS NON-ZERO unless both deployment environments verify as
> `PROTECTED`.** `development-infra-apply` and
> `development-infra-apply-recovery` are checked at the end of the run, and the
> `Bootstrap complete` line is printed **only after** that check passes — so a
> **green bootstrap is the signal that activation is safe**, rather than
> something a reader has to notice the absence of. **Do not set
> `DEV_TF_BACKEND_READY` true until bootstrap exits zero.** See
> [MG-23 live acceptance](mg23-live-acceptance.md).

### Preconditions that abort before anything is provisioned

Every federated subject is composed from the repository's **live** sub-claim
prefix (MG-42), and `resolve_oidc_subject_prefix()` runs in `main()` **before**
the state backend or any identity is created. So each failure below aborts with
**nothing provisioned and nothing rewritten** — a re-run after remediation is a
clean first run, not a resumption. The four abort classes are distinct and their
remediations are *different*; matching the message to the right one matters,
because chasing the wrong cause here is how the credentials end up
hand-"corrected" into the broken form.

| Abort | What bootstrap saw | Remediation |
| ----- | ------------------ | ----------- |
| **`gh` not authenticated** | `gh auth status` fails. Previously only the *binary* had to exist; an unauthenticated `gh` 404s on a private repo's endpoints exactly like a repo with no customization, so it would have been read as "use the default prefix" and rewritten every credential. | `gh auth login`, then re-run. |
| **GitHub API failure** — 403, 429/rate limit, 5xx, DNS, proxy | The response status line was something **other** than an exact `404` — or there was no parseable status line at all (a proxy that swallowed the response, a DNS failure), which is no authoritative status for the request and is read the same way. The response says nothing about the repo's configuration, so falling back to the default prefix would be a guess that rewrites live trust. | **Retry / check GitHub status.** This is *not* an auth problem — `gh auth login` will not fix it, and running it here wastes the outage window. |
| **Customization unreadable** — `use_default: false` with no readable prefix, an empty body, or an unparseable one | GitHub returned 200 but the answer cannot be used: it positively states a customization exists (`use_default: false`) while carrying no usable `sub_claim_prefix`, or the body is empty, or it is not parseable JSON. Epistemically identical to a 403/5xx — unreadable, not absent. | Same class as above — re-read the customization (`gh api …/oidc/customization/sub`) and resolve why the prefix is missing or malformed. Do **not** fall back to the default. |
| **Trust-root mismatch** | The resolved prefix does not name `stevebargelt/meatgeekv2` (after stripping GitHub's optional `@<digits>` owner-id/repo-id). Every identity — including the dev infra-apply one holding `Contributor` on the dev RG — would be federated to another repository's workflows. | A **reviewed edit to `GITHUB_REPO`** in `bootstrap.sh`, in a commit. If you forked the repo, that is the change to make; there is no environment-variable override and there is deliberately no workaround. |

Only one non-200 answer is read as a *fact* rather than an outage: **an exact
`404`**, which is GitHub's "no sub-claim customization is configured". Bootstrap
then warns and federates the default `repo:<owner>/<repo>` prefix. Two things
make that safe to trust. The auth gate above rules out the other common meaning
of a 404 on a private repo. And the status is taken from the **response status
line** — bootstrap calls `gh api -i` and matches the first line anchored — not
from `gh`'s exit code or a substring of its stderr: a proxy error page or an
unrelated nested 404 can both *contain* the text `HTTP 404` while saying nothing
about this endpoint, and reading one as the fallback signal is what deletes and
recreates three live credentials on a subject no token carries. **If you check
the customization by hand, discriminate the 404 the same way** — the procedure
is [B10](mg23-live-acceptance.md#b10--do-the-live-federated-subjects-match-the-prefix-the-repo-actually-presents).

> **An unauthenticated `gh` no longer gets as far as the Azure work.** Earlier
> revisions of this runbook said the Azure side still completed and only the
> environment protection was left `UNVERIFIED`; that is no longer true, because
> the sub-claim read happens first. The environments' `UNVERIFIED` path still
> exists for a `gh` that stops working part-way through a run, and bootstrap
> then prints the manual `gh api` procedure — but the ordinary
> "forgot to log in" case now aborts up front with nothing changed.

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

   - **Terraform PLAN / read identity — PROD ONLY under MG-23** — `Reader` at
     subscription scope + **`Storage Blob Data Reader`** on its **own state
     container only** (`tfstate-prod`). It can read every resource and read its
     tfstate blob, but has **no** write/apply role. This is emitted as
     `AZURE_CLIENT_ID`, scoped to the `production` GitHub Environment. (It is a
     _plan/read_ identity — the earlier "deployment identity" label was a
     misnomer; a `Reader` cannot deploy anything.) **The dev half of this
     identity is gone**: MG-23 made dev PR validation credentialless, so nothing
     reachable from a pull request reads `tfstate-dev`.
   - **APP DEPLOYMENT identity** — a **distinct** SP granted least-privilege
     publish (`Website Contributor`) scoped to **its Function App only**, plus a
     **`Storage Blob Data Contributor` on the Flex `deployment-package`
     container** (Flex OneDeploy writes the package ZIP there — see the Flex
     hosting-model section), plus `Storage Blob Data Reader` on the state
     container (to read the `function_app_name` output). A `Reader` **cannot**
     publish a Function App, which is exactly why this is a separate identity.
     Emitted as `AZURE_APP_DEPLOY_CLIENT_ID`; `app-deploy-prod.yml`'s
     func-publish `azure/login` uses it, not `AZURE_CLIENT_ID`.

     > **The `Website Contributor` role is created by Terraform, in the same
     > apply that creates the Function App** (MG-24 item 4). The Function App
     > only exists **after** the greenfield apply, so the bootstrap (which runs
     > **before** the apply) cannot grant a role on it — instead it **emits this
     > SP's OBJECT ID** as `AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID`. The operator
     > sets that value into `environments/dev.tfvars`
     > (`app_deploy_principal_object_id`) **before Step 4/6**, and the single
     > apply provisions the Function App **and** grants it `Website Contributor`
     > scoped to that Function App alone (root `azurerm_role_assignment`
     > `functions_app_deploy_publisher`, guarded by `count` on the var) **and** —
     > for Flex OneDeploy — grants it `Storage Blob Data Contributor` on the
     > `deployment-package` blob container (module `azurerm_role_assignment`
     > `deploy_principal_deployment_container`, same `count`/var guard) so it can
     > write the package ZIP the Flex runtime then reads. That
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
   subject = <the repository's live sub-claim prefix>:environment:<github-env>
   ```

   **The `repo:…` head is not a constant (MG-42).** This account's GitHub org
   customizes the OIDC `sub` claim to inject the numeric owner-id and repo-id,
   so the prefix is a **fact about the repository, read at run time** —
   `resolve_oidc_subject_prefix()` fetches it before anything is provisioned and
   `federated_environment_subject()` composes every subject from it. Read the
   current value the same way the script does:

   ```bash
   gh api repos/stevebargelt/meatgeekv2/actions/oidc/customization/sub
   ```

   Observed on this account (2026-07-28):

   ```json
   { "use_default": true, "use_immutable_subject": false, "sub_claim_prefix": "repo:stevebargelt@4857343/meatgeekv2@1304558512" }
   ```

   **`use_default: true` coexists with a custom prefix — they are not mutually
   exclusive.** `use_default` describes the claim-KEY list (`include_claim_keys`)
   — "this repo has not customized WHICH claims appear" — while the enterprise
   policy injects the id-bearing prefix independently of it. `sub_claim_prefix`
   is the authority: where it is present and non-empty it decides the subject
   whatever `use_default` says. Reading those two as mutually exclusive is the
   defect that produced the MG-42 outage; do not "simplify" this back.

   `<github-env>` is the EXACT `environment:` value the job declares, so the
   credential the bootstrap creates equals the OIDC subject GitHub presents.
   The environments, their identities, and their (short) Terraform/state names:

   | GitHub Environment (workflow `environment:` + OIDC subject) | Identity it federates | Federated subject                          | tf env / state container |
   | ----------------------------------------------------------- | --------------------- | ------------------------------------------ | ------------------------ |
   | `development-infra-apply` (infra-apply-dev.yml `apply`)      | dev **infra-apply**   | `<prefix>:environment:development-infra-apply` | `dev` / `tfstate-dev`    |
   | `development` (app publish)                                  | dev **app-deploy**    | `<prefix>:environment:development`             | `dev` / `tfstate-dev`    |
   | `production` (infra-deploy-prod / app-deploy-prod)           | prod plan/read        | `<prefix>:environment:production`              | `prod` / `tfstate-prod`  |

   `<prefix>` is whatever the `gh api` call above returns **today**. With the
   value observed on this account, the three live subjects resolve to:

   ```
   repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:development-infra-apply
   repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:development
   repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:production
   ```

   Those strings are **an observation, not a constant**. Verify against the API
   before treating a live credential as wrong — a credential that does not match
   the *hardcoded old form* `repo:stevebargelt/meatgeekv2:environment:<env>` is
   almost certainly correct, and "correcting" it back to that form is the
   outage (`AADSTS700213` on every `azure/login`). Bootstrap composes subjects
   in exactly one place and never interpolates the repo name directly.

   **The count, stated both ways so the two numbers never read as a
   contradiction: there are FOUR GitHub Environments — the THREE FEDERATED ones
   in the table above, PLUS one APPROVAL-ONLY, deliberately unfederated recovery
   environment (`development-infra-apply-recovery`, below). Three federated +
   one approval-only recovery = four total.** The table is the complete set of
   *federated* environments — every environment an identity can log into Azure
   under — and is deliberately not the complete set of environments.

   There is no PR-reachable environment and no PR-reachable identity: under MG-23 the
   pull-request infrastructure job (`ci.yml` → `validate-infrastructure`) binds
   **no** environment at all, so nothing in the table above is reachable from a
   pull request.

   The full-word GitHub-Environment names are what the workflows declare — a job
   with `environment: development-infra-apply` presents the subject
   `…:environment:development-infra-apply`, so the bootstrap federates that exact
   subject (never a bare `…:environment:dev`, which would silently never match).
   A jest guard (`oidc-subject-consistency.spec.ts`, in CI) and the bootstrap
   tests (`bootstrap.test.sh`) assert this alignment so it cannot drift.

   **Why the dev environments split (MG-23 F8).** Before MG-23, every dev
   identity federated the *identical* `…:environment:development` subject and
   was selected only by which client id a job happened to pass — so a one-line
   client-id edit merged to `main` would have silently upgraded a low-privilege
   job to full apply. Now the **environment**, not the client id, selects
   the identity: an edited client id simply stops matching the subject and the
   login fails closed. The state **containers** deliberately do *not* follow this
   split — they are derived from a separate list, so there is exactly one
   container per Terraform environment (`tfstate-dev` / `tfstate-prod`) no matter
   how many GitHub Environments exist.

   **The fourth environment** — the approval-only one already counted above —
   is `development-infra-apply-recovery`, which gates the recovery
   `workflow_dispatch` path in `infra-apply-dev.yml`. It is deliberately **not
   federated**: it appears in no subject table because no identity is bound to
   it and nothing logs into Azure under it. The `recovery_approval` job binds it
   purely to pick up its protection rules — it is a human gate, not a
   credential.

   **The bootstrap explicitly creates and verifies TWO of those four
   environments** — the dev apply pair — do not let GitHub create either for
   you. (`development` and `production` predate MG-23 and already exist.) GitHub auto-creates an environment on a
   workflow's first reference to it, and an auto-created environment has **no
   protection rules at all**:

   | Environment | Protection the bootstrap creates and verifies | What an unprotected one would mean |
   | --- | --- | --- |
   | `development-infra-apply` | deployment branch policy: **`main` only**. **NO required reviewer** — the automatic path must not park on a human | any ref reaching the workflow could mint a token for an identity holding Contributor + conditioned RBAC Administrator on `meatgeek-v2-dev-rg` |
   | `development-infra-apply-recovery` | deployment branch policy: **`main` only**, **PLUS required reviewers** (`prevent_self_review: false`, so a solo maintainer can approve their own recovery run) | a recovery dispatch would sail straight through the "approval" gate guarding a *destructive*, `authorized_changes`-bearing apply |

   > For each, the bootstrap PUTs the configuration and then **reads the
   > protection rules back** to decide `PROTECTED` / `UNPROTECTED` — a successful
   > PUT is not evidence. This is create-or-update, so it also **repairs** an
   > environment GitHub already auto-created unprotected. If `gh` is unavailable
   > or unauthenticated the status is recorded `UNVERIFIED` (never silently
   > passed) and the run's final summary prints the exact commands to run.
   >
   > This is a **blocking pre-activation check**: do **not** set
   > `DEV_TF_BACKEND_READY=true` until **BOTH** environments verify as
   > `PROTECTED` — `development-infra-apply` with its `main`-only branch policy
   > and no reviewer, `development-infra-apply-recovery` with its `main`-only
   > policy and a non-empty `required_reviewers` rule. See
   > [MG-23 live acceptance & activation](./mg23-live-acceptance.md).

   The **prod** plan/read identity is granted least-privilege **`Reader`** at
   subscription scope plus **`Storage Blob Data Reader` on its own state
   container only** (`tfstate-prod`) — **container-scoped, not account-scoped**,
   so it cannot read `tfstate-dev` or anything else in the account. It has **no**
   apply role — an accidental apply under that identity fails closed. It is
   reached only from `infra-deploy-prod.yml`, which is `workflow_dispatch`-only
   behind the `production` environment and is **not** pull-request-reachable.

   > **There is no dev plan/read identity (MG-23).** The earlier design ran a
   > PR-time `terraform plan` against live dev state, which forced a
   > pull-request-reachable principal to hold read on `tfstate-dev` — and dev
   > state carries live IoT Hub SAS keys. MG-23 deleted that identity and its
   > environment outright: PR validation is credentialless, so the disclosure
   > path is closed **by construction** rather than by a reviewer gate. Retiring
   > the *live* Azure and GitHub objects is a separate operator action —
   > **re-running this bootstrap does not remove them** — see the DECOMMISSION
   > section of
   > [MG-23 live acceptance & activation](./mg23-live-acceptance.md).

   Applying dev infrastructure is the separate, dedicated **infra-apply**
   identity's job (Contributor and a conditioned Role Based Access Control
   Administrator scoped **only** to `meatgeek-v2-dev-rg`, plus Storage Blob Data
   Contributor on `tfstate-dev`); publishing the app is the separate
   `AZURE_APP_DEPLOY_CLIENT_ID` identity's job (above). Three identities, three
   environments, three privilege levels.

A **V1-safety guard** (`assert_v2_name`) refuses to operate on any name that is
not unambiguously `meatgeek-v2` / `meatgeekv2`, and explicitly rejects the known
V1 identifiers (`meatgeek-shared`, `meatgeekterraformstate`). This is the last
line of defense against a mistyped override pointing the bootstrap at V1.

### Wire the OIDC coordinates into GitHub

The script prints the non-secret coordinates to register as **GitHub
Environment** variables/secrets (one set per environment — the GitHub
Environments named `development` and `production`):

```
AZURE_CLIENT_ID             = <plan/read appId>        # `production` environment ONLY (MG-23)
AZURE_APP_DEPLOY_CLIENT_ID  = <app-deployment appId>   # distinct SP; CI/OIDC func-publish only
AZURE_INFRA_APPLY_CLIENT_ID = <infra-apply appId>      # `development-infra-apply` ONLY (MG-23)
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
grant that identity `Website Contributor` scoped to the Function App alone **and**
`Storage Blob Data Contributor` on the Flex `deployment-package` blob container
(the write target for Flex OneDeploy), so `func publish` works immediately after
Step 6 — no post-apply grant, no bootstrap re-run. Leaving it empty still
validates and plans (both role assignments are skipped via `count`), but the
resulting Function App has nothing that can publish to it, so it is **required**
for a deployable dev environment. It is an identifier, not a secret.

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
functions_auth_allowed_client_app_ids = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]   # calling client(s) — allowed_applications, QUOTED HCL
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
  i.e. _which app minted the token_, never the API.

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
- **Do not substitute `nx run infrastructure:init --args="--env=dev"` here.** The Nx `init`
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
key). It also inspects the **inherent computed key attributes** of the data
services and accepts a residual only when auth cannot use it: the full AI
connection string in a Function App telemetry sink — its `app_settings` map or
its Flex `site_config` block (the AI string is wired via the native
`site_config.application_insights_connection_string` field, not an app setting) —
**only** when `azurerm_application_insights` sets
`local_authentication_enabled = false`; the
inherent key of a Cosmos / SignalR / Event Hubs namespace resource
**only** when that resource disables local/key auth
(`local_authentication_enabled = false` / `local_auth_enabled = false` /
`local_authentication_enabled = false`); for the **azapi-managed** Functions storage
account (`Microsoft.Storage/storageAccounts`) it makes a **positive assertion that
the azapi body sets `allowSharedKeyAccess = false`** — otherwise it is a
**VIOLATION** (a live in-state key); and `azurerm_iothub` keys
as the **acknowledged exception** (accepted with a note — device SAS auth kept).
It also
fails closed on any operational failure (no `jq`, unparseable JSON, no input) —
an inspection that cannot run must not report success.

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
materializing into state. `tf-static-checks.sh` check 12 fails the build if this
runbook/README stops documenting it as the required pre-apply step, and under
MG-23 the script itself is an **executed** CI gate rather than a documented
intention, in **both** workflows and in two different ways:

- **`infra-apply-dev.yml`** runs the real gate **twice** on the real apply — on
  the **saved plan** before the apply, and on the resulting **state** after it.
  This is the load-bearing execution: it is the only place the script sees an
  actual dev plan, because there is no PR-time plan any more.
- **`ci.yml` (`lint-and-test`, the `api-interfaces` leg)** runs it only as
  **fixture regressions** — the credentialless PR path has no plan and no state
  to inspect, so what it proves is that the gate still fails **closed** on the
  crafted fixtures (missing tools, invalid JSON, unexpected schema, temp-file
  failure) and still **passes** a valid empty `resource_changes` array. A gate
  that silently started exiting 0 would be caught here, pre-merge, without any
  credential. Note the job: the Jest suite shells out to
  `scripts/fixtures/run-flex-secret-gate-fixtures.sh` (bash *and* dash), so the
  secret-gate regression lives in `lint-and-test`, **not** in
  `validate-infrastructure` — that job runs the *destroy-guard* fixtures
  (`run-destroy-guard-fixtures.sh`). Both jobs are required checks.

### Step 6 — Apply (greenfield creation — operator-run)

> This step creates the dev stack for the first time, which is an operator
> action by design. **Steady-state** dev applies are CI-run under MG-23; once
> the stack exists, changes go through a PR and merge to `main`, not through
> this command. See [MG-23 live acceptance & activation](./mg23-live-acceptance.md).

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
dev identity (Step 6a). Confirm the CI-path assignments exist — both the
Function-App `Website Contributor` and the Flex deployment-container `Storage Blob
Data Contributor`:

```bash
FUNC_ID="$(terraform state show module.azure_functions.azurerm_function_app_flex_consumption.main | awk '/^ *id /{print $3; exit}')"
az role assignment list --scope "$FUNC_ID" \
  --query "[?roleDefinitionName=='Website Contributor'].principalId" -o tsv
#   → the app-deploy SP object id (== app_deploy_principal_object_id)

# Flex OneDeploy write-path: the same SP on the deployment-package container.
# The functions storage account is the azapi control-plane resource, not azurerm.
STORAGE_ID="$(terraform state show module.azure_functions.azapi_resource.functions_storage | awk '/^ *id /{print $3; exit}')"
az role assignment list \
  --scope "${STORAGE_ID}/blobServices/default/containers/deployment-package" \
  --query "[?roleDefinitionName=='Storage Blob Data Contributor'].principalId" -o tsv
#   → the app-deploy SP object id (== app_deploy_principal_object_id)
```

### Step 6a — Publish the app, then run the authenticated smoke test (unblocks MG-21)

The MG-21 dev integration proof has two parts, **both run manually by the operator
using the operator's own authenticated dev session** — _not_ the app-deploy OIDC
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
FUNC_ID="$(terraform state show module.azure_functions.azurerm_function_app_flex_consumption.main | awk '/^ *id /{print $3; exit}')"

# Only if you don't already have publish rights on the dev FA:
ME="$(az ad signed-in-user show --query id -o tsv)"
az role assignment create --assignee-object-id "$ME" \
  --assignee-principal-type User \
  --role "Website Contributor" --scope "$FUNC_ID"

# Flex OneDeploy writes the package ZIP to the deployment-package blob container
# under YOUR identity, so you also need Blob Data write there (Contributor/Owner
# on the RG does NOT include the storage data plane). Grant it if you lack it
# (the functions storage account is the azapi control-plane resource, not azurerm):
STORAGE_ID="$(terraform state show module.azure_functions.azapi_resource.functions_storage | awk '/^ *id /{print $3; exit}')"
az role assignment create --assignee-object-id "$ME" \
  --assignee-principal-type User \
  --role "Storage Blob Data Contributor" \
  --scope "${STORAGE_ID}/blobServices/default/containers/deployment-package"
```

Then publish the packaged artifact to the dev Function App **as yourself**. On
Flex this is **OneDeploy** — Core Tools uploads the package ZIP to the
`deployment-package` blob container (MI-authenticated); there is no Kudu
zip-deploy and no `WEBSITE_RUN_FROM_PACKAGE`:

```bash
# Build + publish the API package — the Nx target CI runs, invoked locally under
# your own dev session (NOT the app-deploy OIDC SP):
npx nx deploy api --functionApp="$FUNC"
#   … or the raw Core Tools publish against the built package:
#   func azure functionapp publish "$FUNC"
```

This proves the packaged artifact deploys to the MG-24-created dev Function App
(Flex, Node 24, West US 2). Capture the publish output as evidence.

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

# `/api/devices` is a real, idempotent GET route (function getDevices in
# apps/api/src/main.ts); there is NO health endpoint and no anonymous carve-out.
# The getDevicesHandler REQUIRES a user id — read from the `userId` query param
# or the `x-user-id` header — and returns HTTP 400 "User ID is required" without
# one. So the VALID-token call must carry it, or it 400s instead of 2xx. The id
# is a DUMMY smoke value read straight from the query/header; it need NOT match
# the token subject (this API does not cross-check the two). All three calls hit
# the same URL so the only variable is the token.
DEVICES_URL="https://${FUNC}.azurewebsites.net/api/devices?userId=smoke-test"

# 1. No token → MUST be rejected (default-deny proven). Easy Auth rejects at the
#    platform layer BEFORE the function runs, so the userId in the query string
#    is never even reached — the rejection is purely the missing token:
curl -s -o /dev/null -w '%{http_code}\n' "$DEVICES_URL"
#   → 401/403

# 2. Acquire a delegated user token for the API audience (interactive az user):
TOKEN="$(az account get-access-token \
  --scope "$APP_ID_URI/access_as_user" \
  --query accessToken -o tsv)"

# 3. Valid token, correct audience, WITH the required user id → MUST be 2xx:
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${TOKEN}" \
  "$DEVICES_URL"
#   → 200
#   (equivalently, drop the ?userId=… and pass the id as a header instead:
#    -H "x-user-id: smoke-test" against .../api/devices)

# 4. Wrong audience → MUST be rejected (401/403). Acquire a token for a DIFFERENT
#    scope (e.g. ARM) and confirm Easy Auth rejects it BEFORE the function runs
#    (so, exactly like step 1, the userId never comes into play):
WRONG="$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer ${WRONG}" \
  "$DEVICES_URL"
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

- `.github/workflows/ci.yml` (`validate-infrastructure`) is the **only**
  infrastructure job reachable from a pull request, and it is **credentialless**:
  `permissions: contents: read` only (no `id-token: write`), no `environment:`,
  no `azure/login`, and an `env:` block pinning `ARM_USE_OIDC` / `ARM_USE_CLI` /
  `ARM_USE_MSI` / `ARM_USE_AKS_WORKLOAD_IDENTITY` to `'false'`. On every push and
  pull request it runs, in order: `scripts/assert-credentialless.sh` →
  `terraform fmt -check -recursive` →
  `terraform init -backend=false -input=false -lockfile=readonly` →
  `terraform validate` → `terraform test` (root) → `scripts/tf-static-checks.sh`
  → `bootstrap/bootstrap.test.sh` → the destroy-guard fixtures → per-module
  `terraform test` (`modules/functions`, `modules/iot-hub`, `modules/monitoring`)
  → the pinned OTel collector config validate. It takes **no** `terraform plan`,
  binds **no** backend, and never touches `meatgeek-v2/dev.tfstate`. PR jobs
  **never** apply, and now never authenticate either.
- `.github/workflows/infra-apply-dev.yml` **applies dev automatically** after CI
  goes green on a push to `main` — this is MG-23, automated dev GitOps
  reconciliation. It checks out the exact CI'd SHA, plans to a file, runs the
  pre-apply secret gate and the destructive-change circuit-breaker on that file
  (which blocks destroys **and** `forget`/state-orphaning changes), applies
  **that saved plan**, runs the post-apply state gate, and ends with a final
  plan that **fails the run on drift**. Every job skips cleanly unless
  `DEV_TF_BACKEND_READY == 'true'`.
- `.github/workflows/infra-deploy-prod.yml` authenticates via **OIDC**, binds
  the prod remote state (`terraform init -reconfigure -backend-config=environments/backend-prod.hcl`
  plus `-backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"`),
  runs under the `production` GitHub Environment gate, and **ends at
  `terraform plan`** — prod has **no** CI apply yet.

**CI-run reconciliation is the intended steady state.** Dev is active under
MG-23; prod activates under **MG-25**, and until then the prod apply is an
operator action per this runbook. What stays operator-run in **every**
environment, permanently: this bootstrap, creation of the resource groups
themselves, subscription-scoped configuration, and disaster recovery. The dev
apply identity is scoped to `meatgeek-v2-dev-rg`, so Terraform can only *adopt*
that resource group — if dev state or the RG is lost, the GitOps loop cannot
rebuild it and you come back here.

Activating the dev loop has prerequisites — a least-privilege apply identity,
the four GitHub Environments and their protection rules (three federated —
`development-infra-apply`, `development`, `production` — plus the approval-only,
deliberately unfederated `development-infra-apply-recovery`), three empirical checks
against Azure's ABAC behaviour, the T1–T7 live acceptance tests, and tightened
branch protection on `main` — all in
**[MG-23 live acceptance & activation](./mg23-live-acceptance.md)**. Do not set
`DEV_TF_BACKEND_READY` before working through it.

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
  `Website Contributor` scoped to the prod Function App (via the same guarded
  `functions_app_deploy_publisher` assignment) **and** `Storage Blob Data
Contributor` on the prod Flex `deployment-package` container (via the guarded
  `deploy_principal_deployment_container` assignment) — no new Terraform is needed.
- **Function-App runtime credentials** — resolved by MG-24: the Functions
  module accesses Cosmos, host Storage, the IoT-telemetry Event Hub, and
  SignalR **identity-based** (system-assigned managed identity + RBAC over
  non-secret endpoints), so **no connection-string or primary-key VALUE is USED,
  placed in `app_settings`, or surfaced as a Terraform output**. (Accurate state
  posture: each data service's key still exists as an inherent _computed
  attribute_ in state — as for any TF-managed resource; the control is to make it
  non-authenticating by disabling local/key auth where safe —
  `local_authentication_enabled = false` on Cosmos, `local_auth_enabled = false`
  on SignalR, `allowSharedKeyAccess = false` in the azapi body on the
  control-plane-managed host storage account, `local_authentication_enabled = false`
  on the Event Hubs namespace. **IoT Hub is
  the SOLE documented exception:** device/data-pusher/device-controller SAS auth is
  intentionally kept, mitigated by restricted state access. The
  `tf-plan-secret-inspection.sh` gate flags Cosmos/SignalR/Storage/Event Hubs
  namespace as a VIOLATION if local auth is re-enabled, and accepts the IoT Hub
  keys with a note.) The
  former "route plaintext secrets through Key Vault references" question is
  therefore moot — there are no such runtime secrets to route. Application
  Insights is wired via the **full**
  TF-managed connection string (InstrumentationKey included — Microsoft requires
  it as the destination-resource identifier even under Entra) in the Flex
  resource's native `site_config.application_insights_connection_string` field
  (not an app setting; Azure surfaces it to the host unchanged as the
  `APPLICATIONINSIGHTS_CONNECTION_STRING` runtime env var, so `apps/api` telemetry
  is unaffected), but the embedded
  ikey **cannot authenticate**: `local_authentication_enabled = false` on the
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

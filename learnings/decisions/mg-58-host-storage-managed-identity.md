# Function HOST storage (`AzureWebJobsStorage`) is fully managed-identity via the account-name form; the MG-24 shared-key conditional resolves in the managed-identity branch with NO key exception

- **Status:** Accepted (decision binding; **revised 2026-08-10** — the root cause
  is the provider, not the module, and the ticket's framing changed with it; see
  *Root cause* and the Honest boundary)
- **Date:** 2026-08-09; **revised 2026-08-10**
- **Ticket:** MG-58 (dev Function host cannot authenticate to `AzureWebJobsStorage`)
- **Scope:** `apps/infrastructure/modules/functions` (the Flex Function App's
  `app_settings` and its two storage role assignments), the module's
  `tests/security_posture.tftest.hcl` / `tests/flex_hosting_behavior.tftest.hcl`
  invariants, `libs/api-interfaces/src/lib/infra-security-posture.spec.ts`, and
  the two MG-24 ADRs amended alongside this one. The **2026-08-10 revision**
  adds `apps/infrastructure/scripts/assert-live-host-storage.sh` and its fixture
  harness, the post-apply live gate in `.github/workflows/infra-apply-dev.yml`,
  the MG-25 precondition in `.github/workflows/infra-deploy-prod.yml`, and
  `libs/api-interfaces/src/lib/infra-apply-dev.spec.ts`

> **THE FRAMING OF THIS TICKET CHANGED — read this first.** MG-58 was opened as
> "make Terraform authoritative for the absence of the bare `AzureWebJobsStorage`
> setting." **That is not achievable, and the reason is not a limitation of this
> repo's configuration.** The pinned provider writes that key itself and then
> conceals it on read, so the key is not representable in HCL, in the plan
> document or in post-apply state — there is no Terraform surface on which its
> absence could be asserted, and no existing gate that could be extended to see
> it. The decision below is therefore **to recognise that and put the authority
> where it can live**: the desired state stays authoritative for the identity
> form's PRESENCE, and a post-apply assertion against the LIVE site becomes
> authoritative for the scalar form's ABSENCE. See *Root cause* and
> *(e) Split authority*.

> **Honest boundary (revised 2026-08-10).** What is verified, and what is not,
> stated separately — because the first version of this ADR treated a green
> `terraform test` as the outstanding gap, and that framing is itself the error
> this ticket exists to correct.
>
> **Verified in this pass, in the build container, against `/project`:**
> `npx nx test api-interfaces` green (6 suites, 291 tests);
> `bash apps/infrastructure/scripts/fixtures/run-live-host-storage-fixtures.sh`
> green under **both** `bash` and `sh` (25 checks each, counts equal), and also
> under `dash`;
> `bash apps/infrastructure/scripts/fixtures/run-flex-secret-gate-fixtures.sh`
> green under both shells (18 checks each);
> `bash apps/infrastructure/scripts/tf-static-checks.sh` green across all 19
> checks with **no allowlist drift in either direction**;
> and guard 3 re-proven **by mutation rather than by report** — adding the scalar
> key to `live-appsettings-clean.json` turned the harness RED (harness exit 1,
> gate exit 3), and the fixture was restored byte-exact afterwards.
>
> **NOT verified in this pass, and why — do not read this as green.** `terraform
> fmt -check`, `terraform validate` and `terraform test` in
> `apps/infrastructure/modules/functions` **were not run: no `terraform` (or
> `tofu`) binary exists in the build container.** They are CI-gated and must be
> read from the pull request's own run, not from this document. The module change
> in this pass is comment-only, so the expected result is unchanged-green — but
> "expected" is not "observed," and this ADR does not claim it.
>
> **Operator-gated, and outstanding.** The live proofs cannot be produced from a
> build container. Restart-and-re-prove (host lock lease + a `storageHeartbeat`
> execution) has already passed by hand against the 2026-08-09T22:22:17Z restart
> boundary; **T4 — the exact-SHA `func azure functionapp publish` completing with
> no "app appears to be unhealthy" warning — is the ONE proof still outstanding**,
> and MG-58 closes only when it joins the already-passing convergence, apply,
> storage-health and timer proofs. The sequence is in
> `docs/infrastructure/mg58-host-storage-verification.md`.
>
> **Do not read any green guard as "the host can reach its storage account."**
> That inference — a green guard read as an operational fact — is exactly how
> this defect shipped past eleven green checks (see *The architectural lesson*).

## Context

MG-24 hardened the Functions storage account to **`allowSharedKeyAccess = false`**
but left an explicit, written conditional attached to that hardening
(`backlog/notes.md:17-19`, quoting the MG-24 ticket verbatim):

> Storage: `shared_access_key_enabled = false` **ONLY IF** the Function host
> storage is fully managed-identity; **VERIFY first**, else keep keys as a
> documented exception (do NOT break Functions).

**The verification was never performed, and the conditional was never settled.**
What settled instead was an *assumption*, recorded in two places as though it
were a finding:

- `modules/functions/main.tf` (the `app_settings` header comment) asserted that
  Flex "manages … host storage itself", and listed `AzureWebJobsStorage*` among
  the settings deliberately **not** set.
- [`mg-24-flex-consumption-hosting-model`](mg-24-flex-consumption-hosting-model.md)
  generalised the (true) fact that Flex needs no Azure Files content share into
  the (false) claim that the account can keep `allowSharedKeyAccess = false`
  and Flex therefore "still deploys **and runs**".

The consequence was that the Function App shipped with **no host-storage
connection configured in any form** — neither the credential-carrying
connection-string form (correctly forbidden) nor the identity-based form
(wrongly omitted). In dev this surfaced as `azure.functions.webjobs.storage`
permanently **Unhealthy** with `errorCode AuthenticationFailed`, logged roughly
every 30 seconds, and as the "app appears to be unhealthy" warning at the end of
every `func azure functionapp publish`. HTTP triggers kept working throughout,
because an HTTP trigger does not need the host storage account — which is why a
permanently-broken authentication surface went unnoticed from MG-24 until the
MG-51 live proof.

## Root cause (established 2026-08-10, after the first fix failed)

**The first fix was correct and did not work.** Commit `e785a74` (PR #42) added
`AzureWebJobsStorage__accountName`, narrowed the guards, corrected the false Flex
premise, added the `storageHeartbeat` timer probe and the runbook. Two
convergence plans were clean, all eleven CI checks passed, the dev GitOps apply
succeeded — **and the defect persisted.** The live Function App carried **both**
forms at once: a scalar `AzureWebJobsStorage` connection string whose
`AccountKey` was **empty**, alongside the new identity form. The Functions host
resolves the connection-string form **first** and never reaches the identity
form, so it authenticated with an unusable key against an account whose shared
keys are disabled. **The setting that shipped was not wrong; it was SHADOWED.**

### The injector is the provider

`hashicorp/azurerm` **v4.81.0**, pinned in
`apps/infrastructure/.terraform.lock.hcl`. This was **read from the provider's
own source at the pinned version**, not inferred from behaviour. Three code
paths, and all three are load-bearing:

| # | Path | What it does | Why it matters |
| --- | --- | --- | --- |
| 1 | **WRITE, unconditional** — `ExpandSiteConfigFunctionFlexConsumptionApp` in `helpers/function_app_schema.go` | Appends the scalar key `AzureWebJobsStorage` to app settings whenever the composed storage string is non-empty, with **no branch on the authentication type**. Called from **both** the create and the update path of `function_app_flex_consumption_resource.go`. | The classic Linux/Windows Function App expanders **in the same file** *do* branch — emitting the `__accountName` form under managed identity and the scalar form otherwise. **The Flex expander never got that branch. That asymmetry is the defect.** |
| 2 | **THE VALUE** — composed from `StorageStringFmt` | Account name parsed out of `storage_container_endpoint`, plus the `storage_access_key` attribute — which is **EMPTY** under `storage_authentication_type = "SystemAssignedIdentity"`. | Rendering that format with an empty key yields **byte-for-byte** the unusable string observed on the live site. The value is a **fingerprint of provider injection**. |
| 3 | **READ, concealed** — the resource's settings unpacker | Special-cases the key and routes it **out of `app_settings` into the `storage_access_key` attribute**. | The key **never lands in the `app_settings` map in state**, so **no plan diff on it is representable**, and **the provider can never prune an app setting it does not believe exists**. |

### Three corollaries, each of which changes what "success" looks like

1. **The manual CLI repair was not merely undurable — it was SCHEDULED FOR
   REVERSAL.** The Update path recomposes the connection string and re-runs the
   settings merge **unconditionally**. So **any in-place change to the Function
   App at all** — a tag, a CORS origin, an always-ready count, an App Insights
   key rotation — would have re-injected the key. The hand-applied
   `az functionapp config appsettings delete` was living on borrowed time, and
   nothing in the pipeline would have reported its reversal.
2. **This is also why the defect survived the last GitOps apply intact.** The
   apply that shipped PR #42 *updated* the Function App, which re-ran the
   injection. Config-clean and site-dirty are different claims; every gate this
   repo had asserted only the first.
3. **A NO-OP apply is the correct, SUCCESSFUL outcome for this change.** The
   manual deletion already made live state match the corrected desired state,
   and this change makes **no functional HCL change** — the module edit is
   comment-only by design. An implementer who finds themselves producing a
   Function App diff has taken one of the eliminated routes below. A no-op apply
   here is proof the desired state was already right, **not** a sign that
   nothing was accomplished.

### None of the suspected causes was the cause

The ticket proposed three candidates — created-with-the-app-and-never-pruned,
Flex platform injection, or `func azure functionapp publish` re-adding it. **All
three are wrong.** The injector is Terraform's own provider, on every apply that
updates the app. The T4 live-settings capture in the runbook confirms the
`publish` branch for free, and additionally checks for the stray
deployment-storage connection-string setting the Update path injects — whose
presence is itself decisive evidence that an **UPDATE**, not a create and not a
publish, was the injector.

## Decision

### (a) The MG-24 conditional resolves in the MANAGED-IDENTITY branch

**The Function host storage is made fully managed-identity; shared keys stay
disabled on the Functions storage account; there is NO documented key
exception.** The `ONLY IF` in MG-24 is satisfied by *completing* the
managed-identity configuration — publishing the one identity-based setting the
app was missing — not by relaxing the storage posture to accommodate its
absence. The IoT Hub remains the **sole** documented live-key exception in this
stack, exactly as
[`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md)
records; MG-58 adds none.

This is the correct branch on the merits — Flex Consumption fully supports
identity-based host storage, Microsoft recommends it, and **this same identity
already authenticates successfully to Cosmos and SignalR**, so the identity
itself was never in question and the fault was specific to the storage account's
data plane. (App Insights is *configured* for AAD ingestion but is **not**
cited as corroboration here: MG-37 records it emitting nothing in dev, so it is
an unproven path, not a working one.) It is also worth recording that **the
alternative branch was, concretely, the expensive one.** Restoring keys
would have had to defeat four independent controls that already encode this
direction:

| Control | Location | What a key restoration would have to do |
| --- | --- | --- |
| The account body itself | `modules/functions/main.tf:129` — `allowSharedKeyAccess = false` in the `azapi_resource.functions_storage` body | Flip it, re-enabling a live account key that Terraform then reads into state |
| `tf-static-checks.sh` | `scripts/tf-static-checks.sh:498-499` | Defeat a `grep` that fails the PR the moment that line disappears from the module |
| `tf-plan-secret-inspection.sh`, positive assertion | `scripts/tf-plan-secret-inspection.sh:689-698` | Defeat a positive plan-time assertion that the azapi storage-account body sets `allowSharedKeyAccess=false` |
| `tf-plan-secret-inspection.sh`, `deploy_storage_key` | `scripts/tf-plan-secret-inspection.sh:425-432`, `578-579` | Defeat a check that rejects a raw storage key **unconditionally on presence** — deliberately not marker-based, because a raw Azure storage key is opaque base64 carrying **no** lexical credential marker (no `AccountKey=`, no `sig=`), so presence is the only signal available |

Two of those four are CI gates that fail the pull request, and the fourth is
non-negotiable by construction. A key restoration was therefore never the cheap
rollback it can appear to be from the outside; it was a four-control retreat
from a posture the repository has already paid for.

**Rollback is explicitly NOT via shared keys.** If the live proofs do not land —
that is, if **no `Host lock lease acquired` row appears after a recorded restart
boundary and no `storageHeartbeat` execution is observed** (the corrected
signals; see *(i)* — do **not** look for a `Healthy` row, none is ever emitted) —
the setting is reverted and MG-58 is re-opened with concrete evidence naming the
specific element of *this app's* configuration that managed identity cannot
support. "MI was harder" is not that evidence.

**And note what rollback does NOT mean, post-2026-08-10.** Reverting the
account-name setting is **strictly worse than the defect being fixed**: it
returns the app to having *no* usable host-storage configuration at all, while
the provider keeps injecting the empty-key scalar form regardless. The recorded
connection-string value
(`DefaultEndpointsProtocol=https;AccountName=…;AccountKey=;EndpointSuffix=…`) is
a **forensic fingerprint of provider injection, NOT a restore path** — its
`AccountKey` is empty, it never authenticated, and it cannot, because shared keys
are disabled on the account. Restoring it restores the outage.

### (b) The setting form: the ACCOUNT-NAME form, and why

Exactly **one** host-storage setting is published
(`modules/functions/main.tf:285`):

```hcl
"AzureWebJobsStorage__accountName" = local.functions_storage_account_name
```

The account-name form and the service-URI forms
(`AzureWebJobsStorage__blobServiceUri` / `__queueServiceUri` /
`__tableServiceUri`) are **alternatives, not complements**. Publishing both, or
publishing the wrong one, is its own defect: the wrong one leaves the host
unable to authenticate while every static test still reads green.

**The evidence for the account-name form** is that this account is reachable by
**standard Azure public-cloud DNS**. It is a plain `Standard_LRS` `StorageV2`
account; a sweep of every `.tf` file in `apps/infrastructure` for
`private_endpoint`, `virtual_network`, `vnet` and `public_network_access`
returns nothing, so there is no private endpoint, no VNet integration and no
network restriction anywhere in the stack. The corroborating datum is that the
**already-working** deployment endpoint is itself composed against
`blob.core.windows.net` (`modules/functions/main.tf:207`) and resolves fine. The
service-URI form exists for accounts the host cannot address by standard DNS —
sovereign clouds, custom endpoints, private endpoints — and none of those apply.

**The reason is recorded, not merely the choice, because the reason has a known
expiry.** **MG-34** (the secure off-VNet edge) would put this app behind private
endpoints / VNet integration, which **invalidates the premise above** and forces
the service-URI form. Whoever picks up MG-34 must revisit this setting; a future
reader who found only the choice and not its premise would have no way to know
that.

The setting carries a **name, not a credential** — no key, no SAS, no connection
string. That is what makes it compatible with `allowSharedKeyAccess = false`,
and it is why publishing it does not trip the secret gates: an account name is
not a secret, and nothing secret reaches `app_settings`, the module outputs, or
Terraform state as a result of this change.

### (c) The role-to-feature mapping AS IT STANDS

One row per role currently granted to the **Function App's system-assigned
managed identity** on the Functions storage account. **This ticket makes NO role
change** — no role is added, removed or re-scoped, `tf-managed-role-allowlist.tsv`
is untouched, and no `bootstrap.sh` re-run is required or implied.

| Role (scope) | Declared at | Feature that requires it | Status |
| --- | --- | --- | --- |
| **Storage Blob Data Owner** (storage account) | `modules/functions/main.tf:455-460` | The documented minimum for the host's **required storage**: the host's own containers (`azure-webjobs-hosts`), blob **leases** for the singleton/host lock, **timer schedule status** persistence, and the runtime read of the **deployment package** from the blob container under `storage_authentication_type = "SystemAssignedIdentity"`. | **Justified.** This is the role the account-name setting above is resolved against; it is what makes host storage work at all. |
| **Storage Queue Data Contributor** (storage account) | `modules/functions/main.tf:462-467` | The justification on record is the one written at `modules/functions/main.tf:443-448` — the Flex runtime's **triggers and scaling** need queue data-plane access on the app's own storage account. | **UNRESOLVED, owned by MG-60.** The question is disputed and undisproven; MG-60 exists to settle it against Microsoft's documented Flex host-storage requirements and **depends on MG-58 landing first**. |

Two rows, matching one-for-one the two `azurerm_role_assignment` blocks that
exist against the storage account in `modules/functions/main.tf`. (A third
storage role assignment exists in the module —
`deploy_principal_deployment_container`, `main.tf:479-485` — but it grants a
**different** identity, the app-deploy principal, and is scoped to the
deployment container rather than the account, so it is out of scope for this
table. The three-identity split is documented in the
[Flex hosting-model ADR](mg-24-flex-consumption-hosting-model.md).)

On the queue row specifically: **this ADR does not assert that the grant is
unjustified, and it makes no recommendation about its disposition.** MG-58
deliberately carries no role delta, for a reason worth stating — a role change
drags in an edit to `apps/infrastructure/bootstrap/tf-managed-role-allowlist.tsv`
and a privileged `bootstrap.sh` re-run by a subscription Owner / User Access
Administrator, outside CI's credential-less reach, and can leave the live ABAC
condition and the Terraform graph disagreeing. Folding that into a
one-setting authentication fix would have made a failure of either ambiguous.
MG-60 owns the question on its own.

Should a role turn out to be **required and missing** at live-proof time, that is
a **finding to surface** on MG-58, not a silent adjustment.

### (d) The architectural lesson: two authentication surfaces, one account

**Host storage and deployment storage are two independent authentication
surfaces that happen to share one storage account.**

| Surface | Configured by | Status through MG-24 |
| --- | --- | --- |
| **Deployment** storage — the package ZIP the app runs from | The Flex resource's own `storage_container_type` / `storage_container_endpoint` / `storage_authentication_type = "SystemAssignedIdentity"` arguments (`modules/functions/main.tf:205-208`) | **Fully configured and working.** Confirmed as part of MG-58 rather than assumed: the two surfaces do not share a fate, and this one was never broken. |
| **Host** storage — the host's own required storage (host lock, leases, timer schedule status, key store) | The `AzureWebJobsStorage__accountName` app setting — **and nothing else** | **Completely unconfigured.** Permanently `AuthenticationFailed`. |

A fully-configured deployment surface **coexisted with a completely
unconfigured host surface while every guard in the repository stayed green.**
The guards were green because they asserted the *absence* of the
credential-carrying form, and absence-of-a-credential was silently read as
presence-of-identity-auth. An invariant of the form "no key is configured here"
cannot, on its own, distinguish "configured by identity" from "not configured at
all" — and the second reading was the true one for the whole of MG-24.

Two corrections follow, both landed in the module change alongside this ADR:

1. The two surfaces are now **two separately named invariants** —
   `deployment_storage_is_managed_identity_only`
   (`tests/security_posture.tftest.hcl:70`) and
   `host_storage_is_managed_identity_only`
   (`tests/security_posture.tftest.hcl:128`). Neither may be folded into the
   other: collapsing them is exactly what let one surface's green assertion mask
   the other's absence.
2. Every absence-asserting guard was **narrowed, not deleted** — each now
   asserts the negative **and** the corresponding positive: the
   credential-carrying `AzureWebJobsStorage` connection-string form and every
   `*ServiceUri` variant are **absent**, *and* the account-name form is
   **present**. A pure-absence assertion is now understood to be a
   half-assertion wherever a positive counterpart exists.

### (e) AUTHORITY IS SPLIT — the central decision of the 2026-08-10 revision

**The desired state stays authoritative for the identity form's PRESENCE. A
post-apply assertion against the LIVE site becomes authoritative for the scalar
form's ABSENCE.** These are two different claims on two different surfaces, and
after *Root cause* there is no surface that can carry both.

| Claim | Authority | Enforced by |
| --- | --- | --- |
| `AzureWebJobsStorage__accountName` is present, Terraform-owned, and equals `var.storage_account_name` | **The desired state** — `modules/functions/main.tf` | `tests/security_posture.tftest.hcl`, `tests/flex_hosting_behavior.tftest.hcl` (unchanged by this revision) |
| The scalar `AzureWebJobsStorage` is **absent from the deployed site** | **The live post-apply gate** — and nowhere else, because nowhere else *can* | `scripts/assert-live-host-storage.sh`, run by the dev apply job in `.github/workflows/infra-apply-dev.yml`, pinned by `infra-apply-dev.spec.ts` and `infra-security-posture.spec.ts` |

**Guards 1–3 are regression fences, not detectors.** This distinction is the
whole lesson and is easy to lose. The tftest guards, the plan/state secret
inspection and the static HCL scan all assert the scalar key's absence from
*configuration*, where it was **genuinely absent all along** — they passed before
the defect, during the defect, and after it. They protect against **a human
reintroducing the key in HCL**, which is a real risk worth fencing. They are
structurally incapable of observing **the injection that actually shipped**.
Guard 4 is the only gate in the system on which that defect is representable at
all.

### (f) FAIL-LOUD over silent self-heal — a policy choice, with its cost stated

When the live gate finds the scalar key, the workflow deletes exactly that one
key on exactly that one app, re-reads, re-asserts — **and then FAILS THE RUN
ANYWAY.**

**Why.** A remediation that left the run green would reproduce **the precise
property that let a non-fix ship past eleven green checks**: a live defect behind
a green pipeline. It would also mask the moment a provider upgrade changes this
behaviour, in either direction — including the good direction, where the
injection stops and this whole apparatus should be retired.

**The cost, stated honestly and accepted.** `main` goes **red after every change
that updates the Function App**, until the provider behaviour changes upstream.
That is real recurring noise, not a hypothetical. Two things bound it:
remediation is **conditional on presence**, so the steady state on the many
pushes that touch no infrastructure is **zero deletions and zero red runs**; and
the failure message names the cause (provider injection — not drift, not a human
edit) and points at this ADR and the runbook, so a red run is a 30-second read
rather than an investigation.

**This is the flippable one.** If the noise proves worse than the visibility is
worth, only the failure branch of the workflow step and its matching assertion in
`infra-apply-dev.spec.ts` change. Record the flip here if it happens; do not flip
it silently, because the silence is the thing being traded away.

### (g) The behavioural dependency on undocumented provider internals

This decision **depends on internal provider behaviour that is documented
nowhere** — not in the resource docs, not in a changelog — and the constraint in
`main.tf` is `~> 4.0`, which **floats**. The lock file pins 4.81.0 today; any
`terraform init -upgrade` may move it.

**The live assertion is precisely what makes a minor bump survivable in either
direction**, and this is the reason to keep it even though it is unusual:

- **If a bump keeps injecting** — the gate keeps catching it. Nothing changes.
- **If a bump FIXES the injection** (the Flex expander gets the branch its
  siblings already have) — the gate goes quiet and stays green, and the ADR's
  retirement condition is met **observably**, rather than by someone guessing
  from a changelog.
- **If a bump changes the shape** — a different key, a different value form — the
  gate fails on the account-name assertion or on the name list it prints, and the
  failure is loud and diagnosable.

A config-surface guard could not have survived any of these, because it never saw
the behaviour in the first place. **Do not tighten the constraint to an exact
pin as a substitute for this gate** — that trades a detector for a freeze, and
freezes rot.

### (h) The upstream provider bug — DECISION: file it, and do not block on it

**Decision: file the two-part bug upstream against `hashicorp/terraform-provider-azurerm`,
as a follow-up that blocks nothing in MG-58.** It is genuinely two defects and
should be reported as such:

1. **The Flex expander omits the authentication-type branch its Linux/Windows
   siblings have** — it writes the scalar connection-string form even under
   `SystemAssignedIdentity`, producing a connection string with an empty
   `AccountKey` that cannot authenticate anywhere.
2. **The read path conceals the key** by routing it into `storage_access_key`,
   which is what makes the first bug undiagnosable from any Terraform surface and
   unprunable by the provider itself.

The second is arguably the more serious: without it, the first would have shown
up as a plan diff and been caught in review. **MG-58 does not wait on the fix.**
Upstream acceptance and release are outside this project's control, and the live
gate is correct whether or not the bug is ever fixed — see (g) for how the gate
reports the fix landing.

### (i) The corrected acceptance signals — the old ones were UNSATISFIABLE

The original acceptance criteria demanded a **positive `Healthy` row** in
`FunctionAppLogs`. **No such row is ever emitted.** The platform logs
`Process reporting unhealthy` **only when unhealthy** and stays **silent when
healthy**, so that criterion could never have been met by a working system. It
was not a high bar; it was an unmeetable one, and it must not be restored.

The instinct behind it was right — **forbid proof-by-absence.** The disappearance
of `Unhealthy` rows is genuinely not proof: the dev Log Analytics workspace has a
hard ingestion cap, and the defect's own ~30s rows are themselves ingestion
volume that vanishes both when the defect is fixed **and** when ingestion simply
stops. So absence remains inadmissible. The fix is to demand **positive signals
that are stronger than a log line**:

| Signal | Why it proves working host storage |
| --- | --- |
| **`Host lock lease acquired`** after a recorded restart boundary | The host lock is a **blob lease IN the host storage account**. It **cannot be taken** without working data-plane access. This is proof by consequence, not by report. |
| **A `storageHeartbeat` timer execution** | The timer's **schedule status and singleton lease live in that same account**. A timer that fires has necessarily read and written host storage. |

**Proof by consequence is stronger than a log line**, which is why this is an
upgrade rather than a workaround: a log line asserts that some component believed
something; a lease acquisition and a timer execution are **operations that could
not have completed** had the thing under test been broken. Both were observed
against the 2026-08-09T22:22:17Z restart boundary — two lease rows at 22:27:18Z
and 22:28:47Z, and `Executed Functions.storageHeartbeat Succeeded in 32ms` at
22:30:00Z, where that same timer had failed to fire at 21:45, 22:00 and 22:15
before the repair.

### (j) MG-25 prod activation precondition — NAMED, not noted

**Prod's apply may not be activated until prod carries the same post-apply live
host-storage assertion.** This is recorded in the header of
`.github/workflows/infra-deploy-prod.yml`, where MG-25 will actually read it, and
is part of **MG-25's definition of done**, not a follow-up.

The same provider and the same module build the prod Function App, so **prod will
inherit the identical empty-key injection at its FIRST apply** — and a plan-only
pipeline is **structurally blind** to it, because the key is absent from the plan
document by construction. Reviewing a prod plan and seeing nothing is not
evidence of a clean site. Without this precondition, MG-25 ships a prod Function
App with dead host storage behind a fully green pipeline: **exactly the outcome
MG-58 exists to prevent, repeated in the environment where it costs most.** Note
that prod remediation needs management-plane write on the prod app; that is an
MG-25 identity question, and **MG-58 made no RBAC change in any environment.**

## Alternatives considered

The first two were added in the 2026-08-10 revision and are the mechanisms that
would have made **Terraform** authoritative for the scalar key's absence. **Both
are eliminated on evidence, not on preference** — that is why the module change
in this pass is comment-only.

- **(a) DECLARE `AzureWebJobsStorage` in the module's `app_settings`** (set it to
  the empty string, or to the identity form, to override the injection).
  **REJECTED — it works on the wire and fails permanently in the plan.**
  Declaring the key *would* suppress the injected value on the deployed site: the
  module's setting wins the merge. But the **read path routes that key out of
  `app_settings` into `storage_access_key`** (*Root cause*, path 3), so state can
  **never** carry a key the configuration does. Config-has / state-lacks is a
  **permanent diff**: every plan proposes to add it, every apply "adds" it, and
  every subsequent plan proposes it again. That **reddens the final drift gate on
  every single run** — the gate whose exit-0 is this pipeline's convergence
  proof. This is **the same shape as the `APPLICATIONINSIGHTS_CONNECTION_STRING`
  perpetual diff already recorded in this repo under MG-24**, which was resolved
  by moving the value to a native `site_config` field. **No equivalent native
  field exists here**, so that escape is unavailable. Trading a real convergence
  proof for a cosmetically-clean site is a bad trade: it would train everyone to
  ignore a permanently-red gate, which is how the next defect ships.
- **(b) ADD A SECOND TERRAFORM WRITER on the app-settings sub-resource** (an
  `azapi_resource` / `azapi_update_resource` managing
  `…/config/appsettings` directly). **REJECTED — it fails differently and
  worse: silently.** That sub-resource is **replace-the-whole-collection**, not
  merge-by-key. A second owner writing "the settings" would **silently DELETE
  every setting it does not itself declare** — including the provider-injected
  ones the module never declares and cannot see: the health-check ping-failure
  setting, the App Insights connection string and instrumentation key, and the
  deployment-storage settings. The loss would be **invisible in HCL for exactly
  the reason the current defect is**, and would surface as a second, subtler
  outage. **The azapi precedent in this module does NOT transfer.** `azapi` is
  used here for `azapi_resource.functions_storage`, where it is the **sole owner
  of a whole resource**; this would make it a **co-owner of one sub-resource**
  alongside `azurerm`. Sole ownership of a resource and shared ownership of a
  replace-whole-collection sub-resource are not the same pattern, and the
  existing precedent should not be read as licensing the second.
- **Restore shared keys and use the connection-string `AzureWebJobsStorage`
  form.** **Rejected.** It reintroduces a live storage credential into
  `app_settings` and Terraform state, reverses the posture MG-24 paid for, and
  must defeat the four controls tabulated in (a). Flex Consumption fully
  supports identity-based host storage, so nothing about this app requires it.
  Permitted only on concrete evidence naming the specific element of this app's
  configuration that managed identity cannot support; no such evidence exists.
- **Publish the service-URI form (`AzureWebJobsStorage__blobServiceUri` …).**
  **Rejected** — not warranted for an account on standard Azure DNS with no
  private endpoint and no VNet integration. Would become the correct form under
  MG-34; see (b).
- **Publish both the account-name and service-URI forms "to be safe."**
  **Rejected** — they are alternatives, not complements; publishing both is its
  own defect.
- **Fix host storage and prune the queue role in one ticket.** **Rejected** —
  see (c). A role delta pulls in an allowlist edit and a privileged bootstrap
  re-run, and would make a failure of either change ambiguous. MG-60 owns it.

## Consequences

- **The MG-24 conditional is settled**: managed-identity branch, shared keys stay
  disabled, no key exception. `backlog/notes.md` item 1 no longer carries it as
  an open question. IoT Hub remains the sole live-key exception in the stack.
- **`allowSharedKeyAccess = false` stands unchanged**, and both secret gates keep
  passing unweakened. The secrets-out-of-state posture is preserved, not traded
  away: the added setting carries an account **name**, which is not a credential.
- **Exactly one host-storage setting form is published.** Any future change that
  adds a second form, or swaps the form without recording the reason, is a
  regression — the module tests now fail on both.
- **MG-34 must revisit the setting form.** Private endpoints / VNet integration
  invalidate the standard-DNS premise and force the service-URI form.
- **MG-60 inherits the Storage Queue Data Contributor question** and depends on
  MG-58 landing first. MG-58 itself carries **no role delta**.
- **MG-58 is sequenced before MG-53** (the Cosmos shared-throughput migration),
  so that a cutover failure there is not ambiguous between a Cosmos cause and a
  broken host storage plane.
- **The live proofs are the corrected ones** (see *(i)*). A **positive `Healthy`
  row is UNSATISFIABLE and must not be reintroduced** into any acceptance text —
  the platform is silent when healthy. The proofs are: **`Host lock lease
  acquired`** after a recorded restart boundary, **a `storageHeartbeat` timer
  execution**, and **T4** — the exact-SHA `func azure functionapp publish`
  completing with no "app appears to be unhealthy" warning. The first two have
  passed; **T4 is the one still outstanding**, and MG-58 closes only when it
  joins them. Sequence and queries:
  `docs/infrastructure/mg58-host-storage-verification.md`. The *disappearance* of
  `Unhealthy` rows remains **not** proof: the dev Log Analytics workspace has a
  hard ingestion cap, and the defect's own ~30s rows are themselves ingestion
  volume that vanishes when the defect is fixed *and* when ingestion simply
  stops.
- **The dev apply job now holds a new class of authority**: an imperative,
  credentialed management-plane mutation (`az functionapp config appsettings
  delete`) that sits outside everything the workflow's other gates reason about.
  It is bounded to **one key on one app**, both resolved from `terraform output`
  rather than from any literal, fires **only** when the gate reports that key
  present, and **never leaves the run green when it fires**. Widening it is a
  security regression, not a convenience: the sub-resource is
  replace-the-whole-collection.
- **The live settings document is never persisted.** `az … appsettings list`
  returns VALUES, connection strings among them, into a retained and broadly
  readable CI log. It is piped **straight into the gate's stdin** — no file, no
  `tee`, no artifact, no `echo` — and the gate prints **setting NAMES and fixed
  reasons only**, on accept and reject paths alike.
- **Guard 4 CAN run in CI, and deliberately does not run on the PR.** It runs in
  the post-merge dev apply job, which already holds sufficient authority to both
  read and remediate — which is why **no RBAC change was needed** to satisfy the
  ticket. It is **not** added to `ci.yml`'s `validate-infrastructure` job because
  that job is **credentialless by design and proven so at runtime** by
  `assert-credentialless.sh`; adding an Azure identity there would trade a
  load-bearing security invariant for a gate that has a correct home elsewhere.
  This is a threat-model boundary, not a missing credential.
- **`main` will go red after Function-App-updating applies** until the provider is
  fixed upstream — the accepted cost of *(f)*. Steady state on infrastructure-free
  pushes is zero deletions and zero red runs.
- **MG-25 inherits a named activation precondition** *(j)*: no prod apply without
  the same live assertion. **MG-58 carries no role delta in any environment.**
- **This ADR's apparatus has a retirement condition.** If a future `azurerm`
  release gives the Flex expander the authentication-type branch its
  Linux/Windows siblings already have, the injection stops, the live gate goes
  quiet, and the workflow step and its remediation can be removed — leaving the
  desired state authoritative for both claims, as it should have been. Retire it
  on **observed** silence (see *(g)*), never on a changelog reading alone.
- **Amended alongside this ADR**, both for stating the retracted premise:
  [`mg-24-flex-consumption-hosting-model`](mg-24-flex-consumption-hosting-model.md)
  (the "Flex still deploys and runs" claim, true of deployment storage and false
  of host storage until this ticket) and
  [`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md)
  (the Storage row, which inferred full managed identity from the *absence* of a
  key-based `AzureWebJobsStorage` and now names the positive setting instead).

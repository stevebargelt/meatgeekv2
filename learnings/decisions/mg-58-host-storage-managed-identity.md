# Function HOST storage (`AzureWebJobsStorage`) is fully managed-identity via the account-name form; the MG-24 shared-key conditional resolves in the managed-identity branch with NO key exception

- **Status:** Accepted (decision binding; the setting is authored + statically
  validated, live proof runbook-gated — see the Honest boundary)
- **Date:** 2026-08-09
- **Ticket:** MG-58 (dev Function host cannot authenticate to `AzureWebJobsStorage`)
- **Scope:** `apps/infrastructure/modules/functions` (the Flex Function App's
  `app_settings` and its two storage role assignments), the module's
  `tests/security_posture.tftest.hcl` / `tests/flex_hosting_behavior.tftest.hcl`
  invariants, `libs/api-interfaces/src/lib/infra-security-posture.spec.ts`, and
  the two MG-24 ADRs amended alongside this one

> **Honest boundary.** The setting, the narrowed guards and this decision are
> **authored and statically validated only** — `terraform test` in
> `modules/functions`, `tf-static-checks.sh`, `tf-plan-secret-inspection.sh` and
> `nx test api-interfaces`. **No live proof is in hand at the time of writing:**
> `azure.functions.webjobs.storage` has **not** yet been observed `Healthy` in
> `FunctionAppLogs`, no `func azure functionapp publish` has yet completed
> without the "app appears to be unhealthy" warning, and the timer probe has not
> yet been seen executing in dev. Those three proofs are specified in
> `docs/infrastructure/mg58-host-storage-verification.md` and are the operator's
> out-of-band gated step. **Do not read a green `terraform test` as "the host can
> reach its storage account."** That inference — a green guard read as an
> operational fact — is the precise error this ticket exists to correct (see
> *The architectural lesson*). The DECISION below is nonetheless binding: it
> records which branch is taken and why, so that a failure at proof time is
> resolved by re-opening with evidence, not by quietly restoring keys.

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

**Rollback is explicitly NOT via shared keys.** If the live proofs do not
produce a `Healthy` row, the setting is reverted and MG-58 is re-opened with
concrete evidence naming the specific element of *this app's* configuration that
managed identity cannot support. "MI was harder" is not that evidence.

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

## Alternatives considered

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
- **The decision is binding before the proofs land** (see the Honest boundary).
  The three live proofs — a positive `Healthy` row sustained across a host
  restart, a clean `func azure functionapp publish`, and an observed
  timer-triggered execution — are specified in
  `docs/infrastructure/mg58-host-storage-verification.md`. Note that the
  *disappearance* of `Unhealthy` rows is **not** proof: the dev Log Analytics
  workspace has a hard ingestion cap, and the defect's own ~30s `Unhealthy` rows
  are themselves ingestion volume that vanishes when the defect is fixed *and*
  when ingestion simply stops.
- **Amended alongside this ADR**, both for stating the retracted premise:
  [`mg-24-flex-consumption-hosting-model`](mg-24-flex-consumption-hosting-model.md)
  (the "Flex still deploys and runs" claim, true of deployment storage and false
  of host storage until this ticket) and
  [`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md)
  (the Storage row, which inferred full managed identity from the *absence* of a
  key-based `AzureWebJobsStorage` and now names the positive setting instead).

# tf-plan-secret-inspection Flex Consumption regression fixtures (MG-24)

These `terraform show -json` fixtures pin the behaviour of
`scripts/tf-plan-secret-inspection.sh` against the **Flex Consumption** hosting
shape introduced by MG-24 (the `azurerm_function_app_flex_consumption` resource
replacing the Y1/EP1 `azurerm_linux_function_app`). They let the fail-closed
plan/state secret gate be exercised deterministically with **no Azure and no
`terraform` binary** — the gate reads a `terraform show -json` document, and each
fixture here IS one.

Run them all with:

```sh
scripts/fixtures/run-flex-secret-gate-fixtures.sh
```

| fixture | expected | proves |
| --- | --- | --- |
| `flex-plan-accepted.json` | **exit 0** | the accepted App Insights residual (managed ikey, `local_authentication_enabled=false`) passes on the flex shape; MI blob deployment storage (`storage_authentication_type=SystemAssignedIdentity`, plain SAS-free `storage_container_endpoint`) and the azapi `Microsoft.Storage/storageAccounts` account body with `allowSharedKeyAccess=false` are accepted; since **MG-58** it also carries the identity-based host-storage setting `AzureWebJobsStorage__accountName`, whose value is an account NAME and therefore not a credential |
| `flex-plan-reenabled-shared-key.json` | **nonzero** | fail-closed when the azapi functions storage account body sets `allowSharedKeyAccess=true` — its in-state account key becomes a live credential (MG-24 point 5). The shared-key-disabled invariant now lives in the azapi body (the account is created over the ARM control plane), not the former azurerm `shared_access_key_enabled` attribute |
| `flex-plan-appsetting-key.json` | **nonzero** | a real `AccountKey=` credential VALUE planted in a flex `app_settings` entry is caught (the app_settings sink walk matches the flex type via the `function_app` substring) |
| `flex-plan-host-storage-connstr.json` | **nonzero** | the credential-carrying bare `AzureWebJobsStorage` connection-string form (with an `AccountKey`) in `app_settings` is caught — the MG-58 negative control. It is a one-setting mutation of `flex-plan-accepted.json`: the identity-based account-name form swapped for the shared-key substitute. The two together pin that the host-storage surface accepts an identity and rejects a credential |
| `flex-plan-siteconfig-key.json` | **nonzero** | a credential VALUE placed in the flex `site_config` block (a sink that did NOT exist on `azurerm_linux_function_app`) is caught — the extended site_config walk |
| `flex-plan-sas-endpoint.json` | **nonzero** | a SAS token (`?...&sig=`) on `storage_container_endpoint` is caught — the deployment blob-container URL must be a plain MI-auth URL, never a shared-key SAS |
| `flex-plan-deploy-storage-key.json` | **nonzero** | a raw `storage_access_key` (opaque base64 account key, NO lexical marker) on the flex deployment-storage config is caught — rejected UNCONDITIONALLY on presence, since the marker classifier alone would let a bare key pass (MG-24 red **dd7ba9** coverage gap) |

The IoT-Hub documented exception set is unchanged: none of these fixtures add a
new authenticating-key allowance.

## assert-live-host-storage LIVE settings fixtures (MG-58)

The `live-appsettings-*.json` fixtures pin the behaviour of
`scripts/assert-live-host-storage.sh`, the post-apply gate that asserts host
storage on the **deployed site** rather than in the configuration. They are a
different input shape from everything above: each one is an
`az functionapp config appsettings list -o json` document — a flat array of
`{"name", "slotSetting", "value"}` entries — not a `terraform show -json` plan.

They exist because MG-58's defect is **not representable on any Terraform
surface**. The pinned azurerm provider (v4.81.0) composes and writes the scalar
`AzureWebJobsStorage` connection string itself on every Function App create and
update, then routes it out of `app_settings` on read, so it is absent from HCL,
from the plan document and from state by construction. Every fixture above was
green while the live site carried the key. The live settings document is the
only place this defect can be seen, so it is the only place it can be pinned.

Run them all with:

```sh
scripts/fixtures/run-live-host-storage-fixtures.sh
```

Exit codes are asserted **exactly**, not as pass/nonzero: the dev apply job's
bounded remediation keys off the difference between `3` (the scalar key is
present — delete that one setting on that one app and re-assert) and `1` (every
other violation, and every operational failure).

| fixture | expected | proves |
| --- | --- | --- |
| `live-appsettings-clean.json` | **exit 0** | the healthy post-remediation site shape passes: the identity form `AzureWebJobsStorage__accountName` present and equal to the `--account-name` the caller resolved from `terraform output`, and no scalar form. This is the harness's only "gate says yes" row, so it is also the positive control the `[shape]`, `[pair]`, `[hygiene]` and `[non-vacuous]` cases guard against drift. It deliberately carries a `DEPLOYMENT_STORAGE_CONNECTION_STRING` entry (the provider's update path injects one) to prove that setting is reported as a non-fatal NOTE and does not fail the gate |
| `live-appsettings-scalar-injected.json` | **exit 3** | the MG-58 defect itself — the credential-carrying scalar `AzureWebJobsStorage` connection string SHADOWING a correct identity form. It is a **one-key mutation** of `live-appsettings-clean.json`, machine-checked as such by the `[pair]` case: strip that one entry and the remainder is byte-identical to the clean document, so the two exit codes differ for exactly one reason. Its value is byte-identical to the string observed on the live dev site on 2026-08-09, empty `AccountKey` and all — the real defect, not a synthetic stand-in. Also pins the `SCALAR_KEY_PRESENT=AzureWebJobsStorage` stdout marker the apply job's remediation reads |
| `live-appsettings-accountname-missing.json` | **exit 1** | fail-closed when the identity form is absent from the live site. The module declares it and the module's terraform tests assert it, so its absence live means the apply did not reach this app — which must never read as "no scalar key found, all clear" |
| `live-appsettings-accountname-mismatch.json` | **exit 1** | the identity form present but pointing at the WRONG account is a violation, not a pass — presence alone is not the assertion. Its value embeds the `MGSENTINELDONOTLOG` sentinel, so this fixture doubles as the targeted redaction control on the mismatch reject path: that path is the one tempted to quote what it found, and it must print `observed=[REDACTED]` |
| `live-appsettings-malformed.json` | **exit 1** | one unusable entry poisons the whole document. It mixes a bare string, a non-string `name`, a nameless object, a nested array and a `null` in alongside a perfectly good identity-form entry: the key comparisons ARE the assertion, so a document whose entries cannot be named reliably cannot be asserted against. Fail-closed, never best-effort |
| `live-appsettings-sentinel.json` | **exit 3** | the whole-surface redaction control. Every VALUE carries the `MGSENTINELDONOTLOG` sentinel and the document is built to drive every reject and NOTE path at once (scalar present, account-name mismatch, an `AzureWebJobsStorage*` variant, a deployment-storage connection string). The harness captures stdout and stderr **separately** and requires the sentinel in neither, and requires the run to have actually rejected — redaction is a vacuous claim on a run that accepted. Sentinels live only in values, never in names, because names are printed by design |

None of these fixtures carries key material. The one connection string reproduced
byte-for-byte from the live site has an **empty** `AccountKey` field — that is
what makes it the defect: the provider composes it from the `storage_access_key`
attribute, which is empty under `storage_authentication_type =
SystemAssignedIdentity`, so the host authenticated with an unusable key against
an account with `allowSharedKeyAccess=false`. It is a forensic fingerprint of
provider injection, **not** a credential and **not** a restore path.

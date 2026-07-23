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
| `flex-plan-accepted.json` | **exit 0** | the accepted App Insights residual (managed ikey, `local_authentication_enabled=false`) passes on the flex shape; MI blob deployment storage (`storage_authentication_type=SystemAssignedIdentity`, plain SAS-free `storage_container_endpoint`) and the azapi `Microsoft.Storage/storageAccounts` account body with `allowSharedKeyAccess=false` are accepted |
| `flex-plan-reenabled-shared-key.json` | **nonzero** | fail-closed when the azapi functions storage account body sets `allowSharedKeyAccess=true` — its in-state account key becomes a live credential (MG-24 point 5). The shared-key-disabled invariant now lives in the azapi body (the account is created over the ARM control plane), not the former azurerm `shared_access_key_enabled` attribute |
| `flex-plan-appsetting-key.json` | **nonzero** | a real `AccountKey=` credential VALUE planted in a flex `app_settings` entry is caught (the app_settings sink walk matches the flex type via the `function_app` substring) |
| `flex-plan-siteconfig-key.json` | **nonzero** | a credential VALUE placed in the flex `site_config` block (a sink that did NOT exist on `azurerm_linux_function_app`) is caught — the extended site_config walk |
| `flex-plan-sas-endpoint.json` | **nonzero** | a SAS token (`?...&sig=`) on `storage_container_endpoint` is caught — the deployment blob-container URL must be a plain MI-auth URL, never a shared-key SAS |
| `flex-plan-deploy-storage-key.json` | **nonzero** | a raw `storage_access_key` (opaque base64 account key, NO lexical marker) on the flex deployment-storage config is caught — rejected UNCONDITIONALLY on presence, since the marker classifier alone would let a bare key pass (MG-24 red **dd7ba9** coverage gap) |

The IoT-Hub documented exception set is unchanged: none of these fixtures add a
new authenticating-key allowance.

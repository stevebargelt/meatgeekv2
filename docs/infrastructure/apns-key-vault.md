# APNs key: the Apple account and the dev Key Vault

The API sends target alerts to the iOS app through Apple Push Notification
service (APNs), dev only, on the APNs sandbox (spec #237). APNs accepts a push
when it carries a provider token: a short JWT signed with the team's APNs key.
That key is held in a Key Vault on dev as a **non-exportable signing key**. The
Function App signs its provider token through Key Vault under its managed
identity, which may sign with the key and may never read or export it.

This page has the owner's steps, in order, and what Terraform does around them.
Nothing on it identifies the Apple account: the team id, the key id and the key
file stay on the owner's machine and in GitHub secrets, never in this
repository, Terraform state, an app setting, a log or an issue.

## What Terraform creates

`modules/apns-key-vault`, switched on by `apns_key_vault_enabled = true` in
`environments/dev.tfvars` (prod does not set it):

| What | Value |
| --- | --- |
| Key Vault | `mgv2-dev-kv-<10 hex>` in `meatgeek-v2-dev-rg`. The suffix is derived from the subscription id, like the Cosmos and storage account names. |
| SKU | `standard`: software-protected keys, billed per operation. |
| Authorisation | Azure RBAC only (`enableRbacAuthorization = true`), no access policies. |
| Soft delete | On (it cannot be turned off), 7-day retention (the minimum; fixed once the vault exists). |
| Purge protection | Off. See [Destroy and recreate](#destroy-and-recreate). |
| Network | Public access on. The Function App runs on Flex Consumption with no VNet and no fixed outbound address; RBAC is the gate. |
| Key | **None.** Terraform never creates, imports or reads a key. The vault is empty after every apply until the owner imports the key, and nothing in the stack needs it to exist. |
| App settings | `APNS_KEY_VAULT_URI` (`https://<vault>.vault.azure.net/`) and `APNS_KEY_NAME` (`apns-auth-key`). Both are names, not secrets. Nothing reads them yet (#243 does). |
| Function App grant | `Key Vault Crypto User` on the vault, for the Function App's system-assigned identity. Behind `apns_key_signer_enabled`, **off** until the owner re-runs `bootstrap.sh` (step 3 below). |

The vault is created over the ARM control plane (azapi), not with
`azurerm_key_vault`, because that resource reads the vault's certificate
contacts over the data plane on every refresh, and no Terraform principal in
this stack holds a Key Vault data-plane role.

### Why `Key Vault Crypto User`, and what else it grants

No built-in role grants `keys/sign/action` alone, and a sign-only custom role
would be a role *definition* write, which the CI apply identity cannot make.
`Key Vault Crypto User` is the narrowest built-in role with sign. Its data
actions, from [Azure built-in roles: Security](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/security#key-vault-crypto-user):
`keys/read`, `keys/update/action`, `keys/backup/action`, `keys/encrypt/action`,
`keys/decrypt/action`, `keys/wrap/action`, `keys/unwrap/action`,
`keys/sign/action`, `keys/verify/action`. For this key:

- `read` returns the public key and the key's attributes. Key Vault never
  returns a private key: "The service doesn't support EXPORT operations. Once a
  key is provisioned, you can't extract it or modify its key material"
  ([Key types, algorithms, and operations](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details#key-operations)).
- encrypt, decrypt, wrap and unwrap do not exist for an EC key, and the key is
  imported with `sign` as its only permitted operation.
- `backup` makes a blob that only Key Vault can restore. It is not the key.
- `update` can change the key's attributes (enabled, dates, tags, permitted
  operations). It cannot change the key material or release it: key release is
  `keys/release/action`, which this role does not have.

So the identity can sign, and at worst disable the key. It can never obtain it.

## The owner's steps

Steps 1 to 4 are on Apple's side; `bin/apple-push-setup` in the owner's
`paperclip-team` repository walks them and records the ids in
`~/.config/meatgeek/apns.env` (mode 600, outside every repository), with the key
file beside it. Steps 5 to 8 are the Key Vault import and the ids for the
deployment.

### 1. Join the Apple Developer Program

Push Notifications, Time Sensitive Notifications and an APNs key all need the
paid program ($99 a year): <https://developer.apple.com/programs/enroll/>. On
**Membership details**, note the 10-character **Team ID**.

### 2. Turn on the push capabilities for the app's identifier

<https://developer.apple.com/account/resources/identifiers/list>: open the App
ID `com.meatgeek.ios` (Xcode may have made it as "XC com meatgeek ios"; if it
is missing, register an explicit App ID with that bundle id). Tick **Push
Notifications** and **Time Sensitive Notifications**, then **Save**.

### 3. Register the widget extension's identifier

Same page, **+**, **App IDs**, **App**: description "MeatGeek Widgets",
explicit bundle id `com.meatgeek.ios.widgets`. The lock-screen extension will
sign under it.

### 4. Create a sandbox APNs key

<https://developer.apple.com/account/resources/authkeys/list>: **+**, name
"MeatGeek APNs dev", tick **Apple Push Notifications service (APNs)**. If
**Configure** appears: environment **Sandbox**, restriction **Team Scoped (All
Topics)**. **Continue**, **Register**, then **Download**: Apple offers the
`AuthKey_<KEYID>.p8` file once only. Note the **Key ID**. Move the file out of
`Downloads` to `~/.config/meatgeek/` with mode 600, and back it up somewhere you
trust (a password manager attachment). Never put it in a repository, an app
setting or an issue.

### 5. Wait for the vault

The vault exists once the pull request that adds it (#241) is merged and
**Apply Dev Infrastructure** is green. Check:

```sh
az keyvault list -g meatgeek-v2-dev-rg --query "[].name" -o tsv
```

It prints one name, `mgv2-dev-kv-` and 10 hex characters.

### 6. Import the key as a non-exportable signing key

Run in a terminal signed in to Azure as yourself (`az login`; `az account show`
names the dev subscription). Importing needs a data-plane role on the vault,
which nobody holds by default: give it to yourself for the import and take it
away afterwards. Terraform cannot make this grant: the CI apply identity may
only grant roles to service principals, and no user id goes in this repository.

```sh
set -a; . ~/.config/meatgeek/apns.env; set +a    # APNS_KEY_ID, APPLE_TEAM_ID, APNS_KEY_PATH
VAULT=$(az keyvault list -g meatgeek-v2-dev-rg --query "[0].name" -o tsv)
VAULT_ID=$(az keyvault show --name "$VAULT" --query id -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv)

# Key Vault Crypto Officer on this vault only, for the import.
az role assignment create --role "Key Vault Crypto Officer" \
  --assignee-object-id "$ME" --assignee-principal-type User --scope "$VAULT_ID" -o none

# The import. A new role can take a few minutes to reach Key Vault: on
# "Forbidden", wait a minute and run this line again.
az keyvault key import --vault-name "$VAULT" --name apns-auth-key \
  --pem-file "$APNS_KEY_PATH" --protection software --ops sign --exportable false -o none
```

The CLI reads the key type and curve from the `.p8` file itself (EC, P-256);
`--kty` and `--curve` apply only to BYOK imports and are not passed. If Azure
refuses `--exportable false` on this standard vault, run the import again
without that flag: a standard vault holds software keys and has no export
operation, so the key cannot be exported either way.

Check what was stored (public parts and attributes only):

```sh
az keyvault key show --vault-name "$VAULT" --name apns-auth-key \
  --query "{kty:key.kty, crv:key.crv, ops:key.keyOps, exportable:attributes.exportable, enabled:attributes.enabled}" -o json
```

Expect `"kty": "EC"`, `"crv": "P-256"`, `"ops": ["sign"]`, `"exportable": false`
(or `null`) and `"enabled": true`. Then remove your grant:

```sh
az role assignment delete --role "Key Vault Crypto Officer" --assignee "$ME" --scope "$VAULT_ID"
```

The role-assignment-write activity-log alert emails for both commands; that is
expected. The `.p8` stays in `~/.config/meatgeek/` as the backup; nothing else
needs it.

### 7. Let the Function App sign with it

This is the `Key Vault Crypto User` grant. Its role is in
`apps/infrastructure/bootstrap/tf-managed-role-allowlist.tsv`, but the CI apply
identity only learns a role when bootstrap runs, so in this order:

1. Re-run `./bootstrap.sh` from `apps/infrastructure/bootstrap` on `main`, as in
   the [bootstrap runbook](./bootstrap-runbook.md#apns-key-signer-grant--re-run-bootstrap-before-setting-apns_key_signer_enabled-241).
2. Only then set `apns_key_signer_enabled = true` in
   `apps/infrastructure/environments/dev.tfvars` (a one-line pull request).

Setting it first fails every dev apply with `AuthorizationFailed`.

### 8. Give the deployment the key id and the team id

Both are identifiers, not secrets, but they name the owner's Apple account and
the repository and its workflow logs are public, so they travel as GitHub
secrets (masked in every log), on the environment the dev apply runs in:

```sh
set -a; . ~/.config/meatgeek/apns.env; set +a
printf '%s' "$APNS_KEY_ID"   | gh secret set APNS_KEY_ID  --repo stevebargelt/meatgeekv2 --env development-infra-apply
printf '%s' "$APPLE_TEAM_ID" | gh secret set APNS_TEAM_ID --repo stevebargelt/meatgeekv2 --env development-infra-apply
```

Nothing reads them yet. #243 passes them to Terraform as sensitive variables
and on to the Function App as `APNS_KEY_ID` and `APNS_TEAM_ID`, beside
`APNS_BUNDLE_ID` (`com.meatgeek.ios`) and `APNS_HOST`
(`api.sandbox.push.apple.com`), which are not account-specific and can be
committed in `dev.tfvars`.

## Destroy and recreate

The vault is protected like every other resource: the dev apply's destroy
guard refuses a plan that deletes it unless the destroy is authorised. If it
is deleted anyway, Key Vault keeps it, key included, soft-deleted for 7 days
under the same name, and a new vault with that name cannot be created until it
is recovered or purged. The CI apply identity can do neither (deleted vaults
live at subscription scope, outside its resource group), so this is an owner
step:

```sh
az keyvault list-deleted --query "[].name" -o tsv
az keyvault recover --name <vault>   # brings the vault and the key back; then re-run the apply
az keyvault purge --name <vault>     # or: destroys it for good; re-import the key afterwards
```

Purge protection is off on purpose. Once on it can never be turned off, and
with it a deleted vault cannot be purged before its retention ends, which would
lock the deterministic name for the whole period. The key is also replaceable
from Apple's side: revoke it and create another (step 4).

## Cost

Facts, read 2026-11-26 from the [Key Vault pricing page](https://azure.microsoft.com/en-us/pricing/details/key-vault/)
and the Azure retail prices API (`serviceName eq 'Key Vault'`, West US 2, USD):

- A standard vault has no monthly charge, and a software-protected key has no
  per-key charge. Billing is per operation.
- Operations on secrets and RSA 2048 keys, including key reads: $0.03 per
  10,000.
- Advanced key operations (ECC, and RSA 3072 and 4096), which is what signing
  with the P-256 key is: $0.15 per 10,000.

With the vault empty, it costs nothing. Once #243 signs, the provider token is
refreshed at most every 20 minutes per running instance, so at most 72 signs a
day per instance: about 2,200 a month for one instance, about $0.03.
APNs itself is free.

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
| App settings | `APNS_KEY_VAULT_URI` (`https://<vault>.vault.azure.net/`), `APNS_KEY_NAME` (`apns-auth-key`), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` (`com.meatgeek.ios`) and `APNS_HOST` (`api.sandbox.push.apple.com`). All are identifiers, not secrets. The API reads them to sign for Apple ([the path to Apple](#the-path-to-apple)). Terraform publishes the key id and team id only when the GitHub secrets below are set. |
| Function App grant | `Key Vault Crypto User` on the vault, for the Function App's system-assigned identity. Behind `apns_key_signer_enabled`, on in dev since the owner re-ran `bootstrap.sh` on 2026-11-26 (step 7 below). |

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
home repository walks them and records the ids in
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

`infra-apply-dev.yml` must pass them to Terraform as `TF_VAR_apns_key_id` and
`TF_VAR_apns_team_id` (two `env:` lines on the apply job, beside `TF_INPUT`:
`TF_VAR_apns_key_id: ${{ secrets.APNS_KEY_ID }}` and
`TF_VAR_apns_team_id: ${{ secrets.APNS_TEAM_ID }}`; the owner adds them, as the
bot that opened #243's pull request may not edit workflows), and Terraform publishes them to the Function App as
`APNS_KEY_ID` and `APNS_TEAM_ID`, beside `APNS_BUNDLE_ID` (`com.meatgeek.ios`)
and `APNS_HOST` (`api.sandbox.push.apple.com`), which are not account-specific
and are committed in `dev.tfvars`. Until the secrets exist the two settings are
absent and the health probe below answers `APNS_KEY_ID_missing`.

## The path to Apple

The API reaches Apple's push service in three steps, all in `apps/api/src/shared/apns/`:

1. **Sign through Key Vault.** `KeyVaultSigner` posts the SHA-256 digest of the
   JWT's signing input to the vault's `keys/<name>//sign` operation (`ES256`)
   under the Function App's managed identity, and gets the raw 64-byte
   signature back, which is exactly a JWT's ES256 signature. The key never
   leaves the vault and is never read.
2. **Cache the provider token.** `ProviderTokenCache` keeps the JWT per
   instance and mints a new one 30 minutes after the last (Apple refuses a
   token older than 60 minutes and throttles minting more often than every 20).
3. **Send over HTTP/2.** `ApnsClient` posts to `https://$APNS_HOST/3/device/<token>`
   with `authorization: bearer <JWT>`, through one transport seam
   (`ApnsTransport`; production is `node:http2`, no dependency). Tests use a fake.

### The dev proof: `GET /health/apns`

The route sends one push to a made-up device token (64 zeros). Apple checks
the provider token before the device token, so:

| Apple answers | Meaning | Route |
| --- | --- | --- |
| `400 BadDeviceToken` | Apple accepted the token the Function App signed | `200 healthy` |
| `403 InvalidProviderToken`, `ExpiredProviderToken`, ... | Apple refused the token | `503`, `error: apns_rejected`, `reason` |
| a Key Vault failure | the identity, the key or its import is wrong | `503`, `key_vault_sign_failed` with Key Vault's status |

The live acceptance proof `apns health` (`apps/api/acceptance/proofs/apns-health.proof.ts`)
runs it in Deploy Dev App. It needs the key imported (step 6) and the two
secrets set (step 8).

### Target alerts (#244)

`recordTargetsReached` sends each reached target to the cook owner's phones
through the same client and provider-token cache (`shared/apns/shared-client.ts`),
so the alerts add no setting and no grant. The `targets reached` acceptance
proof registers the same made-up token as a phone; Apple answering its alert
`BadDeviceToken` makes the API delete it, and the proof sees it gone. See
[Data Flow](../architecture/data-flow.md#6-target-rule).

### If Key Vault cannot sign with the imported key

Two assumptions here come from the documentation and are settled by the first
live run: that an imported EC P-256 `.p8` is signable through Key Vault, and
that the `//sign` path signs with the key's current version. If the proof
fails with `key_vault_sign_failed` / `key_vault_bad_signature` that Key Vault's
status cannot explain by a missing grant or key, put a card to the owner with
the alternatives (for example Managed HSM, or a signing service that holds the
key). **An app setting holding the key is not an alternative.**

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

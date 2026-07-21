# Authentication & Authorization

MeatGeek V2 authenticates API callers with **Azure Entra** via Azure App Service
**Easy Auth** (`auth_settings_v2` / `active_directory_v2`). Authentication is
enforced by the **platform**, in front of the Azure Functions host: every request
is validated against the Entra identity provider **before any function runs**.
There is **no** Supabase, **no** application-layer JWT middleware, and **no**
external auth provider in the V2 stack — the shipped model is bearer-token
*validation* at the platform layer, with no client secret and no sign-in flow.

Ground truth for everything below:
- `apps/infrastructure/modules/functions/main.tf` — the `auth_settings_v2` /
  `active_directory_v2` block on the Function App.
- `apps/infrastructure/bootstrap/bootstrap.sh` — the dev Entra API registration
  that exposes the `access_as_user` scope Easy Auth validates against.

See also
[Terraform Setup → Authentication Integration](../infrastructure/terraform-setup.md#authentication-integration)
and the [bootstrap runbook](../infrastructure/bootstrap-runbook.md).

## Overview

Authentication is a **platform capability**, not application code. The Function
App's `auth_settings_v2` provider terminates authentication before the Functions
host dispatches a request, so the application never implements a token provider,
a sign-in flow, or a JWT-verification middleware. Individual functions are
`authLevel` **anonymous by design** — they are unreachable anonymously anyway
because Easy Auth rejects unauthenticated requests at the platform (`Return401`)
regardless of a function's own level.

## Authentication Architecture

### Why Azure Entra Easy Auth?

- **Fail-closed by construction**: a Terraform precondition refuses to deploy the
  Function App unless an Entra identity provider is configured
  (`var.auth_active_directory_client_id` set), so an anonymous API can never ship.
- **Platform-enforced before any function runs**: `require_authentication = true`
  with `unauthenticated_action = "Return401"` means a missing/invalid bearer token
  is rejected with **401** independent of a function's `authLevel`.
- **No long-lived secret**: Easy Auth only *validates* bearer tokens — **no client
  secret** is set, and no token is stored at rest (`token_store_enabled = false`).
- **Calling-client restricted**: `allowed_applications` validates the calling
  client's `appid`/`azp` claim, so only pre-authorized clients are accepted.
- **First-class Azure integration**: the identity provider is wired through the
  same Terraform apply as the rest of the V2 stack; the dev Entra API registration
  is created by the bootstrap.

### Request Flow

```
┌─────────────────┐   Authorization:    ┌──────────────────────┐   validated    ┌──────────────────┐
│  Caller (CLI,   │   Bearer <token>    │  Function App        │   request      │  Azure Functions │
│  mobile, web,   │────────────────────▶│  Easy Auth           │───────────────▶│  host + function │
│  service)       │                     │  (auth_settings_v2)  │                │  (authLevel      │
└─────────────────┘                     └──────────────────────┘                │   anonymous)     │
                                                  │                             └──────────────────┘
                                     401 (Return401) on missing/
                                     invalid/wrong-audience/wrong-
                                     client token — function never runs
```

**Key points:**
- The caller acquires an Entra bearer token for the API's delegated
  `access_as_user` scope (`api://<dev-api-app-id>/access_as_user`) and presents it
  as an `Authorization: Bearer <token>` header.
- Easy Auth validates the token's **audience** (`allowed_audiences` = the API App
  ID URI) and the **calling client** (`allowed_applications` = the pre-authorized
  client id) at the platform layer — the function never sees an unauthenticated
  request.
- CosmosDB remains the application data store; access to it is via the Function
  App's **managed identity**, not the caller's token.

## Platform-Layer Token Validation

Token validation is performed by **Easy Auth at the platform layer** (not by
application code), against the Entra identity provider configured in
`modules/functions/main.tf`:

1. **Signature & issuer**: the token is validated against the Entra tenant's
   published signing keys; the issuer is fixed by
   `tenant_auth_endpoint = https://login.microsoftonline.com/<tenant-id>/v2.0`.
2. **Expiration**: expired tokens are rejected.
3. **Audience** (`allowed_audiences`): the token's `aud` must match the API App ID
   URI (`api://<dev-api-app-id>`) — the dev Entra API registration.
4. **Calling client** (`allowed_applications`): the calling client's `appid`/`azp`
   must be one of the pre-authorized client ids (the Azure CLI public client
   `04b07795-8ddb-461a-bbee-02f9e1bf7b46` by default, or a dedicated dev client). A
   token minted by any other client is rejected.

The provider is deliberately configured as bearer-validation-only:

- `www_authentication_disabled = true` — no `WWW-Authenticate` browser sign-in
  challenge is emitted; an unauthenticated request gets a clean **401**.
- `token_store_enabled = false` — no token is persisted at rest.
- **No client secret** is set anywhere in the provider.

### The `active_directory_v2` block (as shipped)

The provider block is present **only** when the Entra API registration is
configured (`var.auth_active_directory_client_id != ""`); otherwise the module
precondition refuses the plan (fail-closed). When present it is, in essence:

```hcl
auth_settings_v2 {
  auth_enabled           = true
  require_authentication = true
  unauthenticated_action = "Return401"

  active_directory_v2 {
    client_id                   = var.auth_active_directory_client_id      # dev API registration
    tenant_auth_endpoint        = "https://login.microsoftonline.com/<tenant-id>/v2.0"
    allowed_audiences           = var.auth_allowed_audiences               # ["api://<dev-api-app-id>"]
    allowed_applications        = var.auth_allowed_client_app_ids          # the CALLING client(s)
    www_authentication_disabled = true
  }

  login {
    token_store_enabled = false
  }
}
```

> `allowed_applications` binds the **calling client**, not the API registration —
> the API is never the caller. Azure Easy Auth treats an *empty*
> `allowed_applications` as "no calling-client restriction", so a module
> precondition also requires `auth_allowed_client_app_ids` to be non-empty once
> auth is enabled.

## The `access_as_user` Scope & Acquiring a Token

The dev Entra **API registration** (created by `bootstrap.sh`, not Terraform)
exposes a single **delegated** OAuth2 scope, `access_as_user`, on the App ID URI
`api://<dev-api-app-id>`. Calling clients (the Azure CLI public client by default)
are listed as `preAuthorizedApplications` for that scope, so a token can be
acquired without an interactive consent prompt.

Acquire a bearer token for the scope with the Azure CLI:

```bash
# <dev-api-app-id> is the dev API registration's client id emitted by bootstrap.sh
# (DEV_API_CLIENT_ID / functions_auth_client_id). The App ID URI is api://<dev-api-app-id>.
APP_ID_URI=$(az ad app show --id <dev-api-app-id> --query 'identifierUris[0]' -o tsv)
az account get-access-token --scope "${APP_ID_URI}/access_as_user"
```

The coordinates the operator wires into `environments/dev.tfvars` after bootstrap:

```hcl
functions_auth_client_id              = "<dev-api-app-id>"
functions_auth_tenant_id              = "<tenant-id>"
functions_auth_allowed_audiences      = ["api://<dev-api-app-id>"]
functions_auth_allowed_client_app_ids = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]  # calling client(s)
```

## Presenting the Token & Failure Behavior

Present the acquired token as a standard bearer header on every API request:

```
Authorization: Bearer <token>
```

| Condition | Result |
| --- | --- |
| Valid token: correct issuer, unexpired, `aud` in `allowed_audiences`, calling `appid`/`azp` in `allowed_applications` | Request is forwarded to the Functions host and the target function runs |
| No `Authorization` header, or a malformed/expired token | **401** (`unauthenticated_action = Return401`) — no `WWW-Authenticate` challenge, function never runs |
| Wrong audience (token `aud` not in `allowed_audiences`) | **401** — rejected at the platform |
| Wrong calling client (`appid`/`azp` not pre-authorized) | **401** — rejected at the platform |

Because the check happens ahead of the Functions host, a 401 here is produced by
the platform, not by any application code — there is no application 401 path to
maintain.

## What Is *Not* Implemented

To be explicit, the following do **not** exist in the V2 stack:

- **No application-layer JWT middleware.** There is no `libs/auth` token-verifying
  middleware, no `@supabase/supabase-js` / `supabase.auth.getUser`, and no
  `jsonwebtoken` verification in `apps/`/`libs/`. Validation is entirely
  platform-layer.
- **No client secret.** Neither the Easy Auth provider nor the dev API
  registration holds a client secret — the model is token *validation* only.
- **No Supabase.** No `SUPABASE_URL` / `SUPABASE_ANON_KEY` (or any other
  auth-provider) app settings exist on the Function App; there is no Supabase SDK
  in the client or mobile apps.
- **No `iss: supabase` token shape.** Tokens are Entra v2 access tokens issued by
  `https://login.microsoftonline.com/<tenant-id>/v2.0`.

## Related Documentation

- [Terraform Setup → Authentication Integration](../infrastructure/terraform-setup.md#authentication-integration)
  — the `auth_settings_v2` configuration and fail-closed preconditions in context.
- [Bootstrap runbook](../infrastructure/bootstrap-runbook.md) — the dev Entra API
  registration and the authenticated smoke test that exercises this path end-to-end.
- [Azure Functions API → Application Settings](./azure-functions.md#application-settings)
  — the non-secret, identity-based service wiring the Function App runs under.

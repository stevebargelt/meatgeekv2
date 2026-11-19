# Azure Functions Module for MeatGeek V2 — FLEX CONSUMPTION hosting (MG-24)
#
# Hosting model (MG-24, 2026-07-23): a SINGLE Flex Consumption model runs BOTH
# dev and prod, replacing the inherited Y1(dev)/EP1(prod) split. Flex deploys the
# package from an MI-authenticated BLOB container (not an Azure Files content
# share that requires a shared key), so the functions storage account keeps
# shared_access_key_enabled=false.
#
# Flex still requires a service plan, but of SKU "FC1" (the Flex Consumption
# plan), NOT Y1/EP1. The site's serverFarmId points at it.
#
# OWNERSHIP (HAR-15): the Function App site and its Easy Auth config are azapi
# resources, NOT the azurerm Flex Function App resource. The azurerm resource
# injected a scalar AzureWebJobsStorage connection string on every create and
# update; see the block comment above azapi_resource.function_app and the MG-58
# ADR (learnings/decisions/mg-58-host-storage-managed-identity.md).
#
# Security posture (MG-24 S1/S2):
#   * The Function App runs under a SYSTEM-ASSIGNED MANAGED IDENTITY. Runtime
#     access to Cosmos / Storage / Event Hub (IoT telemetry) / SignalR is
#     identity-based (RBAC + non-secret endpoints) — NO connection strings or
#     primary keys are placed in app settings or Terraform state.
#   * Deployment storage is identity-based: functionAppConfig deployment storage
#     authenticates with "SystemAssignedIdentity" against a blobContainer on the
#     functions storage account, which KEEPS allowSharedKeyAccess=false — so no
#     storage account key is written to state and no shared key can leak.
#     BOTH the storage account AND its deployment container are created via azapi
#     over the ARM CONTROL PLANE, because the azurerm_storage_account resource
#     itself performs shared-key storage DATA-PLANE reads that 403 on a shared-key-
#     disabled account with storage_use_azuread unset (MG-24 operational fix).
#   * HOST storage is a SEPARATE authentication surface from deployment storage,
#     on the SAME account (MG-58). Deployment storage is configured by
#     functionAppConfig; the host's own required storage is configured by the
#     AzureWebJobsStorage__accountName app setting — the identity-based,
#     account-name form, which carries no credential. Neither surface implies the
#     other, so they are asserted as two independent invariants. Because azapi
#     sends the complete settings collection and nothing else writes it, this
#     module is now authoritative for BOTH the presence of that setting AND the
#     absence of the scalar AzureWebJobsStorage / DEPLOYMENT_STORAGE_CONNECTION_STRING
#     forms. The live host-storage gate in infra-apply-dev.yml still checks the
#     deployed site after every apply.
#   * Application Insights ingestion is identity-based (AAD): the managed
#     identity is granted 'Monitoring Metrics Publisher' on the App Insights
#     resource (root module) and the host authenticates telemetry via
#     APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD. The FULL
#     TF-managed connection string (InstrumentationKey included, as Microsoft
#     requires) is placed in app settings, but the ikey CANNOT authenticate
#     ingestion because the AI resource sets local_authentication_enabled=false
#     (AAD-only). This residual is safe ONLY while local auth stays disabled —
#     enforced by the pre-apply secret-inspection gate. See the MG-24 ADR.
#   * CORS is explicit per-environment (no wildcard). App Service Authentication
#     is FAIL-CLOSED: the module refuses to deploy (plan precondition) unless an
#     Entra identity provider is configured, so an anonymous Function App can
#     never be shipped; once configured every request is validated at the
#     platform layer (Return401 on no/invalid token) before any function runs.

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    # azapi creates BOTH the Functions storage ACCOUNT
    # (Microsoft.Storage/storageAccounts) and the Flex deployment BLOB container
    # (Microsoft.Storage/storageAccounts/blobServices/containers) over the ARM
    # CONTROL PLANE — same pattern the native-otlp module uses for its DCR.
    # Control-plane creation sidesteps the storage DATA-plane entirely: neither the
    # account's OWN reads (a data-plane azurerm_storage_account performs
    # blob-service/queue/share reads that 403 on a shared-key-disabled account) nor
    # the container create needs a Storage Blob Data role or storage_use_azuread on
    # the apply principal against an account THIS apply creates. See the MG-24 ADR.
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

locals {
  # Globally-unique storage account name. Storage account names must be 3-24
  # chars, lowercase alphanumeric only (no hyphens). Like the Cosmos account
  # name, this is derived from a subscription-scoped hash (passed in by the
  # root as var.storage_account_name) so a greenfield apply cannot collide with
  # a pre-existing account anywhere in Azure. The substr() is a defensive cap.
  functions_storage_account_name = substr(var.storage_account_name, 0, 24)

  # Name of the Flex deployment-package blob container (target of the OneDeploy
  # package ZIP). Held as a local so the container resource, the Function App's
  # storage_container_endpoint, the app-deploy role-assignment scope, and the
  # module output all reference ONE source of truth.
  deployment_container_name = "deployment-package"

  # Plain blob-container URL built from the account name (no SAS, no AccountKey),
  # so it carries no secret into state. The account is created via azapi (control
  # plane) and exposes no azurerm primary_blob_endpoint attribute, so the endpoint
  # is composed from the deterministic account name + the container name.
  deployment_container_endpoint = "https://${local.functions_storage_account_name}.blob.core.windows.net/${local.deployment_container_name}"

  # Globally-unique Function App name: <name>.azurewebsites.net must be unique
  # across all of Azure, so the subscription-derived global_suffix is appended
  # (the same suffix the IoT Hub / Event Hubs / SignalR names use). "-func-" + 12
  # hex chars keeps it inside the 60-char Function App limit.
  function_app_name = "${var.resource_prefix}-func-${var.global_suffix}"

  # ARM api-version for the site and its config children. One value, so the
  # resources and the import ids the root module builds (outputs.tf) agree.
  web_api_version = "2024-04-01"

  # The site's resource id, derived from inputs alone so it is known at plan
  # time without reading the site. The root module's import block uses it
  # (through the function_app_import_ids output); referencing the resource's
  # own id there would be a cycle.
  function_app_resource_id = "${var.resource_group_id}/providers/Microsoft.Web/sites/${local.function_app_name}"

  # THE COMPLETE APP SETTINGS COLLECTION for the Function App (HAR-15).
  #
  # azapi_resource.function_app sends this map as siteConfig.appSettings, and a
  # site PUT REPLACES the whole collection. So this is not "the settings we add";
  # it is every setting the app has after an apply. Declare every setting the app
  # needs and nothing else.
  #
  # Deliberately ABSENT, and asserted absent by the module tests and
  # tf-static-checks.sh:
  #   * scalar `AzureWebJobsStorage` — a connection string. With shared keys
  #     disabled it can only carry an empty or unusable AccountKey, and the host
  #     reads it BEFORE the identity form, so its presence kills host storage
  #     (MG-58).
  #   * `DEPLOYMENT_STORAGE_CONNECTION_STRING` — the connection-string form of
  #     deployment storage auth. Deployment storage authenticates by managed
  #     identity in functionAppConfig, so no connection string is needed (MG-61).
  #   * Flex-forbidden classic settings (FUNCTIONS_WORKER_RUNTIME,
  #     FUNCTIONS_EXTENSION_VERSION, WEBSITE_NODE_DEFAULT_VERSION, WEBSITE_CONTENT*,
  #     WEBSITE_RUN_FROM_PACKAGE, WEBSITE_TIME_ZONE). Flex declares the runtime in
  #     functionAppConfig and manages the extension version and package mount;
  #     FUNCTIONS_WORKER_RUNTIME fails a Flex create with 400 BadRequest
  #     (ExtendedCode 51021).
  function_app_settings = {
    # HOST STORAGE — identity-based, ACCOUNT-NAME form (MG-58).
    #
    # The host resolves this against the app's system-assigned managed identity
    # to reach its own required storage (host lock / singleton leases, timer
    # schedule status, key store). It carries a NAME, not a credential, so it is
    # compatible with allowSharedKeyAccess=false and nothing secret reaches state.
    #
    # WHY THE ACCOUNT-NAME FORM AND NOT `AzureWebJobsStorage__blobServiceUri` &c:
    # the two forms are ALTERNATIVES, and publishing both (or the wrong one) is
    # its own defect. The service-URI form is for accounts the host cannot address
    # by standard Azure DNS (sovereign clouds, custom or private endpoints). This
    # account is a plain Standard_LRS StorageV2 account on public-cloud DNS with
    # no private endpoint, no VNet integration and no network restriction, and the
    # deployment endpoint above is likewise composed against
    # `blob.core.windows.net`. NOTE FOR THE FUTURE: if this app moves behind
    # private endpoints / VNet integration (MG-34), revisit this choice.
    "AzureWebJobsStorage__accountName" = local.functions_storage_account_name

    # Application Insights — identity-based (AAD) telemetry ingestion. The FULL
    # TF-managed connection string (InstrumentationKey included, required by
    # Microsoft as the destination-resource identifier even under Entra-only
    # ingestion) is the destination; Authorization=AAD makes the host
    # authenticate with an AAD token. The ikey CANNOT authenticate because
    # local_authentication_enabled=false on the AI resource. This
    # ikey-in-state residual is safe ONLY while local auth stays disabled — the
    # pre-apply secret-inspection gate enforces that coupling on this setting.
    #
    # Under azurerm this string travelled in the native
    # site_config.application_insights_connection_string field, which the
    # provider turned into this same app setting on the wire. azapi has no such
    # translation, so it is declared here directly.
    "APPLICATIONINSIGHTS_CONNECTION_STRING"     = var.application_insights_connection_string
    "APPLICATIONINSIGHTS_AUTHENTICATION_STRING" = "Authorization=AAD"
    "APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE"   = "50"

    # Cosmos DB — identity-based. Endpoint is non-secret; data-plane access is
    # granted via the Cosmos SQL role assignment in the root module.
    "COSMOSDB__accountEndpoint" = var.cosmos_account_endpoint

    # Which DATABASE inside that account the API talks to (MG-51). A plain app
    # setting read by the API's own code (process.env.COSMOSDB_DATABASE_NAME),
    # NOT a `__`-suffixed binding property. It is a name, not a resource bound to
    # the database, so a database replacement leaves it byte-identical and no
    # replacement propagation is needed (unlike the MG-48 IoT Hub endpoint).
    "COSMOSDB_DATABASE_NAME" = var.cosmos_database_name

    # Which CONTAINER the cooks handlers read and write (MG-59). Read by the cooks
    # adapter with a fail-loud guard (no default), and Terraform-owned: it comes
    # from the cosmos-db module output threaded through the root, never a literal
    # restated here. Plain app setting, name not credential.
    "COSMOSDB_COOKS_CONTAINER_NAME" = var.cooks_container_name

    # The other four entity containers in the same shared-throughput database
    # (HAR-19), published the same way and for the same reason as cooks: each
    # comes from the cosmos-db module output via the root, never a literal here.
    "COSMOSDB_DEVICES_CONTAINER_NAME"      = var.devices_container_name
    "COSMOSDB_TEMPERATURES_CONTAINER_NAME" = var.temperatures_container_name
    "COSMOSDB_USERS_CONTAINER_NAME"        = var.users_container_name
    "COSMOSDB_RECIPES_CONTAINER_NAME"      = var.recipes_container_name

    # IoT telemetry (Event Hubs-compatible) — identity-based. The fully-qualified
    # namespace is non-secret; the identity is granted Azure Event Hubs Data
    # Receiver in the root module.
    "IOTHUB_EVENTS__fullyQualifiedNamespace" = var.eventhub_namespace_fqdn

    # SignalR — identity-based. Service URI is non-secret; the identity is
    # granted SignalR Service Owner in the root module.
    "AzureSignalRConnectionString__serviceUri" = var.signalr_service_uri

    # Which environment this app runs in ("dev" or "prod", validated on the
    # variable). A plain, non-secret label the running app can read (HAR-17).
    # Nothing reads it yet; it is also the Terraform-made setting change whose
    # merge proves the dev apply -> deploy -> acceptance chain (goal HAR-9 item 7).
    "MEATGEEK_ENVIRONMENT" = var.environment
  }
}

# Storage account for Azure Functions — created via azapi over the ARM CONTROL
# PLANE (Microsoft.Storage/storageAccounts@2023-05-01), NOT azurerm_storage_account.
#
# WHY azapi and not azurerm (MG-24 operational fix — 403'd twice on live Azure):
# the azurerm_storage_account RESOURCE performs its OWN storage DATA-PLANE reads —
# a blob-service-availability poll on create, and queue/blob/share property reads
# on refresh — using SHARED-KEY auth by default. With allowSharedKeyAccess=false
# and the provider's storage_use_azuread deliberately unset, those reads 403
# (KeyBasedAuthenticationNotPermitted): the original Y1 apply AND the Flex
# destroy-refresh both failed here, on the account's OWN reads (not the container).
# Creating the account over the ARM control plane — the same pattern as the
# deployment container below and the native-otlp DCR — performs NO storage
# data-plane operation at plan/apply for ANY terraform principal, so the account
# can keep shared key disabled with no storage_use_azuread and no pre-apply
# data-plane grant for the apply or CI identities. See the MG-24 ADR.
#
# Identity-based storage: allowSharedKeyAccess=false so no account key can be used
# (or leak into state). The Function App's managed identity is granted the
# Blob/Queue data roles below and reads the package ZIP from the blob deployment
# container at runtime over that identity (functionAppConfig deployment storage
# authentication = SystemAssignedIdentity on azapi_resource.function_app).
resource "azapi_resource" "functions_storage" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = local.functions_storage_account_name
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  body = {
    # Standard_LRS StorageV2 — carried 1:1 from the former azurerm resource
    # (account_tier="Standard" + account_replication_type="LRS" => Standard_LRS;
    # azurerm's default account_kind was StorageV2).
    sku = {
      name = "Standard_LRS"
    }
    kind = "StorageV2"
    properties = {
      # min_tls_version = "TLS1_2" on the former azurerm resource.
      minimumTlsVersion = "TLS1_2"
      # shared_access_key_enabled = false — the secrets-out-of-state invariant,
      # now expressed in the azapi body. No account key can authenticate or leak.
      allowSharedKeyAccess = false
      # Private storage — no anonymous blob access; HTTPS only.
      allowBlobPublicAccess    = false
      supportsHttpsTrafficOnly = true
    }
  }
}

# Deployment package container (Flex Consumption). Flex reads the deployed
# package ZIP from THIS blob container, authenticated by the Function App's
# managed identity (deployment storage authentication = SystemAssignedIdentity on
# azapi_resource.function_app below).
#
# Created via azapi over the ARM CONTROL PLANE
# (Microsoft.Storage/storageAccounts/blobServices/containers) rather than
# azurerm_storage_container, which is a storage DATA-PLANE operation. That
# distinction is load-bearing here (MG-24 red 2f5154 / b08ced): the account sets
# shared_access_key_enabled=false, and it is CREATED BY THIS APPLY — so a
# data-plane container create would require the apply principal to already hold a
# Storage Blob Data role on an account that does not exist until mid-apply (a
# same-apply chicken-and-egg that 403s, or forces a fragile pre-apply data-plane
# grant + RBAC-propagation wait). The control-plane create needs only the
# resource-management permission the apply principal already has (Contributor on
# the RG), so the FIRST apply is executable with NO manual pre-grant and the
# provider no longer needs the storage_use_azuread data-plane switch.
#
# publicAccess = "None": private container, never anonymously readable — the
# package ZIP is fetched by the Function App's managed identity, so no public
# blob access is ever needed.
resource "azapi_resource" "deployment_container" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = local.deployment_container_name
  parent_id = "${azapi_resource.functions_storage.id}/blobServices/default"

  body = {
    properties = {
      publicAccess = "None"
    }
  }
}

# App Service Plan for Azure Functions — FLEX CONSUMPTION (SKU FC1). Flex
# requires a plan (the site's serverFarmId), but it is the Flex plan, not Y1/EP1. Billing is per-execution GB-s with
# scale-to-zero when always_ready=0 (dev) and an always-ready baseline (prod).
resource "azurerm_service_plan" "functions" {
  name                = "${var.resource_prefix}-func-plan"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "FC1"

  tags = var.tags
}

# Azure Function App — Flex Consumption, OWNED SOLELY BY azapi (HAR-15).
#
# WHY azapi AND NOT THE azurerm FLEX FUNCTION APP RESOURCE. The pinned azurerm
# provider (hashicorp/azurerm v4.81.0, and still at v5.14.0) writes a scalar
# `AzureWebJobsStorage` connection string with an EMPTY AccountKey into this
# app's settings on EVERY create and EVERY update, whatever
# storage_authentication_type says, and hides it again on read. Its Flex
# expander (helpers/function_app_schema.go,
# ExpandSiteConfigFunctionFlexConsumptionApp) appends the key with no branch on
# the authentication type; the update path also writes
# DEPLOYMENT_STORAGE_CONNECTION_STRING. The Functions host resolves the scalar
# form before AzureWebJobsStorage__accountName, so every in-place update of the
# app killed host storage and failed the dev apply at the live host-storage gate.
# No HCL on that resource can stop it (MG-58 ADR, "Alternatives considered").
#
# So azapi is the SOLE owner of the whole site, the same precedent as
# azapi_resource.functions_storage above. Its PUT carries the COMPLETE app
# settings collection declared below and nothing else, so nothing injects a key.
# That is safe ONLY because no other resource writes Microsoft.Web/sites/<app> or
# any of its config/* children: Easy Auth lives on its own azapi
# config/authsettingsV2 resource below, which does not touch app settings, and
# tf-static-checks.sh refuses any azurerm site-writing resource in this stack.
# This is NOT the co-owner design MG-58 rejected (azapi PUTting the
# replace-whole-collection config/appsettings child while azurerm still owned the
# site): here there is one writer for the site and one for authsettingsV2.
#
# MIGRATION: the root module adopts the existing dev site with an `import` block
# and drops the azurerm resource with `removed { destroy = false }`, so the site
# and its system-assigned identity (and therefore every role assignment's
# principal) are never recreated. See the root main.tf.
#
# ignore_casing: ARM echoes some values in a different case from the one sent
# (serverFarmId's `serverfarms` segment, for one). Without this the read-back
# body would differ from config on case alone and the post-apply drift plan
# would never converge.
resource "azapi_resource" "function_app" {
  type      = "Microsoft.Web/sites@${local.web_api_version}"
  name      = local.function_app_name
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  ignore_casing = true

  # System-assigned managed identity: the runtime credential for all
  # identity-based service access (deployment storage, host storage, Cosmos,
  # Event Hub, SignalR, App Insights). Imported with the site, never recreated.
  identity {
    type = "SystemAssigned"
    # LOAD-BEARING (HAR-16): keeps principal_id KNOWN on every plan, so the six
    # role assignments that read identity_principal_id are never replaced.
    # azapi v2.11.0 internal/services/azapi_resource.go:581-587 (ModifyPlan)
    # copies the state identity (principal_id, tenant_id) into the plan ONLY when
    # planIdentity.Type.Equal(stateIdentity.Type) &&
    # planIdentity.IdentityIDs.Equal(stateIdentity.IdentityIDs). The comparison
    # is strict: state holds identity_ids = [], an omitted attribute plans null,
    # [] != null, so principal_id went "(known after apply)" and principal_id is
    # ForceNew on azurerm_role_assignment and
    # azurerm_cosmosdb_sql_role_assignment. Apply Dev Infrastructure run
    # 44413716132 planned 6 to destroy for exactly this and the destroy guard
    # refused it. Do not remove; tf-static-checks.sh check 9c and the
    # system_identity_keeps_principal_id_known test guard it.
    identity_ids = []
  }

  body = {
    kind = "functionapp,linux"
    properties = {
      # Flex still needs a plan, but it is the FC1 Flex plan above.
      serverFarmId = azurerm_service_plan.functions.id

      functionAppConfig = {
        # MI-authenticated blob deployment storage: NO Azure Files content share,
        # NO shared key, NO connection-string setting name. The endpoint is a plain
        # blob-container URL (no SAS, no AccountKey), so it carries no secret.
        deployment = {
          storage = {
            type  = "blobContainer"
            value = local.deployment_container_endpoint
            authentication = {
              type = "SystemAssignedIdentity"
            }
          }
        }

        # Node 24 runtime (matches the API's engines.node). Flex declares the
        # worker runtime HERE; FUNCTIONS_WORKER_RUNTIME as an app setting is
        # rejected on a Flex site (400 BadRequest, ExtendedCode 51021).
        runtime = {
          name    = "node"
          version = "24"
        }

        # Flex scale knobs (per-env via tfvars). instanceMemoryMB +
        # maximumInstanceCount bound the per-instance footprint and the ceiling.
        #
        # Always-ready instances: dev sets always_ready=0 => an EMPTY list =>
        # scale-to-zero (~$0 idle). prod sets always_ready>=1 => one warm "http"
        # group (the built-in group covering all HTTP-triggered functions) so the
        # first request after idle is not cold.
        scaleAndConcurrency = {
          instanceMemoryMB     = var.instance_memory_in_mb
          maximumInstanceCount = var.maximum_instance_count
          alwaysReady = [
            for instances in(var.always_ready > 0 ? [var.always_ready] : []) : {
              name          = "http"
              instanceCount = instances
            }
          ]
        }
      }

      siteConfig = {
        # The COMPLETE app settings collection. A site PUT replaces the whole
        # collection, so this list IS the app's settings: what is not here is
        # removed. See local.function_app_settings for each setting's reason.
        appSettings = [
          for setting_name in sort(keys(local.function_app_settings)) : {
            name  = setting_name
            value = local.function_app_settings[setting_name]
          }
        ]

        # Explicit per-environment allowed origins (no wildcard). An empty list
        # permits no cross-origin browser access. supportCredentials stays false
        # unless a cookie/credential design requires it.
        cors = {
          allowedOrigins     = var.cors_allowed_origins
          supportCredentials = false
        }

        # TLS 1.2 floor on the app and its SCM endpoint — the values the azurerm
        # resource sent by default, now stated rather than inherited.
        minTlsVersion    = "1.2"
        scmMinTlsVersion = "1.2"
      }
    }
  }

  # Read back the default hostname for the module outputs.
  response_export_values = ["properties.defaultHostName"]

  # The deployment blob container must exist before the app binds to it. The
  # endpoint is a composed URL string, not a reference to the container
  # resource, so declare the ordering explicitly.
  depends_on = [azapi_resource.deployment_container]
}

# App Service Authentication (Easy Auth), config/authsettingsV2. FAIL-CLOSED.
#
# Its own azapi resource, not part of the site body: authsettingsV2 is a
# separate ARM config child with its own PUT, and it does not touch app settings,
# so it cannot reintroduce a settings writer.
#
# API/bearer-token VALIDATION only, NOT an interactive sign-in flow: no client
# secret (client-secret-free bearer validation), allowedAudiences carries the API
# App ID URI, the WWW-Authenticate challenge is disabled (a clean 401 with no
# browser challenge), and the token store is disabled (no token at rest).
#
# allowedApplications validates the CALLING CLIENT's appid/azp claim, NOT the API
# registration, so it is var.auth_allowed_client_app_ids (the smoke-test client:
# the Azure CLI public client by default, or a dedicated dev client). A token
# minted by any other client is rejected at the platform layer. Binding the API
# registration's OWN client id there would be wrong: the API is never the caller.
#
# The body mirrors what azurerm's auth_settings_v2 block sent on this app
# (platform runtime ~1, HTTPS required, /.auth route prefix, no forward proxy,
# nonce validation, fixed 8h cookie expiry, 72h token refresh extension), so
# moving ownership changes nothing about how a request is authenticated.
resource "azapi_resource" "function_app_auth" {
  type      = "Microsoft.Web/sites/config@${local.web_api_version}"
  name      = "authsettingsV2"
  parent_id = azapi_resource.function_app.id

  ignore_casing = true

  body = {
    properties = {
      platform = {
        enabled        = true
        runtimeVersion = "~1"
      }
      globalValidation = {
        requireAuthentication       = true
        unauthenticatedClientAction = "Return401"
      }
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            clientId     = var.auth_active_directory_client_id
            openIdIssuer = "https://login.microsoftonline.com/${var.auth_active_directory_tenant_id}/v2.0"
          }
          login = {
            disableWWWAuthenticate = true
          }
          validation = {
            allowedAudiences = var.auth_allowed_audiences
            defaultAuthorizationPolicy = {
              allowedApplications = var.auth_allowed_client_app_ids
            }
          }
        }
      }
      login = {
        tokenStore = {
          enabled                    = false
          tokenRefreshExtensionHours = 72
        }
        preserveUrlFragmentsForLogins = false
        nonce = {
          validateNonce           = true
          nonceExpirationInterval = "00:05:00"
        }
        cookieExpiration = {
          convention       = "FixedTime"
          timeToExpiration = "08:00:00"
        }
      }
      httpSettings = {
        requireHttps = true
        routes = {
          apiPrefix = "/.auth"
        }
        forwardProxy = {
          convention = "NoProxy"
        }
      }
    }
  }

  lifecycle {
    # ARM echoes the PARENT SITE's tags on this proxy resource, and Terraform can
    # never converge them any other way (HAR-17, Apply Dev Infrastructure run
    # 44418353799: the final drift plan showed `tags {...} -> null` right after an
    # apply that had just "removed" them). The chain, in azapi v2.11.0:
    #   * Read (internal/services/azapi_resource.go:1068-1070) stores the GET
    #     response's `tags` in state, and GET of config/authsettingsV2 returns the
    #     site's tags. ImportState (:1292-1294) does the same.
    #   * ModifyPlan (:663-666) plans tagsWithDefaultTags(config.Tags, ...)
    #     (:1422-1461): config tags are null, the body has none, there are no
    #     provider default_tags, and state tags are non-empty, so it returns null
    #     and plans `tags -> null` plus an unknown output.
    #   * expandBody (:1589-1591) adds tags to the PUT only when non-empty, so the
    #     apply sends none, ARM keeps echoing the site's tags, and the next refresh
    #     puts them back.
    # Declaring `tags = var.tags` instead is refused: the embedded schema for
    # Microsoft.Web/sites/config@2024-04-01 (authsettingsV2) has no `tags`
    # property, and schemaValidate (internal/services/resource.go:66-69, 106-124)
    # fails "`tags` is not expected here".
    # ignore_changes works because Terraform core rewrites the CONFIG the provider
    # sees before PlanResourceChange (terraform v1.9.8,
    # internal/terraform/node_resource_abstract_instance.go:897-904, 947-949):
    # config tags become the state tags, so tagsWithDefaultTags returns them at
    # rule 1 (:1423-1426), plan == state, and nothing changes. tags ONLY: body,
    # identity and every other attribute stay fully managed. tf-static-checks.sh
    # check 9d and the auth_config_ignores_echoed_parent_tags test guard this line.
    ignore_changes = [tags]

    # Fail-closed: refuse to deploy without platform authentication. Azure
    # requires at least one identity provider, so an empty client id cannot
    # produce valid auth settings; the plan is refused rather than shipping an
    # anonymous Function App. Populate auth_active_directory_client_id from the
    # dev API Entra registration (MG-24 bootstrap runbook) before applying.
    precondition {
      condition     = var.auth_active_directory_client_id != ""
      error_message = "Function App Easy Auth is not configured: set auth_active_directory_client_id to the dev API Entra registration client id (MG-24 runbook). An empty value cannot produce valid authsettingsV2 (Azure requires >=1 identity provider), so deployment is refused fail-closed rather than shipping an anonymous Function App."
    }
    # Easy Auth is all-or-nothing: the issuer (from tenant_id) fixes which
    # tokens are trusted and the audience list fixes which are accepted. If
    # either is empty, bearer validation rejects EVERY token.
    precondition {
      condition     = var.auth_active_directory_client_id == "" || var.auth_active_directory_tenant_id != ""
      error_message = "Function App Easy Auth is incompletely configured: auth_active_directory_client_id is set but auth_active_directory_tenant_id is empty. openIdIssuer would point at an invalid issuer and bearer validation would reject every token. Set auth_active_directory_tenant_id to the dev API Entra tenant id (MG-24 runbook)."
    }
    precondition {
      condition     = var.auth_active_directory_client_id == "" || length(var.auth_allowed_audiences) > 0
      error_message = "Function App Easy Auth is incompletely configured: auth_active_directory_client_id is set but auth_allowed_audiences is empty. With no allowed audience, bearer validation rejects every token. Set auth_allowed_audiences to the dev API's accepted audience(s) (MG-24 runbook)."
    }
    # Azure Easy Auth treats an EMPTY allowedApplications as NO calling-client
    # restriction, silently disabling the calling-client guarantee. Require a
    # non-empty list once auth is enabled.
    precondition {
      condition     = var.auth_active_directory_client_id == "" || length(var.auth_allowed_client_app_ids) > 0
      error_message = "Function App Easy Auth is incompletely configured: auth_active_directory_client_id is set but auth_allowed_client_app_ids is empty. Azure Easy Auth treats an empty allowedApplications as no calling-client restriction, so ANY client holding a token for an allowed audience could call the API, contradicting the bearer-validation-only contract. Set auth_allowed_client_app_ids to the calling client app id(s) — the smoke-test client (the Azure CLI public client 04b07795-8ddb-461a-bbee-02f9e1bf7b46 by default, or a dedicated dev client) (MG-24 runbook)."
    }
  }
}

# --- Identity-based access grants for the Function App managed identity ------
# Deployment + host storage: the Flex runtime needs Blob (package deployment /
# host) and Queue (triggers/scaling) data-plane access on ITS OWN storage
# account. Scoped to the storage account only — least privilege. Storage Blob
# Data Owner covers reading the deployment package from the blob container under
# the app's managed identity (deployment storage authentication =
# SystemAssignedIdentity).
#
# principal_type is declared EXPLICITLY on every azurerm_role_assignment in this
# stack — the MG-23 apply identity's ABAC condition matches on PrincipalType, and
# an attribute the request never sends does not match, so an omitted principal_type
# fails the condition SHUT. Full rationale in the root main.tf block above
# functions_eventhub_receiver.
resource "azurerm_role_assignment" "functions_storage_blob" {
  scope                = azapi_resource.functions_storage.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azapi_resource.function_app.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "functions_storage_queue" {
  scope                = azapi_resource.functions_storage.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azapi_resource.function_app.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# App-deployment identity → deployment-container write access (MG-24 item 4).
# Flex OneDeploy (func publish / `nx deploy api`) writes the package ZIP into the
# blob deployment container, so the SEPARATE app-deploy principal needs Blob Data
# write on THAT CONTAINER (in addition to its Website Contributor on the Function
# App granted in the root module). Scoped to the container alone — least
# privilege; it cannot touch other blobs on the account. Guarded by count so a
# bare `terraform validate`/plan with an empty app_deploy_principal_object_id
# still validates (the grant is skipped). The object id is the SP's OBJECT id,
# created by the bootstrap BEFORE this apply, so no apply-time principal is
# referenced and the graph stays acyclic.
resource "azurerm_role_assignment" "deploy_principal_deployment_container" {
  count                = var.app_deploy_principal_object_id != "" ? 1 : 0
  scope                = azapi_resource.deployment_container.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.app_deploy_principal_object_id
  principal_type       = "ServicePrincipal"
}

# IoT Hub Module for MeatGeek V2

# Provider requirements (MG-39). Without an explicit azurerm constraint a
# standalone `terraform init` in this module resolves the LATEST azurerm — which
# on 2026-08-03 became v5.0.1, whose breaking azurerm_eventhub schema
# (namespace_id replacing namespace_name/resource_group_name) failed every
# `terraform test` run in CI with nothing in this repo having changed. This
# codebase is written against azurerm 4.x; v5 is a deliberate, separate
# migration.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# MG-48 REPLACEMENT-PROPAGATION AUDIT — this module, enumerated in full.
#
# THE RULE, in attribute-kind terms rather than resource types: a reference to a
# parent's COMPUTED attribute (`.id`, an endpoint URI, a principal id) is unknown
# until the new parent exists, so it carries REPLACEMENT. A reference to a
# parent's CONFIGURED value — `.name` above all — is a static literal, identical
# before and after, so it carries ORDERING ONLY. Terraform never plans the child
# for replacement, Azure destroys it with the parent regardless, and state is left
# listing a resource that no longer exists.
#
# The enumeration is written out because assuming "the obvious ones are all of
# them" is what has now broken dev repeatedly. It is deliberately NOT limited to
# arguments spelled `<something>_name`, and NOT to bare references: `entity_path`
# is a name-valued argument not spelled that way, and `endpoint_uri` reaches a
# name from INSIDE a string interpolation. The VALUE decides, never the spelling.
# Arguments are named rather than line numbers, which rot.
#
# CONFIGURED-NAME references — ordering only, so every child listed here carries
# an explicit replace_triggered_by naming that parent:
#   azurerm_eventhub.temperature_data          -> eventhub_namespace.main  (namespace_name)
#   ..._endpoint_eventhub.eventhub_realtime    -> eventhub_namespace.main  (endpoint_uri, interpolated)
#   ..._endpoint_eventhub.eventhub_realtime    -> eventhub.temperature_data (entity_path)
#   azurerm_iothub_route.cosmos                -> iothub.main              (iothub_name)
#   azurerm_iothub_route.cosmos                -> ..._cosmosdb_account.cosmos_storage (endpoint_names)
#   azurerm_iothub_route.eventhub              -> iothub.main              (iothub_name)
#   azurerm_iothub_route.eventhub              -> ..._endpoint_eventhub.eventhub_realtime (endpoint_names)
#   azurerm_iothub_consumer_group.functions    -> iothub.main              (iothub_name)
#   azurerm_iothub_consumer_group.realtime     -> iothub.main              (iothub_name)
#
# COMPUTED references — these carry replacement natively. No lifecycle block is
# needed and adding one would be noise, not safety:
#   azurerm_role_assignment.iothub_eventhub_sender -> eventhub.temperature_data (scope, `.id`)
#   azurerm_role_assignment.iothub_eventhub_sender -> iothub.main (principal_id, identity)
#   both routing endpoints                         -> iothub.main (iothub_id, `.id`)
#
# CROSS-BOUNDARY values, which no lifecycle block in this module can name because
# replace_triggered_by accepts only managed resources in the SAME module:
# var.cosmos_database_name and var.cosmos_container_name are configured literals
# that carry nothing, which is why terraform_data.cosmos_target_ready below
# carries the corresponding COMPUTED ids instead. var.cosmos_account_endpoint is
# module.cosmos_db.endpoint, a computed attribute, so it does go unknown when the
# account is replaced — and the account reaches this module a second way besides,
# via account -> database -> cosmos_target_ready -> endpoint.
# var.resource_group_name is excluded on the boundary static check 18 documents:
# an RG replacement is a whole-stack event the destroy guard blocks on sight.
#
# STRUCTURALLY EXCLUDED: outputs.tf reaches several of these resources by `.name`.
# An `output` block cannot carry a `lifecycle` block, so there is nothing to
# assert there — that is an exclusion, not an unclosed gap.
#
# PLAN SHAPE, MEASURED rather than argued (Terraform 1.9.8, synthetic
# terraform_data graph, real apply, no credentials — transcripts in the MG-48
# step-4 result notes): adding a lifecycle block to a resource ALREADY IN STATE,
# or extending an existing replace_triggered_by list, plans as "No changes"; and a
# trigger whose referenced parent is planned for CREATE does not fire. Both
# properties matter here, because this module's routes, consumer groups and Event
# Hub path are all in live dev state while the Cosmos endpoint is not — together
# they are why the blocks below add nothing to the MG-48 repair plan and keep it
# CREATES-ONLY.

# IoT Hub
#
# DOCUMENTED EXCEPTION (MG-24 ADR) — key/SAS auth is INTENTIONALLY kept enabled.
# Unlike Cosmos/SignalR (local auth disabled) and Storage (shared-key disabled),
# the IoT Hub keeps its shared-access policies: real BBQ devices, the data-pusher,
# and the device-controller authenticate to the hub with SAS keys — the device
# SDKs' supported path. Disabling local auth here (local_authentication_enabled =
# false) would sever device connectivity, so it is deliberately left at its
# default (enabled). The hub's inherent shared_access_policy key attributes are
# therefore live credentials that DO land in Terraform state. The mitigation is
# restricted, container-scoped RBAC state access (state blob is not broadly
# readable) plus the documented acceptance in the MG-24 ADR. The secret-
# inspection gate treats these IoT key attributes as the acknowledged exception
# (accepted with a note), NOT as a violation.
resource "azurerm_iothub" "main" {
  name                = "${var.resource_prefix}-iothub-${var.global_suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku {
    name     = var.iot_hub_sku_name
    capacity = var.iot_hub_sku_capacity
  }

  # System-assigned identity enables identity-based auth on custom routing endpoints
  # (Cosmos DB endpoint uses this identity; AAD avoids key rotation).
  identity {
    type = "SystemAssigned"
  }

  tags = var.tags
}

# Event Hub Namespace for real-time processing.
#
# SAS auth is DISABLED (local_authentication_enabled = false). The namespace
# auto-creates a RootManageSharedAccessKey policy whose primary/secondary keys and
# connection strings are computed attributes that ALWAYS land in Terraform state —
# no argument suppresses them. Disabling local auth makes that RootManage key
# NON-authenticating (AAD-only), so the in-state residual cannot be used as a
# credential. This is SAFE because BOTH access paths are identity-based, not SAS:
# the IoT Hub PRODUCES via azurerm_iothub_endpoint_eventhub.eventhub_realtime
# (authentication_type = identityBased) backed by the iothub_eventhub_sender role
# assignment, and the Function App CONSUMES via Azure Event Hubs Data Receiver
# (IOTHUB_EVENTS__fullyQualifiedNamespace). Nothing reads the RootManage key.
# Unlike the IoT Hub itself (whose device SAS keys must stay live — see below),
# the Event Hubs namespace has no SAS consumer, so it is NOT an exception.
resource "azurerm_eventhub_namespace" "main" {
  name                = "${var.resource_prefix}-eventhub-ns-${var.global_suffix}"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
  capacity            = 1

  local_authentication_enabled = false

  tags = var.tags
}

# Event Hub for temperature data
resource "azurerm_eventhub" "temperature_data" {
  name                = "temperature-data"
  namespace_name      = azurerm_eventhub_namespace.main.name
  resource_group_name = var.resource_group_name
  partition_count     = 2
  message_retention   = 1

  # NOT redundant with the namespace_name reference above — do not delete this.
  # `azurerm_eventhub_namespace.main.name` is the namespace's CONFIGURED name:
  # identical before and after the namespace is replaced, so the reference carries
  # ORDERING but never REPLACEMENT. Terraform would leave this Event Hub unplanned
  # while Azure destroyed it along with its parent namespace, and state would keep
  # listing an entity that no longer exists — the same class of defect that
  # orphaned the Cosmos database and its containers on 2026-08-06 (MG-48). A
  # reference to a parent's COMPUTED attribute (`.id`) would carry replacement; a
  # reference to its configured `name` does not.
  lifecycle {
    replace_triggered_by = [azurerm_eventhub_namespace.main]
  }
}

# Identity-based send access for the IoT Hub routing endpoint.
# The IoT Hub's system-assigned identity is granted "Azure Event Hubs Data
# Sender" on the target Event Hub so the custom endpoint below authenticates via
# AAD. This replaces the former azurerm_eventhub_authorization_rule ("iothub-sender"),
# whose primary_connection_string / primary_key were SAS secrets materialized
# into Terraform state (MG-24 S1). No SAS rule, no connection string, no key.
resource "azurerm_role_assignment" "iothub_eventhub_sender" {
  scope                = azurerm_eventhub.temperature_data.id
  role_definition_name = "Azure Event Hubs Data Sender"
  principal_id         = azurerm_iothub.main.identity[0].principal_id
  # principal_type is declared EXPLICITLY on every azurerm_role_assignment in this
  # stack — the MG-23 apply identity's ABAC condition matches on PrincipalType, and
  # an omitted attribute does not match, so leaving it off fails the condition SHUT.
  # Rationale in the root main.tf block above functions_eventhub_receiver.
  principal_type = "ServicePrincipal"
}

# Dependency handle for the Cosmos data-plane role assignment. It carries the
# role-assignment id passed from root into the graph as a concrete node the
# identity-based Cosmos endpoint can depends_on. Using terraform_data (rather than
# making azurerm_iothub.main depend on the role) is what keeps the graph acyclic:
# the role assignment depends on this module's identity_principal_id output, so
# only the endpoint below — never the IoT Hub resource — sits downstream of it.
resource "terraform_data" "cosmos_role_ready" {
  input = var.cosmos_role_assignment_id
}

# Dependency handle for the Cosmos routing TARGET (MG-48). It carries the ids of
# the SQL database and the container the endpoint writes into, giving the endpoint
# a structural dependency on those objects EXISTING rather than on what they are
# called.
#
# The chain, end to end: the Cosmos database is planned for replacement -> its
# `.id` is a computed attribute and so is UNKNOWN at plan time -> this handle's
# triggers_replace no longer matches the value in state -> the handle is planned
# for replacement -> the endpoint's replace_triggered_by fires. Every link needs a
# value that is COMPUTED; a name would be known and identical at every step, which
# is the whole defect this ticket exists to close.
#
# The payload is on `triggers_replace` rather than `input`. Be precise about why,
# because the tempting reason is not the true one. MEASURED, not assumed (Terraform
# 1.9.8, synthetic terraform_data graph, real apply, no credentials — transcript in
# the MG-48 result notes): a whole-resource `replace_triggered_by` reference fires
# when the referenced resource is planned for UPDATE as well as for REPLACEMENT. So
# `input` would ALSO have propagated here — the handle would have been updated in
# place (`input = "..." -> (known after apply)`) and the endpoint replaced anyway.
# Any comment claiming the `input` form is inert is wrong; it was tested.
#
# `triggers_replace` is still the right argument, for two reasons that survive the
# correction. First, it does not depend on update-also-fires, which is a property of
# how Terraform evaluates a bare resource reference and not something the docs
# promise; `triggers_replace` states the intent directly and keeps working if that
# evaluation is ever narrowed. Second, it makes this node's own lifecycle match the
# thing it stands for: the handle IS the target's identity, so when the target is
# replaced the handle should be replaced too, not quietly mutate while continuing to
# claim it represents an object that no longer exists.
#
# Plan-shape cost, stated so it is not discovered later: because the handle is
# REPLACED rather than updated, a future target replacement puts one additional
# delete token in that plan — which is already destroy-gated many times over by the
# account, database, containers and endpoint themselves, so it changes nothing an
# operator has to authorize. It adds NOTHING to this repair: cosmos_target_ready is
# brand new here, a pure create under either shape.
#
# The endpoint's own arguments reach the target through var.cosmos_database_name
# and var.cosmos_container_name, which are CONFIGURED literals: identical before
# and after the database is destroyed and recreated. Ordering through them is not
# ordering at all — nothing in this module's graph knows the database exists, so
# the endpoint's create is only ever racing it. That is exactly how the 2026-08-06
# dev apply died: free_tier_enabled is create-only, so claiming the free tier
# replaced the Cosmos account, Azure destroyed meatgeek-v2-dev-db and its five
# containers along with it, Terraform never planned those children for replacement
# (same static-name defect as the routes below), and this endpoint's create then
# failed with Azure IH400142 "Database does not exist". An id is COMPUTED and
# changes when the object is replaced, which is what makes it usable both as an
# ordering edge and — via replace_triggered_by — as a replacement trigger.
#
# This is a SEPARATE node from cosmos_role_ready above, deliberately. That handle
# is already in live state; feeding it a value that is unknown at plan time would
# plan it for REPLACEMENT, and tf-plan-destroy-guard.sh classifies a replace as a
# protected delete. cosmos_target_ready is brand new, so it is a pure create and
# adds no delete token to the repair plan. Do not fold the two together.
#
# Acyclicity is unchanged: only the endpoint sits downstream of this handle, never
# azurerm_iothub.main, and the cosmos-db module has no edge back into this one.
resource "terraform_data" "cosmos_target_ready" {
  triggers_replace = {
    database_id  = var.cosmos_database_id
    container_id = var.cosmos_container_id
  }
}

# Custom routing endpoint: Cosmos DB temperatures container (identity-based auth).
# The IoT Hub system-assigned identity (output: identity_principal_id) must hold
# the "Cosmos DB Built-in Data Contributor" role on the Cosmos account BEFORE this
# endpoint is created — the service validates the identity's data-plane access at
# creation, so a greenfield apply that races the endpoint ahead of the role fails
# until the role propagates. The depends_on below orders it strictly after the
# role assignment via the terraform_data handle (MG-24).
resource "azurerm_iothub_endpoint_cosmosdb_account" "cosmos_storage" {
  name                = "cosmos-storage"
  iothub_id           = azurerm_iothub.main.id
  resource_group_name = var.resource_group_name

  endpoint_uri   = var.cosmos_account_endpoint
  database_name  = var.cosmos_database_name
  container_name = var.cosmos_container_name

  authentication_type = "identityBased"

  # Two independent preconditions, one handle each: the data-plane role must exist
  # (Azure validates the identity's access at creation, MG-24) AND the database and
  # container must exist (IH400142, MG-48). The names above cannot carry the second
  # one — they are literals that survive the target's destruction unchanged.
  depends_on = [terraform_data.cosmos_role_ready, terraform_data.cosmos_target_ready]

  # NOT redundant with the depends_on above — do not delete this. depends_on
  # propagates ORDERING only; it never plans this endpoint for replacement. When
  # the database or container is planned for replacement its `.id` goes UNKNOWN at
  # plan time, cosmos_target_ready's triggers_replace no longer matches state so
  # that handle is planned for replacement too, and this block is what carries the
  # replacement the last hop to the endpoint. The reference below names the handle
  # as a WHOLE RESOURCE; measured against Terraform 1.9.8, that form fires when the
  # referenced resource is planned for update OR for replacement (see the handle's
  # own comment — the distinction is documented there and the transcript is in the
  # MG-48 result notes). Without this block the endpoint would keep pointing,
  # unchanged, at a database that Azure had already destroyed and recreated — state
  # claiming a binding that no longer exists, which is the shape of the IH400142
  # failure.
  lifecycle {
    replace_triggered_by = [terraform_data.cosmos_target_ready]
  }
}

# Custom routing endpoint: Event Hub for real-time fan-out to Functions.
# IDENTITY-BASED auth (MG-24 S1): the IoT Hub authenticates to the Event Hub
# with its system-assigned managed identity (endpoint_uri + entity_path), so NO
# SAS connection string / key is generated or stored in Terraform state. The
# role assignment above must exist before the endpoint is created.
resource "azurerm_iothub_endpoint_eventhub" "eventhub_realtime" {
  name                = "eventhub-realtime"
  iothub_id           = azurerm_iothub.main.id
  resource_group_name = var.resource_group_name

  authentication_type = "identityBased"
  endpoint_uri        = "sb://${azurerm_eventhub_namespace.main.name}.servicebus.windows.net"
  entity_path         = azurerm_eventhub.temperature_data.name

  depends_on = [azurerm_role_assignment.iothub_eventhub_sender]

  # NOT redundant with the two references above — do not delete this. BOTH of them
  # reach their parent through the parent's CONFIGURED name, which is the MG-48
  # defect class in its less obvious form: `entity_path` is a bare
  # `azurerm_eventhub.temperature_data.name` and `endpoint_uri` interpolates
  # `azurerm_eventhub_namespace.main.name` inside a string. Neither attribute is
  # spelled `<something>_name`, and one is not even a bare reference, but the VALUE
  # is what matters — both are static literals ("temperature-data",
  # "meatgeek-v2-dev-eventhub-ns-<suffix>"), byte-identical before and after their
  # parent is destroyed and recreated. Ordering, never replacement.
  #
  # This became REACHABLE, not merely latent, once azurerm_eventhub.temperature_data
  # gained its own replace_triggered_by on the namespace above: the Event Hub now
  # replaces with its namespace while this endpoint, pointing at it, would not.
  # Terraform would try to delete the Event Hub with a live routing endpoint still
  # bound to it, and the eventhub-realtime-route pointing at THAT — the IH400111
  # ordering failure, reintroduced on the one data path this ticket promised not to
  # disturb. A partial fix that opens a new path is worse than no fix.
  #
  # The route downstream already names this endpoint in its own replace_triggered_by
  # (see azurerm_iothub_route.eventhub), so the cascade completes: namespace ->
  # event hub -> endpoint -> route.
  lifecycle {
    replace_triggered_by = [
      azurerm_eventhub_namespace.main,
      azurerm_eventhub.temperature_data,
    ]
  }
}

# Parallel route #1: all DeviceMessages → Cosmos (storage of record).
resource "azurerm_iothub_route" "cosmos" {
  name                = "cosmos-storage-route"
  iothub_name         = azurerm_iothub.main.name
  resource_group_name = var.resource_group_name

  source         = "DeviceMessages"
  condition      = "true"
  endpoint_names = [azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage.name]
  enabled        = true

  # NOT redundant with the endpoint_names reference above — do not delete this.
  # That reference propagates ORDERING but not REPLACEMENT, because the attribute
  # it reads (`.name`) is the static literal "cosmos-storage": identical before and
  # after the endpoint is replaced. The route's own configuration therefore never
  # changes, Terraform never plans the route for replacement, and it tries to
  # delete the endpoint while this route still points at it. Azure refuses that —
  # IH400111, "Route to cosmos-storage endpoint is invalid: endpoint does not
  # exist" — which is how the 2026-08-06 dev apply died partway through, after it
  # had already destroyed the Function App's Cosmos data-plane role assignment.
  # replace_triggered_by forces the route to be replaced with the endpoint, and
  # the reference above then orders the route's destroy before the endpoint's.
  #
  # azurerm_iothub.main is listed for the SAME reason, one level up (MG-48). PR #37
  # fixed route-to-ENDPOINT propagation and left route-to-HUB propagation broken:
  # `iothub_name` above reaches the hub by its configured name too, so a hub
  # replacement would destroy this route in Azure while Terraform kept it in state,
  # unplanned. Hub replacement is not hypothetical — tf-plan-destroy-guard.sh's own
  # header names IoT Hub `location` as ForceNew, so a single-token edit plans the
  # hub as a destroy-and-recreate.
  lifecycle {
    replace_triggered_by = [
      azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage,
      azurerm_iothub.main,
    ]
  }
}

# Parallel route #2: all DeviceMessages → Event Hub (real-time path).
resource "azurerm_iothub_route" "eventhub" {
  name                = "eventhub-realtime-route"
  iothub_name         = azurerm_iothub.main.name
  resource_group_name = var.resource_group_name

  source         = "DeviceMessages"
  condition      = "true"
  endpoint_names = [azurerm_iothub_endpoint_eventhub.eventhub_realtime.name]
  enabled        = true

  # Same defect as the Cosmos route above, latent rather than fired: `.name` here
  # is the static literal "eventhub-realtime", so replacing the Event Hub endpoint
  # (which the Event Hub namespace or entity being replaced would cascade into)
  # leaves this route untouched and Azure rejects the endpoint delete with
  # IH400111. Not redundant with the endpoint_names reference — see above.
  #
  # azurerm_iothub.main is listed for the route-to-HUB pairing, exactly as on the
  # Cosmos route above: `iothub_name` reaches the hub by its configured name, which
  # survives a hub replacement unchanged, so without this the route is orphaned in
  # state when the hub is replaced.
  lifecycle {
    replace_triggered_by = [
      azurerm_iothub_endpoint_eventhub.eventhub_realtime,
      azurerm_iothub.main,
    ]
  }
}

# Consumer group for Azure Functions
resource "azurerm_iothub_consumer_group" "functions" {
  name                   = "azure-functions"
  iothub_name            = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name

  # NOT redundant with the iothub_name reference above — do not delete this. The
  # hub's configured name is identical before and after a hub replacement, so the
  # reference orders this consumer group but never plans it for replacement. Azure
  # destroys the consumer group with the hub regardless, leaving state listing a
  # resource that does not exist — and the Function App's IoT trigger then binds to
  # a consumer group the hub has never heard of. See the routes above; MG-48.
  lifecycle {
    replace_triggered_by = [azurerm_iothub.main]
  }
}

# Consumer group for real-time processing
resource "azurerm_iothub_consumer_group" "realtime" {
  name                   = "realtime-processing"
  iothub_name            = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name

  # Same hub pairing as the functions consumer group above, for the same reason.
  lifecycle {
    replace_triggered_by = [azurerm_iothub.main]
  }
}

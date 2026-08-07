# Route/endpoint replacement-pairing test for the IoT Hub module (MG-48).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply.
#
# WHAT THIS FILE DOES NOT DO — read before trusting it as the regression guard.
# It does NOT prove that replacing an endpoint plans its route for replacement.
# That property is a state DIFF: a resource can only be "replaced" relative to a
# prior state. A `terraform test` run block with `command = plan` always starts
# from EMPTY state (verified: every plan run reports "0 to destroy"), and static
# check 15 forbids `command = apply` because the PR gate is credentialless. So a
# tftest that satisfies check 15 has no prior state and can never observe a
# replacement. `plan_options { replace = [...] }` does not help either — with
# nothing in state it is a no-op. `replace_triggered_by` is also absent from
# `terraform show -json`, so the plan JSON cannot be inspected for it.
#
# The replacement propagation and its destroy/create ORDER were instead verified
# out-of-band, against a synthetic graph of the identical shape built on the
# builtin terraform_data provider (no credentials, real apply): with the
# lifecycle block the plan is "2 to add, 2 to destroy" and the apply order is
# destroy route -> destroy endpoint -> create endpoint -> create route; with the
# block removed it is "1 to add, 1 to destroy" and the route is left live, which
# is the IH400111 failure. See the MG-48 result notes for both transcripts.
#
# What this file DOES pin is the premise the fix rests on: each route reaches its
# endpoint through an attribute whose value is a STATIC LITERAL, identical before
# and after replacement. That is precisely why the endpoint_names reference below
# propagates ordering but not replacement, and therefore why each route needs the
# `replace_triggered_by` lifecycle block in main.tf. If someone ever makes an
# endpoint name derive from something that changes on replacement, these
# assertions fail and the lifecycle blocks should be revisited.
#
# The second run block pins the SAME premise one level down, on the Event Hub
# endpoint's own parents. That pairing was missed twice because it does not look
# like the others: `entity_path` is not spelled `<something>_name`, and
# `endpoint_uri` reaches the namespace through an INTERPOLATION inside a string
# rather than a bare reference. Neither shape changes what matters — the value is
# a configured literal either way — so both are asserted here explicitly, as the
# standing reminder that this class is about the KIND of value a reference carries
# and never about how the argument is spelled.
#
# Run:  terraform -chdir=apps/infrastructure/modules/iot-hub test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}

variables {
  resource_prefix           = "meatgeek-v2-dev"
  global_suffix             = "abc123def456"
  resource_group_name       = "meatgeek-v2-dev-rg"
  location                  = "westus2"
  cosmos_account_endpoint   = "https://mgv2dev.documents.azure.com/"
  cosmos_database_name      = "meatgeek"
  cosmos_container_name     = "temperatures"
  cosmos_database_id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/mgv2dev/sqlDatabases/meatgeek"
  cosmos_container_id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/mgv2dev/sqlDatabases/meatgeek/containers/temperatures"
  cosmos_role_assignment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/mgv2dev/sqlRoleAssignments/11111111-1111-1111-1111-111111111111"
}

# Each route must name exactly the endpoint it is paired with, and that endpoint
# name must be the fixed literal. The pairing is what each lifecycle block's
# replace_triggered_by has to mirror; the literal is why it is needed at all.
run "routes_reach_their_endpoints_through_a_static_literal_name" {
  command = plan

  assert {
    condition     = azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage.name == "cosmos-storage"
    error_message = "Cosmos endpoint name must be the fixed literal 'cosmos-storage' — a name that CHANGED on replacement would make the route's config change on its own, and the replace_triggered_by block in main.tf would no longer be the thing carrying replacement across"
  }

  assert {
    condition     = one(azurerm_iothub_route.cosmos.endpoint_names) == "cosmos-storage"
    error_message = "Cosmos route must route to the cosmos-storage endpoint — this is the pairing azurerm_iothub_route.cosmos's replace_triggered_by must name"
  }

  assert {
    condition     = azurerm_iothub_endpoint_eventhub.eventhub_realtime.name == "eventhub-realtime"
    error_message = "Event Hub endpoint name must be the fixed literal 'eventhub-realtime' — same reasoning as the Cosmos endpoint above"
  }

  assert {
    condition     = one(azurerm_iothub_route.eventhub.endpoint_names) == "eventhub-realtime"
    error_message = "Event Hub route must route to the eventhub-realtime endpoint — this is the pairing azurerm_iothub_route.eventhub's replace_triggered_by must name"
  }
}

# The Event Hub endpoint reaches BOTH its parents by a configured name, in the two
# shapes that a suffix-matching scan does not see: entity_path (a bare reference on
# an argument not named `*_name`) and endpoint_uri (an interpolation inside a
# string). Both values are static literals, so both carry ordering and neither
# carries replacement — which is why the endpoint carries replace_triggered_by for
# the namespace AND the event hub in main.tf. This matters more since the event hub
# gained its own pairing on the namespace: without the endpoint's block the event
# hub would replace while the endpoint bound to it did not, and Azure would reject
# the delete with IH400111 on the live telemetry path.
run "eventhub_endpoint_reaches_its_parents_through_static_literal_names" {
  command = plan

  assert {
    condition     = azurerm_eventhub.temperature_data.name == "temperature-data"
    error_message = "the Event Hub name must be the fixed literal 'temperature-data' — it is identical before and after the hub is replaced, which is exactly why entity_path below cannot carry replacement on its own"
  }

  assert {
    condition     = azurerm_iothub_endpoint_eventhub.eventhub_realtime.entity_path == azurerm_eventhub.temperature_data.name
    error_message = "the Event Hub endpoint must target azurerm_eventhub.temperature_data — that is the parent azurerm_iothub_endpoint_eventhub.eventhub_realtime's replace_triggered_by must name, and entity_path reaching it by NAME is why the lifecycle block is required rather than optional"
  }

  assert {
    condition     = azurerm_iothub_endpoint_eventhub.eventhub_realtime.endpoint_uri == "sb://${azurerm_eventhub_namespace.main.name}.servicebus.windows.net"
    error_message = "the Event Hub endpoint's endpoint_uri must be built from azurerm_eventhub_namespace.main's configured name — an interpolated name is still a configured literal, so this reference is the second parent pairing the endpoint's replace_triggered_by must name; a scan keyed on bare `<type>.<label>.name` references would miss it entirely"
  }

  assert {
    condition     = azurerm_eventhub.temperature_data.namespace_name == azurerm_eventhub_namespace.main.name
    error_message = "the Event Hub must sit in azurerm_eventhub_namespace.main and reach it by configured name — this is the pairing azurerm_eventhub.temperature_data's own replace_triggered_by must name, and the reason the endpoint above needs the namespace in its list too"
  }
}

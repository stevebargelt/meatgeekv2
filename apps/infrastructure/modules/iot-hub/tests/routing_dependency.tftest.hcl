# Plan-level dependency-ordering test for the IoT Hub module (MG-24).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply. It proves that the identity-based Cosmos
# routing endpoint is gated on the Cosmos data-plane role assignment: the endpoint
# writes to Cosmos with the IoT Hub managed identity, so on a greenfield apply it
# must be created only AFTER the "Cosmos DB Built-in Data Contributor" role exists,
# or IoT→Cosmos routing fails until the role propagates.
#
# The ordering is carried by terraform_data.cosmos_role_ready (input =
# var.cosmos_role_assignment_id), which the endpoint declares in depends_on. We
# assert the handle carries the role-assignment id passed from root; the depends_on
# edge on that handle is what serializes the endpoint after the role.
#
# A second handle, terraform_data.cosmos_target_ready, does the same job for the
# endpoint's TARGET (MG-48): it carries the Cosmos database and container ids, so
# the endpoint is ordered after those objects exist instead of racing them. The
# endpoint reaches the target by NAME (var.cosmos_database_name /
# var.cosmos_container_name), and a name is a configured literal identical before
# and after the target is destroyed and recreated — which is why the ids, not the
# names, are what the handle carries.
#
# That handle carries its payload on `triggers_replace`, and the assertions below
# read triggers_replace deliberately, because on this wiring the argument is
# load-bearing. The endpoint triggers on `terraform_data.cosmos_target_ready.id`,
# and terraform_data keeps its id byte-identical across an in-place update —
# measured on Terraform 1.9.8 against a synthetic terraform_data graph, transcripts
# in the MG-48 step-3 result notes. A payload on `input` would therefore leave the
# handle UPDATED rather than replaced, its id unchanged, and the endpoint would not
# be replaced at all: the propagation would break silently while the handle still
# carried exactly the right value. `triggers_replace` forces replacement, which is
# what makes the id unknown at plan time and carries the signal across. So these
# assertions guard two things whose loss is silent — the payload being the computed
# IDS rather than the configured names, and it sitting on the argument that actually
# replaces the handle.
#
# WHAT THESE ASSERTIONS DO NOT PROVE. They pin the wiring — that each handle
# carries the value it is supposed to carry — not the replacement behaviour built
# on it. Replacement is a state DIFF; a `command = plan` run block always starts
# from empty state and static check 15 forbids `command = apply`, and
# replace_triggered_by never appears in `terraform show -json`. No credentialless
# Terraform test can observe it. The static checks in
# apps/infrastructure/scripts/tf-static-checks.sh are the real guard.
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

# The Cosmos routing endpoint's role-ready handle carries the exact role-assignment
# id passed from root. Because the endpoint depends_on this handle and the handle is
# fed by the role id, the endpoint is ordered strictly after the role assignment.
run "cosmos_endpoint_gated_on_role_assignment" {
  command = plan

  assert {
    condition     = terraform_data.cosmos_role_ready.input == var.cosmos_role_assignment_id
    error_message = "cosmos_role_ready handle must carry the Cosmos data-plane role-assignment id so the endpoint can order after it"
  }

  # The endpoint is identity-based — it is exactly the resource that requires the
  # role to exist first.
  assert {
    condition     = azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage.authentication_type == "identityBased"
    error_message = "Cosmos routing endpoint must use identity-based auth (the reason the role must precede it)"
  }
}

# The target handle must carry the database and container IDS — the computed
# values that change when those objects are replaced — and must carry them on
# TRIGGERS_REPLACE. If someone ever repoints it at the name variables it will still
# plan and still look like a dependency, while silently carrying a literal that
# survives the target's destruction unchanged: the endpoint would then be ordered
# after nothing, which is the IH400142 shape. Moving the payload back to `input`
# also fails these assertions — deliberately, because on `input` the handle is
# updated in place, its id never changes, and the endpoint's replace_triggered_by
# never fires at all.
run "cosmos_endpoint_gated_on_target_existing" {
  command = plan

  assert {
    condition     = terraform_data.cosmos_target_ready.triggers_replace.database_id == var.cosmos_database_id
    error_message = "cosmos_target_ready must carry the Cosmos SQL DATABASE id on triggers_replace — the computed value that changes on replacement, on the argument that actually forces this handle to be replaced — so the endpoint depends on the database existing, not merely on what it is called"
  }

  assert {
    condition     = terraform_data.cosmos_target_ready.triggers_replace.container_id == var.cosmos_container_id
    error_message = "cosmos_target_ready must carry the Cosmos CONTAINER id on triggers_replace for the same reason as the database id — var.cosmos_container_name is a configured literal and cannot express whether the container still exists"
  }

  # The two handles stay separate. cosmos_role_ready is already in live state, and
  # feeding it a plan-time-unknown value would plan it for REPLACEMENT — which
  # tf-plan-destroy-guard.sh classifies as a protected delete. A single such token
  # turns an automatic repair into a human destroy-authorization gate.
  assert {
    condition     = terraform_data.cosmos_role_ready.input == var.cosmos_role_assignment_id
    error_message = "cosmos_role_ready's input must remain exactly var.cosmos_role_assignment_id — the Cosmos target ids belong on the separate cosmos_target_ready handle, because cosmos_role_ready is in live state and an unknown input would plan it for replacement"
  }
}

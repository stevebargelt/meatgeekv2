# Plan-level regression test for the two Flex/real-Azure monitoring defects found
# on the live MG-24 apply (MG-24 monitoring fixes):
#
#   1. SignalR diagnostic setting must use the `allLogs` category GROUP — the
#      Free_F1 SignalR tier exposes NO individual ConnectivityLogs/MessagingLogs/
#      HttpRequestLogs categories, so the former three enabled_log{category=...}
#      blocks were rejected by Azure.
#   2. The function-failure alert must target the App Insights resource with
#      metric_namespace=microsoft.insights/components + metric_name=requests/failed.
#      The Flex Function App has NO platform failure metric (FunctionExecutionCount
#      does not exist) and NO Status dimension, so the alert is repointed to AI.
#
# Runs the module as the config-under-test with MOCKED providers — NO live Azure,
# NO credentials, NO apply.
#
# Run:  terraform -chdir=apps/infrastructure/modules/monitoring test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "time" {}

variables {
  resource_prefix              = "meatgeek-v2-dev"
  resource_group_name          = "meatgeek-v2-dev-rg"
  location                     = "westus2"
  log_analytics_workspace_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.OperationalInsights/workspaces/mgv2dev-law"
  log_analytics_workspace_name = "mgv2dev-law"
  application_insights_id      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Insights/components/mgv2dev-ai"
  iot_hub_id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/IotHubs/mgv2dev-iothub"
  cosmos_db_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/mgv2dev-cosmos"
  function_app_id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Web/sites/mgv2dev-func"
  signalr_id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.SignalRService/SignalR/mgv2dev-signalr"
  # MG-23: the out-of-band-persistence Activity Log alerts scope to the RESOURCE
  # GROUP id (an alert scope is a resource id, not a name).
  resource_group_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg"
  # Non-UUID placeholder — the tf-static-checks subscription-id guard forbids a
  # literal `subscription_id = "<uuid>"`, and the mocked provider needs no real GUID.
  subscription_id = "00000000000000000000000000000000"
}

# Defect 1 — SignalR diag uses the `allLogs` category GROUP, not individual
# ConnectivityLogs/MessagingLogs/HttpRequestLogs categories (Free_F1 exposes none
# of them). AllMetrics is retained.
run "signalr_diag_uses_alllogs_category_group" {
  command = plan

  # Exactly one enabled_log block, and it selects the group — not an individual
  # category. (mutation-check: reverting to three category blocks flips length to 3.)
  assert {
    condition     = length(azurerm_monitor_diagnostic_setting.signalr.enabled_log) == 1
    error_message = "SignalR diag must have exactly one enabled_log block (the allLogs category group)"
  }
  assert {
    condition     = one([for l in azurerm_monitor_diagnostic_setting.signalr.enabled_log : l.category_group]) == "allLogs"
    error_message = "SignalR diag enabled_log must use category_group = \"allLogs\""
  }
  # NEGATIVE — none of the rejected individual categories may be present.
  assert {
    condition     = alltrue([for l in azurerm_monitor_diagnostic_setting.signalr.enabled_log : !contains(["ConnectivityLogs", "MessagingLogs", "HttpRequestLogs"], coalesce(l.category, "none"))])
    error_message = "SignalR diag must NOT set individual log categories (Free_F1 exposes only the allLogs group)"
  }
  # AllMetrics retained.
  assert {
    condition     = one([for m in azurerm_monitor_diagnostic_setting.signalr.enabled_metric : m.category]) == "AllMetrics"
    error_message = "SignalR diag must keep enabled_metric category = AllMetrics"
  }
}

# MG-24 second-plan no-op — the two consumption budgets declare an EXPLICIT
# anchor-derived end_date (start + 10 years). Azure defaults an omitted end_date
# to that horizon and reports it back, so a config that omits it forces a
# delete+create (REPLACE) on every plan; declaring it makes config == Azure so the
# budget plans as a no-op (verified: start "…-07-01T00:00:00Z" / end
# "…+10-07-01T00:00:00Z"). The date VALUE cannot be asserted here: a mock_provider
# reads a mocked azurerm_consumption_budget_resource_group's time_period back as
# unknown-until-apply, and `command = apply` fails on the metric-alert action-id
# validation with mock ids. The explicit-end_date + no-timestamp() regression is
# asserted statically in libs/api-interfaces .../infra-security-posture.spec.ts
# ("both consumption budgets set an EXPLICIT end_date"), which reads the sources.

# MG-24 second-plan no-op — the Cosmos DB diagnostic setting must declare the
# CONCRETE metric categories (Requests + SLI) rather than "AllMetrics". Azure
# expands AllMetrics for a Cosmos account into those two concrete categories and
# reports them back in state, so a config of ["AllMetrics"] never matches
# ["Requests","SLI"] and updates in-place on every plan. Declaring the concrete
# categories makes config == Azure so the diag setting plans as a no-op. The
# enabled_log blocks (DataPlaneRequests, QueryRuntimeStatistics) round-trip
# cleanly and are unchanged.
run "cosmos_diag_uses_concrete_metric_categories_not_allmetrics" {
  command = plan

  # Exactly two enabled_metric blocks — the concrete categories Azure returns.
  # (mutation-check: reverting to a single AllMetrics block flips length to 1.)
  assert {
    condition     = length(azurerm_monitor_diagnostic_setting.cosmos_db.enabled_metric) == 2
    error_message = "Cosmos diag must declare exactly two enabled_metric blocks (Requests + SLI)"
  }
  assert {
    condition     = toset([for m in azurerm_monitor_diagnostic_setting.cosmos_db.enabled_metric : m.category]) == toset(["Requests", "SLI"])
    error_message = "Cosmos diag enabled_metric categories must be exactly {Requests, SLI}"
  }
  # NEGATIVE — the expanded-by-Azure "AllMetrics" pseudo-category must be gone
  # (its presence is what caused the perpetual in-place update).
  assert {
    condition     = alltrue([for m in azurerm_monitor_diagnostic_setting.cosmos_db.enabled_metric : m.category != "AllMetrics"])
    error_message = "Cosmos diag must NOT use AllMetrics (Azure expands it, forcing a perpetual diff)"
  }
  # The enabled_log blocks are untouched — they do not drift.
  assert {
    condition     = toset([for l in azurerm_monitor_diagnostic_setting.cosmos_db.enabled_log : l.category]) == toset(["DataPlaneRequests", "QueryRuntimeStatistics"])
    error_message = "Cosmos diag enabled_log categories must remain DataPlaneRequests + QueryRuntimeStatistics"
  }
}

# Defect 2 — the function-failure alert targets App Insights (not the Function
# App) and uses the AI requests/failed metric (not the non-existent Flex platform
# metric FunctionExecutionCount), with no Status dimension.
run "function_failure_alert_targets_app_insights_requests_failed" {
  command = plan

  # Scope is the App Insights resource id, NOT the Function App id.
  assert {
    condition     = contains(azurerm_monitor_metric_alert.function_failure_rate.scopes, var.application_insights_id)
    error_message = "function_failure_rate must scope to the Application Insights resource id"
  }
  assert {
    condition     = !contains(azurerm_monitor_metric_alert.function_failure_rate.scopes, var.function_app_id)
    error_message = "function_failure_rate must NOT scope to the Function App (Flex has no platform failure metric)"
  }
  # AI metric namespace + metric name.
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).metric_namespace == "microsoft.insights/components"
    error_message = "function_failure_rate metric_namespace must be microsoft.insights/components"
  }
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).metric_name == "requests/failed"
    error_message = "function_failure_rate metric_name must be requests/failed"
  }
  # NEGATIVE — the rejected Flex platform metric must be gone.
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).metric_name != "FunctionExecutionCount"
    error_message = "function_failure_rate must NOT use FunctionExecutionCount (does not exist on Flex)"
  }
  # NEGATIVE — no Status dimension (not an AI requests/failed dimension).
  assert {
    condition     = length(one(azurerm_monitor_metric_alert.function_failure_rate.criteria).dimension) == 0
    error_message = "function_failure_rate must not carry a Status dimension"
  }
  # Aggregation/operator/threshold and the window/frequency are preserved.
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).aggregation == "Count" && one(azurerm_monitor_metric_alert.function_failure_rate.criteria).operator == "GreaterThan" && one(azurerm_monitor_metric_alert.function_failure_rate.criteria).threshold == 5
    error_message = "function_failure_rate criteria must be Count / GreaterThan / 5"
  }
  assert {
    condition     = azurerm_monitor_metric_alert.function_failure_rate.window_size == "PT5M" && azurerm_monitor_metric_alert.function_failure_rate.frequency == "PT1M"
    error_message = "function_failure_rate must keep window_size PT5M / frequency PT1M"
  }
}

# MG-23 F5 — the three out-of-band-persistence Activity Log alerts.
#
# These are the compensating DETECTIVE control for what the MG-23 final drift plan
# structurally cannot see. The drift plan proves convergence of Terraform-MANAGED
# CONTROL-PLANE resources only; a role assignment, a user-assigned identity, or a
# Cosmos data-plane sqlRoleAssignment created out of band is invisible to it. Each
# assertion below pins the three properties that make the alert actually work:
# it watches the right operation, it is scoped to the workload RESOURCE GROUP (not
# the subscription — that scope is outside the CI apply identity's boundary), and
# it is wired to the action group so it reaches a human.
run "out_of_band_persistence_activity_log_alerts" {
  command = plan

  # --- 1. Microsoft.Authorization/roleAssignments/write (residual F4) ---------
  assert {
    condition     = one(azurerm_monitor_activity_log_alert.role_assignment_write.criteria).operation_name == "Microsoft.Authorization/roleAssignments/write"
    error_message = "role_assignment_write must watch operation Microsoft.Authorization/roleAssignments/write"
  }
  assert {
    condition     = one(azurerm_monitor_activity_log_alert.role_assignment_write.criteria).category == "Administrative"
    error_message = "role_assignment_write criteria category must be Administrative"
  }
  assert {
    condition     = azurerm_monitor_activity_log_alert.role_assignment_write.scopes == toset([var.resource_group_id])
    error_message = "role_assignment_write must be scoped to the workload RESOURCE GROUP id, and to nothing else"
  }
  assert {
    condition     = length(azurerm_monitor_activity_log_alert.role_assignment_write.action) == 1
    error_message = "role_assignment_write must declare exactly one action block (an alert nobody receives is not a control)"
  }

  # --- 2. Microsoft.ManagedIdentity/userAssignedIdentities/write -------------
  assert {
    condition     = one(azurerm_monitor_activity_log_alert.user_assigned_identity_write.criteria).operation_name == "Microsoft.ManagedIdentity/userAssignedIdentities/write"
    error_message = "user_assigned_identity_write must watch operation Microsoft.ManagedIdentity/userAssignedIdentities/write"
  }
  assert {
    condition     = azurerm_monitor_activity_log_alert.user_assigned_identity_write.scopes == toset([var.resource_group_id])
    error_message = "user_assigned_identity_write must be scoped to the workload RESOURCE GROUP id, and to nothing else"
  }
  assert {
    condition     = length(azurerm_monitor_activity_log_alert.user_assigned_identity_write.action) == 1
    error_message = "user_assigned_identity_write must declare exactly one action block (an alert nobody receives is not a control)"
  }

  # --- 3. Microsoft.DocumentDB/.../sqlRoleAssignments/write (residual F6) -----
  # Cosmos DATA-PLANE grants: Contributor-granted, invisible to a
  # Microsoft.Authorization ABAC condition, and they accept USER principals.
  assert {
    condition     = one(azurerm_monitor_activity_log_alert.cosmos_sql_role_assignment_write.criteria).operation_name == "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write"
    error_message = "cosmos_sql_role_assignment_write must watch operation Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write"
  }
  assert {
    condition     = azurerm_monitor_activity_log_alert.cosmos_sql_role_assignment_write.scopes == toset([var.resource_group_id])
    error_message = "cosmos_sql_role_assignment_write must be scoped to the workload RESOURCE GROUP id, and to nothing else"
  }
  assert {
    condition     = length(azurerm_monitor_activity_log_alert.cosmos_sql_role_assignment_write.action) == 1
    error_message = "cosmos_sql_role_assignment_write must declare exactly one action block (an alert nobody receives is not a control)"
  }

  # NEGATIVE — no alert may be scoped to the SUBSCRIPTION. A subscription-scoped
  # alert is outside the boundary the MG-23 CI apply identity is confined to, so it
  # would be unappliable from CI for exactly the reason the subscription budget was
  # count-guarded off. (mutation-check: swapping any scope for
  # "/subscriptions/<id>" flips this false.)
  assert {
    condition = alltrue([
      for s in setunion(
        azurerm_monitor_activity_log_alert.role_assignment_write.scopes,
        azurerm_monitor_activity_log_alert.user_assigned_identity_write.scopes,
        azurerm_monitor_activity_log_alert.cosmos_sql_role_assignment_write.scopes,
      ) : can(regex("/resourceGroups/", s))
    ])
    error_message = "no MG-23 activity log alert may be scoped above the resource group (a subscription scope is outside the CI apply identity's boundary)"
  }
}

# MG-23 RG BOUNDARY — the subscription-scoped budget is count-guarded OFF by
# default, so the module's whole graph is applicable by an identity scoped only to
# the workload resource group. The default (no manage_subscription_budget override)
# is what CI applies, so the default is what is asserted.
run "subscription_budget_is_count_guarded_off_by_default" {
  command = plan

  assert {
    condition     = length(azurerm_consumption_budget_subscription.credit_budget) == 0
    error_message = "the subscription-scoped budget must NOT be in the default graph (MG-23: a /subscriptions/<id> resource cannot be applied by a resource-group-scoped CI identity)"
  }
  # The RESOURCE-GROUP budget is unaffected — it remains the primary spend control.
  assert {
    condition     = azurerm_consumption_budget_resource_group.main.amount == var.budget_limit
    error_message = "the resource-group budget must remain in the graph as the primary spend control"
  }
}

# Mutation-check for the guard above: with the flag flipped ON the resource DOES
# come back, proving the count guard is a real switch and not an always-empty
# resource. This is the operator/bootstrap path, never the CI path.
run "subscription_budget_returns_when_operator_opts_in" {
  command = plan

  variables {
    manage_subscription_budget = true
  }

  assert {
    condition     = length(azurerm_consumption_budget_subscription.credit_budget) == 1
    error_message = "manage_subscription_budget = true must create the subscription-scoped budget (operator/bootstrap path)"
  }
  assert {
    condition     = one(azurerm_consumption_budget_subscription.credit_budget[*].subscription_id) == "/subscriptions/${var.subscription_id}"
    error_message = "the opted-in subscription budget must still target the subscription id it is given"
  }
}

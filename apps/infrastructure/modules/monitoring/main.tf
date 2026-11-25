# Monitoring Module for MeatGeek V2
#
# Phase 1 observability layer: action group + budgets + diagnostic settings +
# 3 platform-metric alerts + 2 daily-ingestion-cap log search alerts + workbook
# stub. The 5 custom-metric alerts
# (device-disconnected, real-time error rate, storage p95 latency,
# temp-out-of-safe-range, cook-idle) intentionally land in ticket #6 alongside
# the StandardDimensions emitter — wiring them now produces always-green
# alerts (no telemetry source emits the required custom metrics yet),
# which is the anti-pattern the architect's synthesis called out.

# Budget start-date anchor. `time_static` captures the apply time ONCE and then
# persists it in state, so `time_static.budget_anchor.rfc3339` is stable across
# subsequent plans/applies. Deriving the budget start_date from this (instead of
# from the wall-clock time, which re-evaluates on every plan) keeps the first-of-month
# start date fixed and guarantees a 2nd-plan no-op even across a month boundary.
resource "time_static" "budget_anchor" {}

locals {
  # First-of-month budget start, derived from the persisted anchor (stable across
  # plans — see the time_static note above).
  budget_start_date = formatdate("YYYY-MM-01'T'00:00:00'Z'", time_static.budget_anchor.rfc3339)

  # Explicit budget END date. Azure defaults an OMITTED end_date to start + 10
  # years and then reports that concrete date back in state — so a config that
  # omits end_date never matches Azure and forces a delete+create (REPLACE) on
  # every plan. Declaring it explicitly at the same 10-year horizon makes config
  # == Azure so the budget plans as a no-op. formatdate cannot add years, so the
  # end year is the anchor year + 10 at the same month-01; derived from the
  # persisted time_static anchor (never wall-clock), so it does not drift.
  budget_end_date = format(
    "%04d-%s-01T00:00:00Z",
    tonumber(formatdate("YYYY", time_static.budget_anchor.rfc3339)) + 10,
    formatdate("MM", time_static.budget_anchor.rfc3339),
  )
}

# Action Group for alerts
resource "azurerm_monitor_action_group" "main" {
  name                = "${var.resource_prefix}-alerts"
  resource_group_name = var.resource_group_name
  short_name          = "meatgeek"

  email_receiver {
    name          = "admin"
    email_address = var.admin_email
  }

  tags = var.tags
}

# Budget alert for cost monitoring (resource-group scope, primary)
resource "azurerm_consumption_budget_resource_group" "main" {
  name = "${var.resource_prefix}-budget"
  # Use the RG id the module already receives (azurerm_resource_group.main.id),
  # NOT a string rebuilt from data.azurerm_client_config.current. Under the
  # OIDC/SP automatic-apply context that data source is read DURING APPLY, so its
  # subscription_id is unknown at plan time, which makes this (ForceNew)
  # resource_group_id "(known after apply)" and forces a spurious budget REPLACE
  # on any RG-touching change — which the destroy circuit-breaker then blocks.
  resource_group_id = var.resource_group_id

  amount     = var.budget_limit
  time_grain = "Monthly"

  time_period {
    start_date = local.budget_start_date
    end_date   = local.budget_end_date
  }

  notification {
    enabled   = true
    threshold = 80
    operator  = "GreaterThan"

    contact_emails = [
      var.admin_email
    ]
  }

  notification {
    enabled   = true
    threshold = 100
    operator  = "GreaterThan"

    contact_emails = [
      var.admin_email
    ]
  }
}

# Data source for current client config
data "azurerm_client_config" "current" {}

# -----------------------------------------------------------------------------
# Diagnostic settings: route platform/resource logs + metrics to the workspace
# Categories are scoped to what the o11y story actually needs — verbose
# categories are intentionally omitted to stay under the 2 GB/day cap.
# -----------------------------------------------------------------------------

resource "azurerm_monitor_diagnostic_setting" "iot_hub" {
  name                       = "${var.resource_prefix}-iothub-diag"
  target_resource_id         = var.iot_hub_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "Connections"
  }
  enabled_log {
    category = "DeviceTelemetry"
  }
  enabled_log {
    category = "Routes"
  }
  enabled_log {
    category = "C2DCommands"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "cosmos_db" {
  name                       = "${var.resource_prefix}-cosmos-diag"
  target_resource_id         = var.cosmos_db_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "DataPlaneRequests"
  }
  enabled_log {
    category = "QueryRuntimeStatistics"
  }

  # Azure EXPANDS AllMetrics for a Cosmos DB account into its concrete metric
  # categories (Requests, SLI) and reports those back in state — so a config of
  # ["AllMetrics"] never matches ["Requests","SLI"] and drifts in-place every
  # plan. Declaring the concrete categories makes config == Azure (2nd-plan
  # no-op). Cosmos is the only diag setting where AllMetrics does not round-trip
  # cleanly; the others (signalr/iot_hub/function_app) keep AllMetrics.
  enabled_metric {
    category = "Requests"
  }
  enabled_metric {
    category = "SLI"
  }
}

resource "azurerm_monitor_diagnostic_setting" "function_app" {
  name                       = "${var.resource_prefix}-functions-diag"
  target_resource_id         = var.function_app_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "FunctionAppLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "signalr" {
  name                       = "${var.resource_prefix}-signalr-diag"
  target_resource_id         = var.signalr_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  # Free_F1 SignalR exposes only the `allLogs` category GROUP — no individual
  # ConnectivityLogs/MessagingLogs/HttpRequestLogs categories on this tier.
  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

# -----------------------------------------------------------------------------
# 3 platform-metric alerts wired to the existing action group. The daily
# ingestion cap is watched by the two log search alerts further down.
# Custom-metric alerts (device-disconnected, real-time error rate,
# storage p95 latency, temp-out-of-safe-range, cook-idle) are deferred to #6.
# -----------------------------------------------------------------------------

resource "azurerm_monitor_metric_alert" "function_failure_rate" {
  name                = "${var.resource_prefix}-function-failure-rate"
  resource_group_name = var.resource_group_name
  scopes              = [var.application_insights_id]
  description         = "App Insights failed requests > 5 over a 5m window (Flex Function App has no platform failure metric; failures are detected via telemetry)"
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "microsoft.insights/components"
    metric_name      = "requests/failed"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 5
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

# Cosmos throttling fires only when sustained: more than 50 429s in 15 minutes.
# Single 429s are expected on the 400 RU/s free tier (the SDK retries them), and
# 50 in 15 minutes is 8x the worst 15-minute window seen across a week of deploys.
resource "azurerm_monitor_metric_alert" "cosmos_429_rate" {
  name                = "${var.resource_prefix}-cosmos-429-rate"
  resource_group_name = var.resource_group_name
  scopes              = [var.cosmos_db_id]
  description         = "Cosmos DB refused more than 50 requests with 429 (throttled: over the provisioned RU/s) in 15 minutes. Brief throttling during deploys is normal and the SDK retries it. This much, sustained, means users see slow or failed reads and writes. Check NormalizedRUConsumption and which collection and operation are throttled; also check function-failure-rate for requests that failed after retries."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.DocumentDB/databaseAccounts"
    metric_name      = "TotalRequests"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 50

    dimension {
      name     = "StatusCode"
      operator = "Include"
      values   = ["429"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

resource "azurerm_monitor_metric_alert" "signalr_connection_failure_rate" {
  name                = "${var.resource_prefix}-signalr-connection-failure-rate"
  resource_group_name = var.resource_group_name
  scopes              = [var.signalr_id]
  description         = "SignalR system errors > 5 over a 5m window"
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.SignalRService/SignalR"
    metric_name      = "SystemErrors"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    threshold        = 5
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# HAR-174 — daily-cap alerts as log search rules on the workspace.
#
# These two rules replaced a platform metric alert on the workspace that could
# not fire: it waited for a heartbeat metric that nothing in this system sends
# (removed in HAR-175). That rule was a metric alert rather than a log search on
# purpose, for one concern: a log query against the workspace it watches could
# become self-referential, because once the cap stops ingestion the query that
# looks for the cap might stop returning data and mask the very condition it is
# supposed to detect.
#
# Does that concern apply to these rules? No, for both:
#
#   * The cap stops billable data only. https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap:
#     the cap works by "stopping collection of billable log data for tables in
#     the Analytics or Basic table plans".
#   * Both tables these rules read are not billable.
#     https://learn.microsoft.com/en-us/azure/azure-monitor/logs/cost-logs
#     ("Excluded tables"): "Some tables are free from data ingestion charges
#     altogether, including, for example, AzureActivity, [...], Usage, and
#     Operation." `_LogOperation` reads the Operation table.
#   * Microsoft's own documented cap alert is a log search on this table
#     (daily-cap page, "Alert when daily cap is reached"):
#     `_LogOperation | where Category =~ "Ingestion" | where Detail contains "OverQuota"`.
#
# Proven live, not only inferred: no doc page states in so many words that the
# cap event row itself is ingested after the cap is reached, but on 2026-11-25
# (HAR-179), with the dev cap at 0.1 GB, the cap row was ingested at 09:43:35Z,
# after billable ingestion had stopped. Its Category was `Ingestion`, and this
# alert fired at 09:56:40Z.
# -----------------------------------------------------------------------------

# Rule 1 — the cap was reached and ingestion has stopped.
#
# Microsoft's query also filters `Category =~ "Ingestion"`. We drop that filter on
# purpose, because the docs disagree on the category:
#   * daily-cap page: "an operation event is sent to the *Operation* table under
#     the **LogManagement** category."
#   * https://learn.microsoft.com/en-us/azure/azure-monitor/logs/monitor-workspace
#     lists it under Category "Ingestion" with Detail "Data collection stopped
#     due to daily limit of free data reached. Ingestion status = OverQuota".
# The live row's Category was `Ingestion` (HAR-179).
# Filtering on Detail alone matches either.
#
# Evaluated every 15 minutes over a 30-minute window: the overlap covers the
# ingestion latency of the event row. 15 minutes costs a third of Microsoft's
# 5-minute example. The outage lasts until the daily reset, or until about 45
# minutes after the cap is raised (HAR-180), so 15 minutes of delay does not
# matter. Stateless (auto_mitigation off) with actions muted for an
# hour, so a cap event sends one email rather than one per evaluation that still
# sees the row.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "ingestion_cap_reached" {
  name                = "${var.resource_prefix}-ingestion-cap-reached"
  resource_group_name = var.resource_group_name
  location            = var.location
  scopes              = [var.log_analytics_workspace_id]
  description         = "Workspace ${var.log_analytics_workspace_name} reached its daily ingestion cap of ${var.ingestion_cap_gb} GB. Azure has stopped storing billable logs and telemetry (App Insights, Function App logs, diagnostic logs), and everything sent while capped is lost, not delayed. Ingestion resumes by itself at the workspace's daily reset hour. Raising the cap brings it back sooner, but not at once: in the 2026-11-25 test, data returned about 45 minutes after the cap was raised. Raising the cap costs money and is the owner's decision. Find which tables grew with: Usage | where IsBillable | summarize sum(Quantity) by DataType. Then fix the source."
  severity            = 1

  evaluation_frequency              = "PT15M"
  window_duration                   = "PT30M"
  auto_mitigation_enabled           = false
  mute_actions_after_alert_duration = "PT1H"

  criteria {
    query                   = "_LogOperation | where Detail contains \"OverQuota\""
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }

  action {
    action_groups = [azurerm_monitor_action_group.main.id]
  }

  tags = var.tags
}

# Rule 2 — billable ingestion is near the cap.
#
# Sums billable MB over a trailing 24 hours, checked hourly. `Usage.Quantity` is
# in MB (Microsoft's queries divide by 1000 for GB), so the threshold is
# cap_gb * 1000 * pct / 100: 1600 MB for the dev cap of 2 GB at 80%.
#
# The cap's own day starts at a per-workspace reset hour that "can't be
# configured" (daily-cap page) and that Terraform does not expose, so a trailing
# 24 hours is the honest proxy for "today's" ingestion.
#
# Usage is also free of ingestion charges (same cost-logs sentence above), so
# this rule keeps working at the cap too. Stateful (auto_mitigation on): one email
# when it crosses, one when it falls back.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "ingestion_near_cap" {
  name                = "${var.resource_prefix}-ingestion-near-cap"
  resource_group_name = var.resource_group_name
  location            = var.location
  scopes              = [var.log_analytics_workspace_id]
  description         = "Billable ingestion into workspace ${var.log_analytics_workspace_name} over the last 24 hours passed ${var.ingestion_warning_percent}% of the ${var.ingestion_cap_gb} GB daily cap. If it keeps growing, the cap will stop ingestion, and logs sent while capped are lost until the daily reset, or until about 45 minutes after the cap is raised. The cap's day starts at a reset hour Azure picks per workspace, so this rule measures a trailing 24 hours instead. Find which tables grew with: Usage | where IsBillable | summarize sum(Quantity) by DataType."
  severity            = 2

  evaluation_frequency    = "PT1H"
  window_duration         = "P1D"
  auto_mitigation_enabled = true

  criteria {
    query                   = "Usage | where IsBillable == true | summarize BillableMB = sum(Quantity)"
    time_aggregation_method = "Total"
    metric_measure_column   = "BillableMB"
    operator                = "GreaterThan"
    threshold               = var.ingestion_cap_gb * 1000 * var.ingestion_warning_percent / 100
  }

  action {
    action_groups = [azurerm_monitor_action_group.main.id]
  }

  tags = var.tags
}

# Secondary subscription-scope budget — warning before the $200 Azure credit
# is exhausted. Resource-group budget (above) is the primary; this one catches
# any spend that lands outside the meatgeek-{env}-rg group.
#
# MG-23 (automated dev GitOps reconciliation, CI-run) — COUNT-GUARDED, DEFAULT OFF.
# This is the ONE resource in the stack scoped OUTSIDE the workload resource group
# (/subscriptions/<id>), so writing it requires a subscription-scoped writer. The
# MG-23 CI apply identity is Contributor on meatgeek-v2-<env>-rg ONLY; leaving this
# unguarded made the whole configuration unappliable from CI. The boundary is
# resolved in the GRAPH rather than by widening the identity — widening would break
# the closed-escalation-path precondition the MG-23 threat model rests on.
# Subscription-scoped spend control is an operator/bootstrap concern; the
# RESOURCE-GROUP budget above is unaffected and remains the primary control.
# See the root apps/infrastructure/variables.tf comment on manage_subscription_budget
# (including the `terraform state rm` note for dev, which already applied it).
resource "azurerm_consumption_budget_subscription" "credit_budget" {
  count = var.manage_subscription_budget ? 1 : 0

  name            = "${var.resource_prefix}-credit-budget"
  subscription_id = "/subscriptions/${var.subscription_id}"

  amount     = var.secondary_budget_limit
  time_grain = "Monthly"

  time_period {
    start_date = local.budget_start_date
    end_date   = local.budget_end_date
  }

  notification {
    enabled   = true
    threshold = 80
    operator  = "GreaterThan"

    contact_emails = [
      var.admin_email
    ]
  }

  notification {
    enabled   = true
    threshold = 100
    operator  = "GreaterThan"

    contact_emails = [
      var.admin_email
    ]
  }
}

# -----------------------------------------------------------------------------
# MG-23 F5 — OUT-OF-BAND PERSISTENCE DETECTIVE CONTROLS
#
# MG-23 is automated dev GitOps reconciliation (CI-run). Its final `terraform plan
# -detailed-exitcode` proves CONVERGENCE, but only of Terraform-MANAGED control-
# plane resources. It is blind to exactly the changes an attacker who reached the
# apply identity would make, because they are not in the Terraform graph:
#
#   1. Microsoft.Authorization/roleAssignments/write — a NEW role assignment inside
#      meatgeek-v2-<env>-rg. The apply identity holds CONDITIONED Role Based Access
#      Control Administrator here; the ABAC condition constrains WHICH role and
#      WHICH principal type, but it CANNOT constrain SCOPE (residual F4), so an
#      allowlisted data role can legitimately be re-granted RG-wide. That is
#      persistence/stealth rather than a boundary break — it does not exceed the
#      SP's own Contributor — and THIS ALERT is its compensating control.
#   2. Microsoft.ManagedIdentity/userAssignedIdentities/write — a new user-assigned
#      identity is a durable, Terraform-invisible foothold.
#   3. Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write — Cosmos
#      DATA-PLANE role assignments (residual F6). These are granted by plain
#      Contributor, are invisible to a Microsoft.Authorization ABAC condition, and
#      accept USER principals — the clearest gap versus the condition's
#      "service-principals only" intent. Accepted for dev (7-day-TTL test data);
#      detection is the control, not prevention.
#
# Scoped to the workload RESOURCE GROUP (never the subscription) so these controls
# live inside the same boundary the CI apply identity is confined to. Wired to the
# existing action group, so they reach the same operator as every other alert.
# These are DETECTIVE, not preventive: they fire AFTER the write succeeds.
# -----------------------------------------------------------------------------

resource "azurerm_monitor_activity_log_alert" "role_assignment_write" {
  name                = "${var.resource_prefix}-role-assignment-write"
  resource_group_name = var.resource_group_name
  location            = "global"
  scopes              = [var.resource_group_id]
  description         = "A role assignment was written inside ${var.resource_group_name}. Expected only from the Terraform-managed graph; anything else is out-of-band RBAC persistence the final drift plan cannot see (MG-23 F4/F5)."

  criteria {
    category       = "Administrative"
    operation_name = "Microsoft.Authorization/roleAssignments/write"
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

resource "azurerm_monitor_activity_log_alert" "user_assigned_identity_write" {
  name                = "${var.resource_prefix}-user-assigned-identity-write"
  resource_group_name = var.resource_group_name
  location            = "global"
  scopes              = [var.resource_group_id]
  description         = "A user-assigned managed identity was written inside ${var.resource_group_name} — a durable foothold that is invisible to the MG-23 final drift plan unless it is in the Terraform graph (MG-23 F5)."

  criteria {
    category       = "Administrative"
    operation_name = "Microsoft.ManagedIdentity/userAssignedIdentities/write"
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

resource "azurerm_monitor_activity_log_alert" "cosmos_sql_role_assignment_write" {
  name                = "${var.resource_prefix}-cosmos-sql-role-assignment-write"
  resource_group_name = var.resource_group_name
  location            = "global"
  scopes              = [var.resource_group_id]
  description         = "A Cosmos DB DATA-PLANE (sqlRoleAssignments) role assignment was written inside ${var.resource_group_name}. Granted by plain Contributor, invisible to a Microsoft.Authorization ABAC condition, and accepts USER principals — the accepted MG-23 residual F6. Detection is the control."

  criteria {
    category       = "Administrative"
    operation_name = "Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write"
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Workbook stub — content lands in ticket #6.
# -----------------------------------------------------------------------------
resource "azurerm_application_insights_workbook" "main" {
  name                = "5a3c1d2e-7b4f-4a0e-9c1a-000000000006"
  resource_group_name = var.resource_group_name
  location            = var.location
  display_name        = "${var.resource_prefix}-observability"

  data_json = jsonencode({
    version = "Notebook/1.0"
    items = [
      {
        type = 1
        content = {
          json = "Populated in ticket #6"
        }
      }
    ]
    isLocked = false
    fallbackResourceIds = [
      "Azure Monitor"
    ]
  })

  tags = merge(var.tags, {
    Service = "Monitoring"
  })
}

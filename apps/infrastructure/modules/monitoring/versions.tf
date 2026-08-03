# Monitoring module provider requirements.
#
# The `time` provider is declared HERE (module-local) rather than in the root so
# the dependency stays with the resource that needs it. `time_static.budget_anchor`
# pins the monthly-budget start date at first apply, replacing the previous
# wall-clock-derived start_date that rolled over every month boundary and
# produced a perpetual plan diff (breaking the 2nd-plan-no-op invariant).
#
# azurerm is constrained here too (MG-39). This module declared only `time`, so a
# standalone `terraform init` resolved azurerm with NO constraint at all and took
# whatever the registry served — which became the breaking v5.0.1 on 2026-08-03.
# The whole codebase targets azurerm 4.x; v5 is a separate, deliberate migration.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }
}

# Monitoring module provider requirements.
#
# The `time` provider is declared HERE (module-local) rather than in the root so
# the dependency stays with the resource that needs it. `time_static.budget_anchor`
# pins the monthly-budget start date at first apply, replacing the previous
# wall-clock-derived start_date that rolled over every month boundary and
# produced a perpetual plan diff (breaking the 2nd-plan-no-op invariant).
terraform {
  required_providers {
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }
}

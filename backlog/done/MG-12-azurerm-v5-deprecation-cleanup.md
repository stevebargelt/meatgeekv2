---
id: MG-12
type: story
status: done
title: azurerm-v5-deprecation-cleanup
closed: 2026-07-21
closed_commit: c37397a0d2073a9f83947437266a72ccd7a98b84
---

#### Context
4 `azurerm_monitor_diagnostic_setting` resources in `apps/infrastructure/modules/monitoring/main.tf:67-143` use the deprecated `metric { category = "AllMetrics"; enabled = true }` form. AzureRM provider warns this will be removed in v5.0. Currently advisory only.

#### Acceptance Criteria
- [ ] All 4 diagnostic-setting resources migrated from `metric { ... }` blocks to the `enabled_metric` property form
- [ ] `terraform validate` clean with no deprecation warnings on these resources
- [ ] Bundle any other azurerm v5 forward-compat lint warnings if they appear

#### Notes
Not blocking until you actually upgrade to azurerm v5. Could be deferred until just before that upgrade.
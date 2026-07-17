---
id: MG-10
type: story
status: active
title: infra-security-hardening
---

#### Context
Pre-existing security issues red-wide flagged during #1's review. Out of scope for #1 (which was o11y-focused) but should be addressed before this infra goes near a production environment.

#### Acceptance Criteria
- [ ] Azure subscription ID removed from hardcoded provider config in `apps/infrastructure/main.tf:~25`; use environment variable, var, or terraform.tfvars
- [ ] CORS on SignalR + Azure Functions narrowed from `*` to known origins
- [ ] Functions module: replace storage account primary access key in plaintext app settings with managed identity (`azurerm_user_assigned_identity` + role assignment on the storage account)
- [ ] Other secrets in plaintext `app_settings` (connection strings, etc.) migrated to Key Vault references or managed identity
- [ ] CORS `support_credentials` decision aligned with chosen authentication scheme
---
id: MG-15
type: story
status: active
title: repository secret remediation before remote publication
created: 2026-07-17
---

#### Context
The canonical repository currently has no remote, which gives us a safe window to remediate tracked credential material before publication. A local-only scan found a real-looking Application Insights connection string in the current tracked tree and history. Project handoff history also documents a New Relic credential that was removed from current source but remains in Git history. Ignored local.settings.json and Terraform state contain local configuration and must remain untracked. Never put credential values in tickets, logs, commits, or agent prompts.

#### Acceptance Criteria
- [ ] The API development environment reads its Application Insights connection string from a local environment/config source and contains no tracked live value
- [ ] Any live Application Insights and New Relic credentials identified during local triage are rotated or revoked by the account owner before publication
- [ ] Known credential values are removed from Git history after rotation/revocation and after a verified backup exists
- [ ] local.settings.json, Terraform state, and comparable machine-local secret-bearing files remain ignored and untracked
- [ ] A full tracked-history secret scan is clean, or every remaining finding is documented as a reviewed false positive without copying its matched value
- [ ] No Git remote is created or pushed until the preceding publication-safety gates pass
- [ ] README clone/setup instructions describe the actual remote and safe local configuration only after that remote exists
---
id: MG-15
type: story
status: active
title: repository secret remediation before remote publication
created: 2026-07-17
---

#### Context
The canonical repository currently has no remote, which gives us a safe window to remediate historical credential material before publication. The sole Gitleaks tracked-history finding was locally reviewed and is the documented Azure Cosmos DB Emulator default key, not a live project credential. The development App Insights value is an all-zero placeholder; the other development service values are explicitly fake. Project handoff history does document a New Relic credential that was removed from current source but remains in Git history. Ignored local.settings.json and Terraform state contain local configuration and must remain untracked. Never put credential values in tickets, logs, commits, or agent prompts.

#### Acceptance Criteria
- [x] The Gitleaks history finding is locally classified as the documented Cosmos DB Emulator default-key false positive without copying its value into project records
- [ ] The account owner confirms the historical New Relic credential has been rotated/revoked, or rotates/revokes it before publication
- [ ] The known historical New Relic credential is removed from Git history after rotation/revocation and after a verified backup exists
- [x] local.settings.json and Terraform state are confirmed ignored and untracked
- [ ] A post-rewrite tracked-history scan is clean except for the reviewed emulator-key false positive; a separate targeted check confirms the historical New Relic value is absent
- [ ] No Git remote is created or pushed until the preceding publication-safety gates pass
- [ ] README clone/setup instructions describe the actual remote and safe local configuration only after that remote exists
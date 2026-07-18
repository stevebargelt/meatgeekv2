---
id: MG-19
type: story
status: active
title: fix CI pipeline and enable branch protection on main
created: 2026-07-18
---

### Context
First push to the new public GitHub remote (MG-15) triggered CI/CD Pipeline (.github/workflows/ci.yml) for the first time. It fails: the committed package-lock.json is out of sync with package.json, so `npm ci` errors on clean Linux runners (Missing: babel-plugin-macros@3.1.0, cosmiconfig@7.1.0, yaml@1.10.3 from lock file). The setup and security-scan jobs die at the Install step; lint-and-test and build-typescript are skipped because they depend on setup. build-go (both) and validate-infrastructure pass. Merge checks cannot be required until the pipeline is green.

### Acceptance Criteria
- [ ] package-lock.json reconciled with package.json so `npm ci` succeeds from a clean checkout (no missing-from-lock errors); lockfile committed
- [ ] The setup job's affected-projects detection works on the aligned Nx 19.8 line (replace `nx print-affected` if it is removed/deprecated in 19.8; verify the step runs after install succeeds)
- [ ] security-scan job passes on a clean runner (confirm the only failure cause was the npm ci break; fix any residual)
- [ ] On push to main, these quality jobs are green: lint-and-test, build-typescript, build-go (data-pusher), build-go (device-controller), validate-infrastructure, security-scan
- [ ] Branch protection applied to main requiring the green quality-job contexts (NOT deploy-dev/deploy-prod); enforce_admins off so solo direct pushes still work
- [ ] No deployment executed; no Azure credentials/secrets added to the repo
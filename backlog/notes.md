**Last session ended 2026-07-19.**

**Where we left off:** Shipped MG-21 (prod deploy split) end-to-end via PR #2 — merged to main as `dc5df4d`. Clean tree. The CI-hardening arc (MG-20/22/21) is complete; deploy is now split and the red-on-every-push symptom is gone.

**Picked up next:**
1. **MG-23** — mirror the infra/app deploy split for dev (`develop`): `infra-deploy-dev.yml` + `app-deploy-dev.yml`, remove `deploy-dev` from `ci.yml`. ALSO remove the now-orphaned build-artifact upload from `ci.yml` at that point (it's retained today only because `deploy-dev` still downloads it — see MG-21). Precedent: the two prod workflows are the template; dev is a near-mechanical copy with `dev.tfvars`/`AZURE_CREDENTIALS`.
2. **MG-24** — wire the terraform `azurerm` remote backend (`backend-config.hcl` exists, unwired), THEN enable infra auto-apply-on-merge (add the `push`+`apps/infrastructure/**` trigger to `infra-deploy-prod.yml`, and dev's). Blocker MG-21 deferred: today terraform runs on local state, so auto-apply would plan against empty state and try to recreate all prod infra.
3. **Feature work** — MG-9 (data-models bug fixes; ready characterization-test AC — cleanest start), MG-14 (Phase 2 SignalR cook events), MG-6 (OTel).

**Shipped this session (2026-07-18 → 07-19):**
- **MG-20** — pinned npm 10.9.8 (`packageManager` + `corepack enable` in CI). Guard `ci-toolchain-pin.spec.ts`. Manual `npx npm@10` workaround retired.
- **MG-22** — `nrwl/nx-set-shas@v4` so nx-affected works on PRs (was `git diff main HEAD`, fails in PR checkout). Both shipped in PR #1 (`56b0038`).
- **MG-21** — split prod deploy out of `ci.yml`'s monolithic `deploy-prod`:
  - `infra-deploy-prod.yml` — `workflow_dispatch` ONLY (auto-apply-on-merge deferred to MG-24).
  - `app-deploy-prod.yml` — push to `main` on `apps/api/**`+`libs/**` + dispatch; **API-only** (`nx deploy api --env=prod`); self-contained build; credential-skip guard on `AZURE_CREDENTIALS_PROD`.
  - Both: `environment: production` (reviewer-less), concurrency `cancel-in-progress: false`.
  - `deploy-prod` removed from `ci.yml`; build-artifact upload RETAINED (deploy-dev still needs it).
  - Guard `prod-deploy-split.spec.ts` (14 assertions, incl. that the guard reads the secret & derives `has_creds`). Docs reconciled: `ci-cd.md`, `nx-commands.md`, `meatgeekV2-plan.md`.
  - **Post-merge PROVEN**: `app-deploy-prod` triggered (merge touched `libs/**`), guard job succeeded, `deploy-api` job SKIPPED (no creds) → workflow success not failure. `infra-deploy-prod` did NOT trigger (dispatch-only). ci.yml green.

**External state to remember:**
- GitHub repo PUBLIC. Branch protection on `main`: required checks setup, lint-and-test x4, build-typescript x2, build-go x2, validate-infrastructure, security-scan; deploy jobs/workflows EXCLUDED; enforce_admins off.
- npm pinned (MG-20); PRs work in CI (MG-22); prod deploy split + gated (MG-21).
- Prod deploy secrets: `AZURE_CREDENTIALS_PROD` (repo or `production` env) — currently ABSENT, so app-deploy-prod skips green. Prod is API-ONLY (no prod web deploy). Terraform still on LOCAL state (MG-24 to fix).

**Decisions worth not relitigating:**
- MG-21 rescoped mid-flight: the architect (via a red) caught that prod deploy is API-only (web is dev-only) and terraform has no remote backend. Operator chose: prod API-only, infra dispatch-only, defer auto-apply+backend to MG-24. Full pipeline abandoned, re-routed to quick chain.
- The `ci.yml` build-artifact upload is NOT orphaned while `deploy-dev` lives there (deploy-dev downloads it). Removing it broke dev — review-loop caught it. Remove only when MG-23 splits deploy-dev.
- MG-21 took ~7 review-loop rounds; every finding was legitimate (removed-job guard ref, upload/deploy-dev break, weak guard test, three stale deploy docs, stale handoff note). The loop earned its keep.
- Binding INTERIM durable-dispatch rule still in effect: all Forge agent/multi-minute commands via `forge launch run` + ScheduleWakeup, never synchronous Bash — until FG-552/562/563.

**Shipped (older, for reference):** MG-15 (secret scrub + public publish), MG-16 (Nx alignment), MG-17 (goqueue race), MG-18 (TS build boundaries), MG-19 (CI repair + branch protection).

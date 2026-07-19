**Last session ended 2026-07-18.**

**Where we left off:** Shipped MG-20 (npm pin) end-to-end via PR #1 — the repo's first-ever PR. That PR surfaced a latent CI bug, filed and fixed as MG-22 in the same PR. Both merged to main as `56b0038` and closed. Clean tree.

**Picked up next:**
1. **MG-21** — gate the Azure deploy jobs. Confirmed live symptom: `deploy-prod` is the ONLY failing job on every push to `main` (no Azure creds) — it made the post-merge main run show overall red while every required check was green. Excluded from branch protection so it doesn't block, but it's noise and blindly attempts a prod deploy each push. High-leverage cleanup, small.
2. **Feature work** — MG-9 (data-models bug fixes; ready characterization-test AC — cleanest start), MG-14 (Phase 2 SignalR cook events), MG-6 (OTel).

**Shipped this session:**
- **MG-20** — pinned npm to 10.9.8 via `"packageManager"` in root package.json + `corepack enable` before `npm ci` in all 4 install jobs. Lockfile was already canonical under npm 10 (zero diff). Guard test `libs/api-interfaces/src/lib/ci-toolchain-pin.spec.ts` (5/5). Docs reconciled (ci-cd.md, local-setup.md, README Quick Start) — manual `npx npm@10 install --package-lock-only` workaround RETIRED; run `corepack enable` once in a fresh clone.
- **MG-22** — CI `setup` job computed nx-affected via `git diff main HEAD`, which fails on PR checkouts (no local `main` ref). Added `nrwl/nx-set-shas@v4` before the affected step (last-successful-commit base on push, merge-base on PR — avoids the trap where a static `origin/main` base skips all tests on push-to-main). Verified: PR setup green + downstream ran; push-to-main setup green + downstream ran.

**External state to remember:**
- GitHub repo PUBLIC at github.com/stevebargelt/meatgeekv2. Branch protection on `main`: required checks setup, lint-and-test x4, build-typescript x2, build-go x2, validate-infrastructure, security-scan; deploy jobs EXCLUDED; enforce_admins off.
- npm is now pinned (MG-20) — corepack supplies npm 10.9.8 for CI + local. No more manual lockfile regen.
- PRs now work in CI (MG-22) — the branch → PR → review-loop → merge flow is functional end-to-end (proven by PR #1).

**Decisions worth not relitigating:**
- MG-20 review round 1 flagged a stale `backlog/notes.md` line (orchestrator-owned; fixed directly) and round 2 flagged README Quick Start missing `corepack enable` (fixed via docs-maintainer). Both legit; folded in.
- MG-22 was found mid-MG-20 (first PR exposed it). Operator chose Option A: fold the fix into PR #1 rather than a separate PR (which would've hit the same bug). nx-set-shas over a static base — correctness (push-event affected-detection) was the deciding factor.
- Binding INTERIM durable-dispatch rule still in effect: all Forge agent/multi-minute commands via `forge launch run` + ScheduleWakeup, never synchronous Bash — until FG-552/562/563.

**Shipped (older, for reference):** MG-15 (secret scrub + public publish), MG-16 (Nx alignment), MG-17 (goqueue race), MG-18 (TS build boundaries), MG-19 (CI repair + branch protection). Still OPEN and filed: MG-21 (deploy gating).

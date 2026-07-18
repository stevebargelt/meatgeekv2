**Last session ended 2026-07-18.**

**Where we left off:** Publication + CI-hardening arc, now complete — MeatGeek V2 published to GitHub (public) and `main` branch-protected with a green quality pipeline. No mid-flight thread; ended on "what next" with feature work as the open question.

**Picked up next:**
1. **MG-20** — pin npm (add `packageManager`/CI npm-install step). The npm11-vs-npm10 lockfile skew re-broke `npm ci` on CI twice this session; this is the durable fix and prevents the next agent that runs `npm install` from re-breaking it. High leverage, small.
2. **MG-21** — gate the Azure deploy jobs. Non-ticket symptom to know: `deploy-prod` FAILS on every push to `main` (no Azure creds), so every otherwise-green run shows overall red. It's excluded from the merge gate so it doesn't block, but it's noise and attempts a prod deploy on every push.
3. **Feature work** — MG-9 (data-models bug fixes; has a ready characterization-test AC), MG-14 (Phase 2 SignalR cook events), MG-6 (OTel). Phase 1 is substantially built; these move toward Phase 2.

**External state to remember:**
- GitHub repo is now PUBLIC at github.com/stevebargelt/meatgeekv2. Branch protection on `main`: 11 quality checks required (setup, lint-and-test x4, build-typescript api+web, build-go x2, validate-infrastructure, security-scan), deploy jobs EXCLUDED, `enforce_admins` off (solo direct pushes work).
- New Relic credential confirmed rotated (operator) and scrubbed from all git history. Pre-publish backup mirror at `~/code/meatgeekv2-prepublish-backup-20260717.git` — safe to delete once you trust the published history.
- CI runner is Node 20 / npm 10; local + agent tooling default to npm 11. Lockfile MUST be generated under npm 10 (`npx npm@10 install --package-lock-only`) until MG-20 lands.

**Decisions worth not relitigating:**
- MG-18 red-review was OVERRIDDEN (operator-confirmed): reviewer claimed TS6059 persisted; CI proved build green. Its local-only fix was discarded. CI is the deterministic truth here.
- TS6059 fix is the Nx buildable-lib pattern (per-lib `package.json` name = alias drives `@nx/js:tsc` dist remap), NOT project references (@nx/js:tsc non-batch ignores them). `tsconfig.base` aliases intentionally stay on source for Jest/IDE.
- Repo published PUBLIC (deliberate operator choice), not private.
- Binding INTERIM durable-dispatch rule in effect (saved to project memory): all Forge agent/multi-minute commands go via `forge launch run` + a Monitor observer, never synchronous Bash — until FG-552/562/563.

**Shipped (for reference):** MG-15 (secret scrub + public publish), MG-16 (Nx alignment), MG-17 (goqueue race), MG-18 (TS build boundaries), MG-19 (CI repair + branch protection). Filed MG-20 (npm pin), MG-21 (deploy gating).

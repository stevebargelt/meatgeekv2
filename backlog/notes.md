**Session 2026-08-03. MG-42 MERGED but NOT closed. MG-39 partially shipped. Azure subscription is DOWN.**

## DO THIS FIRST ON 2026-08-06 — MG-42 AC4

VSE02 (`c7e800cb`) is **DISABLED** — MSDN monthly credit exhausted, `spendingLimit: On`. Operator
decided 2026-08-03 NOT to pay to restart early. **Credit resets 2026-08-06.** The moment it is
back, finish MG-42 AC4. It needs NO code — the implementation is merged and reviewed.

1. Verify the sub is live: `az account list --refresh --all` (NOT `az account show` — that reads
   the CLI's cached profile and lied about this all session, reporting Enabled while ARM said Disabled).
2. `az login` as Owner; `az account set --subscription c7e800cb-0ee6-4175-9605-a6b97c6f419f`.
3. `cd apps/infrastructure/bootstrap && ./bootstrap.sh` from main.
4. Confirm all three fed creds carry `repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:<env>`.
   Baseline captured 2026-08-03: `infra-apply-dev` (8d7d37cb) already correct — a re-run MUST leave
   it alone; `appdeploy-dev` (8426e178) and `oidc-prod` (3e1ac1f5) still on the BROKEN default prefix.
5. Trigger an environment-scoped `azure/login`, confirm no `AADSTS700213`.
6. Then close MG-42 with the Acceptance Evidence grid (AC1/2/3/5 evidence is already written into
   the ticket body; only AC4's row is missing).

The old "do NOT re-run bootstrap.sh" hazard is GONE — the integration suite proves, against the
verbatim live API response, that a re-run leaves the hand-corrected credential untouched.

## Then MG-47 — cost analysis (operator asked for this explicitly)

Why the credit died, what to cut, and **fix the alerting that let it happen silently** — budgets
were configured (50 RG / 150 subscription, admin_email set) and nobody was told. Concrete lead
already found: Cosmos `enable_free_tier` defaults false and dev never sets it, while dev uses
400 RU/s against a 1000 RU/s free allowance. Also disposition IoT Hub S1 and Event Hub Standard
(both always-on, no scale-to-zero). **MG-47 gates MG-25** — prod activation adds a second stack.

## What shipped 2026-08-03

- **MG-39 AC#2 ONLY** (`0209495`, PR #34) — azurerm v5.0.1 floated in and broke `azurerm_eventhub`,
  turning every PR red and leaving main latent-red. Pinned `~> 4.0` in all modules, tracked six
  multi-platform locks, `-lockfile=readonly`, and tf-static-checks **check 16** gating CI-invoked
  modules. MG-39 REMAINS OPEN: snyk@master SHA-pinning + SNYK_TOKEN, and prod-workflow `uses:` pinning.
- **MG-42** (`879efbb`, PR #33) — derived OIDC subject prefix, integration suite, runbook guards,
  bash-3.2 test fix, CI completion guard. Merged, 11/11 green. **Still OPEN on AC4 only.**

## Filed this session (all from real evidence, not speculation)

MG-43 (runbook guard harness + 4 pre-existing blocks that fail `bash -n`), MG-44 (CI bash-3.2
matrix), MG-45 (forge-test unusable here — package-lock babel-plugin-macros trips `npm ls --all`;
every agent improvises its own validation until fixed), MG-46 (completion guard trusts the suite's
self-reported pass count), MG-47 (cost analysis).

## Hard-won lessons — do not relearn these

- **macOS `/bin/bash` is 3.2.57 and there is no newer bash on this box.** A `case` with quoted
  patterns lexically inside a `$( … )` is mis-parsed by 3.2 but fine on CI's bash 5. It bit TWICE
  this session (MG-42 F5 truncated `bootstrap.test.sh` at 229/321 silently; MG-39's new check 16
  aborted `tf-static-checks.sh`). **`bash -n` does NOT detect it** — bash defers parsing of `$( )`
  bodies, so a syntax check passes on known-broken code. Only execution finds it. That is MG-44.
- **This repo has NO dedicated worktree.** Never switch branches or run two agents while an agent
  is live — a bounded recheck was destroyed that way this session and had to be re-run.
- **Run things on macOS yourself.** Three of seven MG-42 findings came from the orchestrator
  executing on the real platform, not from any reviewer; containers are bash 5 and cannot see them.
- The dev auto-apply loop triggers on `workflow_run` of CI, which fires for PR runs too — those
  show as `skipped` via the `head_branch == main` gate. A skipped apply is usually NOT drift.

**Session 2026-08-03/04. THREE PRs merged. MG-42 open on AC4 only. Azure subscription VSE02 is DOWN until 2026-08-06.**

## DO THIS FIRST WHEN THE CREDIT RESETS (2026-08-06)

VSE02 (`c7e800cb`) is **DISABLED** — MSDN monthly credit exhausted, `spendingLimit: On`. Operator
decided NOT to pay to restart early. Everything below is blocked on the reset.

**Order matters — AC4 first, it is fastest and unblocks the dev GitOps loop.**

### 1. MG-42 AC4 — closes the ticket, NO code needed (all merged)
1. `az account list --refresh --all` — **NOT `az account show`**, which reads a CACHED profile and
   reported `Enabled` for a disabled subscription all through 2026-08-03. Cost a wrong assertion.
2. `az login` as Owner; `az account set --subscription c7e800cb-0ee6-4175-9605-a6b97c6f419f`
3. `cd apps/infrastructure/bootstrap && ./bootstrap.sh` from main
4. Confirm all three fed creds carry `repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:<env>`.
   Baseline: `infra-apply-dev` (8d7d37cb) already correct — a re-run MUST leave it alone;
   `appdeploy-dev` (8426e178) and `oidc-prod` (3e1ac1f5) still on the BROKEN default prefix.
5. Environment-scoped `azure/login` succeeds, no `AADSTS700213`
6. Close MG-42 with the Acceptance Evidence grid — AC1/2/3/5 evidence is already in the ticket body,
   only AC4's row is missing.

The old "never re-run bootstrap.sh" hazard is GONE — the integration suite proves against the
verbatim live API response that a re-run leaves the hand-corrected credential untouched.

### 2. MG-48 Phase 1 — ~$50-60/mo, no data risk. Full runbook is IN THE TICKET.
**Gotcha that will waste your first attempt:** APIM is `Suspended` separately from the subscription.
`az apim backup` and `az apim api export` are served by the INSTANCE and both fail while it holds
(verified: `Invalid API Management service state: Suspended`), even though `az apim show` answers
fine. MG-48 step 0b polls `provisioningState` until it leaves `Stopped`.
Then: backup -> **verify blob is MEGABYTES** -> download + hash OFF Azure -> export OpenAPI -> delete.

### 3. MG-48 Phase 2 — ~$24/mo more. SMOKE THE EXPORT TOOL ON V2 DEV FIRST (step is in the ticket).
### 4. MG-47 — real per-RG spend, Cosmos throughput check, and fix the budget alerting that failed silently.

## Shipped this session

- **MG-39 AC#2** (`0209495`, PR #34) — azurerm floated to v5.0.1 and broke `azurerm_eventhub`,
  leaving every PR red and main latent-red. Pinned `~> 4.0`, six tracked multi-platform locks,
  `-lockfile=readonly`, tf-static-checks **check 16**. MG-39 REMAINS OPEN: snyk@master SHA-pinning
  + SNYK_TOKEN, and prod-workflow `uses:` pinning.
- **MG-42** (`879efbb`, PR #33) — derived OIDC subject prefix, integration suite, runbook guards,
  bash-3.2 test fix, CI completion guard. **Still OPEN on AC4 only.**
- **MG-48 export tool** (`c107fca`, PR #35) — read-only, count-reconciled Cosmos exporter,
  50 tests, CI-wired. Real SDK path deliberately unexercised; covered by the V2-dev smoke run.

## Filed this session (all from evidence, not speculation)

MG-43 (runbook guard harness + 4 blocks that fail `bash -n`), MG-44 (CI bash-3.2 matrix),
MG-45 (forge-test unusable here — package-lock trips `npm ls --all`; agents improvise validation
until fixed), MG-46 (completion guard trusts self-reported pass count), MG-47 (cost analysis),
MG-48 (retire V1 — ~$85-100/mo, with full runbooks).

## Cost picture (operator-supplied actuals, ~$182.40/cycle)

VMs 43.58, Cosmos 41.52, APIM 34.61, IoT Hub 23.39, Event Hubs 21.77, Storage 17.53.
**VSE02 hosts FOUR projects — MeatGeek V2 is only about a THIRD.** V1 legacy is roughly half:
APIM Developer ($34.61, 100% V1, and there is no APIM in the V2 terraform), a second paid S1 IoT
Hub (`testhubmeatgeek`, a TEST hub), a Cosmos account, 4 storage accounts. Constellation and
forge-ntfy are also in here. **V1 holds the subscription's single Cosmos free-tier slot**, which is
why V2 pays ~$24/mo it need not. Operator confirmed nothing calls the V1 API.

## Hard-won lessons — do not relearn

- **macOS `/bin/bash` is 3.2.57, no newer bash on this box.** A `case` with quoted patterns
  lexically inside `$( … )` is mis-parsed there but fine on CI bash 5. Bit TWICE this session
  (MG-42 F5 truncated `bootstrap.test.sh` at 229/321; MG-39's check 16 aborted tf-static-checks).
  **`bash -n` does NOT detect it** — bash defers parsing `$( )` bodies. Only execution finds it. MG-44.
- **No dedicated worktree.** Never switch branches or run two agents while one is live — a bounded
  recheck was destroyed that way and had to be re-run.
- **Run things on macOS yourself.** Three of MG-42's seven findings came from the orchestrator
  executing on the real platform; containers are bash 5 and cannot see that class.
- **`az account show` lies** (cached profile). Use `az account list --refresh`.
- The dev auto-apply triggers on `workflow_run` of CI, which fires for PR runs too — those show
  `skipped` via the `head_branch == main` gate. A skipped apply is usually NOT drift.
- The apply's post-apply secret gate correctly distinguishes "could not read state" (fail closed)
  from "never bound state" (nothing to inspect, exit 0). A `success` on a backlog-only commit is
  not a fail-open.

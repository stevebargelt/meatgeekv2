**Last session ended 2026-08-06.**

**Where we left off:** The Cosmos free-tier claim is the only open thread. It was attempted and
FAILED mid-apply (Azure `IH400111` — cannot delete a routing endpoint a route still references),
which briefly destroyed the Function App's Cosmos role assignment before being reverted. The root
cause is now fixed, guarded and merged (`29cebf2`, PR #37). Re-landing was deliberately deferred
to a fresh session rather than retried at the end of a long one.

**Picked up next:**

1. **MG-48 — re-land the Cosmos free tier (~$24/mo). The full step-by-step is IN THE TICKET; read
   it first.** Short form: `git revert a2dab91` -> push -> the automatic apply refuses at the
   destroy guard (expected, that path cannot carry authorization — MG-50) -> read the token set
   that failed run prints -> **expect SEVEN tokens now, not five** (both IoT Hub routes joined the
   chain via the ordering fix; that growth is the fix working) -> `workflow_dispatch`
   `Apply Dev Infrastructure` with that exact set -> approve the `development-infra-apply-recovery`
   gate -> verify `enableFreeTier=true`, 5 containers, 2 Cosmos role assignments, both routes
   enabled, and the run's FINAL DRIFT PLAN green (that step is the real verdict).
   **If it stalls partway: revert FIRST to restore dev, diagnose second.** That is what worked.
2. **MG-47 — cost analysis.** The retirement is done, so the useful move now is measuring the NEXT
   cycle against ~$182 baseline and, more importantly, fixing the budget alerting that let the
   credit empty silently (budgets were configured at 50/150 with `admin_email` set, and nobody was
   told). MG-47 also gates MG-25 prod activation.
3. **MG-50 — the GitOps destroy-authorization gap.** Sizeable change to a safety-critical path;
   treat as `implementation_full`, not a quick fix. It is the direct cause of MG-38's condition.

**External state to remember:**

- **VSE02 is live again** — MSDN credit reset 2026-08-06. It had been DISABLED since ~2026-08-03,
  which is what blocked everything. `az account show` reads a CACHED profile and reported
  `Enabled` while ARM said `Disabled` — always use `az account list --refresh`.
- **`~/meatgeek-v1-archive/` (84 MB) is OFF-REPO and holds the only copy of some V1 artifacts:**
  the APIM backup blob (sha256-verified; restores only INTO an APIM instance), OpenAPI for both V1
  APIs, ARM templates for all six V1 resource groups, the 73 MB arm64 telemetry image (.NET 6 IoT
  Edge module) + reconstructed Dockerfile, Event Hubs topology, and **9,886 Cosmos documents
  (42 sessions / 9,843 statuses / 1 cook), triple-verified**. Back it up somewhere durable.
- V1 source also survives in GitHub: `meatgeek-azure-sessions`, `MeatGeek-IoT`,
  `meatgeek-azure-proxies`, `MeatGeek-Shared` (archived), `MeatGeek-IoTEdge`.
- `meatgeek-archive-rg` was created by hand (deliberately NOT terraform-managed) purely as a write
  target for the APIM backup. Safe to delete once the archive is duplicated off-Azure.
- Soft-deleted Key Vault `meatgeekkv` auto-purges **2026-11-04**; the APIM name stays reserved for
  its soft-delete window. Both free, no action.
- GitHub Actions had a **critical incident** on 2026-08-06 (webhooks throttled to ~15%); three CI
  runs were cancelled mid-flight and looked like failures. Recovered late in the session.

**Decisions worth not relitigating:**

- **Free-tier re-land deferred on purpose** — the known blocker is fixed, but a 7-resource
  replacement chain across Cosmos / IoT Hub routing / Cosmos RBAC deserves fresh attention. A
  correct plan is not an achievable plan; that is precisely what the failed attempt taught.
- **A human approval gate is NOT the long-term answer** for destructive applies (operator: "a
  human can't approve every deploy, that is a bottleneck"). MG-50 proposes git-tracked declarative
  authorization. For prod, the right control is `prevent_destroy` on data-bearing resources
  (MG-35), not a gate on every deploy. Note **prod does not exist** — no RG, empty `tfstate-prod`.
- **`estimated_monthly_cost` was DELETED, not fixed** — it was wrong by 100x AND computed from
  variables that governed nothing (no `autoscale_settings` exists anywhere in the module).
- **Static check 17 is lexical by necessity** — a Terraform-native test cannot express replacement:
  it is a state-diff property, plan-only runs start from empty state, `command = apply` is banned
  by check 15 (deliberately, to keep the PR gate credentialless), and `replace_triggered_by` never
  appears in `terraform show -json`.
- **Deleting V1's Function apps was safe** because the source is in GitHub; the ARM templates
  captured configuration, git holds the code. Verified before deleting, not assumed.
- **Azure did NOT delete anything during the disabled window** — the operator had removed
  `testhubmeatgeek` and the orphaned IP themselves. A disabled subscription stops resources, it
  does not destroy them.

**Shipped (for reference):**

- **MG-42 CLOSED** (audit `879efbb`, Acceptance Evidence grid in the ticket) — derived OIDC
  fed-cred subject prefix. AC4 proven live: all three creds reconciled, `azure/login` success in
  run 31132208038, no `AADSTS700213`. Open since 2026-07-27.
- **MG-48 V1 retirement COMPLETE** except the free-tier claim — `az resource list` returns zero
  MeatGeek resources. APIM, ACR, Event Hubs, the test-devices RG, V1 Cosmos and all five V1
  resource groups gone. **~$85-115/mo reclaimed from ~$182.**
- **MG-39 AC#2 only** (PR #34) — azurerm pinned `~> 4.0`, six tracked multi-platform locks,
  `-lockfile=readonly`, static check 16. **MG-39 REMAINS OPEN** for snyk@master SHA-pinning +
  `SNYK_TOKEN`, and prod-workflow `uses:` pinning.
- PR #35 — verified Cosmos export tool (read-only, count-reconciled, 50 tests).
- PR #37 (`29cebf2`) — IoT Hub route/endpoint replacement ordering fix + static check 17.
- PR #36 merged then REVERTED (`a2dab91`) — free-tier config, pending re-land.
- Filed: MG-43, MG-44, MG-45, MG-46, MG-47, MG-48, MG-49, MG-50.

**Lessons that cost real time (all cost >15 min this session):**

- **An empty query result means "absent OR you asked wrong."** A wrong-cased jmespath
  (`cosmosDBSqlContainers` vs `cosmosDbSqlContainers`) made a healthy endpoint look destroyed and
  produced an overstated outage report.
- **`${PIPESTATUS[0]}` is EMPTY in zsh** (it is `pipestatus`, 1-indexed) — it turned a PASSING
  verify into a refusal. Capture exit codes without a pipe.
- **A `grep` with an unquoted `--include=*.tf` silently does nothing in zsh** — a dependency check
  almost got skipped right before deleting five resource groups.
- **macOS `/bin/bash` is 3.2.57.** A `case` with quoted patterns inside `$( … )` aborts scripts
  there while CI bash 5 stays green, and `bash -n` cannot detect it. Run repo shell locally.
- **No dedicated worktree** — never switch branches or run two agents while one is live.

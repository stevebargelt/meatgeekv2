**Last session ended 2026-08-07.**

**Where we left off:** The free tier is CLAIMED — `mgv2-dev-f640e19ae7ab` has `enableFreeTier=true`
and that slot was expensive to get. But the re-land broke the dev Cosmos data path on the way in.
`free_tier_enabled` is create-only, so claiming it REPLACED `azurerm_cosmosdb_account.main`; Azure
destroyed the account's SQL database and all five containers with it, while Terraform — which had
never planned them for replacement — left state listing all six as existing. The apply then died
creating the IoT Hub Cosmos endpoint: `IH400142 "Database does not exist. DatabaseName:
meatgeek-v2-dev-db"` (run 31146292145, job 92766768140). Dev is partially broken: account fine,
database and containers are GHOSTS IN STATE, Cosmos routing endpoint and route absent.

**Picked up next:**

1. **MG-48 — repair the dev Cosmos data path. The code fix is in (this branch); what remains is
   ONE creates-only apply.** Read (a)-(c) below before running it — each is a way this repair
   silently turns into a no-op, into something worse than the current breakage, or into a
   half-authorized replacement.

   Short form: land the fix -> automatic apply on `main` -> **the plan must be CREATES-ONLY.** If
   it is, it applies with no gate at all and you are done: verify the database, 5 containers, the
   `cosmos-storage` endpoint + `cosmos-storage-route`, 2 Cosmos role assignments, both routes
   enabled (`cosmos-storage-route` AND the untouched `eventhub-realtime-route`), and
   the run's FINAL DRIFT PLAN green (that step is the real verdict). **If any delete or replace
   token appears, STOP and re-scope — do not authorize it.** A destroy authorization here is a
   destroy authorization over the free-tier account (see (b)); that is the one thing this repair
   exists to avoid.

   **(a) THE REPAIR IS REFRESH-DRIVEN. The code fix prevents recurrence; it repairs nothing.**
   What turns the six ghosts into creates is Terraform's REFRESH reading them back as absent from
   Azure. `infra-apply-dev.yml` does not pass `-refresh=false` today and the final drift plan
   relies on the same behaviour — **introducing `-refresh=false`, or reaching for a `-target`ed
   plan to "keep it small", silently reverts this repair to a no-op that fails again at IH400142.**
   If refresh does NOT produce creates for all six, the fallback is `terraform state rm` of the
   ghosts. **NOT `taint`, NOT `-replace`** — both emit delete tokens and trip the destroy guard,
   which is exactly the gate we are trying not to need.

   **(b) REPLACING THE FREE-TIER ACCOUNT IS NOW ALL-OR-NOTHING OVER A NON-REISSUABLE RESOURCE.**
   With the closure fixed, an account replacement takes the database and containers with it by
   plan as well as in fact — correct, and much more dangerous. Azure allows ONE free-tier account
   per subscription and the account name is deterministic, so if the slot or the name is not
   released synchronously on delete, the create half fails and dev is left with **no Cosmos account
   at all** — strictly worse than today's partial breakage. Second, independent argument for
   extending MG-35's `prevent_destroy` to the DEV account, not just prod.

   **(c) The token count is the size of the account's dependent closure — never a fixed number.**
   The old note here said "expect SEVEN tokens now, not five." That expectation is dead and was
   always the wrong shape: **the closure grows every time this class of bug is fixed correctly.**
   Today it is roughly thirteen (account, database, 5 containers, 2 Cosmos role assignments — both
   scoped by the account's computed id — both `terraform_data` handles, the Cosmos endpoint and the
   Cosmos route). Tomorrow it is more. **Read the set out of the failed run's own output; do not
   carry a number forward from these notes.** An operator who reads a larger set as a regression
   will either stop or authorize a truncated set, and a truncated set is how you get half a
   replacement.

2. **MG-47 — cost analysis.** The retirement is done, so the useful move now is measuring the NEXT
   cycle against ~$182 baseline and, more importantly, fixing the budget alerting that let the
   credit empty silently (budgets were configured at 50/150 with `admin_email` set, and nobody was
   told). MG-47 also gates MG-25 prod activation.
3. **MG-50 — the GitOps destroy-authorization gap.** Sizeable change to a safety-critical path;
   treat as `implementation_full`, not a quick fix. It is the direct cause of MG-38's condition.
   **It got bigger with the closure fix:** authorization is hand-transcribed exact addresses, and
   at ~13 of them it is past the point where a human transcribes it reliably. Per (c) the set only
   grows. A mistyped or dropped address in that list is not a typo, it is a partial replacement.
4. **Wire the Cosmos DATABASE NAME into the Function App — separate ticket, deliberately NOT in
   the MG-48 repair.** Terraform creates `${resource_prefix}-db` (= `meatgeek-v2-dev-db`), but
   `modules/functions/main.tf:259` passes only `COSMOSDB__accountEndpoint` — no database name. So
   `apps/api/src/environments/environment.development.ts:5` falls through to its default,
   `'meatgeek-dev'`, **a database that has never existed in any environment.** Consequence worth
   internalising: after the repair, a "dev is healthy" check via the IoT path (telemetry lands in
   Cosmos) can pass GREEN while the API path is still misconfigured — they do not share a code
   path. Kept out of the repair on purpose: an `app_settings` change is an UPDATE, not a create,
   and would break CREATES-ONLY. Do not smuggle it in.

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
  **Confirmed the hard way on 2026-08-07:** the chain was never 7, because the enumeration was
  built by listing resources instead of by asking which references carry replacement.
- **A reference to a parent's CONFIGURED `name` carries ordering ONLY; only a reference to a
  COMPUTED attribute (`.id`, `.endpoint`) carries replacement.** That one sentence is the whole
  bug class, and it has now broken dev twice — once at the route/endpoint layer (`29cebf2`), once
  at the account/database layer. Static check 18 is the guard, and it is DISCOVERY-DRIVEN rather
  than a Cosmos allowlist for exactly this reason: a type-keyed check would have passed green on
  the day it shipped while five IoT Hub pairs sat broken. **Do not "fix" it by narrowing it.**
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
- PR #36 merged then REVERTED (`a2dab91`) — free-tier config; re-landed 2026-08-07 (`071ec34`).
  The account carries `enableFreeTier=true` from that apply; the same apply orphaned its children.
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

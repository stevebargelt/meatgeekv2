**Last session ended 2026-08-07.**

**Where we left off:** **MG-48's free tier is CLAIMED and dev is FULLY REPAIRED.** Both landed and
verified live; nothing is outstanding on the infrastructure.

The re-land broke the dev Cosmos data path on the way in — `free_tier_enabled` is create-only, so
claiming it REPLACED the account, Azure destroyed the SQL database and all five containers with it,
and Terraform (which had never planned them for replacement) left state listing all six as
existing. The apply died creating the IoT Hub Cosmos endpoint with `IH400142 "Database does not
exist"`. **That was diagnosed, fixed and repaired the same session.** PR #38 (`99ce110`) fixed the
propagation class across both modules; PR #39 (`9a6fed9`) committed the mutation fixtures. The
repair apply (run 31158767820) came back **12 planned changes / 0 DESTRUCTIVE, 11 added / 0 changed
/ 0 destroyed, final drift plan CONVERGED** — creates-only, unattended, **no human gate**, because
refresh detected the six ghosts as absent and planned them as creates. Live-verified after:
`enableFreeTier: true`, `meatgeek-v2-dev-db`, all 5 containers, 2 Cosmos role assignments, both
routes enabled, `cosmos-storage` endpoint and the diagnostic setting. A subsequent main apply is a
clean 0/0/0 no-op.

**MG-48 REMAINS OPEN on ONE acceptance criterion, and it is time-gated, not work-gated:** post-change
spend measured against the next billing cycle and recorded on MG-47. Six of seven criteria are met
with evidence — the full walk is in the ticket's Acceptance walk grid. **Do not close it until the
bill shows the saving.** There is no engineering left to do on it.

**Picked up next:**

1. **MG-47 — cost analysis, which now also gates MG-48's closure.** Measure the next cycle against
   the ~$182 baseline, and fix the budget alerting that let the credit empty silently (budgets were
   configured at 50/150 with `admin_email` set, and nobody was told). Also gates MG-25 prod
   activation.

**Operational rules for the Cosmos account — these govern any FUTURE replacement, and every one of
them was learned by breaking dev.** They are no longer a to-do list; they are the manual.

   **(a) A REPAIR OF ORPHANED CHILDREN IS REFRESH-DRIVEN. Code fixes prevent recurrence; they
   repair nothing.**
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
   Count it by MECHANISM, never from memory. A resource is in the delete-or-replace set only if
   the account's replacement makes one of ITS OWN ForceNew arguments change, or if a
   `replace_triggered_by` reaches it. On this branch that is: the account; the SQL database; the
   five containers; BOTH `azurerm_cosmosdb_sql_role_assignment`s (root `main.tf` — `scope` and
   `role_definition_id` are built from the account's computed id);
   `module.iot_hub.terraform_data.cosmos_target_ready`, whose `triggers_replace` carries the
   database and container ids; the `cosmos-storage` endpoint and the `cosmos-storage-route`
   behind it; and — easy to miss, because it lives nowhere near the Cosmos module —
   `module.monitoring`'s Cosmos diagnostic setting and 429 metric alert, which both address the
   account by its computed id. Thirteen or fourteen, depending on how the provider classifies
   `azurerm_monitor_metric_alert.scopes`, which no one here has read out of a real plan.
   Tomorrow it is more. **Read the set out of the run's own output; do not carry a number forward
   from these notes.** An operator who reads a larger set as a regression will either stop or
   authorize a truncated set, and a truncated set is how you get half a replacement.

   **That closure is a REPLACEMENT closure, not an update closure — and only because of how the
   triggers are spelled.** Every `replace_triggered_by` entry on this branch names the parent's
   `.id` (`azurerm_cosmosdb_account.main.id`), never the bare address
   (`azurerm_cosmosdb_account.main`). A trigger fires when the referenced VALUE changes: an id is
   unknown at plan time when the parent is REPLACED, so it fires; it is byte-identical across an
   in-place edit, so it stays quiet. **A bare whole-resource trigger also fires on the parent's
   in-place UPDATE.** In the bare form, adding a tag to the account, changing its backup policy or
   its consistency level would destroy and recreate the database and all five containers — every
   stored document — and on the IoT Hub side a namespace tag or a throughput-unit scale would take
   the Event Hub, the endpoint and the route with it, while a hub tag or sku change would recreate
   both routes and both consumer groups the Functions triggers bind to. Routine edits becoming data
   loss and a routing gap is strictly worse than the orphaning this branch fixes. Operationally:
   **if a plan for an ordinary tag / sku / policy edit ever shows `-/+` on the containers, the
   routes or the consumer groups, do not authorize it** — a trigger has been rewritten to the bare
   form. Static check 18 rejects that form by name and inspects EVERY `replace_triggered_by` list
   in the tree, not only the ones on name-referenced children, so it should not be landable; a plan
   that shows it means the check was bypassed or narrowed.

   **`module.iot_hub.terraform_data.cosmos_role_ready` is NOT in that set** — an earlier draft of
   this note counted both handles, which is wrong. Its payload sits on `input`, which is not
   ForceNew: when the role-assignment id goes unknown that handle is UPDATED IN PLACE (`~`), so
   it never reaches the destroy guard. Only `cosmos_target_ready` is replaced, because its
   payload sits on `triggers_replace`. Two things follow. An update token transcribed into a
   destroy-authorization list is a transcription error (see 3). And if `cosmos_target_ready` ever
   shows as `~` instead of `-/+`, someone has moved its payload back onto `input`, which
   **silently breaks the propagation** — per the MEASURED note in `modules/iot-hub/main.tf`,
   `terraform_data` keeps its `id` byte-identical across an in-place update, and the endpoint
   triggers on that `.id`, so the endpoint would not be replaced at all. Do not authorize such a
   plan: static check 19 asserts both halves of that contract, so a `~` here means it was
   bypassed.

2. **MG-52 — migrate name-based parent references to id-based.** Filed 2026-08-07 off a deprecation
   warning in the repair apply: `namespace_name` is deprecated in favour of `namespace_id` and
   removed in azurerm v5. **This is not a deprecation chore — it RETIRES the bug class instead of
   guarding it.** A parent reached by its COMPUTED id propagates replacement natively, with no
   lifecycle block and nothing for a static check to police. Azure is deprecating exactly the form
   that causes the bug in favour of exactly the form that fixes it. Treat as `implementation_full`:
   it changes replacement semantics on the path that has already broken dev twice, and check 18's
   pair floor must shrink pair-by-pair with justification, never by casual re-baselining.
3. **MG-51 — wire the Cosmos DATABASE NAME into the Function App.** Terraform creates
   `${resource_prefix}-db` (= `meatgeek-v2-dev-db`) but `modules/functions/main.tf:259` passes only
   `COSMOSDB__accountEndpoint`, so `apps/api/src/environments/environment.development.ts:5` falls
   through to `'meatgeek-dev'` — **a database that has never existed in any environment.** Worth
   internalising: a "dev is healthy" check via the IoT path (telemetry landing in Cosmos) passes
   GREEN while the API path is still misconfigured — they do not share a code path. Kept out of the
   MG-48 repair on purpose: an `app_settings` change is an UPDATE, not a create, and would have
   broken CREATES-ONLY.
4. **MG-50 — the GitOps destroy-authorization gap.** Sizeable change to a safety-critical path;
   treat as `implementation_full`, not a quick fix. It is the direct cause of MG-38's condition.
   **It got bigger with the closure fix:** authorization is hand-transcribed exact addresses, and
   at a dozen-plus of them it is past the point where a human transcribes it reliably. Per (c) the
   set only grows, it now reaches into `module.monitoring`, and it sits next to look-alike tokens
   that must NOT be transcribed into it (`cosmos_role_ready` updates in place). A mistyped,
   dropped or wrongly-included address in that list is not a typo, it is a partial replacement.
   **Counter-evidence worth holding onto, though: the MG-48 repair itself needed NO authorization
   and NO gate**, because a creates-only plan never reaches the guard. The bottleneck is destructive
   changes specifically, not the loop — ordinary reconciliation already runs with nobody in it.

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
  the day it shipped while five IoT Hub pairs sat broken. It keys on the VALUE — any
  configured-name reference to a managed resource, including one interpolated inside a string —
  not on the argument's name. An earlier draft matched only `*_name = <type>.<label>.name` and
  was blind to `entity_path = azurerm_eventhub.temperature_data.name` and to
  `endpoint_uri = "sb://${azurerm_eventhub_namespace.main.name}..."`, which is the same defect on
  the Event Hub path. **Do not "fix" it by narrowing it.** Every exclusion it does make
  (`resource_group_name`; `module`/`output` blocks, which cannot carry a lifecycle block) is
  listed in the check's own header, because an undocumented exclusion is how the next enumeration
  gap gets created.
- **The second half of that rule: name the parent's `.id`, never the bare parent.** Both forms
  propagate replacement, so the difference is invisible in the plan the fix was written for — which
  is why `29cebf2` shipped the bare form and nobody noticed. The bare form ADDITIONALLY fires on
  the parent's in-place update (measured on a synthetic graph, not inferred), turning a tag edit
  into a recreate of every child; see (c) above for what that costs on each path. This branch
  rewrote all of them to `.id`, the pre-existing `29cebf2` entries included — fixing only the new
  ones would have left the hazard half-closed on the routes.
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
- PR #37 (`29cebf2`) — IoT Hub route/endpoint replacement ordering fix + static check 17. Its
  ordering fix WORKED on the re-land: destroys ran route -> endpoint -> account and IH400111 did not
  recur. It shipped the bare-address trigger form, corrected in PR #38.
- PR #36 merged then REVERTED (`a2dab91`) — free-tier config; re-landed 2026-08-07 (`071ec34`).
  The account carries `enableFreeTier=true` from that apply; the same apply orphaned its children.
- **PR #38 (`99ce110`) — the propagation fix.** Cosmos database + 5 containers, the Event Hub, the
  Event Hub endpoint, both routes and both consumer groups now replace with their parents; the IoT
  Hub Cosmos endpoint gained a cross-module dependency on the database via a `terraform_data`
  handle (`replace_triggered_by` is module-local, so the module input contract carries identity,
  not just names); every trigger in the `.id` form; static checks 18 and 19.
- **PR #39 (`9a6fed9`) — 8 committed mutation fixtures for checks 18/19**, wired into the
  credentialless CI job, passing under bash 5.3.15 AND macOS `/bin/bash` 3.2.57. Closes the gap
  where both guards were hand-verified once by a transcript nobody could re-execute.
- Filed: MG-43, MG-44, MG-45, MG-46, MG-47, MG-48, MG-49, MG-50, MG-51, MG-52.

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
- **A reviewer's severity is an input, not a verdict — and so is your own recollection.** Two calls
  went the other way this session. A red graded the `input`-vs-`triggers_replace` handle a LOW
  comment inaccuracy; the orchestrator re-graded it HIGH on the reasoning that a whole-resource
  trigger fires only on replacement. The engineer then MEASURED it on a synthetic graph — it fires
  on in-place update too — so the red's original grading was right. Conversely, a red graded the
  bare-vs-`.id` trigger form a HIGH, and it was: the bare form would have made a routine tag edit
  destroy every document. Measure before overriding, and when an agent pushes back with evidence,
  that is the system working.
- **Don't batch findings that share files into a fanout step.** A four-finding batch where three
  touched `tf-static-checks.sh` and two touched `notes.md` was split into parallel work items that
  conflicted on merge; the run failed `integration_blocked` and published nothing. Same-file work
  goes to ONE sequential agent pass.
- **Backticks inside a double-quoted Bash argument are live command substitution.** A `--rationale`
  lost the word `input` twice from the highest-severity finding's diagnosis; the only symptom was a
  quiet `command not found: input`, and the mangled text was already persisted. Use single quotes
  for code identifiers in Bash-passed prose, or none.
- **`gh run list --commit <sha>` returned `[]` for a commit whose runs existed** (they carry that
  `headSha`, and `--branch main` finds them). A Monitor armed on that filter stayed silent through a
  complete CI-plus-apply cycle. Same lesson as the jmespath one, in a new place: verify a wait
  condition returns data BEFORE arming anything on it.

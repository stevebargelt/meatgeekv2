**Last session ended 2026-08-07.**

**Where we left off:** MG-48's free tier is CLAIMED and dev is FULLY REPAIRED — nothing is
outstanding on the infrastructure. Claiming the free tier replaced the Cosmos account (the flag is
create-only), which orphaned its SQL database and five containers in state and killed the apply at
`IH400142 "Database does not exist"`. That was diagnosed, fixed and repaired the same session: PR
#38 (`99ce110`) fixed the propagation class across both modules, PR #39 (`9a6fed9`) committed the
mutation fixtures, and the repair apply (run 31158767820) came back **12 planned / 0 DESTRUCTIVE,
11 added / 0 changed / 0 destroyed, final drift plan CONVERGED** — creates-only, unattended, **no
human gate**. Three subsequent main applies converge at 0/0/0. Live-verified after:
`enableFreeTier: true`, `meatgeek-v2-dev-db`, all 5 containers, 2 Cosmos role assignments, both
routes enabled, `cosmos-storage` endpoint and the diagnostic setting.

**Picked up next:**

1. **MG-47 — cost analysis. This also gates MG-48's closure.** MG-48 is open on exactly ONE
   acceptance criterion: post-change spend measured against the next billing cycle and recorded
   here. Six of seven criteria are met with evidence (walk grid is in the MG-48 body). **There is no
   engineering left on MG-48 — do not close it until the bill shows the saving, and do not reopen
   the infrastructure work looking for something to do.** The other half of MG-47 is real work now:
   fix the budget alerting that let the credit empty silently (budgets were configured at 50/150
   with `admin_email` set and nobody was told). Also gates MG-25 prod activation.
2. **MG-52 — migrate name-based parent references to id-based.** Filed off a deprecation warning in
   the repair apply: `namespace_name` is deprecated for `namespace_id`, removed in azurerm v5. **Not
   a deprecation chore — it RETIRES the bug class instead of guarding it.** A parent reached by its
   COMPUTED id propagates replacement natively, with no lifecycle block and nothing for a static
   check to police. Treat as `implementation_full`: it changes replacement semantics on the path
   that has broken dev twice, and check 18's pair floor (currently 20) must shrink pair-by-pair with
   justification, never by casual re-baselining.
3. **MG-50 — the GitOps destroy-authorization gap.** `implementation_full`. It got bigger this
   session: the authorization set now reaches into `module.monitoring`, sits beside look-alike
   tokens that must NOT be transcribed into it, and only grows as this bug class is fixed correctly.
   **But scope the complaint correctly — the MG-48 repair needed no authorization and no gate at
   all**, because a creates-only plan never reaches the guard. The bottleneck is destructive changes
   specifically, not the reconciliation loop.
4. **Non-ticket thread: duplicate `~/meatgeek-v1-archive/` (84 MB) off the Mac.** It is the ONLY
   copy of several V1 artifacts and it currently lives on one machine.

**External state to remember:**

- **`~/meatgeek-v1-archive/` (84 MB) is OFF-REPO and single-copy**: the APIM backup blob
  (sha256-verified, restores only INTO an APIM instance), OpenAPI for both V1 APIs, ARM templates
  for all six V1 resource groups, the 73 MB arm64 telemetry image + reconstructed Dockerfile, Event
  Hubs topology, and 9,886 Cosmos documents (triple-verified).
- V1 source survives in GitHub: `meatgeek-azure-sessions`, `MeatGeek-IoT`, `meatgeek-azure-proxies`,
  `MeatGeek-Shared` (archived), `MeatGeek-IoTEdge`.
- `meatgeek-archive-rg` was created by hand (deliberately NOT terraform-managed) as a write target
  for the APIM backup. Safe to delete once the archive is duplicated off-Azure.
- Soft-deleted Key Vault `meatgeekkv` auto-purges **2026-11-04**. Free, no action.
- `az account show` reads a CACHED profile — it reported `Enabled` for a DISABLED subscription.
  Always `az account list --refresh`.

**Decisions worth not relitigating:**

- **The whole bug class, in one sentence: a reference to a parent's CONFIGURED `name` carries
  ordering ONLY; only a reference to a COMPUTED attribute carries replacement.** It has now broken
  dev twice, at the route/endpoint layer (`29cebf2`) and the account/database layer (`99ce110`).
- **Second half of that rule: name the parent's `.id`, never the bare parent.** Both propagate
  replacement, so the difference is invisible in the plan the fix is written for — which is why
  `29cebf2` shipped the bare form and nobody noticed. The bare form ALSO fires on the parent's
  in-place UPDATE (measured on a synthetic graph, not inferred), so a routine tag edit would have
  destroyed the database and all five containers. All entries are now `.id`, pre-existing ones
  included. **If a plan for an ordinary tag/sku/policy edit ever shows `-/+` on containers, routes
  or consumer groups, do not authorize it** — a trigger was rewritten to the bare form.
- **Check 18 is discovery-driven and keys on the VALUE, not the argument name** — an earlier draft
  matched only `*_name = <type>.<label>.name` and was blind to `entity_path` and to an interpolated
  `endpoint_uri`. **Do not "fix" it by narrowing it.** Its exclusions are documented in its own
  header because an undocumented exclusion is how the next enumeration gap gets created.
- **Repairing orphaned children is REFRESH-DRIVEN.** Code fixes prevent recurrence; they repair
  nothing. Introducing `-refresh=false` or a `-target`ed plan silently reverts such a repair to a
  no-op. If refresh does not produce the creates, the fallback is `terraform state rm` — **NOT
  `taint`, NOT `-replace`**, which emit delete tokens and trip the guard.
- **Replacing the free-tier account is now ALL-OR-NOTHING over a non-reissuable resource.** One
  free-tier account per subscription and a deterministic name: if the slot is not released
  synchronously on delete, the create half fails and dev is left with no Cosmos account at all.
  Independent argument for extending MG-35's `prevent_destroy` to the DEV account.
- **Token counts are the size of the dependent closure — never a fixed number.** "Expect SEVEN" was
  wrong (it was six); the closure grows every time this class is fixed correctly. Read the set out
  of the run's own output. `cosmos_role_ready` is NOT in it (its payload is on `input`, updated in
  place); `cosmos_target_ready` IS (payload on `triggers_replace`).
- **MG-51 was deliberately kept OUT of the repair** — an `app_settings` change is an UPDATE, not a
  create, and would have broken CREATES-ONLY.

**Shipped (for reference):**

- **PR #38 (`99ce110`)** — replacement propagation for the Cosmos account's dependents: database + 5
  containers, the Event Hub, the Event Hub endpoint, both routes, both consumer groups; the IoT Hub
  Cosmos endpoint gained a cross-module dependency via a `terraform_data` handle (`replace_triggered_by`
  is module-local, so the module input contract carries identity, not just names); static checks 18
  and 19.
- **PR #39 (`9a6fed9`)** — 8 committed mutation fixtures for checks 18/19, wired into the
  credentialless CI job, passing under bash 5.3.15 AND macOS `/bin/bash` 3.2.57. Closes the gap
  where both guards were hand-verified once by a transcript nobody could re-execute.
- Free-tier config re-landed (`071ec34`), reverting the earlier `a2dab91`.
- Filed this session: **MG-51** (Function App never receives the database name — a dev health check
  via the IoT path passes GREEN while the API path is misconfigured; they share no code path) and
  **MG-52** (name→id migration).

**Lessons that cost real time:**

- **A reviewer's severity is an input, not a verdict — and so is your own recollection.** A red
  graded the `input`-vs-`triggers_replace` handle LOW; the orchestrator re-graded it HIGH from
  memory of Terraform semantics; the engineer MEASURED it and the red was right. In the same run a
  different red's HIGH was correct and load-bearing. Measure before overriding.
- **Don't batch findings that share files into a fanout step.** Four findings where three touched
  `tf-static-checks.sh` conflicted on merge; the run failed `integration_blocked` and published
  nothing. Same-file work goes to ONE sequential agent pass.
- **Backticks inside a double-quoted Bash argument are live command substitution** — a `--rationale`
  silently lost a word from its highest-severity finding. Single-quote code identifiers, or omit.
- **`gh run list --commit <sha>` returned `[]` for a commit whose runs existed** (`--branch main`
  finds them). A Monitor armed on that filter stayed silent through a full CI+apply cycle. Prove a
  wait condition returns data BEFORE arming anything on it.
- **`forge-stable` cannot dispatch ticketed work here** — it validates `--ticket` against the FILE
  backlog, which is a stale mirror stopping around MG-36. Use bare `forge`.
- macOS `/bin/bash` is 3.2.57; a `case` inside `$( )` aborts there while CI bash 5 stays green.
- An unquoted `--include=*.tf` in `grep` silently does nothing in zsh — hit again this session.
- **No dedicated worktree** — never switch branches or run two agents while one is live.

**Last session ended 2026-08-09.**

**Where we left off:** MG-51 shipped end-to-end and is CLOSED with a full acceptance-evidence grid.
The operator settled the two parked review findings as `accepted_risk --operator` (wording made the
distinction explicit: what is accepted is the ASSURANCE GAP, not the original disclosure), PR #40
squash-merged to `dc0941f`, post-merge main CI green, dev applied through the normal GitOps path, and
the exact merged SHA deployed and exercised live. The live proof PASSED, which means the gate on
MG-53 is lifted. Nothing is mid-flight; the session ended at a clean stopping point.

**Picked up next:**

1. **MG-58 before MG-53 — recommended ordering, not yet decided.** MG-58 (filed this session) is a
   PRE-EXISTING dev defect found during the MG-51 live proof: the dev Function host cannot
   authenticate to `AzureWebJobsStorage` (`AuthenticationFailed`), logged every ~30s, and it also
   produces the "app appears to be unhealthy" warning at the end of every `func ... publish`. HTTP
   triggers are unaffected, which is exactly why it went unnoticed. MG-24 predicted this hazard
   verbatim ("Storage: `shared_access_key_enabled = false` ONLY IF the Function host storage is fully
   managed-identity; VERIFY first, else keep keys as a documented exception (do NOT break
   Functions)") and the conditional looks unresolved. The argument for doing it first: MG-53 is a
   container migration + cutover, and running it while the host storage-plane identity is broken
   makes any failure ambiguous between the two causes. The operator has NOT ruled on this ordering.

2. **MG-53 is UNBLOCKED** (migration + cutover only). Its gate — the live API-path proof — passed on
   2026-08-09. Route as `implementation_full`. MG-54 (deletion + the 1000 RU/s free-tier ceiling)
   remains a SEPARATE second authorization point and must not be folded in.

3. **A NON-TICKET thread awaiting an operator call: the API serves stub data, not Cosmos.**
   `GET /api/cooks` returns hardcoded fixtures (`cook-1`, "Weekend Brisket", literal 2025 dates) and
   touches no database. No pre-MG-51 endpoint touched Cosmos at all — which is precisely why MG-51's
   own `/health/cosmos` endpoint was the ONLY available proof path. So the API surface has never been
   wired to the database in dev. This is deliberately UNFILED: it is much larger scope than MG-51 and
   the operator was asked whether to file it and had not answered when the session ended. Do not
   fold it into MG-53.

4. **MG-47's alerting half is still untouched and is the ticket's more important failure.** Four
   defects are diagnosed and recorded on the ticket, ready to implement. Unchanged from last session.

5. **MG-57** (no per-test identity in Jest output) is what forced the accepted_risk exit on MG-51.
   Until it is fixed, every review in this repo hits the same wall — no finding can be resolved on
   regression-test evidence. **MG-55** (same fail-loud treatment for `environment.production.ts` /
   `environment.ts`, which still default to the nonexistent V1 name `meatgeek`) is the direct
   MG-51 sibling and is small.

**External state to remember:**

- **Live dev deployment is now the MG-51 build at `dc0941f`**, published manually as the OPERATOR
  identity to `meatgeek-v2-dev-func-259d4bf5b628`. It is NOT reproducible from CI — MG-36 (automated
  dev app deploy) is still open. Seven functions are registered, including the new `cosmosHealth`.
- **The MG-21 manual deploy recipe, re-proven this session:** `npx nx build api` →
  `npm install --omit=dev --ignore-scripts` inside `dist/apps/api` →
  `func azure functionapp publish <fa> --javascript --no-build`. The bare `nx deploy api` target does
  NOT work on Flex. Both `--javascript` and the self-contained package are required.
- **Working log path for dev Functions is Log Analytics, NOT App Insights.** App Insights returns
  zero rows (that is MG-37). `FunctionAppLogs` flows to workspace `meatgeek-v2-dev-logs`
  (guid `6632bb13-0766-4250-9423-622e00be3482`) via diagnostic setting
  `meatgeek-v2-dev-functions-diag`. Query with `az monitor log-analytics query -w <guid>`. Ingestion
  lag is roughly 3-5 minutes — do not conclude "no logs" from an immediate query.
- **Authenticated dev API smoke test:** audience is `api://348570b2-44e5-41a6-ad15-2a7032366130`;
  `az account get-access-token --resource <that>` works because the Azure CLI client id is in
  `allowed_client_applications`. Unauthenticated calls correctly return 401.
- **`az functionapp show --query` returns nulls here** — this CLI version wraps the payload under
  `properties`, so top-level `--query defaultHostName` silently yields null. Pipe to `jq` instead.
  This wasted time; do not re-diagnose it.
- **Watch your shell cwd when calling `forge backlog`.** `cd`-ing into a subdirectory
  (e.g. `apps/infrastructure`) makes the CLI resolve the WRONG project — prefix comes back `(none)`,
  allocation tries `FG`, and filing fails with a misleading "no id sequence seeded" error suggesting
  `forge backlog import`. **Do NOT run that import** — the DB is authoritative and `backlog/*.md` is
  stale. Just pass `--project /Users/stevebargelt/code/meatgeekv2`.
- **`~/meatgeek-v1-archive/` (84 MB) is still OFF-REPO and SINGLE-COPY on one Mac.** Unchanged; still
  the only copy of several V1 artifacts.
- **VSE02 measured spend, cycle 2026-07-06 → 08-05: $205.47 total.** V1 79.76 (39%) ·
  Constellation 61.83 (30%) · V2 61.79 (30%) · forge-ntfy 2.08. Constellation is as large as all of
  V2 and is outside this project's control.
- `az consumption usage list` is UNUSABLE here (returns `pretaxCost: "None"`, null `meterDetails`,
  ignores the date range). Use the Cost Management query API
  (`POST .../Microsoft.CostManagement/query?api-version=2023-03-01`). It rate-limits hard with
  HTTP 429 — space retries, do not loop.
- `az account show` still reads a CACHED profile. Always `az account list --refresh`.
- Soft-deleted Key Vault `meatgeekkv` auto-purges **2026-11-04**. Free, no action.
- Terraform init needs the derived state-account name:
  `-backend-config="storage_account_name=$(bash scripts/state-account-name.sh "$SUB")"` alongside
  `-backend-config=environments/backend-dev.hcl`. Confirmed working this session; the account is
  `meatgeekv2tfc49dbf8ad608`, `SUB=c7e800cb-0ee6-4175-9605-a6b97c6f419f`.

**Decisions worth not relitigating:**

- **RF-1/RF-2 settled as `accepted_risk --operator`, not `rejected_premise` and not a fresh review.**
  `rejected_premise` was rejected because the premise was TRUE when discovered and the reds were
  right — recording it rejected would falsify history. A fresh review at `e12b3a5` was rejected as
  expensive and likely to hit the identical MG-57 wall. Do not reopen the ledger; the live proof was
  recorded on the ticket as CONFIRMATION, explicitly not as an overturn.
- **The MG-51 fallback was removed, not corrected.** Failing loudly at module load beat matching the
  Terraform value, because a fallback that is right today silently becomes wrong the moment MG-53
  moves the database name. Rationale is recorded in the source file header.
- **MG-55 was deliberately kept out of MG-51's scope** — the production/default environment files get
  the same treatment under their own ticket.
- **MG-36 is NOT a prerequisite for anything here** — it automates a path MG-21 already proved
  manually, and that manual path was re-proven this session.

**Shipped (for reference):**

- **MG-51** — dev Functions now receives the Terraform-owned Cosmos database name; app-side fallback
  removed in favour of failing loudly; new `/api/health/cosmos` endpoint exercises the API path to
  Cosmos. Merged `dc0941f` (PR #40), closed with an acceptance-evidence grid.
- **MG-58** — FILED (not fixed): dev Function host cannot authenticate to `AzureWebJobsStorage`.
- **FG-696** — FILED against the **forge** repo (not this one): the review ledger has no disposition
  for "remediated, humanly verified, but ledger evidence unavailable and the cycle is exhausted."
  `accepted_risk` is the least-false legal exit today and should not remain the permanent vocabulary.

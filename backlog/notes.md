**Session 2026-08-06. MG-42 CLOSED. MeatGeek V1 FULLY RETIRED. ~$85-115/mo reclaimed. One self-inflicted dev outage, reverted and root-caused.**

## Next action: re-land the Cosmos free tier (~$24/mo)

Everything blocking it is fixed and merged. **Full step-by-step procedure is in MG-48** — read it
before starting; it names the exact verification commands and the failure protocol.

Short version: `git revert a2dab91` -> push -> the automatic apply refuses at the destroy guard
(expected, see MG-50) -> read the token set it prints (**expect SEVEN now, not five** — both IoT
Hub routes joined the chain via the ordering fix, which is the fix working) -> `workflow_dispatch`
`Apply Dev Infrastructure` with that exact set -> approve the recovery gate -> verify
`enableFreeTier=true`, 5 containers, 2 role assignments, both routes, and the run's FINAL DRIFT
PLAN green.

**If it stalls partway: revert FIRST (restores dev), diagnose second.** That is what worked today.

## Shipped today

- **MG-42 CLOSED** (audit `879efbb`) with a full Acceptance Evidence grid. AC4 proven live: the
  bootstrap re-run reconciled all three fed creds onto the derived prefix (`appdeploy-dev` and
  `oidc-prod` REPAIRED, `infra-apply-dev` untouched — 3 matched, 0 wrong), and GitHub Actions run
  **31132208038** shows `Azure login (OIDC — dev infra-apply identity) = success`, no
  `AADSTS700213`. Open since 2026-07-27.
- **MG-48 V1 retirement COMPLETE.** `az resource list` returns zero MeatGeek/Meatgeek resources.
  Deleted: APIM (~$34.61), Event Hubs `meetgeek` (~$11), ACR (~$5), RG `MeatGeek-IoT-Test-Devices`
  (~$10-20, incl. a Premium_LRS disk that billed in full while the VM was deallocated), V1 Cosmos,
  and all five V1 resource groups. Operator had removed `testhubmeatgeek` (~$25) earlier.
- **PR #37 (`29cebf2`)** — IoT Hub route/endpoint replacement ordering fix + static check 17.

## Archive — ~/meatgeek-v1-archive/ (84 MB, README reconstructs V1's architecture)

APIM backup blob (sha256 verified) + OpenAPI for both APIs; ARM templates for all six RGs; the
full 73 MB arm64 telemetry image (.NET 6 IoT Edge module) + reconstructed Dockerfile; Event Hubs
topology; and **9,886 Cosmos documents (42 sessions / 9,843 statuses / 1 cook), triple-verified**.
V1 source also lives on in GitHub: `meatgeek-azure-sessions`, `MeatGeek-IoT`,
`meatgeek-azure-proxies`, `MeatGeek-Shared` (archived), `MeatGeek-IoTEdge`.

## Filed today

**MG-49** cosmos-export `--auth aad` documented but `@azure/identity` absent (V2 dev has
`disableLocalAuth=true`, so a key-only tool cannot export V2).
**MG-50** GitOps gap — destroy authorization is a `workflow_dispatch`-only input, so ANY
destructive change drops the loop into manual mode. Operator: "a human can't approve every deploy,
that is a bottleneck." Proposed fix: git-tracked declarative token file. This is also the direct
cause of MG-38's condition.

## Lessons that cost real time today

- **An empty query result means "absent OR you asked wrong."** A wrong-cased jmespath
  (`cosmosDBSqlContainers` vs `cosmosDbSqlContainers`) made a healthy endpoint look destroyed and
  produced an overstated damage report. Distinguish before concluding.
- **`${PIPESTATUS[0]}` is EMPTY in zsh** (it is `pipestatus`, 1-indexed). It silently turned a
  PASSING verify into a refusal. Capture exit codes without a pipe, or use bash explicitly.
- **A correct plan is not an achievable plan.** The destroy set was reviewed for legitimacy — the
  right check — but not for whether Azure would permit the ordering. Different question.
- **A grep with an unquoted `--include=*.tf` silently does nothing in zsh** (glob expansion errors
  the command). A dependency check almost got skipped before deleting five resource groups.
- **macOS `/bin/bash` is 3.2.57.** A `case` with quoted patterns inside `$( … )` aborts scripts
  there while CI bash 5 stays green, and `bash -n` cannot detect it. Run repo shell locally.
- **No dedicated worktree** — never switch branches or run two agents while one is live.

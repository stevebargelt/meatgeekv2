**Last session ended 2026-08-20.**

**Where we left off:** MG-54 (cosmos dev cleanup) SHIPPED and CLOSED (merge 8eaf060). The five source
containers + source database were destroyed and the account 1000 RU/s free-tier ceiling applied, via
an operator-authorized TWO-PHASE HOST APPLY (phase 1: targeted destroy of the six source addresses ->
400 RU/s; phase 2: account in-place update -> 1000 ceiling). Provisioned throughput 2400 -> 400 RU/s;
enableFreeTier=true; dev Cosmos is now inside the free-tier allowance (0 billable). Post-cleanup MG-67
send proved the write path intact (3/3 into the destination). The 10 synthetic docs were disposed with
the source; the MG-67 fixture device survives. Temp Cosmos grant revoked, baseline restored (2/0).

**Picked up next:**

1. **MG-77 (HIGH) — the api-interfaces required check is RED repo-wide** and now intermittently
   fail-fast-CANCELS sibling required checks (lint-and-test (api)). run-flex-secret-gate-fixtures
   mktemp-stub portability broke on the current GitHub runner (MG-40/MG-44 class). It blocks every PR
   merge (both MG-62 and MG-54 were override-merged past it) and is escalating from one-check-to-
   override toward blocking the whole matrix. Fix this before the next merge that cannot be overridden.
2. **MG-76 — infra fixture-harness provability.** The review lane cannot run tf-static-checks or the
   fixture runners, so MG-54's deletion silently broke TWO source-coupled harnesses that only CI
   caught: the check-18 name-pair floor (31->20) and run-cross-module-propagation-fixtures.sh (it
   mutated the deleted source db). Both fixed via engineer + CI-verified, but the evidence-led review
   settled GREEN on a diff that then failed CI. Deletion/rename tickets especially need these harnesses.
3. **MG-47 billing measurement (pending, time-gated)** — take the post-cleanup dollar billing-window
   measurement after a full post-2026-08-20 billing cycle; it is MG-54 AC 9, recorded on MG-47, and
   unblocks MG-48 AC6 + MG-25. RU/s evidence already establishes the expected result (inside free tier).

**Operational lessons this session:**

- **Destructive Cosmos two-phase apply.** The account total_throughput_limit ceiling is rejected while
  over-provisioned, and a single terraform apply cannot order the account update after the child
  destroys (no graph edge). The RECOVERY workflow cannot do a targeted apply. So: phase 1 = host
  targeted apply of the exact destroy set (terraform plan -target ... -out, tf-plan-destroy-guard on
  it, then apply), confirm the account settles to the new floor; phase 2 = host apply of the account
  in-place update. Guard-gated each phase; a safety check refuses phase 2 if any destroy token appears.
- **The MG-76 lane gap bites deletion tickets hardest** — a diff can settle a green evidence-led review
  yet fail CI on multiple source-coupled infra harnesses. After a deletion diff, proactively run ALL
  cosmos fixture harnesses locally to find every break in one pass, then fix in one engineer batch.
- **Live-read pattern reaffirmed:** temporary Cosmos Data Reader grant (create -> read/send -> revoke
  -> verify baseline 2/0) each time; @azure/cosmos + DefaultAzureCredential via dist/esm/index.js works
  for source enumeration; the health proof needs the Entra bearer (api://348570b2.../access_as_user).

**Shipped (for reference):**
- MG-62 (merge a544fd3) — cutover to the shared-throughput destination (all four live proofs).
- MG-54 (merge 8eaf060) — source deletion + 1000 RU/s ceiling; nine-row acceptance-evidence grid
  (8/9 met, AC 9 billing pending on MG-47). MG-77 filed (repo-wide red required check).

---
id: MG-38
type: story
status: active
title: "dev GitOps reconciliation-drift alert: green-CI main SHA left unreconciled"
created: 2026-07-26
---

## Problem

MG-23's automated dev infra-apply loop uses `workflow_run` on the CI pipeline. A superseded automatic apply run skips cleanly (per MG-23 design — it must never apply stale trunk). But this leaves a silent-stall gap: if the SUPERSEDING commit's CI does NOT conclude `success`, neither commit is ever applied, every job in the repo is green, and the GitOps reconciliation loop stops with **no red signal and no catch-up trigger**. Surfaced by red-backend during the MG-23 build (medium).

## Target definition (refined)

The reconciliation target is **the latest main SHA that has SUCCESSFUL required CI** — NOT blindly the current main HEAD. Distinguish two states:

1. **main is intentionally blocked** because its current CI is red → NOT a reconciliation miss (the system is correctly withholding a bad apply).
2. **a green-CI main SHA was never reconciled** (the last successful-CI commit on main is ahead of the last-applied SHA) → THIS is the missed-reconciliation condition and the thing to alert on.

## Acceptance criteria

- A scheduled/periodic check computes: last-applied dev SHA vs the latest main SHA with successful required CI.
- When (2) holds — a green-CI main SHA is ahead of the last-applied SHA — it emits an alert (and/or auto-triggers a catch-up apply through the same gated sequence).
- When (1) holds — main HEAD's CI is red but the last GREEN-CI SHA is already applied — it does NOT alert (no false positive on an intentionally-blocked main).
- Wired into the same dev backend/state and identity model as MG-23; no new privileged surface beyond what MG-23 establishes.

## Context

Follow-up to MG-23 (automated dev infra GitOps reconciliation). Fail-safe gap (silent non-convergence, not a wrong-ship or data-loss), deferred from MG-23 per operator disposition. Depends on MG-23 landing + activation.
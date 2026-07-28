---
id: MG-41
type: story
status: active
title: "fix stale MG-23 safety documentation describing the removed PR-plan workflow"
created: 2026-07-27
---

## Problem

The MG-23 safety explanation in `apps/infrastructure/environments/dev.tfvars`
describes a workflow that no longer exists:

- It says a merge can opt into destruction using an exact expected destroy
  count. Normal automatic reconciliation cannot authorize any destructive
  change; destruction is available only through the reviewer-approved recovery
  dispatch using an exact set of action-qualified change tokens.
- It says the Terraform plan reviewed on the pull request is the plan that is
  applied. Pull requests now run credentialless, backendless validation and do
  not produce a live Terraform plan. The authoritative saved plan is generated
  after merge by the apply workflow.

The executable controls are correct, but the stale explanation can give an
operator the wrong mental model during a destructive change such as a region
cutover. Related wording about PR/human plan review also remains in
`apps/infrastructure/scripts/tf-plan-secret-inspection.sh` and
`libs/api-interfaces/src/lib/infra-apply-dev.spec.ts`.

## Acceptance criteria

- `apps/infrastructure/environments/dev.tfvars` accurately states that the
  automatic path fails closed on every destructive change and cannot carry a
  destroy authorization.
- The documentation identifies the protected recovery dispatch as the only
  path for destruction and describes its exact action-qualified token-set
  authorization.
- The documentation accurately describes pull-request infrastructure checks as
  credentialless/backendless validation, not a live Terraform plan.
- Known stale PR-plan or human-plan-review descriptions in the MG-23 comments
  and regression-test documentation are updated consistently.
- This is a documentation/test-description correction only; the shipped
  workflow behavior and security controls do not change.

## Context

Follow-up from the post-merge correctness review of MG-23 (`aa13f0f`, PR #27).
Severity: medium because the implementation fails closed, but misleading safety
documentation can cause an operator to choose the wrong recovery procedure.

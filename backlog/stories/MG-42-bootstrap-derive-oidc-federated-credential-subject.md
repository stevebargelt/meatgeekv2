---
id: MG-42
type: story
status: active
title: "bootstrap: derive OIDC federated-credential subject from the repo's actual sub_claim_prefix (this repo injects owner/repo immutable IDs)"
created: 2026-07-27
---

## Problem (activation blocker, found running MG-23 activation 2026-07-27)

`bootstrap.sh` hardcodes federated-credential subjects as `repo:${GITHUB_REPO}:environment:<env>` / `:ref:<ref>` (standard GitHub OIDC subject). But **stevebargelt/meatgeekv2 has a custom OIDC subject prefix** — `gh api repos/stevebargelt/meatgeekv2/actions/oidc/customization/sub` returns `sub_claim_prefix = repo:stevebargelt@4857343/meatgeekv2@1304558512` (owner-id + repo-id injected; almost certainly a target.com enterprise policy since the account is a work account).

Proven empirically during MG-23 activation: a workflow job (ref AND environment scoped) presents `sub = repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:<env>`. bootstrap's standard-prefix credential does NOT match -> `AADSTS700213: No matching federated identity record` at azure/login. This affects ALL three OIDC identities bootstrap manages: infra-apply (development-infra-apply), app-deploy (development, MG-36), and prod plan/read (production, MG-25).

## Interim state (do not lose)

The `development-infra-apply` credential was MANUALLY corrected to the custom-prefix subject during activation so the MG-23 first apply can authenticate. **Until this ticket lands, re-running bootstrap.sh REVERTS that credential to the broken standard-prefix subject** (ensure_federated_credential reconciles the subject). The `development` and `production` credentials are still on the broken standard prefix (not needed for MG-23; will break MG-36/MG-25 until fixed).

## Acceptance criteria

- bootstrap.sh derives the subject PREFIX from the repo's live OIDC customization (`gh api repos/${GITHUB_REPO}/actions/oidc/customization/sub` -> `.sub_claim_prefix`), falling back to `repo:${GITHUB_REPO}` when the repo uses the default (no custom prefix). All federated-credential subjects (env + ref) use the derived prefix.
- ensure_federated_credential reconciles to the DERIVED subject (so a re-run no longer reverts the manual fix).
- oidc-subject-consistency.spec.ts and bootstrap.test.sh updated: they currently assert the hardcoded `repo:stevebargelt/meatgeekv2:...` format; assert the derived-prefix behavior instead (and that a custom prefix is honored).
- Re-run bootstrap and confirm all three identities' credentials match the presented subjects (an environment-scoped azure/login succeeds).
- Add this as a blocking pre-activation check in mg23-live-acceptance.md (an OIDC-subject-match check the runbook currently lacks).

## Context

Found during MG-23 operator activation. The whole MG-23/MG-24 design assumed standard OIDC subjects; this repo's enterprise policy breaks that assumption. Independent of MG-23's code (already merged); MG-23 activation proceeds on the manual credential fix.
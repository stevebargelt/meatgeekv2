---
id: MG-40
type: story
status: active
title: "test portability: secret-gate mktemp-failure fixture case is a no-op on macOS (Darwin mktemp ignores unwritable TMPDIR)"
created: 2026-07-27
---

## Problem (non-critical, split from MG-23 completion)

The secret-gate fixture harness `apps/infrastructure/scripts/fixtures/run-flex-secret-gate-fixtures.sh` includes an `[env] unwritable TMPDIR` case that forces `mktemp` to fail (to prove the gate fails CLOSED on temp-file failure — an MG-23 blocker-1 control). It expects a nonzero exit naming the temp-file failure.

On **Linux/CI this fires correctly** (unwritable `TMPDIR` => mktemp fails => gate fail-closed => nonzero => pass). On **macOS (Darwin) mktemp ignores the unwritable `TMPDIR` and falls back to `/var/folders`**, so mktemp SUCCEEDS, the gate correctly accepts a valid plan (exit 0), and the test's trigger never fires — reporting `expected nonzero, got 0`. This also reddens `libs/api-interfaces/src/lib/infra-security-posture.spec.ts:1011`, which drives the runner.

The GATE itself is correct (the `|| die` guard on mktemp is intact and verified); only the TEST's method of forcing a mktemp failure is non-portable to Darwin. Steve develops on macOS, so `nx test api-interfaces` is red locally today (green in CI).

## Acceptance criteria

- The mktemp-failure secret-gate case forces the failure portably on BOTH Linux and macOS (e.g. a stub `mktemp` on PATH that exits nonzero, rather than relying on an unwritable `TMPDIR`), OR is cleanly skipped on Darwin with a stated reason — no false red on macOS.
- `run-flex-secret-gate-fixtures.sh` and `infra-security-posture.spec.ts` pass on macOS and Linux.
- The gate's fail-closed-on-mktemp-failure behavior remains asserted on at least one platform.

## Context

Split from MG-23 during completion 2026-07-27; non-critical (test portability, not a gate defect). CI (Linux) is unaffected.

## Impact escalation (2026-07-28, found during MG-42)

This is no longer only a local-test annoyance — **it blocks `forge review-loop` on this host for every ticket on this repo.**

`forge review-loop MG-42 --since 344af69` stopped at `verification_failed` in round 1 and **skipped the reviewer entirely** (`reviewer: skipped (verification failed)`), on this exact case. MG-42's diff consequently got no adversarial review from the loop and had to be reviewed by a direct `red-wide` invoke as the documented fallback.

Two compounding factors, both worth fixing:

1. The loop could not use the green PR CI as verification evidence: it reported *"CI workflow does not demonstrably run `npm run test:all` as the `CI / test` check"*. This repo's checks are `lint-and-test (<project>)`, `build-*`, `security-scan`, `setup`, `validate-infrastructure` — not the `test` / `test-extended` names forge's CI-pairing logic looks for. So the loop always falls back to a local run on this host, where this case fails deterministically.
2. Because the local fallback is the only path, this single non-portable fixture case gates every review-loop run.

So fixing MG-40 restores the review-loop on macOS. Fixing the CI-pairing naming (worth its own ticket) would additionally let the loop consume the green CI and skip the local run altogether.

**Also worth folding in:** the loop's fixer produced a genuinely useful diagnostics improvement to `infra-security-posture.spec.ts` before it was discarded as out-of-scope for MG-42 — assert `{code, out}` together so the failure message carries the harness log naming WHICH case failed under WHICH shell, instead of a bare `Expected: 0 / Received: 1`; and distinguish a null `status` (killed by signal, or execFileSync itself failing) from a real nonzero exit, so an environment failure is not reported as a gate verdict it never rendered. Both are directly on-point for this ticket. Re-derive them here.

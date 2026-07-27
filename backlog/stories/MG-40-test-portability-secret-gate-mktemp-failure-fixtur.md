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
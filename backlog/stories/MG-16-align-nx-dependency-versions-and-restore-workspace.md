---
id: MG-16
type: story
status: active
title: align Nx dependency versions and restore workspace test execution
created: 2026-07-17
---

#### Context
The canonical verification command originally failed before project execution with `Unable to resolve @nx/workspace:run-commands`. Root-cause investigation found three independent configuration problems: a mixed Nx 19/21 dependency graph, 27 stale executor references using `@nx/workspace:run-commands` instead of `nx:run-commands`, and no declared Jest-29-compatible `@types/jest` dependency despite spec tsconfigs requesting Jest globals.

#### Acceptance Criteria
- [x] All first-party Nx packages resolve to one mutually compatible 19.8.0 line with no mixed 19/21 core-plugin graph
- [x] package.json and package-lock.json express the aligned dependency graph deterministically
- [x] `npm ci` succeeds from the lockfile
- [x] `npx nx show projects` succeeds and lists the expected workspace projects
- [x] All executable project configs use the canonical `nx:run-commands` executor
- [x] Jest 29 global types resolve from a clean install
- [x] `npx nx run-many -t test --all --skip-nx-cache` executes all ten configured test targets successfully
- [x] Remaining failures: none

#### Verification
Independent Forge test-engineer verification from a clean Linux project mount reported 10/10 Nx targets green and 314 assertions passed: 237 Jest tests and 77 Go tests. Independent host verification on macOS ran the nine portable targets green; the Raspberry Pi GPIO-backed device-controller target was verified in the Linux Forge container. Durable docs were updated to use the live executor syntax. No deployment target was executed.
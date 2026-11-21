---
id: MG-86
type: story
status: done
title: "mobile jest harness cannot run any test (missing babel/RN deps); nx test mobile passes vacuously"
closed: 2026-11-20
closed_commit: e273891
---

#### Problem
`nx test mobile` passed in CI only because `apps/mobile` had no spec files and set `passWithNoTests: true`, so jest never loaded `apps/mobile/src/test-setup.ts`. The harness was missing `babel-plugin-module-resolver`, `react-native-gesture-handler`, `react-native-reanimated`, `@react-native-async-storage/async-storage` and `@react-native-community/netinfo`, so any real spec failed with `Cannot find module 'babel-plugin-module-resolver'`. Found as a follow-up from HAR-4 (MG-74); tracked in Paperclip as HAR-7.

#### Acceptance Criteria
1. The mobile jest harness can run a test, either by adding the missing dependencies or by trimming `test-setup.ts` and `babel.config.js` to what the app uses.
2. At least one real spec exists, so `nx test mobile` stops passing vacuously.

## Closure

**Obsolete: React Native removed in HAR-71; the mobile client will be native Swift.** HAR-73 (PR #107, branch commit `5b8d26e`) deleted `apps/mobile`, its Nx project and the `react-native` dependencies, and removed the `mobile` leg from the CI `lint-and-test` matrix. There is no mobile jest harness left to repair. This record was created at closure; the ticket had no file in `backlog/stories/`.

| Acceptance criterion | Status (met / obsolete) | Evidence |
| --- | --- | --- |
| 1. The mobile jest harness can run a test | obsolete | HAR-73 (`5b8d26e`): `git ls-files apps/mobile` prints nothing; `npx nx show projects` does not list `mobile`; `npm ls react-native` reports `(empty)` |
| 2. At least one real spec, so `nx test mobile` is not vacuous | obsolete | No `mobile` project exists; `.github/workflows/ci.yml` `lint-and-test` matrix is `['api', 'web', 'api-interfaces']`. The native iOS app's tests belong to the next goal |

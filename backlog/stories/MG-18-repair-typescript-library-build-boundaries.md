---
id: MG-18
type: story
status: active
title: repair TypeScript library build boundaries
created: 2026-07-17
---

#### Context
After MG-16 restored `@nx/webpack`, `npx nx build api --skip-nx-cache` advances past executor resolution but fails in dependency builds with TS6059. `azure-client:build` and `data-models:build` compile sibling library source resolved through `tsconfig.base.json` path aliases while each `@nx/js:tsc` executor uses a project-local rootDir. The failure reproduces directly with `npx nx build data-models --skip-nx-cache`; leaf libraries build. This is a pre-existing build-boundary/configuration defect that tests do not exercise.

#### Acceptance Criteria
- [ ] Capture the direct data-models and API build failures before changing configuration
- [ ] Buildable libraries consume sibling build outputs or explicit project boundaries rather than widening rootDir to compile unrelated source trees
- [ ] `npx nx build api-interfaces --skip-nx-cache` passes
- [ ] `npx nx build utils --skip-nx-cache` passes
- [ ] `npx nx build data-models --skip-nx-cache` passes
- [ ] `npx nx build azure-client --skip-nx-cache` passes
- [ ] `npx nx build api --skip-nx-cache` passes
- [ ] `npm test` passes after an Nx cache reset
- [ ] No deployment target is executed and no credential-bearing local files are touched
- [ ] Durable Nx/build documentation is updated only if the supported configuration pattern changes
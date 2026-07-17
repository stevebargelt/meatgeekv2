---
id: MG-16
type: story
status: active
title: align Nx dependency versions and restore workspace test execution
created: 2026-07-17
---

#### Context
The canonical verification command `npx nx run-many -t test --all` fails before project execution with `Unable to resolve @nx/workspace:run-commands`. Root-cause investigation shows the workspace was created with a mixed Nx dependency graph in the initial commit: `nx` and `@nx/vite` are 21.4.1 while most first-party Nx plugins, including `@nx/workspace`, `@nx/js`, `@nx/jest`, React, and React Native, are 19.8.0. The installed 19.8.0 workspace executor manifest does not expose `run-commands`, while the 21.4.1 core attempts to resolve it there. Preserve the existing Nx 19-era project configuration unless evidence shows a coordinated upgrade is safer.

#### Acceptance Criteria
- [ ] All first-party Nx packages resolve to one mutually compatible major/minor line with no mixed 19/21 core-plugin graph
- [ ] package.json and package-lock.json express the aligned dependency graph deterministically
- [ ] `npm ci` succeeds from the committed lockfile
- [ ] `npx nx show projects` succeeds and lists the expected workspace projects
- [ ] `npx nx run-many -t test --all` reaches project execution and all configured test targets pass
- [ ] Any remaining project-level test failures are distinguished from Nx bootstrap/executor failures and filed with concrete evidence
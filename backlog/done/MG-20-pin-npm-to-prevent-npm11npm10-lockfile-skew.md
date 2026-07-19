---
id: MG-20
type: story
status: done
title: pin npm to prevent npm11/npm10 lockfile skew
created: 2026-07-18
closed: 2026-07-18
closed_commit: 56b003804e8e11b056ad5e0346f16905656d7d81
---

## Problem

CI runner is Node 20 / npm 10; local + agent tooling default to npm 11. The two produce incompatible `package-lock.json` output, so an `npm install` run under npm 11 re-breaks `npm ci` on CI (lockfile-not-in-sync). This skew broke CI twice during the MG-18/19 arc and forced the interim workaround `npx npm@10 install --package-lock-only`.

## Durable fix

Pin the package manager so every environment (local, agent container, CI) resolves npm to a single version:
- Add a `packageManager` field (e.g. `"npm@10.x.x"`) to root `package.json` so Corepack/tooling honor it.
- Add / adjust the CI npm-install step to enforce the pinned npm version rather than the runner default.

## Acceptance criteria

- `package.json` declares a pinned `packageManager` npm version.
- A fresh `npm install` on a developer/agent machine produces a `package-lock.json` that passes `npm ci` on CI (no lockfile-sync failure).
- The interim `npx npm@10 install --package-lock-only` workaround is no longer required and this is noted where documented.
- CI green after the change.

## Context

Refiled — a prior session's HEAD commit subject claimed to file this as "MG-20" but the ticket never persisted in the backlog.

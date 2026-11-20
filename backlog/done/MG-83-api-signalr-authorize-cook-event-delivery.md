---
id: MG-83
type: story
status: done
title: "authorize cook-event delivery deviceId against the caller's owned devices"
closed: 2026-11-20
closed_commit: f29d094
---

#### Problem
start-cook and stop-cook sent COOK_STARTED / COOK_STOPPED with SignalR `userId = body.deviceId`, so any caller could direct a cook event to any device's identity. Found by MG-59 review RF-3.

#### Acceptance Criteria
1. Start and stop reject (403) a deviceId the principal does not own, before any write or SignalR emission (HAR-26 #71).
2. The ownership lookup is a single-partition point read (`device-ownership.ts`, `getDeviceOwnership`).
3. There are negative tests for a foreign deviceId, an unknown deviceId and a missing principal.
4. It lands before MG-25 (prod is still inactive).
5. Added by HAR-55: delivery goes to the owner's `userId`, never a deviceId (HAR-57 #91, cook-events integration test).

## Closure

**Completed.** HAR-26 (#71, `d91960a`) made start and stop refuse a device the caller does not own before any write or emission; HAR-57 (#91, `f0ac2e4`) addressed every cook event to the owner's `userId` instead of a deviceId. This record was created at closure; the ticket had no file in `backlog/stories/`.

Live evidence is Deploy Dev App run **44747912598** (main `f29d094`, 2026-11-20, green).

| Acceptance criterion | Status (met / obsolete) | Evidence |
| --- | --- | --- |
| 1. Start and stop answer 403 for a deviceId the principal does not own, before any write or SignalR emission | met | HAR-26 #71 (`d91960a`); `apps/api/src/functions/cooks/start-cook.spec.ts` › `HAR-26 — only the device owner can start a cook (MG-88, MG-83)` › `%s device: 403 DEVICE_NOT_OWNED, no startCook call, no SignalR output`; `apps/api/src/functions/cooks/stop-cook.spec.ts` › `HAR-26 — only the device owner can stop a cook (MG-83, MG-88)` › `%s device: 403 DEVICE_NOT_OWNED, no write, no SignalR output`; run 44747912598: `PASS signalr isolation › the peer: POST /cooks on the simulated device is 403 DEVICE_NOT_OWNED` |
| 2. The ownership lookup is a single-partition point read | met | `DevicesRepository.getDeviceOwnership` in `apps/api/src/shared/cosmos/devices-repository.ts` reads `container.item(deviceId, deviceId).read()` (one point read, partition = device id) and answers `owned` / `foreign` / `unknown`; `apps/api/src/functions/cooks/device-ownership.ts` holds the shared 403 `DEVICE_NOT_OWNED` body both routes return (HAR-26 #71, `d91960a`) |
| 3. Negative tests for a foreign deviceId, an unknown deviceId and a missing principal | met | Foreign and unknown: the `it.each(['foreign', 'unknown'] as const)` 403 tests above in `start-cook.spec.ts` and `stop-cook.spec.ts`, plus `start-cook.spec.ts` › `foreign and unknown devices get byte-identical responses`. Missing principal: `start-cook.spec.ts` › `missing principal: 401 before any ownership read`; `stop-cook.spec.ts` › `missing principal: 401 before any read` |
| 4. Lands before MG-25 (prod still inactive) | met | HAR-26 #71 merged `d91960a` on 2026-11-18; MG-25 (production activation) is still `status: active` in `backlog/stories/` |
| 5. Delivery goes to the owner's `userId`, never a deviceId (added by HAR-55) | met | HAR-57 #91 (`f0ac2e4`); `apps/api/src/integration/cook-events.integration.spec.ts` › `emits exactly one cook_started envelope to the owner (userId = principal) with correlation from X-Request-ID`, `emits one cook_stopped envelope to the owner (userId = principal) with top-level cookId OMITTED`; run 44747912598: `PASS signalr isolation › POST /cooks as the owner starts a cook on the simulated device and cook_started reaches the owner`, `METRIC isolation-peer-messages 0` |

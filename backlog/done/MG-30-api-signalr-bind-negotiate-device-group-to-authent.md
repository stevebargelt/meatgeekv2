---
id: MG-30
type: story
status: done
title: "api-signalr: bind negotiate device-group to authenticated identity instead of trusting a deviceId query param (MG-14 DEC-4 authz hardening)"
created: 2026-07-21
closed: 2026-11-20
closed_commit: f29d094
---

## Closure

**Completed** by goal HAR-55. `POST /negotiate` mints the SignalR token for the Easy Auth principal's `userId`, resets its group membership to exactly the devices that user owns, and ignores any `deviceId` query parameter (HAR-57 #91, `f0ac2e4`; REST contract fixes HAR-59 #95, `9cc0d0a`). The live isolation proof shows a non-owner receives nothing.

Live evidence is Deploy Dev App run **44747912598** (main `f29d094`, 2026-11-20, green).

| Acceptance criterion | Status (met / obsolete) | Evidence |
| --- | --- | --- |
| (a) The token is minted for the principal's `userId` | met | HAR-57 #91 (`f0ac2e4`); `apps/api/src/functions/signalr/negotiate.spec.ts` › `returns 200 { url, accessToken } minted for exactly principal.userId`; run 44747912598: `PASS signalr isolation › the owner negotiates and connects, listening for temperature, cook_started and cook_stopped` |
| (b) Group membership is limited to owned devices | met | HAR-57 #91 (`f0ac2e4`), HAR-59 #95 (`9cc0d0a`); `negotiate.spec.ts` › `resets membership: remove-all first, then one add per owned device and nothing else`, `with no owned devices, still clears the groups and adds none`; `apps/api/src/integration/cook-events.integration.spec.ts` › `returns a token for the principal and joins only the caller's device groups` |
| (c) The `deviceId` query parameter is ignored | met | `negotiate.spec.ts` › `ignores ?deviceId=<foreign device>: same token, same groups, no 400`; `cook-events.integration.spec.ts` › `ignores a ?deviceId= for a device the caller does not own`; run 44747912598: `PASS signalr isolation › the peer: POST /negotiate?deviceId=<simulated device> returns 200 and its client connects` |
| (d) A non-owner receives nothing live | met | Run 44747912598: `PASS signalr isolation › the owner receives the reading on temperature; the peer receives nothing in the grace window`, `PASS signalr isolation › POST /cooks/{cookId}/stop stops it, cook_stopped reaches the owner, and the peer has received nothing`, `METRIC isolation-peer-messages 0` (proof added by HAR-67 #102, `e6b1991`) |

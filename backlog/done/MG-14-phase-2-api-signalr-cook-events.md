---
id: MG-14
type: story
status: done
title: "[Phase 2] api-signalr-cook-events"
closed: 2026-11-20
closed_commit: f29d094
---

#### Context
Surfaced during #5's architect gate. The data-pusher (ticket #5) shipped a Go SignalR consumer that connects to receive `cook_started` and `cook_stopped` events from the API. But the Azure Functions API doesn't actually emit those events yet — there's no `negotiate` endpoint and no event publisher. The data-pusher's SignalR client is currently a consumer-without-a-producer; it gracefully reconnects but receives nothing.

#### Acceptance Criteria
- [x] Azure Functions API exposes a SignalR `negotiate` HTTP endpoint that returns the connection info for the SignalR Service
- [x] When a cook start API call lands, the Function publishes a `cook_started` event with `{cookId, deviceId, startedAt, ...}` payload to the SignalR hub on a per-device group
- [x] When a cook stop API call lands, the Function publishes a `cook_stopped` event with `{cookId, deviceId, stoppedAt, ...}`
- [x] Authentication on the negotiate endpoint matches the broader API auth scheme
- [ ] ~~Smoke test: trigger a cook start via the API, see the data-pusher's SignalR client receive the event and update its `activeCookID`, then see subsequent telemetry messages carry the new `cookId`~~ (obsolete, see Closure)

#### Notes
Phase 2 work per docs/planning/implementation-phases.md (the API/SignalR section). Filed now so the cross-ticket dependency between #5's SignalR consumer and #6's end-to-end smoke test is explicit. #6's smoke test should pass even without #14 because the SignalR consumer is graceful-on-no-events.

## Closure

**Completed** by goal HAR-55, with AC5 **obsolete**: the API negotiates SignalR for the authenticated caller and pushes `cook_started` / `cook_stopped` to the cook's owner. AC5 assumed the Pi learns its cook over SignalR; under the 2026-11-19 owner decision the Pi gets its cook from the IoT Hub device twin instead, and the live twin proof replaces the smoke test.

Live evidence is the post-merge acceptance run of HAR-69 on main: Deploy Dev App run **44747912598** (main `f29d094`, 2026-11-20, green).

| Acceptance criterion | Status (met / obsolete) | Evidence |
| --- | --- | --- |
| AC1. `negotiate` HTTP endpoint returns the SignalR connection info | met | HAR-57 #91 (`f0ac2e4`) and HAR-59 #95 (`9cc0d0a`); `apps/api/src/functions/signalr/negotiate.spec.ts` › `returns 200 { url, accessToken } minted for exactly principal.userId`; run 44747912598: `PASS signalr negotiate › POST /negotiate returns a url and an accessToken`, `PASS signalr negotiate › a SignalR client connects with that url and token, then stops` |
| AC2. Cook start publishes `cook_started`. Delivered to the **owning user** (`userId` = principal), not to a per-device group (HAR-57) | met | HAR-57 #91 (`f0ac2e4`); `apps/api/src/integration/cook-events.integration.spec.ts` › `emits exactly one cook_started envelope to the owner (userId = principal) with correlation from X-Request-ID`; run 44747912598: `PASS signalr isolation › POST /cooks as the owner starts a cook on the simulated device and cook_started reaches the owner`, `METRIC signalr-cook-event-ms 208` |
| AC3. Cook stop publishes `cook_stopped`. Delivered to the **owning user**, not to a per-device group (HAR-57) | met | HAR-57 #91 (`f0ac2e4`); `cook-events.integration.spec.ts` › `emits one cook_stopped envelope to the owner (userId = principal) with top-level cookId OMITTED`; run 44747912598: `PASS signalr isolation › POST /cooks/{cookId}/stop stops it, cook_stopped reaches the owner, and the peer has received nothing` |
| AC4. Negotiate auth matches the API scheme | met | Easy Auth at the platform; the handler derives `userId` from the principal with the same `principalFromRequest` (`apps/api/src/shared/auth/principal.ts`) every route uses (`negotiate.ts`, `main.ts` registration). `negotiate.spec.ts` › `answers 401 with no principal and makes no SignalR or Cosmos call`; run 44747912598: `PASS signalr negotiate › POST /negotiate returns a url and an accessToken` (bearer token through Easy Auth) |
| AC5. data-pusher SignalR smoke test | obsolete | 2026-11-19 owner decision: the Pi gets its cook from the device twin; HAR-58 #92 (`ef18023`) removed the Pi's SignalR client (see MG-29). Replacement evidence, run 44747912598: `PASS device twin › simdevice --twin --count 1 reconnects: the twin carries the cook and the device reports it applied`, `METRIC twin-apply-ms 356`, `PASS device twin › GET /temperatures/current/{deviceId} returns the reading just sent, tagged with the cook`, `PASS device twin › simdevice --twin --count 0 reconnects: the twin has no cook and the device reports it applied` |

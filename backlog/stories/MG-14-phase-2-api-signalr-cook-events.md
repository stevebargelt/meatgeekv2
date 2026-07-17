---
id: MG-14
type: story
status: active
title: "[Phase 2] api-signalr-cook-events"
---

#### Context
Surfaced during #5's architect gate. The data-pusher (ticket #5) shipped a Go SignalR consumer that connects to receive `cook_started` and `cook_stopped` events from the API. But the Azure Functions API doesn't actually emit those events yet — there's no `negotiate` endpoint and no event publisher. The data-pusher's SignalR client is currently a consumer-without-a-producer; it gracefully reconnects but receives nothing.

#### Acceptance Criteria
- [ ] Azure Functions API exposes a SignalR `negotiate` HTTP endpoint that returns the connection info for the SignalR Service
- [ ] When a cook start API call lands, the Function publishes a `cook_started` event with `{cookId, deviceId, startedAt, ...}` payload to the SignalR hub on a per-device group
- [ ] When a cook stop API call lands, the Function publishes a `cook_stopped` event with `{cookId, deviceId, stoppedAt, ...}`
- [ ] Authentication on the negotiate endpoint matches the broader API auth scheme
- [ ] Smoke test: trigger a cook start via the API, see the data-pusher's SignalR client receive the event and update its `activeCookID`, then see subsequent telemetry messages carry the new `cookId`

#### Notes
Phase 2 work per docs/planning/implementation-phases.md (the API/SignalR section). Filed now so the cross-ticket dependency between #5's SignalR consumer and #6's end-to-end smoke test is explicit. #6's smoke test should pass even without #14 because the SignalR consumer is graceful-on-no-events.
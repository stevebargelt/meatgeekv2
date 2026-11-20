---
id: MG-6
type: story
status: active
title: otel-integration
---

#### Context
Cross-cutting observability work landing the OTel discipline + Sentry architecture decisions from the synthesis. Includes amending `docs/monitoring/observability.md` to reflect the OTel-with-two-exemptions discipline. Sentry architecture-establishment happens here (free tier, $0); Sentry implementation is Phase 3 ticket #7. Also wires the 5 alerts deferred from #1.

#### Acceptance Criteria — OTel instrumentation
- [ ] Go device-controller: OTel Go SDK + Azure Monitor exporter (NewRelic was removed in #4 ✅)
- [ ] Go data-pusher: OTel Go SDK + Azure Monitor exporter (skeleton at `internal/telemetry/tracing.go` exists from #5; wire the Azure Monitor exporter and instrument the publish path)
- [ ] TS Azure Functions API: `@azure/monitor-opentelemetry` distribution
- [ ] Connection strings + endpoints via env vars only (no hardcoded values)
- [ ] AlwaysSample on Go side (volume too small to undersample); 50% sampling on Functions (configured in #1 ✅)

#### Acceptance Criteria — Trace propagation
- [ ] W3C Trace Context propagation across device-controller → data-pusher → IoT Hub → Functions → CosmosDB → SignalR
- [ ] `correlation.id` rides as IoT Hub message property on send (data-pusher already sets a UUID placeholder per #5 — tighten this to W3C trace context) and is restored to span dimension on receive (Function)
- [ ] Standard custom dimensions enforced everywhere: `device.id`, `cook.id`, `correlation.id`, `processing.path`, `component`, `environment`

#### Acceptance Criteria — Sentry architecture (Phase 1, $0 on Developer free tier)
- [ ] Sentry organization created (single-user free tier)
- [ ] Sentry projects provisioned (decide during implementation: one project + environments, or one project per app)
- [ ] DSN management contract documented (env var per project/environment)
- [ ] `traceparent` injection contract designed: how RN client will inject on outbound HTTP, how backend OTel pipeline preserves it, how the trace-ID copy-paste join workflow works
- [ ] Free-tier quotas verified against current Sentry pricing page

#### Acceptance Criteria — Deferred alerts (carried over from #1)
- [ ] Wire 5 custom-metric alerts to the existing Action Group, against dimensions emitted by the new OTel instrumentation:
  1. Device disconnected (dynamic threshold on `meatgeek_device_connectivity` gauge by `device.id`)
  2. Real-time path error rate > 10% over 5 min (filter on `processing.path` dimension)
  3. Storage path p95 latency > 5s over 5 min
  4. Temperature reading out of safe range (>500°F or <32°F)
  5. Cook session idle > 2 min while active

#### Acceptance Criteria — Documentation
- [ ] Amend `docs/monitoring/observability.md`:
  - [ ] OTel-with-two-exemptions discipline (server/device = OTel; React web = App Insights JS SDK; native iOS (Swift), not built = Sentry)
  - [ ] Trace-ID copy-paste join workflow for mobile↔backend debugging
  - [ ] Sentry-vs-App-Insights ownership boundary (backend errors → App Insights; mobile crashes → Sentry; never bridge them)
  - [ ] Custom dimension contract (already in doc; verify still accurate)

#### Acceptance Criteria — Validation
- [ ] End-to-end smoke test: device → data-pusher → IoT Hub → Function → CosmosDB → SignalR, full trace visible in App Insights Application Map and Transaction Search; `correlation.id` queryable
- [ ] First-cut Workbook content populates the stub created in #1 ✅

#### Dependencies
- Depends on: #1 (✅), #4 (✅), #5 (✅)
- Unblocks: Phase 3 #7 depends on Sentry architecture established here
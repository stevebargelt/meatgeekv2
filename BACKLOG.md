# MeatGeek V2 Backlog

## Notes for next session

### Phase 1 backlog filed (2026-05-26)

Phase 1 tickets #1–#6 filed against the o11y architecture synthesis. Phase 3 ticket #7 (mobile-sentry-integration) filed in advance to lock scope.

**Security finding (manual stakeholder action required):**
NewRelic license key `***REMOVED***` is checked into `apps/device-controller/main.go:43`. Repo has no git history so it hasn't shipped. **Rotate the key on the NewRelic side regardless** — code removal is handled by ticket #4. Not in scope of any ticket.

**Dependency graph:**
- #1 (infra-azure-services-config) → unblocks #5, #6
- #4 (device-controller-integration) → unblocks #6
- #2 (lib-api-specs), #3 (lib-data-models-tests) → independent, parallel-friendly
- #6 (otel-integration) → architecture for Phase 3 #7

**Architecture artifacts (read for deep context):**
- Synthesis: `~/.forge/runs/run-o11y-architecture-synthesis-668aa7/`
- Backend APM research: `~/.forge/runs/run-o11y-research-backend-apm-c5c89b/`
- Frontend RUM research: `~/.forge/runs/run-o11y-research-frontend-rum-2b7b18/`
- Analytics/flags research: `~/.forge/runs/run-o11y-research-product-analytics-flags-51845e/`

## Active

### #1 — infra-azure-services-config

#### Context
Foundation work for Phase 1 o11y architecture (synthesis: `~/.forge/runs/run-o11y-architecture-synthesis-668aa7/`). The monitoring Terraform module today is only an Action Group + budget alert — App Insights, Log Analytics, ingestion controls, diagnostic settings, and metric alerts are all missing. Also configures IoT Hub parallel routing (CosmosDB direct route + Event Hub route) which is currently a TODO in `apps/infrastructure/modules/iot-hub/main.tf`.

#### Acceptance Criteria
- [ ] IoT Hub parallel routing configured: direct route → CosmosDB (storage); Event Hub route → Functions (real-time)
- [ ] Application Insights resource (workspace-based) + Log Analytics workspace provisioned via Terraform
- [ ] Daily ingestion cap of 2 GB/day on the workspace (Terraform-managed)
- [ ] Diagnostic Settings routing platform/resource logs to workspace for: IoT Hub, CosmosDB, Functions, SignalR
- [ ] App Insights 50% sampling baseline configured for Functions
- [ ] CosmosDB partitioning verified against spec; container RU/s config confirmed within 1000 RU/s free tier at projected telemetry volume (5–10 devices × write frequency × per-write RU). Flag back to stakeholder if projected to exceed.
- [ ] 10 metric alerts attached to existing Action Group:
  1. Device disconnected (dynamic threshold on connectivity gauge by `device.id`)
  2. Real-time path error rate > 10% over 5 min
  3. Storage path p95 latency > 5s over 5 min
  4. Temperature reading out of safe range (>500°F or <32°F)
  5. Cook session idle > 2 min while active
  6. Function failure rate > 5% over 5 min
  7. CosmosDB 429 rate > 0 over 5 min
  8. SignalR connection failure rate > 5% over 5 min
  9. Daily ingestion cap reached
  10. $150 secondary budget alert (warning before $200 credit exhausted)
- [ ] Workbook stub resource created (content lands in #6)
- [ ] `terraform plan` clean; deploy to dev validated

#### Dependencies
- Unblocks: #5 (data-pusher), #6 (otel-integration)
- Depends on: none

### #2 — lib-api-specs

#### Context
The `libs/api-specs` library does not exist. Phase 1 calls for OpenAPI 3.0 specs as the contract between mobile/web clients and the Functions API, with a mock server for client development before the backend is live. `libs/api-interfaces` has 624 lines of hand-written TypeScript types that may need reconciling with generated types.

#### Acceptance Criteria
- [ ] `libs/api-specs` NX library created
- [ ] OpenAPI 3.0 specs covering Phase 1 API surface: cook management (create/start/stop/list/history), temperature queries with cook association, device status + configuration
- [ ] Swagger UI integration for spec browsing
- [ ] Mock API server with realistic BBQ temperature data
- [ ] Request/response validation middleware against spec
- [ ] Contract testing scaffolding
- [ ] `nx serve api-specs` works
- [ ] Decision documented: re-export from generated types in `@meatgeekv2/api-interfaces`, or maintain dual sources

#### Dependencies
- Independent of other Phase 1 tickets

### #3 — lib-data-models-tests

#### Context
`libs/data-models` has 919 lines of implementation across `cook-manager.ts`, `temperature-calculator.ts`, `validation.ts`. No test files exist in the lib's src tree. Phase 1 calls for comprehensive unit tests.

#### Acceptance Criteria
- [ ] Unit tests for `cook-manager.ts`: createCook, lifecycle transitions, edge cases (invalid meat types, missing target temps, duplicate IDs)
- [ ] Unit tests for `temperature-calculator.ts`: doneness calculations, interpolation, safe-range validation
- [ ] Unit tests for `validation.ts`: all rules, error message correctness
- [ ] `nx test data-models` passes
- [ ] Code coverage ≥ 80% on the lib

#### Dependencies
- Independent of other Phase 1 tickets

#### Notes
Pure test-writing — implementation already in place.

### #4 — device-controller-integration

#### Context
`apps/device-controller` is a copy-paste of the legacy MeatGeek-DeviceController repo. Go module path is still `github.com/stevebargelt/MeatGeek-DeviceController`. Imports `newrelic/go-agent`. Hardcoded NewRelic license key on `main.go:43` (security finding — see notes section of BACKLOG). NX `build-arm` cross-compile target unverified.

#### Acceptance Criteria
- [ ] Go module path renamed under `meatgeekv2` namespace
- [ ] All internal `goqueue` import paths updated to match new module path
- [ ] `newrelic/go-agent` dependency removed from `go.mod` and `go.sum`
- [ ] Hardcoded NewRelic license key removed from `main.go` (OTel replacement happens in #6)
- [ ] NX `build-arm` target produces a working ARMv7 binary for Raspberry Pi
- [ ] Integration with `@meatgeekv2/api-interfaces` types verified (Go codegen from #2 OpenAPI specs, or another path documented)
- [ ] `nx build device-controller` and `nx build-arm device-controller` both pass

#### Dependencies
- Unblocks: #6 (otel-integration)
- Depends on: none

#### Notes
**SECURITY**: rotation of the leaked NewRelic key is a manual stakeholder action — not in scope of this ticket. See notes section of BACKLOG.

### #5 — data-pusher-implementation

#### Context
`apps/data-pusher` has the structure (`cmd/main.go`, `internal/{collector, iothub, telemetry}`) but `iothub/client.go` is a stub — `PublishTelemetry` is a TODO that no-ops. Cook session state, temperature enrichment, local buffering, and SignalR client are not yet implemented.

#### Acceptance Criteria
- [ ] Real Azure IoT Hub publishing in `internal/iothub/client.go` (MQTT or AMQP via Azure Go SDK)
- [ ] Cook session management: in-memory active `cookId`, recovery on restart
- [ ] Temperature enrichment: every outbound telemetry message carries `cookId`, `device.id`, `correlation.id`
- [ ] Local buffering for offline scenarios (disk-backed queue, replay on reconnect)
- [ ] SignalR client for receiving cook start/stop notifications from backend
- [ ] systemd service configuration for Raspberry Pi deployment
- [ ] `nx build-arm data-pusher` produces working ARMv7 binary
- [ ] End-to-end smoke test: data-pusher → IoT Hub → CosmosDB (storage path) and → Functions (real-time path) both visible in Azure Portal
- [ ] Mock IoT Hub client preserved for dev

#### Dependencies
- Depends on: #1 (needs IoT Hub parallel routing + CosmosDB endpoint live)
- Unblocks: #6 (OTel instruments the working data path)

#### Notes
The `correlation.id` IoT Hub message-property contract is defined in #6 — implement against that contract.

### #6 — otel-integration

#### Context
Cross-cutting observability work landing the OTel discipline + Sentry architecture decisions from the synthesis. Includes amending `docs/monitoring/observability.md` to reflect the OTel-with-two-exemptions discipline. Sentry architecture-establishment happens here (free tier, $0); Sentry implementation is Phase 3 ticket #7.

#### Acceptance Criteria — OTel instrumentation
- [ ] Go device-controller: OTel Go SDK + Azure Monitor exporter (replacing NewRelic, removed in #4)
- [ ] Go data-pusher: OTel Go SDK + Azure Monitor exporter
- [ ] TS Azure Functions API: `@azure/monitor-opentelemetry` distribution
- [ ] Connection strings + endpoints via env vars only (no hardcoded values)
- [ ] AlwaysSample on Go side (volume too small to undersample); 50% sampling on Functions (configured in #1)

#### Acceptance Criteria — Trace propagation
- [ ] W3C Trace Context propagation across device-controller → data-pusher → IoT Hub → Functions → CosmosDB → SignalR
- [ ] `correlation.id` rides as IoT Hub message property on send (data-pusher) and is restored to span dimension on receive (Function)
- [ ] Standard custom dimensions enforced everywhere: `device.id`, `cook.id`, `correlation.id`, `processing.path`, `component`, `environment`

#### Acceptance Criteria — Sentry architecture (Phase 1, $0 on Developer free tier)
- [ ] Sentry organization created (single-user free tier)
- [ ] Sentry projects provisioned (decide during implementation: one project + environments, or one project per app)
- [ ] DSN management contract documented (env var per project/environment)
- [ ] `traceparent` injection contract designed: how RN client will inject on outbound HTTP, how backend OTel pipeline preserves it, how the trace-ID copy-paste join workflow works
- [ ] Free-tier quotas verified against current Sentry pricing page (research dated 2026-05-26 — pricing moves)

#### Acceptance Criteria — Documentation
- [ ] Amend `docs/monitoring/observability.md`:
  - [ ] OTel-with-two-exemptions discipline (server/device = OTel; React web = App Insights JS SDK; React Native = Sentry)
  - [ ] Trace-ID copy-paste join workflow for mobile↔backend debugging
  - [ ] Sentry-vs-App-Insights ownership boundary (backend errors → App Insights; mobile crashes → Sentry; never bridge them)
  - [ ] Custom dimension contract (already in doc; verify still accurate)

#### Acceptance Criteria — Validation
- [ ] End-to-end smoke test: device → data-pusher → IoT Hub → Function → CosmosDB → SignalR, full trace visible in App Insights Application Map and Transaction Search; `correlation.id` queryable
- [ ] First-cut Workbook content populates the stub created in #1

#### Dependencies
- Depends on: #1 (App Insights workspace), #4 (NewRelic gone from device-controller), #5 (working data path to instrument)
- Unblocks: nothing in Phase 1; Phase 3 #7 depends on Sentry architecture established here

### #7 — [Phase 3] mobile-sentry-integration

#### Context
Phase 3 implementation work — DO NOT start before Phase 1 #6 lands and the mobile app exists. Filed now to lock scope. Architecture is established in Phase 1 ticket #6. This ticket wires the Sentry RN SDK into the mobile app once it exists. Free-tier appropriate at single-developer scale.

#### Acceptance Criteria
- [ ] Sentry RN SDK installed and initialized in `apps/mobile`
- [ ] Sentry init reads DSN from env var per the contract established in #6
- [ ] Hermes sourcemap automation in CI:
  - [ ] `@sentry/wizard` or equivalent integrated into mobile build
  - [ ] Fastlane plugin or CI step uploads sourcemaps on every release build
  - [ ] CI fails (not warns) if sourcemap upload fails
- [ ] Native iOS crash reporting verified (force a native crash, confirm symbolicated stack in Sentry)
- [ ] Native Android crash reporting verified (same)
- [ ] On-device offline event queue verified (toggle airplane mode, generate event, reconnect, confirm event arrives)
- [ ] Session replay enabled at 10% sampling with `replaysOnErrorSampleRate: 1.0`
- [ ] Outbound HTTP requests inject W3C `traceparent` per the contract from #6
- [ ] End-to-end smoke test: trigger RN error → Sentry capture → copy trace-id → find backend half in App Insights Transaction Search

#### Dependencies
- Depends on: #6 (Sentry architecture + DSN contract documented)
- Depends on: existence of mobile app implementation (separate Phase 3 mobile ticket family)

#### Notes
Phase 3 ticket — not active work. Filed now to keep scope explicit when mobile work begins. Free tier quotas (5K errors, 50 replays, 5M spans per 2026-05 Developer plan) — verify current pricing at Phase 3 start.

## Done (recent)

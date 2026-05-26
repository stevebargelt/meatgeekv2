# MeatGeek V2 Backlog

## Notes for next session

### Wave 2 of Phase 1 landed (2026-05-26)

Tickets #1-#5 + #8 complete. Wave 3 is just #6 (otel-integration) — depends on #1, #4, #5, all done.

Pipeline anomaly during #5: the first build attempt hit Anthropic's 5-hour rate limit mid-run. `forge retry` created fresh sub-builds that completed cleanly. Some "zombie" pending tasks remain in the #5 run's task list as audit artifacts — the work itself is complete and committed (`5d7e111`).

**Security finding (manual stakeholder action required):**
NewRelic license key `***REMOVED***` was in `apps/device-controller/main.go:43` — redacted in commit `96f1fa1`, fully removed in commit `1f03708` (ticket #4). Still in git history. **Rotate the key on the NewRelic side** to invalidate the leaked credential.

**Architecture artifacts (read for deep context on the o11y stack decisions):**
- Synthesis: `~/.forge/runs/run-o11y-architecture-synthesis-668aa7/`
- Backend APM research: `~/.forge/runs/run-o11y-research-backend-apm-c5c89b/`
- Frontend RUM research: `~/.forge/runs/run-o11y-research-frontend-rum-2b7b18/`
- Analytics/flags research: `~/.forge/runs/run-o11y-research-product-analytics-flags-51845e/`

## Active

### #6 — otel-integration

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
  - [ ] OTel-with-two-exemptions discipline (server/device = OTel; React web = App Insights JS SDK; React Native = Sentry)
  - [ ] Trace-ID copy-paste join workflow for mobile↔backend debugging
  - [ ] Sentry-vs-App-Insights ownership boundary (backend errors → App Insights; mobile crashes → Sentry; never bridge them)
  - [ ] Custom dimension contract (already in doc; verify still accurate)

#### Acceptance Criteria — Validation
- [ ] End-to-end smoke test: device → data-pusher → IoT Hub → Function → CosmosDB → SignalR, full trace visible in App Insights Application Map and Transaction Search; `correlation.id` queryable
- [ ] First-cut Workbook content populates the stub created in #1 ✅

#### Dependencies
- Depends on: #1 (✅), #4 (✅), #5 (✅)
- Unblocks: Phase 3 #7 depends on Sentry architecture established here

### #7 — [Phase 3] mobile-sentry-integration

#### Context
Phase 3 implementation work — DO NOT start before Phase 1 #6 lands and the mobile app exists. Filed now to lock scope. Architecture is established in Phase 1 ticket #6.

#### Acceptance Criteria
- [ ] Sentry RN SDK installed and initialized in `apps/mobile`
- [ ] Sentry init reads DSN from env var per the contract established in #6
- [ ] Hermes sourcemap automation in CI (`@sentry/wizard` or equivalent); CI fails (not warns) if upload fails
- [ ] Native iOS + Android crash reporting verified (force crashes, confirm symbolicated stacks)
- [ ] On-device offline event queue verified (airplane mode test)
- [ ] Session replay enabled at 10% sampling with `replaysOnErrorSampleRate: 1.0`
- [ ] Outbound HTTP requests inject W3C `traceparent` per the contract from #6
- [ ] End-to-end smoke test: trigger RN error → Sentry capture → copy trace-id → find backend half in App Insights

#### Dependencies
- Depends on: #6 + mobile app existing

### #9 — data-models-impl-fixes

#### Context
Bugs in `libs/data-models` that the #3 test suite pins as characterization tests with `// BUG:` comments. Each represents a real divergence that should be resolved (probably by aligning cook-manager and DataValidator on a single source of truth, likely the constants in `@meatgeekv2/utils`).

#### Acceptance Criteria
- [ ] `createCook` cookId generation collision risk addressed (Date.now()+Math.random with 9-char base36 ≈ 34 bits entropy is insufficient for distributed concurrent creates — UUIDv4 or ULID recommended)
- [ ] `calculateRSquared` NaN propagation when all `normalizedTimes` are identical (denominator becomes zero in slope calc, line ~260 of temperature-calculator.ts)
- [ ] Hardcoded anomaly thresholds (15/25/50°F in `detectAnomalies`) either documented with rationale or made configurable
- [ ] cook-manager vs DataValidator divergence on `meatType` lookup: cook-manager uses object KEY (PORK_SHOULDER), DataValidator uses `.name` field (Pork Shoulder). Unify on one strategy.
- [ ] cook name trim/no-trim disagreement between cook-manager and DataValidator
- [ ] Weight bounds disagreement: cook-manager hard-fails outside 0<w≤100, DataValidator allows >0 with warning over 50. Unify.
- [ ] `validateCookNameUniqueness` compares `cook.name !== excludeCookId` — almost certainly meant `cook.id !== excludeCookId`. Fix and verify existing characterization test for the old behavior is updated.
- [ ] Update the corresponding `// BUG:` characterization tests in #3's spec files to assert the fixed behavior

### #10 — infra-security-hardening

#### Context
Pre-existing security issues red-wide flagged during #1's review. Out of scope for #1 (which was o11y-focused) but should be addressed before this infra goes near a production environment.

#### Acceptance Criteria
- [ ] Azure subscription ID removed from hardcoded provider config in `apps/infrastructure/main.tf:~25`; use environment variable, var, or terraform.tfvars
- [ ] CORS on SignalR + Azure Functions narrowed from `*` to known origins
- [ ] Functions module: replace storage account primary access key in plaintext app settings with managed identity (`azurerm_user_assigned_identity` + role assignment on the storage account)
- [ ] Other secrets in plaintext `app_settings` (connection strings, etc.) migrated to Key Vault references or managed identity
- [ ] CORS `support_credentials` decision aligned with chosen authentication scheme

### #11 — data-pusher-module-path-rename

#### Context
`apps/data-pusher`'s Go module path is currently `meatgeek-pusher` (declared in `go.mod`). #4 set the monorepo convention as `github.com/stevebargelt/meatgeekv2/apps/<app>`. Rename data-pusher to match.

#### Acceptance Criteria
- [ ] `apps/data-pusher/go.mod` module path → `github.com/stevebargelt/meatgeekv2/apps/data-pusher`
- [ ] All internal import paths updated
- [ ] `go build ./...`, `go vet ./...`, `go test ./...` all pass
- [ ] `nx build data-pusher` and `nx build-arm data-pusher` both pass

#### Notes
Now that #5 has landed, this is safe to run anytime.

### #12 — azurerm-v5-deprecation-cleanup

#### Context
4 `azurerm_monitor_diagnostic_setting` resources in `apps/infrastructure/modules/monitoring/main.tf:67-143` use the deprecated `metric { category = "AllMetrics"; enabled = true }` form. AzureRM provider warns this will be removed in v5.0. Currently advisory only.

#### Acceptance Criteria
- [ ] All 4 diagnostic-setting resources migrated from `metric { ... }` blocks to the `enabled_metric` property form
- [ ] `terraform validate` clean with no deprecation warnings on these resources
- [ ] Bundle any other azurerm v5 forward-compat lint warnings if they appear

#### Notes
Not blocking until you actually upgrade to azurerm v5. Could be deferred until just before that upgrade.

### #13 — [Phase 3+] pact-consumer-driven-contracts

#### Context
#2 chose Schemathesis (property-based fuzz against the OpenAPI spec) for current contract testing because Pact requires consumer participation and no consumers exist yet. Add Pact when real consumer code exists (React Native in Phase 3, React web sometime after).

#### Acceptance Criteria
- [ ] Pact consumer-side setup in `apps/mobile` (and `apps/web` if it's consuming the API by then)
- [ ] Pact provider-side verification in `apps/api`
- [ ] Pact broker hosting decision (PactFlow free tier vs. self-host)
- [ ] CI runs both Schemathesis and Pact verification — they're complementary, not exclusive (Schemathesis = spec vs impl; Pact = impl vs consumer expectations)

#### Notes
Schemathesis stays — Pact layers on top, doesn't replace.

### #14 — [Phase 2] api-signalr-cook-events

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

## Done (recent)

- 2026-05-26 closed #1 — infra-azure-services-config (commit `8b0cc8c`)
- 2026-05-26 closed #2 — lib-api-specs (commit `0610095`)
- 2026-05-26 closed #3 — lib-data-models-tests (commit `7115aea`)
- 2026-05-26 closed #4 — device-controller-integration (commit `1f03708`)
- 2026-05-26 closed #5 — data-pusher-implementation (commit `5d7e111`)
- 2026-05-26 closed #8 — workspace-eslint-config-fix (commit `8b688a2`)

# MeatGeek V2 Backlog

## Notes for next session

### Wave 1 of Phase 1 landed (2026-05-26)

Tickets #1, #2, #3, #4 complete. Wave 2 (#5 data-pusher) is the next thing to launch — depends on #1's IoT Hub routing being live (it is). Wave 3 (#6 otel-integration) depends on #1, #4, #5.

**Workspace blocker (filed as #8, do this FIRST):**
Every `nx` command fails to load the project graph because `.eslintrc.json` (root + `libs/api-specs/`) uses the legacy `extends: ['@typescript-eslint/recommended']` shortcut that typescript-eslint v7.18+ dropped. Engineers in Wave 1 worked around by direct `jest` / `make` invocation, but this blocks any real `nx`-driven workflow. ~5 minute fix; prioritize before Wave 2 if you want a clean engineer experience.

**Security finding (manual stakeholder action required):**
NewRelic license key `***REMOVED***` was in `apps/device-controller/main.go:43` — redacted in commit `96f1fa1`, fully removed in commit `1f03708` (ticket #4). Still in git history. **Rotate the key on the NewRelic side** to invalidate the leaked credential.

**Architecture artifacts (read for deep context on the o11y stack decisions):**
- Synthesis: `~/.forge/runs/run-o11y-architecture-synthesis-668aa7/`
- Backend APM research: `~/.forge/runs/run-o11y-research-backend-apm-c5c89b/`
- Frontend RUM research: `~/.forge/runs/run-o11y-research-frontend-rum-2b7b18/`
- Analytics/flags research: `~/.forge/runs/run-o11y-research-product-analytics-flags-51845e/`

## Active

### #5 — data-pusher-implementation

#### Context
`apps/data-pusher` has the structure (`cmd/main.go`, `internal/{collector, iothub, telemetry}`) but `iothub/client.go` is a stub — `PublishTelemetry` is a TODO that no-ops. Cook session state, temperature enrichment, local buffering, and SignalR client are not yet implemented. With #4's close-out decision, data-pusher is also the boundary where `@meatgeekv2/api-interfaces` types enter the Go side (V1→V2 translation lives here, not in device-controller).

#### Acceptance Criteria
- [ ] Real Azure IoT Hub publishing in `internal/iothub/client.go` (MQTT or AMQP via Azure Go SDK)
- [ ] Cook session management: in-memory active `cookId`, recovery on restart
- [ ] Temperature enrichment: every outbound telemetry message carries `cookId`, `device.id`, `correlation.id`
- [ ] V1 device-controller JSON → V2 `DeviceStatus` / `TemperatureReading` / `DeviceTelemetryBatch` translation against `@meatgeekv2/api-interfaces` (via Go codegen from #2 OpenAPI specs, or hand-written struct mapping — decision in tech-lead)
- [ ] Local buffering for offline scenarios (disk-backed queue, replay on reconnect)
- [ ] SignalR client for receiving cook start/stop notifications from backend
- [ ] systemd service configuration for Raspberry Pi deployment
- [ ] `nx build-arm data-pusher` (or `make build-arm` if eslint workspace bug is still present) produces working ARM64 binary
- [ ] End-to-end smoke test: data-pusher → IoT Hub → CosmosDB (storage path) and → Functions (real-time path) both visible in Azure Portal
- [ ] Mock IoT Hub client preserved for dev

#### Dependencies
- Depends on: #1 (✅ complete — IoT Hub routing + CosmosDB endpoint live)
- Unblocks: #6 (OTel instruments the working data path)

#### Notes
The `correlation.id` IoT Hub message-property contract is defined in #6 — implement against that contract.

### #6 — otel-integration

#### Context
Cross-cutting observability work landing the OTel discipline + Sentry architecture decisions from the synthesis. Includes amending `docs/monitoring/observability.md` to reflect the OTel-with-two-exemptions discipline. Sentry architecture-establishment happens here (free tier, $0); Sentry implementation is Phase 3 ticket #7. Also wires the 5 alerts deferred from #1.

#### Acceptance Criteria — OTel instrumentation
- [ ] Go device-controller: OTel Go SDK + Azure Monitor exporter (NewRelic was removed in #4 ✅)
- [ ] Go data-pusher: OTel Go SDK + Azure Monitor exporter
- [ ] TS Azure Functions API: `@azure/monitor-opentelemetry` distribution
- [ ] Connection strings + endpoints via env vars only (no hardcoded values)
- [ ] AlwaysSample on Go side (volume too small to undersample); 50% sampling on Functions (configured in #1 ✅)

#### Acceptance Criteria — Trace propagation
- [ ] W3C Trace Context propagation across device-controller → data-pusher → IoT Hub → Functions → CosmosDB → SignalR
- [ ] `correlation.id` rides as IoT Hub message property on send (data-pusher) and is restored to span dimension on receive (Function)
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
- Depends on: #1 (✅), #4 (✅), #5 (in flight)
- Unblocks: Phase 3 #7 depends on Sentry architecture established here

### #7 — [Phase 3] mobile-sentry-integration

#### Context
Phase 3 implementation work — DO NOT start before Phase 1 #6 lands and the mobile app exists. Filed now to lock scope. Architecture is established in Phase 1 ticket #6. This ticket wires the Sentry RN SDK into the mobile app once it exists.

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

### #8 — workspace-eslint-config-fix

#### Context
Surfaced by Wave 1 engineers (#4, #3, #2 all hit it; worked around with direct `jest` / `make`). Every `nx` command fails to load the project graph with `Failed to load config "@typescript-eslint/recommended" to extend from`. Root cause: `.eslintrc.json` files use the legacy bare-name shortcut that typescript-eslint v7.18+ dropped.

#### Acceptance Criteria
- [ ] `extends: ['@typescript-eslint/recommended']` → `extends: ['plugin:@typescript-eslint/recommended']` in:
  - `/Users/stevebargelt/code/meatgeekv2/.eslintrc.json`
  - `/Users/stevebargelt/code/meatgeekv2/libs/api-specs/.eslintrc.json`
  - Any other `.eslintrc.json` files in the tree with the same legacy extends
- [ ] `nx graph` and at least one `nx test <project>` succeed (proves project graph loads + a target runs)
- [ ] Search every `.eslintrc.json` for similar legacy bare-name `extends` entries; convert systematically

#### Notes
~5 minute fix. Should be done before further Wave 2/3 pipeline work so engineers don't all have to work around it.

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

#### Notes
Wait for #3 to land (it has — commit `7115aea`); start from the `// BUG:` comments in the spec files for the inventory.

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
- [ ] `nx build data-pusher` and `nx build-arm data-pusher` both pass (assumes #8 has landed)

#### Notes
Coordinate with #5 — if #5 is in flight, defer this until #5 lands to avoid merge churn.

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

## Done (recent)

- 2026-05-26 closed #1 — infra-azure-services-config (commit `8b0cc8c`)
- 2026-05-26 closed #2 — lib-api-specs (commit `0610095`)
- 2026-05-26 closed #3 — lib-data-models-tests (commit `7115aea`)
- 2026-05-26 closed #4 — device-controller-integration (commit `1f03708`)

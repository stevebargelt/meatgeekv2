---
id: MG-7
type: story
status: active
title: "[Phase 3] mobile-sentry-integration"
---

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
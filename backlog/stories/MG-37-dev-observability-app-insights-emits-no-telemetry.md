---
id: MG-37
type: story
status: active
title: "dev observability: App Insights emits no telemetry from the Flex FA despite correct AAD-ingestion wiring"
created: 2026-07-23
---

Found during MG-21's dev publish + auth smoke (2026-07-23). The Flex dev Function App (meatgeek-v2-dev-func-259d4bf5b628) serves authenticated requests correctly (getDevices returns HTTP 200 + real body), but NO telemetry appears in App Insights (requests/traces empty after 15+ min) NOR in Log Analytics FunctionAppLogs NOR the live log stream. WIRING IS CORRECT: FA system-assigned MI holds Monitoring Metrics Publisher on the App Insights resource; APPLICATIONINSIGHTS_CONNECTION_STRING present (surfaced from the Flex native site_config field); APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD; local_authentication_enabled=false on AI. So config is not the gap. Investigate the RUNTIME telemetry path: the app uses @azure/monitor-opentelemetry — verify it is initialized in apps/api (an explicit useAzureMonitor()/startup call is required; auto-collection may not fire without it), and that AAD-token ingestion resolves at runtime on Flex. Relates to MG-6 (otel-integration). Impact: observability only — the app + auth work; this does not block app deploy. NOTE: this is also why MG-21's 'matching invocation log' evidence item could not be captured from telemetry (the HTTP 200 + response body is the execution proof instead).
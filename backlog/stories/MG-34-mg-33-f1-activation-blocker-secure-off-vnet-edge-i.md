---
id: MG-34
type: story
status: active
title: "MG-33 F1 activation blocker: secure off-VNet edge ingress + live Go-span-to-App-Insights proof"
created: 2026-07-22
---

BLOCKS MG-33 closure (operator directive, 2026-07-22). The native-OTLP OUTBOUND path (collector→DCE/DCR→App Insights via azure_auth managed identity) is authored under MG-33 default-off with NO public collector ingress. Before MG-33 can close, this ticket must resolve:

AC1 — Secure edge ingress: the Go edge services run on Raspberry Pis OFF Azure's VNet. Define + implement a secure device→collector ingress (mTLS, header/bearer token at an auth-terminating proxy, or private-link/tunnel). NO public unauthenticated OTLP listener. This is a dev/live-proof dependency, NOT merely MG-25 production scope.
AC2 — Live Go-span-to-Azure proof (MG-24/MG-25-gated): a real span emitted by device-controller/data-pusher over OTLP → deployed collector → otlphttp/azure_auth(MI) → DCE/DCR → appears queryable in App Insights (AppDependencies/AppTraces) carrying the expected per-reading W3C traceparent (MG-33 F2/F3).
AC3 — Negative check: with the collector's Monitoring-Metrics-Publisher-on-DCR role assignment removed, ingestion is REJECTED (proves Entra/RBAC enforcement, not a silent residual local path).

Depends on MG-24 (Container Apps env) + MG-25 (native-OTLP preview acceptance in the target region).
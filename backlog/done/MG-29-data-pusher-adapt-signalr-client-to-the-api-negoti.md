---
id: MG-29
type: story
status: done
title: "data-pusher: adapt SignalR client to the API negotiate handshake protocol (MG-14 DEC-1, resolve at AC5 live-smoke)"
created: 2026-07-21
closed: 2026-11-20
closed_commit: f29d094
---

## Closure

**Obsolete.** On 2026-11-19 the owner decided that cook state reaches the Pi as IoT Hub device twin desired properties, not over SignalR. HAR-58 (#92, `ef18023`) therefore deleted the Pi's SignalR client instead of adapting it to negotiate. It also removed the startup REST reconcile, which never worked: `GET /cooks` answers 401 to the Pi, which has no user credential. The twin GET the Pi makes on every connect is now the authoritative reconcile.

Live evidence is Deploy Dev App run **44747912598** (main `f29d094`, 2026-11-20, green).

| Acceptance criterion | Status (met / obsolete) | Evidence |
| --- | --- | --- |
| data-pusher's SignalR client adapted to the API negotiate handshake (the title) | obsolete | HAR-58 #92 (`ef18023`) removed `internal/signalr`, `cooksession/reconcile.go`, `--signalr-hub-url` and `--api-base-url`; on main `f29d094`, `grep -rni signalr apps/data-pusher` returns nothing (exit 1). Replacement, run 44747912598: `PASS device twin › simdevice --twin --count 1 reconnects: the twin carries the cook and the device reports it applied`, `METRIC twin-apply-ms 356`, `PASS device twin › simdevice --twin --count 0 reconnects: the twin has no cook and the device reports it applied` |

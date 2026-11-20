---
id: MG-31
type: story
status: done
title: "api-signalr: cook_stopped payload carries placeholder name/startTime (no persistence) — persist real Cook or minimize the CookStoppedMessage payload contract (MG-14 DEC-3 follow-up)"
created: 2026-07-21
closed: 2026-11-20
closed_commit: f29d094
---

## Closure

**Completed** earlier by HAR-26 (#71, `d91960a`) and confirmed under goal HAR-55: stop-cook reads the persisted cook, completes it, and builds the `cook_stopped` envelope (deviceId and payload, including `name` and `startTime`) from the stored document, not from placeholders or the request (`apps/api/src/functions/cooks/stop-cook.ts`, the "MG-31" comment above the envelope).

| Acceptance criterion | Status (met / obsolete) | Evidence |
| --- | --- | --- |
| `cook_stopped` carries the real persisted cook's name and startTime, not placeholders (the title) | met | HAR-26 #71 (`d91960a`); `apps/api/src/functions/cooks/stop-cook.ts` builds the envelope from the persisted cook; `apps/api/src/functions/cooks/stop-cook.spec.ts` › `MG-31 — cook_stopped carries the persisted cook` › `emits the stored name and startTime, which appear nowhere in the request`. Live: run 44747912598 (main `f29d094`) `PASS signalr isolation › POST /cooks/{cookId}/stop stops it, cook_stopped reaches the owner, and the peer has received nothing` |

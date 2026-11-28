# Domain session: code reconciliation list

Ticketed 2026-11-27. Order: #237 finishes (#250–#252), then #288 prune, then renames #289 → #290 → #291 → #292, then spec #293 (slices #294–#299). #286 runs in parallel. Parked: #301, #302.

1. [#289] "grill" → Smoker Probe across contract and code: `grillTemp`, `TargetTemperatures.grill`, LCD text, LikeC4 "physical grill". Breaking contract change (web, iOS, device).
2. [#290] `probe1Temp`–`probe4Temp` / `probe1`–`probe4` → Food Probe naming.
3. [#291] `CookChartChannel` and "channel" in chart code and docs → Probe Line.
4. [#288] `CookStatus`: drop `paused`; `planning` → Planned (later feature, not built).
5. [#286] Retention (decided): per-Reading TTL. Readings with no Cook expire in 24h; Cook Readings expire in 7 days in every environment; chart rollups kept forever (already true). Today: one container default for all Readings, 7 days in dev and 90 in prod. See docs/adr/0001.
6. [#292] People terms: User and Owner (glossary). Replace Pitmaster in LikeC4 and docs.
7. [#301 (parked)] Factory reset on the Device releases it (recovery for a Device whose Owner is gone). Not built: today a claimed Device can only be released by its Owner.
8. [#301 (parked)] An Owner sees only Readings taken after their Claim. Today device history shows any unexpired Reading, including a previous Owner's.
9. [#301 (parked)] Watcher: invited per Cook, read-only, sees nothing else on the Device. Not built.
10. [#288] Drop `Cook.isPublic` (conflicts with invite-only Watchers).
11. [#294] Several kinds of meat per Cook: `Cook.meatType`/`weight` are single values; meat should be per Food Probe.
12. [#302 (parked)] Cook started from a Recipe copies it (no live link). Today Cook and Recipe are unlinked; StartCookRequest takes no recipe.
13. [#289 (keep)] `RecipeCookMethod` keeps `grill` (grilling on a Smoker is fine); grill is banned only as a name for the hardware or the Smoker Probe.
14. [#294, #295] `TargetTemperatures` (one value per probe slot, on Cook and Recipe) → a Smoker Target that changes over the Cook, plus per-Cut Milestones (several per Cut). Same for `maxTemps`. Reaching a Milestone prompts the Owner; it does not change anything by itself.
15. [#302 (parked)] Rest: optional end of a Cook with probes still in; Cook stays Active. Not built.
16. [#302 (parked)] Later, not designed: time-based actions (rest 1 hour, spritz every 45 min); who decides a Smoker Target change when Cuts disagree.
17. [#288 (dead flags), #296–#298] Alarms, Milestones, Notifications (none built). Replace `TemperatureAlert` (fixed thresholds per probe slot; `target_reached` overlaps Milestone) and `Device.configuration.alertSettings` (fixed high/low per Device) with: Smoker Range per Cook (default per Owner, can come from a Recipe), moving with the Smoker Target; Alarms Food Probe Lost and Device Silent; Alarms only during an Active Cook, repeat until acknowledged, ignore quiet hours. `NotificationPreferences` → Notification settings: Owner gets every Milestone and Alarm even in quiet hours; quiet hours hold back only Watcher Milestones; Watchers can opt in to Milestones, never Alarms. Drop `weeklyReports`/`productUpdates`/`cookComplete`/`deviceOffline` flags or remap them to these terms.
18. [#292] Ops vocabulary: Azure Monitor "alerts" (cap emails etc.) stay as ops terms; never call a domain Alarm an "alert" in code or UI.
19. [#297] Device states Live / Online / Offline. Today: Devices list shows IoT Hub `connected`/`disconnected`/`unknown` + "last heard" (hub activity, lags minutes); live panel shows `waiting`/`live`/`stale` (Reading age). Unify: Live = latest Reading within ~3x reading interval; Online = connected, not Live; Offline = not connected. Show "last Reading <age> ago", not "last heard". `waiting` and `stale` go away. App's own SignalR reconnecting badge stays UI-only.
20. [#288] Remove V1 smoker-control fields from the Device status (`augerOn`, `blowerOn`, `igniterOn`, `fireHealthy`, `mode`, `setPoint`, `modeTime`; device-controller sends fixed placeholders today). MeatGeek does not control the Smoker.
21. [#288 (dead code), #302 (feature, parked)] Calibration per Port, set by the Owner, delivered to the Device (like the active Cook, via the twin), applied on the Device before a Reading is sent. Replaces hard-coded `tempCorrection` values in `apps/device-controller/main.go:123` and the unused `Device.configuration.*Correction` fields; delete unused `ProbeCorrections` / temperature-calculator correction code in libs/data-models. Rename correction → Calibration.
22. [#289, #290] Port naming: Smoker Port, Food Ports 1–4. Readings, targets and chart lines keyed by `probe1`–`probe4` → Food Port numbers (ties into items 1–2).
23. [#302 (parked)] Log Entries (timed notes during an Active Cook, with photos; auto-written when the Owner acts on a Milestone) and Review (rating + notes per Cook, optional line per Cut, editable any time). Replace unused `rating`, `photos`, `notes`-at-start-only, `UpdateCookRequest`. No route updates a Cook today.
24. [#288] Drop `actualDuration` (derived), `CookSummary` averages per probe slot and `fuelEfficiency`; keep Smoker Stability (share of Cook inside Smoker Range).
25. [#288] Park (not domain yet): `Achievement`, `UserActivity`. Delete the unused types or leave them out of the contract.

# Live Acceptance Suite

> The live suites are the one place a test may wait on real time. Every other
> test follows [Deterministic tests](deterministic-tests.md): it waits on the
> event, a fake clock or a no-deadline poll, and `tools/no-real-time` fails one
> that does not. Each live wait has a row in [Real-time waits](#real-time-waits).

The live acceptance suite proves the **deployed** API works: it calls the real
Function App over HTTPS, as a real Entra-authenticated caller, writes data
through it, and reads it back. It replaces hand-run "live dev proofs" in
tickets.

It runs automatically after each dev deploy of the API: the `acceptance` job in
`.github/workflows/app-deploy-dev.yml` (see
[CI/CD → Dev app deploy and live acceptance](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)).
A ticket whose behaviour is visible through the API can state its acceptance
criterion as **"the acceptance run on the merge commit is green"**, backed by a
proof the ticket adds. You can also run it by hand, as below.

## What it checks today

Every proof below also checks each response against the OpenAPI contract,
`libs/api-specs/spec/openapi.yaml` (HAR-77). See
[Contract validation](#contract-validation).

| Proof file                          | Proof                                                                                                                                                                                                                                            | Expects                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acceptance-device-sweep.proof.ts`  | `GET /devices`; per `acceptance-*` device but the simulated and chart ones: stop its active cooks (HAR-136), `DELETE /devices/{id}`, then `delete-device.sh --device-id <id> --only-prefix acceptance-` (HAR-140); `GET /devices` again (HAR-85) | `200`, `204` and a `delete-device.sh` exit `0` per device (`deleted <id>`, or `already deleted <id>` for one with no enrollment), then `200` with no `acceptance-*` device listed; prints `METRIC acceptance-devices-before`, `acceptance-devices-swept` and `acceptance-devices-after`                                                                                                                |
| `cooks-unauthenticated.proof.ts`    | `GET /cooks` with no `Authorization` header                                                                                                                                                                                                      | `401`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cooks-lifecycle.proof.ts`          | a fresh device, `acceptance-cook-<runId>`: `simdevice identity init`, `enrol-device.sh`, `simdevice --twin --count 0 --timeout 2m` (HAR-140, see [Fresh devices](#fresh-devices-har-140))                                                        | each exits `0`; `enrol-device.sh` prints `enrolled <id>`                                                                                                                                                                                                                                                                                                                                               |
|                                     | `simdevice --twin --count 0`, `simdevice claim-code`, then `POST /devices/claim` with the code it shows and a run-unique name                                                                                                                    | the code is `unclaimed`; `201` with a request charge; the device id is the one sent                                                                                                                                                                                                                                                                                                                    |
|                                     | `POST /cooks` with a new UUID `id` on `acceptance-cook-<runId>`                                                                                                                                                                                  | `2xx`; body is an api-interfaces `Cook` with no Cosmos system property (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`), status `active`                                                                                                                                                                                                                                                              |
|                                     | `GET /cooks/{cookId}` for the new cook (HAR-75)                                                                                                                                                                                                  | `200`; `id`, `deviceId` and `status` equal the `POST` response                                                                                                                                                                                                                                                                                                                                         |
|                                     | the same as the peer                                                                                                                                                                                                                             | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                          |
|                                     | `GET /cooks/{cookId}` for a new random UUID                                                                                                                                                                                                      | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                          |
|                                     | `GET /cooks/active-device:<device>` (the device lock, in the owner's partition while the cook runs)                                                                                                                                              | `404` with `error: NOT_FOUND`: a lock is not a cook                                                                                                                                                                                                                                                                                                                                                    |
|                                     | `GET /cooks/{cookId}/chart` for the new cook (HAR-86)                                                                                                                                                                                            | `200`; the body matches `CookChart` (the contract check), and `cookId`, `deviceId` and `startTime` are the cook's. `points` may be empty and is not checked                                                                                                                                                                                                                                            |
|                                     | `GET /cooks/{cookId}/chart` for a new random UUID                                                                                                                                                                                                | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                          |
|                                     | `GET /cooks/{cookId}/chart` for the new cook as the peer                                                                                                                                                                                         | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                          |
|                                     | `GET /cooks`                                                                                                                                                                                                                                     | the new cook is listed (pages via `continuationToken`)                                                                                                                                                                                                                                                                                                                                                 |
|                                     | `GET /cooks?deviceId=<device>&status=active`                                                                                                                                                                                                     | `200`; returns exactly the new cook, `active`, on that device, in one page                                                                                                                                                                                                                                                                                                                             |
|                                     | `POST /cooks/{cookId}/stop`                                                                                                                                                                                                                      | `2xx`; the cook is `completed` with an `endTime`                                                                                                                                                                                                                                                                                                                                                       |
|                                     | `GET /cooks/{cookId}`                                                                                                                                                                                                                            | `200`; `status: completed` with an `endTime`                                                                                                                                                                                                                                                                                                                                                           |
|                                     | `GET /cooks`                                                                                                                                                                                                                                     | the cook reads back `completed`                                                                                                                                                                                                                                                                                                                                                                        |
|                                     | `GET /cooks?deviceId=<device>&status=active`                                                                                                                                                                                                     | `200`; returns no cook after the stop                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `POST /cooks` on the unregistered `acceptance-unowned-<runId>`                                                                                                                                                                                   | `403`; `error` is `DEVICE_NOT_OWNED`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `GET /cooks?deviceId=acceptance-unowned-<runId>`                                                                                                                                                                                                 | `200`; returns no cook (the refused start wrote nothing)                                                                                                                                                                                                                                                                                                                                               |
|                                     | always, even after a failed step: stop any cook active on `acceptance-cook-<runId>`, `DELETE /devices/{id}` for it, `delete-device.sh --device-id <id> --only-prefix acceptance-`, remove its state dir (HAR-85, HAR-136, HAR-140)               | `204` (`204` or `404` if the claim's `201` never came back); `delete-device.sh` exits `0`                                                                                                                                                                                                                                                                                                              |
| `device-claim.proof.ts`             | a fresh device, `acceptance-claim-<runId>`, enrolled as in `cooks-lifecycle.proof.ts`, then a twin sync and `simdevice claim-code` (HAR-142)                                                                                                     | each step exits `0`; the code shows `unclaimed`                                                                                                                                                                                                                                                                                                                                                        |
|                                     | `POST /devices/claim` for `acceptance-guess-<runId>` (never enrolled) with a random well-formed code                                                                                                                                             | `403` `CLAIM_REFUSED`; every refusal in this table is checked the same way: no request-charge header, a body of exactly `error`, `message`, `requestId` in that order, `CLAIM_REFUSED` and the one fixed message, so each is the same bytes apart from `requestId` (no oracle)                                                                                                                         |
|                                     | the same for `acceptance-claim-<runId>` with a random well-formed code that is not its own                                                                                                                                                       | `403`, the same body                                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | the same with its own code, one symbol changed to the next in the alphabet                                                                                                                                                                       | `403`, the same body                                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | the same with its own code                                                                                                                                                                                                                       | `201` with `claimedAt`: the refusals did not burn the code                                                                                                                                                                                                                                                                                                                                             |
|                                     | `GET /devices/{id}` as the owner                                                                                                                                                                                                                 | `200`, the owner's `userId`, the claim's `claimedAt`                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `POST /devices/claim` again with the same code                                                                                                                                                                                                   | `200`, `claimedAt` unchanged                                                                                                                                                                                                                                                                                                                                                                           |
|                                     | as the peer: `POST /devices/claim` with the consumed code, then with a random well-formed code, then `GET /devices/{id}`                                                                                                                         | `403`, `403` (the same body), `404`                                                                                                                                                                                                                                                                                                                                                                    |
|                                     | always, even after a failed step: release it, `delete-device.sh`, remove its state dir                                                                                                                                                           | as `devices.proof.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| `device-release.proof.ts`           | two fresh devices, `acceptance-release-<runId>` and `acceptance-control-<runId>` (the control), enrolled and claimed by the owner with their own codes (HAR-142)                                                                                 | `201` each                                                                                                                                                                                                                                                                                                                                                                                             |
|                                     | `POST /negotiate`, then a SignalR client listening on `temperature` connects                                                                                                                                                                     | `200`, then `Connected`                                                                                                                                                                                                                                                                                                                                                                                |
|                                     | `simdevice --count 1` as the released device                                                                                                                                                                                                     | its reading arrives on `temperature` within 90 s                                                                                                                                                                                                                                                                                                                                                       |
|                                     | `DELETE /devices/{id}` for it, then `GET /temperatures/current/{id}` as the old owner                                                                                                                                                            | `204`, then `404` `DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `simdevice --count 1` as the released device, then as the control                                                                                                                                                                                | the control's reading arrives within 90 s; then for 15 s more no message for the released device but its first reading. The control shows the path to the owner works; the window is there because Event Hub orders readings per device, not across devices                                                                                                                                            |
|                                     | the connection stops                                                                                                                                                                                                                             | `Disconnected`                                                                                                                                                                                                                                                                                                                                                                                         |
|                                     | `POST /devices/claim` with the code it was claimed with before the release                                                                                                                                                                       | `403` `CLAIM_REFUSED`, the same refusal checks                                                                                                                                                                                                                                                                                                                                                         |
|                                     | a twin sync and `simdevice claim-code`, then `POST /devices/claim` as the peer with the new code; `GET /devices/{id}` as the peer, then as the owner                                                                                             | a code other than the first; `201` with a `userId` that is not the old owner's; `200`; `404`                                                                                                                                                                                                                                                                                                           |
|                                     | `DELETE /devices/{id}` as the peer                                                                                                                                                                                                               | `204`                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | always, even after a failed step: each device is released by whoever holds it, `delete-device.sh`, its state dir removed                                                                                                                         | as `devices.proof.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| `device-revoke.proof.ts`            | a fresh device, `acceptance-revoke-<runId>`, enrolled and claimed by the owner (HAR-142)                                                                                                                                                         | `201`                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `revoke-device.sh --device-id <id>` (HAR-135; the runner adds `--auth-type login` and the host names)                                                                                                                                            | exit `0`, `revoked <id>`                                                                                                                                                                                                                                                                                                                                                                               |
|                                     | `simdevice --count 1` as it, with its cached hub assignment                                                                                                                                                                                      | a non-zero exit before the runner's 120 s kill, no reading printed, and a last stderr line (simdevice's own failure line) that names a refusal: the hub refuses the disabled identity, the device registers again, and DPS refuses the disabled enrollment                                                                                                                                             |
|                                     | `revoke-device.sh` again                                                                                                                                                                                                                         | exit `0`, `already revoked <id>`                                                                                                                                                                                                                                                                                                                                                                       |
|                                     | always, even after a failed step: release it, `delete-device.sh`, remove its state dir                                                                                                                                                           | as `devices.proof.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| `device-twin.proof.ts`              | `POST /devices/claim` for the simulated device with its own claim code (HAR-140), as `telemetry-roundtrip.proof.ts` does                                                                                                                         | `200` or `201`; see [The standing devices are claimed once per run](#the-standing-devices-are-claimed-once-per-run-har-140)                                                                                                                                                                                                                                                                            |
|                                     | `GET /cooks?deviceId=<simulated device>&status=active`, and `POST /cooks/{cookId}/stop` for each cook listed                                                                                                                                     | `200`, then `200` per stop (an earlier run's cook is cleared, so the device lock is free)                                                                                                                                                                                                                                                                                                              |
|                                     | `POST /cooks` with a new UUID `id` on the simulated device and `X-Request-ID: acceptance-twin-<runId>`                                                                                                                                           | `201`, status `active`. A `503 DEVICE_TWIN_UPDATE_FAILED` fails, printing its fixed `reason`                                                                                                                                                                                                                                                                                                           |
|                                     | `simdevice --twin --count 1 --timeout 60s` (a reconnect: simdevice was not connected when the cook started)                                                                                                                                      | exit `0`; the `{"event":"twin"}` line, then one reading line. `desired.activeCookId` and `reported.activeCookId` are the new cook; `desired.correlationId` and `reported.correlationId` are `acceptance-twin-<runId>`; `reported.appliedDesiredVersion` is `desired.$version`. Prints `METRIC twin-apply-ms`                                                                                           |
|                                     | the same twin line (HAR-152)                                                                                                                                                                                                                     | its `applyLagMs`, the device's own measure from the start's desired `cookUpdatedAt` to its GET, is a non-negative integer; the PASS line ends `— applyLagMs <n>`. Prints `METRIC twin-device-apply-lag-ms`                                                                                                                                                                                             |
|                                     | poll `GET /temperatures/current/<simulated device>` every 2 s, up to 90 s, for the reading just sent (matched by `timestamp`, as an instant)                                                                                                     | it arrives, and its `cookId` is the new cook                                                                                                                                                                                                                                                                                                                                                           |
|                                     | `POST /cooks/{cookId}/stop`                                                                                                                                                                                                                      | `200`; the cook is `completed`                                                                                                                                                                                                                                                                                                                                                                         |
|                                     | `simdevice --twin --count 0 --timeout 60s`                                                                                                                                                                                                       | exit `0`; `desired.activeCookId` absent or `null`, `reported.activeCookId` `null`, `reported.appliedDesiredVersion` is `desired.$version`, which is later than the start's                                                                                                                                                                                                                             |
|                                     | always, even after a failed step: `GET /cooks?deviceId=<simulated device>&status=active`, and `POST /cooks/{cookId}/stop` for each cook listed                                                                                                   | `200`, then `200` per stop: no cook is left active on the simulated device                                                                                                                                                                                                                                                                                                                             |
| `devices.proof.ts`                  | `POST /devices` (HAR-145: removed) outside the contract, with a body the old route took, for the never-enrolled `acceptance-firstcome-<runId>`; then `GET /devices/{id}` for that id                                                             | `404` or `405`, never `2xx`, and the PASS line names which; the `GET` is `404`: no device was made                                                                                                                                                                                                                                                                                                     |
|                                     | a fresh device, `acceptance-device-<runId>`, enrolled as in `cooks-lifecycle.proof.ts` (HAR-140)                                                                                                                                                 | each step exits `0`; `enrolled <id>`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `enrol-device.sh` again for `acceptance-device-<runId>` with the same certificate (HAR-149: re-running onboarding on a set-up Pi)                                                                                                                | exit `0` and `unchanged <id>`, which the PASS line quotes; nothing written to DPS                                                                                                                                                                                                                                                                                                                      |
|                                     | `POST /devices/claim` with the code the device shows (after a twin sync) and a run-unique name                                                                                                                                                   | `201` with a request charge; body is an api-interfaces `Device` with the id and name sent, `isActive: true`, and no `connectionStatus` or `connection` (HAR-143)                                                                                                                                                                                                                                       |
|                                     | `GET /devices/{id}` for the registered device                                                                                                                                                                                                    | `200`; the same device, owned by the claiming caller, with a `connection` (`state` and `lastActivityAt`, HAR-143)                                                                                                                                                                                                                                                                                      |
|                                     | `GET /devices/{id}` once, right after the claim (HAR-143)                                                                                                                                                                                        | `200`; `connection.lastActivityAt` set and not before the proof's start less 5 min of clock skew: the device reported its claim code to its twin before the claim, and the API counts the device's last reported-properties write (`properties.reported.$metadata.$lastUpdated`) as well as the hub's `lastActivityTime`; `state` `connected` or `disconnected` (simdevice disconnects after each run) |
|                                     | `GET /devices`                                                                                                                                                                                                                                   | `200`; the device is listed, and every listed device has the caller as owner and a `connection` (HAR-143)                                                                                                                                                                                                                                                                                              |
|                                     | `PATCH /devices/{id}` with a new `location`                                                                                                                                                                                                      | `200`; the device carries the new location                                                                                                                                                                                                                                                                                                                                                             |
|                                     | `GET /devices/{id}` for the registered device                                                                                                                                                                                                    | `200`; the patched location reads back                                                                                                                                                                                                                                                                                                                                                                 |
|                                     | `GET /devices/<random uuid>`                                                                                                                                                                                                                     | `404`                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `DELETE /devices/{id}` for `acceptance-device-<runId>` as the peer, then `GET /devices/{id}` as the owner (HAR-85)                                                                                                                               | `403` with `error: DEVICE_NOT_OWNED`, then `200`: the device is still the owner's                                                                                                                                                                                                                                                                                                                      |
|                                     | `DELETE /devices/{id}` for `acceptance-device-<runId>`                                                                                                                                                                                           | `204`                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `GET /devices/{id}` for it                                                                                                                                                                                                                       | `404`                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `DELETE /devices/{id}` for it again                                                                                                                                                                                                              | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | always, even after a failed step: `DELETE /devices/{id}` for `acceptance-device-<runId>` unless the `204` above came back, then `delete-device.sh --device-id <id> --only-prefix acceptance-` and remove its state dir (HAR-140)                 | `204` (`204` or `404` if the claim's `201` never came back); `delete-device.sh` exits `0`                                                                                                                                                                                                                                                                                                              |
| `recipes.proof.ts`                  | `POST /recipes` named `Acceptance recipe <runId>`, `meatType: pork`                                                                                                                                                                              | `201`; body is an api-interfaces `Recipe` with the name sent, a server-generated UUID `id`, and `createdAt` equal to `updatedAt`                                                                                                                                                                                                                                                                       |
|                                     | `GET /recipes/{id}` for the new recipe                                                                                                                                                                                                           | `200`; the same recipe, owned by the creating caller                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `GET /recipes`                                                                                                                                                                                                                                   | `200`; the recipe is listed, and every listed recipe has the caller as owner                                                                                                                                                                                                                                                                                                                           |
|                                     | `PATCH /recipes/{id}` with a new `description`                                                                                                                                                                                                   | `200`; the recipe carries the new description; `createdAt` is unchanged                                                                                                                                                                                                                                                                                                                                |
|                                     | `GET /recipes/{id}` for the new recipe                                                                                                                                                                                                           | `200`; the patched description reads back                                                                                                                                                                                                                                                                                                                                                              |
|                                     | `DELETE /recipes/{id}` for the new recipe                                                                                                                                                                                                        | `204`                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `GET /recipes/{id}` for the deleted recipe                                                                                                                                                                                                       | `404` with `error: RECIPE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                   |
| `signalr-isolation.proof.ts`        | `POST /devices/claim` for the simulated device with its own claim code (HAR-140), as `telemetry-roundtrip.proof.ts` does                                                                                                                         | `200` or `201`; see [The standing devices are claimed once per run](#the-standing-devices-are-claimed-once-per-run-har-140)                                                                                                                                                                                                                                                                            |
|                                     | `POST /negotiate` as the owner, then a client with handlers on `temperature`, `cook_started` and `cook_stopped`                                                                                                                                  | `200`; `start()` resolves within 30 s and the connection is `Connected`                                                                                                                                                                                                                                                                                                                                |
|                                     | `POST /negotiate?deviceId=<simulated device>` as the peer (the query must be ignored), then a client with the same handlers; every invocation it receives, on any target, is recorded                                                            | `200`; the peer's client connects                                                                                                                                                                                                                                                                                                                                                                      |
|                                     | `GET /temperatures/current/<simulated device>` as the peer                                                                                                                                                                                       | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `POST /cooks` with a new UUID `id` on the simulated device, as the peer                                                                                                                                                                          | `403` with `error: DEVICE_NOT_OWNED`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `simdevice --count 1`                                                                                                                                                                                                                            | exit `0` and exactly one JSON line on stdout, with a `timestamp` and `sentAt`                                                                                                                                                                                                                                                                                                                          |
|                                     | wait up to 90 s for the sent reading on the owner's `temperature` (matched as in 7a), then a further 15 s                                                                                                                                        | the owner receives it; the peer has received **no message at all**, else it fails naming each target and count                                                                                                                                                                                                                                                                                         |
|                                     | `GET /cooks?deviceId=<simulated device>&status=active` as the owner, and `POST /cooks/{cookId}/stop` for each cook listed                                                                                                                        | `200`, then `2xx` per stop (an earlier run's cook is cleared, twin sync included)                                                                                                                                                                                                                                                                                                                      |
|                                     | `POST /cooks` with a new UUID `id` on the simulated device, as the owner; wait up to 90 s for `cook_started` with that cook as `payload`                                                                                                         | `201`; `cook_started` reaches the owner; prints `METRIC signalr-cook-event-ms`                                                                                                                                                                                                                                                                                                                         |
|                                     | `POST /cooks/{cookId}/stop` as the owner; wait up to 90 s for `cook_stopped`, then a further 15 s                                                                                                                                                | `2xx`; `cook_stopped` reaches the owner; the peer has still received nothing; prints `METRIC isolation-peer-messages` (must be `0`)                                                                                                                                                                                                                                                                    |
|                                     | `stop()` on both connections                                                                                                                                                                                                                     | both are `Disconnected`. A failure at any earlier step stops both connections before it is reported                                                                                                                                                                                                                                                                                                    |
| `signalr-live-temperature.proof.ts` | `POST /devices/claim` for the simulated device with its own claim code (HAR-140), as `telemetry-roundtrip.proof.ts` does                                                                                                                         | `200` or `201`; see [The standing devices are claimed once per run](#the-standing-devices-are-claimed-once-per-run-har-140)                                                                                                                                                                                                                                                                            |
|                                     | `POST /negotiate` (after the registration), then a `@microsoft/signalr` client with a handler on target `temperature` opens the `url` with `accessTokenFactory`                                                                                  | `200`; `start()` resolves within 30 s and the connection is `Connected`                                                                                                                                                                                                                                                                                                                                |
|                                     | `simdevice --count 1` (one reading through IoT Hub, as the simulated device); the wall-clock time just before it starts is kept                                                                                                                  | exit `0` and exactly one JSON line on stdout, with a `timestamp` and `sentAt`                                                                                                                                                                                                                                                                                                                          |
|                                     | wait up to 90 s for a `temperature` message whose `deviceId` is the simulated device and whose `timestamp` is the sent one (other messages, e.g. replayed older readings, are ignored)                                                           | it arrives; the payload has a date `enqueuedTimeUtc` and no field besides `deviceId`, `timestamp`, `cookId`, `grillTemp`, `probe1Temp`…`probe4Temp` and `enqueuedTimeUtc`; prints `METRIC signalr-delivery-ms`                                                                                                                                                                                         |
|                                     | `stop()`                                                                                                                                                                                                                                         | the connection is `Disconnected`. A failure at any earlier step stops the connection before it is reported                                                                                                                                                                                                                                                                                             |
| `signalr-negotiate.proof.ts`        | `POST /negotiate`                                                                                                                                                                                                                                | `200`; body has an https `url` of the form `…/client/?hub=…` and a non-empty `accessToken`                                                                                                                                                                                                                                                                                                             |
|                                     | a `@microsoft/signalr` client opens the `url` with `accessTokenFactory` returning the `accessToken`, then stops                                                                                                                                  | `start()` resolves within 30 s and the connection is `Connected`; `stop()` leaves it `Disconnected`                                                                                                                                                                                                                                                                                                    |
| `temperatures.proof.ts`             | a fresh device, `acceptance-temp-<runId>`, enrolled as in `cooks-lifecycle.proof.ts`, then `POST /devices/claim` with its code and a run-unique name (HAR-140)                                                                                   | each step exits `0`; `201`                                                                                                                                                                                                                                                                                                                                                                             |
|                                     | `GET /temperatures/current/acceptance-temp-<runId>`                                                                                                                                                                                              | `404` with `error: NO_READINGS` (owned, but nothing has been routed for it)                                                                                                                                                                                                                                                                                                                            |
|                                     | `GET /temperatures/current/acceptance-temp-unowned-<runId>` (never registered)                                                                                                                                                                   | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | `GET /temperatures/history?deviceId=acceptance-temp-<runId>`                                                                                                                                                                                     | `200`; exactly `{ readings: [], limit: 100, hasMore: false }` (owned, nothing routed): no `continuationToken`, `total` or `offset`                                                                                                                                                                                                                                                                     |
|                                     | the same with `&offset=0`                                                                                                                                                                                                                        | `400` with `error: VALIDATION_ERROR` (HAR-75: history pages by continuation token only); no RU header                                                                                                                                                                                                                                                                                                  |
|                                     | `GET /temperatures/history?deviceId=acceptance-temp-unowned-<runId>`                                                                                                                                                                             | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                   |
|                                     | always, even after a failed step: `DELETE /devices/{id}` for `acceptance-temp-<runId>`, `delete-device.sh --device-id <id> --only-prefix acceptance-`, remove its state dir (HAR-85, HAR-140)                                                    | `204` (`204` or `404` if the claim's `201` never came back); `delete-device.sh` exits `0`                                                                                                                                                                                                                                                                                                              |
| `telemetry-roundtrip.proof.ts`      | `POST /devices/claim` for the simulated device (`ACCEPTANCE_SIM_DEVICE_ID`) as `Simulated smoker (acceptance)`, with its own claim code (HAR-140)                                                                                                | `201` the run's first claim when the owner did not hold it, `200` when it did and for each later group                                                                                                                                                                                                                                                                                                 |
|                                     | `simdevice --count 1` (one reading through IoT Hub, as the simulated device)                                                                                                                                                                     | exit `0` and exactly one JSON line on stdout, with a `timestamp` and `sentAt`                                                                                                                                                                                                                                                                                                                          |
|                                     | `GET /temperatures/current/<simulated device>`, every 1 s for at most 120 s                                                                                                                                                                      | a `200` whose `timestamp` is the sent one (`404 NO_READINGS` or an older reading: poll again); `deviceId` is the device, `grillTemp` a number, no `_` key; prints `METRIC roundtrip-ms`                                                                                                                                                                                                                |
|                                     | `GET /temperatures/history?deviceId=<simulated device>&startTime=<sentAt − 5 min>`                                                                                                                                                               | `200`; the sent reading is in `readings` (paging with `continuationToken` while `hasMore`), with the same field checks                                                                                                                                                                                                                                                                                 |
| `telemetry-volume.proof.ts`         | `GET /temperatures/history?deviceId=<simulated device>&limit=1000`, then each `continuationToken` in turn, one request at a time                                                                                                                 | `200` pages; counts the readings and prints `METRIC history-readings-before`                                                                                                                                                                                                                                                                                                                           |
|                                     | `simdevice --count <8640 − readings + 60> --inflight 32 --interval 50ms`, only when readings < 8,640                                                                                                                                             | exit `0` and one JSON line per reading requested; prints `METRIC topup-sent` (`0` when no top-up was needed) and `METRIC topup-ms`                                                                                                                                                                                                                                                                     |
|                                     | after a top-up only: `GET /temperatures/current/<simulated device>`, every 10 s for at most 15 min                                                                                                                                               | the reading's `timestamp` reaches the top-up's end (the reading 32 places from its last: see below), else it fails naming the cap                                                                                                                                                                                                                                                                      |
|                                     | the same walk again                                                                                                                                                                                                                              | at least 8,640 readings, and the last page's RU ≤ 1.5 × the first page's; prints `METRIC history-readings`, `history-pages`, `history-ru-first-page`, `history-ru-last-page`                                                                                                                                                                                                                           |
| `users.proof.ts`                    | `PUT /users/me` with a run-unique `name` and `acceptance@example.invalid`                                                                                                                                                                        | `200` or `201` (the profile persists between runs); body is an api-interfaces `User` with the name and email sent and a `<tid>:<oid>` id                                                                                                                                                                                                                                                               |
|                                     | `GET /users/me`                                                                                                                                                                                                                                  | `200`; this run's name reads back, with the same `id` and `createdAt` as the PUT returned                                                                                                                                                                                                                                                                                                              |
| `volume-cook-chart.proof.ts`        | checks the chart device is configured (`ACCEPTANCE_CHART_DEVICE_ID`, `ACCEPTANCE_CHART_STATE_DIR`)                                                                                                                                               | both set, else it fails naming both                                                                                                                                                                                                                                                                                                                                                                    |
|                                     | `POST /devices/claim` for the chart device with its own claim code (HAR-140); never released                                                                                                                                                     | `201` when the owner did not hold it, `200` when it did                                                                                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks?deviceId=<chart device>&status=active`, then `POST /cooks` (`acceptance standing chart cook`, `brisket`, fresh UUID) only when none is active                                                                                        | `200`; `201` and an `active` cook. The cook is never stopped                                                                                                                                                                                                                                                                                                                                           |
|                                     | `GET /cooks/{cookId}/chart` for the standing cook                                                                                                                                                                                                | `200`, the cook's chart; checks whether it covers the cook's 12 h (see below)                                                                                                                                                                                                                                                                                                                          |
|                                     | `simdevice --count 8640 --start <cook startTime> --step 5s --inflight 32 --interval 50ms` as the chart device, only when not covered                                                                                                             | exit `0`, 8,640 JSON lines stamped `startTime + i × 5 s`; prints `METRIC chart-topup-sent` (`0` when none was needed)                                                                                                                                                                                                                                                                                  |
|                                     | after a top-up only: `GET /cooks/{cookId}/chart`, every 10 s for at most 15 min                                                                                                                                                                  | covered, else it fails naming the cap                                                                                                                                                                                                                                                                                                                                                                  |
|                                     | `GET /cooks/{cookId}/chart` once more: the measurement                                                                                                                                                                                           | covered, and `x-meatgeek-request-charge` ≤ 40 (`CHART_RU_BUDGET`); prints `METRIC chart-ru-12h`, `chart-points`, `chart-bucket-seconds`                                                                                                                                                                                                                                                                |

Every `devices.proof.ts`, `recipes.proof.ts` and `users.proof.ts` response body is also checked for
keys starting with `_` at any depth (Cosmos system properties).

Every authenticated cooks, devices, recipes, temperatures and users response must carry the
`x-meatgeek-request-charge` header (the Cosmos RU the call cost, as a decimal),
including the devices `404` and the cooks `403`, which still cost a point read,
both `GET /temperatures/current` `404`s (the ownership point read, plus the
readings query for `NO_READINGS`), and both `GET /temperatures/history`
responses (the ownership point read for the `404`; that plus the count and page
queries for the empty `200`). The users figure includes the devices owner query that fills
`User.devices`. Every recipes response carries one too, the `DELETE` `204` and the
`404 RECIPE_NOT_FOUND` after it included (a point delete and a point read). So
does every `DELETE /devices/{id}`: the `204` (HAR-136: the ownership read, the
cook-lock read, then the delete's own read and the point delete),
the peer's `403` and the `404`s (a point read). A response without
it fails the proof. Responses that make no Cosmos call, such as a 401, carry no
header.

Each run uses its own device ids, and deletes them again (HAR-85). Since HAR-136,
`DELETE /devices/{id}` is a release and answers `409 COOK_ACTIVE` while a cook is
active on the device. A cleanup that may meet an active cook (the cooks
lifecycle's and the sweep's) stops it first; no cleanup accepts a `409`.
`devices.proof.ts` claims `acceptance-device-<runId>`.
`cooks-lifecycle.proof.ts` claims `acceptance-cook-<runId>` and runs the
cook lifecycle on it, because a cook may only start on a device the caller
owns (HAR-26); a fresh device per run also means runs never trip the
one-active-cook-per-device rule. Both claim with a run-unique name, so runs never
collide on device id or on the `(userId, name)` pair. The cooks proof's last
two steps use `acceptance-unowned-<runId>`, which is never enrolled or claimed.

### Fresh devices (HAR-140)

No proof uses `POST /devices` to get a device; HAR-145 removed the route. The
devices group's first step sends it once, outside the contract
(`outsideContract`, below), to prove it is not served: 404 or 405, and its
PASS line names the status. A group that needs a device of its own gets a
real one, enrolled the way the owner's Pi is (`lib/enrolment.ts`):

1. `enrolFreshDevice`: a new state dir under `$RUNNER_TEMP` (`os.tmpdir()`
   locally), where `simdevice identity init` makes the device's key and
   certificate; `enrol-device.sh` enrols that certificate in DPS; and
   `simdevice --twin --count 0 --timeout 2m` registers it through DPS, which
   creates its hub identity, and mints its first claim code.
2. `claimDevice`: `prepareClaim` syncs the twin again (`--twin --count 0`,
   which picks up a release: a release raises the claim generation and the
   device mints a new code), reads the code with `simdevice claim-code`, and
   fails unless it is `unclaimed`. Then `POST /devices/claim` with that code
   must answer `201` (or `200`, the same caller again) with a request charge.
3. `cleanupFreshDevice`, the group's `always` step: release
   (`DELETE /devices/{id}`), `delete-device.sh --device-id <id> --only-prefix
acceptance-` (its DPS enrollment and hub identity), and remove the state
   dir. Each part runs even when the one before it failed.

The runner runs the device scripts from `apps/data-pusher/deploy` as the job's
`az` login. It adds `--auth-type login --dps <ACCEPTANCE_DPS_HOST> --hub
<ACCEPTANCE_IOT_HUB_HOST>`: CI's identity holds data-plane roles only, so the
services are named by host. Each script's one result line (`enrolled <id>`,
`deleted <id>`) is on its `EXEC` line in the log. The claim code goes from
`simdevice claim-code` straight into the claim's request body: the runner logs
only the code's state (`state unclaimed`), never the line or a request body,
and its redactor masks anything shaped like a code. The state dir's contents,
the device's private key among them, are never read or printed; only its path
is passed on.

Each of the three groups that claims a device ends with a step marked
`always`, which releases and deletes it even when an earlier step failed. `devices.proof.ts`
deletes its device as part of the proof (the peer's `403`, the owner's `204`,
then `404`s), so its last step only runs when that did not happen. Cooks are not
deleted (there is no `DELETE /cooks`): a deleted device's cooks stay in the
owner's history, and its readings expire on the `temperatures` container TTL.

A run that is killed (a job timeout, a cancelled deploy) cannot run those
steps. So the first group, `acceptance-device-sweep.proof.ts` (its file name
sorts first), releases every `acceptance-*` device the owner holds, and deletes
its DPS enrollment and hub identity with `delete-device.sh`, before any other
proof enrols one. It never deletes the simulated or chart device,
whose ids do not start with `acceptance-` and which it also excludes by id.
Dev deploys run one at a time (the `app-deploy-dev` concurrency group), so no
other CI run's devices are in flight; a local run signs in as you, a different
owner, and sweeps only your `acceptance-*` devices. The three `METRIC
acceptance-devices-*` lines in the run summary give the owner's device count
before the sweep, how many it deleted, and the count after. Before HAR-85 the
acceptance owner had 98 devices.

`temperatures.proof.ts` claims its own fresh device, `acceptance-temp-<runId>`, and
is read-only otherwise. Telemetry only ever arrives through IoT Hub, and the
suite sends readings only as the simulated device (a fresh device's
registration and twin syncs send none), so a fresh `acceptance-temp-<runId>`
device keeps answering `NO_READINGS` for its current reading and an empty first
page for its history: that proof keeps proving the empty answers.

`telemetry-roundtrip.proof.ts` (HAR-44, MG-79's live criterion) is the proof
that reads telemetry back through the temperatures routes. It sends one reading through IoT Hub the way the Pi does,
by running `simdevice` (`apps/data-pusher`, see its
[README](../../apps/data-pusher/README.md#simdevice-a-software-device-for-dev)),
which builds the payload and message properties with data-pusher's own code and
sends as the standing simulated device `meatgeek-dev-simulated-smoker`. The
reading travels hub → route → Cosmos `temperatures` and is read back through
both temperatures routes, matched on the body `timestamp` simdevice reports.
Unlike the run-unique devices, this device is the same on every run, and it
is claimed, not registered (see the next section). Its readings are
not deleted; they expire on the `temperatures` container TTL.

### The standing devices are claimed once per run (HAR-140)

The simulated device and the chart device are claimed with their own claim
codes (`claimStandingDevice` in `lib/enrolment.ts`) and never released, which
the owner decided on HAR-140:

- Their history is the point. `telemetry-volume.proof.ts` keeps 8,640 readings
  on the simulated device, and `volume-cook-chart.proof.ts` keeps 12 h of
  rollups under the chart device's standing cook. Reads are bounded by the
  owner's `claimedAt` (HAR-136), so a release and a new claim would hide all
  of it and force a full top-up every run (~86k RU on the shared 400 RU/s
  offer).
- The chart device's cook is never stopped, so its release would be
  `409 COOK_ACTIVE`.

Each standing device runs in DPS mode (the only mode, HAR-146). In CI its state
dir is one the workflow made fresh this run, so it shows a new, unclaimed code. The run's first group that
needs the device syncs its twin, reads the code and claims it. The answer is
`201` when the owner did not hold the device, and `200` when it did: the stored
device is returned unchanged, `claimedAt` included. Every later group claims
it again with the same code, which the runner keeps in memory and never logs.
The answer is `200`, the same caller again. A device whose state dir shows its
code already `claimed` (a local state dir reused from an earlier run) must
already be the caller's: `GET /devices/{id}` `200`.

The history window opens five minutes before `sentAt`: the routes window on the hub's
enqueued time, which is never before the send.

`telemetry-volume.proof.ts` (HAR-45, MG-79's last deferred criterion; HAR-75)
measures what `GET /temperatures/history` costs at the volume one long cook
writes: 12 hours at one reading every 5 seconds, **8,640 readings**. It counts
the simulated device's readings by walking its history 1,000 a page by
continuation token, tops it up through IoT Hub with `simdevice` when it is
short, waits for the top-up to reach the current reading, and walks again. The
second walk prints the request charge of its first and last pages and its page
count, and fails unless the last page costs at most 1.5 × the first: the
evidence that a deep page no longer costs more. (Before HAR-75 history paged by
`OFFSET`, whose cost grows with the rows skipped: the page at 8,600 cost twice
the first.) It relies on the round-trip proof, which runs first, having
registered the device to the caller.

- **Why a top-up.** The volume cannot be loaded once by hand: readings expire on
  the dev `temperatures` container TTL, 7 days (`temperature_data_ttl_days` in
  `apps/infrastructure/environments/dev.tfvars`). Each run restores it when it
  is short, sending the shortfall plus 60 for readings that expire during the
  run.
- **When it happens.** On the first run, and then on the first run after the
  previous top-up's readings expire. A top-up writes its readings within one
  run, so they all expire together 7 days later: whatever the run frequency,
  expect a full top-up about once a week. In between, the walk counts at least
  8,640 (the round trip adds one reading a run) and `METRIC topup-sent 0`.
- **How long it takes.** The top-up runs `--inflight 32 --interval 50ms`:
  simdevice starts a send every 50 ms and lets up to 32 await IoT Hub's QoS 1
  acknowledgement at once, so the ~200 ms publish round trip overlaps the next
  sends instead of adding to each one. That is 20 readings/s, so a full top-up
  of ~8,700 readings takes about 7–8 minutes (`METRIC topup-ms` reports it);
  with one send in flight (the default, `--inflight 1`) it took ~30. simdevice
  is killed after `count × 50 ms × 1.5 + 120 s` (~13 min for a full top-up),
  and the failure says how many readings it had sent. The proof then waits for
  the routed writes to be readable (the drain), at most 15 minutes; at 20
  writes/s the routing keeps roughly pace, so expect a short drain. The drain
  ends when `GET /temperatures/current` shows a reading at or after the one 32
  places from the top-up's last: simdevice stamps readings in send order and
  keeps at most 32 unacknowledged, so the last reading IoT Hub enqueues is one
  of the final 32 (waiting for the very last timestamp could wait forever). A run
  without a top-up adds a few seconds. The live run's time limit is 35 minutes
  to fit this (the third argument of the one `test(...)` in
  `apps/api/acceptance/live.acceptance.ts`), under the job's 40.
- **Why 50 ms.** The `temperatures` container has no throughput of its own: it
  shares one 400 RU/s database-level offer with the other four containers
  (`apps/infrastructure/modules/cosmos-db/main.tf`), and IoT Hub's routed
  writes are paid from it. The top-up may use at most half: 200 RU/s at ~10 RU
  per routed write is 20 writes/s, a 50 ms gap. Waiting for the top-up's end
  also drains the routing backlog before the measuring walk and later groups
  run on the same offer.

`volume-cook-chart.proof.ts` (HAR-87, goal HAR-71 item 5) measures what loading
a 12-hour cook's chart costs, `GET /cooks/{cookId}/chart` (HAR-86), and fails
if it is over **40 RU** (`CHART_RU_BUDGET` in the proof file). The chart is
served from per-device, per-hour rollup documents, so the cost is one point read
of the cook and one single-partition query over about 13 hour documents. Its
file name sorts after `cooks-lifecycle` and `telemetry-volume`, so it runs after
both.

- **The standing chart cook.** The server sets a cook's `startTime` when it
  starts it, and `device-twin.proof.ts` starts and stops cooks on the simulated
  device every run, so the proof keeps one active cook,
  `acceptance standing chart cook`, on the second standing device, the chart
  device (see [The chart device](#the-chart-device-har-84)), and never stops
  it. Each run finds it with `GET /cooks?deviceId=<chart device>&status=active`
  and starts one only when there is none. An active cook's chart covers every
  reading from `startTime` on with no upper bound, so the readings are stamped
  from `startTime` forward, whenever they are sent: `simdevice --start
<startTime> --step 5s` stamps reading _i_ `startTime + i × 5 s`. (On the run
  that starts the cook, most of those stamps are in the future. Nothing else
  reads the chart device.)
- **Covered.** The chart covers the cook when its first point is within one
  bucket of `startTime` and its last point is the bucket holding the last
  reading, `startTime + 12 h − 5 s`. Point `t`s are bucket starts on
  `startTime`'s minute, so that last bucket can start a few seconds before
  `startTime + 12 h − bucketSeconds`.
- **The one-time top-up and its cost.** The first run finds the chart empty and
  sends 8,640 readings as the chart device, paced as the volume top-up is
  (`--inflight 32 --interval 50ms`, at most 200 RU/s of the shared 400): about
  7 minutes of sending, ~86k RU of routed writes, plus the rollup trigger's
  hour-document writes (paced at 100 RU/s, HAR-86). It then re-reads the chart
  every 10 s, for at most 15 minutes, until the rollups cover it. Rollups have
  no TTL, so every later run finds the chart covered and sends nothing
  (`METRIC chart-topup-sent 0`). The raw readings expire after 7 days; the
  chart never reads them. If that first run also has a full volume top-up to
  do, the two together still fit the 35-minute suite limit, but only just.
- **The budget.** `METRIC chart-ru-12h` is the RU of one more chart load after
  coverage. Above 40 the proof fails. The fix is not to raise the budget: report
  the number and the rollup document sizes on the issue, and decide the rollup
  or endpoint change separately. `chart-bucket-seconds` grows as the standing
  cook ages (its span runs to now), which does not change the documents read.
- **If the cook is stopped by hand.** Do nothing. The next run finds no active
  cook on the chart device, starts a new one and tops it up once (the one-time
  cost again). The old cook's rollups stay, outside the new cook's window.
  `signalr-isolation.proof.ts` (HAR-67, goal HAR-55 items 5 and 7b) proves a
  caller who does not own the simulated device receives nothing from it over
  SignalR. The owner is the run's caller; the peer is the zero-role acceptance
  peer (`ACCEPTANCE_PEER_BEARER_TOKEN`), which a proof sends as with
  `api.request({ ..., as: 'peer' })`. The peer's `POST /negotiate` carries
  `?deviceId=<simulated device>`, which negotiate must ignore: it mints a token
  for the caller's userId only, and every reading goes to the device owner's
  userId (HAR-81). The peer's connection records every
  invocation at the protocol, before dispatch, so a message on a target nobody
  handles still counts as a leak. Silence is judged after a 15 s grace once the
  owner has received the same event, so a late leak is not missed. A leak fails
  the proof with the target(s) and counts the peer received; it is reported, not
  fixed, here. The cook runs on the simulated device itself, so the proof first
  stops any cook an earlier run left active on it (`POST /cooks` would be `409
COOK_ALREADY_ACTIVE`); stops and starts sync the device twin (HAR-66). Two
  connections are open while it runs (dev SignalR `Free_F1` allows 20).

`device-twin.proof.ts` (HAR-68, goal HAR-55 items 1, 2 and 7c) proves a cook
started while the device is offline reaches it through the IoT Hub device twin,
and the device reports it applied. Start and stop sync the twin's desired
`activeCookId` and `correlationId` to Cosmos (HAR-66); the correlation id is the
start's `X-Request-ID`, which the proof sends through `api.request({ ...,
headers })`. `simdevice --twin` (HAR-58) runs the Pi's own twin code: it
connects, GETs the twin, applies the desired cook, reports it, GETs the twin
again and prints it as one `{"event":"twin","desired":…,"reported":…}` line,
then sends `--count` readings carrying the applied cook. simdevice is
short-lived, so it is not connected when the cook starts: each run is the
offline-then-reconnect case. The cook runs on the simulated device itself, so
the proof first stops any cook left active on it, and its last step, marked
`always`, runs even after a failed step and stops whatever is still active, so
a failed run never leaves the device locked for the next one. A defect in the
twin sync or in simdevice is reported here, not fixed.

`signalr-live-temperature.proof.ts` (HAR-63, goal HAR-55 item 7a) proves a
live reading reaches its owner by push: simdevice → IoT Hub →
`temperature-data` Event Hub → `broadcastTemperature` → SignalR, addressed to
the device owner's `userId` (HAR-81). `broadcastTemperature` reads the owner
when it handles the reading, so the proof claims the simulated device for the
caller before it sends; `POST /negotiate` only mints the caller's token. It
opens one connection (dev SignalR is `Free_F1`: 20
concurrent connections, 20,000 messages a day) and stops it whichever step
fails. A new Event Hub consumer group can replay retained events, so older
readings of the device may arrive first; the proof matches the one it sent by
`timestamp`, as an instant. `broadcastTemperature` logs
`broadcastTemperature sent=<n> skipped=<m> unowned=<u> lookupFailed=<f>`, but
App Insights shows nothing from
dev (MG-37), so this proof's output is the only evidence of delivery: a timeout
says how many `temperature` messages did arrive, how many for the device, and
the last `timestamp` among them.

The three SignalR proofs start their clients through `startConnection` in
`lib/signalr.ts`. When the SignalR service answers the client's own negotiate
with `429` (Too many requests), it retries after 1, 2, 4 and 8 s, so five
attempts in all; any other error fails at once. `POST /negotiate` already
retries the service's REST API (HAR-80); this covers the next step, the client
dialling the service. Free_F1 throttles that step briefly when connections open
close together: HAR-77's first live run had two proofs fail with `429`, and the
next one, two seconds later, connected. If every attempt is throttled, the
failure ends `(throttled on all 5 attempts)`, which points at the service's
limits rather than our code.

`recipes.proof.ts` cleans up after itself: it creates one recipe named
`Acceptance recipe <runId>`, and its sixth step deletes it. If an earlier step
fails, the runner skips the rest of the group, so that run's one recipe stays in
the acceptance identity's partition; its run-unique name says which run left it.

The acceptance profile is not cleaned up either: there is no `DELETE /users/me`.
It is keyed by the caller's identity, so every run writes the same document,
the CI service principal's profile. The first run creates it (`201`) and later
runs replace it (`200`); each run writes its own `Acceptance <runId>` name, so
the read-back proves that run's write. Its `devices` lists the devices the
identity holds at that moment: the standing simulated and chart devices, plus
the run-unique devices of groups that have not deleted theirs yet.

## Output

One line per request, then a per-route RU table and a total:

```
acceptance run 20261118153521-6cacc5 against https://<function-app-host>/api
RUN  cooks lifecycle › POST /cooks starts a cook on the owned device and returns a Cook
  POST   /cooks                         201    412 ms  RU 11.43
PASS cooks lifecycle › POST /cooks starts a cook on the owned device and returns a Cook
...
RUN  cooks lifecycle › POST /cooks/{cookId}/stop stops the cook
  POST   /cooks/{cookId}/stop           500    233 ms  RU 20.1
FAIL cooks lifecycle › POST /cooks/{cookId}/stop stops the cook — POST /cooks/{cookId}/stop → 500: expected 2xx, got 500 (INTERNAL_SERVER_ERROR)
SKIP cooks lifecycle › GET /cooks reads the cook back as stopped (an earlier proof in this group failed)

RU per route
  ROUTE                                    CALLS  RU TOTAL   RU AVG
  GET /cooks                                   1      2.83     2.83
  GET /cooks (no auth)                         1         -        -
  POST /cooks                                  1     11.43    11.43
  POST /cooks/{cookId}/stop                    1      20.1     20.1

CONTRACT validated 4 responses, 0 hub messages, 1 mismatches
METRIC contract-validated-responses 4

acceptance: 3 passed, 1 failed, 1 skipped
```

A `simdevice` run is one `EXEC` line, with its exit code, duration and the
number of JSON lines it printed:

```
RUN  telemetry round-trip › simdevice --count 1 sends one reading through IoT Hub
  EXEC   simdevice --count 1            exit 0  1840 ms  1 message(s)
PASS telemetry round-trip › simdevice --count 1 sends one reading through IoT Hub
RUN  telemetry round-trip › GET /temperatures/current/{deviceId} returns the sent reading
  GET    /temperatures/current/{deviceId} 404    212 ms  RU 3.86
  GET    /temperatures/current/{deviceId} 200    198 ms  RU 3.86
METRIC roundtrip-ms 2140
PASS telemetry round-trip › GET /temperatures/current/{deviceId} returns the sent reading
```

`METRIC <name> <value>` lines report a measurement, not a pass/fail:

| Metric                         | Proof file                          | Value                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roundtrip-ms`                 | `telemetry-roundtrip.proof.ts`      | ms from simdevice's `sentAt` (IoT Hub acknowledged the publish) to the `GET /temperatures/current` response that first carried the reading; overstated by up to one poll (1 s)                                                        |
| `history-readings-before`      | `telemetry-volume.proof.ts`         | readings the first walk of the simulated device's history counted                                                                                                                                                                     |
| `topup-sent`                   | `telemetry-volume.proof.ts`         | readings the top-up sent; `0` when none was needed                                                                                                                                                                                    |
| `topup-ms`                     | `telemetry-volume.proof.ts`         | how long the top-up's simdevice run took; `0` when none was needed                                                                                                                                                                    |
| `history-readings`             | `telemetry-volume.proof.ts`         | readings the measuring walk counted (≥ 8,640)                                                                                                                                                                                         |
| `history-pages`                | `telemetry-volume.proof.ts`         | pages of 1,000 the measuring walk took                                                                                                                                                                                                |
| `history-ru-first-page`        | `telemetry-volume.proof.ts`         | RU of the measuring walk's first page (`limit=1000`, no token)                                                                                                                                                                        |
| `history-ru-last-page`         | `telemetry-volume.proof.ts`         | RU of its last page, reached by continuation token; must be ≤ 1.5 × the first                                                                                                                                                         |
| `signalr-delivery-ms`          | `signalr-live-temperature.proof.ts` | ms from just before `simdevice --count 1` starts to the client receiving the reading on target `temperature`. Includes simdevice's start-up and IoT Hub connect, so it overstates hub-to-client delivery by about the `EXEC` duration |
| `isolation-peer-messages`      | `signalr-isolation.proof.ts`        | messages the peer received on any target, by the end of the 15 s grace after `cook_stopped` (or by the failing check). The proof fails unless it is `0`                                                                               |
| `signalr-cook-event-ms`        | `signalr-isolation.proof.ts`        | ms from just before the owner's `POST /cooks` to the owner's client receiving `cook_started` for that cook                                                                                                                            |
| `contract-validated-responses` | the runner (HAR-77)                 | responses checked against openapi.yaml in the run. Printed with the `CONTRACT` line just above the totals                                                                                                                             |
| `twin-apply-ms`                | `device-twin.proof.ts`              | ms from the start's `201` to the exit of `simdevice --twin --count 1`: a reconnect, two twin GETs, the reported patch and one reading's send                                                                                          |
| `twin-device-apply-lag-ms`     | `device-twin.proof.ts`              | the twin line's `applyLagMs` (HAR-152): the device's clock at its GET minus the start's desired `cookUpdatedAt`; a reconnect, so it includes the wait for simdevice                                                                   |
| `chart-topup-sent`             | `volume-cook-chart.proof.ts`        | readings the chart top-up sent; `0` when the chart was already covered                                                                                                                                                                |
| `chart-ru-12h`                 | `volume-cook-chart.proof.ts`        | RU of one `GET /cooks/{cookId}/chart` of the standing 12 h cook; must be ≤ 40                                                                                                                                                         |
| `chart-points`                 | `volume-cook-chart.proof.ts`        | points in that chart                                                                                                                                                                                                                  |
| `chart-bucket-seconds`         | `volume-cook-chart.proof.ts`        | its `bucketSeconds`                                                                                                                                                                                                                   |

There are no thresholds on them, except that `chart-ru-12h` must be ≤ 40; the numbers are the deliverable. The CI job copies every line starting with
`METRIC ` into the run summary. Proofs print one with `api.metric(name, value)`.

Any failed proof makes the process exit non-zero, and the `FAIL` line names the
proof, the route and the status received (or `simdevice → exit <code>` when
simdevice was the last thing it ran). Secrets are never printed: the suite logs
no request or response headers or bodies (only a bare upper-case `error` code
from an error body), never prints simdevice's stdout or stderr raw (stdout is
parsed as JSON lines; of stderr only the first line is reported, on failure),
and masks in every line, as a second guard, both bearer tokens and anything
shaped like a claim code. No device key passes through the runner: each
device's key stays in its state dir (HAR-146).

### Contract validation

At start-up the runner loads and dereferences
`libs/api-specs/spec/openapi.yaml` with `@apidevtools/swagger-parser`. It
compiles every response schema and every `x-signalr` message schema with `ajv`
and `ajv-formats` (`apps/api/acceptance/lib/contract.ts`). If the spec cannot
be loaded, the run exits `2` before any request.

Every `api.request(...)`, the unauthenticated ones included, is checked:

- **Before it is sent:** the method and route must be an operation in the
  spec. A proof's `route` must be one of the spec's paths, and the request's
  `path` must fit it. With no `route`, the spec path that `path` fits is used,
  and a literal segment wins over a `{parameter}`. Anything else fails the
  proof with no request sent.
- **HAR-145, `outsideContract: true`:** for a route the spec deliberately
  lacks (the removed `POST /devices`). The method and path must NOT be a spec
  operation, or the proof fails with no request sent. The response is not
  checked or counted, and needs no request charge; the proof checks the status
  itself. A proof may resolve to a note, which its PASS line carries:
  `PASS devices › POST /devices is not served … — POST /devices answered 404`.
- **When it comes back:**
  - The status must be declared for the operation.
  - A JSON body must match that status's `application/json` schema. A JSON
    body is also a mismatch when the status declares no body. A non-JSON or
    empty body is not checked against a schema; Easy Auth's own `401` is an
    example.
  - If the response declares `X-Request-ID`, the header must be present.

A mismatch fails the proof with a line such as:

```
FAIL devices › … — POST /devices/claim → 201: contract: POST /devices/claim (claimDevice) 201: the body does not match the schema: /isActive must be boolean; (root) must NOT have additional properties 'colour'
```

The line names the operation, the status and up to three Ajv errors with their
path in the body. It never prints a value from the body, and the redactor
masks it like every other line.

There is no per-proof opt-out for a route the spec describes. If the spec is
wrong, fix the spec. If the API is wrong, fix the handler.

SignalR proofs check each message they receive with `expectHubMessage(api,
target, message)` from `lib/signalr.ts`, against `x-signalr.messages.<target>`.
`signalr-live-temperature` checks every `temperature` message it received.
`signalr-isolation` checks every message the owner received on
`temperature`, `cook_started` and `cook_stopped`. (`device-twin` opens no
SignalR connection; it reads the twin through `simdevice`.)

The run ends with `CONTRACT validated <n> responses, <m> hub messages,
<k> mismatches` and `METRIC contract-validated-responses <n>`. A green run
shows `0 mismatches`.

## Real-time waits

The live suite waits on a real cloud, so some of its waits are on real time.
This table is every one of them in `live.acceptance.ts`, `proofs/*.proof.ts`
and `lib/*`, with its bound and why the bound is that long. The browser proof
(`apps/web-e2e`) has its own table, with the same columns, in
[The browser proof's waits](#the-browser-proofs-waits), and so does the iOS
proof (`apps/ios/MeatGeekLiveUITests`), in
[The iOS proof's waits](#the-ios-proofs-waits).

The rules (HAR-106, HAR-120):

- Every wait in `proofs/` and `lib/` goes through the one clock in
  `lib/clock.ts`. Live it is the real one (`Date.now`, `performance.now`,
  `setTimeout`). The self-test (`acceptance-runner.spec.ts`) installs a fake
  one, so each wait below runs there with its **live** value: a `sleep` ends
  once the stub has answered and every SignalR client has taken what was
  pushed to it, then moves the fake time on by exactly that long; a deadline
  fires only when the fake time reaches it. Each failure message below is
  asserted exactly there.
- A timeout's message names what it was waiting for.
- A bound changes only with a reason in this table: a measured run, an Azure
  limit or a ticket. Never to make something pass.

"Measured" below is the six green `Deploy Dev App` runs on `main` from
2026-11-20 to 2026-11-22 (runs 44826747406, 44829527186, 44837747351, 44843327090, 44936508031 and 44964201190),
none of which needed a volume or chart top-up.

| Where (file:symbol)                                                                                | What it waits for                                                                                                                                                                                                                                                                              | Bound                                                        | Why that long                                                                                                                                                                                                                                                                                                                                                                                            | Failure message                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live.acceptance.ts:SUITE_TIMEOUT_MS`                                                              | the whole run: jest's limit on the suite's one test. Jest's own timer, not the clock                                                                                                                                                                                                           | 35 min                                                       | Under the `acceptance` job's 40 min timeout (`app-deploy-dev.yml`), so jest reports an overrun, not the job kill (HAR-46). Room for a full volume top-up (~8,700 readings, ~7–8 min) plus its drain (up to 15 min). Measured: 1–2 min with no top-up                                                                                                                                                     | jest: `Exceeded timeout of 2100000 ms for a test` on `live acceptance proofs pass against ACCEPTANCE_BASE_URL`                                                                                                                                                                                                                          |
| `lib/runner.ts:DEFAULT_TIMEOUT_MS` (`api.request`)                                                 | one API response, body included                                                                                                                                                                                                                                                                | 60 s                                                         | A dev Function App cold start: the slowest first request measured was 9,469 ms (run 44964201190) and 9,365 ms (run 44843327090); every other request was under 0.9 s (HAR-11)                                                                                                                                                                                                                            | `FAIL <proof> — <METHOD> <route> → no response: the response did not finish in 60000 ms (the runner's per-request limit)`                                                                                                                                                                                                               |
| `lib/runner.ts:SIMDEVICE_TIMEOUT_MS` (`runSimDevice`, `runChild`'s kill)                           | a `simdevice` run to exit, unless the proof passes its own limit; killed with `SIGKILL`. HAR-142: also each fresh device's `--count 1` in the release proof                                                                                                                                    | 120 s                                                        | One reading takes seconds (HAR-44). Measured: `simdevice --count 1` ≤ 487 ms                                                                                                                                                                                                                                                                                                                             | `simdevice → exit killed: simdevice did not exit within its 120000 ms limit and was killed, expected exit 0` (its `EXEC` line says `exit killed`)                                                                                                                                                                                       |
| `proofs/device-twin.proof.ts:SIMDEVICE_KILL_MS`                                                    | `simdevice --twin` to exit; killed with `SIGKILL`                                                                                                                                                                                                                                              | 120 s                                                        | Twice simdevice's own 60 s twin wait (next row), leaving room for the connect and a reading (HAR-68). Measured: a reconnect ≤ 869 ms (`twin-apply-ms` ≤ 870)                                                                                                                                                                                                                                             | as the row above, with `120000 ms`                                                                                                                                                                                                                                                                                                      |
| `proofs/device-twin.proof.ts:TWIN_TIMEOUT` (`--timeout 60s`)                                       | simdevice's own wait for each twin GET, inside the child (Go)                                                                                                                                                                                                                                  | 60 s                                                         | Set with the proof (HAR-68), twice simdevice's own 30 s default (HAR-58); no measurement then. Measured: the whole reconnect, both GETs included, ≤ 869 ms                                                                                                                                                                                                                                               | `simdevice exited 1, expected 0: … no twin response from IoT Hub within 60s: …`                                                                                                                                                                                                                                                         |
| `proofs/telemetry-volume.proof.ts:topupTimeLimitMs`                                                | the volume top-up's `simdevice` run; killed with `SIGKILL`                                                                                                                                                                                                                                     | `count × 50 ms × 1.5 + 120 s` (8,700 readings: 772.5 s)      | The paced send time with half again for slack, plus 120 s to connect and drain the last acknowledgements (HAR-45, HAR-46). A full top-up took ~7–8 min                                                                                                                                                                                                                                                   | `simdevice was killed after the <n> s limit (<k> of <count> message(s) sent)`                                                                                                                                                                                                                                                           |
| `proofs/volume-cook-chart.proof.ts` (`topupTimeLimitMs`)                                           | the chart top-up's `simdevice` run; killed with `SIGKILL`                                                                                                                                                                                                                                      | the same formula (8,640 readings: 768 s)                     | The same pacing as the volume top-up (HAR-87)                                                                                                                                                                                                                                                                                                                                                            | as the row above                                                                                                                                                                                                                                                                                                                        |
| `proofs/device-twin.proof.ts:TWIN_POLL`                                                            | the twin run's reading in `GET /temperatures/current/{deviceId}`                                                                                                                                                                                                                               | a poll every 2 s, cap 90 s                                   | IoT Hub → Cosmos routing (HAR-68). Measured round trip (`roundtrip-ms`) ≤ 1,225 ms                                                                                                                                                                                                                                                                                                                       | `the reading with timestamp <ts> was not readable within the 90 s cap; last status <status>, last timestamp seen <ts or none>`                                                                                                                                                                                                          |
| `proofs/telemetry-roundtrip.proof.ts:ROUNDTRIP_POLL`                                               | the sent reading in `GET /temperatures/current/{deviceId}`                                                                                                                                                                                                                                     | a poll every 1 s, cap 120 s                                  | IoT Hub → Cosmos routing (HAR-44). Measured `roundtrip-ms` 104–1,225 ms                                                                                                                                                                                                                                                                                                                                  | `the reading sent at <sentAt> (timestamp <ts>) was not readable within the 120 s cap; last status <status>, last timestamp seen <ts or none>`                                                                                                                                                                                           |
| `proofs/telemetry-volume.proof.ts:VOLUME.pollIntervalMs`, `pollCapMs`                              | the top-up's tail in the current reading: its routing backlog has drained                                                                                                                                                                                                                      | a poll every 10 s, cap 15 min                                | The routed writes share the one 400 RU/s offer, so ~8,700 of them drain behind it (HAR-45, HAR-46)                                                                                                                                                                                                                                                                                                       | `the current reading is <ts or none>, before the top-up's end (<iso>), after the 900 s cap`                                                                                                                                                                                                                                             |
| `proofs/volume-cook-chart.proof.ts:CHART.pollIntervalMs`, `pollCapMs`                              | the chart to cover 12 h after a top-up (rolled up)                                                                                                                                                                                                                                             | a poll every 10 s, cap 15 min                                | The same backlog as the volume top-up, plus the hourly rollup (HAR-87)                                                                                                                                                                                                                                                                                                                                   | `the chart is not covered after the 900 s cap: <why>`                                                                                                                                                                                                                                                                                   |
| `proofs/signalr-live-temperature.proof.ts:LIVE_WAIT.capMs`                                         | the sent reading pushed on target `temperature`                                                                                                                                                                                                                                                | 90 s                                                         | simdevice → IoT Hub → Event Hub → `broadcastTemperature` → SignalR (HAR-63). Measured `signalr-delivery-ms` 436–628 ms                                                                                                                                                                                                                                                                                   | `connected and sent (…), but no temperature message for <device> with that timestamp arrived: nothing within the 90 s cap; the connection is <state>. Received <n> temperature message(s), …`                                                                                                                                           |
| `proofs/signalr-isolation.proof.ts:ISOLATION_WAIT.capMs` (`waitForOwner`)                          | the owner's reading, `cook_started` and `cook_stopped`, each                                                                                                                                                                                                                                   | 90 s each                                                    | As the row above (HAR-67). Measured `signalr-cook-event-ms` 230–366 ms                                                                                                                                                                                                                                                                                                                                   | `no <what> reached the owner: nothing within the 90 s cap; the owner connection is <state>. The owner received <n> message(s) (…)`                                                                                                                                                                                                      |
| `proofs/signalr-isolation.proof.ts:ISOLATION_WAIT.graceMs` (`expectPeerSilent`)                    | a fixed window after the owner got an event, in which the peer must receive nothing                                                                                                                                                                                                            | 15 s                                                         | A leak would travel the same path as the owner's message, so it gets about 24 × the slowest owner delivery measured (628 ms) to show up (HAR-67)                                                                                                                                                                                                                                                         | `LEAK: the peer, who does not own <device>, received <n> message(s) by <event> + 15 s: <target ×n>`                                                                                                                                                                                                                                     |
| `proofs/device-release.proof.ts:RELEASE_WAIT.capMs` (`MessageFeed.waitFor`, `lib/live-feed.ts`)    | the released device's first reading, and later the control device's reading, pushed to the owner on target `temperature`                                                                                                                                                                       | 90 s each                                                    | The same path and cap as `LIVE_WAIT` (HAR-142). Measured there: `signalr-delivery-ms` 436–628 ms                                                                                                                                                                                                                                                                                                         | `sent a reading as <device> (timestamp <ts>), but it did not reach the owner: nothing within the 90 s cap; the connection is <state>`; for the control: `the control device's reading (timestamp <ts>) did not reach the owner, so the path to the owner was not shown to work: nothing within the 90 s cap; the connection is <state>` |
| `proofs/device-release.proof.ts:RELEASE_WAIT.graceMs` (`MessageFeed.quietFor`, `lib/live-feed.ts`) | a fixed window after the control's reading arrived, in which the old owner must receive nothing more from the released device                                                                                                                                                                  | 15 s; it ends early, and fails, when such a reading arrives  | Event Hub orders readings per device, not across devices, so the control arriving first does not by itself show the released device's reading was dropped. A leak would travel the same path, so it gets the same 15 s as `ISOLATION_WAIT.graceMs`, about 24 × the slowest delivery measured (HAR-142)                                                                                                   | `after the release the old owner received <n> reading(s) from <device> (timestamp <ts, …>; the next one sent was <ts>)`                                                                                                                                                                                                                 |
| `proofs/device-revoke.proof.ts:REVOKED_SEND_KILL_MS`                                               | the revoked device's `simdevice --count 1` to be refused and exit; killed with `SIGKILL`                                                                                                                                                                                                       | 120 s                                                        | Inside it, simdevice's own bounds end the run: its 30 s limit on the send (`internal/simdevice` `sendTimeout`, which covers the hub's refusal, the DPS re-registration DPS refuses, and the one retry) and DPS's own answer. `--timeout` bounds only `--twin`, so it is not passed. 120 s is the runner's default kill (`SIMDEVICE_TIMEOUT_MS`), four times the send limit (HAR-142). No measurement yet | `simdevice as the revoked <device> did not exit within its 120000 ms limit and was killed: it should be refused at once`                                                                                                                                                                                                                |
| `lib/signalr.ts:CONNECT_TIMEOUT_MS` (`within`)                                                     | one SignalR client `start()` attempt, or a `stop()`                                                                                                                                                                                                                                            | 30 s                                                         | Set with the first SignalR proof (HAR-57) for the Free_F1 service's client negotiate and transport start; no measurement then. Measured, from the log's timestamps: `start()` 170–580 ms                                                                                                                                                                                                                 | `<what> did not finish in 30000 ms`, `<what>` being `start()`, `owner start()`, `peer start()` or `stop()`                                                                                                                                                                                                                              |
| `lib/signalr.ts:START_RETRY.delaysMs` (`startConnection`)                                          | before retrying a `start()` the service answered with `429`                                                                                                                                                                                                                                    | 1, 2, 4 and 8 s: five attempts, 15 s of waiting              | HAR-77's first live run: two proofs got `429`, and the next one, 2 s later, connected                                                                                                                                                                                                                                                                                                                    | `<what> failed: <masked error> (throttled on all 5 attempts)`                                                                                                                                                                                                                                                                           |
| simdevice `internal/provision/provision.go:Register` (DPS mode)                                    | simdevice's DPS registration, in the child (Go): `PUT`, then polls to `assigned`                                                                                                                                                                                                               | 30 polls, each after `Retry-After` (default 2 s)             | Set with the DPS client (HAR-132; `defaultMaxAttempts`, `defaultRetryAfter`, 30 s per request); no measurement then. Only a device's first simdevice run in a job registers, and in CI that is the enrol step's `--twin --count 0` run (HAR-139), before the suite starts: later runs reuse the assignment cached in its state dir                                                                       | `provision: registration of <id> still "<status>" after 30 status checks`                                                                                                                                                                                                                                                               |
| `lib/enrolment.ts:enrolFreshDevice` (`TWIN_SYNC_TIMEOUT`, `TWIN_SYNC_KILL_MS`)                     | a fresh device's first `simdevice --twin --count 0`: its DPS registration (the row below) and twin sync, which mints its first claim code; killed with `SIGKILL`                                                                                                                               | simdevice's own `--timeout 2m`; the runner kills it at 150 s | The CI workflow's own registration of the standing devices uses the same `--timeout 2m` (HAR-139). The 30 s over it lets simdevice give up and exit with its own message first. Measured in run 45133256919 (`main` at 9a4ce8b, 2026-11-23): 3,447–3,521 ms over its 7 fresh devices                                                                                                                     | `simdevice --twin --count 0 for <id> exited <n>, expected 0: <stderr>`, or `… did not exit within its 150000 ms limit and was killed`                                                                                                                                                                                                   |
| `lib/enrolment.ts:prepareClaim` (the same constants)                                               | the twin sync before a claim code is read: `simdevice --twin --count 0`, which picks up a release and mints a new code; killed with `SIGKILL`. HAR-142: the claim, release and revoke proofs run it before each claim, and the release proof once more after the release, to show the new code | the same: `--timeout 2m`, killed at 150 s                    | As the row above: the device reconnects (it is already registered) and reads its twin. Measured in run 45133256919 (`main` at 9a4ce8b, 2026-11-23): 319–343 ms over 10 runs                                                                                                                                                                                                                              | as the row above                                                                                                                                                                                                                                                                                                                        |
| `lib/runner.ts:DEVICE_SCRIPT_TIMEOUT_MS` (`runDeviceScript`)                                       | `enrol-device.sh`, `delete-device.sh` or (HAR-142) `revoke-device.sh` to exit; killed with `SIGKILL`                                                                                                                                                                                           | 300 s                                                        | Each makes three to five `az` calls of a few seconds each (HAR-140). Measured in run 45133256919 (`main` at 9a4ce8b, 2026-11-23): `enrol-device.sh` 1,875–2,380 ms (7 runs), `delete-device.sh` 3,170–5,043 ms (7), `revoke-device.sh` 1,867–3,744 ms (2)                                                                                                                                                | `<script> for <id> exited (killed), expected 0` (the cleanup and the sweep), or `… did not exit within its 300000 ms limit and was killed`                                                                                                                                                                                              |

A `grep -nE 'capMs|intervalMs|graceMs|TIMEOUT_MS|timeoutMs|delaysMs' -r
apps/api/acceptance` also finds names that are not waits in this suite:
`VOLUME.intervalMs` is the pace simdevice sends a top-up at (`--interval
50ms`, set by the 200 RU/s write budget; it is simdevice's, not a wait here);
`timeoutMs` in `RunOptions` and `SimDeviceOptions` carries the limits above;
the local `capMs` constants are the caps above; and the self-test's own uses.

### The browser proof's waits

The live browser proof (`apps/web-e2e/live`, below) waits on Microsoft's
sign-in pages, the deployed app and the dev API, with the same columns. Its
non-live test, `src/*.spec.ts` against the built app and fakes, has none of
these: it freezes the browser's clock and the fakes' on one instant
(`src/fakes/clock.ts`) and every wait ends on its event, bounded only by the
test timeout (HAR-121).

"Measured" here is every `web-acceptance` attempt in the `Deploy Dev App` runs
from 2026-11-20 to 2026-11-22 that reached the sign-in step: 19 attempts in 18
runs (44830799078, 44833909340, 44837747351, 44841530086, 44843327090,
44855329505, 44855615157, 44857270408, 44933546359, 44936508031, 44940008836
attempts 1 and 2, 44944960894, 44953129691, 44954673647, 44960958060,
44964201190, 44969331304, 44971443748), from the step reporter's
`PASS 2. sign in on the real Microsoft pages (<s>)` lines and the log's
timestamps. In all 19 Microsoft asked for no second factor, and production
already served the expected commit (`web-deploy-wait-s 0`).

| Where (file:symbol)                                                      | What it waits for                                                                                                                                                                                           | Bound                            | Why that long                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Failure message                                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `playwright.live.config.ts:timeout`                                      | the whole proof: Playwright's limit on its one test                                                                                                                                                         | 25 min                           | Up to 15 min for the build (`waitForBuild`, below) plus a few minutes of proof. Under the job's 30 min timeout. Measured: the whole test 15.9–36.8 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Playwright: `Test timeout of 1500000ms exceeded.`                                                                                                            |
| `helpers.ts:waitForBuild` (`intervalMs`, `timeoutMs`)                    | `<web>/version.json` to serve `EXPECTED_WEB_SHA` or a commit after it                                                                                                                                       | a poll every 15 s, cap 15 min    | Vercel builds and promotes the merge commit after the deploy job starts (HAR-99). Measured: `web-deploy-wait-s 0` in all 19 (production already served it); the cap is for a slow Vercel build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `Production did not serve <sha> or a commit after it within 15 min: <web>/version.json last reported <sha or no sha> (<why>)`                                |
| `helpers.ts:runGit` (`spawnSync` `timeout`)                              | one `git merge-base --is-ancestor`, or the `git fetch` of both commits after it; killed after                                                                                                               | 120 s each                       | A fetch of two commits from GitHub, when production serves a newer commit this clone lacks. Never ran in the 19: production served the exact sha, which needs no git. The unit test runs real git with no bound (HAR-121)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `git could not compare <a> and <b> (exit killed), even after fetching both from origin`                                                                      |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`firstOf`)                       | the first of a step's outcomes to show: the password page or `usernameError`; the code box, method list, KMSI or the app; and so on                                                                         | 30 s each                        | Kept at 30 s on the measurements: the UPN and password pages, from the click on **Sign in** to Microsoft's answer after the password, took **1.6–3.7 s in total** over the 18 passing attempts, so one page gets more than 8× that whole sequence. The whole sign-in step took 2.5–13.4 s (2.5, 3.2, 3.5, 3.5, 3.5, 3.6, 3.9, 4.2, 4.5, 4.5, 5.0, 12.1, 12.3, 12.3, 12.4, 13.1, 13.3, 13.4 s); the 12–13 s ones spend about 10 s after Microsoft, on the API's cold `GET /devices` (the `APP_TIMEOUT_MS` row). The one failure (44940008836, attempt 1, 32.3 s) waited the full 30 s on the password step; its re-run took 3.35 s for both pages. Nothing measured says a longer bound would have passed it, so it is not raised and nothing retries; the step now writes `sign-in-diagnostic.txt` (below) to tell a slow page from a changed one | `Microsoft sign-in page changed at step <step>: none of <outcomes> appeared within 30 s (on <origin><path>)`                                                 |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`fillAt`)                        | a field (UPN, password, code) to be visible, then to take the value                                                                                                                                         | 30 s each                        | As the row above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `Microsoft sign-in page changed at step <step>: <selector> did not appear or take input within 30 s (on <origin><path>)`                                     |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`clickAt`)                       | **Next**, **Sign in**, a method, **No** on "Stay signed in?" to be clickable                                                                                                                                | 30 s                             | As the row above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `Microsoft sign-in page changed at step <step>: <selector> could not be clicked within 30 s (on <origin><path>)`                                             |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (the Enter press)                 | the code box to take Enter                                                                                                                                                                                  | 30 s                             | As the row above. Never reached in the 19 (no second factor asked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `Microsoft sign-in page changed at step totp: #idTxtBx_SAOTCC_OTC did not take Enter within 30 s (on <origin><path>)`                                        |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`waitForURL`)                    | the browser back on the app's origin after Microsoft                                                                                                                                                        | 30 s                             | As the row above. Measured: inside the 0.8–11.0 s from Microsoft's last page to signed-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `Microsoft sign-in page changed at step return to app: the browser did not come back to the app (<origin>) within 30 s (on <origin><path>)`                  |
| `microsoft-sign-in.ts` (`waitForTimeout(left + 250)`)                    | the next 30 s TOTP window, when the current one has under 5 s left                                                                                                                                          | at most 5.25 s, a fixed wait     | A code typed in its last seconds can expire before Microsoft checks it (HAR-99). It cannot time out; it notes `Waiting <s> s for the next TOTP window`. Never reached in the 19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | — (a fixed wait). A code Microsoft still rejects: `Microsoft rejected the TOTP code (step totp): check ACCEPTANCE_USER_TOTP_SECRET and this machine's clock` |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (header `toHaveText`)             | the app header to show the signed-in user                                                                                                                                                                   | 30 s                             | The app's own render after the redirect. Measured, with the `GET /devices` poll below: 0.8–11.0 s from Microsoft's last page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `the app header did not show the signed-in user within 30 s` (Playwright adds the locator and `Timeout 30000ms exceeded`)                                    |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`GET /devices` poll)             | the page's `GET /devices` to answer `200`                                                                                                                                                                   | 30 s                             | A dev Function App cold start: about 10 s in the 6 slow attempts (10.1–11.0 s with the header), matching the API suite's 9.4 s cold start above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `GET /devices did not answer 200 within 30 s of sign-in`                                                                                                     |
| `browser-proof.live.ts:TWIN_SYNC_TIMEOUT` (simdevice `--timeout`)        | step 4's `simdevice --twin --count 0`: the twin's GETs and the claim report, in the child (Go); it exits `1` when one does not come                                                                         | 60 s                             | HAR-141. The same bound the API suite's `--twin --count 0` checks use (the rows above): one MQTT connection and a twin round trip. The device is registered with DPS already (the job's enrol step), so the run reuses the cached assignment. Measured in run 45133256919 (`main` at 9a4ce8b, 2026-11-23): the whole of step 4, this sync, the claim-code read and the claim included, 1.3 s                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `the twin sync failed: simdevice exited 1: <stderr's first line, redacted>`                                                                                  |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`waitForResponse`, claim)        | the `POST /devices/claim` the claim page sends                                                                                                                                                              | 30 s                             | HAR-141. One API request that reads and patches the device twin, cold start included (as `GET /devices`). Measured in run 45133256919 (`main` at 9a4ce8b, 2026-11-23): inside step 4's 1.3 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `POST /devices/claim (claiming <device>) did not answer within 30 s`                                                                                         |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`waitForResponse`, release)      | the `DELETE /devices/{id}` **Yes, release** sends, in step 9 (and step 3 when an earlier run left the device claimed)                                                                                       | 30 s                             | HAR-141. One API request that patches the device twin, as the claim. Measured in run 45133256919 (`main` at 9a4ce8b, 2026-11-23): the whole release step 0.6 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `DELETE /devices/<device> (releasing it) did not answer within 30 s`                                                                                         |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`toHaveText`, connection)        | in step 8, the device row's connection text to say when IoT Hub last heard from the device (`Connected · last heard <age> ago` or `Offline · last heard <age> ago`) after the devices page's `GET /devices` | 30 s                             | HAR-143. One `GET /devices`, which reads each device's twin, and a render. The web device is a standing one that synced in step 4 and sent in step 6, so IoT Hub has heard from it. Measured 0.1 s (Deploy Dev App run 45146229868)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `<device>'s row did not say when it was last heard from within 30 s`                                                                                         |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`GET /cooks?status=active` poll) | the page's active-cooks request to answer `200`                                                                                                                                                             | 30 s                             | As `GET /devices`. Since HAR-141 only in step 3, when an earlier run left the device claimed. Measured (as the old step 4, before HAR-141): 0.0 s in all 18 that reached it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `GET /cooks?status=active did not answer 200 within 30 s`                                                                                                    |
| `live-panel.ts:expectLivePanelConnected` (`APP_TIMEOUT_MS`)              | the cook page's live panel to be connected (`waiting`, `live`, or stale "No reading for …"); "Sign in again" fails at once                                                                                  | 30 s, read every 250 ms          | Negotiate plus the SignalR start (HAR-101). Measured: the whole of step 5, form included, 0.4–2.9 s in the 17 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `the live panel is not connected within 30 s: not connected (data-state <state>, badge "<badge>")`; `… and has stopped trying: …` for "Sign in again"        |
| `browser-proof.live.ts:PUSH_TIMEOUT_MS` (`waitForFunction`)              | the live panel to be `live` showing the value simdevice sent                                                                                                                                                | 60 s, read every 100 ms          | simdevice → IoT Hub → Event Hub → Function → SignalR → browser (HAR-99). Measured `web-push-ms` 416–19,748 ms over the 17 that got there; step 6 took 10.1–19.8 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `The live panel did not show grill <value> within 60 s (it shows <value or nothing>, data-state <state>): <cause>`                                           |
| `playwright.live.config.ts:expect.timeout`                               | every other `expect` in the proof without its own bound (`toBeVisible`, `toHaveURL`, `toHaveText`, `toHaveCount`, `toHaveValue`)                                                                            | 30 s each                        | Page renders and single API calls, as the rows above. Each message names what was expected, e.g. `starting the cook did not open its page`, `the cook did not complete`, `the live panel is still on screen after the stop`; since HAR-141 also `the claim page did not take ?deviceId=`, `a successful claim did not open the devices page`, `<device> is not on the devices page after the claim` and `<device> is still on the devices page after the release`                                                                                                                                                                                                                                                                                                                                                                                 | Playwright: the expect's message, the locator, and `Timeout 30000ms exceeded`                                                                                |
| `playwright.live.config.ts:actionTimeout`, `navigationTimeout`           | every click, fill and `goto` on the app without its own bound                                                                                                                                               | 30 s each; 60 s for a navigation | The same app renders; the first `goto` loads the app from Vercel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Playwright: the action, the locator or URL, and `Timeout <n>ms exceeded`                                                                                     |

#### The sign-in diagnostic

When a sign-in step fails, `signInWithMicrosoft` writes
`sign-in-diagnostic.txt` to the test's output dir, next to `failure.png`
(`dist/.playwright/web-e2e-live/test-results/<test>/`). It holds the failure's
first line, the page URL's origin and path (never the query or fragment), the
page title, whether each selector in the `MS` map is present and visible, and
the text of Microsoft's error containers (`#usernameError`, `#passwordError`,
`#idSpan_SAOTCC_Error_OTC` and any `[role="alert"]`). It never reads an
input's value, cookies or a screenshot, and the UPN, password, TOTP secret and
every value typed are replaced by `[redacted]` wherever they appear, even in
an error Microsoft echoes. `live/sign-in-diagnostic.test.ts` proves it on a
fake page whose inputs hold those values and whose URL carries tokens.

In CI the file is uploaded on failure, in the `web-acceptance-diagnostics`
artifact with the screenshot, only after the job's leak check has passed on
it: the check scans every diagnostic for the same secrets as the proof's log,
and deletes one it finds anything in before the upload step runs (see
[Secrets in the CI log](#secrets-in-the-ci-log)).

### The iOS proof's waits

The [live iOS proof](#live-ios-proof) (`apps/ios/MeatGeekLiveUITests`, run by
`apps/ios/scripts/run-live-proof.sh`) waits on Microsoft's sign-in pages, the
app, the dev API and simdevice, with the same columns. Every bound is a
constant in `LiveBound` (`MeatGeekLiveUITests/LiveDriver.swift`) or at the top
of the runner script. The app's other tests (`MeatGeekKitTests`,
`MeatGeekUITests`) have none of these: they run on fakes and wait with no
deadline of their own (apps/ios/README.md, "Run the tests").
`tools/no-real-time` leaves only `apps/ios/MeatGeekLiveUITests/**` out of
scope for this; it has no Swift rules yet (see its README).

Every wait below that looks at the screen goes through one poll, `LivePoll`
(`LiveDriver.swift`): `Live.waitFor`, `waitGone`, `waitLabel`, `firstOf`,
`paste` and the pushed-reading watch. **A bound measures Microsoft, the app
or the API, not XCUITest's own queries.** One look can take tens of seconds
on CI: in Deploy Dev App 45465463113 one existence query hung 30.5 s while
Microsoft replaced its page mid-navigation, and one sweep of the "second
factor" outcomes took 47 s, so the 30 s bound ran out before the settled page
had been looked at once. So a wait fails only after a look that **started**
at or after its deadline found nothing; a look that began before the deadline
and ran past it is never the last. A wait therefore takes at most its bound,
plus one 0.25 s poll, plus one look. `LiveOfflineTests` checks this on a fake
clock (`testAPollLooksAgainAfterALookThatRanPastTheDeadline`,
`testAPollFailsAfterOneLookStartedAtTheDeadline`).

"Measured" is the rehearsals this was built on (HAR-169): the app-side steps
on UI test mode's stub, and the runner end to end in a fresh simulator with a
fake simdevice, signing in as far as Microsoft's answer to the UPN. The first
green `ios-acceptance` runs on `main` are the first measurements against dev;
until they are added here, each bound is sized on the web proof's measured
waits for the same thing.

| Where (file:symbol)                                                        | What it waits for                                                                                                                                                                                                                                                    | Bound                                         | Why that long                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Live.xctestplan` (`defaultTestExecutionTimeAllowance`, `maximum…`)        | the whole test: XCTest's hang guard                                                                                                                                                                                                                                  | 900 s                                         | The sum of the bounds below on the slowest path is about 7 min. Under the job's 45 min, which also holds the app's build (most of the job)                                                                                                                                                                                                             |
| `LiveBound.app` (launch `firstOf`)                                         | the app's first screen: Sign in with Microsoft, the signed-in tabs (an account left from an earlier run), or the app's sign-in error                                                                                                                                 | 30 s                                          | The app's own launch, with no network call before it. Measured: 2.8 s, launch included                                                                                                                                                                                                                                                                 |
| `LiveBound.app` (`MicrosoftSignIn.openSheet`, sign-in start)               | after **Sign in with Microsoft**, the tap taken: the app's "Signing in…" (MSAL starting), or already the system alert, Microsoft's UPN page or the app's sign-in error                                                                                               | 30 s                                          | One app screen change. Measured: "Signing in…" at the first look after the tap                                                                                                                                                                                                                                                                         |
| `LiveBound.consent` (`MicrosoftSignIn.openSheet`, `firstOf`)               | once the app says "Signing in…", MSAL's own outcome: the system "“MeatGeek” Wants to Use “login.microsoftonline.com” to Sign In" alert, Microsoft's UPN page, the app's sign-in error, or its signed-out screen again (MSAL reported the sign-in cancelled)          | 30 s                                          | Each outcome ends the wait, so a failure is never a window running out over an app that already said why. On a timeout it names what is on screen (`SignInScreen`: the app's state, any system alert, whether the sheet has a text field) and keeps a `failure` screenshot. Measured (locally, 7 fresh simulators): the alert 1.2–2.5 s after the tap  |
| `LiveBound.signInStep` (`MicrosoftSignIn.openSheet`, after **Continue**)   | Microsoft's UPN page (its text field), the app's sign-in error, or its signed-out screen                                                                                                                                                                             | 30 s                                          | Microsoft's first page load. Measured: the UPN page 3.7–4.1 s after **Continue**                                                                                                                                                                                                                                                                       |
| `LiveBound.signInStep` (`firstOf`, each)                                   | the password page (or Microsoft's error on the UPN page); the second factor, "Stay signed in?" or the app; the code's result; the app back after Microsoft's last page                                                                                               | 30 s each                                     | As the web proof's `STEP_TIMEOUT_MS`: its UPN and password pages took 1.6–3.7 s together over 18 passing runs. Measured here: Microsoft's answer to an unknown UPN in 14.6 s from launch, alert and page load included                                                                                                                                 |
| `LiveBound.pasteMenu`, `pasteRetap` (`Live.paste`)                         | the edit menu's **Paste** after a tap on a field, tapping again every 2 s                                                                                                                                                                                            | 10 s, re-tapped every 2 s                     | Measured: it shows after the first or second tap, within 4 s, on Microsoft's fields and the app's claim code field; on CI (45413956495) at the second look, 31 s after the first, as each look there took up to 17 s. One look is: Paste there, or a tap and up to 2 s for it; as every wait, it fails only after a look started at or after the bound |
| `LiveBound.pasted`, `LiveBound.poll` (`Live.paste`)                        | from the tap on **Paste** to the field holding the pasted value (the same text; one bullet per character in the password field; the same symbols in the app's formatted claim code field), read every 0.25 s; only then is Return pressed and the pasteboard emptied | 20 s                                          | The paste lands after the tap returns: in the sign-in sheet another process reads the pasteboard. Measured: 2.1 s locally on the UPN and password fields. On the first `main` run (45413956495) one tap took 10 s and nothing checked the field: the pasteboard was emptied straight after the tap and Microsoft got an empty UPN                      |
| `LiveBound.totpMargin`, `totpSlack` (`MicrosoftSignIn.enterCode`)          | the next 30 s TOTP window, when the current one has under 5 s left                                                                                                                                                                                                   | at most 5.25 s, a fixed wait                  | A code pasted in its last seconds can expire before Microsoft checks it, as in the web proof. It notes `Waiting <s> s for the next TOTP window`                                                                                                                                                                                                        |
| `LiveBound.app` (Devices list, claim, device screen, start, stop, release) | the Devices tab's list (or its error); the claim form closing with the device listed (or the claim's error); Start cook; the new cook's screen `Status, Active`; `Status, Completed`; the row gone                                                                   | 30 s each                                     | One screen and one API call, a dev Function App cold start (about 10 s) included, as the web proof's `APP_TIMEOUT_MS`. Measured on the stub: the whole claim step 11.6 s, start 9.3 s, stop 4.2 s, release 7.1 s (mostly XCUITest typing and animations)                                                                                               |
| `LiveBound.push`, `LiveBound.poll` (`Proof.pushedReading`)                 | from the tap on **Start** to the cook screen showing a reading newer than the first it showed, the badge `live` and the grill not "—"; read every 0.25 s                                                                                                             | 90 s                                          | The cook screen opening, negotiate and the SignalR start (the web proof allows 30 s), then one push (the web proof measured 0.4–19.7 s from send to screen), then up to one 2 s send interval. Each measurement is the run's `METRIC ios-push-ms`                                                                                                      |
| `run-live-proof.sh:TWIN_SYNC_TIMEOUT` (simdevice `--timeout`)              | `simdevice --twin --count 0` before the claim code is read: the twin's GETs and the claim report                                                                                                                                                                     | 60 s                                          | As the web proof's `TWIN_SYNC_TIMEOUT`: one MQTT connection and a twin round trip, the device already registered by the job's enrol step                                                                                                                                                                                                               |
| `run-live-proof.sh:FIRST_READING_BOUND_S`                                  | simdevice's first sent reading, before the test starts; checked every 1 s                                                                                                                                                                                            | 60 s                                          | One DPS-mode connection with the cached assignment and one send. Seconds in practice                                                                                                                                                                                                                                                                   |
| `run-live-proof.sh:SEND_COUNT`, `SEND_INTERVAL`                            | (not a wait) how long simdevice sends: 900 readings, 2 s apart                                                                                                                                                                                                       | 30 min at most; stopped when the runner exits | Longer than the job, so the readings never stop before the test does; the runner's exit trap stops simdevice whatever happened                                                                                                                                                                                                                         |
| `app-deploy-dev.yml` `ios-acceptance` `timeout-minutes`                    | the whole job                                                                                                                                                                                                                                                        | 45 min                                        | A cold build of the app and its packages on `macos-26` (most of the job: `ci.yml`'s `ios` job, which builds and runs 7 UI tests, took 19 min on 2026-11-24), the simulator, and the test's 15 min allowance                                                                                                                                            |

## Running it locally against dev

The suite takes its inputs from the environment. If a required one is missing
it fails at once and names the variable; it never skips silently. simdevice
runs only in [DPS mode](#dps-mode-har-138), as the device's own certificate,
the way a real Pi enrols (HAR-146): there is no device key to fetch.

| Variable                       | Value                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ACCEPTANCE_BASE_URL`          | The API root, including `/api`, e.g. `https://<function-app-host>/api`                                 |
| `ACCEPTANCE_BEARER_TOKEN`      | An Entra access token for the API audience                                                             |
| `ACCEPTANCE_PEER_BEARER_TOKEN` | A token for the same audience as a second caller who owns no devices (HAR-67)                          |
| `ACCEPTANCE_DPS_ID_SCOPE`      | The dev DPS's ID scope                                                                                 |
| `ACCEPTANCE_SIM_DEVICE_ID`     | The simulated device's id, `meatgeek-dev-simulated-smoker` in dev                                      |
| `ACCEPTANCE_SIM_STATE_DIR`     | The simulated device's state dir, made by `simdevice identity init` ([DPS mode](#dps-mode-har-138))    |
| `ACCEPTANCE_SIMDEVICE_BIN`     | Path to the built `simdevice` binary, e.g. `$PWD/apps/data-pusher/dist/simdevice` (absolute is safest) |

```bash
az login   # once, as a user the dev tenant knows

# The dev Function App's host name.
HOST=$(az functionapp list -g meatgeek-v2-dev-rg --query '[0].defaultHostName' -o tsv)

export ACCEPTANCE_BASE_URL="https://${HOST}/api"
export ACCEPTANCE_BEARER_TOKEN=$(az account get-access-token \
  --scope api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user \
  --query accessToken -o tsv)

# The isolation proof's second caller: a different user, signed in from its own
# az config directory so your own login is untouched. It must own no devices.
AZURE_CONFIG_DIR="$HOME/.azure-acceptance-peer" az login   # once, as the second user
export ACCEPTANCE_PEER_BEARER_TOKEN=$(AZURE_CONFIG_DIR="$HOME/.azure-acceptance-peer" \
  az account get-access-token \
  --scope api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user \
  --query accessToken -o tsv)

# The telemetry round-trip: build simdevice (needs Go) and point at it.
make -C apps/data-pusher build
export ACCEPTANCE_SIMDEVICE_BIN="$PWD/apps/data-pusher/dist/simdevice"
export ACCEPTANCE_SIM_DEVICE_ID=meatgeek-dev-simulated-smoker
# The device's own identity, enrolled once: see "DPS mode (HAR-138)" below.
export ACCEPTANCE_SIM_STATE_DIR="$HOME/.meatgeek-acceptance/$ACCEPTANCE_SIM_DEVICE_ID"
export ACCEPTANCE_DPS_ID_SCOPE=$(az iot dps list -g meatgeek-v2-dev-rg \
  --query '[0].properties.idScope' -o tsv)

npx nx run api:acceptance
```

The token is a delegated token for the `access_as_user` scope on the dev API
registration, which the dev Function App's Easy Auth accepts (see
[Authentication](../api/authentication.md)). Cooks written by the run land in
**your** user's partition. So does the simulated device's claim: if the CI
identity holds `meatgeek-dev-simulated-smoker`, the claim fails for you
(`403 CLAIM_REFUSED`), which is that proof working as designed. CI also enrols
a new certificate for each of its standing devices every run
([In CI](#in-ci-har-139)), which replaces yours. Point
`ACCEPTANCE_SIM_DEVICE_ID` and its state dir at a device of your own to run it
by hand.

In CI the caller is the dev app-publish identity instead: the `acceptance` job
mints an app-only token for `<audience>/.default`, so its cooks land in that
service principal's partition. The same step also signs in, from a separate
`az` config directory, as the zero-role acceptance peer
`meatgeek-v2-dev-acceptance-peer` (`vars.AZURE_ACCEPTANCE_PEER_CLIENT_ID` on
the `development` environment, set by bootstrap, HAR-61) and hands the suite a
second masked app-only token as `ACCEPTANCE_PEER_BEARER_TOKEN`, after checking
that its `appid`/`azp` claim is the peer's and not app-publish's (HAR-65). The
isolation proof (HAR-67) sends as it. The same job builds simdevice, gives each
simulated device its own X.509 identity enrolled in DPS, and runs the suite
(see [In CI](#in-ci-har-139) and
[CI/CD](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)). The proof results and the RU-per-route table
also go to the workflow run's summary page. The target is never cached by Nx, so every invocation
calls the live system.

### DPS mode (HAR-138)

simdevice is the device, with its own X.509 identity in a state dir, enrolled
in the dev Device Provisioning Service (HAR-131); there is no device key to
fetch. Each device gets its own state dir. Since HAR-146 this is the only mode:
the runner has no connection-string inputs.

| Variable                     | Value                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `ACCEPTANCE_DPS_ID_SCOPE`    | The dev DPS's ID scope. Required                                                                   |
| `ACCEPTANCE_DPS_ENDPOINT`    | Optional. The DPS global endpoint; simdevice defaults to `global.azure-devices-provisioning.net`   |
| `ACCEPTANCE_SIM_STATE_DIR`   | The simulated device's state dir. Required                                                         |
| `ACCEPTANCE_CHART_STATE_DIR` | Optional: the [chart device](#the-chart-device-har-84)'s state dir                                 |
| `ACCEPTANCE_WEB_STATE_DIR`   | The [browser proof](#inputs)'s device's state dir                                                  |
| `ACCEPTANCE_DPS_HOST`        | HAR-140: the DPS service host, `<dps_name>.azure-devices-provisioning.net`, for the device scripts |
| `ACCEPTANCE_IOT_HUB_HOST`    | HAR-140: the IoT hub host (`iot_hub_hostname`), for the device scripts                             |

- Each simdevice run gets `MEATGEEK_DPS_ID_SCOPE`, `MEATGEEK_DEVICE_ID` (the
  device's id variable), `MEATGEEK_STATE_DIR` and, if set,
  `MEATGEEK_DPS_ENDPOINT`, and no other device's inputs. No `SIMDEVICE_*`
  variable from the runner's own environment reaches it.
- A missing required input stops the run before any proof, naming the
  variable (never its value). The chart device's id and state dir go
  together: one without the other stops the run, naming both.

Create each device's identity once, enrol its certificate with your own
`az login`, then export the variables. `enrol-device.sh` uses `--auth-type key`
by default: `az` fetches the DPS and hub keys with your ARM rights, which the
owner has (see [`apps/data-pusher/deploy/README.md`](../../apps/data-pusher/deploy/README.md)).

```bash
make -C apps/data-pusher build
export ACCEPTANCE_SIMDEVICE_BIN="$PWD/apps/data-pusher/dist/simdevice"
export ACCEPTANCE_SIM_DEVICE_ID=meatgeek-dev-simulated-smoker
export ACCEPTANCE_SIM_STATE_DIR="$HOME/.meatgeek-acceptance/$ACCEPTANCE_SIM_DEVICE_ID"

# Once per device: the device makes its own key and prints only its certificate.
mkdir -p "$HOME/.meatgeek-acceptance"
"$ACCEPTANCE_SIMDEVICE_BIN" identity init --device-id "$ACCEPTANCE_SIM_DEVICE_ID" \
  --state-dir "$ACCEPTANCE_SIM_STATE_DIR" > "$ACCEPTANCE_SIM_STATE_DIR.pem"
apps/data-pusher/deploy/enrol-device.sh --device-id "$ACCEPTANCE_SIM_DEVICE_ID" \
  --certificate "$ACCEPTANCE_SIM_STATE_DIR.pem"

export ACCEPTANCE_DPS_ID_SCOPE=$(az iot dps list -g meatgeek-v2-dev-rg \
  --query '[0].properties.idScope' -o tsv)

# Optional: the chart device, the same way.
export ACCEPTANCE_CHART_DEVICE_ID="${ACCEPTANCE_SIM_DEVICE_ID}-chart"
export ACCEPTANCE_CHART_STATE_DIR="$HOME/.meatgeek-acceptance/$ACCEPTANCE_CHART_DEVICE_ID"
# ... identity init and enrol-device.sh for it, as above ...

npx nx run api:acceptance   # with the base URL and the two tokens, as above
```

The certificate is public; the key never leaves the state dir. Keep the state
dir out of the repository and never paste anything from it into a ticket or a
log: it holds the device key and, once the device has read its twin, its claim
code (HAR-134). The runner never logs a claim code: its redactor masks anything
shaped like one (`XXXX-XXXX-XXXX`), and so does the browser proof's. Each
harness has a `readClaimCode(bin, stateDir)` helper
(`apps/api/acceptance/lib/claim-code.ts`, `apps/web-e2e/live/simdevice.ts`) for
the claim proofs that come next. It runs
`simdevice claim-code --state-dir <dir>` and returns
`{ deviceId, state, claimCode?, expiresAt? }`, a "no claim yet" result on exit
3, and on any other failure an error with the exit code and stderr, never
stdout.

### In CI (HAR-139)

CI's simulated devices get their identity the way the owner's Pi does. No hub
identity is created for them and no device key is read. The
`acceptance` job's "Enrol the simulated devices through DPS" step does this
for `<simulated_device_id>` and `<simulated_device_id>-chart`. The
`web-acceptance` job's "Enrol the web device through DPS" step does the same
for `<simulated_device_id>-web`. For each device:

1. **Migration, once.** The step reads only the authentication type of the
   device's hub identity (`az iot hub device-identity show` with
   `--query authentication.type`). If the identity still uses SAS (symmetric key)
   authentication from before HAR-139, the step deletes it, so DPS creates an
   X.509 identity when the device registers, and logs `migrated <id>`.
   Otherwise, or if there is no identity, it logs `ok <id>`. Any error other
   than "device not found" fails the step.
2. **A new key every run.** `simdevice identity init` makes the device's key
   and certificate in a fresh state dir, `$RUNNER_TEMP/devices/<id>`, and
   prints only the certificate, to `$RUNNER_TEMP/devices/<id>.pem`. The key is deleted with the runner.
3. **Enrolment.** `apps/data-pusher/deploy/enrol-device.sh` enrols that
   certificate (`--auth-type login`, with the DPS and hub host names) and
   prints its one result line. The first run prints `enrolled <id>`. Every
   later run prints `certificate replaced <id>`, because the key is new, so
   every run exercises the re-imaged-Pi path: DPS registration with a new
   certificate must update the hub identity. Any non-zero exit fails the
   step. The ids are stable, so there are no enrollments to clean up.
4. **Registration.** `simdevice --twin --count 0 --timeout 2m`, in DPS mode from that state
   dir, registers the device with DPS, reads and reports its twin, sends no
   reading, and logs `registered <id>`. This makes sure the device's hub
   identity exists before the suite's first `POST /cooks` writes
   `desired.activeCookId` to its twin. Without it, after a migration (or for
   a new device id) that write found no device, and the device's first
   registration then created a new identity with an empty twin
   (`desired.activeCookId is null`, run 45080482155). If it fails, the step
   prints simdevice's stderr and fails.

The DPS and the hub are passed by host name
(`<dps_name>.azure-devices-provisioning.net` and `iot_hub_hostname`). CI's
identity holds only data-plane roles (IoT Hub Registry Contributor and Device
Provisioning Service Data Contributor), with no ARM read, and with a host name
the script makes no ARM call (see
[its README](../../apps/data-pusher/deploy/README.md#host-names-no-arm)).

The suite step then sets `ACCEPTANCE_DPS_ID_SCOPE` (Terraform output
`dps_id_scope`), `ACCEPTANCE_SIM_STATE_DIR` and `ACCEPTANCE_CHART_STATE_DIR`
to those state dirs. The browser proof's step sets `ACCEPTANCE_WEB_STATE_DIR`
the same way. The
registration in step 4 is a real-time wait ([its row](#real-time-waits)); the
suite's simdevice runs reuse the assignment it cached in the state dir.

HAR-140: the suite step also sets `ACCEPTANCE_DPS_HOST`
(`<dps_name>.azure-devices-provisioning.net`) and `ACCEPTANCE_IOT_HUB_HOST`
(Terraform output `iot_hub_hostname`). The suite runs `enrol-device.sh` and `delete-device.sh`
itself, as the same identity and in the same host-name mode, for the fresh
`acceptance-*` devices it enrols and deletes each run
([Fresh devices](#fresh-devices-har-140)). Without them, every fresh-device
step fails with a message naming both variables.

### The chart device (HAR-84)

A second standing IoT Hub device, `<simulated device id>-chart`
(`meatgeek-dev-simulated-smoker-chart` in dev), is for the cook-chart RU proof
of goal HAR-71. That proof keeps one active cook running on its device across
runs, with 12 hours of readings in it. It cannot use the first device:
`device-twin.proof.ts` starts and stops a cook there on every run, and a
standing active cook would make that proof's `POST /cooks` fail with `409`.
The CI job's "Enrol the simulated devices through DPS" step gives the chart
device its identity the same way as the first ([In CI](#in-ci-har-139)), and
the suite runs it in DPS mode with `ACCEPTANCE_CHART_STATE_DIR`; its id is
derived in the workflow, not in Terraform.

Two more variables name it. The runner treats them as optional, but set both or
neither: one without the other stops the run at once, naming both. The cook-chart
proof (HAR-87, `volume-cook-chart.proof.ts`) needs them: without them it fails
at its first step, naming both, and sends nothing.

| Variable                     | Value                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| `ACCEPTANCE_CHART_DEVICE_ID` | The chart device's id, `meatgeek-dev-simulated-smoker-chart` in dev |
| `ACCEPTANCE_CHART_STATE_DIR` | The chart device's state dir ([DPS mode](#dps-mode-har-138))        |

A proof reads the id as `api.chartDeviceId` (`undefined` when the run was not
given it) and sends as the device with
`api.runSimDevice(args, { device: 'chart' })`. The runner hands that simdevice
run the chart device's DPS variables; no simdevice run gets the inputs of a
device it is not sending as. Without the variables, a chart run fails as
`simdevice (chart) → not started`.

## Live browser proof

The suite above proves the API. The live browser proof (HAR-99, goal HAR-71)
proves the **production web app**, `https://meatgeekv2-web.vercel.app`, end to
end in a real browser. Since HAR-141 the acceptance user claims the web device
through the app's claim page with the code the device reports, and releases it
at the end, so every run starts with the device unclaimed:

1. **Wait for the build.** It polls `<web>/version.json` every 15 s, for at
   most 15 min, until the `sha` there is `EXPECTED_WEB_SHA` or a commit that
   contains it (`git merge-base --is-ancestor`, fetching either commit from
   `origin` if this clone lacks it), so a newer `main` commit already in
   production also counts. On timeout the failure names both shas.
2. **Sign in** through Microsoft's real pages as the acceptance user: UPN,
   password, then a TOTP code computed from the user's authenticator secret
   (choosing the authenticator-app code if Microsoft asks which method), then
   **No** on "Stay signed in?". Signed in means the app header shows the user
   and `GET /devices` answered `200`. If Microsoft asks for no second factor,
   the run notes it and carries on.
3. **Clean slate.** If `ACCEPTANCE_WEB_DEVICE_ID` is still on the devices
   page (an earlier run failed before it released it), a cook left running on
   it (a "Cooking: …" link) is opened and stopped through the UI, since a
   release is refused while a cook runs, and the device is then released
   through the UI as in step 9.
4. **Claim.** `simdevice --twin --count 0 --timeout 60s` in DPS mode (the
   spawn `startSimDevice` in `apps/web-e2e/live/simdevice.ts` uses) does a full
   twin sync, so a device released since its last sync sees the new claim
   generation and mints a fresh code. `readClaimCode` (that is,
   `simdevice claim-code --state-dir $ACCEPTANCE_WEB_STATE_DIR`) must then
   report `unclaimed` with a code; `claimed` means another user holds the device, and the step says so.
   The proof opens `/devices/claim?deviceId=<id>`, checks the id is
   prefilled, types the code and the name `Web acceptance smoker`, and
   submits: `POST /devices/claim` must answer `201`, the app go to `/` and the
   device be listed. On a `403` the step asks `DELETE /devices/{id}` (with the
   page's token) whether another user owns the device
   (`403 DEVICE_NOT_OWNED`) or nobody does (`404`), and names which; the device is
   not the acceptance user's, so that request changes nothing.
5. **Start a cook** through the UI, named `acceptance web <run id>` (the
   GitHub run id, or a UTC timestamp locally). Its page opens and the live
   panel is connected: `waiting`, `live`, or `stale` with a "No reading for …"
   badge. The web device is a standing device, so the panel backfills the last
   run's reading and a run more than 90 s after the previous one opens stale
   while connected; step 6 proves a fresh reading arrives. "Connecting…" and
   "Reconnecting…" still showing after 30 s fail the step; "Sign in again"
   fails it at once, since the app tries nothing more after it. The check is
   `expectLivePanelConnected` in `apps/web-e2e/live/live-panel.ts`, and the
   mocked browser test `apps/web-e2e/src/live-panel-connected.spec.ts` runs it
   against the built app with an old reading seeded and with negotiate
   answering 401.
6. **A pushed reading.** simdevice sends 10 readings, 1 s apart, as the web
   device, with a grill value no earlier run is likely to have left on screen
   (300.0 to 399.9 °F, from the run's start time; `simdevice --grill`). Within
   60 s the live panel must be `data-state="live"` showing that value.
7. **Stop** through the UI: the cook shows `completed` and the live panel goes.
8. **Last heard** (HAR-143). Back on the devices page, whose `GET /devices`
   reads each device's IoT Hub twin, the device's row must say when the hub
   last heard from it: `Connected · last heard <age> ago` or
   `Offline · last heard <age> ago`, and that time must be no earlier than
   when step 4's twin sync began, less 5 min of clock skew: an earlier run's
   time fails the step, as do `Offline · never heard from` and
   `Status unknown` (the API could not read the twin). The step logs the text
   it saw.
9. **Release** through the UI: **Release** on the device's row, then **Yes,
   release** on its confirm step. `DELETE /devices/{id}` must answer `204` and
   the row leave the list.
10. **Cleanup.** If a cook from step 5 was not stopped on screen, it is stopped
    through the API with the token the page itself sent (taken from the page's
    requests, never printed). If the device this run claimed was not released
    on screen, it is released the same way (`DELETE /devices/{id}`; only the
    status is logged). A device still left claimed is released by the next
    run's step 3.

It runs after every dev deploy, as the `web-acceptance` job in
`.github/workflows/app-deploy-dev.yml` (HAR-101; see
[CI/CD → Dev app deploy and live acceptance](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)),
in parallel with the API suite's `acceptance` job, with `EXPECTED_WEB_SHA` set
to the deployed commit. The job enrols the device `<simulated_device_id>-web`
through DPS and runs the proof's simdevice in DPS mode with
`ACCEPTANCE_WEB_STATE_DIR` ([In CI](#in-ci-har-139)), and takes the acceptance
user's UPN from the
`development` environment's `ACCEPTANCE_USER_UPN` variable and the password and
TOTP secret from its `ACCEPTANCE_USER_PASSWORD` and
`ACCEPTANCE_USER_TOTP_SECRET` secrets. The run summary gets one `PASS` or
`FAIL` line per step (printed by `apps/web-e2e/live/step-reporter.ts`), the two
`METRIC` lines and Playwright's summary line. A step then checks the proof's
raw output and its sign-in diagnostics for leaked secrets (see
[Secrets in the CI log](#secrets-in-the-ci-log)). On failure, and only after
that check has finished, the proof's screenshot and every sign-in diagnostic
that passed the check are uploaded as the `web-acceptance-diagnostics`
artifact, kept 7 days. You can still run it by hand, below.

### Inputs

All from the environment. Global setup checks them before a browser starts: a
missing one fails the run at once, naming every missing variable, never a
value.

| Variable                      | Value                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `WEB_BASE_URL`                | The web app's origin. Optional, default `https://meatgeekv2-web.vercel.app`                                         |
| `EXPECTED_WEB_SHA`            | The full 40-character commit production must serve (or contain), usually the merge commit                           |
| `ACCEPTANCE_USER_UPN`         | The acceptance user's sign-in name, in the dev tenant                                                               |
| `ACCEPTANCE_USER_PASSWORD`    | Its password                                                                                                        |
| `ACCEPTANCE_USER_TOTP_SECRET` | Its authenticator-app secret (base32; spaces, dashes, lower case and `=` padding are accepted)                      |
| `ACCEPTANCE_WEB_DEVICE_ID`    | The IoT Hub device the proof claims and sends as (`<simulated device id>-web`). Unclaimed, or the acceptance user's |
| `ACCEPTANCE_WEB_STATE_DIR`    | That device's state dir ([DPS mode](#dps-mode-har-138)). Only simdevice's own environment gets it                   |
| `ACCEPTANCE_DPS_ID_SCOPE`     | The dev DPS's ID scope                                                                                              |
| `ACCEPTANCE_SIMDEVICE_BIN`    | Path to the built `simdevice`, the same binary the API suite uses                                                   |

`ACCEPTANCE_DPS_ENDPOINT` is optional, as for the API suite. simdevice runs in
DPS mode, the only mode (HAR-146), which is also where the device mints the
claim code step 4 needs (HAR-141).

The proof writes none of the password, the TOTP secret or code, the claim
code or any token anywhere. Playwright's trace, video,
HTML report, failure page snapshot (`error-context.md`) and automatic
screenshot are all off for it (`apps/web-e2e/playwright.live.config.ts`),
because the sign-in pages show the UPN and what was typed, and the claim form
the claim code; none of them records the `POST /devices/claim` request body
either. It takes its own full-page screenshot on failure, and only once
sign-in has finished and the browser is back on the app, and never on the
claim page (`/devices/claim`), whose code field may still hold the code: it
logs `No failure screenshot: the claim page can show the claim code` instead.
After a successful claim the app has blanked the field and left that page. The
screenshot is `failure.png` under
`dist/.playwright/web-e2e-live/test-results/`. The sign-in diagnostic is
written during step 2, before the code is read in step 4, so it cannot hold
it. The code is passed to the page by `fill` only: no `expect` and no log line
names it.

### Secrets in the CI log

GitHub masks the password and TOTP secret (repository secrets) in the job
log, so the masked log cannot show whether the proof printed one. (Since
HAR-139 the job holds no device connection string; the device's key stays in
its state dir.) The `web-acceptance` job's leak
check (`.github/scripts/web-acceptance-leak-check.cjs`), which runs whether the
proof passed or not, checks the proof's **raw** output instead (the file `tee`
wrote, before masking), and every
`dist/.playwright/web-e2e-live/test-results/**/sign-in-diagnostic.txt`, and
fails the job if one holds:

- a connection string's `SharedAccessKey=` field;
- the password;
- the TOTP secret, as stored or normalized;
- any 6-digit TOTP code for any 30 s window from 35 min before the check to
  1 min after it, which covers the job's 30 min timeout. A code is matched
  only as a whole 6-digit number.
- anything shaped like a device claim code (HAR-134, `XXXX-XXXX-XXXX` in
  Crockford base32, not inside a longer dashed id such as a UUID). Nobody knows
  a claim code before the device mints it, so its shape is what is matched
  (HAR-138). That includes the bare value the proof types into the claim form
  (HAR-141): it is the code exactly as `simdevice claim-code` printed it, in
  that shape, so a line holding it alone, in a Playwright call log or as an
  input's value is found. The check does not read the code from the state dir:
  by the time it runs the device has been released and the code is used up,
  and a shape match already finds any code, this run's or not.
- a PEM private key block: a `-----BEGIN … PRIVATE KEY-----` line of any key
  type (HAR-139). Each simulated device now holds its own key.
- a JSON `claimCode` member with a string value, whatever the value's shape
  (HAR-139).

It prints one line per file and check (`leak check: proof log: password:
none`, and so on) and, on a hit, line numbers only, never the text it found.

It runs before the failure upload (HAR-126). A sign-in diagnostic with a
finding is deleted, so the upload cannot include it. If the check cannot finish
(it exits 2), it deletes every diagnostic it did not prove clean and the upload
step is skipped, because it uploads only when the check reports `checked`.

To run it locally on a directory of files, from the repository root:

```bash
ACCEPTANCE_USER_PASSWORD=... ACCEPTANCE_USER_TOTP_SECRET=... \
  node .github/scripts/web-acceptance-leak-check.cjs <proof-log> '<dir>/**/sign-in-diagnostic.txt'
```

It exits 0 when nothing is found, 1 when something is (and the diagnostics
with findings are deleted), and 2 when it could not finish. A missing proof
log is reported and skipped, not an error.

### Running it locally against production

Export the variables yourself, in your shell only (never in a file), then run
the `e2e-live` target. It needs Chromium for Playwright and Go for simdevice.

```bash
npx playwright install chromium          # once
make -C apps/data-pusher build           # builds dist/simdevice

export EXPECTED_WEB_SHA=$(git rev-parse origin/main)
export ACCEPTANCE_USER_UPN=...           # from wherever the team keeps the acceptance user
read -rs ACCEPTANCE_USER_PASSWORD && export ACCEPTANCE_USER_PASSWORD
read -rs ACCEPTANCE_USER_TOTP_SECRET && export ACCEPTANCE_USER_TOTP_SECRET
export ACCEPTANCE_WEB_DEVICE_ID=meatgeek-dev-simulated-smoker-web
export ACCEPTANCE_SIMDEVICE_BIN="$PWD/apps/data-pusher/dist/simdevice"
# The state dir of a device enrolled as in "DPS mode (HAR-138)" above.
export ACCEPTANCE_WEB_STATE_DIR="$HOME/.meatgeek-acceptance/$ACCEPTANCE_WEB_DEVICE_ID"
export ACCEPTANCE_DPS_ID_SCOPE=...       # the dev DPS's ID scope

npx nx e2e-live web-e2e
```

`read -rs` keeps the two secrets out of your shell history. The device must
already be enrolled in DPS, with its key in `ACCEPTANCE_WEB_STATE_DIR`
([DPS mode](#dps-mode-har-138)); the proof claims it with the API, it does
not enrol it. Run against the same device CI uses, the next CI run's step 3
releases it if this run left it claimed. The unit tests for the proof's pure parts (env checks, the build and
ancestor checks, the TOTP code) run with `npx nx test web-e2e` and need none of
this.

### The two METRIC lines

| Line                           | Meaning                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `METRIC web-deploy-wait-s <n>` | Seconds step 1 waited for production to serve `EXPECTED_WEB_SHA` or later. `0` when it already did. Large values mean Vercel was slow to build or promote the merge commit                                                     |
| `METRIC web-push-ms <ms>`      | Milliseconds from the first reading's timestamp (stamped by simdevice just before the send) to the browser showing that value in the live panel: device → IoT Hub → Function → SignalR → browser, plus up to 100 ms of polling |

### When Microsoft changes its sign-in pages

The sign-in step drives Microsoft's pages by the element ids they have used for
years (`#i0116` UPN, `#i0118` password, `#idSIButton9` Next / Sign in,
`#idTxtBx_SAOTCC_OTC` code, `[data-value="PhoneAppOTP"]` the authenticator-app
method, `#idBtn_Back` "No" on "Stay signed in?"), never copy text. Each waits
at most 30 s. When one does not appear, the run fails with
**`Microsoft sign-in page changed at step <x>`**, naming the selectors it
waited for and the page (`origin` and path only, never the query), and writes
`sign-in-diagnostic.txt` next to `failure.png`: which of the selectors are on
the page and visible, the page title and Microsoft's error text, with nothing
typed in it (see [The sign-in diagnostic](#the-sign-in-diagnostic)). A page
whose selectors are all absent has changed; one still showing the previous
step's selector was slow or stuck.

To fix it, sign in by hand as the acceptance user in a private window, open
the browser's developer tools at the step named, find the element's new `id`,
and update the `MS` map at the top of `apps/web-e2e/live/microsoft-sign-in.ts`;
it is the only place the selectors live. Two traps: the UPN page already holds
an off-screen, `aria-hidden` `#i0118` (class `moveOffScreen`) for password
managers, which is why the password selector excludes it; and `name`
selectors such as `input[name="passwd"]` match that same helper. A failure
that names the password (`Microsoft rejected the password`), the TOTP code or
an unknown UPN is the account, not the page: check the secrets and this
machine's clock.

## Live iOS proof

The browser proof above proves the web app. The live iOS proof (HAR-169, goal
HAR-157) proves the **iOS app** the same way, on every dev deploy: the real
app (`apps/ios`, not its UI test mode), built for an iPhone simulator,
against the dev API. It is the `ios-acceptance` job in
`.github/workflows/app-deploy-dev.yml`; the test is
`apps/ios/MeatGeekLiveUITests/LiveProofUITests.swift`, in its own test plan,
`apps/ios/Live.xctestplan`, which the `MeatGeek` scheme does not run by
default, so `ci.yml`'s `ios` job only compiles it (and fails if the default
plan ever runs it).

`apps/ios/scripts/run-live-proof.sh` runs it:

1. **The claim code.** `simdevice --twin --count 0` syncs the iOS device's
   twin (so a device released since its last sync mints a fresh code), then
   `simdevice claim-code` reads it. `unclaimed` passes the code to the test;
   `claimed` (an earlier run stopped before releasing the device) passes
   `already-claimed`.
2. **A throwaway simulator**: an iPhone 17 on the iOS runtime matching
   Xcode's simulator SDK, created for the run and deleted when the runner
   exits, so no MSAL account or Microsoft cookie outlives it.
3. **The build** (`xcodebuild build-for-testing -testPlan Live`), signed
   "to run locally" as Xcode signs every simulator build: the app keeps its
   tokens in MSAL's keychain cache, which a build with
   `CODE_SIGNING_ALLOWED=NO` cannot reach. No team id is involved.
4. **Readings.** simdevice sends the device's synthetic readings in DPS mode,
   one every 2 s, in the background for the length of the test; the runner
   waits for the first before it starts the test, and its exit trap stops
   simdevice whatever happened. Probe 1 climbs 0.5 °F a reading, so every
   reading reads differently on screen.
5. **The test** (`xcodebuild test-without-building -testPlan Live`). The
   plan's offline tests run first (`LiveOfflineTests`: the TOTP port against
   RFC 6238's vectors, the input check), then the proof, which prints one
   `PASS`, `FAIL` or `SKIP` line per step: 0. **inputs**: every missing one is named, and the test fails (it never
   skips);
   1. **sign in** with **Sign in with Microsoft**: the system "wants to use
      login.microsoftonline.com to sign in" alert (**Continue**), then
      Microsoft's real pages in the system browser sheet: UPN, password, a
      TOTP code computed in the test (RFC 6238, SHA-1, 30 s, 6 digits; the
      next window when under 5 s are left), choosing the authenticator-app
      code if Microsoft asks which method, then **No** on "Stay signed in?".
      Signed in means the app's tabs. If Microsoft asks for no second factor,
      the run notes it and carries on;
   2. **the Devices tab** lists the acceptance user's devices. If the device is
      on it already, step 3 is skipped (`SKIP`); if the runner said
      `already-claimed` and it is not, another user holds it, and the step
      fails saying so;
   3. **claim** it with **+**: the device ID, the claim code and the name
      `iOS acceptance smoker`; the device is listed;
   4. **start a cook** from the device's screen, named `acceptance ios <run
id>`, meat type Brisket, grill target 225 °F (a cook an earlier run left
      running is stopped first); its screen opens, `Status, Active`;
   5. **a pushed reading**: within 90 s of **Start**, the live panel's badge is
      `live`, the grill is not "—", and it then shows a reading newer than the
      first it showed. The panel reads `GET /temperatures/current` once, when
      it connects, so a newer reading on the open screen is one SignalR
      pushed. The time from the tap on Start to that reading is
      `METRIC ios-push-ms <n>`;
   6. **stop** the cook, confirmed: `Status, Completed`;
   7. **release** the device from its screen, confirmed: it leaves the list.

So every run that passes leaves the device unclaimed with no active cook. A
run that fails part way can leave the device claimed, or a cook running; the
next run's steps 2 and 4 take it from there.

### Inputs

The runner's, from the environment (the same names as the web proof's where
they mean the same thing). It names every missing one and exits 2.

| Variable                      | Value                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ACCEPTANCE_USER_UPN`         | The acceptance user's sign-in name                                                                                |
| `ACCEPTANCE_USER_PASSWORD`    | Its password                                                                                                      |
| `ACCEPTANCE_USER_TOTP_SECRET` | Its authenticator-app secret (base32; spaces, dashes, lower case and `=` padding are accepted)                    |
| `ACCEPTANCE_IOS_DEVICE_ID`    | The device the proof claims and sends as (`<simulated device id>-ios` in CI). Unclaimed, or the acceptance user's |
| `ACCEPTANCE_IOS_STATE_DIR`    | That device's simdevice state dir ([DPS mode](#dps-mode-har-138))                                                 |
| `ACCEPTANCE_DPS_ID_SCOPE`     | The dev DPS's ID scope                                                                                            |
| `ACCEPTANCE_SIMDEVICE_BIN`    | Path to the built `simdevice` (on the Mac: `make -C apps/data-pusher build`)                                      |

Optional: `ACCEPTANCE_DPS_ENDPOINT`; `ACCEPTANCE_RUN_ID` (names the cook;
default a UTC timestamp); `IOS_SIMULATOR` (default `iPhone 17`);
`IOS_LIVE_RESULT_BUNDLE` (default `./ios-live-proof.xcresult`, which must not
exist); `IOS_LIVE_DERIVED_DATA` (default under `$TMPDIR`).

The test's own inputs are `MEATGEEK_LIVE_UPN`, `MEATGEEK_LIVE_PASSWORD`,
`MEATGEEK_LIVE_TOTP_SECRET`, `MEATGEEK_LIVE_DEVICE_ID`,
`MEATGEEK_LIVE_CLAIM_CODE` (a code, or `already-claimed`) and the optional
`MEATGEEK_LIVE_RUN_ID`. `xcodebuild` hands every variable named
`TEST_RUNNER_<NAME>` in its own environment to the test runner as `<NAME>`;
the runner exports `TEST_RUNNER_MEATGEEK_LIVE_*` in a subshell that only
runs `xcodebuild`. The app gets none of them: it is launched with its own
environment, and talks to the dev API with the acceptance user's token.

### Running it by hand

On a Mac with Xcode 26.6, Go and the device already enrolled
([DPS mode](#dps-mode-har-138)), from the repository root, in your shell only
(never in a file):

```bash
make -C apps/data-pusher build           # builds dist/simdevice

export ACCEPTANCE_USER_UPN=...           # from wherever the team keeps the acceptance user
read -rs ACCEPTANCE_USER_PASSWORD && export ACCEPTANCE_USER_PASSWORD
read -rs ACCEPTANCE_USER_TOTP_SECRET && export ACCEPTANCE_USER_TOTP_SECRET
export ACCEPTANCE_IOS_DEVICE_ID=meatgeek-dev-simulated-smoker-ios
export ACCEPTANCE_IOS_STATE_DIR="$HOME/.meatgeek-acceptance/$ACCEPTANCE_IOS_DEVICE_ID"
export ACCEPTANCE_DPS_ID_SCOPE=...       # the dev DPS's ID scope
export ACCEPTANCE_SIMDEVICE_BIN="$PWD/apps/data-pusher/dist/simdevice"

apps/ios/scripts/run-live-proof.sh
```

It prints everything `xcodebuild` prints, as the job's raw log is; nothing in
it should be a secret, but read it before you paste it anywhere. The
screenshots are in the result bundle:
`xcrun xcresulttool export attachments --path ios-live-proof.xcresult --output-path <dir>`.
Run against the device CI uses, the next CI run carries on from whatever this
run left (steps 2 and 4). While it runs, the simulator's pasteboard briefly
holds each secret the test pastes (below); if Simulator.app is open with
**Automatically Sync Pasteboard** on, so does your Mac's, until the test
empties it again.

To see the input check fail without any of this, run the plan on its own:

```bash
xcodebuild test -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek -testPlan Live \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' -skipPackagePluginValidation
```

The offline tests pass and the proof fails with `FAIL 0. inputs (0.0 s): The
live iOS proof cannot run: missing: MEATGEEK_LIVE_UPN, MEATGEEK_LIVE_PASSWORD,
MEATGEEK_LIVE_TOTP_SECRET, MEATGEEK_LIVE_DEVICE_ID, MEATGEEK_LIVE_CLAIM_CODE (…)`.

### What is uploaded, and what is never written

- **Screenshots**, as `XCTAttachment`s kept on success too, and only these,
  taken only before Microsoft's sign-in sheet is open or once sign-in has
  finished (Microsoft's pages show the UPN), and never of the claim form (it
  shows the claim code): `1-devices-tab` (the device on the Devices tab),
  `2-cook-pushed-reading` (the proof: the cook screen live with the pushed
  reading), `3-cook-ended`, and `failure`, when sign-in fails before
  Microsoft's UPN page (nothing has been pasted: the screen shows the app,
  the system alert or Microsoft's empty first page) or a step fails past
  sign-in and the claim form is not open. The job
  exports them by name from the result bundle and uploads them as the
  `ios-acceptance-screenshots` artifact, kept 30 days, on success too (the
  goal needs them). On success the job fails if `2-cook-pushed-reading` is
  missing. Nothing else leaves the runner: not the result bundle, and not the
  text dumps of the screen's elements XCTest attaches to it on its own (they
  can hold a field's value). The test plan keeps no automatic screenshot
  (`systemAttachmentLifetime` and `uiTestingScreenshotsLifetime` are
  `keepNever`). A chart screenshot joins them once the cook screen has its
  chart (HAR-168).
- **Never typed.** XCTest writes every `typeText` value into the xcodebuild
  log (`Type '<text>' into …`). The UPN, the password, the TOTP code and the
  claim code are put on the simulator's pasteboard and pasted with the edit
  menu's **Paste** instead, which logs only `Tap "Paste" MenuItem`. The test
  then waits for the field to hold the value before it presses Return, and
  empties the pasteboard only then (or when the step fails). To know that, it
  reads the field's value in the test runner and compares it there; the value
  is never printed (XCTest logs only `Find the "<label>" TextField`), and a
  failure says only whether the field was empty.
  Typed, and so in the log: the device ID, the device and cook names, the
  meat type and the grill target.
- **Never on a command line.** The password, TOTP secret and claim code reach
  `xcodebuild` only as exported `TEST_RUNNER_*` variables, and the claim code
  is read from simdevice's output into a variable. simdevice gets `PATH`,
  `HOME` and its `MEATGEEK_*` variables only; its own output stays in a
  temporary directory the runner deletes, and only its stderr's first line is
  printed, with anything shaped like a claim code masked.
- **The job's log** shows only the `PASS`/`FAIL`/`SKIP`, `METRIC` and runner
  lines while the proof runs; the raw output goes to a file. The job's leak
  check (`.github/scripts/web-acceptance-leak-check.cjs`, as in
  [Secrets in the CI log](#secrets-in-the-ci-log), given the log only) scans
  that raw file for the password, the TOTP secret, every TOTP code of the
  job's time span, anything shaped like a claim code, a PEM private key or a
  JSON `claimCode`. It runs before the upload, which needs it to have
  finished, and the full raw log is printed to the job only if it found
  nothing.

The run summary gets the `PASS`/`FAIL`/`SKIP` lines and `METRIC ios-push-ms`.

### When Microsoft changes its sign-in pages (iOS)

In the system browser sheet the pages' element ids are not visible to
XCUITest, so `MeatGeekLiveUITests/MicrosoftSignIn.swift` tells the pages apart
by what is on them: the UPN page by its one text field, the password page by
its secure text field, the code page by a text field with no secure one after
the password, Microsoft's errors by text inside its `role="alert"` container
(on every page, empty until an error). Each field is pasted and submitted with
the keyboard's Return. Copy is used only where nothing else tells the page
apart: **No** on "Stay signed in?", and an element labelled "verification
code" or "another way" on the method pages; the system alert's **Continue**
and the edit menu's **Paste** are Apple's. A step that does not find its page
fails with `<step>: none of <what it looked for> within 30 s`; before
Microsoft's UPN page (the tap on **Sign in with Microsoft**, the alert, the
sheet) it adds `; on screen: <the app's state; any system alert; the
sheet>`, from `SignInScreen` in `MicrosoftSignIn.swift`, and keeps a `failure`
screenshot, so a red run says whether MSAL never opened the sheet, the app
showed its own error, or Microsoft's page never loaded; one where
Microsoft showed an error quotes it (Microsoft does not echo what was
typed). There is no sign-in diagnostic file: the iOS job uploads no text.

To fix it, sign in by hand in the simulator (the app's **Sign in with
Microsoft**, as the acceptance user), and look at the page with Xcode's
Accessibility Inspector, or print `app.webViews.firstMatch.debugDescription`
from a scratch UI test (never in the proof itself: it prints field values).
Update the queries at the top of `MicrosoftSignIn`.

## How it is built

```
apps/api/acceptance/
├── jest.config.ts              # its own jest config: matches live.acceptance.ts only
├── live.acceptance.ts          # entry point for `nx run api:acceptance`
├── lib/
│   ├── checks.ts               # shared response checks (system properties, error code)
│   ├── clock.ts                # HAR-120: the one clock every wait goes through (fake in the self-test)
│   ├── devices.ts              # HAR-85: DELETE /devices/{id} and the always-run cleanup step (HAR-136: stops active cooks first)
│   ├── contract.ts             # HAR-77: openapi.yaml loaded and compiled; response and hub message checks
│   ├── proof.ts                # the proof contract: defineProofs, AcceptanceApi
│   ├── runner.ts               # env check, HTTP client, simdevice, redaction, output, RU table
│   ├── signalr.ts              # SignalR helpers, including expectHubMessage
│   └── telemetry.ts            # simulated-device registration and send helpers
├── proofs/
│   ├── acceptance-device-sweep.proof.ts   # HAR-85: runs first; deletes stale acceptance-* devices
│   ├── cooks-lifecycle.proof.ts
│   ├── cooks-unauthenticated.proof.ts
│   ├── device-twin.proof.ts
│   ├── devices.proof.ts
│   ├── recipes.proof.ts
│   ├── telemetry-roundtrip.proof.ts
│   ├── telemetry-volume.proof.ts
│   ├── temperatures.proof.ts
│   ├── users.proof.ts
│   └── volume-cook-chart.proof.ts
└── acceptance-runner.spec.ts   # self-test, runs under `nx test api`
```

- `npx nx test api` never calls a live system. The api unit-test config does not
  match `live.acceptance.ts`. It does run `acceptance-runner.spec.ts`, which
  starts an in-process stub HTTP server imitating the cooks, devices, recipes,
  temperatures and users routes and drives the real runner and the real proof
  files against it: a passing stub, a wrong status on each route, a missing RU
  header on each route, missing environment variables, and a server that echoes
  the token back. `simdevice` is replaced by a small Node script the test writes
  to a temp dir: it prints one JSON line, exits 1, or prints the connection
  string to stdout and stderr; the stub makes the reading readable after a few
  polls, never, or registers the simulated device to someone else. HAR-140:
  the stub also serves `POST /devices/claim` from a fake DPS registry, fake
  `enrol-device.sh` and `delete-device.sh` scripts stand in for the real ones,
  and the fake simdevice handles `identity init`, `claim-code` and DPS mode.
  `enrolment.spec.ts` tests `lib/enrolment.ts` against a recording fake API.
  The poll
  interval and cap are `ROUNDTRIP_POLL` in the proof file; there is no
  environment variable for them. The self-test runs every wait with its live
  value on a fake clock (see [Real-time waits](#real-time-waits)). For the
  volume proof the stub keeps a reading count for the simulated device; the
  fake reports a
  top-up to the stub, which makes it readable a batch per poll, or never, and
  the fake can fail a top-up with exit 1. The self-test also checks that the
  top-up passes `--inflight 32 --interval 50ms` and a kill limit of
  `count × 50 ms × 1.5 + 120 s`. Its target, margin, interval, inflight and poll
  pacing are `VOLUME` in the proof file; the self-test shrinks the target to a
  few hundred readings and keeps the poll pacing. For the twin proof the
  stub keeps a device twin for the simulated device that start and stop sync
  as the API does; the fake `simdevice --twin` reads it from the stub, which
  applies desired to reported, and prints the twin line. The stub can print a
  wrong desired cook id or a reported version one behind, or answer the start
  with `503 DEVICE_TWIN_UPDATE_FAILED`; each fails the proof and still leaves
  no cook active. Its poll pacing is `TWIN_POLL` in the proof file.
  For the cook-chart proof every whole-suite run sets the chart variables, and
  the stub starts with the chart device registered and a standing cook whose
  chart is covered (the steady state live), or, per test, with no cook (a first
  run) or an uncovered one. The fake reports a chart top-up
  (`--start … --step 5s`) to the stub, which covers that cook's chart after a
  few reads, or never. The self-test proves a first run starts a cook and tops
  it up once, a covered chart sends nothing, 41 RU fails naming the budget (40
  passes), and a missing variable fails clearly. `CHART` in the proof file
  holds the reading count and poll pacing; the self-test shrinks the count.
  Every stub response conforms to openapi.yaml (HAR-77): it sends
  `X-Request-ID`, the error envelope `{error, message, requestId}`, and Easy
  Auth's empty `401`. The self-test also proves the contract checks fail on an
  undeclared status, a body that breaks its schema, a missing `X-Request-ID`,
  a route that is not in the spec, and a hub message of the wrong shape.
- The acceptance code is not part of the API build; `dist/apps/api` contains
  none of it.
- Besides Node built-ins (`fetch`, `http`, `crypto`, `child_process`) it uses
  `@microsoft/signalr`, plus `@apidevtools/swagger-parser`, `ajv` and
  `ajv-formats` for the contract. All of them are root dependencies already.

## Adding a proof for your ticket

1. **Create one file** in `apps/api/acceptance/proofs/`, named
   `<area>-<what>.proof.ts`. The runner loads every `*.proof.ts` there, in
   file-name order; you do not edit the runner.
2. **Default-export a group** built with `defineProofs`. Proofs in a group run
   in order and can share state through the closure; after a failure the rest of
   the group is skipped, except a proof marked `always: true`, which still runs
   (use it for a cleanup step). Groups are independent of each other.

   ```ts
   import type { AcceptanceApi } from '../lib/proof';
   import { defineProofs } from '../lib/proof';

   export default defineProofs('cooks paging', () => [
     {
       name: 'GET /cooks?limit=1 returns at most one cook',
       async run(api: AcceptanceApi) {
         const response = await api.request<{ cooks: unknown[] }>({
           method: 'GET',
           path: '/cooks?limit=1',
           route: '/cooks',
         });
         api.expectStatus(response, 200);
         api.check(response, response.body.cooks.length <= 1, 'more than one cook returned');
       },
     },
   ]);
   ```

   - `api.request` sends the bearer token by default (`authenticated: false` to
     omit it). It requires the `x-meatgeek-request-charge` header by default; pass
     `expectRequestCharge: false` only for a response that makes no Cosmos call.
     For a path with an id in it, pass `route: '/cooks/{cookId}/stop'` so the
     output and RU table group by route, not by id. Extra request headers go in
     `headers` (e.g. `{ 'X-Request-ID': … }`); they never replace the bearer
     token.
   - Every response is checked against openapi.yaml (see
     [Contract validation](#contract-validation)). `route` must be a spec path.
     A status, field or header your proof relies on must be in the spec first.
   - `api.expectStatus(response, 201)` or `api.expectStatus(response, '2xx')`.
   - `api.check(response, condition, message)` fails the proof with the route
     and status attached. Annotate the parameter as `api: AcceptanceApi` so
     `check` can narrow types.
   - Name synthetic data with `api.runId` (e.g. `acceptance-${api.runId}`) so
     reruns never collide. Do not touch real devices or other users' data.
   - To send telemetry, `api.runSimDevice(['--count', '1'])` runs simdevice as
     `api.simulatedDeviceId` and resolves to its exit code, its stdout as parsed
     JSON lines, and its first stderr line, redacted. A proof never reads
     `process.env` for the device credential; only the runner does. A run is
     killed after 120 s; a long one passes its own limit,
     `api.runSimDevice(args, { timeoutMs })`.
   - `api.metric('roundtrip-ms', 2140)` prints `METRIC roundtrip-ms 2140`.

3. **Make the stub serve it.** The self-test runs every proof file against the
   stub in `acceptance-runner.spec.ts`. If your proof calls a route the stub does
   not implement, add that route to the stub, so `nx test api` keeps proving the
   proof passes against a correct server and fails against a broken one. The
   stub's answers must conform to openapi.yaml, or the self-test fails on the
   contract check.
4. **If the route reads or writes Cosmos, return the RU header** from the
   handler: merge `requestChargeHeaders(charge)` from
   `apps/api/src/shared/cosmos/request-charge.ts` into its response headers, and
   unit-test it in the handler's `*.spec.ts`.
5. **Run it** against dev as above, and quote the run in the PR.
6. **Write the acceptance criterion** as: "the acceptance run on the merge
   commit is green, including `<proof name>`".

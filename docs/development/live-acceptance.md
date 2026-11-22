# Live Acceptance Suite

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

| Proof file                          | Proof                                                                                                                                                                                  | Expects                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acceptance-device-sweep.proof.ts`  | `GET /devices`, then `DELETE /devices/{id}` for every `acceptance-*` device except the simulated and chart devices, then `GET /devices` again (HAR-85)                                 | `200`, `204` per device, then `200` with no `acceptance-*` device listed; prints `METRIC acceptance-devices-before`, `acceptance-devices-swept` and `acceptance-devices-after`                                                                                                                               |
| `cooks-unauthenticated.proof.ts`    | `GET /cooks` with no `Authorization` header                                                                                                                                            | `401`                                                                                                                                                                                                                                                                                                        |
| `cooks-lifecycle.proof.ts`          | `POST /devices` registering `acceptance-cook-<runId>` with a run-unique name                                                                                                           | `201`; the device id is the one sent                                                                                                                                                                                                                                                                         |
|                                     | `POST /cooks` with a new UUID `id` on `acceptance-cook-<runId>`                                                                                                                        | `2xx`; body is an api-interfaces `Cook` with no Cosmos system property (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`), status `active`                                                                                                                                                                    |
|                                     | `GET /cooks/{cookId}` for the new cook (HAR-75)                                                                                                                                        | `200`; `id`, `deviceId` and `status` equal the `POST` response                                                                                                                                                                                                                                               |
|                                     | the same as the peer                                                                                                                                                                   | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks/{cookId}` for a new random UUID                                                                                                                                            | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks/active-device:<device>` (the device lock, in the owner's partition while the cook runs)                                                                                    | `404` with `error: NOT_FOUND`: a lock is not a cook                                                                                                                                                                                                                                                          |
|                                     | `GET /cooks/{cookId}/chart` for the new cook (HAR-86)                                                                                                                                  | `200`; the body matches `CookChart` (the contract check), and `cookId`, `deviceId` and `startTime` are the cook's. `points` may be empty and is not checked                                                                                                                                                  |
|                                     | `GET /cooks/{cookId}/chart` for a new random UUID                                                                                                                                      | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks/{cookId}/chart` for the new cook as the peer                                                                                                                               | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks`                                                                                                                                                                           | the new cook is listed (pages via `continuationToken`)                                                                                                                                                                                                                                                       |
|                                     | `GET /cooks?deviceId=<device>&status=active`                                                                                                                                           | `200`; returns exactly the new cook, `active`, on that device, in one page                                                                                                                                                                                                                                   |
|                                     | `POST /cooks/{cookId}/stop`                                                                                                                                                            | `2xx`; the cook is `completed` with an `endTime`                                                                                                                                                                                                                                                             |
|                                     | `GET /cooks/{cookId}`                                                                                                                                                                  | `200`; `status: completed` with an `endTime`                                                                                                                                                                                                                                                                 |
|                                     | `GET /cooks`                                                                                                                                                                           | the cook reads back `completed`                                                                                                                                                                                                                                                                              |
|                                     | `GET /cooks?deviceId=<device>&status=active`                                                                                                                                           | `200`; returns no cook after the stop                                                                                                                                                                                                                                                                        |
|                                     | `POST /cooks` on the unregistered `acceptance-unowned-<runId>`                                                                                                                         | `403`; `error` is `DEVICE_NOT_OWNED`                                                                                                                                                                                                                                                                         |
|                                     | `GET /cooks?deviceId=acceptance-unowned-<runId>`                                                                                                                                       | `200`; returns no cook (the refused start wrote nothing)                                                                                                                                                                                                                                                     |
|                                     | always, even after a failed step: `DELETE /devices/{id}` for `acceptance-cook-<runId>` (HAR-85)                                                                                        | `204` (`204` or `404` if the registration's `201` never came back)                                                                                                                                                                                                                                           |
| `device-twin.proof.ts`              | `POST /devices` registering the simulated device to the owner, as `signalr-live-temperature.proof.ts` does                                                                             | `201`, or `409 DEVICE_CONFLICT` then `GET /devices/{id}` `200`                                                                                                                                                                                                                                               |
|                                     | `GET /cooks?deviceId=<simulated device>&status=active`, and `POST /cooks/{cookId}/stop` for each cook listed                                                                           | `200`, then `200` per stop (an earlier run's cook is cleared, so the device lock is free)                                                                                                                                                                                                                    |
|                                     | `POST /cooks` with a new UUID `id` on the simulated device and `X-Request-ID: acceptance-twin-<runId>`                                                                                 | `201`, status `active`. A `503 DEVICE_TWIN_UPDATE_FAILED` fails, printing its fixed `reason`                                                                                                                                                                                                                 |
|                                     | `simdevice --twin --count 1 --timeout 60s` (a reconnect: simdevice was not connected when the cook started)                                                                            | exit `0`; the `{"event":"twin"}` line, then one reading line. `desired.activeCookId` and `reported.activeCookId` are the new cook; `desired.correlationId` and `reported.correlationId` are `acceptance-twin-<runId>`; `reported.appliedDesiredVersion` is `desired.$version`. Prints `METRIC twin-apply-ms` |
|                                     | poll `GET /temperatures/current/<simulated device>` every 2 s, up to 90 s, for the reading just sent (matched by `timestamp`, as an instant)                                           | it arrives, and its `cookId` is the new cook                                                                                                                                                                                                                                                                 |
|                                     | `POST /cooks/{cookId}/stop`                                                                                                                                                            | `200`; the cook is `completed`                                                                                                                                                                                                                                                                               |
|                                     | `simdevice --twin --count 0 --timeout 60s`                                                                                                                                             | exit `0`; `desired.activeCookId` absent or `null`, `reported.activeCookId` `null`, `reported.appliedDesiredVersion` is `desired.$version`, which is later than the start's                                                                                                                                   |
|                                     | always, even after a failed step: `GET /cooks?deviceId=<simulated device>&status=active`, and `POST /cooks/{cookId}/stop` for each cook listed                                         | `200`, then `200` per stop: no cook is left active on the simulated device                                                                                                                                                                                                                                   |
| `devices.proof.ts`                  | `POST /devices` registering `acceptance-<runId>` with a run-unique name                                                                                                                | `201`; body is an api-interfaces `Device` with the id and name sent, `isActive: true`, `connectionStatus: unknown`                                                                                                                                                                                           |
|                                     | `GET /devices/{id}` for the registered device                                                                                                                                          | `200`; the same device, owned by the registering caller                                                                                                                                                                                                                                                      |
|                                     | `GET /devices`                                                                                                                                                                         | `200`; the device is listed, and every listed device has the caller as owner                                                                                                                                                                                                                                 |
|                                     | `PATCH /devices/{id}` with a new `location`                                                                                                                                            | `200`; the device carries the new location                                                                                                                                                                                                                                                                   |
|                                     | `GET /devices/{id}` for the registered device                                                                                                                                          | `200`; the patched location reads back                                                                                                                                                                                                                                                                       |
|                                     | `GET /devices/<random uuid>`                                                                                                                                                           | `404`                                                                                                                                                                                                                                                                                                        |
|                                     | `DELETE /devices/{id}` for `acceptance-<runId>` as the peer, then `GET /devices/{id}` as the owner (HAR-85)                                                                            | `403` with `error: DEVICE_NOT_OWNED`, then `200`: the device is still the owner's                                                                                                                                                                                                                            |
|                                     | `DELETE /devices/{id}` for `acceptance-<runId>`                                                                                                                                        | `204`                                                                                                                                                                                                                                                                                                        |
|                                     | `GET /devices/{id}` for it                                                                                                                                                             | `404`                                                                                                                                                                                                                                                                                                        |
|                                     | `DELETE /devices/{id}` for it again                                                                                                                                                    | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                         |
|                                     | always, even after a failed step, unless the `204` above came back: `DELETE /devices/{id}` for `acceptance-<runId>`                                                                    | `204` (`204` or `404` if the registration's `201` never came back)                                                                                                                                                                                                                                           |
| `recipes.proof.ts`                  | `POST /recipes` named `Acceptance recipe <runId>`, `meatType: pork`                                                                                                                    | `201`; body is an api-interfaces `Recipe` with the name sent, a server-generated UUID `id`, and `createdAt` equal to `updatedAt`                                                                                                                                                                             |
|                                     | `GET /recipes/{id}` for the new recipe                                                                                                                                                 | `200`; the same recipe, owned by the creating caller                                                                                                                                                                                                                                                         |
|                                     | `GET /recipes`                                                                                                                                                                         | `200`; the recipe is listed, and every listed recipe has the caller as owner                                                                                                                                                                                                                                 |
|                                     | `PATCH /recipes/{id}` with a new `description`                                                                                                                                         | `200`; the recipe carries the new description; `createdAt` is unchanged                                                                                                                                                                                                                                      |
|                                     | `GET /recipes/{id}` for the new recipe                                                                                                                                                 | `200`; the patched description reads back                                                                                                                                                                                                                                                                    |
|                                     | `DELETE /recipes/{id}` for the new recipe                                                                                                                                              | `204`                                                                                                                                                                                                                                                                                                        |
|                                     | `GET /recipes/{id}` for the deleted recipe                                                                                                                                             | `404` with `error: RECIPE_NOT_FOUND`                                                                                                                                                                                                                                                                         |
| `signalr-isolation.proof.ts`        | `POST /devices` registering the simulated device to the owner, as `signalr-live-temperature.proof.ts` does                                                                             | `201`, or `409 DEVICE_CONFLICT` then `GET /devices/{id}` `200`                                                                                                                                                                                                                                               |
|                                     | `POST /negotiate` as the owner, then a client with handlers on `temperature`, `cook_started` and `cook_stopped`                                                                        | `200`; `start()` resolves within 30 s and the connection is `Connected`                                                                                                                                                                                                                                      |
|                                     | `POST /negotiate?deviceId=<simulated device>` as the peer (the query must be ignored), then a client with the same handlers; every invocation it receives, on any target, is recorded  | `200`; the peer's client connects                                                                                                                                                                                                                                                                            |
|                                     | `GET /temperatures/current/<simulated device>` as the peer                                                                                                                             | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                         |
|                                     | `POST /cooks` with a new UUID `id` on the simulated device, as the peer                                                                                                                | `403` with `error: DEVICE_NOT_OWNED`                                                                                                                                                                                                                                                                         |
|                                     | `simdevice --count 1`                                                                                                                                                                  | exit `0` and exactly one JSON line on stdout, with a `timestamp` and `sentAt`                                                                                                                                                                                                                                |
|                                     | wait up to 90 s for the sent reading on the owner's `temperature` (matched as in 7a), then a further 15 s                                                                              | the owner receives it; the peer has received **no message at all**, else it fails naming each target and count                                                                                                                                                                                               |
|                                     | `GET /cooks?deviceId=<simulated device>&status=active` as the owner, and `POST /cooks/{cookId}/stop` for each cook listed                                                              | `200`, then `2xx` per stop (an earlier run's cook is cleared, twin sync included)                                                                                                                                                                                                                            |
|                                     | `POST /cooks` with a new UUID `id` on the simulated device, as the owner; wait up to 90 s for `cook_started` with that cook as `payload`                                               | `201`; `cook_started` reaches the owner; prints `METRIC signalr-cook-event-ms`                                                                                                                                                                                                                               |
|                                     | `POST /cooks/{cookId}/stop` as the owner; wait up to 90 s for `cook_stopped`, then a further 15 s                                                                                      | `2xx`; `cook_stopped` reaches the owner; the peer has still received nothing; prints `METRIC isolation-peer-messages` (must be `0`)                                                                                                                                                                          |
|                                     | `stop()` on both connections                                                                                                                                                           | both are `Disconnected`. A failure at any earlier step stops both connections before it is reported                                                                                                                                                                                                          |
| `signalr-live-temperature.proof.ts` | `POST /devices` registering the simulated device, as `telemetry-roundtrip.proof.ts` does                                                                                               | `201`, or `409 DEVICE_CONFLICT` then `GET /devices/{id}` `200`                                                                                                                                                                                                                                               |
|                                     | `POST /negotiate` (after the registration), then a `@microsoft/signalr` client with a handler on target `temperature` opens the `url` with `accessTokenFactory`                        | `200`; `start()` resolves within 30 s and the connection is `Connected`                                                                                                                                                                                                                                      |
|                                     | `simdevice --count 1` (one reading through IoT Hub, as the simulated device); the wall-clock time just before it starts is kept                                                        | exit `0` and exactly one JSON line on stdout, with a `timestamp` and `sentAt`                                                                                                                                                                                                                                |
|                                     | wait up to 90 s for a `temperature` message whose `deviceId` is the simulated device and whose `timestamp` is the sent one (other messages, e.g. replayed older readings, are ignored) | it arrives; the payload has a date `enqueuedTimeUtc` and no field besides `deviceId`, `timestamp`, `cookId`, `grillTemp`, `probe1Temp`…`probe4Temp` and `enqueuedTimeUtc`; prints `METRIC signalr-delivery-ms`                                                                                               |
|                                     | `stop()`                                                                                                                                                                               | the connection is `Disconnected`. A failure at any earlier step stops the connection before it is reported                                                                                                                                                                                                   |
| `signalr-negotiate.proof.ts`        | `POST /negotiate`                                                                                                                                                                      | `200`; body has an https `url` of the form `…/client/?hub=…` and a non-empty `accessToken`                                                                                                                                                                                                                   |
|                                     | a `@microsoft/signalr` client opens the `url` with `accessTokenFactory` returning the `accessToken`, then stops                                                                        | `start()` resolves within 30 s and the connection is `Connected`; `stop()` leaves it `Disconnected`                                                                                                                                                                                                          |
| `temperatures.proof.ts`             | `POST /devices` registering `acceptance-temp-<runId>` with a run-unique name                                                                                                           | `201`                                                                                                                                                                                                                                                                                                        |
|                                     | `GET /temperatures/current/acceptance-temp-<runId>`                                                                                                                                    | `404` with `error: NO_READINGS` (owned, but nothing has been routed for it)                                                                                                                                                                                                                                  |
|                                     | `GET /temperatures/current/acceptance-temp-unowned-<runId>` (never registered)                                                                                                         | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                         |
|                                     | `GET /temperatures/history?deviceId=acceptance-temp-<runId>`                                                                                                                           | `200`; exactly `{ readings: [], limit: 100, hasMore: false }` (owned, nothing routed): no `continuationToken`, `total` or `offset`                                                                                                                                                                           |
|                                     | the same with `&offset=0`                                                                                                                                                              | `400` with `error: VALIDATION_ERROR` (HAR-75: history pages by continuation token only); no RU header                                                                                                                                                                                                        |
|                                     | `GET /temperatures/history?deviceId=acceptance-temp-unowned-<runId>`                                                                                                                   | `404` with `error: DEVICE_NOT_FOUND`                                                                                                                                                                                                                                                                         |
|                                     | always, even after a failed step: `DELETE /devices/{id}` for `acceptance-temp-<runId>` (HAR-85)                                                                                        | `204` (`204` or `404` if the registration's `201` never came back)                                                                                                                                                                                                                                           |
| `telemetry-roundtrip.proof.ts`      | `POST /devices` registering the simulated device (`ACCEPTANCE_SIM_DEVICE_ID`) as `Simulated smoker (acceptance)`                                                                       | `201`, or `409 DEVICE_CONFLICT` then `GET /devices/{id}` `200` (already the caller's); `409` then `404` fails (someone else owns it)                                                                                                                                                                         |
|                                     | `simdevice --count 1` (one reading through IoT Hub, as the simulated device)                                                                                                           | exit `0` and exactly one JSON line on stdout, with a `timestamp` and `sentAt`                                                                                                                                                                                                                                |
|                                     | `GET /temperatures/current/<simulated device>`, every 1 s for at most 120 s                                                                                                            | a `200` whose `timestamp` is the sent one (`404 NO_READINGS` or an older reading: poll again); `deviceId` is the device, `grillTemp` a number, no `_` key; prints `METRIC roundtrip-ms`                                                                                                                      |
|                                     | `GET /temperatures/history?deviceId=<simulated device>&startTime=<sentAt − 5 min>`                                                                                                     | `200`; the sent reading is in `readings` (paging with `continuationToken` while `hasMore`), with the same field checks                                                                                                                                                                                       |
| `telemetry-volume.proof.ts`         | `GET /temperatures/history?deviceId=<simulated device>&limit=1000`, then each `continuationToken` in turn, one request at a time                                                       | `200` pages; counts the readings and prints `METRIC history-readings-before`                                                                                                                                                                                                                                 |
|                                     | `simdevice --count <8640 − readings + 60> --inflight 32 --interval 50ms`, only when readings < 8,640                                                                                   | exit `0` and one JSON line per reading requested; prints `METRIC topup-sent` (`0` when no top-up was needed) and `METRIC topup-ms`                                                                                                                                                                           |
|                                     | after a top-up only: `GET /temperatures/current/<simulated device>`, every 10 s for at most 15 min                                                                                     | the reading's `timestamp` reaches the top-up's end (the reading 32 places from its last: see below), else it fails naming the cap                                                                                                                                                                            |
|                                     | the same walk again                                                                                                                                                                    | at least 8,640 readings, and the last page's RU ≤ 1.5 × the first page's; prints `METRIC history-readings`, `history-pages`, `history-ru-first-page`, `history-ru-last-page`                                                                                                                                 |
| `users.proof.ts`                    | `PUT /users/me` with a run-unique `name` and `acceptance@example.invalid`                                                                                                              | `200` or `201` (the profile persists between runs); body is an api-interfaces `User` with the name and email sent and a `<tid>:<oid>` id                                                                                                                                                                     |
|                                     | `GET /users/me`                                                                                                                                                                        | `200`; this run's name reads back, with the same `id` and `createdAt` as the PUT returned                                                                                                                                                                                                                    |
| `volume-cook-chart.proof.ts`        | checks the chart device is configured (`ACCEPTANCE_CHART_DEVICE_ID`, `SIMDEVICE_CHART_CONNECTION_STRING`)                                                                              | both set, else it fails naming both                                                                                                                                                                                                                                                                          |
|                                     | `GET /devices/<chart device>`, then `POST /devices` on `404` only                                                                                                                      | `200`, or `404` and then `201`                                                                                                                                                                                                                                                                               |
|                                     | `GET /cooks?deviceId=<chart device>&status=active`, then `POST /cooks` (`acceptance standing chart cook`, `brisket`, fresh UUID) only when none is active                              | `200`; `201` and an `active` cook. The cook is never stopped                                                                                                                                                                                                                                                 |
|                                     | `GET /cooks/{cookId}/chart` for the standing cook                                                                                                                                      | `200`, the cook's chart; checks whether it covers the cook's 12 h (see below)                                                                                                                                                                                                                                |
|                                     | `simdevice --count 8640 --start <cook startTime> --step 5s --inflight 32 --interval 50ms` as the chart device, only when not covered                                                   | exit `0`, 8,640 JSON lines stamped `startTime + i × 5 s`; prints `METRIC chart-topup-sent` (`0` when none was needed)                                                                                                                                                                                        |
|                                     | after a top-up only: `GET /cooks/{cookId}/chart`, every 10 s for at most 15 min                                                                                                        | covered, else it fails naming the cap                                                                                                                                                                                                                                                                        |
|                                     | `GET /cooks/{cookId}/chart` once more: the measurement                                                                                                                                 | covered, and `x-meatgeek-request-charge` ≤ 40 (`CHART_RU_BUDGET`); prints `METRIC chart-ru-12h`, `chart-points`, `chart-bucket-seconds`                                                                                                                                                                      |

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
does every `DELETE /devices/{id}`: the `204` (a point read and a point delete),
the peer's `403` and the `404`s (a point read). A response without
it fails the proof. Responses that make no Cosmos call, such as a 401, carry no
header.

Each run uses its own device ids, and deletes them again (HAR-85).
`devices.proof.ts` registers `acceptance-<runId>`.
`cooks-lifecycle.proof.ts` registers `acceptance-cook-<runId>` and runs the
cook lifecycle on it, because a cook may only start on a device the caller
owns (HAR-26); a fresh device per run also means runs never trip the
one-active-cook-per-device rule. Both register a run-unique name, so runs never
collide on device id or on the `(userId, name)` pair. The cooks proof's last
two steps use `acceptance-unowned-<runId>`, which is never registered.

Each of the three groups that registers a device ends with a step marked
`always`, which deletes it even when an earlier step failed. `devices.proof.ts`
deletes its device as part of the proof (the peer's `403`, the owner's `204`,
then `404`s), so its last step only runs when that did not happen. Cooks are not
deleted (there is no `DELETE /cooks`): a deleted device's cooks stay in the
owner's history, and its readings expire on the `temperatures` container TTL.

A run that is killed (a job timeout, a cancelled deploy) cannot run those
steps. So the first group, `acceptance-device-sweep.proof.ts` (its file name
sorts first), deletes every `acceptance-*` device the owner holds before any
other proof registers one. It never deletes the simulated or chart device,
whose ids do not start with `acceptance-` and which it also excludes by id.
Dev deploys run one at a time (the `app-deploy-dev` concurrency group), so no
other CI run's devices are in flight; a local run signs in as you, a different
owner, and sweeps only your `acceptance-*` devices. The three `METRIC
acceptance-devices-*` lines in the run summary give the owner's device count
before the sweep, how many it deleted, and the count after. Before HAR-85 the
acceptance owner had 98 devices.

`temperatures.proof.ts` registers its own device, `acceptance-temp-<runId>`, and
is read-only otherwise. Telemetry only ever arrives through IoT Hub, and the
suite sends it only as the simulated device, so a fresh `acceptance-temp-<runId>`
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
Unlike the run-unique devices, this device is the same on every run: the first
proof to register it on the first run gets `201`, every later registration gets
`409 DEVICE_CONFLICT` and confirm with `GET /devices/{id}` (which answers `404`
for a device someone else owns) that it is still the caller's. Its readings are
not deleted; they expire on the `temperatures` container TTL. The history
window opens five minutes before `sentAt`: the routes window on the hub's
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
when it handles the reading, so the proof registers the simulated device to the
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
and masks in every line, as a second guard, both bearer tokens, the
`SIMDEVICE_CONNECTION_STRING` and `SIMDEVICE_CHART_CONNECTION_STRING` values,
and each one's `SharedAccessKey` value.

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
- **When it comes back:**
  - The status must be declared for the operation.
  - A JSON body must match that status's `application/json` schema. A JSON
    body is also a mismatch when the status declares no body. A non-JSON or
    empty body is not checked against a schema; Easy Auth's own `401` is an
    example.
  - If the response declares `X-Request-ID`, the header must be present.

A mismatch fails the proof with a line such as:

```
FAIL devices › … — POST /devices → 201: contract: POST /devices (registerDevice) 201: the body does not match the schema: /isActive must be boolean; (root) must NOT have additional properties 'colour'
```

The line names the operation, the status and up to three Ajv errors with their
path in the body. It never prints a value from the body, and the redactor
masks it like every other line.

There is no per-proof opt-out. If the spec is wrong, fix the spec. If the API
is wrong, fix the handler.

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
[The browser proof's waits](#the-browser-proofs-waits).

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

| Where (file:symbol)                                                             | What it waits for                                                                       | Bound                                                   | Why that long                                                                                                                                                                                                                                        | Failure message                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live.acceptance.ts:SUITE_TIMEOUT_MS`                                           | the whole run: jest's limit on the suite's one test. Jest's own timer, not the clock    | 35 min                                                  | Under the `acceptance` job's 40 min timeout (`app-deploy-dev.yml`), so jest reports an overrun, not the job kill (HAR-46). Room for a full volume top-up (~8,700 readings, ~7–8 min) plus its drain (up to 15 min). Measured: 1–2 min with no top-up | jest: `Exceeded timeout of 2100000 ms for a test` on `live acceptance proofs pass against ACCEPTANCE_BASE_URL`                                                                                |
| `lib/runner.ts:DEFAULT_TIMEOUT_MS` (`api.request`)                              | one API response, body included                                                         | 60 s                                                    | A dev Function App cold start: the slowest first request measured was 9,469 ms (run 44964201190) and 9,365 ms (run 44843327090); every other request was under 0.9 s (HAR-11)                                                                        | `FAIL <proof> — <METHOD> <route> → no response: the response did not finish in 60000 ms (the runner's per-request limit)`                                                                     |
| `lib/runner.ts:SIMDEVICE_TIMEOUT_MS` (`runSimDevice`, `runChild`'s kill)        | a `simdevice` run to exit, unless the proof passes its own limit; killed with `SIGKILL` | 120 s                                                   | One reading takes seconds (HAR-44). Measured: `simdevice --count 1` ≤ 487 ms                                                                                                                                                                         | `simdevice → exit killed: simdevice did not exit within its 120000 ms limit and was killed, expected exit 0` (its `EXEC` line says `exit killed`)                                             |
| `proofs/device-twin.proof.ts:SIMDEVICE_KILL_MS`                                 | `simdevice --twin` to exit; killed with `SIGKILL`                                       | 120 s                                                   | Twice simdevice's own 60 s twin wait (next row), leaving room for the connect and a reading (HAR-68). Measured: a reconnect ≤ 869 ms (`twin-apply-ms` ≤ 870)                                                                                         | as the row above, with `120000 ms`                                                                                                                                                            |
| `proofs/device-twin.proof.ts:TWIN_TIMEOUT` (`--timeout 60s`)                    | simdevice's own wait for each twin GET, inside the child (Go)                           | 60 s                                                    | Set with the proof (HAR-68), twice simdevice's own 30 s default (HAR-58); no measurement then. Measured: the whole reconnect, both GETs included, ≤ 869 ms                                                                                           | `simdevice exited 1, expected 0: … no twin response from IoT Hub within 60s: …`                                                                                                               |
| `proofs/telemetry-volume.proof.ts:topupTimeLimitMs`                             | the volume top-up's `simdevice` run; killed with `SIGKILL`                              | `count × 50 ms × 1.5 + 120 s` (8,700 readings: 772.5 s) | The paced send time with half again for slack, plus 120 s to connect and drain the last acknowledgements (HAR-45, HAR-46). A full top-up took ~7–8 min                                                                                               | `simdevice was killed after the <n> s limit (<k> of <count> message(s) sent)`                                                                                                                 |
| `proofs/volume-cook-chart.proof.ts` (`topupTimeLimitMs`)                        | the chart top-up's `simdevice` run; killed with `SIGKILL`                               | the same formula (8,640 readings: 768 s)                | The same pacing as the volume top-up (HAR-87)                                                                                                                                                                                                        | as the row above                                                                                                                                                                              |
| `proofs/device-twin.proof.ts:TWIN_POLL`                                         | the twin run's reading in `GET /temperatures/current/{deviceId}`                        | a poll every 2 s, cap 90 s                              | IoT Hub → Cosmos routing (HAR-68). Measured round trip (`roundtrip-ms`) ≤ 1,225 ms                                                                                                                                                                   | `the reading with timestamp <ts> was not readable within the 90 s cap; last status <status>, last timestamp seen <ts or none>`                                                                |
| `proofs/telemetry-roundtrip.proof.ts:ROUNDTRIP_POLL`                            | the sent reading in `GET /temperatures/current/{deviceId}`                              | a poll every 1 s, cap 120 s                             | IoT Hub → Cosmos routing (HAR-44). Measured `roundtrip-ms` 104–1,225 ms                                                                                                                                                                              | `the reading sent at <sentAt> (timestamp <ts>) was not readable within the 120 s cap; last status <status>, last timestamp seen <ts or none>`                                                 |
| `proofs/telemetry-volume.proof.ts:VOLUME.pollIntervalMs`, `pollCapMs`           | the top-up's tail in the current reading: its routing backlog has drained               | a poll every 10 s, cap 15 min                           | The routed writes share the one 400 RU/s offer, so ~8,700 of them drain behind it (HAR-45, HAR-46)                                                                                                                                                   | `the current reading is <ts or none>, before the top-up's end (<iso>), after the 900 s cap`                                                                                                   |
| `proofs/volume-cook-chart.proof.ts:CHART.pollIntervalMs`, `pollCapMs`           | the chart to cover 12 h after a top-up (rolled up)                                      | a poll every 10 s, cap 15 min                           | The same backlog as the volume top-up, plus the hourly rollup (HAR-87)                                                                                                                                                                               | `the chart is not covered after the 900 s cap: <why>`                                                                                                                                         |
| `proofs/signalr-live-temperature.proof.ts:LIVE_WAIT.capMs`                      | the sent reading pushed on target `temperature`                                         | 90 s                                                    | simdevice → IoT Hub → Event Hub → `broadcastTemperature` → SignalR (HAR-63). Measured `signalr-delivery-ms` 436–628 ms                                                                                                                               | `connected and sent (…), but no temperature message for <device> with that timestamp arrived: nothing within the 90 s cap; the connection is <state>. Received <n> temperature message(s), …` |
| `proofs/signalr-isolation.proof.ts:ISOLATION_WAIT.capMs` (`waitForOwner`)       | the owner's reading, `cook_started` and `cook_stopped`, each                            | 90 s each                                               | As the row above (HAR-67). Measured `signalr-cook-event-ms` 230–366 ms                                                                                                                                                                               | `no <what> reached the owner: nothing within the 90 s cap; the owner connection is <state>. The owner received <n> message(s) (…)`                                                            |
| `proofs/signalr-isolation.proof.ts:ISOLATION_WAIT.graceMs` (`expectPeerSilent`) | a fixed window after the owner got an event, in which the peer must receive nothing     | 15 s                                                    | A leak would travel the same path as the owner's message, so it gets about 24 × the slowest owner delivery measured (628 ms) to show up (HAR-67)                                                                                                     | `LEAK: the peer, who does not own <device>, received <n> message(s) by <event> + 15 s: <target ×n>`                                                                                           |
| `lib/signalr.ts:CONNECT_TIMEOUT_MS` (`within`)                                  | one SignalR client `start()` attempt, or a `stop()`                                     | 30 s                                                    | Set with the first SignalR proof (HAR-57) for the Free_F1 service's client negotiate and transport start; no measurement then. Measured, from the log's timestamps: `start()` 170–580 ms                                                             | `<what> did not finish in 30000 ms`, `<what>` being `start()`, `owner start()`, `peer start()` or `stop()`                                                                                    |
| `lib/signalr.ts:START_RETRY.delaysMs` (`startConnection`)                       | before retrying a `start()` the service answered with `429`                             | 1, 2, 4 and 8 s: five attempts, 15 s of waiting         | HAR-77's first live run: two proofs got `429`, and the next one, 2 s later, connected                                                                                                                                                                | `<what> failed: <masked error> (throttled on all 5 attempts)`                                                                                                                                 |

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

| Where (file:symbol)                                                      | What it waits for                                                                                                                   | Bound                            | Why that long                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Failure message                                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `playwright.live.config.ts:timeout`                                      | the whole proof: Playwright's limit on its one test                                                                                 | 25 min                           | Up to 15 min for the build (`waitForBuild`, below) plus a few minutes of proof. Under the job's 30 min timeout. Measured: the whole test 15.9–36.8 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Playwright: `Test timeout of 1500000ms exceeded.`                                                                                                            |
| `helpers.ts:waitForBuild` (`intervalMs`, `timeoutMs`)                    | `<web>/version.json` to serve `EXPECTED_WEB_SHA` or a commit after it                                                               | a poll every 15 s, cap 15 min    | Vercel builds and promotes the merge commit after the deploy job starts (HAR-99). Measured: `web-deploy-wait-s 0` in all 19 (production already served it); the cap is for a slow Vercel build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `Production did not serve <sha> or a commit after it within 15 min: <web>/version.json last reported <sha or no sha> (<why>)`                                |
| `helpers.ts:runGit` (`spawnSync` `timeout`)                              | one `git merge-base --is-ancestor`, or the `git fetch` of both commits after it; killed after                                       | 120 s each                       | A fetch of two commits from GitHub, when production serves a newer commit this clone lacks. Never ran in the 19: production served the exact sha, which needs no git. The unit test runs real git with no bound (HAR-121)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `git could not compare <a> and <b> (exit killed), even after fetching both from origin`                                                                      |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`firstOf`)                       | the first of a step's outcomes to show: the password page or `usernameError`; the code box, method list, KMSI or the app; and so on | 30 s each                        | Kept at 30 s on the measurements: the UPN and password pages, from the click on **Sign in** to Microsoft's answer after the password, took **1.6–3.7 s in total** over the 18 passing attempts, so one page gets more than 8× that whole sequence. The whole sign-in step took 2.5–13.4 s (2.5, 3.2, 3.5, 3.5, 3.5, 3.6, 3.9, 4.2, 4.5, 4.5, 5.0, 12.1, 12.3, 12.3, 12.4, 13.1, 13.3, 13.4 s); the 12–13 s ones spend about 10 s after Microsoft, on the API's cold `GET /devices` (the `APP_TIMEOUT_MS` row). The one failure (44940008836, attempt 1, 32.3 s) waited the full 30 s on the password step; its re-run took 3.35 s for both pages. Nothing measured says a longer bound would have passed it, so it is not raised and nothing retries; the step now writes `sign-in-diagnostic.txt` (below) to tell a slow page from a changed one | `Microsoft sign-in page changed at step <step>: none of <outcomes> appeared within 30 s (on <origin><path>)`                                                 |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`fillAt`)                        | a field (UPN, password, code) to be visible, then to take the value                                                                 | 30 s each                        | As the row above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `Microsoft sign-in page changed at step <step>: <selector> did not appear or take input within 30 s (on <origin><path>)`                                     |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`clickAt`)                       | **Next**, **Sign in**, a method, **No** on "Stay signed in?" to be clickable                                                        | 30 s                             | As the row above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `Microsoft sign-in page changed at step <step>: <selector> could not be clicked within 30 s (on <origin><path>)`                                             |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (the Enter press)                 | the code box to take Enter                                                                                                          | 30 s                             | As the row above. Never reached in the 19 (no second factor asked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `Microsoft sign-in page changed at step totp: #idTxtBx_SAOTCC_OTC did not take Enter within 30 s (on <origin><path>)`                                        |
| `microsoft-sign-in.ts:STEP_TIMEOUT_MS` (`waitForURL`)                    | the browser back on the app's origin after Microsoft                                                                                | 30 s                             | As the row above. Measured: inside the 0.8–11.0 s from Microsoft's last page to signed-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `Microsoft sign-in page changed at step return to app: the browser did not come back to the app (<origin>) within 30 s (on <origin><path>)`                  |
| `microsoft-sign-in.ts` (`waitForTimeout(left + 250)`)                    | the next 30 s TOTP window, when the current one has under 5 s left                                                                  | at most 5.25 s, a fixed wait     | A code typed in its last seconds can expire before Microsoft checks it (HAR-99). It cannot time out; it notes `Waiting <s> s for the next TOTP window`. Never reached in the 19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | — (a fixed wait). A code Microsoft still rejects: `Microsoft rejected the TOTP code (step totp): check ACCEPTANCE_USER_TOTP_SECRET and this machine's clock` |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (header `toHaveText`)             | the app header to show the signed-in user                                                                                           | 30 s                             | The app's own render after the redirect. Measured, with the `GET /devices` poll below: 0.8–11.0 s from Microsoft's last page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `the app header did not show the signed-in user within 30 s` (Playwright adds the locator and `Timeout 30000ms exceeded`)                                    |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`GET /devices` poll)             | the page's `GET /devices` to answer `200`                                                                                           | 30 s                             | A dev Function App cold start: about 10 s in the 6 slow attempts (10.1–11.0 s with the header), matching the API suite's 9.4 s cold start above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `GET /devices did not answer 200 within 30 s of sign-in`                                                                                                     |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`waitForResponse`)               | the `POST /devices` the register form sends                                                                                         | 30 s                             | One API request, cold start included (as above). Only when the device is not registered yet; never ran in the 19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `POST /devices (registering <device>) did not answer within 30 s`                                                                                            |
| `browser-proof.live.ts:APP_TIMEOUT_MS` (`GET /cooks?status=active` poll) | the page's active-cooks request to answer `200`                                                                                     | 30 s                             | As `GET /devices`. Measured: step 4 took 0.0 s in all 18 that reached it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `GET /cooks?status=active did not answer 200 within 30 s`                                                                                                    |
| `live-panel.ts:expectLivePanelConnected` (`APP_TIMEOUT_MS`)              | the cook page's live panel to be connected (`waiting`, `live`, or stale "No reading for …"); "Sign in again" fails at once          | 30 s, read every 250 ms          | Negotiate plus the SignalR start (HAR-101). Measured: the whole of step 5, form included, 0.4–2.9 s in the 17 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `the live panel is not connected within 30 s: not connected (data-state <state>, badge "<badge>")`; `… and has stopped trying: …` for "Sign in again"        |
| `browser-proof.live.ts:PUSH_TIMEOUT_MS` (`waitForFunction`)              | the live panel to be `live` showing the value simdevice sent                                                                        | 60 s, read every 100 ms          | simdevice → IoT Hub → Event Hub → Function → SignalR → browser (HAR-99). Measured `web-push-ms` 416–19,748 ms over the 17 that got there; step 6 took 10.1–19.8 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `The live panel did not show grill <value> within 60 s (it shows <value or nothing>, data-state <state>): <cause>`                                           |
| `playwright.live.config.ts:expect.timeout`                               | every other `expect` in the proof without its own bound (`toBeVisible`, `toHaveURL`, `toHaveText`, `toHaveCount`)                   | 30 s each                        | Page renders and single API calls, as the rows above. Each message names what was expected, e.g. `starting the cook did not open its page`, `the cook did not complete`, `the live panel is still on screen after the stop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Playwright: the expect's message, the locator, and `Timeout 30000ms exceeded`                                                                                |
| `playwright.live.config.ts:actionTimeout`, `navigationTimeout`           | every click, fill and `goto` on the app without its own bound                                                                       | 30 s each; 60 s for a navigation | The same app renders; the first `goto` loads the app from Vercel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Playwright: the action, the locator or URL, and `Timeout <n>ms exceeded`                                                                                     |

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

## Running it locally against dev

The suite takes six inputs, all from the environment. If any is missing it
fails at once and names the variable; it never skips silently.

| Variable                       | Value                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ACCEPTANCE_BASE_URL`          | The API root, including `/api`, e.g. `https://<function-app-host>/api`                                 |
| `ACCEPTANCE_BEARER_TOKEN`      | An Entra access token for the API audience                                                             |
| `ACCEPTANCE_PEER_BEARER_TOKEN` | A token for the same audience as a second caller who owns no devices (HAR-67)                          |
| `SIMDEVICE_CONNECTION_STRING`  | The simulated device's IoT Hub connection string. Only the runner reads it; simdevice inherits it      |
| `ACCEPTANCE_SIM_DEVICE_ID`     | The simulated device's id, `meatgeek-dev-simulated-smoker` in dev                                      |
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

# The device credential, straight into the environment. Needs the azure-iot
# extension (az extension add --name azure-iot) and IoT Hub Registry
# Contributor on the dev hub for your az login.
HUB_HOST=$(az iot hub list -g meatgeek-v2-dev-rg --query '[0].properties.hostName' -o tsv)
export SIMDEVICE_CONNECTION_STRING=$(az iot hub device-identity connection-string show \
  --hub-name "$HUB_HOST" --device-id "$ACCEPTANCE_SIM_DEVICE_ID" --auth-type login \
  --query connectionString -o tsv)

# Optional (HAR-84): the chart device, for the cook-chart proof.
export ACCEPTANCE_CHART_DEVICE_ID="${ACCEPTANCE_SIM_DEVICE_ID}-chart"
export SIMDEVICE_CHART_CONNECTION_STRING=$(az iot hub device-identity connection-string show \
  --hub-name "$HUB_HOST" --device-id "$ACCEPTANCE_CHART_DEVICE_ID" --auth-type login \
  --query connectionString -o tsv)

npx nx run api:acceptance
```

Never paste the connection string into a file (`.env`, a script, a ticket):
it is a live device key. Keep it in your shell's environment and let it go
with the shell. `--auth-type login` makes `az` use your Entra role on the hub
(`IoT Hub Registry Contributor`) rather than hub keys; without that role the
fetch fails and the run stops at once, naming `SIMDEVICE_CONNECTION_STRING`.
The device must already exist; the CI job creates it if it does not (see
[CI/CD](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)), so in practice it
does.

The token is a delegated token for the `access_as_user` scope on the dev API
registration, which the dev Function App's Easy Auth accepts (see
[Authentication](../api/authentication.md)). Cooks written by the run land in
**your** user's partition. So does the simulated device's registration: if the
CI identity already owns `meatgeek-dev-simulated-smoker`, the round-trip's first
step fails for you (`409` then `404`), which is that proof working as designed.
Point `ACCEPTANCE_SIM_DEVICE_ID` and the connection string at a device of your
own to run it by hand.

In CI the caller is the dev app-publish identity instead: the `acceptance` job
mints an app-only token for `<audience>/.default`, so its cooks land in that
service principal's partition. The same step also signs in, from a separate
`az` config directory, as the zero-role acceptance peer
`meatgeek-v2-dev-acceptance-peer` (`vars.AZURE_ACCEPTANCE_PEER_CLIENT_ID` on
the `development` environment, set by bootstrap, HAR-61) and hands the suite a
second masked app-only token as `ACCEPTANCE_PEER_BEARER_TOKEN`, after checking
that its `appid`/`azp` claim is the peer's and not app-publish's (HAR-65). The
isolation proof (HAR-67) sends as it. The same job builds simdevice, ensures the
simulated device exists and hands the suite its masked connection string (see
[CI/CD](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)). The proof results and the RU-per-route table
also go to the workflow run's summary page. The target is never cached by Nx, so every invocation
calls the live system.

### The chart device (HAR-84)

A second standing IoT Hub device, `<simulated device id>-chart`
(`meatgeek-dev-simulated-smoker-chart` in dev), is for the cook-chart RU proof
of goal HAR-71. That proof keeps one active cook running on its device across
runs, with 12 hours of readings in it. It cannot use the first device:
`device-twin.proof.ts` starts and stops a cook there on every run, and a
standing active cook would make that proof's `POST /cooks` fail with `409`.
The CI job's "Ensure the simulated device exists" step creates the chart device
if it is missing, the same way as the first (log line `device <id>: created`
or `device <id>: exists`); its id is derived in the workflow, not in Terraform.

Two more variables name it. The runner treats them as optional, but set both or
neither: one without the other stops the run at once, naming both. The cook-chart
proof (HAR-87, `volume-cook-chart.proof.ts`) needs them: without them it fails
at its first step, naming both, and sends nothing.

| Variable                            | Value                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ACCEPTANCE_CHART_DEVICE_ID`        | The chart device's id, `meatgeek-dev-simulated-smoker-chart` in dev                               |
| `SIMDEVICE_CHART_CONNECTION_STRING` | The chart device's IoT Hub connection string. Only the runner reads it, and masks it as the first |

A proof reads the id as `api.chartDeviceId` (`undefined` when the run was not
given it) and sends as the device with
`api.runSimDevice(args, { device: 'chart' })`. The runner hands that simdevice
run the chart credential as its `SIMDEVICE_CONNECTION_STRING`; no simdevice run
gets the credential of the device it is not sending as. Without the variables,
a chart run fails as `simdevice (chart) → not started`.

## Live browser proof

The suite above proves the API. The live browser proof (HAR-99, goal HAR-71)
proves the **production web app**, `https://meatgeekv2-web.vercel.app`, end to
end in a real browser:

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
3. **Device.** If `ACCEPTANCE_WEB_DEVICE_ID` is not on the devices page, it is
   registered through the page's register form.
4. **Clean slate.** A cook left running on that device (a "Cooking: …" link)
   is opened and stopped through the UI.
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
8. **Cleanup.** If a cook from step 5 was not stopped on screen, it is stopped
   through the API with the token the page itself sent (taken from the page's
   requests, never printed).

It runs after every dev deploy, as the `web-acceptance` job in
`.github/workflows/app-deploy-dev.yml` (HAR-101; see
[CI/CD → Dev app deploy and live acceptance](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)),
in parallel with the API suite's `acceptance` job, with `EXPECTED_WEB_SHA` set
to the deployed commit. The job makes sure the IoT Hub device
`<simulated_device_id>-web` exists, fetches and masks its connection string
inside the run step, and takes the acceptance user's UPN from the
`development` environment's `ACCEPTANCE_USER_UPN` variable and the password and
TOTP secret from its `ACCEPTANCE_USER_PASSWORD` and
`ACCEPTANCE_USER_TOTP_SECRET` secrets. The run summary gets one `PASS` or
`FAIL` line per step (printed by `apps/web-e2e/live/step-reporter.ts`), the two
`METRIC` lines and Playwright's summary line. On failure the proof's
screenshot is uploaded as the `web-acceptance-screenshots` artifact, kept 7
days. A last step checks the proof's raw output for leaked secrets (see
[Secrets in the CI log](#secrets-in-the-ci-log)). You can still run it by hand,
below.

### Inputs

All from the environment. Global setup checks them before a browser starts: a
missing one fails the run at once, naming every missing variable, never a
value.

| Variable                          | Value                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `WEB_BASE_URL`                    | The web app's origin. Optional, default `https://meatgeekv2-web.vercel.app`                                 |
| `EXPECTED_WEB_SHA`                | The full 40-character commit production must serve (or contain), usually the merge commit                   |
| `ACCEPTANCE_USER_UPN`             | The acceptance user's sign-in name, in the dev tenant                                                       |
| `ACCEPTANCE_USER_PASSWORD`        | Its password                                                                                                |
| `ACCEPTANCE_USER_TOTP_SECRET`     | Its authenticator-app secret (base32; spaces, dashes, lower case and `=` padding are accepted)              |
| `ACCEPTANCE_WEB_DEVICE_ID`        | The IoT Hub device the proof sends as, owned by the acceptance user (`<simulated device id>-web`)           |
| `SIMDEVICE_WEB_CONNECTION_STRING` | That device's connection string. Only simdevice's own environment gets it, as `SIMDEVICE_CONNECTION_STRING` |
| `ACCEPTANCE_SIMDEVICE_BIN`        | Path to the built `simdevice`, the same binary the API suite uses                                           |

The proof writes none of the password, the TOTP secret or code, the connection
string or any token anywhere. Playwright's trace, video, HTML report, failure
page snapshot (`error-context.md`) and automatic screenshot are all off for it
(`apps/web-e2e/playwright.live.config.ts`), because the sign-in pages show the
UPN and what was typed. It takes its own full-page screenshot on failure, and
only once sign-in has finished and the browser is back on the app; it is
`failure.png` under `dist/.playwright/web-e2e-live/test-results/`.

### Secrets in the CI log

GitHub masks the password and TOTP secret (repository secrets) and the
connection string and its key (`::add-mask::`) in the job log, so the masked
log cannot show whether the proof printed one. The `web-acceptance` job's last
step, which runs whether the proof passed or not, checks the proof's **raw**
output instead (the file `tee` wrote, before masking) and fails the job if it
holds:

- a connection string's `SharedAccessKey=` field;
- the password;
- the TOTP secret, as stored or normalized;
- any 6-digit TOTP code for any 30 s window from 35 min before the check to
  1 min after it, which covers the job's 30 min timeout. A code is matched
  only as a whole 6-digit number.

It prints one line per check (`leak check: password: none`, and so on) and,
on a hit, line numbers only, never the text it found.

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
HUB_HOST=$(az iot hub list -g meatgeek-v2-dev-rg --query '[0].properties.hostName' -o tsv)
export SIMDEVICE_WEB_CONNECTION_STRING=$(az iot hub device-identity connection-string show \
  --hub-name "$HUB_HOST" --device-id "$ACCEPTANCE_WEB_DEVICE_ID" --auth-type login \
  --query connectionString -o tsv)

npx nx e2e-live web-e2e
```

`read -rs` keeps the two secrets out of your shell history. The device must
already exist in IoT Hub; the proof registers it with the API, not with the
hub. The unit tests for the proof's pure parts (env checks, the build and
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

## How it is built

```
apps/api/acceptance/
├── jest.config.ts              # its own jest config: matches live.acceptance.ts only
├── live.acceptance.ts          # entry point for `nx run api:acceptance`
├── lib/
│   ├── checks.ts               # shared response checks (system properties, error code)
│   ├── clock.ts                # HAR-120: the one clock every wait goes through (fake in the self-test)
│   ├── devices.ts              # HAR-85: DELETE /devices/{id} and the always-run cleanup step
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
  polls, never, or registers the simulated device to someone else. The poll
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

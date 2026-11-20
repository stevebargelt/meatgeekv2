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

| Proof file                          | Proof                                                                                                                                                                                  | Expects                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cooks-unauthenticated.proof.ts`    | `GET /cooks` with no `Authorization` header                                                                                                                                            | `401`                                                                                                                                                                                                                                                                                                        |
| `cooks-lifecycle.proof.ts`          | `POST /devices` registering `acceptance-cook-<runId>` with a run-unique name                                                                                                           | `201`; the device id is the one sent                                                                                                                                                                                                                                                                         |
|                                     | `POST /cooks` with a new UUID `id` on `acceptance-cook-<runId>`                                                                                                                        | `2xx`; body is an api-interfaces `Cook` with no Cosmos system property (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`), status `active`                                                                                                                                                                    |
|                                     | `GET /cooks/{cookId}` for the new cook (HAR-75)                                                                                                                                        | `200`; `id`, `deviceId` and `status` equal the `POST` response                                                                                                                                                                                                                                               |
|                                     | the same as the peer                                                                                                                                                                   | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks/{cookId}` for a new random UUID                                                                                                                                            | `404` with `error: NOT_FOUND`                                                                                                                                                                                                                                                                                |
|                                     | `GET /cooks/active-device:<device>` (the device lock, in the owner's partition while the cook runs)                                                                                    | `404` with `error: NOT_FOUND`: a lock is not a cook                                                                                                                                                                                                                                                          |
|                                     | `GET /cooks`                                                                                                                                                                           | the new cook is listed (pages via `continuationToken`)                                                                                                                                                                                                                                                       |
|                                     | `GET /cooks?deviceId=<device>&status=active`                                                                                                                                           | `200`; returns exactly the new cook, `active`, on that device, in one page                                                                                                                                                                                                                                   |
|                                     | `POST /cooks/{cookId}/stop`                                                                                                                                                            | `2xx`; the cook is `completed` with an `endTime`                                                                                                                                                                                                                                                             |
|                                     | `GET /cooks/{cookId}`                                                                                                                                                                  | `200`; `status: completed` with an `endTime`                                                                                                                                                                                                                                                                 |
|                                     | `GET /cooks`                                                                                                                                                                           | the cook reads back `completed`                                                                                                                                                                                                                                                                              |
|                                     | `GET /cooks?deviceId=<device>&status=active`                                                                                                                                           | `200`; returns no cook after the stop                                                                                                                                                                                                                                                                        |
|                                     | `POST /cooks` on the unregistered `acceptance-unowned-<runId>`                                                                                                                         | `403`; `error` is `DEVICE_NOT_OWNED`                                                                                                                                                                                                                                                                         |
|                                     | `GET /cooks?deviceId=acceptance-unowned-<runId>`                                                                                                                                       | `200`; returns no cook (the refused start wrote nothing)                                                                                                                                                                                                                                                     |
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
`404 RECIPE_NOT_FOUND` after it included (a point delete and a point read). A response without
it fails the proof. Responses that make no Cosmos call, such as a 401, carry no
header.

Acceptance cooks and devices are not cleaned up: there is no delete route for
either yet (no `DELETE /cooks`, no `DELETE /devices`). Each run uses its own
device ids. `devices.proof.ts` registers `acceptance-<runId>`.
`cooks-lifecycle.proof.ts` registers `acceptance-cook-<runId>` and runs the
cook lifecycle on it, because a cook may only start on a device the caller
owns (HAR-26); a fresh device per run also means runs never trip the
one-active-cook-per-device rule. Both register a run-unique name, so runs never
collide on device id or on the `(userId, name)` pair. The cooks proof's last
two steps use `acceptance-unowned-<runId>`, which is never registered.

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
  `signalr-isolation.proof.ts` (HAR-67, goal HAR-55 items 5 and 7b) proves a
  caller who does not own the simulated device receives nothing from it over
  SignalR. The owner is the run's caller; the peer is the zero-role acceptance
  peer (`ACCEPTANCE_PEER_BEARER_TOKEN`), which a proof sends as with
  `api.request({ ..., as: 'peer' })`. The peer's `POST /negotiate` carries
  `?deviceId=<simulated device>`, which negotiate must ignore: it adds a caller
  only to the groups of devices it owns. The peer's connection records every
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
`temperature-data` Event Hub → `broadcastTemperature` → SignalR group
`device-{deviceId}`. `POST /negotiate` puts the caller in the group of every
device it owns, so the proof registers the simulated device first and
negotiates after. It opens one connection (dev SignalR is `Free_F1`: 20
concurrent connections, 20,000 messages a day) and stops it whichever step
fails. A new Event Hub consumer group can replay retained events, so older
readings of the device may arrive first; the proof matches the one it sent by
`timestamp`, as an instant. `broadcastTemperature` logs
`broadcastTemperature sent=<n> skipped=<m>`, but App Insights shows nothing from
dev (MG-37), so this proof's output is the only evidence of delivery: a timeout
says how many `temperature` messages did arrive, how many for the device, and
the last `timestamp` among them.

`recipes.proof.ts` cleans up after itself: it creates one recipe named
`Acceptance recipe <runId>`, and its sixth step deletes it. If an earlier step
fails, the runner skips the rest of the group, so that run's one recipe stays in
the acceptance identity's partition; its run-unique name says which run left it.

The acceptance profile is not cleaned up either: there is no `DELETE /users/me`.
It is keyed by the caller's identity, so every run writes the same document,
the CI service principal's profile. The first run creates it (`201`) and later
runs replace it (`200`); each run writes its own `Acceptance <runId>` name, so
the read-back proves that run's write. Its `devices` lists every acceptance
device the identity has registered.

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

| Metric                    | Proof file                          | Value                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roundtrip-ms`            | `telemetry-roundtrip.proof.ts`      | ms from simdevice's `sentAt` (IoT Hub acknowledged the publish) to the `GET /temperatures/current` response that first carried the reading; overstated by up to one poll (1 s)                                                        |
| `history-readings-before` | `telemetry-volume.proof.ts`         | readings the first walk of the simulated device's history counted                                                                                                                                                                     |
| `topup-sent`              | `telemetry-volume.proof.ts`         | readings the top-up sent; `0` when none was needed                                                                                                                                                                                    |
| `topup-ms`                | `telemetry-volume.proof.ts`         | how long the top-up's simdevice run took; `0` when none was needed                                                                                                                                                                    |
| `history-readings`        | `telemetry-volume.proof.ts`         | readings the measuring walk counted (≥ 8,640)                                                                                                                                                                                         |
| `history-pages`           | `telemetry-volume.proof.ts`         | pages of 1,000 the measuring walk took                                                                                                                                                                                                |
| `history-ru-first-page`   | `telemetry-volume.proof.ts`         | RU of the measuring walk's first page (`limit=1000`, no token)                                                                                                                                                                        |
| `history-ru-last-page`    | `telemetry-volume.proof.ts`         | RU of its last page, reached by continuation token; must be ≤ 1.5 × the first                                                                                                                                                         |
| `signalr-delivery-ms`     | `signalr-live-temperature.proof.ts` | ms from just before `simdevice --count 1` starts to the client receiving the reading on target `temperature`. Includes simdevice's start-up and IoT Hub connect, so it overstates hub-to-client delivery by about the `EXEC` duration |
| `isolation-peer-messages` | `signalr-isolation.proof.ts`        | messages the peer received on any target, by the end of the 15 s grace after `cook_stopped` (or by the failing check). The proof fails unless it is `0`                                                                               |
| `signalr-cook-event-ms`   | `signalr-isolation.proof.ts`        | ms from just before the owner's `POST /cooks` to the owner's client receiving `cook_started` for that cook                                                                                                                            |
| `twin-apply-ms`           | `device-twin.proof.ts`              | ms from the start's `201` to the exit of `simdevice --twin --count 1`: a reconnect, two twin GETs, the reported patch and one reading's send                                                                                          |

There are no thresholds on them; the numbers are the deliverable. The CI job copies every line starting with
`METRIC ` into the run summary. Proofs print one with `api.metric(name, value)`.

Any failed proof makes the process exit non-zero, and the `FAIL` line names the
proof, the route and the status received (or `simdevice → exit <code>` when
simdevice was the last thing it ran). Secrets are never printed: the suite logs
no request or response headers or bodies (only a bare upper-case `error` code
from an error body), never prints simdevice's stdout or stderr raw (stdout is
parsed as JSON lines; of stderr only the first line is reported, on failure),
and masks in every line, as a second guard, both bearer tokens, the
`SIMDEVICE_CONNECTION_STRING` value, and its `SharedAccessKey` value.

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

## How it is built

```
apps/api/acceptance/
├── jest.config.ts              # its own jest config: matches live.acceptance.ts only
├── live.acceptance.ts          # entry point for `nx run api:acceptance`
├── lib/
│   ├── checks.ts               # shared response checks (system properties, error code)
│   ├── proof.ts                # the proof contract: defineProofs, AcceptanceApi
│   └── runner.ts               # env check, HTTP client, simdevice, redaction, output, RU table
├── proofs/
│   ├── cooks-lifecycle.proof.ts
│   ├── cooks-unauthenticated.proof.ts
│   ├── device-twin.proof.ts
│   ├── devices.proof.ts
│   ├── recipes.proof.ts
│   ├── telemetry-roundtrip.proof.ts
│   ├── telemetry-volume.proof.ts
│   ├── temperatures.proof.ts
│   └── users.proof.ts
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
  interval and cap are `ROUNDTRIP_POLL` in the proof file, which the self-test
  shortens; there is no environment variable for them. For the volume proof the
  stub keeps a reading count for the simulated device; the fake reports a
  top-up to the stub, which makes it readable a batch per poll, or never, and
  the fake can fail a top-up with exit 1. The self-test also checks that the
  top-up passes `--inflight 32 --interval 50ms` and a kill limit of
  `count × 50 ms × 1.5 + 120 s`. Its target, margin, interval, inflight and poll
  pacing are `VOLUME` in the proof file; the self-test shrinks the target to a
  few hundred readings and the polls to milliseconds. For the twin proof the
  stub keeps a device twin for the simulated device that start and stop sync
  as the API does; the fake `simdevice --twin` reads it from the stub, which
  applies desired to reported, and prints the twin line. The stub can print a
  wrong desired cook id or a reported version one behind, or answer the start
  with `503 DEVICE_TWIN_UPDATE_FAILED`; each fails the proof and still leaves
  no cook active. Its poll pacing is `TWIN_POLL` in the proof file.
- The acceptance code is not part of the API build; `dist/apps/api` contains
  none of it.
- It uses only Node built-ins (`fetch`, `http`, `crypto`, `child_process`); no
  extra dependencies.

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
   proof passes against a correct server and fails against a broken one.
4. **If the route reads or writes Cosmos, return the RU header** from the
   handler: merge `requestChargeHeaders(charge)` from
   `apps/api/src/shared/cosmos/request-charge.ts` into its response headers, and
   unit-test it in the handler's `*.spec.ts`.
5. **Run it** against dev as above, and quote the run in the PR.
6. **Write the acceptance criterion** as: "the acceptance run on the merge
   commit is green, including `<proof name>`".

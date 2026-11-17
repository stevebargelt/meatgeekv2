# `POST /cooks` is made retry-safe by a client-supplied cook id, and a device holds at most one active cook per user, enforced by a lock document written in the same transactional batch

- **Status:** Accepted
- **Date:** 2026-11-17
- **Ticket:** MG-84 (MG-59 review RF-1: a retried start created a second cook
  and a second `COOK_STARTED`).
- **Scope:** `apps/api/src/functions/cooks/start-cook.ts`,
  `apps/api/src/shared/cosmos/cooks-repository.ts` (`startCook`, lock-aware
  `stopCook`, list filter), `libs/api-interfaces` (`StartCookRequest.id`), the
  OpenAPI spec, the mock server, and the curl smoke doc.

## Decision 1 — the client supplies the cook id

`StartCookRequest.id` is a required UUID. The client generates it once per start
intent and resends it, with the same body, on every retry. There is no
server-minted fallback: a request without an id could not be retried safely, so
a fallback would keep the bug for exactly those callers.

- **201**: this call created the cook. `COOK_STARTED` is emitted once.
- **200**: a cook with this id already exists in the caller's partition with the
  same request fields (`deviceId`, `name`, `meatType`, `weight`, `targetTemps`,
  `notes`). The stored cook is returned and nothing is emitted. This covers a
  retry after success and a concurrent duplicate.
- **422 `COOK_ID_REUSED`**: the id exists with a different body.
- **400 `VALIDATION_ERROR`**: the id is missing or not a UUID.

**Why not an `Idempotency-Key` header.** Cosmos already enforces `(partition,
id)` uniqueness, so the cook's primary key is the dedupe. Concurrent duplicates
collapse because exactly one create can win; there is no idempotency-record
store, no TTL, and no extra RU against the shared 400 RU/s pool. The cost is a
breaking change to the request body, which was cheap because no app client
called the route yet. A general `Idempotency-Key` mechanism would still be
needed if a non-create endpoint ever needs idempotency.

## Decision 2 — one active cook per (user, device)

A start on a device that already has a non-terminal cook returns **409
`COOK_ALREADY_ACTIVE`** with `activeCookId`. The data-pusher holds exactly one
active cook id per device, so a second active cook would misattribute
telemetry.

The rule is held by a lock document, `active-device:<deviceId>` with
`docType: 'activeDeviceLock'` and `cookId`, in the caller's `/userId` partition.

- **Start** runs one transactional batch: create the cook, create the lock. A
  409 on the cook is a replay (checked first, so a retry of the cook that holds
  the device is a 200, not a 409). A 409 on the lock means the device is held:
  the holder is read, and if it is still non-terminal the device is busy. A
  stale lock (holder completed, cancelled or missing) is replaced under
  If-Match on the next batch. At most `START_COOK_MAX_ATTEMPTS` batches.
- **Stop** replaces the cook (If-Match) and deletes the lock in one batch when
  the lock names this cook. A cook without a lock (created before MG-84) takes
  the plain conditional replace.
- **List** excludes lock documents (`NOT IS_DEFINED(c.docType)`). Lock documents
  never pass through `toCook`, so they cannot reach a response or an envelope.

A separate container was rejected: it cannot share a transactional batch with
the cook, so the check-then-write race would come back. A "query for an active
cook, then create" check was rejected for the same race.

**Transactional batch failures do not throw.** `@azure/cosmos` 4.5 returns HTTP
207 with a status per operation (the failing one carries its own code, the rest
424), so the repository reads the outcome per operation. Transport failures
still throw.

## Limits

- **Per user, not device-wide.** The lock lives in the caller's partition. Two
  different users can still start on the same device until start-cook rejects
  devices the caller does not own (MG-83).
- **Existing dev data.** Active cooks created before MG-84 have no lock, so they
  do not block a new start on their device. There were no production cooks, so
  no backfill was written.
- **Clients.** `apps/mobile` and `apps/web` have no API client yet. The contract
  lives in the OpenAPI spec, `libs/api-interfaces` and the mock server, which
  implements the same 201/200/409/422 behaviour.

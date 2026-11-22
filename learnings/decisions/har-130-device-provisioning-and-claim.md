# A device gets its IoT Hub identity from DPS with a key it generates itself, and an owner claims it only with a claim code the device publishes as a hash in its twin

- **Status:** Accepted
- **Date:** 2026-11-22
- **Ticket:** HAR-133 (goal HAR-130: a real MeatGeek Pi is onboarded with one
  command and claimed by its owner; nobody claims a device they do not hold).
- **Scope:** `apps/api/src/functions/devices/claim-device.ts`,
  `apps/api/src/shared/devices/claim-code.ts`,
  `apps/api/src/shared/cosmos/devices-repository.ts` (`claimDevice`),
  `apps/api/src/shared/iothub/device-twin.ts` (reported properties),
  `libs/api-interfaces` (`Device.claimedAt`, `ClaimDeviceRequest`,
  `CLAIM_REFUSED`), `libs/api-interfaces/test-vectors/claim-code.json`, and the
  OpenAPI spec. Provisioning, release, revoke and the readings clamp are built
  in later issues of HAR-130; this record states their design so those issues
  build to it.

## Context

`POST /devices` gives any caller any unused `deviceId`: first come, first
served. Anyone who guesses or reads a device id can take the device, and its
readings then go to them. The device itself also needs an IoT Hub identity,
which today is created by hand with a key copied to it.

## Decision 1 — provisioning through DPS, X.509 individual enrollment, key generated on the device

_Built in later issues of HAR-130 (HAR-131 infrastructure, HAR-132 pusher)._

A device gets its IoT Hub identity from the IoT Hub Device Provisioning Service
(DPS). The Pi generates an ECDSA P-256 key and a self-signed certificate
(CN = device id) on itself; only the public certificate leaves the Pi. An
individual enrollment carries that certificate; the device registers over
HTTPS with mutual TLS, DPS creates or updates its hub identity (X.509
thumbprint), and the device then connects over MQTT/TLS with its client
certificate. No SAS key.

The DPS ↔ IoT Hub link is identity-based: DPS's system-assigned identity holds
`IoT Hub Registry Contributor` on the hub. A keyed link (a connection string
in Terraform state) is the fallback only if ARM rejects identity linking, and
would come back as a decision.

**Why DPS rather than creating hub identities directly.** The device never has
to be told which hub or given a key; the enrollment is the one place to disable
a device so it cannot re-register; CI's simulated devices and a real Pi take
the same path; and more hubs or regions need no device change.

**Rejected alternatives.**

- Symmetric-key group enrollment: the device key is derived off the device from
  a group master key and copied to the Pi, a secret in transit, and one leaked
  group key compromises every device.
- Symmetric-key individual enrollment: the same secret in transit.
- X.509 CA group enrollment: needs a CA private key held somewhere (the owner's
  laptop, or Key Vault signing) for a one-device fleet. More secret surface and
  no benefit until there is a fleet.
- TPM attestation: the Pi has no TPM.

**Cost.** DPS S1 is **$0.10 per 1,000 operations, with no standing fee** (Azure
Retail Prices API, westus2, `IoT Hub Device Provisioning | S1 Operations`). A
Pi registers once per fresh install or re-provision (about 2–5 operations,
register plus status polls), and CI enrols about 4 devices per run: well under
$0.01 a month.

## Where each credential lives

| Credential               | Lives                                                                                                                                                                       | Lifetime                                                                               | Readable by          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| Device private key       | Pi only: `/var/lib/meatgeek-pusher/identity/device.key`, 0600, service user                                                                                                 | Until revoke or re-image (certificate valid 5 years; rotation belongs to the OTA goal) | The pusher service   |
| Device certificate       | Pi, the DPS enrollment, the hub identity's thumbprint                                                                                                                       | Same                                                                                   | Public               |
| CI simulated-device keys | The runner's temp dir                                                                                                                                                       | One run; enrollments and hub identities deleted by an always-run cleanup step          | That job             |
| DPS ↔ hub link          | DPS managed identity plus RBAC                                                                                                                                              | Standing; no key                                                                       | —                    |
| Enrol and revoke rights  | Owner: their own `az` login. CI: the app-deploy identity with `Device Provisioning Service Data Contributor` on the DPS (Terraform, flag-guarded until bootstrap is re-run) | Standing                                                                               | —                    |
| Claim code (plaintext)   | Pi only: `/var/lib/meatgeek-pusher/claim/claim.json`, 0600; printed once by the onboarding command                                                                          | 24 h, single use                                                                       | Whoever holds the Pi |
| Claim code hash          | The twin's reported properties (device-written)                                                                                                                             | Until the device rotates it                                                            | The API              |
| Device SAS keys          | Nowhere, once the pusher's connection-string mode is removed                                                                                                                | —                                                                                      | —                    |

## Decision 2 — the claim code is the proof of possession (built here)

The device generates a claim code and keeps the plaintext. It reports only a
hash, in its device twin's **reported** properties. Only the device,
authenticated with its own credential, can write reported properties, so a hash
there that matches what a claimant typed proves the code came from the device,
and so that the claimant has (or had) the device in hand. The API never stores
the code.

- **Code:** 12 Crockford base32 symbols (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
  60 bits from `crypto/rand`), shown `XXXX-XXXX-XXXX`.
- **Normalizing input:** remove `-` and ASCII whitespace, upper-case ASCII
  letters, map `O` → `0` and `I`/`L` → `1`. Anything that is not then exactly
  12 alphabet symbols is a 400. Upper-casing is ASCII-only, because a full
  Unicode upper-case differs between JavaScript and Go (`ß` → `SS` in one, not
  the other) and the two sides must agree on every input.
- **Hash:** lowercase hex SHA-256 of the UTF-8 string
  `meatgeek-claim-v1:<deviceId>:<normalized code>`. The device id is in the
  hash, so one code cannot claim another device.
- **Claimant hash:** lowercase hex SHA-256 of `meatgeek-claimant-v1:<userId>`.
  The device never sees a user id.
- **Shared vectors:** `libs/api-interfaces/test-vectors/claim-code.json`
  (`{ deviceId, input, normalized, hash }`, `normalized: null` for inputs that
  must be refused). The API's tests read it; the device's Go tests read the
  same file by relative path. Change the rules and the file together.

**Twin properties.** Flat strings, like `activeCookId` / `correlationId`.
Existing cook properties are untouched.

- reported (device-written): `claimCodeHash`, `claimExpiresAt` (ISO-8601 UTC),
  `claimGeneration` (decimal string)
- desired (API-written): `claimGeneration` (decimal string; absent means
  `"0"`), `claimConsumedCodeHash`, `claimClaimantHash`

**The device mints a code** (writes the file, then reports the hash) when it
starts unclaimed with no unexpired code, or when desired `claimGeneration` is
not its stored one: greater after a release, lower only when the twin was
re-created, and a code under any generation but the desired one could never
be claimed. It never mints while its current hash equals desired
`claimConsumedCodeHash` and the generations match (claimed). _Device side
built in HAR-134 (`apps/data-pusher/internal/claim`)._

### `POST /devices/claim`

Body `{ deviceId, claimCode, name, model?, location?, configuration? }`. Unknown
keys are rejected. `deviceId`, `name`, `location` and `configuration` follow
the `POST /devices` rules; `model` defaults to `"MeatGeek"`.

1. Authenticate (the Easy Auth principal, as every route). Validate.
2. Read the twin. IoT Hub 404 → refused.
3. Hash the code. Refused unless reported `claimCodeHash` equals it
   (`crypto.timingSafeEqual`), reported `claimGeneration` equals desired
   `claimGeneration`, and `claimExpiresAt` is later than now (an injected
   clock).
4. If desired `claimConsumedCodeHash` already equals the hash: continue only if
   desired `claimClaimantHash` is the caller's (a retry after a partial
   failure); otherwise refused.
5. Otherwise patch desired `{ claimConsumedCodeHash, claimClaimantHash }` with
   `If-Match: <etag from step 2>`. **This conditional patch is what makes a
   code single-use** when two claimants race: only one patch can win against a
   given etag. A 412 re-reads once and decides again from step 3; a second 412
   is a 503.
6. Cosmos `create` (never upsert) the device document: the register shape plus
   `claimedAt` (ISO-8601 UTC, from the clock), owner = the caller. If the id
   exists: the caller's document → **200** with it; another owner's → refused.

The twin is patched **before** the document is created. A failure between the
two leaves the code consumed by the caller, so the same caller's retry
completes the claim and nobody else can use the code. The reverse order would
let a document exist for a claim whose code was never consumed.

| Answer                              | When                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **201**                             | the stored device                                                                                                                                   |
| **200**                             | a retry by the same caller (the stored device, unchanged)                                                                                           |
| **400 `VALIDATION_ERROR`**          | bad body, bad code length or alphabet, unknown key                                                                                                  |
| **401 `UNAUTHENTICATED`**           | no usable principal                                                                                                                                 |
| **403 `CLAIM_REFUSED`**             | every refusal: unknown device, no twin, no reported code, wrong code, expired, generation mismatch, consumed by someone else, owned by someone else |
| **409 `DEVICE_CONFLICT`**           | the caller already has another device with that name                                                                                                |
| **503 `DEVICE_TWIN_UPDATE_FAILED`** | a twin read or write failed (`reason` is a fixed `iothub_*` code); nothing stored                                                                   |

**No oracle.** The 403 is one fixed body (`Device could not be claimed with
that code`) and, unlike every other answer that reached Cosmos, carries no
request-charge header, so the answer gives no hint which check failed. The log
line and the span carry a fixed refusal code (`wrong_code`, `expired`, ...) for
operators.

**Nothing secret is emitted.** The claim code, its hash and the claimant hash
never appear in a log line, an error body or a span attribute (a unit test
captures all three).

**Brute force.** 60 bits within a 24-hour code lifetime is out of reach over
HTTP. There is no claim-attempt rate limit in this goal; revisit it if codes
ever get shorter.

**`POST /devices` stays for now.** The live acceptance suite and the web app
still use it. It is removed (route, contract) in a later issue of HAR-130 once
both claim instead.

## Decision 3 — release (built in a later issue of HAR-130)

`DELETE /devices/{id}` becomes release, owner only. **409 `COOK_ACTIVE`** while
a cook is active on the device (stop it first). Otherwise patch desired
`claimGeneration` + 1 and `claimClaimantHash: null`, keeping
`claimConsumedCodeHash`, with `If-Match`; then delete the document → 204. The
device sees the generation bump and mints a fresh code; the old one stays
consumed, so it can never claim again. 403 `DEVICE_NOT_OWNED` and 404 as today.

## Decision 4 — revoke (built in a later issue of HAR-130)

`revoke-device.sh <deviceId>`, run on the owner's machine: disable the DPS
enrollment (no re-registration) and set the hub identity `status=disabled` (the
hub drops and refuses its connections). The ownership record is untouched: the
owner sees the device disconnected and can release it. Re-onboarding a revoked
Pi needs `REINSTATE=1` on the enrol step.

## Decision 5 — readings of unclaimed and re-claimed devices (built in a later issue of HAR-130)

- A device sends readings whether or not it is claimed. An unclaimed device's
  readings are stored (Cosmos TTL) but pushed to nobody: the broadcaster finds
  no owner. No route returns them, since every temperatures route requires
  ownership.
- **An owner sees readings only from their `claimedAt` onward**: the
  temperatures routes clamp their lower bound to the device document's
  `claimedAt`, so readings from unclaimed time or from a previous owner never
  reach the new owner.
- After a release, the next reading's owner lookup finds no document, so the
  old owner gets nothing from then on.

`claimedAt` is optional on `Device` because devices registered through
`POST /devices` have none.

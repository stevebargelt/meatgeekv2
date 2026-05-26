# MeatGeek V2 API spec

OpenAPI 3.0.3 source-of-truth for the Phase-1 HTTP surface and the SignalR
message payloads.

## Layout

```
spec/
  openapi.yaml                          # entrypoint — paths + components.schemas
  paths/
    cooks.yaml                          # path items keyed by route alias
    temperatures.yaml
    devices.yaml
  components/
    schemas/
      common.yaml                       # error envelope, pagination, ISODateTime
      cook.yaml                         # CookStatus, Cook, StartCookRequest, ...
      temperature.yaml                  # TemperatureReading, alerts, history
      device.yaml                       # Device, configuration, list wrapper
      signalr-payloads.yaml             # message envelopes for temperatureHub
```

`openapi.yaml` is the single entry point — every external tool (swagger-parser,
openapi-typescript, oapi-codegen, Swagger UI) points at this file.

The split is purely organizational: `openapi.yaml`'s `components.schemas`
block re-publishes every named schema from the sub-files via `$ref`, so the
final dereferenced spec exposes a flat `components.schemas` namespace.

`paths/*.yaml` files contain path items keyed by a stable alias
(`cooks-collection`, `cook-item`, `cook-start`, ...). `openapi.yaml` mounts
each alias under its real URL via `$ref`.

## Conventions

- **Schemas live in `components/schemas/`.** Path files reference schemas via
  `../components/schemas/<file>.yaml#/<SchemaName>`. Inline schemas are
  discouraged — if you need a one-off shape, add it to the appropriate
  schema file and reference it.
- **Named enums, not anonymous unions.** `CookStatus`, `ConnectionStatus`,
  `SignalRMessageType`, etc. are top-level schemas with an `enum:` list so
  language generators emit typed constants instead of `string` /
  `map[string]interface{}`.
- **`additionalProperties: false` by default** on payload bodies. The only
  exception is `metadata`-style free-form bags (e.g.
  `SystemNotificationMessage.payload.metadata`), where it is set to `true`
  intentionally.
- **Error envelopes are flat.** `common.yaml#/ErrorResponse` matches the
  shape that `apps/api/src/functions/**/*.ts` handlers actually return —
  `{error, message, requestId}` — NOT the nested `ErrorResponse` from
  `libs/api-interfaces/src/lib/common.ts`. The spec follows wire reality.
- **Implementation-status prefix.** Every endpoint that is not yet wired up
  in `apps/api/src/main.ts` carries a description that starts with
  `NOT YET IMPLEMENTED -`. Grep for that prefix to enumerate the gap.

## Adding a new endpoint

1. **Add or reuse schemas.** If the endpoint introduces new request/response
   bodies, add them to the relevant `components/schemas/<file>.yaml` and
   register them under `openapi.yaml#/components/schemas/...`.
2. **Add a path item.** Choose the right `paths/<file>.yaml` and append a
   keyed entry (e.g. `cook-bulk-import:`) with `get`/`post`/etc. under it.
3. **Mount it.** Add `'/the-real-url': $ref: './paths/<file>.yaml#/<alias>'`
   to `openapi.yaml`'s top-level `paths` block.
4. **Prefix description with `NOT YET IMPLEMENTED -`** until the handler
   exists in `apps/api/src/main.ts`.
5. **Validate locally.** Run
   `npx @apidevtools/swagger-parser validate libs/api-specs/spec/openapi.yaml`
   before committing.

## Adding a new SignalR message type

1. Add the new value to `SignalRMessageType` enum in `signalr-payloads.yaml`.
2. Add a concrete `XxxMessage` schema that `allOf`s `SignalREnvelopeBase`
   and tightens `type` to the single enum value.
3. Append the concrete schema to the `SignalRMessage.oneOf` list and add
   a mapping under `SignalRMessage.discriminator.mapping`.
4. Re-publish the concrete schema in `openapi.yaml#/components/schemas/...`.

Every SignalR envelope schema MUST include `correlation` as a required
field. This is non-negotiable — downstream tracing depends on it.

## Validating the spec

```bash
# Surface-level validation (structural + reference resolution)
npx @apidevtools/swagger-parser validate libs/api-specs/spec/openapi.yaml

# Generator smoke (proves the spec is codegen-friendly for the TS side)
npx openapi-typescript libs/api-specs/spec/openapi.yaml -o /tmp/types.d.ts

# Generator smoke (Go side — see contract-tests/oapi-codegen-smoke.sh)
docker run --rm -v "$(pwd)":/work deepmap/oapi-codegen:latest \
  -package=apispecs /work/libs/api-specs/spec/openapi.yaml > /tmp/api.go
```

## Currently-implemented routes

These four routes are wired up in `apps/api/src/main.ts`. The spec MUST stay
character-for-character aligned with their route templates and response
shapes:

| HTTP method | Route template (main.ts)           | OpenAPI path                       | Handler |
|-------------|------------------------------------|------------------------------------|---------|
| GET         | `cooks`                            | `/cooks`                           | `cooks/list-cooks.ts` |
| POST        | `cooks`                            | `/cooks`                           | `cooks/start-cook.ts` |
| GET         | `temperatures/current/{deviceId}`  | `/temperatures/current/{deviceId}` | `temperatures/get-current.ts` |
| GET         | `devices`                          | `/devices`                         | `devices/get-devices.ts` |

Preserved wire-shape quirks:

- `GET /cooks` returns `CookListResponse` (NOT wrapped in `ApiResponse`).
- `POST /cooks` returns the created `Cook` directly at 201 (NOT wrapped).
- `GET /temperatures/current/{deviceId}` returns a bare `TemperatureReading`
  (NOT wrapped).
- `GET /devices` wraps the array in `{ devices: [...] }`.

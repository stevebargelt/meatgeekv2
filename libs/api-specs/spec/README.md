# MeatGeek V2 API spec

OpenAPI 3.0.3 description of exactly what the API serves: the HTTP routes
`apps/api/src/main.ts` registers and the SignalR messages the API sends. An
operation is here if and only if `main.ts` registers it; the drift check in
`apps/api/src/contract/contract.spec.ts` (run by `npx nx test api` on every
pull request) fails otherwise.

The bodies are checked too, against the deployed API. The live acceptance run
(`docs/development/live-acceptance.md`, HAR-77) checks every response it
receives: the status must be declared, a JSON body must match its schema, and
a declared `X-Request-ID` must be present. It also checks every SignalR
message it receives against `x-signalr`. A response the spec does not describe
fails the Deploy Dev App run on `main`. So when a handler's output changes,
change its schema in the same pull request.

## Layout

```
spec/
  openapi.yaml                  # entrypoint: paths, x-signalr, components
  paths/
    cooks.yaml                  # GET/POST /cooks, GET /cooks/{cookId}, GET /cooks/{cookId}/chart,
                                # POST /cooks/{cookId}/stop
    negotiate.yaml              # POST /negotiate (SignalR)
    temperatures.yaml           # /temperatures/current/{deviceId}, /temperatures/history
    devices.yaml                # /devices, /devices/{id}
    users.yaml                  # GET/PUT /users/me
    recipes.yaml                # /recipes, /recipes/{id}
    health.yaml                 # GET /health/cosmos
  components/
    headers.yaml                # X-Request-ID, x-meatgeek-request-charge
    parameters.yaml             # shared path parameters
    responses.yaml              # shared responses (401, 500, device/recipe 400/404)
    schemas/
      common.yaml               # ErrorCode, error bodies, health, shared enums
      cook.yaml                 # Cook, StartCookRequest, CookListResponse, CookChart
      temperature.yaml          # TemperatureReading, TemperatureHistoryResponse
      device.yaml               # Device, configuration, requests, list wrapper
      user.yaml                 # User, preferences, PutUserProfileRequest
      recipe.yaml               # Recipe, requests, list wrapper
      signalr-payloads.yaml     # negotiate response and the x-signalr messages
      live-activity.yaml        # the iOS lock-screen activity's attributes and content state
```

`openapi.yaml` is the single entry point; every tool (swagger-parser,
openapi-typescript, oapi-codegen, Swagger UI) points at it. Its `components`
block re-publishes every shared piece from the sub-files, so the dereferenced
document has flat `components.schemas`, `responses`, `headers` and
`parameters` namespaces. `paths/*.yaml` hold path items keyed by an alias
(`cooks-collection`, `cook-stop`, ...) that `openapi.yaml` mounts under the
real path.

The server base is `/api`: `main.ts` registers `cooks`, the Functions host
serves it at `/api/cooks`, and the spec's path is `/cooks`.

## Conventions

- **Describe what the handler does.** Parameters carry the validation the
  handler applies (patterns, ranges, defaults); every status code the handler
  can return is listed with its body and the headers it carries. Where a
  handler is lenient (ignores a field, clamps a value), say so in the
  description rather than declaring a rule it does not enforce.
- **Auth.** The document-level `security` requires `bearerAuth` (an Entra
  access token, validated by App Service Authentication). Every operation
  declares a `401`: `components/responses.yaml#/Unauthenticated` when the
  handler reads the principal, `#/PlatformUnauthenticated` when only Easy
  Auth can answer it.
- **Errors are flat:** `{error, message, requestId}` plus a variant's extra
  fields. `ErrorCode` lists every code the API emits and must equal
  `ERROR_CODES` in `libs/api-interfaces/src/lib/common.ts`.
- **Headers.** Declare `X-Request-ID` and `x-meatgeek-request-charge` on each
  response that carries them (`components/headers.yaml`).
- **Named enums, not anonymous unions**, so generators emit typed constants.
- **`additionalProperties: false`** on response bodies and on request bodies
  whose handler rejects unknown fields.

## Changing a route

Change `main.ts` and the spec in the same pull request:

1. Add or reuse schemas in `components/schemas/<file>.yaml` and register them
   under `openapi.yaml#/components/schemas`.
2. Add the operation to a path item in `paths/<file>.yaml`, or a new path
   item, and mount it under `openapi.yaml#/paths`.
3. Run `npx nx test api`. It names any route or operation that is out of
   line, and any operation missing `bearerAuth` or a `401`.
4. Run `npx nx run api-specs:bundle-ios` and commit the updated iOS bundle
   (`apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml`). `npx nx test
   api-specs` fails until you do. This applies to any change under `spec/`,
   descriptions included.

## Changing a SignalR message

The top-level `x-signalr` extension lists the hub, the negotiate route, and
each SignalR target the API sends, mapped to the schema of its argument. To
add or change one, change the producer and the schema in
`components/schemas/signalr-payloads.yaml` together, and register the schema
under `x-signalr.messages` keyed by its target. The drift check builds each
message with the real producer and validates it against its schema. Cook
events must keep `correlation.id` required.

## Validating the spec

```bash
# Structural validation and reference resolution
npx nx validate-spec api-specs

# The full drift check against the API
npx nx test api

# Generator smoke (TypeScript)
npx openapi-typescript libs/api-specs/spec/openapi.yaml -o /tmp/types.d.ts

# Generator smoke (Go; see contract-tests/oapi-codegen-smoke.sh)
bash libs/api-specs/contract-tests/oapi-codegen-smoke.sh
```

## Wire-shape notes

- `GET /cooks` returns `CookListResponse` (NOT wrapped in `ApiResponse`).
- `GET /cooks/{cookId}`, `POST /cooks` and `POST /cooks/{cookId}/stop` return the `Cook` directly.
- `GET /temperatures/current/{deviceId}` returns a bare `TemperatureReading`.
- `GET /devices` wraps the array in `{ devices: [...] }`; `GET`/`PATCH
/devices/{id}` and `POST /devices/claim` return a bare `Device`. There is no
  `POST /devices` (HAR-145).
- `GET /recipes` wraps the array in `{ recipes: [...] }`; `POST /recipes`,
  `GET`/`PATCH /recipes/{id}` return a bare `Recipe`; `DELETE /recipes/{id}`
  is `204` with no body.
- `POST /negotiate` returns `{ url, accessToken }`.

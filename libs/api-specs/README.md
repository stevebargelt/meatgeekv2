# @meatgeekv2/api-specs

The OpenAPI 3.0 contract for the MeatGeek V2 API: every HTTP route `apps/api`
serves and every SignalR message it sends, and nothing else.

The web client and the mobile client share nothing with the API but this
contract. The mobile client is a native iOS (Swift) app in `apps/ios`. The
contract is kept true by a drift check that runs on every pull request
(below).

## Consumers

| Consumer | How it reads the spec | What fails when they part |
|---|---|---|
| `apps/api` | Not generated; the drift check compares it with the spec | `nx test api` (below) |
| `apps/web` | `openapi-typescript` types, built on demand (`nx generate-types api-specs`) | `web:typecheck` / `web:build` |
| `apps/ios` | One-file bundle committed at `apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml`, written by `nx run api-specs:bundle-ios`; `swift-openapi-generator` generates the Swift client from it on each build | `nx test api-specs` while the bundle is stale; the iOS build once re-bundled |

After any change under `spec/`, run `npx nx run api-specs:bundle-ios` and
commit the updated bundle in the same pull request.

## Layout

```
libs/api-specs/
├── spec/                         The contract. See spec/README.md.
│   ├── openapi.yaml              Entrypoint
│   ├── paths/                    One file per route group
│   └── components/               Schemas, responses, headers, parameters
├── src/
│   ├── index.ts                  Re-export hub
│   ├── generated/                Build-on-demand TS types (NOT checked in)
│   └── lib/swagger-ui/           Swagger UI mount helper for an Express app
└── contract-tests/               Spec-only checks run by `nx test api-specs`
```

## The drift check

`apps/api/src/contract/contract.spec.ts` runs in `npx nx test api`, which CI
runs on every pull request. It fails when:

- a route `apps/api/src/main.ts` registers with `app.http` is not in the spec,
  or a spec operation is not registered (compared on method and path; a path
  parameter's name does not matter, its position does). The failure lists the
  routes missing from the spec and the operations missing from the API;
- an operation does not require the `bearerAuth` scheme or declares no `401`,
  or the 401 body's `reason` enum differs from what
  `apps/api/src/shared/auth/principal.ts` returns;
- the spec does not validate (`@apidevtools/swagger-parser`);
- a `temperature`, `cook_started` or `cook_stopped` message built by the real
  producers (`broadcast-temperature.ts`, `envelope.ts`) does not validate
  against its `x-signalr` schema;
- the `ErrorCode` enum differs from `ERROR_CODES` in `libs/api-interfaces`, or
  a handler writes an error code the enum lacks.

`apps/api`'s `test` target lists `libs/api-specs/spec/**` as an input, so a
spec-only change re-runs it rather than hitting the Nx cache.

`nx test api-specs` runs the spec-only checks in `contract-tests/` (see that
README). CI's `lint-and-test` matrix runs it on every pull request (HAR-107).

### The iOS bundle check

`contract-tests/ios-bundle.spec.ts`, in `nx test api-specs`, bundles the spec
in memory and fails when the committed
`apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml` differs, naming the
first differing line and the fix: `npx nx run api-specs:bundle-ios`. The
`test` target lists that file as an input, so a change to either side re-runs
it. Once re-bundled, the iOS build regenerates the Swift types from it, and
app code that no longer fits fails to compile in CI's `ios` job (HAR-161).

## NX targets

| Target | What it does |
|---|---|
| `nx build api-specs` | `tsc` library compile + copy `spec/` assets into `dist/libs/api-specs/spec` |
| `nx lint api-specs` | ESLint over `src/**` (excludes `src/generated/**`) |
| `nx test api-specs` | Jest: `contract-tests/*.spec.ts` (spec validation, TS round-trip). Run in CI. |
| `nx validate-spec api-specs` | Validates `spec/openapi.yaml` with `@apidevtools/swagger-parser` |
| `nx generate-types api-specs` | Emits `src/generated/types.d.ts` from the spec via `openapi-typescript` |
| `nx run api-specs:bundle-ios` | Bundles the spec into one file for the iOS client (`scripts/bundle-for-ios.ts`); deterministic, so a second run changes nothing |

`@apidevtools/swagger-parser` is a library with no command-line tool, so
`npx @apidevtools/swagger-parser validate ...` does not work; use
`nx validate-spec api-specs`.

## Changing the API

Change the handler and the spec in the same pull request. `npx nx test api`
tells you what is out of line. See `spec/README.md` for the spec's
conventions.

---

## Architectural decisions

### Decision: dual sources vs re-export

`libs/api-interfaces` holds hand-written TypeScript types for application
code; `libs/api-specs` is the wire contract. We do not re-export generated
types into `api-interfaces`: generated types are build-on-demand (below), so
re-exporting them would make every consumer run `nx generate-types api-specs`
first.

The two are kept in line by hand, with these checks:
- the drift check compares `ErrorCode` with `api-interfaces`' `ERROR_CODES`
  and validates real SignalR messages, built from `api-interfaces` types,
  against the spec;
- `contract-tests/round-trip.spec.ts` compiles sample `StartCookRequest`,
  `Cook` and `Device` values against types generated from the spec.

### Decision: SignalR in the same document

The hub and its messages are described in the same OpenAPI document, under
the top-level `x-signalr` extension, rather than in a separate AsyncAPI
document: one file to validate, one drift check. `x-signalr` names the hub
(`temperatureHub`), the route that negotiates a connection (`/negotiate`), and
maps each SignalR target the API sends (`temperature`, `cook_started`,
`cook_stopped`) to the schema of its single argument. Cook events carry a
required `correlation.id` so a user action can be traced end to end.

### Decision: generated types on-demand

Types generated by `openapi-typescript` go to `src/generated/` and are never
checked in: the path is in `.gitignore`, and `nx generate-types api-specs`
refreshes them. `src/generated/**` is excluded from the lib build and lint.

The web app imports them as `@meatgeekv2/api-specs/types` (a path in
`tsconfig.base.json`) and calls the API through `openapi-fetch` typed by them.
`web:build`, `web:test`, `web:lint` and `web:typecheck` all depend on
`api-specs:generate-types`, so the web app is always compiled against the spec
as it is now. A path or method the spec does not declare fails `tsc`.

### Decision: temperature query semantics (strict cookId tag-match)

`GET /temperatures/history?cookId=X` returns only readings whose `cookId` tag
equals `X`, never every reading inside the cook's time window. A paused cook's
untagged readings, and an overlapping cook on the same device, would otherwise
be conflated. The constraint is in the parameter's description in
`spec/paths/temperatures.yaml`.

### Decision: no mock server (HAR-72)

The Express mock server, its fixtures and simulator, and the request
validation adapters were removed. The mock served routes the API does not
(`/cooks/{id}/start` and others), so building a client against it built
against routes that do not exist; nothing imported the validation adapters.
Build clients against the deployed dev API or a local Functions host.

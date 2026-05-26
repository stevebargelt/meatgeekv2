# @meatgeekv2/api-specs

OpenAPI 3.0 specifications, mock API server, request/response validation primitives, and contract-testing scaffolding for the MeatGeek V2 API surface.

This library is the **source-of-truth contract** between the Azure Functions backend (`apps/api`), the web/mobile clients (`apps/web`, `apps/mobile`), and the Go device controller / data pusher (`apps/device-controller`, `apps/data-pusher`).

## Layout

```
libs/api-specs/
├── spec/                         OpenAPI 3.0 source-of-truth (Step #2)
│   ├── openapi.yaml              Entrypoint
│   ├── components/schemas/       Cook, Temperature, Device, Common, SignalR
│   └── paths/                    Cooks, Temperatures, Devices
├── src/
│   ├── index.ts                  Re-export hub
│   ├── generated/                Build-on-demand TS types (NOT checked in)
│   └── lib/
│       ├── mock-data/            Deterministic BBQ temperature simulator (Step #3)
│       ├── validation/           Framework-agnostic validator + adapters (Step #4)
│       ├── mock-server/          Express mock API server (Step #5)
│       └── swagger-ui/           Swagger UI mount helper (Step #5)
└── contract-tests/               Schemathesis + spec-validates scaffolding (Step #6)
```

## NX targets

| Target | What it does |
|---|---|
| `nx build api-specs` | `tsc` library compile + copy `spec/` assets into `dist/libs/api-specs/spec` |
| `nx lint api-specs` | ESLint over `src/**` (excludes `src/generated/**`) |
| `nx test api-specs` | Jest — unit + contract tests |
| `nx serve api-specs` | Boots the Express mock server on `PORT` (default `4010`); Swagger UI at `/docs` |
| `nx mock api-specs` | Alias of `serve` (matches the legacy contract-test team vocabulary) |
| `nx validate-spec api-specs` | Runs `swagger-parser validate` against `spec/openapi.yaml` |
| `nx generate-types api-specs` | Emits `src/generated/types.d.ts` from the spec via `openapi-typescript` |

> **Deliberate deviation:** `serve` uses `nx:run-commands` to invoke `ts-node` on `mock-server/start.ts` rather than the `@nx/js:tsc` library convention. This is intentional and satisfies the ticket #2 acceptance criterion "`nx serve api-specs` works"; this lib is both a library (consumed by other libs) and a dev-only mock server (consumed by humans via Swagger UI). Building first then running from `dist/` is also possible but requires `nx build api-specs && node dist/libs/api-specs/lib/mock-server/start.js`.

## Quick start

```bash
# Validate the spec
nx validate-spec api-specs

# Run the mock server + Swagger UI
nx serve api-specs
# → Swagger UI: http://localhost:4010/docs
# → JSON API:   http://localhost:4010/cooks, /temperatures/current/{deviceId}, ...

# Generate TS types from the spec (one-off, ad-hoc — output is gitignored)
nx generate-types api-specs

# Run all tests (includes contract-tests/spec-validates.spec.ts)
nx test api-specs
```

---

## Architectural decisions

The following decisions are recorded here so downstream tickets (#1 CosmosDB partitioning, #4 Go codegen, #6 trace propagation) and future contributors do not re-litigate them.

### Decision: dual sources vs re-export

**Decision:** `libs/api-interfaces` continues to maintain hand-written TypeScript types as the source-of-truth **for application code** (the 624 lines across `cook.ts`, `common.ts`, `temperature.ts`, `device.ts`, `user.ts`). `libs/api-specs` is the OpenAPI source-of-truth **for the wire contract**. We do **not** re-export from `api-specs/src/generated/` into `api-interfaces` at this time.

**Why dual sources for now:**
1. **Generated types are build-on-demand** (see next decision) — they're not checked in, so re-exporting from them would mean `api-interfaces` cannot be consumed without a prior `nx generate-types api-specs` step. That's a footgun for every downstream lib and app.
2. **Hand-written types carry richer ergonomic affordances** (JSDoc, branded types, discriminated unions written for TS DX) that `openapi-typescript` doesn't yet emit cleanly from a spec.
3. **The spec is *narrower* than the TS types** at this phase: the spec covers wire-level Phase 1 endpoints; the TS types cover internal domain shapes (e.g., `CookSummary`, `UserActivity`) that aren't on the wire yet.

**Reconciliation strategy:**
- The TS types in `api-interfaces` and the spec schemas in `api-specs/spec/components/schemas` are kept in sync **manually** — when one changes, update the other.
- `contract-tests/round-trip.spec.ts` smoke-tests that fixtures conform to the generated TS types, which catches the most obvious divergence cases at CI time.
- Schemathesis (see contract-testing decision) fuzz-tests the live mock server against the spec — divergence between the spec and the mock-server handler shape will surface there.
- A future ticket may flip this: when the spec is exhaustive and `openapi-typescript` output is ergonomic enough, `api-interfaces` will re-export generated types and the hand-written ones will be deleted. **Not in scope of #2.**

### Decision: contract testing tool

**Decision:** **Schemathesis via Docker** is the chosen contract-test scaffold. **Pact is deferred** until real consumer teams write pacts.

**Why Schemathesis:**
- **Property-based / fuzz testing** — generates 1000s of valid + invalid payloads from the spec automatically. No consumer pact files to maintain on day one.
- **Runs against the live mock server** — same artifact developers use locally for Swagger UI. No separate test harness.
- **Docker-packaged** (`schemathesis/schemathesis:stable`) — zero Python toolchain pollution in the Node monorepo.
- **CI-friendly** — single `bash` invocation; failures surface as exit codes.

**Why Pact is deferred:**
- Pact's value is **consumer-driven** contracts: the mobile team writes a pact, the backend team verifies against it. We don't have a dedicated mobile team writing pacts yet; until then Pact infrastructure is overhead without payoff.
- When Phase 3 mobile work begins (ticket #7+), revisit. The Schemathesis scaffold does not preclude adding Pact later.

See `contract-tests/README.md` for invocation details.

### Decision: SignalR coverage

**Decision:** SignalR message payload schemas are documented **inline** in the OpenAPI spec under `components/schemas/signalr-payloads.yaml`, even though SignalR is not an HTTP endpoint. Every payload has a **required `correlation.id` field** so traces can be stitched end-to-end (ticket #6 trace propagation).

**Why inline (not a separate AsyncAPI document):**
- Single source of truth — one file to validate, one CI gate, one Swagger UI to browse.
- The OpenAPI spec's `info.description` includes a prose note clarifying that these schemas describe message payloads, not endpoints; the transport is the SignalR `temperatureHub` channel (Phase 2).
- AsyncAPI is the *more correct* tool for event-driven messaging — but introducing a second spec format would force two toolchains (codegen, validation, docs). Light-touch coverage in OpenAPI is acceptable for Phase 2 contract surface.

Payload catalogue: `temperature_update`, `cook_started`, `cook_stopped`, `cook_paused`, `cook_resumed`, `device_online`, `device_offline`, `alert_triggered`, `system_notification`.

### Decision: generated types on-demand

**Decision:** TypeScript types generated from the OpenAPI spec via `openapi-typescript` are emitted to `libs/api-specs/src/generated/` and **never checked into source control**. Each consumer runs `nx generate-types api-specs` to refresh.

**Why on-demand:**
- Avoids the "two places to update" anti-pattern that has bitten this team before — generated artifacts checked in always drift.
- Build pipeline freshness: `nx generate-types api-specs` is wired up as a task that downstream apps' `build` can `dependsOn` if/when they consume generated types.
- `src/generated/**` is excluded from `tsconfig.lib.json` `include` and `.eslintrc.json` lint scope so generated drift doesn't break the lib build.
- Add `libs/api-specs/src/generated/` to `.gitignore` (handled when generated content first lands; sibling step responsibility).

### Decision: temperature query semantics (strict cookId tag-match)

**Decision:** The `GET /temperatures/history?cookId=X` endpoint returns **only readings whose `cookId` tag exactly matches `X`** — it does **not** return all readings within the cook's time window.

**Why strict tag-match:**
- A cook can be paused/resumed. Readings emitted while the cook is paused are not tagged with the `cookId` and must not appear in the cook's history.
- Multiple cooks may overlap in time on the same device (e.g., a quick test grill while a long brisket runs on a second probe). Time-window-based lookup would conflate them.
- This is more expensive to query (CosmosDB needs a composite index on `cookId`), but the cost is bounded by Phase 1's 5–10 device scale.

This semantic is baked into the OpenAPI parameter description in `spec/paths/temperatures.yaml` so downstream codegen-consumers see the constraint at the contract level.

### Decision: framework-agnostic validation primitive

**Decision:** The core validator (`src/lib/validation/validator.ts`) is **framework-agnostic** — it depends only on `ajv`, `ajv-formats`, and `@apidevtools/swagger-parser`, and accepts plain `(method, route, payload, query, params)` arguments. Two thin adapters wrap it:

- `express-adapter.ts` — middleware factory for the Express mock server.
- `functions-adapter.ts` — `withOpenApiValidation(handler)` HOC for `@azure/functions` v4 isolated model, so the **same** primitive can wrap `apps/api` handlers without dragging Express into the Functions runtime.

**Why split core from adapter:**
- The Functions runtime explicitly cannot host Express — Functions v4 has its own request/response types.
- A validator that only works under Express would lock the contract to a single transport. Splitting the core means the spec drives validation in *both* runtimes from one definition.
- The adapter pattern keeps each binding small and trivially testable.

### Decision: mock server as dev-only artifact

**Decision:** The Express mock server (`src/lib/mock-server/`) is a **development-only artifact**. It is not shipped to production, is not deployed to Azure, and is not used by the real `apps/api`.

**Use cases:**
- Frontend developers (web + mobile) need a working API to build against before the Azure Functions backend implements every endpoint.
- Contract testing (Schemathesis) needs an instance of the API conforming to the spec to fuzz against.
- Documentation: Swagger UI mounted at `/docs` gives any contributor a browseable, executable spec.

The mock server's handlers use deterministic in-memory fixtures (`src/lib/mock-data/fixtures.ts`) and the temperature simulator (`src/lib/mock-data/simulator.ts`); they intentionally do not call CosmosDB, Service Bus, or any external service.

---

## Dependency notes

This lib adds the following runtime + dev dependencies to the root `package.json`:

| Package | Purpose |
|---|---|
| `express`, `@types/express` | Mock API server |
| `swagger-ui-express`, `@types/swagger-ui-express` | Swagger UI middleware |
| `ajv`, `ajv-formats` | JSON Schema validation engine |
| `js-yaml`, `@types/js-yaml` | YAML parsing for the spec |
| `@apidevtools/swagger-parser` | Dereferencing + validation of OpenAPI 3.0 |
| `openapi-types` | TS types for the OpenAPI object model |
| `openapi-typescript` | Build-time TS generation from the spec |
| `seedrandom`, `@types/seedrandom` | Deterministic PRNG for the temperature simulator |
| `supertest`, `@types/supertest` | In-process integration tests against the mock server |

All deps are declared at the workspace root (matches monorepo convention).

## Related tickets

- **Ticket #2 (this lib):** scaffolds the contract surface.
- **Ticket #4 (device-controller-integration):** consumes the spec via Go codegen (`oapi-codegen`) for the data-pusher's V1→V2 translation layer.
- **Ticket #6 (otel-integration):** uses the `correlation.id` invariant in SignalR payloads (this lib) to stitch traces from device → backend → client.

## Notes

- `nx serve api-specs` uses `ts-node` on `start.ts` for a fast dev loop; for production-like packaging, run `nx build api-specs` then `node dist/libs/api-specs/lib/mock-server/start.js`.
- If you change the spec, run `nx validate-spec api-specs` before committing — it catches structural errors before they reach the mock server boot or the codegen step.

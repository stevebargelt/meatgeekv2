# Contract tests — `libs/api-specs`

Spec-only checks. They read `spec/openapi.yaml` and, for the iOS bundle
check, the bundle committed under `apps/ios`.

The check that the spec matches the API is not here: it is
`apps/api/src/contract/contract.spec.ts`, run by `npx nx test api` on every
pull request (see `../README.md`). `nx test api-specs` runs the Jest specs
below, in CI and locally.

| File | Kind | Run by |
|---|---|---|
| `spec-validates.spec.ts` | Jest: the spec validates and dereferences, operationIds are unique, cook events require `correlation.id`, no `NOT YET IMPLEMENTED` text | `nx test api-specs` (CI and local) |
| `round-trip.spec.ts` | Jest: `openapi-typescript` generates types from the spec, and sample `StartCookRequest`, `Cook` and `Device` values compile against them | `nx test api-specs` (CI and local) |
| `ios-bundle.spec.ts` | Jest: the committed iOS bundle (`apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml`) equals a fresh bundle of the spec; the bundle validates, has only `#/components/<kind>/<name>` refs and includes the SignalR message schemas; bundling twice gives the same text | `nx test api-specs` (CI and local) |
| `oapi-codegen-smoke.sh` | **Not a test.** A manual codegen tool: runs the `oapi-codegen` Docker image and writes Go for you to inspect. It asserts nothing | Manual only |

The Jest specs have no external prerequisites. The shell script needs Docker.

`oapi-codegen-smoke.sh` is excluded from every suite on purpose (HAR-118). It
pulls `deepmap/oapi-codegen:latest` over the network, so its result depends on
whatever that tag serves that day, and it checks nothing a pass or fail could
report. Do not wire it into CI or an Nx target.

---

## TS round-trip smoke

`round-trip.spec.ts` runs the `openapi-typescript` CLI against the spec,
emits TS types to a temp directory, then asserts that inline sample values
type-check against the generated `StartCookRequest`, `Cook` and `Device`. It
is compile-only: it passes if `tsc` accepts the assignments. When a schema a
client depends on changes shape, add or update a sample here.

## Go codegen smoke (manual tool, not a test)

`oapi-codegen-smoke.sh` invokes the `deepmap/oapi-codegen` Docker image
against the spec to verify that Go codegen produces typed output (named
structs and enums, not `map[string]interface{}`).

**Failure modes:**

- `map[string]interface{}` where a typed struct should be → the schema relies
  on a free-form `type: object`. Tighten it in `spec/components/schemas/*.yaml`.
- Generated enum is `string` instead of a Go const set → the spec uses an
  inline union of string literals instead of a named `enum` on a top-level
  schema. Lift the enum to a `components/schemas/` entry.
- Codegen produces nothing for an endpoint → the operation is missing an
  `operationId`. Add one.

```bash
bash libs/api-specs/contract-tests/oapi-codegen-smoke.sh
# Writes to a fresh mktemp file and prints its path ("output = ...");
# inspect it for any of the failure modes above.
OUTPUT=./api.go bash libs/api-specs/contract-tests/oapi-codegen-smoke.sh
# Writes to the path you name instead.
```

Without `OUTPUT`, every run gets its own temp file, so two copies running at
once never write the same file.

## Removed: Schemathesis

HAR-72 removed `run-schemathesis.sh` and `schemathesis.config.json`. They
fuzzed the Express mock server, which served routes the API does not, and the
mock server is gone. Fuzzing the real API would need a bearer token for every
request and is not set up.

# Contract tests — `libs/api-specs`

Spec-only checks. They read `spec/openapi.yaml` and nothing else.

The check that the spec matches the API is not here: it is
`apps/api/src/contract/contract.spec.ts`, run by `npx nx test api` on every
pull request (see `../README.md`). `nx test api-specs` is not in the CI
matrix; run it locally when you change the spec.

| File | Kind | Run by |
|---|---|---|
| `spec-validates.spec.ts` | Jest: the spec validates and dereferences, operationIds are unique, cook events require `correlation.id`, no `NOT YET IMPLEMENTED` text | `nx test api-specs` (local) |
| `round-trip.spec.ts` | Jest: `openapi-typescript` generates types from the spec, and sample `StartCookRequest`, `Cook` and `Device` values compile against them | `nx test api-specs` (local) |
| `oapi-codegen-smoke.sh` | Bash: runs the `oapi-codegen` Docker image to prove the spec generates Go cleanly | Manual |

The Jest specs have no external prerequisites. The shell script needs Docker.

---

## TS round-trip smoke

`round-trip.spec.ts` runs the `openapi-typescript` CLI against the spec,
emits TS types to a temp directory, then asserts that inline sample values
type-check against the generated `StartCookRequest`, `Cook` and `Device`. It
is compile-only: it passes if `tsc` accepts the assignments. When a schema a
client depends on changes shape, add or update a sample here.

## Go codegen smoke

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
# Output: /tmp/api.go — inspect for any of the failure modes above
```

## Removed: Schemathesis

HAR-72 removed `run-schemathesis.sh` and `schemathesis.config.json`. They
fuzzed the Express mock server, which served routes the API does not, and the
mock server is gone. Fuzzing the real API would need a bearer token for every
request and is not set up.

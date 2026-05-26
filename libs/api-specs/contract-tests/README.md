# Contract tests — `libs/api-specs`

This directory holds the contract-testing scaffold for the MeatGeek V2 API.
Two kinds of artifact live here:

| File | Kind | Run by |
|---|---|---|
| `spec-validates.spec.ts` | Jest — dereferences + validates `spec/openapi.yaml` | `nx test api-specs` (CI) |
| `round-trip.spec.ts` | Jest — TS round-trip smoke (spec → `openapi-typescript` → fixtures conform) | `nx test api-specs` (CI) |
| `run-schemathesis.sh` | Bash — invokes the Schemathesis Docker image against the live mock server | Manual / dedicated CI job |
| `oapi-codegen-smoke.sh` | Bash — invokes `oapi-codegen` Docker image to prove the spec generates Go cleanly | Manual / pre-flight for ticket #4 |
| `schemathesis.config.json` | Config — checks toggled on, hooks if any | Read by `run-schemathesis.sh` |

`nx test api-specs` runs **only** the two `*.spec.ts` files automatically; the
two shell scripts are documented + invokable but never auto-fired, because
they require Docker + a running mock server and have multi-second startup
costs unsuitable for unit-test CI passes.

---

## Decision: Schemathesis chosen

We chose **Schemathesis (via the official Docker image
`schemathesis/schemathesis:stable`)** as the contract-test scaffold.

**Why Schemathesis fits this phase:**

- **Property-based / fuzz testing.** Schemathesis generates thousands of
  request payloads (valid + boundary + adversarial) directly from the
  OpenAPI spec, with no per-endpoint hand-written test cases. The spec is
  the test.
- **Tests the live server, not a recorded contract.** It drives the mock
  API server (the one developers run via `nx serve api-specs`) — so it
  catches the case where the spec and the handler implementation drift.
  No separate harness, no recorded pacts to maintain.
- **Polyglot-safe via Docker.** Schemathesis is Python; the rest of the
  repo is Node + Go. Running it inside its published Docker image keeps
  the Python toolchain out of the monorepo's dependency tree.
- **Single CLI invocation.** `run-schemathesis.sh` is a few lines; exit
  code surfaces failures; no plumbing to manage.
- **Checks the right invariants for "contract":** response-shape conformance,
  status-code coverage, server crashes on adversarial payloads,
  not-a-string-where-string-expected, missing-required-field rejection.
  These are precisely the failures that bite when a client and server
  drift independently.

**Run it:**

```bash
# 1. In one terminal — boot the mock server on port 4010
nx serve api-specs

# 2. In another terminal — run the Schemathesis fuzzer
bash libs/api-specs/contract-tests/run-schemathesis.sh

# Tweak which checks to run by editing schemathesis.config.json or by passing
# additional flags to the script, e.g.
#   bash libs/api-specs/contract-tests/run-schemathesis.sh --workers=4
```

The script's defaults (`-c all`) run every Schemathesis built-in check:
`status_code_conformance`, `content_type_conformance`,
`response_schema_conformance`, `response_headers_conformance`,
`not_a_server_error`.

---

## Decision: Pact deferred

We are **not** standing up Pact infrastructure in ticket #2. The decision
will be revisited when a real consumer team starts writing pacts (most
likely during Phase 3 mobile work, ticket #7+).

**Why Pact is deferred:**

- **Pact's value is consumer-driven contracts.** The mobile team writes
  a pact describing what they expect; the backend verifies against it.
  Without a dedicated consumer team writing pacts, Pact infrastructure
  is overhead with no payoff — a broker to host, pact files to publish,
  CI gates to wire up, all defending against a class of drift no one is
  yet causing.
- **Schemathesis covers the same gap from the producer side.** While
  consumers don't exist, fuzzing the live mock against the spec catches
  the *exact* drift (spec ↔ server) that pacts would otherwise catch
  from the *opposite* direction.
- **Schemathesis does not preclude Pact.** When Phase 3 mobile begins,
  Pact can be layered on top — Schemathesis fuzzes the spec, Pact
  verifies named consumer expectations. They are complementary.

**When to revisit:**

- A dedicated mobile or web consumer team begins maintaining a separate
  release cadence from `apps/api`.
- A second backend (e.g., a third-party integration) needs a stable
  versioned contract.
- We observe drift bugs in production that the spec-validates +
  Schemathesis combination didn't catch.

---

## Decision: spec drift = CI failure

`spec-validates.spec.ts` runs as part of `nx test api-specs`, which is
wired into the project's standard CI test pass (`nx affected:test`).
If `spec/openapi.yaml` fails to dereference (broken `$ref`, malformed
YAML) or fails OpenAPI 3.0 schema validation (wrong property name,
invalid `type`), CI fails *immediately* — before any handler change,
docs build, or codegen step has a chance to surface the same error
later in the pipeline.

This is deliberately a tight feedback loop: spec breakage is one of the
two worst kinds of drift on this team (the other is handler / spec
drift, caught by Schemathesis).

---

## Decision: TS round-trip smoke

`round-trip.spec.ts` runs `openapi-typescript` in-process against the
spec, emits TS types to a tmp directory, then asserts that a sample
`StartCookRequest` payload pulled from `src/lib/mock-data/fixtures.ts`
type-checks against the generated type. This is a *compile-only* check —
the test passes if `tsc` accepts the assignment, fails if the spec and
the fixture diverge.

It is intentionally narrow:

- We do not assert every fixture against every type — only the most
  commonly drifted shapes (`StartCookRequest` is the body the mobile
  team will write against first; `Cook` and `Device` are the most
  common response shapes).
- We do not invoke the project-wide `tsc` — we invoke the TS compiler
  API on a synthesized file so the test stays self-contained.

When you add a new fixture or a new schema, add a matching assertion
here.

---

## Decision: Go codegen smoke (deferred for ticket #4)

`oapi-codegen-smoke.sh` invokes the `deepmap/oapi-codegen` Docker image
against the spec to verify that Go codegen produces clean, typed output
(named structs and enums, not `map[string]interface{}`). This is the
on-ramp for ticket #4 (device-controller integration), which will
consume the spec via `oapi-codegen` to produce the Go client for the
V1 → V2 translation layer.

The script is documented but not auto-run by `nx test api-specs`.
Ticket #4 will integrate it into the Go workspace's build pipeline.

**Failure modes:**

- `map[string]interface{}` where a typed struct should be → the schema
  for that type is missing `additionalProperties: false` or relies on a
  free-form `type: object`. Tighten the schema in
  `spec/components/schemas/*.yaml`.
- Generated enum is `string` instead of a Go const set → the spec uses
  an inline union of string literals instead of a named `enum` array
  on a top-level schema. Lift the enum to a `components/schemas/` entry.
- Codegen produces zero output for an endpoint → the path or operation
  is missing an `operationId`. Add one.

**Run it manually:**

```bash
bash libs/api-specs/contract-tests/oapi-codegen-smoke.sh
# Output: /tmp/api.go — inspect for any of the failure modes above
```

---

## Files

```
contract-tests/
├── README.md                       (this file)
├── run-schemathesis.sh             Docker invocation of the Schemathesis fuzzer
├── oapi-codegen-smoke.sh           Docker invocation of oapi-codegen
├── schemathesis.config.json        Schemathesis check configuration
├── spec-validates.spec.ts          Jest — spec dereferences + validates
└── round-trip.spec.ts              Jest — fixtures conform to generated TS types
```

## Prerequisites

| Tool | Used by | Install |
|---|---|---|
| Docker | `run-schemathesis.sh`, `oapi-codegen-smoke.sh` | https://docs.docker.com/get-docker/ |
| Node ≥ 20, npm ≥ 10 | All Jest specs | Workspace `engines` field |
| Mock server on `:4010` | `run-schemathesis.sh` only | `nx serve api-specs` |

The Jest specs (`spec-validates`, `round-trip`) have **no external
prerequisites** — they read the spec from disk and run entirely
in-process.

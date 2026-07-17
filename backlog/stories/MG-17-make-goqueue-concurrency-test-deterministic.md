---
id: MG-17
type: story
status: active
title: make goqueue concurrency test deterministic
created: 2026-07-17
---

#### Context
MG-16 verification exposed a pre-existing test-harness race in `apps/device-controller/goqueue/queue_test.go`. The queue implementation is mutex-protected, but the Thread Safety specs launch goroutines without waiting for completion and immediately sample `Len()`. Independent stress verification reproduced 35 failures in 100 uncached runs; observed lengths vary because goroutines are still in flight and some Pops can run against an empty queue. This makes the canonical `npm test` gate nondeterministic even after the workspace configuration is repaired.

#### Acceptance Criteria
- [ ] Concurrent Push and Pop test goroutines are synchronized with explicit primitives rather than timing or arbitrary sleeps
- [ ] The scenario guarantees the expected number of successful Pops while still exercising concurrent Push and Pop operations
- [ ] The Push-only concurrency spec also waits for all workers before asserting
- [ ] `go test -race -tags testserver ./goqueue/...` passes
- [ ] 100 uncached repetitions of the focused goqueue suite pass with zero failures
- [ ] The full canonical `npm test` gate passes repeatedly without relying on Nx cache
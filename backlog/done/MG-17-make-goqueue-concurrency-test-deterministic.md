---
id: MG-17
type: story
status: done
title: make goqueue concurrency test deterministic
created: 2026-07-17
closed: 2026-07-18
closed_commit: 01f2cd7
---

#### Context
MG-16 verification exposed a pre-existing test-harness race in `apps/device-controller/goqueue/queue_test.go`. The queue implementation is mutex-protected, but the Thread Safety specs launched goroutines without waiting for completion and immediately sampled `Len()`. Independent baseline stress reproduced 35 failures in 100 fresh-process uncached runs.

#### Acceptance Criteria
- [x] Concurrent Push and Pop test goroutines are synchronized with explicit primitives rather than timing or arbitrary sleeps
- [x] The scenario guarantees the expected number of successful Pops while still exercising concurrent Push and Pop operations
- [x] The Push-only concurrency spec also waits for all workers before asserting
- [x] `go test -race -tags testserver ./goqueue/...` passes
- [x] 100 fresh-process uncached repetitions of the focused goqueue suite pass with zero failures
- [x] The full canonical `npm test` gate passes without relying on Nx cache

#### Verification
The revised test prefills 300 elements, concurrently runs 300 Push and 300 Pop workers, waits for all 600 with `sync.WaitGroup`, and then asserts the deterministic final length of 300. No sleeps and no production queue changes. Forge test-engineer: 100/100 fresh-process race runs passed after a 65/100 baseline. Independent host check: 20/20 fresh-process race runs passed. Canonical `npm test`: 10/10 Nx test targets green.
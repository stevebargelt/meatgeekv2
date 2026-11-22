package fixture

import (
	"testing"
	"time"
)

// A clean Go test: it waits on the fake's own signal and drives an injected
// clock. Nothing here is a hit.
func TestClean(t *testing.T) {
	fake := clocktest.New(time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC))
	done := make(chan struct{})
	go func() { defer close(done); run(fake) }()
	fake.Advance(30 * time.Second)
	select {
	case <-done:
	case <-broker.Connected():
	}
	ctx := await.Context(t)
	_ = ctx
}

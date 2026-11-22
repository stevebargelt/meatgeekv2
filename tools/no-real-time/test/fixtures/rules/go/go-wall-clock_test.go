package fixture

import (
	"testing"
	"time"
)

func TestWallClock(t *testing.T) {
	start := time.Now() // expect: go-wall-clock
	if time.Since(start) > time.Second { // expect: go-wall-clock
		t.Fatal("too slow")
	}
	_ = time.Until(start) // expect: go-wall-clock
	fixed := time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC)
	_ = clk.Now() // an injected clock: not a hit
	_ = fixed
}

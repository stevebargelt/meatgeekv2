package fixture

import (
	"testing"
	"time"
)

func TestTimer(t *testing.T) {
	timer := time.NewTimer(time.Second) // expect: go-timer
	defer timer.Stop()
	ticker := time.NewTicker(time.Second) // expect: go-timer
	defer ticker.Stop()
	c := clk.NewTimer(time.Second) // an injected clock: not a hit
	_ = c
}

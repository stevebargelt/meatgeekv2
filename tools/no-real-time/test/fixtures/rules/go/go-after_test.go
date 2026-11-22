package fixture

import (
	"testing"
	"time"
)

func TestAfter(t *testing.T) {
	select {
	case <-done:
	case <-time.After(time.Second): // expect: go-after
		t.Fatal("nothing happened within a second")
	}
	time.AfterFunc(time.Second, func() {}) // expect: go-after
	clk.After(time.Second)                 // an injected clock: not a hit
}

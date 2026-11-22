package fixture

import (
	"testing"
	"time"
)

func TestTick(t *testing.T) {
	for range time.Tick(time.Millisecond) { // expect: go-tick
		break
	}
	fake.Tick(time.Second) // a clocktest.Fake: not a hit
}

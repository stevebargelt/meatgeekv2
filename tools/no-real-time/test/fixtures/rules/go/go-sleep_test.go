package fixture

import (
	"testing"
	"time"
)

// time.Sleep(time.Second) in a comment is not a hit.
func TestSleep(t *testing.T) {
	time.Sleep(10 * time.Millisecond) // expect: go-sleep
	/* time.Sleep(1) in a block comment is not a hit either */
	time.Sleep(d) // expect: go-sleep
}

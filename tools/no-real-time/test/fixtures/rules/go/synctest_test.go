package fixture

import (
	"net"
	"testing"
	"testing/synctest"
	"time"
)

// Inside a synctest bubble the clock is fake, so the file may sleep and read
// time. The allowance is per file; Eventually and a fixed port stay hits.
func TestSynctest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		time.Sleep(time.Minute)
		<-time.After(time.Second)
		if time.Since(start) != time.Minute+time.Second {
			t.Fatal("the bubble's clock moved wrong")
		}
		assert.Eventually(t, func() bool { return true }, time.Second, time.Millisecond) // expect: go-eventually
		ln, _ := net.Listen("tcp", "127.0.0.1:8081")                                    // expect: go-fixed-port
		_ = ln
	})
}

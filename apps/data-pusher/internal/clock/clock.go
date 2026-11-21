// Package clock is the data-pusher's injectable time source. Code that waits
// on time (reconnect backoff, token refresh, request timeouts) takes a Clock
// so a test can drive it with clocktest.Fake instead of real time; production
// passes Real().
package clock

import "time"

// Clock is the slice of package time the data-pusher waits on.
type Clock interface {
	Now() time.Time
	NewTimer(d time.Duration) Timer
}

// Timer is a one-shot timer, like *time.Timer.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
}

// Real returns the system clock.
func Real() Clock { return realClock{} }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) NewTimer(d time.Duration) Timer { return realTimer{time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time { return r.t.C }
func (r realTimer) Stop() bool          { return r.t.Stop() }

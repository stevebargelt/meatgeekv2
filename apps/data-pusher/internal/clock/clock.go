// Package clock is the data-pusher's injectable time source. Code that waits
// on time (reconnect backoff, token refresh, request timeouts) takes a Clock
// so a test can drive it with clocktest.Fake instead of real time; production
// passes Real().
package clock

import (
	"context"
	"sync"
	"time"
)

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

// WithTimeout is context.WithTimeout on c: the context is done when c's timer
// for d fires, and its Err is then context.DeadlineExceeded, as with
// context.WithTimeout. It reports no Deadline of its own, because c's time
// need not be the wall clock. cancel stops the timer before it returns, so a
// fake clock's Pending no longer lists it.
func WithTimeout(parent context.Context, c Clock, d time.Duration) (context.Context, context.CancelFunc) {
	inner, cancelInner := context.WithCancel(parent)
	ctx := &timeoutCtx{Context: inner}
	timer := c.NewTimer(d)
	go func() {
		select {
		case <-timer.C():
			ctx.mu.Lock()
			if inner.Err() == nil {
				ctx.timedOut = true
			}
			ctx.mu.Unlock()
			cancelInner()
		case <-inner.Done():
		}
	}()
	return ctx, func() {
		timer.Stop()
		cancelInner()
	}
}

type timeoutCtx struct {
	context.Context
	mu       sync.Mutex
	timedOut bool
}

func (c *timeoutCtx) Err() error {
	err := c.Context.Err()
	if err == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timedOut {
		return context.DeadlineExceeded
	}
	return err
}

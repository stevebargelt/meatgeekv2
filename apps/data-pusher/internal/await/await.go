// Package await is how data-pusher tests wait: on an event, never on a
// wall-clock deadline of their own. A test re-checks its condition each time
// one of the things it watches signals a change (a fake broker, a fake clock,
// a recording client), so a slow or busy machine only makes it slower, never
// red. The only bound is the test binary's own -timeout: shortly before
// t.Deadline() the wait fails the test, naming what it waited for and the last
// state it saw, instead of letting the runner panic with a goroutine dump.
package await

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"
)

// Source is anything that can say "something changed": Changed returns a
// channel that is closed at the next change after the call.
type Source interface {
	Changed() <-chan struct{}
}

// Signal is a broadcast Source. The zero value is ready to use; it is safe
// for concurrent use.
type Signal struct {
	mu sync.Mutex
	ch chan struct{}
}

// Changed returns a channel closed by the next Notify.
func (s *Signal) Changed() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch == nil {
		s.ch = make(chan struct{})
	}
	return s.ch
}

// Notify wakes everyone waiting on Changed. Call it after each change.
func (s *Signal) Notify() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch != nil {
		close(s.ch)
		s.ch = nil
	}
}

// Until blocks until cond is true. It evaluates cond now and again after each
// change any of srcs signals; srcs must signal every change cond depends on.
// If the test binary's deadline comes first it fails the test with what and
// state(), the last observed state.
func Until(t testing.TB, what string, cond func() bool, state func() any, srcs ...Source) {
	t.Helper()
	guard, stop := guardChan(t)
	defer stop()
	cases := make([]reflect.SelectCase, len(srcs)+1)
	cases[0] = reflect.SelectCase{Dir: reflect.SelectRecv, Chan: reflect.ValueOf(guard)}
	for {
		// Take the change channels before looking, so a change between the
		// look and the wait still wakes us.
		for i, s := range srcs {
			cases[i+1] = reflect.SelectCase{Dir: reflect.SelectRecv, Chan: reflect.ValueOf(s.Changed())}
		}
		if cond() {
			return
		}
		if chosen, _, _ := reflect.Select(cases); chosen == 0 {
			t.Fatalf("await: still waiting for %s at the test binary's deadline (go test -timeout); last state: %+v", what, state())
		}
	}
}

// Context returns a context that is done at the hang guard (shortly before
// the test binary's deadline) or when the test ends, for product calls that
// block until their context is done.
func Context(t testing.TB) context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if at, ok := Guard(t); ok {
		ctx, cancel = context.WithDeadline(ctx, at)
		t.Cleanup(cancel)
	}
	return ctx
}

// Guard is when waits give up: a little before t.Deadline(), so the failure
// names its condition before the runner's own timeout panics. ok is false
// when the binary has no deadline (go test -timeout 0).
func Guard(t testing.TB) (at time.Time, ok bool) {
	d, ok := t.(interface{ Deadline() (time.Time, bool) })
	if !ok {
		return time.Time{}, false
	}
	deadline, ok := d.Deadline()
	if !ok {
		return time.Time{}, false
	}
	margin := 10 * time.Second
	if left := time.Until(deadline); left < 2*margin {
		margin = left / 2
	}
	return deadline.Add(-margin), true
}

// guardChan is closed at Guard(t); it is nil (never ready) with no deadline.
func guardChan(t testing.TB) (<-chan struct{}, func()) {
	at, ok := Guard(t)
	if !ok {
		return nil, func() {}
	}
	ch := make(chan struct{})
	timer := time.AfterFunc(time.Until(at), func() { close(ch) })
	return ch, func() { timer.Stop() }
}

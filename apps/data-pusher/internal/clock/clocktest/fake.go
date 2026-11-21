// Package clocktest is a fake clock.Clock for tests: time stands still until
// the test calls Advance, so a timer fires only when the test says so and
// never because the machine was slow.
package clocktest

import (
	"sort"
	"sync"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
)

// Fake is a manual clock. It is an await.Source: it signals each time a timer
// is created, stopped or fired, so a test can wait for code to reach a timer
// before it advances past it. Safe for concurrent use.
type Fake struct {
	mu     sync.Mutex
	now    time.Time
	timers []*timer // pending, in creation order
	sig    await.Signal
}

var _ clock.Clock = (*Fake)(nil)

// New returns a fake clock reading start.
func New(start time.Time) *Fake { return &Fake{now: start} }

// Now is the fake time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// NewTimer returns a timer that fires once Advance reaches now+d; with d <= 0
// it has already fired.
func (f *Fake) NewTimer(d time.Duration) clock.Timer {
	f.mu.Lock()
	t := &timer{f: f, at: f.now.Add(d), d: d, c: make(chan time.Time, 1)}
	if d <= 0 {
		t.c <- f.now
	} else {
		f.timers = append(f.timers, t)
	}
	f.mu.Unlock()
	f.sig.Notify()
	return t
}

// Advance moves the clock forward by d and fires every timer now due, in
// deadline order.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	var due, rest []*timer
	for _, t := range f.timers {
		if !t.at.After(f.now) {
			due = append(due, t)
		} else {
			rest = append(rest, t)
		}
	}
	f.timers = rest
	sort.SliceStable(due, func(i, j int) bool { return due[i].at.Before(due[j].at) })
	for _, t := range due {
		t.c <- f.now // buffered 1, sent at most once
	}
	f.mu.Unlock()
	f.sig.Notify()
}

// Pending is the duration each pending timer was created with, in creation
// order.
func (f *Fake) Pending() []time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]time.Duration, len(f.timers))
	for i, t := range f.timers {
		out[i] = t.d
	}
	return out
}

// Changed implements await.Source.
func (f *Fake) Changed() <-chan struct{} { return f.sig.Changed() }

type timer struct {
	f  *Fake
	at time.Time
	d  time.Duration
	c  chan time.Time
}

func (t *timer) C() <-chan time.Time { return t.c }

func (t *timer) Stop() bool {
	f := t.f
	f.mu.Lock()
	stopped := false
	for i, p := range f.timers {
		if p == t {
			f.timers = append(f.timers[:i], f.timers[i+1:]...)
			stopped = true
			break
		}
	}
	f.mu.Unlock()
	if stopped {
		f.sig.Notify()
	}
	return stopped
}

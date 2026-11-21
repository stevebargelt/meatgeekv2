package clock_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
)

var start = time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

// doneSignal adapts a context's Done to an await.Source.
type doneSignal struct{ ctx context.Context }

func (d doneSignal) Changed() <-chan struct{} { return d.ctx.Done() }

func TestWithTimeout_DoneWhenTheClockReachesTheTimeout(t *testing.T) {
	clk := clocktest.New(start)
	ctx, cancel := clock.WithTimeout(context.Background(), clk, time.Second)
	defer cancel()

	if got := clk.Pending(); len(got) != 1 || got[0] != time.Second {
		t.Fatalf("pending = %v, want [1s]", got)
	}
	clk.Advance(999 * time.Millisecond)
	if err := ctx.Err(); err != nil {
		t.Fatalf("Err before the timeout = %v, want nil", err)
	}
	clk.Advance(time.Millisecond)
	await.Until(t, "the context to be done", func() bool { return ctx.Err() != nil },
		func() any { return ctx.Err() }, doneSignal{ctx})
	if err := ctx.Err(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Err = %v, want context.DeadlineExceeded", err)
	}
	if _, ok := ctx.Deadline(); ok {
		t.Error("Deadline reports a wall-clock deadline; the clock's time is not the wall clock")
	}
}

func TestWithTimeout_CancelStopsTheTimer(t *testing.T) {
	clk := clocktest.New(start)
	ctx, cancel := clock.WithTimeout(context.Background(), clk, time.Second)
	cancel()
	if got := clk.Pending(); len(got) != 0 {
		t.Errorf("pending after cancel = %v, want none", got)
	}
	if err := ctx.Err(); !errors.Is(err, context.Canceled) {
		t.Errorf("Err = %v, want context.Canceled", err)
	}
	clk.Advance(time.Hour)
	if err := ctx.Err(); !errors.Is(err, context.Canceled) {
		t.Errorf("Err after the timeout would have passed = %v, want context.Canceled", err)
	}
}

func TestWithTimeout_ParentCancelIsCanceledNotTimedOut(t *testing.T) {
	clk := clocktest.New(start)
	parent, cancelParent := context.WithCancel(context.Background())
	ctx, cancel := clock.WithTimeout(parent, clk, time.Second)
	defer cancel()
	cancelParent()
	await.Until(t, "the context to be done", func() bool { return ctx.Err() != nil },
		func() any { return ctx.Err() }, doneSignal{ctx})
	if err := ctx.Err(); !errors.Is(err, context.Canceled) {
		t.Errorf("Err = %v, want context.Canceled", err)
	}
}

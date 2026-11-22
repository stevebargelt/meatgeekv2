package fixture

import (
	"context"
	"testing"
	"time"
)

func TestContextTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second) // expect: go-context-timeout
	defer cancel()
	ctx, cancel = context.WithDeadline(ctx, // expect: go-context-timeout
		time.Now().Add(time.Minute)) // expect: go-wall-clock
	defer cancel()
	// A deadline that is not a literal duration is not this rule's business:
	at, _ := t.Deadline()
	ctx, cancel = context.WithDeadline(ctx, at)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, guard)
	defer cancel()
	_ = ctx
}

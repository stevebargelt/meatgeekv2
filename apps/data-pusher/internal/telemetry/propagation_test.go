package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// newTestTracer installs a real (AlwaysSample) tracer provider and the W3C
// TraceContext propagator so span contexts are valid/recording and the
// traceparent round-trip helpers exercise the same wire format production uses.
func newTestTracer(t *testing.T) oteltrace.Tracer {
	t.Helper()
	tp := trace.NewTracerProvider(trace.WithSampler(trace.AlwaysSample()))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return tp.Tracer("telemetry-test")
}

// TestExtractTraceparent_ValidSpan asserts a recording span yields a
// well-formed W3C traceparent whose trace id matches the span's own trace id.
func TestExtractTraceparent_ValidSpan(t *testing.T) {
	tracer := newTestTracer(t)

	ctx, span := tracer.Start(context.Background(), "reading")
	defer span.End()

	tp := ExtractTraceparent(ctx)
	if tp == "" {
		t.Fatal("ExtractTraceparent returned empty for a recording span")
	}
	// Form: 00-<32hex traceid>-<16hex spanid>-<2hex flags> = 55 chars.
	if len(tp) != 55 {
		t.Fatalf("traceparent %q has length %d, want 55", tp, len(tp))
	}
	wantTrace := span.SpanContext().TraceID().String()
	if got := tp[3:35]; got != wantTrace {
		t.Errorf("traceparent trace id = %q, want %q", got, wantTrace)
	}
}

// TestExtractTraceparent_NoSpan asserts a bare context (no span) yields "".
func TestExtractTraceparent_NoSpan(t *testing.T) {
	newTestTracer(t)
	if tp := ExtractTraceparent(context.Background()); tp != "" {
		t.Errorf("ExtractTraceparent on span-less context = %q, want empty", tp)
	}
}

// TestTraceparentRoundTrip simulates the durable-queue persist/recover cycle:
// a reading span's traceparent is extracted (persisted to disk in production),
// then re-hydrated into a fresh context; a child span started from that context
// must share the ORIGINAL reading's trace id — i.e. it continues the same
// per-reading trace across the (simulated) process boundary.
func TestTraceparentRoundTrip(t *testing.T) {
	tracer := newTestTracer(t)

	// --- enqueue side: open the per-reading root span, persist its traceparent.
	readingCtx, readingSpan := tracer.Start(context.Background(), "reading",
		oteltrace.WithNewRoot())
	readingTraceID := readingSpan.SpanContext().TraceID().String()
	persisted := ExtractTraceparent(readingCtx)
	readingSpan.End()
	if persisted == "" {
		t.Fatal("no traceparent to persist")
	}

	// --- simulate disk: the string is all that survives. Drop the in-memory
	// context entirely and recover from the bytes alone.
	recovered := persisted

	// --- dequeue side (fresh process): rebuild a parent context from the
	// stored string and start the consumer/publish span from it.
	parentCtx := ContextFromTraceparent(context.Background(), recovered)
	_, publishSpan := tracer.Start(parentCtx, "publisher.publish")
	defer publishSpan.End()

	if got := publishSpan.SpanContext().TraceID().String(); got != readingTraceID {
		t.Errorf("publish span trace id = %q, want %q (must continue the reading trace)", got, readingTraceID)
	}
	if !publishSpan.SpanContext().IsValid() {
		t.Error("recovered publish span context is not valid")
	}
}

// TestContextFromTraceparent_EmptyReturnsParent asserts an empty/malformed
// traceparent leaves the parent context untouched (publish then starts local,
// not from a detached remote root).
func TestContextFromTraceparent_EmptyReturnsParent(t *testing.T) {
	newTestTracer(t)

	base := context.Background()
	if got := ContextFromTraceparent(base, ""); got != base {
		t.Error("empty traceparent must return the parent context unchanged")
	}

	// Malformed input yields no valid remote span context.
	ctx := ContextFromTraceparent(base, "not-a-traceparent")
	if oteltrace.SpanContextFromContext(ctx).IsValid() {
		t.Error("malformed traceparent must not produce a valid remote span context")
	}
}

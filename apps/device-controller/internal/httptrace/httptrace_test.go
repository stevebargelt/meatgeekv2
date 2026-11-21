package httptrace

import (
	"context"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// setPropagator installs p as the global TextMapPropagator for the rest of
// the test and restores the previous one when the test ends, so no test
// leaves a global behind for the next one. The tests that call it must not
// be parallel: the global is process-wide.
func setPropagator(t *testing.T, p propagation.TextMapPropagator) {
	t.Helper()
	prev := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(prev) })
	otel.SetTextMapPropagator(p)
}

// TestStartSpanFromRequest_ContinuesInboundTrace verifies the server side of the
// device-controller <- data-pusher hop: given an inbound request carrying a
// `traceparent`, the handler must extract it and open a span in the SAME trace
// (matching trace-id, valid span context) rather than starting a detached root.
// No live network — the request is constructed in-test.
func TestStartSpanFromRequest_ContinuesInboundTrace(t *testing.T) {
	// Match production wiring (telemetry.Setup installs the W3C propagator).
	setPropagator(t, propagation.TraceContext{})

	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracer := tp.Tracer("httptrace-test")

	const wantTraceID = "0af7651916cd43dd8448eb211c80319c"
	const parentSpanID = "b7ad6b7169203331"

	req := httptest.NewRequest("GET", "/api/robots/MeatGeekBot/commands/get_status", nil)
	req.Header.Set("traceparent", "00-"+wantTraceID+"-"+parentSpanID+"-01")

	ctx, span := StartSpanFromRequest(tracer, req)
	defer span.End()

	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		t.Fatal("started span has an invalid span context")
	}
	if got := sc.TraceID().String(); got != wantTraceID {
		t.Fatalf("trace not continued: span trace-id = %s, want inbound %s", got, wantTraceID)
	}

	// The new span must be a distinct child, not a reuse of the parent span id.
	if got := sc.SpanID().String(); got == parentSpanID {
		t.Fatalf("expected a fresh child span id, got the parent id %s", got)
	}
}

// TestStartSpanFromRequest_NoTraceparentStartsRoot verifies that a request with
// no inbound trace context still yields a valid span (a new root), so the
// middleware is safe on un-instrumented callers.
func TestStartSpanFromRequest_NoTraceparentStartsRoot(t *testing.T) {
	setPropagator(t, propagation.TraceContext{})

	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracer := tp.Tracer("httptrace-test")

	req := httptest.NewRequest("GET", "/api/robots/MeatGeekBot/commands/get_status", nil)

	ctx, span := StartSpanFromRequest(tracer, req)
	defer span.End()

	if !trace.SpanContextFromContext(ctx).IsValid() {
		t.Fatal("expected a valid root span when no traceparent is present")
	}
}

package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace"
)

// withStubExporter swaps newSpanExporter for the duration of a test so we
// can assert the "real exporter" branch is taken without constructing an
// OTLP transport (and restores the original after).
func withStubExporter(t *testing.T, stub func(ctx context.Context) (trace.SpanExporter, error)) {
	t.Helper()
	orig := newSpanExporter
	newSpanExporter = stub
	t.Cleanup(func() { newSpanExporter = orig })
}

func TestSetupTracing_NoOTLPEndpoint_UsesNoOpExporter(t *testing.T) {
	// OTEL_EXPORTER_OTLP_ENDPOINT unset -> no-op path; newSpanExporter must not
	// be called and no network is dialed.
	t.Setenv(EnvOTLPEndpoint, "")

	called := false
	withStubExporter(t, func(context.Context) (trace.SpanExporter, error) {
		called = true
		return &noOpExporter{}, nil
	})

	shutdown, err := SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must be non-nil")
	}
	defer shutdown()

	if called {
		t.Error("newSpanExporter must NOT be called when OTEL_EXPORTER_OTLP_ENDPOINT is empty (no-op path expected)")
	}
}

func TestSetupTracing_WhitespaceOTLPEndpoint_UsesNoOpExporter(t *testing.T) {
	// A whitespace-only endpoint is treated as unset.
	t.Setenv(EnvOTLPEndpoint, "   ")

	called := false
	withStubExporter(t, func(context.Context) (trace.SpanExporter, error) {
		called = true
		return &noOpExporter{}, nil
	})

	shutdown, err := SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	defer shutdown()

	if called {
		t.Error("a whitespace-only OTEL_EXPORTER_OTLP_ENDPOINT must be treated as empty")
	}
}

func TestSetupTracing_OTLPEndpointSet_BuildsRealExporter(t *testing.T) {
	// With OTEL_EXPORTER_OTLP_ENDPOINT set, the real exporter branch is taken.
	t.Setenv(EnvOTLPEndpoint, "http://collector.local:4318")

	called := false
	withStubExporter(t, func(context.Context) (trace.SpanExporter, error) {
		called = true
		return &noOpExporter{}, nil
	})

	shutdown, err := SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must be non-nil")
	}
	defer shutdown()

	if !called {
		t.Fatal("newSpanExporter must be called when OTEL_EXPORTER_OTLP_ENDPOINT is set")
	}
}

// TestSetupTracing_RealExporterOffline exercises the DEFAULT newSpanExporter
// (the real OTLP-backed one) with OTEL_EXPORTER_OTLP_ENDPOINT set to an
// unreachable endpoint, asserting it constructs without error and yields a
// non-nil shutdown. otlptracehttp connects lazily so this makes no network
// round-trip.
func TestSetupTracing_RealExporterOffline(t *testing.T) {
	t.Setenv(EnvOTLPEndpoint, "http://collector.invalid:4318")

	shutdown, err := SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing with real exporter errored offline: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must be non-nil")
	}
	shutdown()
}

func TestSetupTracing_SetsW3CPropagatorGlobally(t *testing.T) {
	t.Setenv(EnvOTLPEndpoint, "")
	// Reset to a non-W3C propagator first so we prove SetupTracing sets it.
	otel.SetTextMapPropagator(propagation.Baggage{})

	shutdown, err := SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	defer shutdown()

	got := otel.GetTextMapPropagator()
	if _, ok := got.(propagation.TraceContext); !ok {
		t.Fatalf("global TextMapPropagator = %T, want propagation.TraceContext (W3C)", got)
	}
}

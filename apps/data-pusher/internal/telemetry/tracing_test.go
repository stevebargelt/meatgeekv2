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
func withStubExporter(t *testing.T, stub func(ctx context.Context, connStr string) (trace.SpanExporter, error)) {
	t.Helper()
	orig := newSpanExporter
	newSpanExporter = stub
	t.Cleanup(func() { newSpanExporter = orig })
}

func TestSetupTracing_EmptyConnStr_UsesNoOpExporter(t *testing.T) {
	called := false
	withStubExporter(t, func(context.Context, string) (trace.SpanExporter, error) {
		called = true
		return &noOpExporter{}, nil
	})

	shutdown, err := SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must be non-nil")
	}
	defer shutdown()

	if called {
		t.Error("newSpanExporter must NOT be called for an empty connection string (no-op path expected)")
	}
}

func TestSetupTracing_WhitespaceConnStr_UsesNoOpExporter(t *testing.T) {
	called := false
	withStubExporter(t, func(context.Context, string) (trace.SpanExporter, error) {
		called = true
		return &noOpExporter{}, nil
	})

	shutdown, err := SetupTracing(context.Background(), "   ")
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	defer shutdown()

	if called {
		t.Error("a whitespace-only connection string must be treated as empty")
	}
}

func TestSetupTracing_NonEmptyConnStr_BuildsRealExporter(t *testing.T) {
	called := false
	var gotConnStr string
	withStubExporter(t, func(_ context.Context, connStr string) (trace.SpanExporter, error) {
		called = true
		gotConnStr = connStr
		return &noOpExporter{}, nil
	})

	connStr := "InstrumentationKey=abc123;IngestionEndpoint=https://example.local/"
	shutdown, err := SetupTracing(context.Background(), connStr)
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must be non-nil")
	}
	defer shutdown()

	if !called {
		t.Fatal("newSpanExporter must be called for a non-empty connection string")
	}
	if gotConnStr != connStr {
		t.Errorf("newSpanExporter got conn string %q, want %q", gotConnStr, connStr)
	}
}

// TestSetupTracing_RealExporterOffline exercises the DEFAULT newSpanExporter
// (the real OTLP-backed one) with no live Azure endpoint, asserting it
// constructs without error and yields a non-nil shutdown. otlptracehttp
// connects lazily so this makes no network round-trip.
func TestSetupTracing_RealExporterOffline(t *testing.T) {
	connStr := "InstrumentationKey=abc123;IngestionEndpoint=https://ingest.invalid/"
	shutdown, err := SetupTracing(context.Background(), connStr)
	if err != nil {
		t.Fatalf("SetupTracing with real exporter errored offline: %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown func must be non-nil")
	}
	shutdown()
}

func TestSetupTracing_SetsW3CPropagatorGlobally(t *testing.T) {
	// Reset to a non-W3C propagator first so we prove SetupTracing sets it.
	otel.SetTextMapPropagator(propagation.Baggage{})

	shutdown, err := SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing returned error: %v", err)
	}
	defer shutdown()

	got := otel.GetTextMapPropagator()
	if _, ok := got.(propagation.TraceContext); !ok {
		t.Fatalf("global TextMapPropagator = %T, want propagation.TraceContext (W3C)", got)
	}
}

func TestIngestionEndpoint(t *testing.T) {
	cases := []struct {
		name    string
		connStr string
		want    string
	}{
		{
			name:    "standard app insights string",
			connStr: "InstrumentationKey=k;IngestionEndpoint=https://westus2.in.applicationinsights.azure.com/;LiveEndpoint=https://x/",
			want:    "https://westus2.in.applicationinsights.azure.com/",
		},
		{
			name:    "case-insensitive key",
			connStr: "ingestionendpoint=https://lower.local/",
			want:    "https://lower.local/",
		},
		{
			name:    "absent endpoint",
			connStr: "InstrumentationKey=k",
			want:    "",
		},
		{
			name:    "empty",
			connStr: "",
			want:    "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ingestionEndpoint(tc.connStr); got != tc.want {
				t.Errorf("ingestionEndpoint(%q) = %q, want %q", tc.connStr, got, tc.want)
			}
		})
	}
}

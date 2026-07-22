package telemetry

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
)

// shutdownCtx returns a short-lived context for exercising ShutdownFunc.
func shutdownCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestSetup_NoOTLPEndpoint_NoopNoPanic(t *testing.T) {
	// Offline / unconfigured: no OTEL_EXPORTER_OTLP_ENDPOINT must not panic and
	// must produce a working provider + shutdown.
	t.Setenv(EnvOTLPEndpoint, "")
	cfg := Config{DeviceID: "meatgeek3", Environment: "test"}

	shutdown, err := Setup(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Setup with no OTLP endpoint: unexpected error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("Setup returned a nil shutdown func")
	}

	// The exporter with no OTLP endpoint configured is the no-op exporter.
	exp, err := newSpanExporter(context.Background())
	if err != nil {
		t.Fatalf("newSpanExporter: unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); !ok {
		t.Fatalf("no OTLP endpoint: expected noopExporter, got %T", exp)
	}

	if err := shutdown(shutdownCtx(t)); err != nil {
		t.Fatalf("shutdown (no endpoint): unexpected error: %v", err)
	}
}

func TestSetup_WhitespaceOTLPEndpoint_Noop(t *testing.T) {
	t.Setenv(EnvOTLPEndpoint, "   ")
	exp, err := newSpanExporter(context.Background())
	if err != nil {
		t.Fatalf("newSpanExporter(whitespace endpoint): unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); !ok {
		t.Fatalf("whitespace OTLP endpoint: expected noopExporter, got %T", exp)
	}
}

func TestSetup_OTLPEndpointSet_ConstructsWithoutLiveBackend(t *testing.T) {
	// A configured OTLP endpoint must build the exporter + TracerProvider with
	// no error and no live backend, and shut down cleanly. The OTLP exporter
	// connects lazily, so construction succeeds offline.
	t.Setenv(EnvOTLPEndpoint, "http://collector.invalid:4318")
	cfg := Config{DeviceID: "meatgeek3", Environment: "prod"}

	tp, err := newTracerProvider(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newTracerProvider (configured): unexpected error: %v", err)
	}
	if tp == nil {
		t.Fatal("newTracerProvider returned nil provider")
	}

	// With the endpoint set, the real OTLP exporter is selected (not the no-op).
	exp, err := newSpanExporter(context.Background())
	if err != nil {
		t.Fatalf("newSpanExporter (endpoint set): unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); ok {
		t.Fatal("OTLP endpoint set: expected the real OTLP exporter, got noopExporter")
	}

	if err := tp.Shutdown(shutdownCtx(t)); err != nil {
		t.Fatalf("shutdown (configured): unexpected error: %v", err)
	}
}

func TestSetup_SamplerIsAlwaysSample(t *testing.T) {
	// Verify behaviorally: every span the provider mints is sampled.
	t.Setenv(EnvOTLPEndpoint, "")
	cfg := Config{DeviceID: "meatgeek3", Environment: "test"}
	tp, err := newTracerProvider(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newTracerProvider: unexpected error: %v", err)
	}
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	_, span := tp.Tracer("telemetry-test").Start(context.Background(), "probe")
	defer span.End()

	if !span.SpanContext().IsSampled() {
		t.Fatal("expected span to be sampled under AlwaysSample sampler")
	}
}

func TestNewResource_CarriesSixStandardDimensions(t *testing.T) {
	cfg := Config{DeviceID: "meatgeek3", Environment: "staging"}
	res := newResource(cfg)
	set := res.Set()

	// All six standard MeatGeek dimension keys must be present with the
	// device-level values. cook.id / correlation.id have no live value at the
	// device level so they default to "none"; processing.path is fixed to
	// "device". The key strings must match data-pusher exactly (join columns).
	cases := []struct {
		key  string
		want string
	}{
		{attrDeviceID, "meatgeek3"},
		{attrCookID, unsetDimension},         // "none"
		{attrCorrelationID, unsetDimension},  // "none"
		{attrProcessingPath, processingPath}, // "device"
		{attrComponent, componentName},       // "device"
		{attrEnvironment, "staging"},
	}
	for _, tc := range cases {
		v, ok := set.Value(attribute.Key(tc.key))
		if !ok {
			t.Errorf("resource missing attribute %q", tc.key)
			continue
		}
		if got := v.AsString(); got != tc.want {
			t.Errorf("resource attribute %q = %q, want %q", tc.key, got, tc.want)
		}
	}

	// component must be exactly "device".
	if v, _ := set.Value(attribute.Key(attrComponent)); v.AsString() != "device" {
		t.Errorf("component dimension = %q, want %q", v.AsString(), "device")
	}
}

func TestSetup_SetsW3CPropagatorGlobally(t *testing.T) {
	t.Setenv(EnvOTLPEndpoint, "")
	// Reset to a non-W3C propagator first so we prove Setup installs it.
	otel.SetTextMapPropagator(propagation.Baggage{})

	shutdown, err := Setup(context.Background(), Config{DeviceID: "meatgeek3"})
	if err != nil {
		t.Fatalf("Setup returned error: %v", err)
	}
	defer func() { _ = shutdown(shutdownCtx(t)) }()

	got := otel.GetTextMapPropagator()
	if _, ok := got.(propagation.TraceContext); !ok {
		t.Fatalf("global TextMapPropagator = %T, want propagation.TraceContext (W3C)", got)
	}
}

func TestConfigFromEnv_ReadsEnv(t *testing.T) {
	t.Setenv(EnvEnvironment, "production")

	cfg := ConfigFromEnv("meatgeek7")
	if cfg.DeviceID != "meatgeek7" {
		t.Errorf("DeviceID = %q, want %q", cfg.DeviceID, "meatgeek7")
	}
	if cfg.Environment != "production" {
		t.Errorf("Environment = %q, want %q", cfg.Environment, "production")
	}
}

func TestConfigFromEnv_UnsetEnvIsEmpty(t *testing.T) {
	t.Setenv(EnvEnvironment, "")
	t.Setenv(EnvOTLPEndpoint, "")

	cfg := ConfigFromEnv("meatgeek3")
	if cfg.Environment != "" {
		t.Errorf("expected empty Environment, got %q", cfg.Environment)
	}
	// With no OTLP endpoint the no-op exporter is selected (offline path).
	exp, err := newSpanExporter(context.Background())
	if err != nil {
		t.Fatalf("newSpanExporter: unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); !ok {
		t.Fatalf("expected noopExporter for unset OTLP endpoint, got %T", exp)
	}
}

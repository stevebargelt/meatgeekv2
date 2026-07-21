package telemetry

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
)

// fakeConnString is a non-empty placeholder that only exercises the
// "configured" code path. It is deliberately NOT a real Application Insights
// connection string — the exporter treats any non-empty value as "enabled".
const fakeConnString = "telemetry-enabled"

// shutdownCtx returns a short-lived context for exercising ShutdownFunc.
func shutdownCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestSetup_EmptyConnectionString_NoopNoPanic(t *testing.T) {
	// Offline / unconfigured: empty connection string must not panic and must
	// produce a working provider + shutdown.
	cfg := Config{DeviceID: "meatgeek3", ConnectionString: "", Environment: "test"}

	shutdown, err := Setup(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Setup with empty connection string: unexpected error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("Setup returned a nil shutdown func")
	}

	// The exporter behind an empty connection string is the no-op exporter.
	exp, err := newSpanExporter(context.Background(), "")
	if err != nil {
		t.Fatalf("newSpanExporter(\"\"): unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); !ok {
		t.Fatalf("empty connection string: expected noopExporter, got %T", exp)
	}

	if err := shutdown(shutdownCtx(t)); err != nil {
		t.Fatalf("shutdown (empty conn): unexpected error: %v", err)
	}
}

func TestSetup_WhitespaceConnectionString_Noop(t *testing.T) {
	exp, err := newSpanExporter(context.Background(), "   ")
	if err != nil {
		t.Fatalf("newSpanExporter(whitespace): unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); !ok {
		t.Fatalf("whitespace connection string: expected noopExporter, got %T", exp)
	}
}

func TestSetup_NonEmptyConnectionString_ConstructsWithoutLiveAzure(t *testing.T) {
	// A configured connection string must build the exporter + TracerProvider
	// with no error and no live backend, and shut down cleanly. The OTLP
	// exporter connects lazily, so construction succeeds offline.
	cfg := Config{DeviceID: "meatgeek3", ConnectionString: fakeConnString, Environment: "prod"}

	tp, err := newTracerProvider(context.Background(), cfg)
	if err != nil {
		t.Fatalf("newTracerProvider (configured): unexpected error: %v", err)
	}
	if tp == nil {
		t.Fatal("newTracerProvider returned nil provider")
	}

	if err := tp.Shutdown(shutdownCtx(t)); err != nil {
		t.Fatalf("shutdown (configured): unexpected error: %v", err)
	}
}

func TestSetup_SamplerIsAlwaysSample(t *testing.T) {
	// Verify behaviorally: every span the provider mints is sampled.
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

func TestNewResource_CarriesCustomDimensions(t *testing.T) {
	cfg := Config{DeviceID: "meatgeek3", Environment: "staging"}
	res := newResource(cfg)
	set := res.Set()

	cases := []struct {
		key  string
		want string
	}{
		{attrDeviceID, "meatgeek3"},
		{attrComponent, componentName}, // "device"
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

func TestConfigFromEnv_ReadsEnv(t *testing.T) {
	t.Setenv(EnvConnectionString, "from-env-conn")
	t.Setenv(EnvEnvironment, "production")

	cfg := ConfigFromEnv("meatgeek7")
	if cfg.DeviceID != "meatgeek7" {
		t.Errorf("DeviceID = %q, want %q", cfg.DeviceID, "meatgeek7")
	}
	if cfg.ConnectionString != "from-env-conn" {
		t.Errorf("ConnectionString = %q, want %q", cfg.ConnectionString, "from-env-conn")
	}
	if cfg.Environment != "production" {
		t.Errorf("Environment = %q, want %q", cfg.Environment, "production")
	}
}

func TestConfigFromEnv_UnsetEnvIsEmpty(t *testing.T) {
	t.Setenv(EnvConnectionString, "")
	t.Setenv(EnvEnvironment, "")

	cfg := ConfigFromEnv("meatgeek3")
	if cfg.ConnectionString != "" {
		t.Errorf("expected empty ConnectionString, got %q", cfg.ConnectionString)
	}
	// Empty connection string must select the no-op exporter (offline path).
	exp, err := newSpanExporter(context.Background(), cfg.ConnectionString)
	if err != nil {
		t.Fatalf("newSpanExporter: unexpected error: %v", err)
	}
	if _, ok := exp.(noopExporter); !ok {
		t.Fatalf("expected noopExporter for unset env, got %T", exp)
	}
}

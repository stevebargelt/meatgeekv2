package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

func TestDimensions_EmitsExactlySixStandardKeys(t *testing.T) {
	attrs := Dimensions{
		DeviceID:       "meatgeek3",
		CookID:         "cook-42",
		CorrelationID:  "corr-abc",
		ProcessingPath: "queue-publish",
		Component:      "data-pusher",
		Environment:    "test",
	}.Attributes()

	if len(attrs) != 6 {
		t.Fatalf("Attributes() returned %d keys, want exactly 6", len(attrs))
	}

	got := map[attribute.Key]bool{}
	for _, a := range attrs {
		if got[a.Key] {
			t.Errorf("duplicate dimension key %q", a.Key)
		}
		got[a.Key] = true
	}

	for _, want := range StandardDimensionKeys {
		if !got[want] {
			t.Errorf("missing standard dimension key %q", want)
		}
	}
	if len(got) != len(StandardDimensionKeys) {
		t.Errorf("emitted key set has %d unique keys, want %d", len(got), len(StandardDimensionKeys))
	}
}

func TestDimensions_ValuesRoundTrip(t *testing.T) {
	attrs := Dimensions{
		DeviceID:       "dev1",
		CookID:         "cook1",
		CorrelationID:  "corr1",
		ProcessingPath: "path1",
		Component:      "comp1",
		Environment:    "env1",
	}.Attributes()

	want := map[attribute.Key]string{
		DimDeviceID:       "dev1",
		DimCookID:         "cook1",
		DimCorrelationID:  "corr1",
		DimProcessingPath: "path1",
		DimComponent:      "comp1",
		DimEnvironment:    "env1",
	}
	for _, a := range attrs {
		if a.Value.AsString() != want[a.Key] {
			t.Errorf("key %q = %q, want %q", a.Key, a.Value.AsString(), want[a.Key])
		}
	}
}

func TestDimensions_DefaultsComponentAndEnvironment(t *testing.T) {
	t.Setenv("ENVIRONMENT", "")
	attrs := Dimensions{DeviceID: "d"}.Attributes()

	vals := map[attribute.Key]string{}
	for _, a := range attrs {
		vals[a.Key] = a.Value.AsString()
	}
	if vals[DimComponent] != componentName {
		t.Errorf("default component = %q, want %q", vals[DimComponent], componentName)
	}
	if vals[DimEnvironment] != "development" {
		t.Errorf("default environment = %q, want %q", vals[DimEnvironment], "development")
	}
}

func TestDimensions_EnvironmentFromEnv(t *testing.T) {
	t.Setenv("ENVIRONMENT", "production")
	attrs := Dimensions{DeviceID: "d"}.Attributes()
	for _, a := range attrs {
		if a.Key == DimEnvironment && a.Value.AsString() != "production" {
			t.Errorf("environment = %q, want %q", a.Value.AsString(), "production")
		}
	}
}

// TestInjectTraceContext_EmitsTraceparent proves the propagation helper
// writes a W3C traceparent into a property map when the context carries a
// recording span, which is the mechanism the publisher relies on.
func TestInjectTraceContext_EmitsTraceparent(t *testing.T) {
	shutdown, err := SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()

	tr := otel.Tracer("test")
	ctx, span := tr.Start(context.Background(), "test.span")
	defer span.End()

	props := map[string]string{"messageId": "m1"}
	InjectTraceContext(ctx, props)

	if props[TraceParentKey] == "" {
		t.Fatalf("expected a %q property to be injected, got none (props=%v)", TraceParentKey, props)
	}
	if props["messageId"] != "m1" {
		t.Errorf("InjectTraceContext must preserve existing props; messageId=%q", props["messageId"])
	}
}

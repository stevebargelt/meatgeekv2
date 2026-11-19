package publish

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"

	"go.opentelemetry.io/otel"
)

func f64(v float64) *float64 { return &v }

// TestProperties_OneRecord pins the full property set for one record with an
// active span and a correlation id: messageId, the JSON content type and
// encoding system properties (MG-68), traceparent and correlation.id.
func TestProperties_OneRecord(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()

	ctx, span := otel.Tracer("test").Start(context.Background(), "publisher.publish")
	defer span.End()

	props := Properties(ctx, "msg-1", "corr-1")

	want := map[string]string{
		"messageId":      "msg-1",
		"$.ct":           "application/json",
		"$.ce":           "utf-8",
		"correlation.id": "corr-1",
	}
	for k, v := range want {
		if props[k] != v {
			t.Errorf("props[%q] = %q, want %q", k, props[k], v)
		}
	}
	tp := props["traceparent"]
	if tp == "" {
		t.Fatal("traceparent must be injected when a span is active")
	}
	if got := tp[3:35]; got != span.SpanContext().TraceID().String() {
		t.Errorf("traceparent trace id = %q, want the active span's %q", got, span.SpanContext().TraceID().String())
	}
	// The constants in iothub are the names the builder uses.
	for _, k := range []string{iothub.MessageIDPropertyName, iothub.ContentTypePropertyName, iothub.ContentEncodingPropertyName, iothub.CorrelationIDPropertyName, iothub.TraceParentPropertyName} {
		if _, ok := props[k]; !ok {
			t.Errorf("property %q missing", k)
		}
	}
}

func TestProperties_NoCorrelationOmitsKey(t *testing.T) {
	props := Properties(context.Background(), "msg-1", "")
	if _, ok := props[iothub.CorrelationIDPropertyName]; ok {
		t.Error("correlation.id must be omitted when no correlation is set")
	}
	if props[iothub.ContentTypePropertyName] != iothub.ContentTypeJSON || props[iothub.ContentEncodingPropertyName] != iothub.ContentEncodingUTF8 {
		t.Errorf("content type/encoding must be set on every message; got %v", props)
	}
}

func TestProperties_NoSpanNoTraceparent(t *testing.T) {
	props := Properties(context.Background(), "msg-1", "")
	if _, ok := props[iothub.TraceParentPropertyName]; ok {
		t.Errorf("traceparent must be absent without an active span; got %q", props[iothub.TraceParentPropertyName])
	}
}

func TestReadingPayload_MapsAndMarshals(t *testing.T) {
	ts := time.Date(2026, 11, 19, 10, 30, 15, 123_000_000, time.UTC)
	cook := "cook-1"
	status := wire.V1Status{SmokerID: "meatgeek3", Temps: wire.V1Temps{GrillTemp: f64(225), Probe1Temp: f64(160)}}

	b, err := ReadingPayload(status, ts, &cook)
	if err != nil {
		t.Fatalf("ReadingPayload: %v", err)
	}
	want, _ := json.Marshal(wire.MapV1ToTemperatureReading(status, ts, &cook))
	if string(b) != string(want) {
		t.Errorf("payload = %s, want %s", b, want)
	}
	var got wire.TemperatureReading
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("payload is not a TemperatureReading: %v", err)
	}
	if got.DeviceID != "meatgeek3" || !got.Timestamp.Equal(ts) || got.GrillTemp == nil || *got.GrillTemp != 225 {
		t.Errorf("unexpected reading: %+v", got)
	}
}

func TestMessageID_IsWireMint(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)
	if got, want := MessageID("d", ts, 7), wire.MintMessageId("d", ts, 7); got != want {
		t.Errorf("MessageID = %q, want %q", got, want)
	}
}

package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"

	"go.opentelemetry.io/otel"
)

// mustReading marshals a minimal TemperatureReading-shaped payload with an
// optional cookId so the publisher's cook.id dimension extraction has
// something to read.
func mustReading(t *testing.T, cookID string) json.RawMessage {
	t.Helper()
	m := map[string]any{"deviceId": "meatgeek3", "grillTemp": 225}
	if cookID != "" {
		m["cookId"] = cookID
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal reading: %v", err)
	}
	return b
}

// TestRunPublisher_InjectsTraceparentAsMessageProperty drives the real
// publisher loop against a disk-backed queue + MockClient (no live Azure),
// and asserts the published message properties carry the injected W3C
// traceparent alongside the retained correlation.id and messageId.
func TestRunPublisher_InjectsTraceparentAsMessageProperty(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()
	tracer := otel.Tracer("meatgeek-pusher-test")

	q, err := queue.Open(t.TempDir(), queue.Options{})
	if err != nil {
		t.Fatalf("queue.Open: %v", err)
	}
	defer q.Close()

	rec := queueRecord{
		Timestamp:   time.Unix(1_700_000_000, 0).UTC(),
		Seq:         q.NextSeq(),
		Correlation: "corr-xyz",
		Payload:     mustReading(t, "cook-99"),
	}
	recBytes, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	if err := q.Enqueue(recBytes); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	client := iothub.NewMockClient()

	// Run the publisher until it drains the single record, then cancel.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runPublisher(ctx, q, client, "meatgeek3", tracer)
		close(done)
	}()

	// Wait for the record to be published (Ack'd -> queue empty + 1 call).
	deadline := time.After(5 * time.Second)
	for {
		if len(client.Calls()) >= 1 {
			break
		}
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("publisher did not publish the record within 5s")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	<-done

	calls := client.Calls()
	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 publish call, got %d", len(calls))
	}
	props := calls[0].Properties

	if props[telemetry.TraceParentKey] == "" {
		t.Errorf("expected injected %q message property, got none (props=%v)", telemetry.TraceParentKey, props)
	}
	if props[iothub.TraceParentPropertyName] == "" {
		t.Errorf("traceparent must be present under the iothub property name too")
	}
	if props[iothub.CorrelationIDPropertyName] != "corr-xyz" {
		t.Errorf("correlation.id must be retained; got %q", props[iothub.CorrelationIDPropertyName])
	}
	if props[iothub.MessageIDPropertyName] == "" {
		t.Errorf("messageId must still be stamped; got empty")
	}
}

func TestBuildPublishProperties_TraceparentAndCorrelation(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()

	tracer := otel.Tracer("test")
	ctx, span := tracer.Start(context.Background(), "publisher.publish")
	defer span.End()

	rec := queueRecord{Correlation: "corr-1", Payload: mustReading(t, "cook-1")}
	props := buildPublishProperties(ctx, "dev1", "msg-1", rec)

	if props[iothub.MessageIDPropertyName] != "msg-1" {
		t.Errorf("messageId = %q, want msg-1", props[iothub.MessageIDPropertyName])
	}
	if props[iothub.CorrelationIDPropertyName] != "corr-1" {
		t.Errorf("correlation.id = %q, want corr-1", props[iothub.CorrelationIDPropertyName])
	}
	if props[telemetry.TraceParentKey] == "" {
		t.Errorf("traceparent must be injected")
	}
}

func TestBuildPublishProperties_NoCorrelationOmitsKey(t *testing.T) {
	shutdown, _ := telemetry.SetupTracing(context.Background(), "")
	defer shutdown()

	tracer := otel.Tracer("test")
	ctx, span := tracer.Start(context.Background(), "publisher.publish")
	defer span.End()

	rec := queueRecord{Payload: mustReading(t, "")}
	props := buildPublishProperties(ctx, "dev1", "msg-1", rec)

	if _, ok := props[iothub.CorrelationIDPropertyName]; ok {
		t.Errorf("correlation.id key must be omitted when the record has no correlation")
	}
}

func TestCookIDFromPayload(t *testing.T) {
	if got := cookIDFromPayload(mustReading(t, "cook-7")); got != "cook-7" {
		t.Errorf("cookIDFromPayload = %q, want cook-7", got)
	}
	if got := cookIDFromPayload(mustReading(t, "")); got != "" {
		t.Errorf("cookIDFromPayload with absent cookId = %q, want empty", got)
	}
	if got := cookIDFromPayload(json.RawMessage("not-json")); got != "" {
		t.Errorf("cookIDFromPayload with bad json = %q, want empty", got)
	}
}

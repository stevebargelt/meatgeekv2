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
	oteltrace "go.opentelemetry.io/otel/trace"
)

// traceIDOf extracts the 32-hex trace-id field from a W3C traceparent string
// (form "00-<traceid>-<spanid>-<flags>"). Returns "" for malformed input.
func traceIDOf(traceparent string) string {
	if len(traceparent) < 35 {
		return ""
	}
	return traceparent[3:35]
}

// startReadingTrace mimics the enqueuer: it opens a per-reading ROOT span and
// returns both the span's trace id and the traceparent string that would be
// persisted into the queue record.
func startReadingTrace(t *testing.T, tracer oteltrace.Tracer) (traceID, traceparent string) {
	t.Helper()
	ctx, span := tracer.Start(context.Background(), "reading.enqueue", oteltrace.WithNewRoot())
	defer span.End()
	return span.SpanContext().TraceID().String(), telemetry.ExtractTraceparent(ctx)
}

// drainOnePublish enqueues rec, runs the real publisher loop until it publishes
// exactly one record against a MockClient, and returns that message's IoT Hub
// properties. No live network.
func drainOnePublish(t *testing.T, tracer oteltrace.Tracer, rec queueRecord, deviceID string) map[string]string {
	t.Helper()
	q, err := queue.Open(t.TempDir(), queue.Options{})
	if err != nil {
		t.Fatalf("queue.Open: %v", err)
	}
	defer q.Close()

	rec.Seq = q.NextSeq()
	recBytes, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	if err := q.Enqueue(recBytes); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	client := iothub.NewMockClient()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runPublisher(ctx, q, client, deviceID, tracer)
		close(done)
	}()

	deadline := time.After(5 * time.Second)
	for len(client.Calls()) < 1 {
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
	return calls[0].Properties
}

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

// TestPerReadingTrace_DistinctAndCarriedOnMessage is the F3 acceptance test:
// (1) two different readings produce DISTINCT trace ids — NOT one shared
// process trace — and (2) the IoT Hub message property published for each
// reading carries THAT reading's own per-reading traceparent (same trace id
// as the reading span, not the process span).
func TestPerReadingTrace_DistinctAndCarriedOnMessage(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()
	tracer := otel.Tracer("meatgeek-pusher-test")

	traceID1, tp1 := startReadingTrace(t, tracer)
	traceID2, tp2 := startReadingTrace(t, tracer)

	if traceID1 == "" || traceID2 == "" {
		t.Fatalf("reading traces must be valid; got %q and %q", traceID1, traceID2)
	}
	if traceID1 == traceID2 {
		t.Fatalf("two distinct readings must have DISTINCT trace ids, both were %q", traceID1)
	}

	rec1 := queueRecord{
		Timestamp:   time.Unix(1_700_000_000, 0).UTC(),
		Correlation: "corr-1",
		Traceparent: tp1,
		Payload:     mustReading(t, "cook-1"),
	}
	rec2 := queueRecord{
		Timestamp:   time.Unix(1_700_000_005, 0).UTC(),
		Correlation: "corr-2",
		Traceparent: tp2,
		Payload:     mustReading(t, "cook-2"),
	}

	props1 := drainOnePublish(t, tracer, rec1, "meatgeek3")
	props2 := drainOnePublish(t, tracer, rec2, "meatgeek3")

	got1 := props1[iothub.TraceParentPropertyName]
	got2 := props2[iothub.TraceParentPropertyName]
	if got1 == "" || got2 == "" {
		t.Fatalf("both messages must carry a traceparent; got %q and %q", got1, got2)
	}

	// Each message's traceparent must belong to ITS reading's trace.
	if traceIDOf(got1) != traceID1 {
		t.Errorf("message 1 traceparent trace id = %q, want reading 1 trace %q", traceIDOf(got1), traceID1)
	}
	if traceIDOf(got2) != traceID2 {
		t.Errorf("message 2 traceparent trace id = %q, want reading 2 trace %q", traceIDOf(got2), traceID2)
	}
	// And the two messages must NOT share a trace (the old giant-trace bug).
	if traceIDOf(got1) == traceIDOf(got2) {
		t.Errorf("two readings' messages must not share a trace id; both were %q", traceIDOf(got1))
	}
}

// TestQueueRecord_TraceparentPersistsAndContinues covers requirement (2): the
// per-reading traceparent round-trips through the record's serialize/deserialize
// (simulating a disk persist + recover across a process restart) and the
// dequeued consumer/publish span CONTINUES that same reading trace.
func TestQueueRecord_TraceparentPersistsAndContinues(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background(), "")
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()
	tracer := otel.Tracer("meatgeek-pusher-test")

	// --- enqueue side: open the per-reading root span, persist its traceparent.
	ctx, span := tracer.Start(context.Background(), "reading.enqueue", oteltrace.WithNewRoot())
	readingTraceID := span.SpanContext().TraceID().String()
	rec := queueRecord{
		Timestamp:   time.Unix(1_700_000_000, 0).UTC(),
		Seq:         1,
		Correlation: "corr-1",
		Traceparent: telemetry.ExtractTraceparent(ctx),
		Payload:     mustReading(t, "cook-1"),
	}
	span.End()
	if rec.Traceparent == "" {
		t.Fatal("reading traceparent was not captured for persistence")
	}

	// --- simulate disk: marshal to bytes, drop the record, recover from bytes.
	onDisk, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	var recovered queueRecord
	if err := json.Unmarshal(onDisk, &recovered); err != nil {
		t.Fatalf("unmarshal record: %v", err)
	}
	if recovered.Traceparent != rec.Traceparent {
		t.Fatalf("traceparent did not survive persist/recover: got %q want %q", recovered.Traceparent, rec.Traceparent)
	}

	// --- dequeue side (fresh process): the publish span continues the trace.
	parentCtx := telemetry.ContextFromTraceparent(context.Background(), recovered.Traceparent)
	_, publishSpan := tracer.Start(parentCtx, "publisher.publish")
	defer publishSpan.End()
	if got := publishSpan.SpanContext().TraceID().String(); got != readingTraceID {
		t.Errorf("dequeued publish span trace id = %q, want reading trace %q", got, readingTraceID)
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

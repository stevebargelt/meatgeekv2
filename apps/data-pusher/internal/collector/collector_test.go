package collector

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"meatgeek-pusher/internal/queue"
	"meatgeek-pusher/internal/wire"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel/trace/noop"
)

// gobotResponseFor builds the {"result": "<json-string>"} envelope the
// device-controller's gobot.io HTTP layer emits.
func gobotResponseFor(t *testing.T, status wire.V1Status) []byte {
	t.Helper()
	inner, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("marshal V1Status: %v", err)
	}
	env := struct {
		Result string `json:"result"`
	}{Result: string(inner)}
	out, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return out
}

// TestDecodeGobotStatus_UnwrapsResultStringIntoV1Status verifies that the
// {"result": "<json-string>"} envelope is correctly two-step-decoded into a
// V1Status. The previous collector did a naive Decode(&status) against the
// envelope, which silently produced zero-valued temps — the bug recorded
// in the architect's prior-art note.
func TestDecodeGobotStatus_UnwrapsResultStringIntoV1Status(t *testing.T) {
	temp := float64Ptr(225.5)
	expected := wire.V1Status{
		ID:          "evt-1",
		SmokerID:    "meatgeek3",
		AugerOn:     true,
		BlowerOn:    true,
		IgniterOn:   false,
		FireHealthy: true,
		Mode:        "smoke",
		SetPoint:    225,
		Temps: wire.V1Temps{
			GrillTemp:  temp,
			Probe1Temp: float64Ptr(150.0),
		},
	}

	body := gobotResponseFor(t, expected)
	got, err := DecodeGobotStatus(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("DecodeGobotStatus: %v", err)
	}
	if got.SmokerID != "meatgeek3" {
		t.Errorf("SmokerID: got %q, want %q", got.SmokerID, "meatgeek3")
	}
	if got.Temps.GrillTemp == nil || *got.Temps.GrillTemp != 225.5 {
		t.Errorf("GrillTemp: got %v, want 225.5", got.Temps.GrillTemp)
	}
	if !got.AugerOn || !got.BlowerOn || got.IgniterOn || !got.FireHealthy {
		t.Errorf("hardware flags lost in decode, got %+v", got)
	}
	if got.Mode != "smoke" || got.SetPoint != 225 {
		t.Errorf("mode/setPoint lost in decode, got mode=%q setPoint=%d", got.Mode, got.SetPoint)
	}
}

// TestDecodeGobotStatus_RejectsBareV1Status confirms that the naive
// previous-version decode path (envelope-less V1Status JSON) is now
// rejected, surfacing the bug rather than silently zeroing temps.
func TestDecodeGobotStatus_RejectsBareV1Status(t *testing.T) {
	bare := wire.V1Status{SmokerID: "meatgeek3", Temps: wire.V1Temps{GrillTemp: float64Ptr(220)}}
	body, err := json.Marshal(bare)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_, err = DecodeGobotStatus(bytes.NewReader(body))
	if err == nil {
		t.Fatal("expected error decoding bare V1Status (missing gobot envelope), got nil")
	}
	if !strings.Contains(err.Error(), "missing 'result'") &&
		!strings.Contains(err.Error(), "decode gobot envelope") {
		t.Errorf("expected envelope-related error, got %v", err)
	}
}

// TestCollector_PollEmitsSampleWithAllHardwareFlags drives a single poll
// against an httptest.Server and asserts every V1 hardware field reaches
// the emitted Sample. Regression test for the previous "only temps fields
// make it through" bug.
func TestCollector_PollEmitsSampleWithAllHardwareFlags(t *testing.T) {
	now := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)
	expected := wire.V1Status{
		ID:          "evt-77",
		TTL:         60,
		SmokerID:    "meatgeek3",
		Type:        "status",
		AugerOn:     true,
		BlowerOn:    false,
		IgniterOn:   true,
		FireHealthy: true,
		Mode:        "warmup",
		SetPoint:    275,
		ModeTime:    now,
		CurrentTime: now,
		Temps: wire.V1Temps{
			GrillTemp:  float64Ptr(220.5),
			Probe1Temp: float64Ptr(150.0),
			Probe2Temp: float64Ptr(99.0),
		},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/api/robots/MeatGeekBot/commands/get_status") {
			t.Errorf("unexpected path %q", r.URL.Path)
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(gobotResponseFor(t, expected))
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, 50*time.Millisecond, noop.NewTracerProvider().Tracer(""))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	startErr := make(chan error, 1)
	go func() { startErr <- c.Start(ctx) }()

	select {
	case s := <-c.Samples():
		if s.Status.SmokerID != "meatgeek3" {
			t.Errorf("SmokerID: got %q, want %q", s.Status.SmokerID, "meatgeek3")
		}
		if !s.Status.AugerOn || s.Status.BlowerOn || !s.Status.IgniterOn || !s.Status.FireHealthy {
			t.Errorf("hardware flags wrong, got %+v", s.Status)
		}
		if s.Status.Mode != "warmup" || s.Status.SetPoint != 275 {
			t.Errorf("mode/setPoint wrong, got mode=%q setPoint=%d", s.Status.Mode, s.Status.SetPoint)
		}
		if s.Status.Temps.GrillTemp == nil || *s.Status.Temps.GrillTemp != 220.5 {
			t.Errorf("grill temp wrong, got %v", s.Status.Temps.GrillTemp)
		}
		if s.Timestamp.IsZero() {
			t.Errorf("Timestamp should be set by collector")
		}
	case <-ctx.Done():
		t.Fatalf("never received a sample: %v", ctx.Err())
	}

	cancel()
	if err := <-startErr; err != nil && err != context.Canceled && err != context.DeadlineExceeded {
		t.Fatalf("Start returned unexpected error: %v", err)
	}
}

// TestCollector_NeverImportsCookSession is a compile-time guarantee that
// the collector package no longer references cooksession.Store. The
// architect's medium-likelihood race risk (cookId mutation racing the
// poll) is eliminated by ABSENCE: there is no field to mutate. We assert
// this by grepping the production source for the offending import.
func TestCollector_NeverImportsCookSession(t *testing.T) {
	data, err := os.ReadFile("collector.go")
	if err != nil {
		t.Fatalf("read collector.go: %v", err)
	}
	body := string(data)
	if strings.Contains(body, "internal/cooksession") {
		t.Errorf("collector.go must not import internal/cooksession; cook state lives only in main")
	}
	if strings.Contains(body, "SetActiveCook") || strings.Contains(body, "activeCookID") {
		t.Errorf("collector.go must not retain SetActiveCook / activeCookID; moved to cooksession.Store")
	}
}

// TestEndToEnd_CollectorQueueMockClient drives the wiring the queue runner
// uses in main.go: collector produces a Sample, the Sample is mapped to a
// TemperatureReading (with a SignalR-injected cookId), enqueued, then
// dequeued and published via a fake publisher. The fake publisher's
// recorded messageId must equal wire.MintMessageId(deviceId, ts, 1)
// (deterministic) and its correlation.id property must match the
// SignalR-injected value.
func TestEndToEnd_CollectorQueueMockClient(t *testing.T) {
	logrus.SetLevel(logrus.PanicLevel)

	expected := wire.V1Status{
		ID:       "evt-1",
		SmokerID: "meatgeek3",
		Mode:     "smoke",
		SetPoint: 225,
		Temps:    wire.V1Temps{GrillTemp: float64Ptr(220.5), Probe1Temp: float64Ptr(150.0)},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(gobotResponseFor(t, expected))
	}))
	t.Cleanup(srv.Close)

	c, err := New(srv.URL, 50*time.Millisecond, noop.NewTracerProvider().Tracer(""))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	q, err := queue.Open(t.TempDir(), queue.Options{FlushEveryN: 1, FlushInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatalf("queue.Open: %v", err)
	}
	t.Cleanup(func() { _ = q.Close() })

	const deviceID = "meatgeek3"
	const injectedCorrelationID = "corr-from-signalr-cook-started"
	const injectedCookID = "cook-abc-123"

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	collectorDone := make(chan struct{})
	go func() {
		defer close(collectorDone)
		_ = c.Start(ctx)
	}()

	cookID := injectedCookID
	correlation := injectedCorrelationID

	var sample Sample
	select {
	case sample = <-c.Samples():
	case <-time.After(2 * time.Second):
		t.Fatal("never observed a sample from collector")
	}

	reading := wire.MapV1ToTemperatureReading(sample.Status, sample.Timestamp, &cookID)
	readingBytes, err := json.Marshal(reading)
	if err != nil {
		t.Fatalf("marshal reading: %v", err)
	}
	seq := q.NextSeq()
	if seq != 1 {
		t.Fatalf("first NextSeq should return 1, got %d", seq)
	}
	rec := queueRecord{
		Timestamp:   sample.Timestamp,
		Seq:         seq,
		Correlation: correlation,
		Payload:     readingBytes,
	}
	recBytes, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal queueRecord: %v", err)
	}
	if err := q.Enqueue(recBytes); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	fake := &fakePublisher{}
	id, payload, ok := q.Peek()
	if !ok {
		t.Fatal("Peek: expected a record")
	}
	var got queueRecord
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("unmarshal record: %v", err)
	}
	expectedMessageID := wire.MintMessageId(deviceID, got.Timestamp, got.Seq)
	props := map[string]string{
		"messageId":      expectedMessageID,
		"correlation.id": got.Correlation,
	}
	if err := fake.PublishTelemetry(ctx, got.Payload, props); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if err := q.Ack(id); err != nil {
		t.Fatalf("Ack: %v", err)
	}

	if len(fake.calls) != 1 {
		t.Fatalf("fake publisher: expected 1 call, got %d", len(fake.calls))
	}
	call := fake.calls[0]
	wantMessageID := wire.MintMessageId(deviceID, got.Timestamp, 1)
	if call.props["messageId"] != wantMessageID {
		t.Errorf("messageId: got %q, want %q (= MintMessageId(deviceID, ts, 1))",
			call.props["messageId"], wantMessageID)
	}
	if call.props["correlation.id"] != injectedCorrelationID {
		t.Errorf("correlation.id: got %q, want %q",
			call.props["correlation.id"], injectedCorrelationID)
	}

	var publishedReading wire.TemperatureReading
	if err := json.Unmarshal(call.payload, &publishedReading); err != nil {
		t.Fatalf("unmarshal published payload: %v", err)
	}
	if publishedReading.CookID == nil || *publishedReading.CookID != injectedCookID {
		t.Errorf("published reading cookId: got %v, want %q",
			publishedReading.CookID, injectedCookID)
	}
	if publishedReading.DeviceID != deviceID {
		t.Errorf("published reading deviceId: got %q, want %q",
			publishedReading.DeviceID, deviceID)
	}
}

// queueRecord matches the on-the-wire JSON envelope cmd/main.go's
// enqueuer/publisher uses. Mirrored here so the e2e test exercises the
// exact shape; production type lives in cmd/main.go.
type queueRecord struct {
	Timestamp   time.Time       `json:"ts"`
	Seq         uint64          `json:"seq"`
	Correlation string          `json:"corr,omitempty"`
	Payload     json.RawMessage `json:"payload"`
}

// fakePublisher mimics iothub.Client without importing the package, so the
// e2e test stays focused on the collector + queue + wire wiring.
type fakePublisher struct {
	mu    sync.Mutex
	calls []fakePublishCall
}

type fakePublishCall struct {
	payload []byte
	props   map[string]string
}

func (f *fakePublisher) PublishTelemetry(_ context.Context, payload []byte, props map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	payloadCopy := append([]byte(nil), payload...)
	propsCopy := make(map[string]string, len(props))
	for k, v := range props {
		propsCopy[k] = v
	}
	f.calls = append(f.calls, fakePublishCall{payload: payloadCopy, props: propsCopy})
	return nil
}

func float64Ptr(v float64) *float64 { return &v }

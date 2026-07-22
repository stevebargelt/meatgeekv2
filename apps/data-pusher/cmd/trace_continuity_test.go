package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/collector"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"

	"go.opentelemetry.io/otel"
)

// TestTraceContinuity_EndToEnd_OneTracePerReading is the MG-33 F2 JOIN test.
//
// The pre-existing tests only prove each HALF independently: collector_test.go
// proves the outbound device-controller request carries the poll span's
// traceparent, and publisher_test.go manufactures its OWN enqueue root and
// proves that root rides through queue -> publish -> IoT message. Neither
// proves the two halves share ONE trace id. This test wires the REAL collector
// (against an httptest device-controller) into the REAL publisher and asserts a
// SINGLE trace id spans every hop of one reading:
//
//	poll span
//	  == traceparent injected on the device-controller request
//	  == sample.Traceparent (the collector -> enqueuer carrier, the F2 gap)
//	  == traceparent persisted in the recovered queue record (disk round-trip)
//	  == publish span
//	  == IoT Hub message traceparent property
//
// It also guards the per-reading property (two polls -> two DISTINCT traces):
// the fix must NOT regress into one-giant-trace-per-process.
func TestTraceContinuity_EndToEnd_OneTracePerReading(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()
	tracer := otel.Tracer("meatgeek-pusher-trace-continuity-test")

	const deviceID = "meatgeek3"

	// device-controller stand-in: it records the `traceparent` the collector
	// injects on each get_status request and replies with a valid gobot
	// {"result":"<V1Status json>"} envelope so the poll succeeds.
	var reqTraceparents []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqTraceparents = append(reqTraceparents, r.Header.Get("traceparent"))
		// Minimal but valid V1Status payload; the poll only needs it to decode.
		_, _ = w.Write([]byte(`{"result":"{}"}`))
	}))
	defer server.Close()

	// pollAndPublish drives one full reading through the real code paths and
	// returns the trace ids observed at each hop. A fresh collector per call:
	// Start closes its samples channel on return, so it is single-use. The
	// large poll interval means Start's immediate initial poll is the only tick
	// we depend on — we read that one sample and cancel.
	pollAndPublish := func() (pollTP, reqTP, recordTP, messageTP string) {
		c, err := collector.New(server.URL, time.Hour, tracer)
		if err != nil {
			t.Fatalf("collector.New: %v", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		startErr := make(chan error, 1)
		go func() { startErr <- c.Start(ctx) }()

		var sample collector.Sample
		select {
		case sample = <-c.Samples():
		case <-time.After(5 * time.Second):
			cancel()
			t.Fatal("collector did not emit a sample within 5s")
		}
		cancel()
		<-startErr

		if sample.Traceparent == "" {
			t.Fatal("sample carries no traceparent — the collector->enqueuer trace link is missing")
		}

		// --- enqueuer step: call the REAL production helper the enqueuer
		// goroutine uses, so a regression to trace.WithNewRoot here is caught.
		readingCtx, readingSpan := startReadingSpan(ctx, tracer, sample.Traceparent)
		rec := queueRecord{
			Timestamp:   sample.Timestamp,
			Correlation: "corr-1",
			Traceparent: telemetry.ExtractTraceparent(readingCtx),
			Payload:     mustReading(t, "cook-1"),
		}
		readingSpan.End()

		// --- durable queue round-trip: marshal + recover, as a restart would.
		onDisk, mErr := json.Marshal(rec)
		if mErr != nil {
			t.Fatalf("marshal record: %v", mErr)
		}
		var recovered queueRecord
		if uErr := json.Unmarshal(onDisk, &recovered); uErr != nil {
			t.Fatalf("unmarshal record: %v", uErr)
		}

		// --- publish step: the REAL publisher loop drains the recovered record.
		props := drainOnePublish(t, tracer, recovered, deviceID)
		messageTP = props[iothub.TraceParentPropertyName]
		if messageTP == "" {
			t.Fatal("published IoT Hub message carried no traceparent property")
		}

		lastReq := reqTraceparents[len(reqTraceparents)-1]
		return sample.Traceparent, lastReq, recovered.Traceparent, messageTP
	}

	pollTP, reqTP, recordTP, messageTP := pollAndPublish()

	pollTrace := traceIDOf(pollTP)
	if pollTrace == "" {
		t.Fatalf("poll traceparent %q has no trace id", pollTP)
	}

	// THE JOIN: one trace id across all five hops.
	for _, tc := range []struct {
		hop string
		tp  string
	}{
		{"device-controller request header", reqTP},
		{"recovered queue record", recordTP},
		{"IoT Hub message property", messageTP},
	} {
		if got := traceIDOf(tc.tp); got != pollTrace {
			t.Errorf("%s trace id = %q, want poll trace %q (traceparent=%q)", tc.hop, got, pollTrace, tc.tp)
		}
	}

	// Per-reading guard: a SECOND poll must produce a DIFFERENT trace id end to
	// end (fresh collector.poll span per tick), not fold into one process trace.
	pollTP2, reqTP2, recordTP2, messageTP2 := pollAndPublish()
	pollTrace2 := traceIDOf(pollTP2)
	if pollTrace2 == "" {
		t.Fatalf("second poll traceparent %q has no trace id", pollTP2)
	}
	if pollTrace2 == pollTrace {
		t.Fatalf("two readings shared trace id %q — regressed to one-giant-trace-per-process", pollTrace)
	}
	// ...and the second reading's chain is internally consistent on its own trace.
	for _, tc := range []struct {
		hop string
		tp  string
	}{
		{"device-controller request header (reading 2)", reqTP2},
		{"recovered queue record (reading 2)", recordTP2},
		{"IoT Hub message property (reading 2)", messageTP2},
	} {
		if got := traceIDOf(tc.tp); got != pollTrace2 {
			t.Errorf("%s trace id = %q, want reading-2 poll trace %q (traceparent=%q)", tc.hop, got, pollTrace2, tc.tp)
		}
	}
}

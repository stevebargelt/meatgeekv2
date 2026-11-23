package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/collector"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"
	"go.opentelemetry.io/otel/trace/noop"
)

func f64(v float64) *float64 { return &v }

// TestEnqueuer_OutOfRangeIsNoReadingLoggedOncePerPoll runs two polls through
// the real enqueuer: one with probe3 at the 2,409.9 °F an unplugged input
// read on the owner's Pi (HAR-151) and probe4 at -50 °F, one with only
// probe3 out of range. Each poll logs ONE out_of_range line naming the
// fields with this poll's count and the running total, never a value, and
// the queued reading carries no probe3 or probe4.
func TestEnqueuer_OutOfRangeIsNoReadingLoggedOncePerPoll(t *testing.T) {
	logs := captureLogs(t)
	sess, err := cooksession.Open(filepath.Join(t.TempDir(), "cook.json"))
	if err != nil {
		t.Fatal(err)
	}
	q, err := queue.Open(t.TempDir(), queue.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()

	ts := time.Date(2026, 11, 23, 15, 4, 6, 0, time.UTC)
	samples := make(chan collector.Sample, 2)
	samples <- collector.Sample{Timestamp: ts, Status: wire.V1Status{SmokerID: "meatgeek3", Temps: wire.V1Temps{
		GrillTemp: f64(64.4), Probe1Temp: f64(66.2), Probe3Temp: f64(2409.9), Probe4Temp: f64(-50),
	}}}
	samples <- collector.Sample{Timestamp: ts.Add(5 * time.Second), Status: wire.V1Status{SmokerID: "meatgeek3", Temps: wire.V1Temps{
		GrillTemp: f64(64.4), Probe3Temp: f64(2409.9),
	}}}
	close(samples)
	runEnqueuer(context.Background(), samples, sess, q, "meatgeek3", noop.NewTracerProvider().Tracer("t"))

	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			continue
		}
		if m["msg"] == "out_of_range" {
			lines = append(lines, m)
		}
	}
	if len(lines) != 2 {
		t.Fatalf("out_of_range lines = %d, want one per poll (2); logs:\n%s", len(lines), logs.String())
	}
	want := []struct {
		fields       string
		count, total float64
	}{
		{`["probe3","probe4"]`, 2, 2},
		{`["probe3"]`, 1, 3},
	}
	for i, w := range want {
		got := lines[i]
		if f := jsonString(t, got["fields"]); f != w.fields {
			t.Errorf("poll %d fields = %s, want %s", i+1, f, w.fields)
		}
		if got["count"] != w.count || got["total"] != w.total {
			t.Errorf("poll %d count/total = %v/%v, want %v/%v", i+1, got["count"], got["total"], w.count, w.total)
		}
	}
	if strings.Contains(logs.String(), "2409") {
		t.Fatalf("a refused value reached the logs:\n%s", logs.String())
	}
	for _, l := range lines {
		if s := jsonString(t, l); strings.Contains(s, "-50") {
			t.Fatalf("a refused value reached the out_of_range line: %s", s)
		}
	}

	_, raw, ok := q.Peek()
	if !ok {
		t.Fatal("nothing queued")
	}
	var rec queueRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatal(err)
	}
	var reading wire.TemperatureReading
	if err := json.Unmarshal(rec.Payload, &reading); err != nil {
		t.Fatal(err)
	}
	if reading.Probe3Temp != nil || reading.Probe4Temp != nil {
		t.Fatalf("queued reading kept an out-of-range probe: %s", rec.Payload)
	}
	if reading.Probe1Temp == nil || *reading.Probe1Temp != 66.2 {
		t.Fatalf("queued reading lost the in-range probe1: %s", rec.Payload)
	}
}

func jsonString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

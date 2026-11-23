package iothub

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
)

// HAR-150: the "applied and reported desired properties" line carries
// desiredUpdatedAt and applyLagMs, read from IoT Hub's $metadata and the
// injected clock. Every time here is on the fake clock, which only moves when
// a test advances it.

// appliedLogHook records every "applied and reported" entry of the standard
// logger. It is an await.Source: it signals after each entry, so a test waits
// for the line instead of racing the worker that logs it.
type appliedLogHook struct {
	await.Signal
	mu      sync.Mutex
	entries []logrus.Fields
}

func (h *appliedLogHook) Levels() []logrus.Level { return logrus.AllLevels }

func (h *appliedLogHook) Fire(e *logrus.Entry) error {
	if e.Message != twinAppliedLogMessage {
		return nil
	}
	fields := logrus.Fields{}
	for k, v := range e.Data {
		fields[k] = v
	}
	h.mu.Lock()
	h.entries = append(h.entries, fields)
	h.mu.Unlock()
	h.Notify()
	return nil
}

func (h *appliedLogHook) all() []logrus.Fields {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]logrus.Fields(nil), h.entries...)
}

// awaitApplied waits for the applied line of desired version v and returns it.
func (h *appliedLogHook) awaitApplied(t *testing.T, v int64) logrus.Fields {
	t.Helper()
	var found logrus.Fields
	await.Until(t, "the applied line of the desired version", func() bool {
		for _, e := range h.all() {
			if e["appliedDesiredVersion"] == v {
				found = e
				return true
			}
		}
		return false
	}, func() any { return h.all() }, h)
	return found
}

// hookAppliedLog adds an appliedLogHook to the standard logger for the test.
func hookAppliedLog(t *testing.T) *appliedLogHook {
	t.Helper()
	h := &appliedLogHook{}
	std := logrus.StandardLogger()
	std.AddHook(h)
	t.Cleanup(func() {
		hooks := logrus.LevelHooks{}
		for level, list := range std.Hooks {
			for _, hook := range list {
				if hook != h {
					hooks[level] = append(hooks[level], hook)
				}
			}
		}
		std.ReplaceHooks(hooks)
	})
	return h
}

// metadataAt is a desired $metadata section stamping each key at its time.
func metadataAt(at map[string]time.Time) map[string]any {
	md := map[string]any{"$lastUpdated": testClockStart.Add(-time.Hour).Format(time.RFC3339Nano)}
	for key, when := range at {
		md[key] = map[string]any{"$lastUpdated": when.UTC().Format(time.RFC3339Nano), "$lastUpdatedVersion": 1}
	}
	return md
}

func TestTwin_PatchLogsApplyLagFromMetadata(t *testing.T) {
	h := hookAppliedLog(t)
	b := iothubtest.NewBroker(t)
	st := &memState{}
	startTwinClient(t, b, st)

	written := testClockStart.Add(-1500 * time.Millisecond)
	v := b.SetDesired(map[string]any{
		"activeCookId":  "c1",
		"correlationId": "r1",
		"$metadata":     metadataAt(map[string]time.Time{"activeCookId": written, "correlationId": written}),
	})
	got := h.awaitApplied(t, v)

	if got["source"] != "patch" {
		t.Errorf("source = %v, want patch", got["source"])
	}
	if got["desiredUpdatedAt"] != written.UTC().Format(time.RFC3339Nano) {
		t.Errorf("desiredUpdatedAt = %v, want %s", got["desiredUpdatedAt"], written.UTC().Format(time.RFC3339Nano))
	}
	if got["applyLagMs"] != int64(1500) {
		t.Errorf("applyLagMs = %v (%T), want 1500", got["applyLagMs"], got["applyLagMs"])
	}
}

func TestTwin_SyncAfterReconnectLogsApplyLagIncludingTimeOffline(t *testing.T) {
	h := hookAppliedLog(t)
	b := iothubtest.NewBroker(t)
	st := &memState{}
	_, clk := startTwinClient(t, b, st)

	// The cook was written 10 s ago and the device missed its patch; it reads
	// the change on its next connect's GET, after the reconnect backoff.
	written := clk.Now().Add(-10 * time.Second)
	v := b.SetDesiredQuietly(map[string]any{
		"activeCookId":  "c1",
		"correlationId": "r1",
		"$metadata":     metadataAt(map[string]time.Time{"activeCookId": written, "correlationId": written}),
	})
	dropAndRedial(t, b, clk)
	got := h.awaitApplied(t, v)

	if got["source"] != "get" {
		t.Errorf("source = %v, want get", got["source"])
	}
	want := (10*time.Second + testBackoff).Milliseconds()
	if got["applyLagMs"] != want {
		t.Errorf("applyLagMs = %v, want %d", got["applyLagMs"], want)
	}
}

func TestTwin_NoMetadataLogsNoLagFields(t *testing.T) {
	h := hookAppliedLog(t)
	b := iothubtest.NewBroker(t)
	st := &memState{}
	startTwinClient(t, b, st)

	v := b.SetDesired(map[string]any{"activeCookId": "c1", "correlationId": "r1"})
	got := h.awaitApplied(t, v)

	if got["cookId"] != "c1" || got["source"] != "patch" {
		t.Errorf("applied line = %v", got)
	}
	for _, key := range []string{"desiredUpdatedAt", "applyLagMs"} {
		if _, ok := got[key]; ok {
			t.Errorf("applied line has %s without $metadata: %v", key, got)
		}
	}
}

func TestNewApplyLag(t *testing.T) {
	now := testClockStart
	earlier := now.Add(-3 * time.Second)
	later := now.Add(-time.Second)
	raw := func(v any) map[string]json.RawMessage {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	both := raw(map[string]any{"$metadata": metadataAt(map[string]time.Time{
		TwinDesiredActiveCookID: earlier, TwinDesiredCorrelationID: later,
	})})

	cases := []struct {
		name    string
		desired map[string]json.RawMessage
		keys    []string
		want    time.Duration // 0: no lag
	}{
		{"the latest of the changed keys", both, []string{TwinDesiredActiveCookID, TwinDesiredCorrelationID}, time.Second},
		{"only the changed key", both, []string{TwinDesiredActiveCookID}, 3 * time.Second},
		{"no changed key", both, nil, 0},
		{"no $metadata", raw(map[string]any{"activeCookId": "c1"}), []string{TwinDesiredActiveCookID}, 0},
		{"$metadata not an object", raw(map[string]any{"$metadata": "x"}), []string{TwinDesiredActiveCookID}, 0},
		{"key not in $metadata", both, []string{"other"}, 0},
		{"$lastUpdated not a time", raw(map[string]any{"$metadata": map[string]any{
			TwinDesiredActiveCookID: map[string]any{"$lastUpdated": "soon"},
		}}), []string{TwinDesiredActiveCookID}, 0},
		{"IoT Hub's 7-digit fraction", raw(map[string]any{"$metadata": map[string]any{
			TwinDesiredActiveCookID: map[string]any{"$lastUpdated": "2023-11-14T22:13:18.5000000Z"},
		}}), []string{TwinDesiredActiveCookID}, 1500 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := newApplyLag(tc.desired, tc.keys, now)
			fields := logrus.Fields{}
			got.addTo(fields)
			if tc.want == 0 {
				if len(fields) != 0 {
					t.Fatalf("fields = %v, want none", fields)
				}
				return
			}
			if fields["applyLagMs"] != tc.want.Milliseconds() {
				t.Errorf("applyLagMs = %v, want %d", fields["applyLagMs"], tc.want.Milliseconds())
			}
			if fields["desiredUpdatedAt"] != now.Add(-tc.want).UTC().Format(time.RFC3339Nano) {
				t.Errorf("desiredUpdatedAt = %v", fields["desiredUpdatedAt"])
			}
		})
	}
}

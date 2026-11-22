package main

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/publish"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/simdevice"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"

	"go.opentelemetry.io/otel"
	oteltrace "go.opentelemetry.io/otel/trace"
)

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestPusherAndSimdeviceMessagesMatch asserts that for the same V1Status,
// timestamp and sequence number, the data-pusher's own publish path and
// simdevice publish byte-identical payloads, the same messageId, and the same
// property key set — i.e. a simdevice message is indistinguishable from a
// Pi's.
func TestPusherAndSimdeviceMessagesMatch(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()
	tracer := otel.Tracer("parity-test")

	const deviceID = "meatgeek3"
	status := simdevice.SyntheticStatus(deviceID, 4)
	ts := time.Date(2026, 11, 19, 10, 30, 15, 123_000_000, time.UTC)
	const seq uint64 = 42

	// --- data-pusher path: enqueuer record -> disk queue -> runPublisher.
	readingCtx, readingSpan := startReadingSpan(context.Background(), tracer, "")
	rec, err := buildQueueRecord(readingCtx, status, ts, nil, seq, "")
	readingSpan.End()
	if err != nil {
		t.Fatalf("buildQueueRecord: %v", err)
	}
	pusherCall := publishRecord(t, tracer, rec, deviceID)

	// --- simdevice path, one Send.
	mock := iothub.NewMockClient()
	sent, err := simdevice.Sender{Client: mock, DeviceID: deviceID, Tracer: tracer}.Send(context.Background(), status, ts, seq)
	if err != nil {
		t.Fatalf("simdevice Send: %v", err)
	}
	calls := mock.Calls()
	if len(calls) != 1 {
		t.Fatalf("simdevice publish calls = %d, want 1", len(calls))
	}
	assertSameMessage(t, pusherCall, calls[0])
	if sent.MessageID != calls[0].Properties["messageId"] {
		t.Errorf("Sent.MessageID %q != published messageId %q", sent.MessageID, calls[0].Properties["messageId"])
	}
}

// TestPusherAndSimdeviceMessagesMatchForEveryInflight runs the whole simdevice
// command at several --inflight values (1 is the blocking send, more the
// pipelined one) and checks its 5th reading against the data-pusher's message
// for the same status, timestamp and sequence number.
func TestPusherAndSimdeviceMessagesMatchForEveryInflight(t *testing.T) {
	shutdown, err := telemetry.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()
	tracer := otel.Tracer("parity-test")

	const deviceID = "meatgeek3"
	conn := "HostName=hub-dev.azure-devices.net;DeviceId=" + deviceID + ";SharedAccessKey=ZmFrZS1rZXk="
	start := time.Date(2026, 11, 19, 10, 30, 15, 123_000_000, time.UTC)
	// simdevice's i-th reading (0-based): SyntheticStatus(i), seq i+1, and with
	// a frozen clock a timestamp i ms after it.
	const i = 4
	ts := start.Add(i * time.Millisecond)
	const seq uint64 = i + 1

	readingCtx, readingSpan := startReadingSpan(context.Background(), tracer, "")
	rec, err := buildQueueRecord(readingCtx, simdevice.SyntheticStatus(deviceID, i), ts, nil, seq, "")
	readingSpan.End()
	if err != nil {
		t.Fatalf("buildQueueRecord: %v", err)
	}
	pusherCall := publishRecord(t, tracer, rec, deviceID)
	wantID := publish.MessageID(deviceID, ts, seq)

	for _, inflight := range []int{1, 2, 8, 32} {
		t.Run(fmt.Sprintf("inflight=%d", inflight), func(t *testing.T) {
			mock := iothub.NewMockClient()
			var stdout, stderr bytes.Buffer
			code := simdevice.Main(context.Background(), simdevice.Env{
				Args:      []string{"--count", "8", "--inflight", fmt.Sprint(inflight)},
				Getenv:    func(k string) string { return map[string]string{simdevice.EnvConnectionString: conn}[k] },
				Stdout:    &stdout,
				Stderr:    &stderr,
				NewClient: func(string) (simdevice.Client, error) { return mock, nil },
				Tracer:    tracer,
				Now:       func() time.Time { return start },
			})
			if code != simdevice.ExitOK {
				t.Fatalf("exit = %d; stderr=%q", code, stderr.String())
			}
			var simCall *iothub.MockPublishCall
			for _, c := range mock.Calls() {
				if c.Properties["messageId"] == wantID {
					c := c
					simCall = &c
				}
			}
			if simCall == nil {
				t.Fatalf("simdevice published no message with messageId %q", wantID)
			}
			assertSameMessage(t, pusherCall, *simCall)
		})
	}
}

// assertSameMessage fails unless the two published messages have
// byte-identical payloads, the same property key set, and the same messageId
// and content type/encoding.
func assertSameMessage(t *testing.T, pusherCall, simCall iothub.MockPublishCall) {
	t.Helper()
	if string(pusherCall.Payload) != string(simCall.Payload) {
		t.Errorf("payloads differ:\n pusher:    %s\n simdevice: %s", pusherCall.Payload, simCall.Payload)
	}
	pk, sk := keysOf(pusherCall.Properties), keysOf(simCall.Properties)
	if len(pk) != len(sk) {
		t.Fatalf("property key sets differ: pusher %v, simdevice %v", pk, sk)
	}
	for i := range pk {
		if pk[i] != sk[i] {
			t.Fatalf("property key sets differ: pusher %v, simdevice %v", pk, sk)
		}
	}
	for _, k := range []string{"messageId", "$.ct", "$.ce"} {
		if pusherCall.Properties[k] != simCall.Properties[k] {
			t.Errorf("property %q differs: pusher %q, simdevice %q", k, pusherCall.Properties[k], simCall.Properties[k])
		}
	}
}

// publishRecord enqueues rec as-is (keeping its Seq) and runs the real
// publisher loop until it publishes exactly that one record.
func publishRecord(t *testing.T, tracer oteltrace.Tracer, rec queueRecord, deviceID string) iothub.MockPublishCall {
	t.Helper()
	q, err := queue.Open(t.TempDir(), queue.Options{})
	if err != nil {
		t.Fatalf("queue.Open: %v", err)
	}
	defer q.Close()
	return enqueueAndPublish(t, tracer, q, rec, deviceID)
}

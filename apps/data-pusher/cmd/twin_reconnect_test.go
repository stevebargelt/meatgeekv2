package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/collector"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/simdevice"

	"go.opentelemetry.io/otel"
)

const twinTestConnStr = "HostName=test-hub.azure-devices.net;DeviceId=pi-1;SharedAccessKey=ZmFrZS1rZXktZG8tbm90LXVzZS0xMjM0NTY3ODkw"

// TestTwin_CookStartedWhileDisconnectedReachesTheNextReading is HAR-58's
// reconnect case, end to end through the pusher's own wiring: a cook is set in
// the twin's desired properties ({activeCookId: c1, correlationId: r1,
// $version: 2}) while the device is disconnected, so no patch reaches it.
// When the client reconnects, the twin GET applies the cook to the persisted
// cook session and reports appliedDesiredVersion 2, and the next reading the
// enqueuer writes and the publisher sends carries cookId c1 in its body and
// correlation.id r1 as a message property.
func TestTwin_CookStartedWhileDisconnectedReachesTheNextReading(t *testing.T) {
	const wait = 10 * time.Second
	tracer := otel.Tracer("twin-reconnect-test")
	broker := iothubtest.NewBroker(t)

	statePath := filepath.Join(t.TempDir(), "cooksession.json")
	sess, err := cooksession.Open(statePath)
	if err != nil {
		t.Fatalf("cooksession.Open: %v", err)
	}
	client, err := iothub.NewAzureClient(twinTestConnStr,
		iothub.WithBrokerURL(broker.URL()),
		iothub.WithCookTwin(sess),
		iothub.WithTwinTimeout(2*time.Second))
	if err != nil {
		t.Fatalf("NewAzureClient: %v", err)
	}
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.Start(ctx)

	syncCtx, syncCancel := context.WithTimeout(ctx, wait)
	defer syncCancel()
	if err := client.WaitTwinSynced(syncCtx); err != nil {
		t.Fatalf("first twin sync: %v", err)
	}
	if got := sess.Snapshot(); got.CookID != nil || got.AppliedDesiredVersion != 1 {
		t.Fatalf("before the cook: session = %+v", got)
	}

	// The device drops off; the cook starts while it is away.
	broker.DropConnections()
	if v := broker.SetDesiredQuietly(map[string]any{"activeCookId": "c1", "correlationId": "r1"}); v != 2 {
		t.Fatalf("desired $version = %d, want 2", v)
	}

	// Start reconnects on its own and the GET on connect applies the cook.
	iothubtest.Eventually(t, wait, func() bool {
		s := sess.Snapshot()
		return s.CookID != nil && *s.CookID == "c1" && s.CorrelationID != nil && *s.CorrelationID == "r1" && s.AppliedDesiredVersion == 2
	}, "cook session after reconnect = %+v", sess.Snapshot())
	if broker.Connections() < 2 {
		t.Fatalf("connections = %d, want a reconnect", broker.Connections())
	}

	// ...and it was persisted, not just held in memory.
	reopened, err := cooksession.Open(statePath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reopened.Snapshot(); got.CookID == nil || *got.CookID != "c1" || got.AppliedDesiredVersion != 2 {
		t.Fatalf("persisted session = %+v", got)
	}

	// The device reported what it applied.
	iothubtest.Eventually(t, wait, func() bool {
		for _, p := range broker.ReportedPatches() {
			if p["appliedDesiredVersion"] == float64(2) && p["activeCookId"] == "c1" && p["correlationId"] == "r1" {
				return true
			}
		}
		return false
	}, "reported patch with appliedDesiredVersion 2; got %v", broker.ReportedPatches())

	// The next reading goes through the real enqueuer and publisher.
	q, err := queue.Open(t.TempDir(), queue.Options{})
	if err != nil {
		t.Fatalf("queue.Open: %v", err)
	}
	defer q.Close()
	samples := make(chan collector.Sample, 1)
	samples <- collector.Sample{Status: simdevice.SyntheticStatus("pi-1", 0), Timestamp: time.Now().UTC()}
	close(samples)
	runEnqueuer(ctx, samples, sess, q, client.DeviceID(), tracer)

	pubDone := make(chan struct{})
	go func() {
		runPublisher(ctx, q, client, client.DeviceID(), tracer)
		close(pubDone)
	}()
	iothubtest.Eventually(t, wait, func() bool { return len(broker.Telemetry()) == 1 }, "one telemetry message")
	cancel()
	<-pubDone

	msg := broker.Telemetry()[0]
	var body struct {
		CookID *string `json:"cookId"`
	}
	if err := json.Unmarshal(msg.Payload, &body); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if body.CookID == nil || *body.CookID != "c1" {
		t.Errorf("reading cookId = %v, want c1 (payload %s)", body.CookID, msg.Payload)
	}
	if got := msg.Properties.Get(iothub.CorrelationIDPropertyName); got != "r1" {
		t.Errorf("reading correlation.id = %q, want r1 (topic %s)", got, msg.Topic)
	}
	if m := broker.MaxConcurrentConnections(); m != 1 {
		t.Errorf("max concurrent connections = %d, want 1 (IoT Hub allows one per device)", m)
	}
}

package iothub

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
)

const testConnStr = "HostName=test-hub.azure-devices.net;DeviceId=dev1;SharedAccessKey=ZmFrZS1rZXktZG8tbm90LXVzZS0xMjM0NTY3ODkw"

const wait = 5 * time.Second

// memState is a CookState that records every apply.
type memState struct {
	mu      sync.Mutex
	cook    *string
	corr    *string
	version int64
	applies []applied
}

type applied struct {
	cook, corr string
	version    int64
}

func (m *memState) AppliedDesired() (*string, *string, int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cook, m.corr, m.version
}

func (m *memState) ApplyDesired(cook, corr *string, version int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cook, m.corr, m.version = cook, corr, version
	m.applies = append(m.applies, applied{derefOr(cook, "<nil>"), derefOr(corr, "<nil>"), version})
	return nil
}

func (m *memState) get() applied {
	m.mu.Lock()
	defer m.mu.Unlock()
	return applied{derefOr(m.cook, "<nil>"), derefOr(m.corr, "<nil>"), m.version}
}

func (m *memState) history() []applied {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]applied(nil), m.applies...)
}

// startTwinClient starts an AzureClient with the twin on, against b, and
// waits for its first sync.
func startTwinClient(t *testing.T, b *iothubtest.Broker, state CookState, opts ...Option) *AzureClient {
	t.Helper()
	opts = append([]Option{
		WithBrokerURL(b.URL()),
		WithCookTwin(state),
		WithTwinTimeout(2 * time.Second),
		withReconnectBackoff(20*time.Millisecond, 200*time.Millisecond),
	}, opts...)
	c, err := NewAzureClient(testConnStr, opts...)
	if err != nil {
		t.Fatalf("NewAzureClient: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	c.Start(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	if err := c.WaitTwinSynced(ctx); err != nil {
		t.Fatalf("WaitTwinSynced: %v", err)
	}
	return c
}

// lastReport is the newest reported patch the broker accepted.
func lastReport(b *iothubtest.Broker) map[string]any {
	r := b.ReportedPatches()
	if len(r) == 0 {
		return nil
	}
	return r[len(r)-1]
}

func reportIs(b *iothubtest.Broker, cook, corr any, version int64) func() bool {
	return func() bool {
		r := lastReport(b)
		return r != nil && r["activeCookId"] == cook && r["correlationId"] == corr && r["appliedDesiredVersion"] == float64(version)
	}
}

// Desired properties written before the device connects are applied and
// reported on connect: the GET is the reconcile.
func TestTwin_ConnectAppliesDesiredWrittenWhileOffline(t *testing.T) {
	b := iothubtest.NewBroker(t)
	v := b.SetDesired(map[string]any{"activeCookId": "c1", "correlationId": "r1"}) // no device connected: nobody gets the patch
	if v != 2 {
		t.Fatalf("desired version = %d, want 2", v)
	}
	st := &memState{}
	startTwinClient(t, b, st)

	if got := st.get(); got != (applied{"c1", "r1", 2}) {
		t.Fatalf("state = %+v", got)
	}
	if !reportIs(b, "c1", "r1", 2)() {
		t.Fatalf("reported patch = %v", lastReport(b))
	}
	subs := b.Subscriptions(1)
	for _, want := range []string{"$iothub/twin/res/#", "$iothub/twin/PATCH/properties/desired/#"} {
		if !slices.Contains(subs, want) {
			t.Errorf("connection 1 subscriptions %v missing %q", subs, want)
		}
	}
}

func TestTwin_PatchWhileConnectedIsAppliedAndReported(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	startTwinClient(t, b, st)
	if got := st.get(); got != (applied{"<nil>", "<nil>", 1}) {
		t.Fatalf("initial state = %+v", got)
	}

	v := b.SetDesired(map[string]any{"activeCookId": "c2", "correlationId": "r2"})
	iothubtest.Eventually(t, wait, reportIs(b, "c2", "r2", v), "report of patch v%d; last report %v", v, lastReport(b))
	if got := st.get(); got != (applied{"c2", "r2", v}) {
		t.Fatalf("state = %+v", got)
	}
	// A patch merges: changing only correlationId keeps the cook.
	v = b.SetDesired(map[string]any{"correlationId": "r3"})
	iothubtest.Eventually(t, wait, reportIs(b, "c2", "r3", v), "report of merged patch; last report %v", lastReport(b))
	if n := len(b.TwinGets()); n != 1 {
		t.Errorf("twin GETs = %d, want 1 (patches must merge, not re-GET)", n)
	}
}

func TestTwin_PatchNotNewerIsIgnored(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetDesiredQuietly(map[string]any{"activeCookId": "c1", "correlationId": "r1"}) // v2
	st := &memState{}
	startTwinClient(t, b, st)
	reports := len(b.ReportedPatches())

	b.SendDesiredPatch(2, map[string]any{"activeCookId": "stale-equal"})
	b.SendDesiredPatch(1, map[string]any{"activeCookId": "stale-older"})
	// A real patch after them proves they were processed (and dropped).
	v := b.SetDesired(map[string]any{"correlationId": "r9"}) // v3
	iothubtest.Eventually(t, wait, reportIs(b, "c1", "r9", v), "report of v3; last report %v", lastReport(b))

	for _, a := range st.history() {
		if a.cook == "stale-equal" || a.cook == "stale-older" {
			t.Fatalf("stale patch applied: %+v", st.history())
		}
	}
	if got := len(b.ReportedPatches()) - reports; got != 1 {
		t.Errorf("reports after the stale patches = %d, want 1 (only v3)", got)
	}
}

func TestTwin_NullActiveCookIDClearsTheCook(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetDesiredQuietly(map[string]any{"activeCookId": "c1", "correlationId": "r1"})
	st := &memState{}
	startTwinClient(t, b, st)

	v := b.SetDesired(map[string]any{"activeCookId": nil})
	iothubtest.Eventually(t, wait, reportIs(b, nil, "r1", v), "report of cleared cook; last report %v", lastReport(b))
	if got := st.get(); got != (applied{"<nil>", "r1", v}) {
		t.Fatalf("state = %+v", got)
	}
	// And a full GET of a twin without the property also clears it.
	b.SetDesiredQuietly(map[string]any{"activeCookId": "c5"})
	b.DropConnections()
	iothubtest.Eventually(t, wait, func() bool { return st.get().cook == "c5" }, "c5 after reconnect")
	v = b.SetDesiredQuietly(map[string]any{"activeCookId": nil, "correlationId": nil})
	b.DropConnections()
	iothubtest.Eventually(t, wait, func() bool { return st.get() == applied{"<nil>", "<nil>", v} }, "cleared after reconnect, state %+v", st.get())
}

func TestTwin_VersionGapTriggersFullGet(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	startTwinClient(t, b, st) // applied v1
	gets := len(b.TwinGets())

	// The twin moves to v3 behind the device's back (it missed v2)...
	v := b.SetDesiredQuietly(map[string]any{"activeCookId": "c-from-v2"})
	v = b.SetDesiredQuietly(map[string]any{"correlationId": "r-from-v3"})
	// ...and the v3 patch arrives. Merging it onto v1 would lose c-from-v2;
	// the body below is a lie to prove the device used the GET, not the patch.
	b.SendDesiredPatch(v, map[string]any{"correlationId": "patch-body"})

	iothubtest.Eventually(t, wait, reportIs(b, "c-from-v2", "r-from-v3", v), "report after re-GET; last report %v", lastReport(b))
	if got := len(b.TwinGets()); got != gets+1 {
		t.Errorf("twin GETs = %d, want %d", got, gets+1)
	}
	for _, a := range st.history() {
		if a.corr == "patch-body" {
			t.Fatalf("gapped patch was merged instead of re-GET: %+v", st.history())
		}
	}
}

// The SAS-refresh reconnect re-subscribes (CleanSession) and re-reads the
// twin, picking up a change it was not sent.
func TestTwin_SASRefreshReconnectResubscribesAndRereads(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	// A 3s token is refreshed halfway (1.5s before expiry).
	startTwinClient(t, b, st, WithSASTokenTTL(3*time.Second))
	v := b.SetDesiredQuietly(map[string]any{"activeCookId": "c-after-refresh"})

	iothubtest.Eventually(t, 3*wait, func() bool { return b.Connections() >= 2 }, "SAS refresh reconnect")
	iothubtest.Eventually(t, wait, func() bool { return st.get().cook == "c-after-refresh" && st.get().version == v }, "re-read after refresh, state %+v", st.get())

	subs := b.Subscriptions(2)
	for _, want := range []string{"$iothub/twin/res/#", "$iothub/twin/PATCH/properties/desired/#"} {
		if !slices.Contains(subs, want) {
			t.Errorf("connection 2 subscriptions %v missing %q", subs, want)
		}
	}
	if !slices.Contains(b.TwinGets(), 2) {
		t.Errorf("no twin GET on connection 2: %v", b.TwinGets())
	}
	// The refreshed connection gets patches.
	v = b.SetDesired(map[string]any{"correlationId": "r-live"})
	iothubtest.Eventually(t, wait, reportIs(b, "c-after-refresh", "r-live", v), "patch on refreshed connection; last %v", lastReport(b))
	if m := b.MaxConcurrentConnections(); m != 1 {
		t.Errorf("max concurrent connections = %d, want 1", m)
	}
}

// After a dropped connection Start reconnects on its own and re-reads.
func TestTwin_DroppedConnectionReconnectsAndRereads(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	startTwinClient(t, b, st)

	b.DropConnections()
	v := b.SetDesiredQuietly(map[string]any{"activeCookId": "c-offline"})
	iothubtest.Eventually(t, wait, func() bool { return st.get() == applied{"c-offline", "<nil>", v} }, "re-read after drop, state %+v", st.get())
	iothubtest.Eventually(t, wait, reportIs(b, "c-offline", nil, v), "report after drop; last %v", lastReport(b))
}

// A failed report is logged and retried on the next connect.
func TestTwin_FailedReportRetriedOnNextConnect(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	startTwinClient(t, b, st)
	before := len(b.ReportedPatches())

	b.FailNextReport(429)
	v := b.SetDesired(map[string]any{"activeCookId": "c1"})
	iothubtest.Eventually(t, wait, func() bool { return st.get().cook == "c1" }, "patch applied")
	time.Sleep(100 * time.Millisecond)
	if got := len(b.ReportedPatches()); got != before {
		t.Fatalf("a failed report was recorded: %d -> %d", before, got)
	}

	b.DropConnections()
	iothubtest.Eventually(t, wait, reportIs(b, "c1", nil, v), "report retried after reconnect; last %v", lastReport(b))
}

// Telemetry and the twin share one connection.
func TestTwin_TelemetrySharesTheConnection(t *testing.T) {
	b := iothubtest.NewBroker(t)
	c := startTwinClient(t, b, &memState{})
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	if err := c.PublishTelemetry(ctx, []byte(`{"x":1}`), map[string]string{MessageIDPropertyName: "m1"}); err != nil {
		t.Fatalf("PublishTelemetry: %v", err)
	}
	tel := b.Telemetry()
	if len(tel) != 1 || tel[0].Conn != 1 || tel[0].Properties.Get("messageId") != "m1" || tel[0].DeviceID != "dev1" {
		t.Fatalf("telemetry = %+v", tel)
	}
	if n := b.Connections(); n != 1 {
		t.Errorf("connections = %d, want 1", n)
	}
}

func TestWaitTwinSynced_TimesOutWithLastError(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetUnresponsive(true)
	c, err := NewAzureClient(testConnStr, WithBrokerURL(b.URL()), WithCookTwin(&memState{}), WithTwinTimeout(100*time.Millisecond))
	if err != nil {
		t.Fatalf("NewAzureClient: %v", err)
	}
	defer c.Close()
	c.Start(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	err = c.WaitTwinSynced(ctx)
	if err == nil {
		t.Fatal("WaitTwinSynced: want error from an unresponsive hub")
	}
	if want := "no response"; !strings.Contains(err.Error(), want) {
		t.Errorf("error %q should carry the last twin error (%q)", err, want)
	}
}

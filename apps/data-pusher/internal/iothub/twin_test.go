package iothub

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
)

// The twin tests' device: its hub and id.
const (
	testHub      = "test-hub.azure-devices.net"
	testDeviceID = "dev1"
)

// The twin tests run the client on a fake clock: no backoff or timeout fires
// unless a test advances the clock past it.
var testClockStart = time.Unix(1_700_000_000, 0)

// testBackoff is the reconnect backoff (min = max, so every redial waits
// exactly this long on the fake clock).
const testBackoff = time.Second

// memState is a CookState that records every apply. It is an await.Source:
// it signals after each apply.
type memState struct {
	await.Signal
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
	m.cook, m.corr, m.version = cook, corr, version
	m.applies = append(m.applies, applied{derefOr(cook, "<nil>"), derefOr(corr, "<nil>"), version})
	m.mu.Unlock()
	m.Notify()
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

// startTwinClient starts an AzureClient with the twin on, against b and on a
// fake clock, and waits for its first sync.
func startTwinClient(t *testing.T, b *iothubtest.Broker, state CookState, opts ...Option) (*AzureClient, *clocktest.Fake) {
	t.Helper()
	clk := clocktest.New(testClockStart)
	opts = append([]Option{
		WithBrokerURL(b.URL()),
		WithCookTwin(state),
		WithClock(clk),
		withReconnectBackoff(testBackoff, testBackoff),
	}, opts...)
	c, err := NewX509Client(testHub, testDeviceID, deviceCert(t, testDeviceID), opts...)
	if err != nil {
		t.Fatalf("NewX509Client: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	c.Start(t.Context())
	if err := c.WaitTwinSynced(await.Context(t)); err != nil {
		t.Fatalf("WaitTwinSynced: %v", err)
	}
	return c, clk
}

// advanceWhenPending waits until the client has a timer of duration d
// pending on clk (a backoff or timeout it has reached), then advances clk
// past it.
func advanceWhenPending(t *testing.T, clk *clocktest.Fake, d time.Duration, what string) {
	t.Helper()
	await.Until(t, what, func() bool { return slices.Contains(clk.Pending(), d) },
		func() any { return clk.Pending() }, clk)
	clk.Advance(d)
}

// dropAndRedial drops the device's connection like a network failure and
// lets its reconnect backoff elapse, then waits for the new connection.
func dropAndRedial(t *testing.T, b *iothubtest.Broker, clk *clocktest.Fake) {
	t.Helper()
	n := b.Connections()
	b.DropConnections()
	advanceWhenPending(t, clk, testBackoff, "the reconnect backoff after the drop")
	await.Until(t, "a reconnect", func() bool { return b.Connections() > n },
		func() any { return b.Connections() }, b)
}

// awaitReport waits until the newest reported patch is {cook, corr, version}.
func awaitReport(t *testing.T, b *iothubtest.Broker, what string, cook, corr any, version int64) {
	t.Helper()
	await.Until(t, what, reportIs(b, cook, corr, version), func() any { return lastReport(b) }, b)
}

// awaitState waits until st holds want.
func awaitState(t *testing.T, st *memState, what string, want applied) {
	t.Helper()
	await.Until(t, what, func() bool { return st.get() == want }, func() any { return st.get() }, st)
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
	awaitReport(t, b, "the report of the patch", "c2", "r2", v)
	if got := st.get(); got != (applied{"c2", "r2", v}) {
		t.Fatalf("state = %+v", got)
	}
	// A patch merges: changing only correlationId keeps the cook.
	v = b.SetDesired(map[string]any{"correlationId": "r3"})
	awaitReport(t, b, "the report of the merged patch", "c2", "r3", v)
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
	awaitReport(t, b, "the report of v3", "c1", "r9", v)

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
	_, clk := startTwinClient(t, b, st)

	v := b.SetDesired(map[string]any{"activeCookId": nil})
	awaitReport(t, b, "the report of the cleared cook", nil, "r1", v)
	if got := st.get(); got != (applied{"<nil>", "r1", v}) {
		t.Fatalf("state = %+v", got)
	}
	// And a full GET of a twin without the property also clears it.
	v = b.SetDesiredQuietly(map[string]any{"activeCookId": "c5"})
	dropAndRedial(t, b, clk)
	awaitState(t, st, "c5 after the reconnect", applied{"c5", "r1", v})
	v = b.SetDesiredQuietly(map[string]any{"activeCookId": nil, "correlationId": nil})
	dropAndRedial(t, b, clk)
	awaitState(t, st, "the cook cleared after the reconnect", applied{"<nil>", "<nil>", v})
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

	awaitReport(t, b, "the report after the re-GET", "c-from-v2", "r-from-v3", v)
	if got := len(b.TwinGets()); got != gets+1 {
		t.Errorf("twin GETs = %d, want %d", got, gets+1)
	}
	for _, a := range st.history() {
		if a.corr == "patch-body" {
			t.Fatalf("gapped patch was merged instead of re-GET: %+v", st.history())
		}
	}
}

// After a dropped connection Start reconnects on its own, re-subscribes
// (CleanSession) and re-reads the twin, picking up a change it was not sent.
func TestTwin_DroppedConnectionReconnectsAndRereads(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	_, clk := startTwinClient(t, b, st)

	n := b.Connections()
	b.DropConnections()
	v := b.SetDesiredQuietly(map[string]any{"activeCookId": "c-offline"})
	advanceWhenPending(t, clk, testBackoff, "the reconnect backoff after the drop")
	await.Until(t, "a reconnect", func() bool { return b.Connections() > n }, func() any { return b.Connections() }, b)
	awaitState(t, st, "the re-read after the drop", applied{"c-offline", "<nil>", v})
	awaitReport(t, b, "the report after the drop", "c-offline", nil, v)

	subs := b.Subscriptions(2)
	for _, want := range []string{"$iothub/twin/res/#", "$iothub/twin/PATCH/properties/desired/#"} {
		if !slices.Contains(subs, want) {
			t.Errorf("connection 2 subscriptions %v missing %q", subs, want)
		}
	}
	if !slices.Contains(b.TwinGets(), 2) {
		t.Errorf("no twin GET on connection 2: %v", b.TwinGets())
	}
	// The new connection gets patches.
	v = b.SetDesired(map[string]any{"correlationId": "r-live"})
	awaitReport(t, b, "the patch on the new connection", "c-offline", "r-live", v)
}

// A failed report is logged and retried on the next connect.
func TestTwin_FailedReportRetriedOnNextConnect(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	_, clk := startTwinClient(t, b, st)
	before := len(b.ReportedPatches())

	b.FailNextReport(429)
	v := b.SetDesired(map[string]any{"activeCookId": "c1"})
	// The device applies before it reports, so once the hub has answered the
	// report with the injected 429 the state is final for this patch.
	await.Until(t, "the hub's 429 to the report", func() bool {
		return slices.ContainsFunc(b.Responses(), func(r iothubtest.Response) bool { return r.Status == 429 })
	}, func() any { return b.Responses() }, b)
	if got := st.get(); got != (applied{"c1", "<nil>", v}) {
		t.Fatalf("state after the failed report = %+v, want the patch applied", got)
	}
	if got := len(b.ReportedPatches()); got != before {
		t.Fatalf("a failed report was recorded: %d -> %d", before, got)
	}

	dropAndRedial(t, b, clk)
	awaitReport(t, b, "the report retried after the reconnect", "c1", nil, v)
}

// Telemetry and the twin share one connection.
func TestTwin_TelemetrySharesTheConnection(t *testing.T) {
	b := iothubtest.NewBroker(t)
	c, _ := startTwinClient(t, b, &memState{})
	if err := c.PublishTelemetry(await.Context(t), []byte(`{"x":1}`), map[string]string{MessageIDPropertyName: "m1"}); err != nil {
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

// An unresponsive hub: the GET's response timer fires (on the fake clock),
// and WaitTwinSynced, once its context is done, says why it never synced.
func TestWaitTwinSynced_TimesOutWithLastError(t *testing.T) {
	const twinTimeout = 100 * time.Millisecond
	b := iothubtest.NewBroker(t)
	b.SetUnresponsive(true)
	clk := clocktest.New(testClockStart)
	c, err := NewX509Client(testHub, testDeviceID, deviceCert(t, testDeviceID), WithBrokerURL(b.URL()),
		WithCookTwin(&memState{}), WithTwinTimeout(twinTimeout), WithClock(clk))
	if err != nil {
		t.Fatalf("NewX509Client: %v", err)
	}
	defer c.Close()
	var (
		events     await.Signal
		mu         sync.Mutex
		awaiting   bool
		failed     bool
		seenEvents []twinEvent
	)
	c.twin.observe = func(e twinEvent) {
		mu.Lock()
		seenEvents = append(seenEvents, e)
		awaiting = awaiting || e == twinAwaitingResponse
		failed = failed || e == twinFailed
		mu.Unlock()
		events.Notify()
	}
	seen := func() any { mu.Lock(); defer mu.Unlock(); return append([]twinEvent(nil), seenEvents...) }
	c.Start(t.Context())

	// The GET is out and only its response timer is running: fire it.
	await.Until(t, "the twin GET waiting for its response", func() bool { mu.Lock(); defer mu.Unlock(); return awaiting }, seen, &events)
	await.Until(t, "the hub to receive the GET", func() bool { return len(b.TwinGets()) == 1 },
		func() any { return b.TwinGets() }, b)
	clk.Advance(twinTimeout)
	await.Until(t, "the twin to record the failed GET", func() bool { mu.Lock(); defer mu.Unlock(); return failed }, seen, &events)

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = c.WaitTwinSynced(ctx)
	if err == nil {
		t.Fatal("WaitTwinSynced: want error from an unresponsive hub")
	}
	if want := "no response"; !strings.Contains(err.Error(), want) {
		t.Errorf("error %q should carry the last twin error (%q)", err, want)
	}
}

// blockedClient is a paho client whose Publish blocks until release closes,
// like paho's Publish on a connection that dropped between its connected
// check and the hand-off to its writer (it waits out WriteTimeout, 30s).
type blockedClient struct {
	mqtt.Client
	release chan struct{}
}

func (c blockedClient) Publish(string, byte, bool, interface{}) mqtt.Token {
	<-c.release
	return nil
}

// A twin request stuck in paho's Publish gives up as soon as its connection
// is lost, so the worker can move on to the next connection instead of
// waiting out paho's timeout.
func TestTwin_LostConnectionReleasesARequestBlockedInPublish(t *testing.T) {
	tw := newTwin(&memState{}, time.Minute, clocktest.New(testClockStart))
	release := make(chan struct{})
	defer close(release)
	lost := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := tw.request(t.Context(), twinConn{client: blockedClient{release: release}, lost: lost}, twinGetTopicPrefix, nil)
		done <- err
	}()
	close(lost)
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "connection lost") {
			t.Fatalf("request error = %v, want connection lost", err)
		}
	case <-await.Context(t).Done(): // hang guard: the test binary's deadline
		t.Fatal("the request stayed blocked in Publish after its connection was lost")
	}
}

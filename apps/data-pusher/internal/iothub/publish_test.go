package iothub

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
)

// stalls records each telemetry Publish a stallingClient holds in paho, by
// the number of the connection it was made on (1 = the first connect). It is
// an await.Source: it signals each stall.
type stalls struct {
	await.Signal
	mu    sync.Mutex
	conns []int
}

func (s *stalls) add(conn int) {
	s.mu.Lock()
	s.conns = append(s.conns, conn)
	s.mu.Unlock()
	s.Notify()
}

func (s *stalls) get() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.conns...)
}

func (s *stalls) await(t *testing.T, conn int) {
	t.Helper()
	await.Until(t, fmt.Sprintf("a telemetry publish stalled in paho on connection %d", conn),
		func() bool { return slices.Contains(s.get(), conn) }, func() any { return s.get() }, s)
}

// stallingClient is the paho client of one connection. Its telemetry Publish
// (twin requests pass straight through) blocks until release closes, like
// paho's Publish on a connection that dropped between its connected check and
// the hand-off to its writer, where it waits out WriteTimeout (30s). Once
// released it makes the real call.
type stallingClient struct {
	mqtt.Client
	conn    int
	release <-chan struct{}
	stalls  *stalls
}

func (c stallingClient) Publish(topic string, qos byte, retained bool, payload interface{}) mqtt.Token {
	if strings.HasPrefix(topic, deviceEventTopicPrefix) {
		c.stalls.add(c.conn)
		<-c.release
	}
	return c.Client.Publish(topic, qos, retained, payload)
}

// stallTelemetryOn returns a withMQTTClient option whose clients stall
// telemetry publishes on the given connections until release closes.
func stallTelemetryOn(release <-chan struct{}, s *stalls, conns ...int) Option {
	return withMQTTClient(stallingFactory(release, s, conns...))
}

// stallingFactory is stallTelemetryOn's paho client factory.
func stallingFactory(release <-chan struct{}, s *stalls, conns ...int) func(*mqtt.ClientOptions) mqtt.Client {
	var n int // ensureConnectedLocked calls the factory under c.mu
	return func(o *mqtt.ClientOptions) mqtt.Client {
		n++
		real := mqtt.NewClient(o)
		if !slices.Contains(conns, n) {
			return real
		}
		return stallingClient{Client: real, conn: n, release: release, stalls: s}
	}
}

// staleClient is a paho client that reports its connection closed once stale
// is set, while the connection is in fact still up and its lost signal has not
// fired: the next connect replaces it, under c.mu, as a dropped one would be.
type staleClient struct {
	mqtt.Client
	stale *atomic.Bool
}

func (c staleClient) IsConnectionOpen() bool {
	return !c.stale.Load() && c.Client.IsConnectionOpen()
}

// awaitPublished waits for a PublishTelemetry running on its own goroutine to
// return, up to the hang guard.
func awaitPublished(t *testing.T, published <-chan error, what string) error {
	t.Helper()
	select {
	case err := <-published:
		return err
	case <-await.Context(t).Done(): // hang guard: the test binary's deadline
		t.Fatalf("%s: PublishTelemetry never returned", what)
		return nil
	}
}

// awaitTelemetry waits until the hub has accepted exactly one telemetry
// message and returns the connection it came in on.
func awaitTelemetry(t *testing.T, b *iothubtest.Broker) int {
	t.Helper()
	await.Until(t, "the telemetry message at the hub", func() bool { return len(b.Telemetry()) > 0 },
		func() any { return b.Telemetry() }, b)
	tel := b.Telemetry()
	if len(tel) != 1 {
		t.Fatalf("telemetry = %+v, want one message", tel)
	}
	return tel[0].Conn
}

// awaitOldConnectionClosed waits until the device holds no connection older
// than its newest open (MaxConcurrentConnections counts only those it still
// holds). paho's Disconnect(250) returns after its quiesce even when its
// writer has not yet sent the DISCONNECT and closed the socket, so a loaded
// machine can see the old connection still open just after the publish
// returns; it must close, and the broker signals when it does.
func awaitOldConnectionClosed(t *testing.T, b *iothubtest.Broker) {
	t.Helper()
	await.Until(t, "the replaced connection to close", func() bool { return b.MaxConcurrentConnections() == 1 },
		func() any { return b.MaxConcurrentConnections() }, b)
}

// HAR-114: a PublishTelemetry blocked inside paho's Publish must not hold up
// the reconnect. The connection drops while the publish is stuck in paho's
// hand-off; supervise redials and the twin re-reads on the new connection
// while paho still holds the publish (its retry, on the new connection, is
// stuck there too until the test releases it).
func TestPublishTelemetry_BlockedInPublishDoesNotHoldUpReconnectOrTwin(t *testing.T) {
	b := iothubtest.NewBroker(t)
	st := &memState{}
	release := make(chan struct{})
	releaseAll := sync.OnceFunc(func() { close(release) })
	defer releaseAll() // before the client's Close (a t.Cleanup)
	var stalled stalls
	c, clk := startTwinClient(t, b, st, stallTelemetryOn(release, &stalled, 1, 2))

	published := make(chan error, 1)
	go func() {
		published <- c.PublishTelemetry(t.Context(), []byte(`{"x":1}`), map[string]string{MessageIDPropertyName: "m1"})
	}()
	stalled.await(t, 1)

	v := b.SetDesiredQuietly(map[string]any{"activeCookId": "c-after-drop"})
	b.DropConnections()
	// Before the fix the publish held c.mu inside paho, so supervise waited
	// behind it here for paho's WriteTimeout and nothing redialled.
	advanceWhenPending(t, clk, testBackoff, "the reconnect backoff after the drop")
	await.Until(t, "a reconnect", func() bool { return b.Connections() >= 2 },
		func() any { return b.Connections() }, b)
	awaitState(t, st, "the twin re-read on the new connection", applied{"c-after-drop", "<nil>", v})
	if !slices.Contains(b.TwinGets(), 2) {
		t.Fatalf("no twin GET on connection 2: %v", b.TwinGets())
	}
	// The publish's retry is in paho on the new connection, and its first
	// attempt is still in paho on the old one: nothing has been released.
	stalled.await(t, 2)
	select {
	case err := <-published:
		t.Fatalf("PublishTelemetry returned (%v) while paho still held it", err)
	default:
	}

	releaseAll()
	if err := awaitPublished(t, published, "after the release"); err != nil {
		t.Fatalf("PublishTelemetry: %v", err)
	}
	if conn := awaitTelemetry(t, b); conn != 2 {
		t.Errorf("telemetry came in on connection %d, want 2", conn)
	}
	awaitOldConnectionClosed(t, b)
}

// HAR-114: the retry of a publish whose connection has already been replaced
// goes out on the new connection and leaves it up. A second publish replaces
// connection 1 (it reports itself closed) under c.mu while the first is stuck
// in paho on it; dropping "the current connection" before the first one's
// retry would close connection 2.
func TestPublishTelemetry_RetryDoesNotDropTheReplacementConnection(t *testing.T) {
	b := iothubtest.NewBroker(t)
	release := make(chan struct{})
	defer close(release)
	var stalled stalls
	var stale atomic.Bool
	newClient := stallingFactory(release, &stalled, 1)
	first := true // ensureConnectedLocked calls the factory under c.mu
	c, _ := startTwinClient(t, b, &memState{}, withMQTTClient(func(o *mqtt.ClientOptions) mqtt.Client {
		cl := newClient(o)
		if first {
			first = false
			return staleClient{Client: cl, stale: &stale}
		}
		return cl
	}))

	published := make(chan error, 1)
	go func() {
		published <- c.PublishTelemetry(t.Context(), []byte(`{"x":1}`), map[string]string{MessageIDPropertyName: "m1"})
	}()
	stalled.await(t, 1)

	// The second publish drops connection 1 and dials connection 2 under
	// c.mu; the first wakes on connection 1's lost signal and retries after
	// that.
	stale.Store(true)
	if err := c.PublishTelemetry(await.Context(t), []byte(`{"x":2}`), map[string]string{MessageIDPropertyName: "m2"}); err != nil {
		t.Fatalf("second PublishTelemetry: %v", err)
	}
	if err := awaitPublished(t, published, "after the replacement"); err != nil {
		t.Fatalf("PublishTelemetry: %v", err)
	}
	await.Until(t, "both messages at the hub", func() bool { return len(b.Telemetry()) == 2 },
		func() any { return b.Telemetry() }, b)
	for _, tel := range b.Telemetry() {
		if tel.Conn != 2 {
			t.Errorf("message %s came in on connection %d, want 2", tel.Properties.Get(MessageIDPropertyName), tel.Conn)
		}
	}
	if n := b.Connections(); n != 2 {
		t.Errorf("connections = %d, want 2 (the retry must not drop the replacement)", n)
	}
	awaitOldConnectionClosed(t, b)
}

// HAR-114: PublishTelemetryAsync's hand-off to paho runs outside c.mu too. A
// hand-off stuck in paho when the connection drops fails as connection lost,
// and supervise redials without waiting for paho.
func TestPublishTelemetryAsync_HandOffBlockedInPublishFailsOnLostConnection(t *testing.T) {
	b := iothubtest.NewBroker(t)
	release := make(chan struct{})
	defer close(release)
	var stalled stalls
	c, clk := startTwinClient(t, b, &memState{}, stallTelemetryOn(release, &stalled, 1))

	started := make(chan error, 1)
	go func() {
		_, err := c.PublishTelemetryAsync(t.Context(), []byte(`{"x":1}`), map[string]string{MessageIDPropertyName: "m1"})
		started <- err
	}()
	stalled.await(t, 1)

	b.DropConnections()
	select {
	case err := <-started:
		if err == nil || !strings.Contains(err.Error(), "connection lost") {
			t.Fatalf("PublishTelemetryAsync error = %v, want connection lost", err)
		}
	case <-await.Context(t).Done(): // hang guard: the test binary's deadline
		t.Fatal("PublishTelemetryAsync stayed blocked in paho after its connection was lost")
	}
	advanceWhenPending(t, clk, testBackoff, "the reconnect backoff after the drop")
	await.Until(t, "a reconnect", func() bool { return b.Connections() >= 2 },
		func() any { return b.Connections() }, b)

	wait, err := c.PublishTelemetryAsync(await.Context(t), []byte(`{"x":2}`), map[string]string{MessageIDPropertyName: "m2"})
	if err != nil {
		t.Fatalf("PublishTelemetryAsync on the new connection: %v", err)
	}
	if err := wait(); err != nil {
		t.Fatalf("PUBACK on the new connection: %v", err)
	}
	if conn := awaitTelemetry(t, b); conn != 2 {
		t.Errorf("telemetry came in on connection %d, want 2", conn)
	}
}

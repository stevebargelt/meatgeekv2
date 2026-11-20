// Package iothubtest is a fake Azure IoT Hub MQTT endpoint for tests: a real
// MQTT 3.1.1 broker on localhost (no TLS) that speaks the slice of IoT Hub's
// device protocol the data-pusher uses: device-to-cloud telemetry and the
// device twin (GET, desired-property patches, reported-property patches).
// Point an iothub.AzureClient at it with iothub.WithBrokerURL(b.URL()).
//
// Like the real hub, it only sends twin responses and desired patches to a
// connection that has subscribed to their topics, and a desired change made
// while no device is connected is delivered to nobody: the device has to GET.
package iothubtest

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/eclipse/paho.mqtt.golang/packets"
)

// Message is one PUBLISH the broker received from a device.
type Message struct {
	Conn    int // 1-based connection number
	Topic   string
	Payload []byte
}

// Telemetry is a device-to-cloud message with its topic property bag parsed.
type Telemetry struct {
	Message
	DeviceID   string
	Properties url.Values
}

// Broker is the fake hub. All methods are safe for concurrent use.
type Broker struct {
	ln net.Listener

	mu              sync.Mutex
	conns           []*conn // every connection ever accepted, in order
	maxLive         int
	overlapChecks   []chan struct{} // one per CONNECT; closed once maxLive is updated
	received        []Message
	desired         map[string]any
	desiredVersion  int64
	reported        map[string]any
	reportedVersion int64
	twinGets        []int // connection number of each twin GET
	reportedPatches []map[string]any
	unresponsive    bool
	nextReportFail  int
}

type conn struct {
	n     int
	nc    net.Conn
	wmu   sync.Mutex
	subs  []string      // guarded by Broker.mu
	alive bool          // guarded by Broker.mu
	done  chan struct{} // closed once serve has finished with the socket
}

// overlapGrace is how long an older connection may stay open after a newer
// one sends CONNECT before the two count as concurrent. A client that closes
// its socket before dialing (as AzureClient does) has its FIN delivered
// ahead of the new SYN, so the old connection's reader sees EOF within
// milliseconds; this only absorbs scheduling delay in the broker's own
// goroutines. A client that really holds two connections keeps the old one
// open past any grace and is counted.
const overlapGrace = 2 * time.Second

// NewBroker starts a broker on 127.0.0.1 with an empty twin at desired
// $version 1 (a new device's twin). It stops when the test ends.
func NewBroker(t testing.TB) *Broker {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("iothubtest: listen: %v", err)
	}
	b := &Broker{
		ln:              ln,
		desired:         map[string]any{},
		desiredVersion:  1,
		reported:        map[string]any{},
		reportedVersion: 1,
	}
	go b.accept()
	t.Cleanup(b.Close)
	return b
}

// URL is the broker address for iothub.WithBrokerURL.
func (b *Broker) URL() string { return "tcp://" + b.ln.Addr().String() }

// Close stops the listener and drops every connection.
func (b *Broker) Close() {
	_ = b.ln.Close()
	b.DropConnections()
}

// SetDesired merges props into the desired section (a nil value removes the
// property), bumps desired $version, and sends the change as a desired patch
// to every connected device subscribed to patches. It returns the new version.
func (b *Broker) SetDesired(props map[string]any) int64 {
	b.mu.Lock()
	for k, v := range props {
		if v == nil {
			delete(b.desired, k)
		} else {
			b.desired[k] = v
		}
	}
	b.desiredVersion++
	v := b.desiredVersion
	b.mu.Unlock()
	b.SendDesiredPatch(v, props)
	return v
}

// SetDesiredQuietly changes the desired section like SetDesired but sends no
// patch, as if the device missed it. It returns the new version.
func (b *Broker) SetDesiredQuietly(props map[string]any) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, v := range props {
		if v == nil {
			delete(b.desired, k)
		} else {
			b.desired[k] = v
		}
	}
	b.desiredVersion++
	return b.desiredVersion
}

// SendDesiredPatch sends a desired patch with the given $version and body to
// subscribed devices without touching the stored twin.
func (b *Broker) SendDesiredPatch(version int64, props map[string]any) {
	body := map[string]any{"$version": version}
	for k, v := range props {
		body[k] = v
	}
	payload, _ := json.Marshal(body)
	topic := fmt.Sprintf("$iothub/twin/PATCH/properties/desired/?$version=%d", version)
	for _, c := range b.liveConns() {
		b.mu.Lock()
		ok := c.subscribedLocked(topic)
		b.mu.Unlock()
		if ok {
			c.publish(topic, payload)
		}
	}
}

// SetUnresponsive makes the broker ignore twin requests (no response at all).
func (b *Broker) SetUnresponsive(on bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.unresponsive = on
}

// FailNextReport makes the next reported-properties patch fail with status.
func (b *Broker) FailNextReport(status int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextReportFail = status
}

// DropConnections closes every live connection without an MQTT DISCONNECT,
// like a network failure.
func (b *Broker) DropConnections() {
	for _, c := range b.liveConns() {
		_ = c.nc.Close()
	}
}

// DesiredVersion is the stored desired $version.
func (b *Broker) DesiredVersion() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.desiredVersion
}

// Reported is a copy of the stored reported section (without $version).
func (b *Broker) Reported() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]any, len(b.reported))
	for k, v := range b.reported {
		out[k] = v
	}
	return out
}

// ReportedPatches is every reported-properties patch body the broker
// accepted, in order.
func (b *Broker) ReportedPatches() []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]map[string]any(nil), b.reportedPatches...)
}

// TwinGets is the connection number of each twin GET received, in order.
func (b *Broker) TwinGets() []int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]int(nil), b.twinGets...)
}

// Connections is how many MQTT connections have been accepted so far.
func (b *Broker) Connections() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.conns)
}

// MaxConcurrentConnections is the most connections ever open at once, as
// seen when each connection sends CONNECT: the new connection plus every
// older one still open overlapGrace later. IoT Hub allows one per device, so
// this must stay 1. It waits for the checks of CONNECTs already received, so
// the answer does not depend on goroutine scheduling.
func (b *Broker) MaxConcurrentConnections() int {
	b.mu.Lock()
	checks := append([]chan struct{}(nil), b.overlapChecks...)
	b.mu.Unlock()
	for _, ch := range checks {
		<-ch
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.maxLive
}

// Subscriptions returns the topic filters connection n (1-based) subscribed to.
func (b *Broker) Subscriptions(n int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n < 1 || n > len(b.conns) {
		return nil
	}
	return append([]string(nil), b.conns[n-1].subs...)
}

// Received is every PUBLISH from devices, in order.
func (b *Broker) Received() []Message {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Message(nil), b.received...)
}

// Telemetry is every device-to-cloud message, with its properties parsed.
func (b *Broker) Telemetry() []Telemetry {
	var out []Telemetry
	for _, m := range b.Received() {
		if !strings.HasPrefix(m.Topic, "devices/") {
			continue
		}
		rest := strings.TrimPrefix(m.Topic, "devices/")
		device, bag, ok := strings.Cut(rest, "/messages/events/")
		if !ok {
			continue
		}
		props, _ := url.ParseQuery(bag)
		out = append(out, Telemetry{Message: m, DeviceID: device, Properties: props})
	}
	return out
}

// Eventually polls cond until it is true or timeout passes, then fails the
// test with msg.
func Eventually(t testing.TB, timeout time.Duration, cond func() bool, msg string, args ...any) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s: "+msg, append([]any{timeout}, args...)...)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (b *Broker) liveConns() []*conn {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []*conn
	for _, c := range b.conns {
		if c.alive {
			out = append(out, c)
		}
	}
	return out
}

func (b *Broker) accept() {
	for {
		nc, err := b.ln.Accept()
		if err != nil {
			return
		}
		b.mu.Lock()
		c := &conn{n: len(b.conns) + 1, nc: nc, alive: true, done: make(chan struct{})}
		b.conns = append(b.conns, c)
		b.mu.Unlock()
		go b.serve(c)
	}
}

func (b *Broker) serve(c *conn) {
	defer func() {
		_ = c.nc.Close()
		b.mu.Lock()
		c.alive = false
		b.mu.Unlock()
		close(c.done)
	}()
	for {
		pkt, err := packets.ReadPacket(c.nc)
		if err != nil {
			return
		}
		switch p := pkt.(type) {
		case *packets.ConnectPacket:
			b.checkOverlap(c)
			ack := packets.NewControlPacket(packets.Connack).(*packets.ConnackPacket)
			ack.ReturnCode = packets.Accepted
			c.write(ack)
		case *packets.SubscribePacket:
			b.mu.Lock()
			c.subs = append(c.subs, p.Topics...)
			b.mu.Unlock()
			ack := packets.NewControlPacket(packets.Suback).(*packets.SubackPacket)
			ack.MessageID = p.MessageID
			for _, q := range p.Qoss {
				ack.ReturnCodes = append(ack.ReturnCodes, min(q, 1))
			}
			c.write(ack)
		case *packets.PublishPacket:
			if p.Qos == 1 {
				ack := packets.NewControlPacket(packets.Puback).(*packets.PubackPacket)
				ack.MessageID = p.MessageID
				c.write(ack)
			}
			b.onPublish(c, p.TopicName, p.Payload)
		case *packets.PingreqPacket:
			c.write(packets.NewControlPacket(packets.Pingresp))
		case *packets.DisconnectPacket:
			return
		}
	}
}

// checkOverlap records, in the background, how many connections are open
// alongside c: c itself plus each older connection that is still open
// overlapGrace after c's CONNECT.
func (b *Broker) checkOverlap(c *conn) {
	checked := make(chan struct{})
	b.mu.Lock()
	var older []*conn
	for _, o := range b.conns {
		if o != c && o.alive {
			older = append(older, o)
		}
	}
	b.overlapChecks = append(b.overlapChecks, checked)
	b.mu.Unlock()
	go func() {
		defer close(checked)
		graceOver := make(chan struct{})
		timer := time.AfterFunc(overlapGrace, func() { close(graceOver) })
		defer timer.Stop()
		open := 1
		for _, o := range older {
			select {
			case <-o.done:
			case <-graceOver:
				select {
				case <-o.done:
				default:
					open++
				}
			}
		}
		b.mu.Lock()
		b.maxLive = max(b.maxLive, open)
		b.mu.Unlock()
	}()
}

func (b *Broker) onPublish(c *conn, topic string, payload []byte) {
	b.mu.Lock()
	b.received = append(b.received, Message{Conn: c.n, Topic: topic, Payload: append([]byte(nil), payload...)})
	unresponsive := b.unresponsive
	b.mu.Unlock()

	switch {
	case strings.HasPrefix(topic, "$iothub/twin/GET/"):
		b.mu.Lock()
		b.twinGets = append(b.twinGets, c.n)
		b.mu.Unlock()
		if unresponsive {
			return
		}
		c.respond(b, topic, 200, b.twinDocument(), 0)
	case strings.HasPrefix(topic, "$iothub/twin/PATCH/properties/reported/"):
		if unresponsive {
			return
		}
		b.mu.Lock()
		fail := b.nextReportFail
		b.nextReportFail = 0
		b.mu.Unlock()
		if fail != 0 {
			c.respond(b, topic, fail, []byte(`{"message":"injected failure"}`), 0)
			return
		}
		var patch map[string]any
		if err := json.Unmarshal(payload, &patch); err != nil {
			c.respond(b, topic, 400, []byte(`{"message":"bad json"}`), 0)
			return
		}
		b.mu.Lock()
		for k, v := range patch {
			if v == nil {
				delete(b.reported, k)
			} else {
				b.reported[k] = v
			}
		}
		b.reportedVersion++
		v := b.reportedVersion
		b.reportedPatches = append(b.reportedPatches, patch)
		b.mu.Unlock()
		c.respond(b, topic, 204, nil, v)
	}
}

func (b *Broker) twinDocument() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	desired := map[string]any{"$version": b.desiredVersion}
	for k, v := range b.desired {
		desired[k] = v
	}
	reported := map[string]any{"$version": b.reportedVersion}
	for k, v := range b.reported {
		reported[k] = v
	}
	out, _ := json.Marshal(map[string]any{"desired": desired, "reported": reported})
	return out
}

// respond answers a twin request on $iothub/twin/res/<status>/?$rid=<rid>.
func (c *conn) respond(b *Broker, reqTopic string, status int, body []byte, version int64) {
	_, query, _ := strings.Cut(reqTopic, "?")
	q, _ := url.ParseQuery(query)
	topic := "$iothub/twin/res/" + strconv.Itoa(status) + "/?$rid=" + q.Get("$rid")
	if version != 0 {
		topic += "&$version=" + strconv.FormatInt(version, 10)
	}
	b.mu.Lock()
	ok := c.subscribedLocked(topic)
	b.mu.Unlock()
	if ok {
		c.publish(topic, body)
	}
}

func (c *conn) subscribedLocked(topic string) bool {
	for _, f := range c.subs {
		if prefix, ok := strings.CutSuffix(f, "#"); ok && strings.HasPrefix(topic, prefix) {
			return true
		}
		if f == topic {
			return true
		}
	}
	return false
}

func (c *conn) publish(topic string, payload []byte) {
	p := packets.NewControlPacket(packets.Publish).(*packets.PublishPacket)
	p.TopicName = topic
	p.Payload = payload
	c.write(p)
}

func (c *conn) write(p packets.ControlPacket) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.nc.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = p.Write(c.nc)
}

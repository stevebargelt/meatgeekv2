// Package iothubtest is a fake Azure IoT Hub MQTT endpoint for tests: a real
// MQTT 3.1.1 broker on localhost (no TLS) that speaks the slice of IoT Hub's
// device protocol the data-pusher uses: device-to-cloud telemetry and the
// device twin (GET, desired-property patches, reported-property patches).
// Point an iothub.AzureClient at it with iothub.WithBrokerURL(b.URL()).
//
// Like the real hub, it only sends twin responses and desired patches to a
// connection that has subscribed to their topics, and a desired change made
// while no device is connected is delivered to nobody: the device has to GET.
//
// The broker is an await.Source: it signals after every change a test can
// observe (a connection accepted or closed, a packet handled, a twin response
// sent, the stored twin edited), so tests wait with await.Until on its state
// instead of polling against a deadline.
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

	"github.com/eclipse/paho.mqtt.golang/packets"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
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

// Connect is one MQTT CONNECT the broker received.
type Connect struct {
	Conn        int // 1-based connection number
	ClientID    string
	Username    string
	HasPassword bool // the CONNECT carried a password (an X.509 device must not)
	ReturnCode  byte // the CONNACK return code sent (0 accepted)
}

// Response is one twin response the broker sent.
type Response struct {
	Conn    int    // 1-based connection number
	Request string // the request topic it answers
	Status  int
}

// Broker is the fake hub. All methods are safe for concurrent use.
type Broker struct {
	ln  net.Listener
	sig await.Signal

	mu              sync.Mutex
	conns           []*conn   // every connection ever accepted, in order
	overlaps        [][]*conn // per CONNECT: the older connections open then
	received        []Message
	responses       []Response
	desired         map[string]any
	desiredVersion  int64
	reported        map[string]any
	reportedVersion int64
	twinGets        []int // connection number of each twin GET
	reportedPatches []map[string]any
	unresponsive    bool
	nextReportFail  int
	connects        []Connect
	refuseNext      []byte
	onReport        func(patch map[string]any)
}

type conn struct {
	n     int
	nc    net.Conn
	wmu   sync.Mutex
	subs  []string      // guarded by Broker.mu
	alive bool          // guarded by Broker.mu
	done  chan struct{} // closed once serve has finished with the socket
}

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

// Changed implements await.Source: the channel closes at the broker's next
// change.
func (b *Broker) Changed() <-chan struct{} { return b.sig.Changed() }

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
	b.sig.Notify()
	b.SendDesiredPatch(v, props)
	return v
}

// SetDesiredQuietly changes the desired section like SetDesired but sends no
// patch, as if the device missed it. It returns the new version.
func (b *Broker) SetDesiredQuietly(props map[string]any) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	defer b.sig.Notify()
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

// OnReport makes the broker call f with each reported-properties patch it
// accepts, before it stores the patch or answers the device: f sees the
// device's state at the moment the patch arrived.
func (b *Broker) OnReport(f func(patch map[string]any)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onReport = f
}

// RefuseNextConnect makes the broker answer the next CONNECT with return
// code rc (4 bad user name or password, 5 not authorised, as IoT Hub does for
// a device it does not accept) and close that connection. Calls queue: each
// refuses one more CONNECT.
func (b *Broker) RefuseNextConnect(rc byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refuseNext = append(b.refuseNext, rc)
}

// Connects is every CONNECT received, in order.
func (b *Broker) Connects() []Connect {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Connect(nil), b.connects...)
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

// MaxConcurrentConnections is the most connections the device has held open
// at once that the broker can prove without a clock: for each CONNECT, the new
// connection plus every older connection that was open then and that the
// client still has open now. A connection open now was open the whole time
// since it was accepted, so the two really overlapped. A connection the
// client has closed counts as closed even if the broker's reader has not got
// to the close yet: the check asks the kernel (see peerOpen), so the answer
// does not depend on goroutine scheduling. IoT Hub allows one connection per
// device, so this must stay 1.
func (b *Broker) MaxConcurrentConnections() int {
	b.mu.Lock()
	overlaps := make([][]*conn, len(b.overlaps))
	copy(overlaps, b.overlaps)
	b.mu.Unlock()
	most := 0
	for _, older := range overlaps {
		open := 1
		for _, o := range older {
			if o.clientHasOpen() {
				open++
			}
		}
		most = max(most, open)
	}
	return most
}

// Responses is every twin response the broker sent, in order.
func (b *Broker) Responses() []Response {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Response(nil), b.responses...)
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
		b.sig.Notify()
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
		b.sig.Notify()
	}()
	for {
		pkt, err := packets.ReadPacket(c.nc)
		if err != nil {
			return
		}
		b.handle(c, pkt)
		b.sig.Notify()
		if _, ok := pkt.(*packets.DisconnectPacket); ok {
			return
		}
	}
}

// handle acts on one packet from connection c.
func (b *Broker) handle(c *conn, pkt packets.ControlPacket) {
	switch p := pkt.(type) {
	case *packets.ConnectPacket:
		b.recordOverlap(c)
		ack := packets.NewControlPacket(packets.Connack).(*packets.ConnackPacket)
		ack.ReturnCode = packets.Accepted
		b.mu.Lock()
		if len(b.refuseNext) > 0 {
			ack.ReturnCode = b.refuseNext[0]
			b.refuseNext = b.refuseNext[1:]
		}
		b.connects = append(b.connects, Connect{
			Conn:        c.n,
			ClientID:    p.ClientIdentifier,
			Username:    p.Username,
			HasPassword: p.PasswordFlag || len(p.Password) > 0,
			ReturnCode:  ack.ReturnCode,
		})
		b.mu.Unlock()
		c.write(ack)
		if ack.ReturnCode != packets.Accepted {
			// Like IoT Hub, close the connection after a refusal; serve's
			// next read fails and ends it.
			_ = c.nc.Close()
		}
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
		// Record (and answer) the message before the PUBACK, so a
		// device whose publish has returned finds it in Received.
		b.onPublish(c, p.TopicName, p.Payload)
		if p.Qos == 1 {
			ack := packets.NewControlPacket(packets.Puback).(*packets.PubackPacket)
			ack.MessageID = p.MessageID
			c.write(ack)
		}
	case *packets.PingreqPacket:
		c.write(packets.NewControlPacket(packets.Pingresp))
	}
}

// recordOverlap notes, at c's CONNECT, every older connection the broker
// still has open. MaxConcurrentConnections later keeps those the client has
// not closed.
func (b *Broker) recordOverlap(c *conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var older []*conn
	for _, o := range b.conns {
		if o != c && o.alive {
			older = append(older, o)
		}
	}
	b.overlaps = append(b.overlaps, older)
}

// clientHasOpen reports whether the device still holds c open: the broker
// has not finished with it and the kernel holds neither the device's close
// nor its DISCONNECT for it.
func (c *conn) clientHasOpen() bool {
	select {
	case <-c.done:
		return false
	default:
	}
	return peerOpen(c.nc)
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
		onReport := b.onReport
		b.mu.Unlock()
		if onReport != nil {
			onReport(patch)
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
	if !ok {
		return
	}
	c.publish(topic, body)
	b.mu.Lock()
	b.responses = append(b.responses, Response{Conn: c.n, Request: reqTopic, Status: status})
	b.mu.Unlock()
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
	_ = p.Write(c.nc)
}

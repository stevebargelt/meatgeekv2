package iothubtest

import (
	"net"
	"testing"

	"github.com/eclipse/paho.mqtt.golang/packets"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
)

// dialConnect opens a raw MQTT connection to b and waits for its CONNACK.
func dialConnect(t *testing.T, b *Broker) net.Conn {
	t.Helper()
	nc, err := net.Dial("tcp", b.ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = nc.Close() })
	cp := packets.NewControlPacket(packets.Connect).(*packets.ConnectPacket)
	cp.ProtocolName, cp.ProtocolVersion, cp.ClientIdentifier = "MQTT", 4, "dev"
	if err := cp.Write(nc); err != nil {
		t.Fatalf("write CONNECT: %v", err)
	}
	if at, ok := await.Guard(t); ok {
		_ = nc.SetReadDeadline(at) // hang guard only: the CONNACK is written at once
	}
	if _, err := packets.ReadPacket(nc); err != nil {
		t.Fatalf("read CONNACK: %v", err)
	}
	return nc
}

// A client that keeps its first connection open while it opens a second is
// counted as two concurrent connections.
func TestMaxConcurrentConnections_CountsRealOverlap(t *testing.T) {
	b := NewBroker(t)
	dialConnect(t, b)
	dialConnect(t, b)
	if m := b.MaxConcurrentConnections(); m != 2 {
		t.Fatalf("max concurrent connections = %d, want 2", m)
	}
}

// A client that closes its connection and redials at once is one connection
// at a time, however late the broker's reader notices the close.
func TestMaxConcurrentConnections_CloseThenRedialIsOne(t *testing.T) {
	b := NewBroker(t)
	for range 20 {
		_ = dialConnect(t, b).Close()
	}
	dialConnect(t, b)
	if m := b.MaxConcurrentConnections(); m != 1 {
		t.Fatalf("max concurrent connections = %d, want 1", m)
	}
}

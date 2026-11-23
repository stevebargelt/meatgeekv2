package iothub

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/identity"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
)

func deviceCert(t *testing.T, deviceID string) tls.Certificate {
	t.Helper()
	_, cert, err := identity.Ensure(t.TempDir(), deviceID, clocktest.New(time.Unix(1_700_000_000, 0)))
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

// optionsLog records the CONNECT options of every connection the client makes.
type optionsLog struct {
	mu   sync.Mutex
	opts []*mqtt.ClientOptions
}

func (l *optionsLog) option() Option {
	return withMQTTClient(func(o *mqtt.ClientOptions) mqtt.Client {
		l.mu.Lock()
		l.opts = append(l.opts, o)
		l.mu.Unlock()
		return mqtt.NewClient(o)
	})
}

func (l *optionsLog) get() []*mqtt.ClientOptions {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]*mqtt.ClientOptions(nil), l.opts...)
}

func TestX509Client_OptionsHaveNoPasswordAndCarryTheCertificate(t *testing.T) {
	broker := iothubtest.NewBroker(t)
	cert := deviceCert(t, "dev-1")
	var log optionsLog
	c, err := NewX509Client("meatgeek-dev.azure-devices.net", "dev-1", cert,
		WithBrokerURL(broker.URL()), WithClock(clocktest.New(time.Unix(1_700_000_000, 0))), log.option())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	if err := c.PublishTelemetry(context.Background(), []byte(`{}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}
	got := log.get()
	if len(got) != 1 {
		t.Fatalf("%d connections, want 1", len(got))
	}
	o := got[0]
	if want := "meatgeek-dev.azure-devices.net/dev-1/?api-version=" + mqttAPIVersion; o.Username != want {
		t.Errorf("username = %q, want %q", o.Username, want)
	}
	if o.Password != "" || o.CredentialsProvider != nil {
		t.Errorf("X.509 CONNECT carries a password (%q) or a credentials provider", o.Password)
	}
	if o.ClientID != "dev-1" {
		t.Errorf("client id = %q", o.ClientID)
	}
	if o.TLSConfig == nil || len(o.TLSConfig.Certificates) != 1 || !bytes.Equal(o.TLSConfig.Certificates[0].Certificate[0], cert.Certificate[0]) {
		t.Fatal("TLS config does not carry the device certificate")
	}
	if o.TLSConfig.ServerName != "meatgeek-dev.azure-devices.net" || o.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Errorf("TLS ServerName %q / MinVersion %x, want the hub and TLS 1.2", o.TLSConfig.ServerName, o.TLSConfig.MinVersion)
	}
	connects := broker.Connects()
	if len(connects) != 1 || connects[0].HasPassword || connects[0].Username != o.Username {
		t.Errorf("broker saw %+v, want one CONNECT with the X.509 username and no password", connects)
	}
}

// An X.509 connection has no token to expire: hours later the client still
// counts the same connection as good and does not redial.
func TestX509Client_NoTokenRefresh(t *testing.T) {
	broker := iothubtest.NewBroker(t)
	clk := clocktest.New(time.Unix(1_700_000_000, 0))
	c, err := NewX509Client("hub.azure-devices.net", "dev-1", deviceCert(t, "dev-1"), WithBrokerURL(broker.URL()), WithClock(clk))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensureConnectedLocked(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	clk.Advance(2 * time.Hour)
	if err := c.ensureConnectedLocked(); err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if n := len(broker.Connects()); n != 1 {
		t.Errorf("%d CONNECTs, want 1: the client redialled though nothing expired", n)
	}
}

// recordingResolver hands out hubs in order and records each call's refresh.
type recordingResolver struct {
	mu    sync.Mutex
	hubs  []string
	calls []bool
	sig   await.Signal
}

func (r *recordingResolver) resolve(_ context.Context, refresh bool) (string, error) {
	r.mu.Lock()
	defer r.sig.Notify()
	defer r.mu.Unlock()
	r.calls = append(r.calls, refresh)
	if len(r.hubs) == 0 {
		return "", errors.New("refused by the test")
	}
	return r.hubs[min(len(r.calls), len(r.hubs))-1], nil
}

func (r *recordingResolver) get() []bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]bool(nil), r.calls...)
}

func (r *recordingResolver) Changed() <-chan struct{} { return r.sig.Changed() }

func TestX509Client_NotAuthorisedResolvesOnceThenReconnects(t *testing.T) {
	for _, rc := range []byte{4, 5} {
		t.Run(fmt.Sprint(rc), func(t *testing.T) {
			broker := iothubtest.NewBroker(t)
			broker.RefuseNextConnect(rc)
			clk := clocktest.New(time.Unix(1_700_000_000, 0))
			res := &recordingResolver{hubs: []string{"hub-a.azure-devices.net", "hub-b.azure-devices.net"}}
			c, err := NewX509Client("", "dev-1", deviceCert(t, "dev-1"),
				WithBrokerURL(broker.URL()), WithClock(clk), WithHubResolver(res.resolve))
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			c.Start(context.Background())

			await.Until(t, "the reconnect backoff after the refusal",
				func() bool { return slices.Contains(clk.Pending(), time.Second) },
				func() any { return clk.Pending() }, clk)
			if got := res.get(); !slices.Equal(got, []bool{false, true}) {
				t.Fatalf("resolver calls (refresh) = %v, want [false true]: one lookup, then one re-registration after the refusal", got)
			}
			clk.Advance(time.Second)
			await.Until(t, "an accepted second connect",
				func() bool { cs := broker.Connects(); return len(cs) == 2 && cs[1].ReturnCode == 0 },
				func() any { return broker.Connects() }, broker)

			cs := broker.Connects()
			if cs[0].ReturnCode != rc || cs[0].Username != "hub-a.azure-devices.net/dev-1/?api-version="+mqttAPIVersion {
				t.Errorf("first CONNECT = %+v, want hub-a refused with %d", cs[0], rc)
			}
			if cs[1].Username != "hub-b.azure-devices.net/dev-1/?api-version="+mqttAPIVersion {
				t.Errorf("second CONNECT = %+v, want hub-b", cs[1])
			}
			if got := res.get(); len(got) != 2 {
				t.Errorf("resolver called %d times, want 2", len(got))
			}
			if c.HostName() != "hub-b.azure-devices.net" {
				t.Errorf("HostName = %q", c.HostName())
			}
		})
	}
}

// Without Start, a publish refused as not authorised re-registers in its one
// retry.
func TestX509Client_PublishRefusedReregistersInItsRetry(t *testing.T) {
	broker := iothubtest.NewBroker(t)
	broker.RefuseNextConnect(5)
	res := &recordingResolver{hubs: []string{"hub-a.azure-devices.net", "hub-b.azure-devices.net"}}
	c, err := NewX509Client("", "dev-1", deviceCert(t, "dev-1"),
		WithBrokerURL(broker.URL()), WithClock(clocktest.New(time.Unix(1_700_000_000, 0))), WithHubResolver(res.resolve))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.PublishTelemetry(context.Background(), []byte(`{}`), nil); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if got := res.get(); !slices.Equal(got, []bool{false, true}) {
		t.Errorf("resolver calls (refresh) = %v, want [false true]", got)
	}
	if tel := broker.Telemetry(); len(tel) != 1 || tel[0].Conn != 2 {
		t.Errorf("telemetry = %+v, want one message on the second connection", tel)
	}
}

// Once started, a failing hub lookup is retried only by the connection loop,
// on its backoff: a publish meanwhile fails at once without asking again.
func TestX509Client_StartedPublishDoesNotResolve(t *testing.T) {
	clk := clocktest.New(time.Unix(1_700_000_000, 0))
	res := &recordingResolver{} // every lookup fails
	c, err := NewX509Client("", "dev-1", deviceCert(t, "dev-1"), WithClock(clk), WithHubResolver(res.resolve))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Start(context.Background())
	await.Until(t, "the backoff after the failed lookup",
		func() bool { return slices.Contains(clk.Pending(), time.Second) },
		func() any { return clk.Pending() }, clk)
	if err := c.PublishTelemetry(context.Background(), []byte(`{}`), nil); err == nil {
		t.Fatal("publish succeeded with no hub")
	}
	if got := res.get(); len(got) != 1 {
		t.Errorf("resolver called %d times, want 1 (the publish must not look the hub up)", len(got))
	}
	clk.Advance(time.Second)
	await.Until(t, "the loop's second lookup", func() bool { return len(res.get()) == 2 },
		func() any { return res.get() }, res)
}

func TestNewX509Client_Validation(t *testing.T) {
	cert := deviceCert(t, "dev-1")
	if _, err := NewX509Client("", "dev-1", cert); err == nil {
		t.Error("accepted no host and no resolver")
	}
	if _, err := NewX509Client("hub", "", cert); err == nil {
		t.Error("accepted no device id")
	}
	if _, err := NewX509Client("hub", "dev-1", tls.Certificate{}); err == nil {
		t.Error("accepted no certificate")
	}
}

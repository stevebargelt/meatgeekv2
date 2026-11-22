package simdevice

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/dpsmode"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision/provisiontest"

	"go.opentelemetry.io/otel"
)

// In DPS mode simdevice creates its own identity, registers with DPS and sends
// as the device on the assigned hub, through the same dpsmode client as the
// pusher.
func TestMain_DPSModeRegistersAndSendsAsTheDevice(t *testing.T) {
	const deviceID = "sim-dps-1"
	state := t.TempDir()
	dps := provisiontest.NewServer(t, "hub-dev.azure-devices.net")
	broker := iothubtest.NewBroker(t)
	clk := clocktest.New(clockStart)
	env := map[string]string{
		dpsmode.EnvIDScope:  "0ne00ABCDEF",
		dpsmode.EnvDeviceID: deviceID,
		dpsmode.EnvEndpoint: dps.Endpoint(),
		dpsmode.EnvStateDir: state,
	}
	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- Main(context.Background(), Env{
			Args:   []string{"--count", "1"},
			Getenv: func(k string) string { return env[k] },
			Stdout: &stdout,
			Stderr: &stderr,
			NewDPSClient: func(cfg dpsmode.Config, clk clock.Clock, opts ...iothub.Option) (TwinClient, error) {
				return dpsmode.NewClient(cfg, clk, []provision.Option{provision.WithRootCAs(dps.RootCAs())},
					append(opts, iothub.WithBrokerURL(broker.URL()))...)
			},
			Tracer: otel.Tracer("simdevice-dps-test"),
			Clock:  clk,
		})
	}()

	await.Until(t, "the registration waiting on DPS's Retry-After",
		func() bool { return slices.Contains(clk.Pending(), provisiontest.RetryAfter*time.Second) },
		func() any { return clk.Pending() }, clk)
	clk.Advance(provisiontest.RetryAfter * time.Second)
	if code := <-done; code != ExitOK {
		t.Fatalf("exit %d; stderr=%q", code, stderr.String())
	}

	var sent Sent
	if err := json.Unmarshal(stdout.Bytes(), &sent); err != nil || sent.DeviceID != deviceID {
		t.Fatalf("stdout = %q, want one Sent line for %s", stdout.String(), deviceID)
	}
	tel := broker.Telemetry()
	if len(tel) != 1 || tel[0].DeviceID != deviceID {
		t.Fatalf("telemetry = %+v, want one message from %s", tel, deviceID)
	}
	cs := broker.Connects()
	if len(cs) != 1 || cs[0].HasPassword || cs[0].Username != "hub-dev.azure-devices.net/"+deviceID+"/?api-version=2021-04-12" {
		t.Errorf("CONNECTs = %+v, want one X.509 CONNECT to the assigned hub", cs)
	}
	if n := dps.Registrations(); n != 1 {
		t.Errorf("%d registrations, want 1", n)
	}
	if a, ok, _ := provision.LoadAssignment(state); !ok || a.AssignedHub != "hub-dev.azure-devices.net" {
		t.Errorf("assignment not cached: %+v", a)
	}
}

func TestMain_DPSModeConfigErrors(t *testing.T) {
	cases := map[string]struct {
		env  map[string]string
		want []string
	}{
		"both modes": {
			env:  map[string]string{EnvConnectionString: validConn, dpsmode.EnvIDScope: "0ne00ABCDEF", dpsmode.EnvDeviceID: "sim-1"},
			want: []string{"set only one", EnvConnectionString, dpsmode.EnvIDScope},
		},
		"no device id": {
			env:  map[string]string{dpsmode.EnvIDScope: "0ne00ABCDEF"},
			want: []string{dpsmode.EnvDeviceID},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			res := runMain(t, []string{"--count", "1"}, tc.env, nil)
			if res.code != ExitUsage {
				t.Fatalf("exit %d, want %d; stderr=%q", res.code, ExitUsage, res.stderr)
			}
			for _, w := range tc.want {
				if !strings.Contains(res.stderr, w) {
					t.Errorf("stderr %q should name %q", res.stderr, w)
				}
			}
			if strings.Contains(res.stderr, fakeKey) {
				t.Error("stderr leaks the key")
			}
			if len(res.mock.Calls()) != 0 {
				t.Error("sent despite the configuration error")
			}
		})
	}
}

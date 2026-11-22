package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/dpsmode"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision/provisiontest"
)

// TestMain lets the test binary stand in for the real meatgeek-pusher: with
// PUSHER_TEST_AS_BINARY=1 it runs the command's real main() with the
// arguments in PUSHER_TEST_ARGS and exits.
func TestMain(m *testing.M) {
	if os.Getenv("PUSHER_TEST_AS_BINARY") == "1" {
		os.Args = append([]string{"meatgeek-pusher"}, strings.Fields(os.Getenv("PUSHER_TEST_ARGS"))...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func envOf(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestConfig_DPSModeWithIDScope(t *testing.T) {
	cfg := loadConfig(nil, envOf(map[string]string{
		dpsmode.EnvIDScope:  "0ne00ABCDEF",
		dpsmode.EnvDeviceID: "meatgeek-pi-7",
	}))
	mode, err := cfg.iotMode()
	if err != nil || mode != modeDPS {
		t.Fatalf("mode = %v, %v; want DPS mode", mode, err)
	}
	want := dpsmode.Config{
		IDScope:  "0ne00ABCDEF",
		DeviceID: "meatgeek-pi-7",
		Endpoint: "global.azure-devices-provisioning.net",
		StateDir: "/var/lib/meatgeek-pusher",
	}
	if cfg.DPS != want {
		t.Errorf("DPS config = %+v, want %+v", cfg.DPS, want)
	}

	cfg = loadConfig(nil, envOf(map[string]string{
		dpsmode.EnvIDScope:  "0ne00ABCDEF",
		dpsmode.EnvDeviceID: "meatgeek-pi-7",
		dpsmode.EnvEndpoint: "dps.example",
		dpsmode.EnvStateDir: "/srv/state",
	}))
	if cfg.DPS.Endpoint != "dps.example" || cfg.DPS.StateDir != "/srv/state" {
		t.Errorf("overrides not read: %+v", cfg.DPS)
	}
}

func TestConfig_DPSModeNeedsADeviceID(t *testing.T) {
	cfg := loadConfig(nil, envOf(map[string]string{dpsmode.EnvIDScope: "0ne00ABCDEF"}))
	if _, err := cfg.iotMode(); err == nil || !strings.Contains(err.Error(), dpsmode.EnvDeviceID) {
		t.Fatalf("err = %v, want one naming %s", err, dpsmode.EnvDeviceID)
	}
}

func TestConfig_LegacyModeWithOnlyTheConnectionString(t *testing.T) {
	cfg := loadConfig(nil, envOf(map[string]string{"IOTHUB_CONNECTION_STRING": twinTestConnStr}))
	mode, err := cfg.iotMode()
	if err != nil || mode != modeConnectionString {
		t.Fatalf("mode = %v, %v; want connection-string mode", mode, err)
	}
	if cfg.IoTHubConnStr != twinTestConnStr {
		t.Error("connection string not read")
	}
}

func TestConfig_RefusesBothModes(t *testing.T) {
	cfg := loadConfig(nil, envOf(map[string]string{
		"IOTHUB_CONNECTION_STRING": twinTestConnStr,
		dpsmode.EnvIDScope:         "0ne00ABCDEF",
		dpsmode.EnvDeviceID:        "meatgeek-pi-7",
	}))
	_, err := cfg.iotMode()
	if !errors.Is(err, errBothModes) || !strings.Contains(err.Error(), "set only one") {
		t.Fatalf("err = %v, want the refusal to run with both", err)
	}
	if strings.Contains(err.Error(), twinTestConnStr) {
		t.Error("the refusal leaks the connection string")
	}
	// run refuses before it opens anything.
	cfg.CookSessionStatePath = t.TempDir() + "/cooksession.json"
	if err := run(context.Background(), cfg, nil); !errors.Is(err, errBothModes) {
		t.Errorf("run = %v, want the refusal", err)
	}
}

func TestConfig_RefusesNeitherMode(t *testing.T) {
	cfg := loadConfig(nil, envOf(nil))
	if _, err := cfg.iotMode(); err == nil {
		t.Fatal("no IoT Hub configuration accepted")
	}
	cfg.MockIoT = true
	if mode, err := cfg.iotMode(); err != nil || mode != modeMock {
		t.Errorf("--mock-iot: mode = %v, %v", mode, err)
	}
}

// TestDPSMode_NotAuthorisedReregistersExactlyOnce is the pusher's DPS wiring
// end to end against a fake DPS and a fake hub: it connects to the cached
// hub, the hub refuses it (CONNACK 5), and it deletes the cached assignment,
// registers once, and connects to the newly assigned hub after the usual
// backoff.
func TestDPSMode_NotAuthorisedReregistersExactlyOnce(t *testing.T) {
	const deviceID = "meatgeek-pi-7"
	state := t.TempDir()
	dps := provisiontest.NewServer(t, "hub-b.azure-devices.net")
	broker := iothubtest.NewBroker(t)
	broker.RefuseNextConnect(5)
	clk := clocktest.New(time.Unix(1_700_000_000, 0))
	if err := provision.SaveAssignment(state, provision.Assignment{AssignedHub: "hub-a.azure-devices.net", DeviceID: deviceID, RegisteredAt: clk.Now()}); err != nil {
		t.Fatal(err)
	}

	cfg := loadConfig(nil, envOf(map[string]string{
		dpsmode.EnvIDScope:  "0ne00ABCDEF",
		dpsmode.EnvDeviceID: deviceID,
		dpsmode.EnvEndpoint: dps.Endpoint(),
		dpsmode.EnvStateDir: state,
	}))
	mode, err := cfg.iotMode()
	if err != nil {
		t.Fatal(err)
	}
	client, err := newIoTHubClient(cfg, mode, cooksession.NewMemory(), clk,
		[]provision.Option{provision.WithRootCAs(dps.RootCAs())},
		iothub.WithBrokerURL(broker.URL()))
	if err != nil {
		t.Fatalf("newIoTHubClient: %v", err)
	}
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.Start(ctx)

	// The refusal: the cached hub was used without registering, then the
	// re-registration is waiting on DPS's Retry-After.
	await.Until(t, "the re-registration waiting on DPS's Retry-After",
		func() bool { return slices.Contains(clk.Pending(), provisiontest.RetryAfter*time.Second) },
		func() any { return clk.Pending() }, clk)
	cs := broker.Connects()
	if len(cs) != 1 || cs[0].ReturnCode != 5 || !strings.HasPrefix(cs[0].Username, "hub-a.azure-devices.net/"+deviceID+"/") {
		t.Fatalf("CONNECTs = %+v, want one to the cached hub-a, refused", cs)
	}
	if n := dps.Registrations(); n != 1 {
		t.Fatalf("%d registrations, want 1", n)
	}
	if _, ok, _ := provision.LoadAssignment(state); ok {
		t.Error("the cached assignment was not deleted after the refusal")
	}
	clk.Advance(provisiontest.RetryAfter * time.Second)

	// Registered: the backoff before the reconnect.
	await.Until(t, "the reconnect backoff",
		func() bool { return slices.Contains(clk.Pending(), time.Second) },
		func() any { return clk.Pending() }, clk)
	clk.Advance(time.Second)
	await.Until(t, "the twin synced on the new hub", func() bool {
		cs := broker.Connects()
		return len(cs) == 2 && cs[1].ReturnCode == 0 && len(broker.TwinGets()) == 1
	}, func() any { return broker.Connects() }, broker)

	cs = broker.Connects()
	if !strings.HasPrefix(cs[1].Username, "hub-b.azure-devices.net/"+deviceID+"/") || cs[1].HasPassword {
		t.Errorf("second CONNECT = %+v, want hub-b with no password", cs[1])
	}
	if n := dps.Registrations(); n != 1 {
		t.Errorf("%d registrations, want exactly 1", n)
	}
	a, ok, err := provision.LoadAssignment(state)
	if err != nil || !ok || a.AssignedHub != "hub-b.azure-devices.net" || a.DeviceID != deviceID {
		t.Errorf("cached assignment = %+v, %v, %v; want hub-b", a, ok, err)
	}
	for _, r := range dps.Requests() {
		if r.ClientCN != deviceID {
			t.Errorf("DPS request with client certificate CN %q, want %q", r.ClientCN, deviceID)
		}
	}
}

func runPusher(t *testing.T, args string) (code int, stdout, stderr []byte) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = []string{"PUSHER_TEST_AS_BINARY=1", "PUSHER_TEST_ARGS=" + args}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	default:
		t.Fatalf("run binary: %v", err)
	}
	return code, out.Bytes(), errb.Bytes()
}

// checkOnlyCertificate fails unless out is exactly one PEM certificate whose
// CN is deviceID.
func checkOnlyCertificate(t *testing.T, out []byte, deviceID string) {
	t.Helper()
	if bytes.Contains(out, []byte("PRIVATE KEY")) {
		t.Fatal("stdout carries a private key")
	}
	block, rest := pem.Decode(out)
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatalf("stdout is not a PEM certificate: %q", out)
	}
	if len(rest) != 0 {
		t.Fatalf("stdout has more than the certificate: %q", rest)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cert.Subject.CommonName != deviceID {
		t.Errorf("CN = %q, want %q", cert.Subject.CommonName, deviceID)
	}
}

func TestIdentityInit_PrintsOnlyTheCertificateAndTheSameOnEveryRun(t *testing.T) {
	state := t.TempDir()
	args := "identity init --device-id meatgeek-pi-7 --state-dir " + state
	code, first, stderr := runPusher(t, args)
	if code != 0 {
		t.Fatalf("exit %d; stderr=%q", code, stderr)
	}
	checkOnlyCertificate(t, first, "meatgeek-pi-7")
	code, second, stderr := runPusher(t, args)
	if code != 0 {
		t.Fatalf("second run: exit %d; stderr=%q", code, stderr)
	}
	if !bytes.Equal(first, second) {
		t.Error("the second run printed different bytes")
	}
}

func TestIdentityInit_UsageErrors(t *testing.T) {
	for _, args := range []string{"identity", "identity init", "identity init --device-id has/slash --state-dir " + t.TempDir()} {
		code, stdout, _ := runPusher(t, args)
		if code == 0 {
			t.Errorf("%q: exit 0", args)
		}
		if len(stdout) != 0 {
			t.Errorf("%q: stdout = %q, want nothing", args, stdout)
		}
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/claim"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/collector"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/dpsmode"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/simdevice"
)

var claimTestNow = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

func saveClaim(t *testing.T, dir string, s claim.State) {
	t.Helper()
	if err := claim.Save(dir, s); err != nil {
		t.Fatal(err)
	}
}

func claimState(deviceID string, expires time.Time, claimed bool) claim.State {
	const code = "7K3M9QXR2HTV"
	return claim.State{DeviceID: deviceID, Code: code, CodeHash: claim.Hash(deviceID, code), ExpiresAt: expires, Claimed: claimed}
}

// `meatgeek-pusher claim-code` prints one JSON line for each state and exits
// 0, or exits 3 with nothing on stdout when there is no claim file.
func TestClaimCode_Pusher(t *testing.T) {
	cases := []struct {
		name  string
		state *claim.State
		code  int
		want  string
	}{
		{"unclaimed", ptr(claimState("pi-7", claimTestNow.Add(time.Hour), false)), 0,
			`{"deviceId":"pi-7","state":"unclaimed","claimCode":"7K3M-9QXR-2HTV","expiresAt":"2026-11-22T13:00:00Z"}`},
		{"claimed", ptr(claimState("pi-7", claimTestNow.Add(time.Hour), true)), 0, `{"deviceId":"pi-7","state":"claimed"}`},
		{"claimed and expired", ptr(claimState("pi-7", claimTestNow.Add(-time.Hour), true)), 0, `{"deviceId":"pi-7","state":"claimed"}`},
		{"expired", ptr(claimState("pi-7", claimTestNow, false)), 0, `{"deviceId":"pi-7","state":"expired"}`},
		{"missing", nil, dpsmode.ExitNoClaim, ``},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			if c.state != nil {
				saveClaim(t, dir, *c.state)
			}
			var stdout, stderr bytes.Buffer
			code, ok := subcommand([]string{"claim-code", "--state-dir", dir}, envOf(nil), &stdout, &stderr, clocktest.New(claimTestNow))
			if !ok || code != c.code {
				t.Fatalf("exit %d (handled %v), want %d; stderr=%q", code, ok, c.code, stderr.String())
			}
			if got := strings.TrimSuffix(stdout.String(), "\n"); got != c.want || strings.Count(stdout.String(), "\n") > 1 {
				t.Errorf("stdout = %q, want %q", stdout.String(), c.want)
			}
		})
	}

	// The state dir defaults to $MEATGEEK_STATE_DIR.
	dir := t.TempDir()
	saveClaim(t, dir, claimState("pi-7", claimTestNow.Add(time.Hour), false))
	var stdout bytes.Buffer
	if code, _ := subcommand([]string{"claim-code"}, envOf(map[string]string{dpsmode.EnvStateDir: dir}), &stdout, io.Discard, clocktest.New(claimTestNow)); code != 0 || !strings.Contains(stdout.String(), "7K3M-9QXR-2HTV") {
		t.Errorf("with $%s: exit %d, stdout %q", dpsmode.EnvStateDir, code, stdout.String())
	}
	if code, _ := subcommand([]string{"claim-code", "extra"}, envOf(nil), io.Discard, io.Discard, clocktest.New(claimTestNow)); code != 2 {
		t.Errorf("unexpected argument: exit %d, want 2", code)
	}
}

func ptr[T any](v T) *T { return &v }

// The real binary dispatches claim-code before anything else touches stdout.
func TestClaimCode_PusherBinary(t *testing.T) {
	dir := t.TempDir()
	code, stdout, stderr := runPusher(t, "claim-code --state-dir "+dir)
	if code != dpsmode.ExitNoClaim || len(stdout) != 0 {
		t.Fatalf("missing: exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	saveClaim(t, dir, claimState("pi-7", claimTestNow, true))
	code, stdout, stderr = runPusher(t, "claim-code --state-dir "+dir)
	if code != 0 || string(stdout) != "{\"deviceId\":\"pi-7\",\"state\":\"claimed\"}\n" {
		t.Fatalf("claimed: exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

// captureLogs sends logrus output to a buffer at debug level for the test.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	out, level, formatter := logrus.StandardLogger().Out, logrus.GetLevel(), logrus.StandardLogger().Formatter
	logrus.SetOutput(buf)
	logrus.SetLevel(logrus.DebugLevel)
	logrus.SetFormatter(&logrus.JSONFormatter{})
	t.Cleanup(func() {
		logrus.SetOutput(out)
		logrus.SetLevel(level)
		logrus.SetFormatter(formatter)
	})
	return buf
}

// TestClaimCycle_NoSecretInLogsSpansOrTelemetry runs the pusher's DPS-mode
// client through a whole claim cycle against a fake hub (mint and report at
// start, a claim, a release and its new code) and publishes a reading through
// the real enqueuer and publisher, with every log at debug level and every
// span recorded. Neither claim code, in any form, nor the claimant hash the
// API wrote appears in a log line, a span, a telemetry message or a reported
// patch.
func TestClaimCycle_NoSecretInLogsSpansOrTelemetry(t *testing.T) {
	const deviceID = "meatgeek-pi-7"
	const claimantHash = "c1a1a1a1b2b2b2b2c3c3c3c3d4d4d4d4e5e5e5e5f6f6f6f6a7a7a7a7b8b8b8b8"
	logs := captureLogs(t)
	spans := tracetest.NewSpanRecorder()
	tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans)).Tracer("claim-leak-test")

	state := t.TempDir()
	broker := iothubtest.NewBroker(t)
	broker.SetDesiredQuietly(map[string]any{"claimClaimantHash": claimantHash})
	clk := clocktest.New(claimTestNow)
	// A cached assignment: the client connects without registering.
	if err := provision.SaveAssignment(state, provision.Assignment{AssignedHub: "hub-a.azure-devices.net", DeviceID: deviceID, RegisteredAt: clk.Now()}); err != nil {
		t.Fatal(err)
	}
	cfg := loadConfig([]string{"--debug"}, envOf(map[string]string{
		dpsmode.EnvIDScope:  "0ne00ABCDEF",
		dpsmode.EnvDeviceID: deviceID,
		dpsmode.EnvStateDir: state,
	}))
	mode, err := cfg.iotMode()
	if err != nil {
		t.Fatal(err)
	}
	sess, err := cooksession.Open(t.TempDir() + "/cooksession.json")
	if err != nil {
		t.Fatal(err)
	}
	client, err := newIoTHubClient(cfg, mode, sess, clk, nil, iothub.WithBrokerURL(broker.URL()))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client.Start(ctx)
	if err := client.WaitTwinSynced(await.Context(t)); err != nil {
		t.Fatal(err)
	}

	first, err := claim.Load(state)
	if err != nil {
		t.Fatalf("no code minted: %v", err)
	}
	if broker.Reported()[claim.ReportedCodeHash] != first.CodeHash {
		t.Fatalf("reported = %v, want the minted hash", broker.Reported())
	}
	// Claimed, then released: a second code.
	broker.SetDesired(map[string]any{claim.DesiredConsumedCodeHash: first.CodeHash, "claimClaimantHash": claimantHash})
	await.Until(t, "the claim recorded", func() bool { s, _ := claim.Load(state); return s.Claimed },
		func() any { return broker.ReportedPatches() }, broker)
	broker.SetDesired(map[string]any{claim.Generation: "1", "claimClaimantHash": nil})
	await.Until(t, "the release's code reported", func() bool { return broker.Reported()[claim.Generation] == "1" },
		func() any { return broker.Reported() }, broker)
	second, err := claim.Load(state)
	if err != nil || second.CodeHash == first.CodeHash {
		t.Fatalf("no second code: %+v, %v", second, err)
	}

	// A reading through the real enqueuer and publisher.
	q, err := queue.Open(t.TempDir(), queue.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	samples := make(chan collector.Sample, 1)
	samples <- collector.Sample{Status: simdevice.SyntheticStatus(deviceID, 0), Timestamp: clk.Now()}
	close(samples)
	runEnqueuer(ctx, samples, sess, q, deviceID, tracer)
	pubDone := make(chan struct{})
	go func() {
		runPublisher(ctx, q, client, deviceID, tracer)
		close(pubDone)
	}()
	await.Until(t, "one telemetry message", func() bool { return len(broker.Telemetry()) == 1 },
		func() any { return broker.Telemetry() }, broker)
	cancel()
	<-pubDone

	secrets := []string{claimantHash}
	for _, s := range []claim.State{first, second} {
		secrets = append(secrets, s.Code, claim.Format(s.Code))
	}
	var haystacks []string
	haystacks = append(haystacks, logs.String())
	if !strings.Contains(logs.String(), "minted a new claim code") {
		t.Fatalf("the logs were not captured: %q", logs.String())
	}
	for _, s := range spans.Ended() {
		haystacks = append(haystacks, fmt.Sprintf("%s %v %v %v", s.Name(), s.Attributes(), s.Events(), s.Status()))
	}
	if len(spans.Ended()) == 0 {
		t.Fatal("no span recorded")
	}
	for _, m := range broker.Telemetry() {
		haystacks = append(haystacks, string(m.Payload), m.Topic, fmt.Sprint(m.Properties))
	}
	for _, p := range broker.ReportedPatches() {
		b, _ := json.Marshal(p)
		haystacks = append(haystacks, string(b))
	}
	for _, h := range haystacks {
		for _, s := range secrets {
			if strings.Contains(h, s) {
				t.Errorf("a secret (%d chars) leaked into %q", len(s), h)
			}
		}
	}
}

// syncBuffer is a bytes.Buffer safe for the client's goroutines to log into
// while the test reads it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

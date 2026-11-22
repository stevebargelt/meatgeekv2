// Package simdevice is a software IoT Hub device for dev: it sends synthetic
// temperature readings as one device, built and published through exactly the
// code the data-pusher on the Pi uses (internal/publish for the payload and
// message properties, an iothub client for the MQTT send). With --twin it
// first reads the device twin through the Pi's twin code (iothub.WithCookTwin
// on an in-memory cooksession) and stamps the applied cook on its readings.
// The device authenticates with a connection string ($SIMDEVICE_CONNECTION_STRING)
// or, in DPS mode ($MEATGEEK_DPS_ID_SCOPE and $MEATGEEK_DEVICE_ID), exactly as
// the Pi does: its own X.509 identity under $MEATGEEK_STATE_DIR, registered
// with the Device Provisioning Service (internal/dpsmode). `simdevice identity
// init` creates that identity and prints only its certificate.
// The cmd/simdevice binary is a thin wrapper around Main.
package simdevice

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/dpsmode"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/publish"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// EnvConnectionString names the ONLY source of the device credential. There is
// deliberately no flag for it: a flag would land in shell history and `ps`.
const EnvConnectionString = "SIMDEVICE_CONNECTION_STRING"

// Exit codes returned by Main.
const (
	ExitOK         = 0
	ExitSendFailed = 1 // a send failed, or --twin got no twin response in time
	ExitUsage      = 2
)

// defaultTwinTimeout is --timeout's default.
const defaultTwinTimeout = 30 * time.Second

// timeFormat is RFC 3339 with exactly three fractional digits, UTC.
const timeFormat = "2006-01-02T15:04:05.000Z07:00"

// Client is the slice of the IoT Hub client simdevice needs. Both
// *iothub.AzureClient and *iothub.MockClient satisfy it. PublishTelemetry is
// the Pi's blocking send; PublishTelemetryAsync starts a send and returns a
// wait for its acknowledgement, so several can be in flight (--inflight > 1).
type Client interface {
	PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error
	PublishTelemetryAsync(ctx context.Context, payload []byte, properties map[string]string) (wait func() error, err error)
	Close() error
}

// ClientFactory builds the IoT Hub client for a connection string.
type ClientFactory func(connectionString string) (Client, error)

// AzureClientFactory is the production factory: the MQTT client the Pi uses.
func AzureClientFactory(connectionString string) (Client, error) {
	return iothub.NewAzureClient(connectionString)
}

// TwinClient is a Client with the device twin on: what --twin needs.
// *iothub.AzureClient satisfies it.
type TwinClient interface {
	Client
	Start(ctx context.Context)
	WaitTwinSynced(ctx context.Context) error
	GetTwin(ctx context.Context) (iothub.Twin, error)
}

// TwinClientFactory builds a twin-enabled client. Main passes
// iothub.WithCookTwin, iothub.WithTwinTimeout and iothub.WithClock in opts.
type TwinClientFactory func(connectionString string, opts ...iothub.Option) (TwinClient, error)

// AzureTwinClientFactory is the production twin factory: the Pi's MQTT client
// and twin code.
func AzureTwinClientFactory(connectionString string, opts ...iothub.Option) (TwinClient, error) {
	return iothub.NewAzureClient(connectionString, opts...)
}

// DPSClientFactory builds the DPS-mode client: the device's own X.509
// identity and the hub DPS assigns. Main passes iothub.WithClock and, with
// --twin, the twin options in opts.
type DPSClientFactory func(cfg dpsmode.Config, clk clock.Clock, opts ...iothub.Option) (TwinClient, error)

// AzureDPSClientFactory is the production DPS factory: the Pi's DPS path.
func AzureDPSClientFactory(cfg dpsmode.Config, clk clock.Clock, opts ...iothub.Option) (TwinClient, error) {
	return dpsmode.NewClient(cfg, clk, nil, opts...)
}

// TwinLine is the stdout line --twin prints after reading the twin back.
type TwinLine struct {
	Event    string              `json:"event"` // always "twin"
	Desired  iothub.TwinDesired  `json:"desired"`
	Reported iothub.TwinReported `json:"reported"`
}

// Sent is one stdout line: the identifiers of a message that IoT Hub accepted.
type Sent struct {
	MessageID string `json:"messageId"`
	DeviceID  string `json:"deviceId"`
	Timestamp string `json:"timestamp"`
	SentAt    string `json:"sentAt"`
}

// Env is everything Main takes from the process, injectable for tests.
type Env struct {
	Args      []string
	Getenv    func(string) string
	Stdout    io.Writer
	Stderr    io.Writer
	NewClient ClientFactory
	// NewTwinClient builds the client for --twin.
	NewTwinClient TwinClientFactory
	// NewDPSClient builds the client in DPS mode, with or without --twin.
	NewDPSClient DPSClientFactory
	Tracer       trace.Tracer
	// Now stamps readings and sentAt; nil is Clock's Now.
	Now func() time.Time
	// Clock times every wait Main makes: the --interval gap, the --twin
	// --timeout, the 30s bound on a blocking send, and the twin client's own
	// timers. nil is clock.Real().
	Clock clock.Clock
}

// Main runs the command and returns its exit code. Nothing but one JSON line
// per sent message (and, with --twin, the twin line first) goes to Stdout. No path writes the connection string or
// its key anywhere: errors go through a redactor before reaching Stderr.
func Main(ctx context.Context, env Env) int {
	clk := env.Clock
	if clk == nil {
		clk = clock.Real()
	}
	if len(env.Args) > 0 && env.Args[0] == "identity" {
		return dpsmode.IdentityCommand("simdevice", env.Args[1:], env.Getenv, env.Stdout, env.Stderr, clk)
	}

	connStr := env.Getenv(EnvConnectionString)
	redact := newRedactor(connStr)
	fail := func(code int, format string, a ...any) int {
		fmt.Fprintln(env.Stderr, redact("simdevice: "+fmt.Sprintf(format, a...)))
		return code
	}

	fs := flag.NewFlagSet("simdevice", flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	count := fs.Int("count", 1, "number of readings to send")
	interval := fs.Duration("interval", 0, "gap between sends (Go duration, e.g. 500ms, 2s); with --inflight > 1, between send starts")
	inflight := fs.Int("inflight", 1, "how many sends may await IoT Hub's acknowledgement at once")
	twinMode := fs.Bool("twin", false, "read the device twin first: apply its desired cook, report it, print the twin, then send --count readings carrying that cook (--count 0 sends none)")
	timeout := fs.Duration("timeout", defaultTwinTimeout, "with --twin, how long to wait for the twin before exiting 1")
	startFlag := fs.String("start", "", "with --step, stamp reading i (0-based) start + i×step instead of the wall clock (RFC 3339); pacing still comes from --interval/--inflight")
	step := fs.Duration("step", 0, "with --start, the gap between consecutive readings' timestamps (Go duration, at least 1ms)")
	grill := fs.Float64("grill", 0, "send this grill temperature (°F) on every reading instead of the synthetic one, so a reader can tell this run's readings from older ones")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: simdevice [--twin [--timeout DURATION]] [--count N] [--interval DURATION] [--inflight N] [--start RFC3339 --step DURATION] [--grill °F]\n"+
			"       simdevice identity init --device-id <id> [--state-dir <dir>]\n"+
			"Sends synthetic readings as the IoT Hub device named by $%s, or in DPS mode ($%s and $%s) as the device with its own X.509 identity.\n", EnvConnectionString, dpsmode.EnvIDScope, dpsmode.EnvDeviceID)
		fs.PrintDefaults()
	}
	if err := fs.Parse(env.Args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if fs.NArg() > 0 {
		return fail(ExitUsage, "unexpected arguments %q (the connection string is read only from $%s)", fs.Args(), EnvConnectionString)
	}
	if *twinMode && *count < 0 {
		return fail(ExitUsage, "--count must not be negative, got %d", *count)
	}
	if !*twinMode && *count < 1 {
		return fail(ExitUsage, "--count must be at least 1, got %d", *count)
	}
	if *timeout <= 0 {
		return fail(ExitUsage, "--timeout must be positive, got %s", *timeout)
	}
	if *interval < 0 {
		return fail(ExitUsage, "--interval must not be negative, got %s", *interval)
	}
	if *inflight < 1 {
		return fail(ExitUsage, "--inflight must be at least 1, got %d", *inflight)
	}
	// --start and --step stamp synthetic timestamps (HAR-87); one without the
	// other is a usage error, not a silent fall-back to the wall clock.
	stepSet, grillSet := false, false
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "step":
			stepSet = true
		case "grill":
			grillSet = true
		}
	})
	if grillSet && (math.IsNaN(*grill) || math.IsInf(*grill, 0)) {
		return fail(ExitUsage, "--grill must be a finite number, got %v", *grill)
	}
	// The status of reading i (0-based): the synthetic curve, with --grill's
	// value in place of its grill temperature when set.
	status := func(deviceID string, i int) wire.V1Status {
		s := SyntheticStatus(deviceID, i)
		if grillSet {
			g := *grill
			s.Temps.GrillTemp = &g
		}
		return s
	}
	startSet := *startFlag != ""
	if startSet != stepSet {
		if startSet {
			return fail(ExitUsage, "--start needs --step")
		}
		return fail(ExitUsage, "--step needs --start")
	}
	var synthStart time.Time
	if startSet {
		t, err := time.Parse(time.RFC3339Nano, *startFlag)
		if err != nil {
			return fail(ExitUsage, "--start must be an RFC 3339 time, got %q", *startFlag)
		}
		if *step < time.Millisecond {
			return fail(ExitUsage, "--step must be at least 1ms, got %s", *step)
		}
		synthStart = t.UTC().Truncate(time.Millisecond)
	}

	dps := dpsmode.FromEnv(env.Getenv)
	var deviceID string
	switch {
	case dps.Enabled() && strings.TrimSpace(connStr) != "":
		return fail(ExitUsage, "both %s and %s are set; set only one: %s for DPS mode, or %s for connection-string mode", dpsmode.EnvIDScope, EnvConnectionString, dpsmode.EnvIDScope, EnvConnectionString)
	case dps.Enabled():
		if err := dps.Validate(); err != nil {
			return fail(ExitUsage, "DPS mode: %v", err)
		}
		if env.NewDPSClient == nil {
			return fail(ExitUsage, "DPS mode is not available in this build (no DPS client)")
		}
		deviceID = dps.DeviceID
	case strings.TrimSpace(connStr) == "":
		return fail(ExitUsage, "%s is not set; export the device's IoT Hub connection string in it (or set %s and %s for DPS mode)", EnvConnectionString, dpsmode.EnvIDScope, dpsmode.EnvDeviceID)
	default:
		parsed, err := iothub.ParseDeviceConnectionString(connStr)
		if err != nil {
			return fail(ExitUsage, "%s is not a valid device connection string: %v", EnvConnectionString, err)
		}
		deviceID = parsed.DeviceID
	}
	enc := json.NewEncoder(env.Stdout)
	tracer := env.Tracer
	if tracer == nil {
		tracer = otel.Tracer("meatgeek-simdevice")
	}
	sender := Sender{DeviceID: deviceID, Tracer: tracer, Clock: clk}

	if *twinMode {
		if env.NewTwinClient == nil {
			return fail(ExitUsage, "--twin is not available in this build (no twin client)")
		}
		session := cooksession.NewMemory()
		twinOpts := []iothub.Option{iothub.WithCookTwin(session), iothub.WithTwinTimeout(*timeout), iothub.WithClock(clk)}
		var tc TwinClient
		var err error
		if dps.Enabled() {
			tc, err = env.NewDPSClient(dps, clk, twinOpts...)
		} else {
			tc, err = env.NewTwinClient(connStr, twinOpts...)
		}
		if err != nil {
			return fail(ExitUsage, "create IoT Hub client: %v", err)
		}
		defer tc.Close()
		if code := readTwin(ctx, tc, clk, *timeout, enc, fail); code != ExitOK {
			return code
		}
		snap := session.Snapshot()
		sender.Client = tc
		sender.CookID = snap.CookID
		if snap.CorrelationID != nil {
			sender.CorrelationID = *snap.CorrelationID
		}
		if *count == 0 {
			return ExitOK
		}
	} else {
		var client Client
		var err error
		if dps.Enabled() {
			client, err = env.NewDPSClient(dps, clk, iothub.WithClock(clk))
		} else {
			client, err = env.NewClient(connStr)
		}
		if err != nil {
			return fail(ExitUsage, "create IoT Hub client: %v", err)
		}
		defer client.Close()
		sender.Client = client
	}

	now := env.Now
	if now == nil {
		now = clk.Now
	}
	// Millisecond timestamps, strictly increasing within the run, so the
	// stdout `timestamp` equals the payload's and every reading is distinct.
	// With --start/--step the n-th call (0-based) returns start + n×step
	// instead of the clock; both senders call it once per reading, in
	// reading order, so reading i carries start + i×step.
	var last time.Time
	stamped := 0
	nextTimestamp := func() time.Time {
		var ts time.Time
		if startSet {
			ts = synthStart.Add(time.Duration(stamped) * *step).Truncate(time.Millisecond)
			stamped++
		} else {
			ts = now().UTC().Truncate(time.Millisecond)
		}
		if !ts.After(last) {
			ts = last.Add(time.Millisecond)
		}
		last = ts
		return ts
	}

	if *inflight > 1 {
		return runPipelined(ctx, pipeline{
			sender:   sender,
			count:    *count,
			interval: *interval,
			inflight: *inflight,
			clock:    clk,
			next:     nextTimestamp,
			status:   status,
			now:      now,
			enc:      enc,
			fail:     fail,
		})
	}

	for i := 0; i < *count; i++ {
		if i > 0 && *interval > 0 {
			timer := clk.NewTimer(*interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return fail(ExitSendFailed, "interrupted after %d of %d readings", i, *count)
			case <-timer.C():
			}
		}
		ts := nextTimestamp()

		sent, err := sender.Send(ctx, status(deviceID, i), ts, uint64(i+1))
		if err != nil {
			return fail(ExitSendFailed, "send reading %d of %d: %v", i+1, *count, err)
		}
		sent.SentAt = now().UTC().Format(timeFormat)
		if err := enc.Encode(sent); err != nil {
			return fail(ExitSendFailed, "write stdout: %v", err)
		}
	}
	return ExitOK
}

// readTwin is --twin's twin phase: connect, let the twin code GET the twin,
// apply its desired cook to the client's CookState and report it, then GET
// the twin again and print it as one TwinLine. All of it must finish within timeout.
func readTwin(ctx context.Context, tc TwinClient, clk clock.Clock, timeout time.Duration, enc *json.Encoder, fail func(code int, format string, a ...any) int) int {
	tctx, cancel := clock.WithTimeout(ctx, clk, timeout)
	defer cancel()
	tc.Start(ctx)
	if err := tc.WaitTwinSynced(tctx); err != nil {
		return fail(ExitSendFailed, "no twin response from IoT Hub within %s: %v", timeout, err)
	}
	tw, err := tc.GetTwin(tctx)
	if err != nil {
		return fail(ExitSendFailed, "no twin response from IoT Hub within %s on the second GET: %v", timeout, err)
	}
	if err := enc.Encode(TwinLine{Event: "twin", Desired: tw.Desired, Reported: tw.Reported}); err != nil {
		return fail(ExitSendFailed, "write stdout: %v", err)
	}
	return ExitOK
}

// pipeline is what runPipelined needs from Main.
type pipeline struct {
	sender   Sender
	count    int
	interval time.Duration
	inflight int
	clock    clock.Clock      // times the interval
	next     func() time.Time // the next reading's timestamp
	status   func(deviceID string, i int) wire.V1Status
	now      func() time.Time
	enc      *json.Encoder
	fail     func(code int, format string, a ...any) int
}

// runPipelined sends p.count readings with up to p.inflight of them awaiting
// IoT Hub's acknowledgement at once. Sends START at most once per p.interval,
// whatever the acknowledgement latency, so the interval caps the rate. Each
// reading's stdout line is written when its acknowledgement arrives (sentAt is
// the ack time), so lines may come out of send order. A failed acknowledgement
// is retried once with the blocking PublishTelemetry; if that fails too, no
// further reading is started, the ones in flight are waited for, and the run
// exits 1. On every path, one stdout line is written per acknowledged reading.
func runPipelined(ctx context.Context, p pipeline) int {
	slots := make(chan struct{}, p.inflight)
	stopped := make(chan struct{})
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex // guards enc and acked
		acked    int
		stopOnce sync.Once
		firstErr string // written once, inside stopOnce
	)
	// stop records the first failure and stops new sends. It never takes mu.
	stop := func(msg string) {
		stopOnce.Do(func() {
			firstErr = msg
			close(stopped)
		})
	}

	started := 0
	var lastStart time.Time
loop:
	for i := 0; i < p.count; i++ {
		if i > 0 && p.interval > 0 {
			if d := p.interval - p.clock.Now().Sub(lastStart); d > 0 {
				timer := p.clock.NewTimer(d)
				select {
				case <-ctx.Done():
					timer.Stop()
					break loop
				case <-stopped:
					timer.Stop()
					break loop
				case <-timer.C():
				}
			}
		}
		select {
		case <-ctx.Done():
			break loop
		case <-stopped:
			break loop
		case slots <- struct{}{}:
		}
		lastStart = p.clock.Now()
		started++

		msg, err := p.sender.Prepare(ctx, p.status(p.sender.DeviceID, i), p.next(), uint64(i+1))
		if err != nil {
			<-slots
			stop(fmt.Sprintf("build reading %d of %d: %v", i+1, p.count, err))
			break
		}
		wait, startErr := p.sender.Client.PublishTelemetryAsync(ctx, msg.payload, msg.props)
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			defer func() { <-slots }()
			defer msg.span.End()

			err := startErr
			if err == nil {
				err = wait()
			}
			if err != nil {
				// One retry, the blocking way the Pi sends.
				retryCtx, cancel := clock.WithTimeout(msg.ctx, p.sender.clock(), sendTimeout)
				err = p.sender.Client.PublishTelemetry(retryCtx, msg.payload, msg.props)
				cancel()
			}
			if err != nil {
				stop(fmt.Sprintf("send reading %d of %d: %v", n, p.count, err))
				return
			}
			sent := msg.sent
			mu.Lock()
			defer mu.Unlock()
			sent.SentAt = p.now().UTC().Format(timeFormat)
			if werr := p.enc.Encode(sent); werr != nil {
				stop(fmt.Sprintf("write stdout: %v", werr))
				return
			}
			acked++
		}(i + 1)
	}
	wg.Wait()

	// Every goroutine is done: acked and firstErr are settled.
	if firstErr != "" {
		return p.fail(ExitSendFailed, "%s (%d of %d readings acknowledged)", firstErr, acked, p.count)
	}
	if acked < p.count {
		return p.fail(ExitSendFailed, "interrupted after %d of %d readings (%d acknowledged)", started, p.count, acked)
	}
	return ExitOK
}

// sendTimeout bounds one blocking send.
const sendTimeout = 30 * time.Second

// Sender publishes readings as one device. CookID and CorrelationID, when
// set, ride on every reading as the Pi's do: the payload's cookId and the
// correlation.id message property.
type Sender struct {
	Client        Client
	DeviceID      string
	Tracer        trace.Tracer
	CookID        *string
	CorrelationID string
	// Clock times the 30s bound on a blocking send; nil is clock.Real().
	Clock clock.Clock
}

func (s Sender) clock() clock.Clock {
	if s.Clock == nil {
		return clock.Real()
	}
	return s.Clock
}

// prepared is one reading ready to publish: its payload and properties, the
// stdout line it earns once acknowledged (without SentAt), and its span.
type prepared struct {
	payload []byte
	props   map[string]string
	sent    Sent
	ctx     context.Context
	span    trace.Span
}

// Prepare builds one reading's payload and properties with the shared publish
// builders, inside a fresh per-reading root span so the message carries its
// own traceparent, as the Pi's do. The caller ends the span once the reading
// is acknowledged (or has failed).
func (s Sender) Prepare(ctx context.Context, status wire.V1Status, ts time.Time, seq uint64) (prepared, error) {
	spanCtx, span := s.Tracer.Start(ctx, "simdevice.publish", trace.WithNewRoot())
	payload, err := publish.ReadingPayload(status, ts, s.CookID)
	if err != nil {
		span.End()
		return prepared{}, err
	}
	messageID := publish.MessageID(s.DeviceID, ts, seq)
	return prepared{
		payload: payload,
		props:   publish.Properties(spanCtx, messageID, s.CorrelationID),
		sent:    Sent{MessageID: messageID, DeviceID: s.DeviceID, Timestamp: ts.UTC().Format(timeFormat)},
		ctx:     spanCtx,
		span:    span,
	}, nil
}

// Send prepares one reading and publishes it with the blocking
// PublishTelemetry, the Pi's send. The returned Sent has no SentAt; the
// caller stamps it.
func (s Sender) Send(ctx context.Context, status wire.V1Status, ts time.Time, seq uint64) (Sent, error) {
	msg, err := s.Prepare(ctx, status, ts, seq)
	if err != nil {
		return Sent{}, err
	}
	defer msg.span.End()

	pubCtx, cancel := clock.WithTimeout(msg.ctx, s.clock(), sendTimeout)
	defer cancel()
	if err := s.Client.PublishTelemetry(pubCtx, msg.payload, msg.props); err != nil {
		return Sent{}, err
	}
	return msg.sent, nil
}

// SyntheticStatus returns a plausible V1 status for the i-th reading of a run:
// a pit holding near 225°F and two probes climbing, the rest unplugged.
func SyntheticStatus(deviceID string, i int) wire.V1Status {
	round := func(v float64) *float64 { r := math.Round(v*10) / 10; return &r }
	return wire.V1Status{
		SmokerID:    deviceID,
		Type:        "status",
		Mode:        "smoke",
		SetPoint:    225,
		FireHealthy: true,
		AugerOn:     i%2 == 0,
		BlowerOn:    true,
		Temps: wire.V1Temps{
			GrillTemp:  round(225 + 4*math.Sin(float64(i)/3)),
			Probe1Temp: round(150 + 0.5*float64(i)),
			Probe2Temp: round(140 + 0.4*float64(i)),
		},
	}
}

// newRedactor returns a function that replaces the connection string, and its
// SharedAccessKey value, wherever either appears in s.
func newRedactor(connStr string) func(string) string {
	var secrets []string
	if strings.TrimSpace(connStr) != "" {
		secrets = append(secrets, connStr, strings.TrimSpace(connStr))
	}
	for _, part := range strings.Split(connStr, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) == 2 && strings.TrimSpace(kv[0]) == "SharedAccessKey" {
			if k := strings.TrimSpace(kv[1]); k != "" {
				secrets = append(secrets, k)
			}
		}
	}
	return func(s string) string {
		for _, sec := range secrets {
			s = strings.ReplaceAll(s, sec, "[REDACTED]")
		}
		return s
	}
}

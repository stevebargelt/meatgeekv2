// Package simdevice is a software IoT Hub device for dev: it sends synthetic
// temperature readings as one device, built and published through exactly the
// code the data-pusher on the Pi uses (internal/publish for the payload and
// message properties, an iothub client for the MQTT send). The cmd/simdevice
// binary is a thin wrapper around Main.
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
	ExitSendFailed = 1
	ExitUsage      = 2
)

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
	Tracer    trace.Tracer
	Now       func() time.Time
}

// Main runs the command and returns its exit code. Nothing but one JSON line
// per sent message goes to Stdout. No path writes the connection string or
// its key anywhere: errors go through a redactor before reaching Stderr.
func Main(ctx context.Context, env Env) int {
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
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: simdevice [--count N] [--interval DURATION] [--inflight N]\n"+
			"Sends synthetic readings as the IoT Hub device named by $%s.\n", EnvConnectionString)
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
	if *count < 1 {
		return fail(ExitUsage, "--count must be at least 1, got %d", *count)
	}
	if *interval < 0 {
		return fail(ExitUsage, "--interval must not be negative, got %s", *interval)
	}
	if *inflight < 1 {
		return fail(ExitUsage, "--inflight must be at least 1, got %d", *inflight)
	}

	if strings.TrimSpace(connStr) == "" {
		return fail(ExitUsage, "%s is not set; export the device's IoT Hub connection string in it", EnvConnectionString)
	}
	parsed, err := iothub.ParseDeviceConnectionString(connStr)
	if err != nil {
		return fail(ExitUsage, "%s is not a valid device connection string: %v", EnvConnectionString, err)
	}
	client, err := env.NewClient(connStr)
	if err != nil {
		return fail(ExitUsage, "create IoT Hub client: %v", err)
	}
	defer client.Close()

	tracer := env.Tracer
	if tracer == nil {
		tracer = otel.Tracer("meatgeek-simdevice")
	}
	sender := Sender{Client: client, DeviceID: parsed.DeviceID, Tracer: tracer}
	enc := json.NewEncoder(env.Stdout)
	now := env.Now
	if now == nil {
		now = time.Now
	}
	// Millisecond timestamps, strictly increasing within the run, so the
	// stdout `timestamp` equals the payload's and every reading is distinct.
	var last time.Time
	nextTimestamp := func() time.Time {
		ts := now().UTC().Truncate(time.Millisecond)
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
			next:     nextTimestamp,
			now:      now,
			enc:      enc,
			fail:     fail,
		})
	}

	for i := 0; i < *count; i++ {
		if i > 0 && *interval > 0 {
			select {
			case <-ctx.Done():
				return fail(ExitSendFailed, "interrupted after %d of %d readings", i, *count)
			case <-time.After(*interval):
			}
		}
		ts := nextTimestamp()

		sent, err := sender.Send(ctx, SyntheticStatus(parsed.DeviceID, i), ts, uint64(i+1))
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

// pipeline is what runPipelined needs from Main.
type pipeline struct {
	sender   Sender
	count    int
	interval time.Duration
	inflight int
	next     func() time.Time // the next reading's timestamp
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
			if d := p.interval - time.Since(lastStart); d > 0 {
				timer := time.NewTimer(d)
				select {
				case <-ctx.Done():
					timer.Stop()
					break loop
				case <-stopped:
					timer.Stop()
					break loop
				case <-timer.C:
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
		lastStart = time.Now()
		started++

		msg, err := p.sender.Prepare(ctx, SyntheticStatus(p.sender.DeviceID, i), p.next(), uint64(i+1))
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
				retryCtx, cancel := context.WithTimeout(msg.ctx, 30*time.Second)
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

// Sender publishes readings as one device.
type Sender struct {
	Client   Client
	DeviceID string
	Tracer   trace.Tracer
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
	payload, err := publish.ReadingPayload(status, ts, nil)
	if err != nil {
		span.End()
		return prepared{}, err
	}
	messageID := publish.MessageID(s.DeviceID, ts, seq)
	return prepared{
		payload: payload,
		props:   publish.Properties(spanCtx, messageID, ""),
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

	pubCtx, cancel := context.WithTimeout(msg.ctx, 30*time.Second)
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

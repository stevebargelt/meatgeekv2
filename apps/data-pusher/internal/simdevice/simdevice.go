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
// *iothub.AzureClient and *iothub.MockClient satisfy it.
type Client interface {
	PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error
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
	interval := fs.Duration("interval", 0, "gap between sends (Go duration, e.g. 500ms, 2s)")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: simdevice [--count N] [--interval DURATION]\n"+
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
	var last time.Time
	for i := 0; i < *count; i++ {
		if i > 0 && *interval > 0 {
			select {
			case <-ctx.Done():
				return fail(ExitSendFailed, "interrupted after %d of %d readings", i, *count)
			case <-time.After(*interval):
			}
		}
		// Millisecond timestamps, strictly increasing within the run, so the
		// stdout `timestamp` equals the payload's and every reading is distinct.
		ts := now().UTC().Truncate(time.Millisecond)
		if !ts.After(last) {
			ts = last.Add(time.Millisecond)
		}
		last = ts

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

// Sender publishes readings as one device.
type Sender struct {
	Client   Client
	DeviceID string
	Tracer   trace.Tracer
}

// Send builds one reading's payload and properties with the shared publish
// builders and publishes it, inside a fresh per-reading root span so the
// message carries its own traceparent, as the Pi's do. The returned Sent has
// no SentAt; the caller stamps it.
func (s Sender) Send(ctx context.Context, status wire.V1Status, ts time.Time, seq uint64) (Sent, error) {
	spanCtx, span := s.Tracer.Start(ctx, "simdevice.publish", trace.WithNewRoot())
	defer span.End()

	payload, err := publish.ReadingPayload(status, ts, nil)
	if err != nil {
		return Sent{}, err
	}
	messageID := publish.MessageID(s.DeviceID, ts, seq)
	props := publish.Properties(spanCtx, messageID, "")

	pubCtx, cancel := context.WithTimeout(spanCtx, 30*time.Second)
	defer cancel()
	if err := s.Client.PublishTelemetry(pubCtx, payload, props); err != nil {
		return Sent{}, err
	}
	return Sent{MessageID: messageID, DeviceID: s.DeviceID, Timestamp: ts.UTC().Format(timeFormat)}, nil
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

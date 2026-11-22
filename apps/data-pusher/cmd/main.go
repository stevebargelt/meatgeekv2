// Command meatgeek-pusher is the data-pusher service. It polls the
// local device-controller, maps each reading V1 -> V2, persists it to a
// disk-backed FIFO queue, and drains the queue to Azure IoT Hub. The active
// cook comes from the IoT Hub device twin: its desired properties carry the
// cook id and correlation id, which ride on every outbound reading (the
// `cookId` body field and the `correlation.id` message property).
//
// Architectural model (ticket #5): single-writer-through-queue.
//
//	[collector] --samples--> [enqueuer] --bytes--> [queue.Queue] --bytes--> [publisher] --> iothub.AzureClient
//	                              ^                                                              |
//	                              | Snapshot                         one MQTT connection: telemetry + twin
//	                              |                                                              |
//	                       cooksession.Store <------ApplyDesired------ [twin: GET on connect, desired patches]
//
// The collector is a pure producer; the publisher is the sole writer of
// telemetry. Cook-session state lives only in cooksession.Store (persisted,
// so a boot with no network still stamps the last cook); the twin is its only
// writer, and the enqueuer reads both ids in one snapshot. The IoT Hub client
// connects at startup and stays connected, so desired patches arrive while the
// device is idle; every (re)connect re-reads the twin, which is how a device
// that was offline when a cook started picks it up (HAR-58).
//
// The device authenticates to IoT Hub in one of two modes: DPS mode
// (MEATGEEK_DPS_ID_SCOPE set), where it creates its own X.509 identity,
// registers with the Device Provisioning Service and connects with its
// certificate; or connection-string mode (IOTHUB_CONNECTION_STRING set). The
// subcommand `meatgeek-pusher identity init` creates the identity and prints
// only its certificate. In DPS mode the device also mints a claim code, keeps
// it under the state dir and reports only its hash in the twin (goal HAR-130);
// `meatgeek-pusher claim-code` prints the current code.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/collector"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/dpsmode"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/publish"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

var (
	Version   = "dev"
	BuildTime = "unknown"
)

// defaultQueueDir is the production root for the disk-backed queue.
// Mirrors cooksession.DefaultStatePath's neighborhood so an operator can
// `chown meatgeek-pusher /var/lib/meatgeek-pusher` once and have both
// pieces of state co-located.
const defaultQueueDir = "/var/lib/meatgeek-pusher/queue"

// publishPollInterval is how long the publisher waits between Peek
// attempts when the queue is empty. Small enough that a fresh enqueue is
// drained promptly, large enough that an idle pusher does not burn CPU.
const publishPollInterval = 100 * time.Millisecond

// publishRetryDelay is the backoff between failed publish attempts when
// the queue still has the same record at the head.
const publishRetryDelay = 2 * time.Second

type Config struct {
	DeviceURL     string
	IoTHubConnStr string
	// DPS is DPS mode's configuration; DPS.IDScope set turns it on.
	DPS                  dpsmode.Config
	PollInterval         time.Duration
	Debug                bool
	MockIoT              bool
	MockDeviceID         string
	QueueDir             string
	CookSessionStatePath string
}

func main() {
	// The subcommands own stdout: they run before anything else can write
	// there.
	if code, ok := subcommand(os.Args[1:], os.Getenv, os.Stdout, os.Stderr, clock.Real()); ok {
		os.Exit(code)
	}

	config := loadConfig(os.Args[1:], os.Getenv)
	setupLogging(config.Debug)

	logrus.WithFields(logrus.Fields{
		"version":   Version,
		"buildTime": BuildTime,
	}).Info("Starting MeatGeek Data Pusher")

	ctx := context.Background()
	shutdown, err := telemetry.SetupTracing(ctx)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to set up tracing")
	}
	defer shutdown()

	tracer := otel.Tracer("meatgeek-pusher")

	if err := run(ctx, config, tracer); err != nil {
		logrus.WithError(err).Fatal("Service failed")
	}

	logrus.Info("MeatGeek Data Pusher stopped")
}

// subcommand runs `identity init` (prints only the certificate) or
// `claim-code` (only reads the claim file and prints one JSON line) when args
// name one, and returns its exit code; ok is false for the service itself.
func subcommand(args []string, getenv func(string) string, stdout, stderr io.Writer, clk clock.Clock) (code int, ok bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "identity":
		return dpsmode.IdentityCommand("meatgeek-pusher", args[1:], getenv, stdout, stderr, clk), true
	case "claim-code":
		return dpsmode.ClaimCodeCommand("meatgeek-pusher", args[1:], getenv, stdout, stderr, clk), true
	}
	return 0, false
}

// loadConfig reads the configuration from flags, each defaulting to its
// environment variable; DPS mode is configured by environment only. It exits
// on a flag error, as flag.Parse does.
func loadConfig(args []string, getenv func(string) string) Config {
	config := Config{}
	env := envReader(getenv)
	fs := flag.NewFlagSet("meatgeek-pusher", flag.ExitOnError)

	fs.StringVar(&config.DeviceURL, "device-url",
		env.String("DEVICE_URL", "http://localhost:3000"),
		"Device controller URL")

	fs.StringVar(&config.IoTHubConnStr, "iothub-connection-string",
		env.String("IOTHUB_CONNECTION_STRING", ""),
		"Per-device Azure IoT Hub connection string (HostName=...;DeviceId=...;SharedAccessKey=...)")

	fs.DurationVar(&config.PollInterval, "poll-interval",
		env.Duration("POLL_INTERVAL", 5*time.Second),
		"Polling interval for device data")

	fs.BoolVar(&config.Debug, "debug",
		env.Bool("DEBUG", false),
		"Enable debug logging")

	fs.BoolVar(&config.MockIoT, "mock-iot",
		env.Bool("MOCK_IOT", false),
		"Use mock IoT Hub client (for development)")

	fs.StringVar(&config.MockDeviceID, "mock-device-id",
		env.String("MOCK_DEVICE_ID", "meatgeek-mock"),
		"Device id used when --mock-iot is set (production sourced from the conn-string)")

	fs.StringVar(&config.QueueDir, "queue-dir",
		env.String("QUEUE_DIR", defaultQueueDir),
		"Directory for the disk-backed outbound queue")

	fs.StringVar(&config.CookSessionStatePath, "cooksession-state-path",
		env.String("COOKSESSION_STATE_PATH", cooksession.DefaultStatePath),
		"Path to the persisted cook-session state file")

	config.DPS = dpsmode.Config{
		IDScope:  env.String(dpsmode.EnvIDScope, ""),
		DeviceID: env.String(dpsmode.EnvDeviceID, ""),
		Endpoint: env.String(dpsmode.EnvEndpoint, provision.DefaultEndpoint),
		StateDir: env.String(dpsmode.EnvStateDir, dpsmode.DefaultStateDir),
	}

	_ = fs.Parse(args)

	return config
}

// iotMode is how the pusher reaches IoT Hub.
type iotMode int

const (
	modeMock iotMode = iota
	modeConnectionString
	modeDPS
)

// errBothModes is the refusal when both modes are configured.
var errBothModes = fmt.Errorf("both %s and IOTHUB_CONNECTION_STRING are set; set only one: %s for DPS mode (the device's own certificate), or IOTHUB_CONNECTION_STRING for connection-string mode", dpsmode.EnvIDScope, dpsmode.EnvIDScope)

// iotMode decides the mode, or refuses the configuration.
func (c Config) iotMode() (iotMode, error) {
	if c.DPS.Enabled() && c.IoTHubConnStr != "" {
		return 0, errBothModes
	}
	switch {
	case c.MockIoT:
		return modeMock, nil
	case c.DPS.Enabled():
		if err := c.DPS.Validate(); err != nil {
			return 0, fmt.Errorf("DPS mode: %w", err)
		}
		return modeDPS, nil
	case c.IoTHubConnStr != "":
		return modeConnectionString, nil
	default:
		return 0, errors.New("IoT Hub connection string is required when not using --mock-iot (or set " + dpsmode.EnvIDScope + " and " + dpsmode.EnvDeviceID + " for DPS mode)")
	}
}

func setupLogging(debug bool) {
	logrus.SetFormatter(&logrus.JSONFormatter{
		TimestampFormat: time.RFC3339,
	})

	if debug {
		logrus.SetLevel(logrus.DebugLevel)
	} else {
		logrus.SetLevel(logrus.InfoLevel)
	}
}

// queueRecord is the on-the-wire envelope the enqueuer writes and the
// publisher reads. It carries the rendered TemperatureReading payload
// plus the metadata the publisher needs to mint a deterministic
// IoT Hub message id and stamp the correlation property.
type queueRecord struct {
	Timestamp   time.Time `json:"ts"`
	Seq         uint64    `json:"seq"`
	Correlation string    `json:"corr,omitempty"`
	// Traceparent is the W3C trace context of the per-reading span opened at
	// enqueue time. It is persisted INTO the record (and thus to disk) so the
	// publish span can continue the same per-reading trace even after a process
	// restart between enqueue and publish. Empty for legacy records; the
	// publisher then starts its span from the process context (F3).
	Traceparent string          `json:"tp,omitempty"`
	Payload     json.RawMessage `json:"payload"`
}

// startReadingSpan opens the per-reading `reading.enqueue` span as a
// CONTINUATION of the trace the collector began at poll time. sampleTraceparent
// is the `collector.poll` span's W3C trace context, captured on the Sample; the
// same context was injected onto the device-controller request, so continuing
// from it keeps ONE trace id spanning poll -> device request -> queue record ->
// publish -> IoT message per reading (MG-33 F2).
//
// It deliberately does NOT use trace.WithNewRoot: a new root would mint a
// second, disconnected trace id per reading (the F2 bug). Per-reading isolation
// is instead preserved upstream — the collector starts a fresh `collector.poll`
// span every tick, so each reading already rides its own trace. When
// sampleTraceparent is empty (no-op tracing / legacy), ContextFromTraceparent
// returns ctx unchanged and the span descends from ctx.
func startReadingSpan(ctx context.Context, tracer trace.Tracer, sampleTraceparent string) (context.Context, trace.Span) {
	parent := telemetry.ContextFromTraceparent(ctx, sampleTraceparent)
	return tracer.Start(parent, "reading.enqueue")
}

func run(ctx context.Context, config Config, tracer trace.Tracer) error {
	// No long-lived process-scoped span is opened here. Rooting every worker's
	// work in a single "main.run" span is exactly what produced one giant
	// trace per process lifetime (F3). Instead, each reading opens its own
	// ROOT span at enqueue time (a per-reading trace), the publisher continues
	// that trace from the persisted traceparent, and the collector's poll spans
	// — started from this span-less ctx — become their own roots per poll.

	logrus.WithFields(logrus.Fields{
		"deviceURL":    config.DeviceURL,
		"pollInterval": config.PollInterval,
		"mockIoT":      config.MockIoT,
		"queueDir":     config.QueueDir,
	}).Info("Starting data collection service")

	// Cook session store: the twin writes it, the enqueuer reads it. Falls
	// back to a user-home path if the configured path is not writable, so
	// this works under `go run`.
	sess, err := cooksession.Open(config.CookSessionStatePath)
	if err != nil {
		return fmt.Errorf("open cook session store: %w", err)
	}
	loaded := sess.Snapshot()
	logrus.WithFields(logrus.Fields{
		"cookId":                derefOrEmpty(loaded.CookID),
		"correlationId":         derefOrEmpty(loaded.CorrelationID),
		"appliedDesiredVersion": loaded.AppliedDesiredVersion,
		"statePath":             sess.Path(),
	}).Info("Cook session loaded")

	// Graceful shutdown plumbing.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// IoT Hub client. The deviceId source is the connection string in
	// production; for --mock-iot it falls back to the configured mock id.
	var (
		iotClient interface {
			PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error
			Close() error
		}
		deviceID string
	)

	mode, err := config.iotMode()
	if err != nil {
		return err
	}
	if mode == modeMock {
		logrus.Info("Using mock IoT Hub client for development (no device twin: the cook session keeps its persisted state)")
		iotClient = iothub.NewMockClient()
		deviceID = config.MockDeviceID
	} else {
		azureClient, err := newIoTHubClient(config, mode, sess, clock.Real(), nil)
		if err != nil {
			return fmt.Errorf("failed to create IoT Hub client: %w", err)
		}
		// Connect now and stay connected, so desired patches arrive while
		// the device is idle and the twin GET on connect reconciles the cook.
		azureClient.Start(ctx)
		iotClient = azureClient
		deviceID = azureClient.DeviceID()
	}
	defer func() {
		if err := iotClient.Close(); err != nil {
			logrus.WithError(err).Warn("iothub: close returned error")
		}
	}()

	if deviceID == "" {
		return fmt.Errorf("deviceId resolved to empty string (mock or conn-string misconfigured)")
	}

	// Disk-backed outbound queue. The dir must exist; cooksession's
	// resolveWritablePath helper isn't shared, so we mkdir here directly.
	if err := os.MkdirAll(config.QueueDir, 0o755); err != nil {
		// Per the architect's note on operator-friendly fallback, if the
		// configured dir isn't writable (typical under `go run` as a
		// non-root user), fall back to a temp dir within the user's home.
		home, herr := os.UserHomeDir()
		if herr != nil {
			return fmt.Errorf("mkdir queue dir %s: %w", config.QueueDir, err)
		}
		fallback := filepath.Join(home, ".meatgeek-pusher", "queue")
		if mkErr := os.MkdirAll(fallback, 0o755); mkErr != nil {
			return fmt.Errorf("mkdir fallback queue dir %s: %w", fallback, mkErr)
		}
		logrus.WithFields(logrus.Fields{
			"requested": config.QueueDir,
			"fallback":  fallback,
		}).Warn("queue dir not writable, falling back to user-home location")
		config.QueueDir = fallback
	}
	q, err := queue.Open(config.QueueDir, queue.Options{})
	if err != nil {
		return fmt.Errorf("open queue: %w", err)
	}
	defer func() {
		if err := q.Close(); err != nil {
			logrus.WithError(err).Warn("queue: close returned error")
		}
	}()

	// Collector.
	tempCollector, err := collector.New(config.DeviceURL, config.PollInterval, tracer)
	if err != nil {
		return fmt.Errorf("failed to create temperature collector: %w", err)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigChan
		logrus.WithField("signal", sig.String()).Info("Received shutdown signal")
		cancel()
	}()

	var wg sync.WaitGroup

	// Goroutine 1: collector producer. Closes its samples channel on
	// shutdown, which terminates the enqueuer goroutine cleanly.
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := tempCollector.Start(ctx); err != nil && ctx.Err() == nil {
			logrus.WithError(err).Error("collector exited unexpectedly")
		}
	}()

	// Goroutine 2: enqueuer. Drains the collector's Samples channel and
	// writes each reading to the queue with the cook session current at
	// collection time.
	wg.Add(1)
	go func() {
		defer wg.Done()
		runEnqueuer(ctx, tempCollector.Samples(), sess, q, deviceID, tracer)
	}()

	// Goroutine 3: publisher. Drains the queue, mints messageId, stamps
	// IoT Hub message properties, publishes. Failure to publish does NOT
	// Ack — the record sits at the head and is retried after a delay.
	wg.Add(1)
	go func() {
		defer wg.Done()
		runPublisher(ctx, q, iotClient, deviceID, tracer)
	}()

	// Wait for ctx cancellation. The collector closes its samples
	// channel on ctx.Done(); that drains the enqueuer; the publisher
	// loop exits on ctx.Done() but only after attempting one more pass.
	<-ctx.Done()
	logrus.Info("Shutting down gracefully...")

	// Wait for all goroutines to finish. The deferred q.Close() then
	// flushes pending fsyncs durably.
	wg.Wait()

	logrus.Info("All workers stopped")
	return nil
}

// newIoTHubClient builds the IoT Hub client for the connection-string or DPS
// mode, with the device twin writing sess. In DPS mode clk times every wait
// and provOpts go to the DPS client; opts go to the IoT Hub client (tests point
// both at fakes).
func newIoTHubClient(config Config, mode iotMode, sess iothub.CookState, clk clock.Clock, provOpts []provision.Option, opts ...iothub.Option) (*iothub.AzureClient, error) {
	opts = append(opts, iothub.WithCookTwin(sess))
	if mode == modeDPS {
		logrus.WithFields(logrus.Fields{
			"deviceId":    config.DPS.DeviceID,
			"dpsEndpoint": config.DPS.Endpoint,
			"stateDir":    config.DPS.StateDir,
		}).Info("DPS mode: the device's own X.509 certificate, hub assigned by the Device Provisioning Service")
		return dpsmode.NewClient(config.DPS, clk, provOpts, opts...)
	}
	return iothub.NewAzureClient(config.IoTHubConnStr, opts...)
}

// runEnqueuer drains samples until the channel closes. Each reading is mapped
// V1->V2 with the cook id and correlation id from ONE cooksession snapshot
// taken at enqueue time, so both always come from the same applied twin
// version, and is written to q.
func runEnqueuer(ctx context.Context, samples <-chan collector.Sample, sess *cooksession.Store, q *queue.Queue, deviceID string, tracer trace.Tracer) {
	for sample := range samples {
		// CONTINUE the per-reading trace that began at poll time (see
		// startReadingSpan): the collector captured its `collector.poll`
		// span's traceparent onto the Sample and injected the SAME context
		// onto the device-controller request, so continuing from it keeps
		// ONE trace id across poll -> device -> queue -> publish -> IoT.
		readingCtx, readingSpan := startReadingSpan(ctx, tracer, sample.Traceparent)

		snap := sess.Snapshot()
		rec, mErr := buildQueueRecord(readingCtx, sample.Status, sample.Timestamp, snap.CookID, q.NextSeq(), derefOrEmpty(snap.CorrelationID))
		if mErr != nil {
			logrus.WithError(mErr).Error("build queue record failed; dropping sample")
			readingSpan.End()
			continue
		}
		readingSpan.SetAttributes(telemetry.Dimensions{
			DeviceID:       deviceID,
			CookID:         cookIDFromPayload(rec.Payload),
			CorrelationID:  rec.Correlation,
			ProcessingPath: "reading-enqueue",
		}.Attributes()...)
		recBytes, mErr := json.Marshal(rec)
		if mErr != nil {
			logrus.WithError(mErr).Error("marshal queueRecord failed; dropping sample")
			readingSpan.End()
			continue
		}
		if eErr := q.Enqueue(recBytes); eErr != nil {
			logrus.WithError(eErr).Error("queue.Enqueue failed; dropping sample")
		}
		readingSpan.End()
	}
	logrus.Info("enqueuer: samples channel closed, exiting")
}

// buildQueueRecord renders one collected reading into the queue record the
// enqueuer persists: the TemperatureReading payload (built by the shared
// publish.ReadingPayload, the same builder simdevice uses) plus the metadata
// the publisher needs. readingCtx is the per-reading span's context; its
// traceparent is persisted INTO the record so the publish span (even after a
// restart/recover) continues the same per-reading trace.
func buildQueueRecord(readingCtx context.Context, status wire.V1Status, ts time.Time, cookID *string, seq uint64, correlation string) (queueRecord, error) {
	payload, err := publish.ReadingPayload(status, ts, cookID)
	if err != nil {
		return queueRecord{}, err
	}
	return queueRecord{
		Timestamp:   ts,
		Seq:         seq,
		Correlation: correlation,
		Traceparent: telemetry.ExtractTraceparent(readingCtx),
		Payload:     payload,
	}, nil
}

// cookIDFromPayload best-effort extracts the cookId from a rendered
// TemperatureReading payload so it can be stamped as the cook.id custom
// dimension. Returns "" when the payload is unparseable or cookId is
// absent (the V2 nullable behavior); dimension stamping is non-critical
// so parse failure is swallowed rather than dropping the publish.
func cookIDFromPayload(payload json.RawMessage) string {
	var reading struct {
		CookID *string `json:"cookId"`
	}
	if err := json.Unmarshal(payload, &reading); err != nil {
		return ""
	}
	if reading.CookID == nil {
		return ""
	}
	return *reading.CookID
}

// runPublisher drains the queue head-first, publishing each record and
// only Ack'ing on success. On publish failure the record stays at the
// head; the loop sleeps publishRetryDelay before trying again. On a fully
// empty queue the loop polls every publishPollInterval.
func runPublisher(
	ctx context.Context,
	q *queue.Queue,
	client interface {
		PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error
		Close() error
	},
	deviceID string,
	tracer trace.Tracer,
) {
	for {
		if ctx.Err() != nil {
			return
		}

		id, payload, ok := q.Peek()
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-time.After(publishPollInterval):
				continue
			}
		}

		var rec queueRecord
		if err := json.Unmarshal(payload, &rec); err != nil {
			// Unparseable record: Ack to skip rather than block forever.
			logrus.WithError(err).
				WithField("queueId", id).
				Error("publisher: skipping unparseable record")
			if aErr := q.Ack(id); aErr != nil {
				logrus.WithError(aErr).Error("publisher: Ack after skip failed")
			}
			continue
		}

		// Continue the per-reading trace persisted at enqueue time. The stored
		// traceparent rode on disk, so this linkage survives a process restart
		// between enqueue and publish: the publish span shares the reading's
		// trace id rather than descending from the long-lived process span.
		// When the record carries no traceparent (legacy), parentCtx == ctx.
		parentCtx := telemetry.ContextFromTraceparent(ctx, rec.Traceparent)

		// Start a per-record publish span within that per-reading trace. Its
		// context is what we inject as the W3C traceparent property, so the IoT
		// Hub message carries a traceparent tied to the reading that produced
		// it (not the process span). span.End fires on every loop-continue path.
		publishCtx, span := tracer.Start(parentCtx, "publisher.publish")

		messageID := publish.MessageID(deviceID, rec.Timestamp, rec.Seq)
		props := publish.Properties(publishCtx, messageID, rec.Correlation)
		// Stamp the six standard custom dimensions on the span so the
		// exported trace is pivotable on device/cook/correlation/path.
		span.SetAttributes(telemetry.Dimensions{
			DeviceID:       deviceID,
			CookID:         cookIDFromPayload(rec.Payload),
			CorrelationID:  rec.Correlation,
			ProcessingPath: "queue-publish",
		}.Attributes()...)

		timeoutCtx, cancel := context.WithTimeout(publishCtx, 30*time.Second)
		err := client.PublishTelemetry(timeoutCtx, rec.Payload, props)
		cancel()
		span.End()

		if err != nil {
			logrus.WithError(err).
				WithField("messageId", messageID).
				Warn("publisher: PublishTelemetry failed, will retry")
			select {
			case <-ctx.Done():
				return
			case <-time.After(publishRetryDelay):
				continue
			}
		}

		if aErr := q.Ack(id); aErr != nil {
			logrus.WithError(aErr).
				WithField("queueId", id).
				Error("publisher: Ack failed")
		}
	}
}

// derefOrEmpty returns the dereferenced string or "" so log fields stay
// printable when the cook id is nil.
func derefOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// envReader reads configuration from an environment lookup.
type envReader func(string) string

func (e envReader) String(key, defaultValue string) string {
	if value := e(key); value != "" {
		return value
	}
	return defaultValue
}

func (e envReader) Bool(key string, defaultValue bool) bool {
	if value := e(key); value != "" {
		return value == "true" || value == "1"
	}
	return defaultValue
}

func (e envReader) Duration(key string, defaultValue time.Duration) time.Duration {
	if value := e(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}

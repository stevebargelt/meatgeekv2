// Command meatgeek-pusher is the data-pusher service. It polls the
// local device-controller, maps each reading V1 -> V2, persists it to a
// disk-backed FIFO queue, and drains the queue to Azure IoT Hub. A
// SignalR consumer (when configured) drives cook-session lifecycle
// updates that ride as IoT Hub message properties on outbound telemetry.
//
// Architectural model (ticket #5): single-writer-through-queue.
//
//	[collector] --samples--> [enqueuer] --bytes--> [queue.Queue] --bytes--> [publisher] --> iothub.Client
//	                              ^                                              ^
//	                              |                                              |
//	                       cooksession.Store <--SetActiveCookID-- [signalr consumer]
//
// The collector is a pure producer; the publisher is the sole writer to
// IoT Hub. Cook-session state lives only in cooksession.Store, removing
// the race window the previous design had between in-flight polls and
// SetActiveCook mutations.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/collector"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/cooksession"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/queue"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/signalr"
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
	DeviceURL            string
	IoTHubConnStr        string
	PollInterval         time.Duration
	Debug                bool
	MockIoT              bool
	MockDeviceID         string
	SignalRHubURL        string
	APIBaseURL           string
	QueueDir             string
	CookSessionStatePath string
}

func main() {
	config := parseFlags()
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

func parseFlags() Config {
	config := Config{}

	flag.StringVar(&config.DeviceURL, "device-url",
		getEnvString("DEVICE_URL", "http://localhost:3000"),
		"Device controller URL")

	flag.StringVar(&config.IoTHubConnStr, "iothub-connection-string",
		getEnvString("IOTHUB_CONNECTION_STRING", ""),
		"Per-device Azure IoT Hub connection string (HostName=...;DeviceId=...;SharedAccessKey=...)")

	flag.DurationVar(&config.PollInterval, "poll-interval",
		getEnvDuration("POLL_INTERVAL", 5*time.Second),
		"Polling interval for device data")

	flag.BoolVar(&config.Debug, "debug",
		getEnvBool("DEBUG", false),
		"Enable debug logging")

	flag.BoolVar(&config.MockIoT, "mock-iot",
		getEnvBool("MOCK_IOT", false),
		"Use mock IoT Hub client (for development)")

	flag.StringVar(&config.MockDeviceID, "mock-device-id",
		getEnvString("MOCK_DEVICE_ID", "meatgeek-mock"),
		"Device id used when --mock-iot is set (production sourced from the conn-string)")

	flag.StringVar(&config.SignalRHubURL, "signalr-hub-url",
		getEnvString("SIGNALR_HUB_URL", ""),
		"SignalR hub URL for cook lifecycle events. Empty disables the SignalR consumer; cooksession.Reconcile is then the sole cook-id authority.")

	flag.StringVar(&config.APIBaseURL, "api-base-url",
		getEnvString("API_BASE_URL", ""),
		"V2 API base URL used by cooksession.Reconcile at startup")

	flag.StringVar(&config.QueueDir, "queue-dir",
		getEnvString("QUEUE_DIR", defaultQueueDir),
		"Directory for the disk-backed outbound queue")

	flag.StringVar(&config.CookSessionStatePath, "cooksession-state-path",
		getEnvString("COOKSESSION_STATE_PATH", cooksession.DefaultStatePath),
		"Path to the persisted cook-session state file")

	flag.Parse()

	return config
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

// correlationHolder is a tiny atomic-string holder for the most-recently
// observed SignalR correlation id. The SignalR consumer writes it on
// every cook lifecycle envelope; the enqueuer reads it at the moment a
// new sample is queued so the correlation rides with the reading even
// if the SignalR connection drops between enqueue and publish.
type correlationHolder struct {
	v atomic.Value // string
}

func (h *correlationHolder) Get() string {
	if v := h.v.Load(); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func (h *correlationHolder) Set(s string) {
	h.v.Store(s)
}

func run(ctx context.Context, config Config, tracer trace.Tracer) error {
	// No long-lived process-scoped span is opened here. Rooting every worker's
	// work in a single "main.run" span is exactly what produced one giant
	// trace per process lifetime (F3). Instead, each reading opens its own
	// ROOT span at enqueue time (a per-reading trace), the publisher continues
	// that trace from the persisted traceparent, and the collector's poll spans
	// — started from this span-less ctx — become their own roots per poll.

	logrus.WithFields(logrus.Fields{
		"deviceURL":     config.DeviceURL,
		"pollInterval":  config.PollInterval,
		"mockIoT":       config.MockIoT,
		"signalRHubURL": config.SignalRHubURL,
		"apiBaseURL":    config.APIBaseURL,
		"queueDir":      config.QueueDir,
	}).Info("Starting data collection service")

	// IoT Hub client. The deviceId source is the connection string in
	// production; for --mock-iot it falls back to the configured mock id.
	var (
		iotClient interface {
			PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error
			Close() error
		}
		deviceID string
	)

	if config.MockIoT {
		logrus.Info("Using mock IoT Hub client for development")
		iotClient = iothub.NewMockClient()
		deviceID = config.MockDeviceID
	} else {
		if config.IoTHubConnStr == "" {
			return fmt.Errorf("IoT Hub connection string is required when not using --mock-iot")
		}
		azureClient, err := iothub.NewAzureClient(config.IoTHubConnStr)
		if err != nil {
			return fmt.Errorf("failed to create IoT Hub client: %w", err)
		}
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

	// Cook session store. Falls back to a user-home path if the
	// configured path is not writable, so this works under `go run`.
	sess, err := cooksession.Open(config.CookSessionStatePath)
	if err != nil {
		return fmt.Errorf("open cook session store: %w", err)
	}
	logrus.WithFields(logrus.Fields{
		"cookId":    derefOrEmpty(sess.ActiveCookID()),
		"statePath": sess.Path(),
	}).Info("Cook session loaded")

	// Best-effort startup reconcile against the API. Failure is
	// non-fatal: we proceed with whatever the persisted state holds.
	if config.APIBaseURL != "" {
		reconCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := sess.Reconcile(reconCtx, config.APIBaseURL, deviceID); err != nil {
			logrus.WithError(err).Warn("cooksession: reconcile failed at startup, continuing with persisted state")
		}
		cancel()
	} else {
		logrus.Debug("cooksession: no --api-base-url configured, skipping startup reconcile")
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

	// Correlation context shared between SignalR consumer and enqueuer.
	corr := &correlationHolder{}

	// Graceful shutdown plumbing.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigChan
		logrus.WithField("signal", sig.String()).Info("Received shutdown signal")
		cancel()
	}()

	// SignalR client (optional). When the hub URL is empty we rely on
	// cooksession.Reconcile alone — handles the architect's "producer
	// side does not exist yet" state without leaking a goroutine.
	var sr *signalr.Client
	if config.SignalRHubURL != "" {
		sr = signalr.New(signalr.Options{})
		if err := sr.Connect(ctx, config.SignalRHubURL, deviceID); err != nil {
			logrus.WithError(err).Warn("signalr: Connect failed, continuing without SignalR")
			sr = nil
		}
	} else {
		logrus.Info("signalr: no --signalr-hub-url configured, running without SignalR (cooksession.Reconcile is the only cook-id source)")
	}

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

	// Goroutine 2: enqueuer. Drains the collector's Samples channel,
	// maps V1->V2 with the CURRENT-at-collection-time cookId, snapshots
	// the current correlation id, and writes the bytes to the queue.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for sample := range tempCollector.Samples() {
			// Open a NEW ROOT span for THIS reading so each reading gets its
			// own trace id (a per-reading trace) instead of descending from the
			// long-lived process span. WithNewRoot detaches from any span
			// already carried on ctx, which is what stops the historical
			// one-giant-trace-per-process behavior.
			readingCtx, readingSpan := tracer.Start(ctx, "reading.enqueue", trace.WithNewRoot())

			reading := wire.MapV1ToTemperatureReading(sample.Status, sample.Timestamp, sess.ActiveCookID())
			readingBytes, mErr := json.Marshal(reading)
			if mErr != nil {
				logrus.WithError(mErr).Error("marshal TemperatureReading failed; dropping sample")
				readingSpan.End()
				continue
			}
			rec := queueRecord{
				Timestamp:   sample.Timestamp,
				Seq:         q.NextSeq(),
				Correlation: corr.Get(),
				// Persist THIS reading's traceparent so the publish span (even
				// after a restart/recover) continues the same per-reading trace.
				Traceparent: telemetry.ExtractTraceparent(readingCtx),
				Payload:     readingBytes,
			}
			readingSpan.SetAttributes(telemetry.Dimensions{
				DeviceID:       deviceID,
				CookID:         cookIDFromPayload(readingBytes),
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
	}()

	// Goroutine 3: signalr consumer. Updates cooksession on
	// cook_started/cook_stopped and refreshes the correlation holder.
	if sr != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ev := range sr.Events() {
				if ev.Correlation.ID != "" {
					corr.Set(ev.Correlation.ID)
				}
				switch ev.Type {
				case signalr.EventTypeCookStarted:
					if ev.CookID != nil {
						if err := sess.SetActiveCookID(ev.CookID); err != nil {
							logrus.WithError(err).Error("cooksession: SetActiveCookID failed")
						}
					}
				case signalr.EventTypeCookStopped:
					if err := sess.SetActiveCookID(nil); err != nil {
						logrus.WithError(err).Error("cooksession: clear failed")
					}
				default:
					// cook_paused / cook_resumed: surfaced by the
					// signalr package but not acted on at this layer.
				}
			}
			logrus.Info("signalr consumer: events channel closed, exiting")
		}()
	}

	// Goroutine 4: publisher. Drains the queue, mints messageId, stamps
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

	// Stop SignalR if running (closes the events channel so its
	// consumer goroutine can exit).
	if sr != nil {
		if err := sr.Close(); err != nil {
			logrus.WithError(err).Warn("signalr: Close returned error")
		}
	}

	// Wait for all goroutines to finish. The deferred q.Close() then
	// flushes pending fsyncs durably.
	wg.Wait()

	logrus.Info("All workers stopped")
	return nil
}

// buildPublishProperties assembles the IoT Hub message properties for one
// record: the deterministic messageId, the optional correlation.id
// (carried since #5), and the injected W3C traceparent from the active
// span in ctx. The traceparent lets the downstream Functions/API layers
// continue the distributed trace; correlation.id is retained alongside it.
func buildPublishProperties(ctx context.Context, deviceID, messageID string, rec queueRecord) map[string]string {
	props := map[string]string{
		iothub.MessageIDPropertyName: messageID,
	}
	if rec.Correlation != "" {
		props[iothub.CorrelationIDPropertyName] = rec.Correlation
	}
	// Inject the W3C traceparent (and any tracestate) from the publish
	// span. When tracing is in no-op/dev mode with a valid span context,
	// a traceparent is still emitted; with no span it is a no-op.
	telemetry.InjectTraceContext(ctx, props)
	return props
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

		messageID := wire.MintMessageId(deviceID, rec.Timestamp, rec.Seq)
		props := buildPublishProperties(publishCtx, deviceID, messageID, rec)
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

// Helper functions for environment variables.
func getEnvString(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		return value == "true" || value == "1"
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}

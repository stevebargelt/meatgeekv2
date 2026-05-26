// Package collector polls the device-controller's local HTTP API on a fixed
// interval and emits each successful poll's V1Status onto an outbound
// Samples channel.
//
// Architectural note (ticket #5): per the all-through-queue model, the
// collector is a PURE PRODUCER — it never touches IoT Hub directly, never
// owns cook-session state, and never mints message ids. Consumers (the
// main package's queue runner) read from Samples() and own those concerns.
// This decoupling lets the disk-backed queue be the single writer to
// IoT Hub and eliminates the race window the previous design had between
// "set active cook id" and "in-flight poll".
package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel/trace"

	"meatgeek-pusher/internal/wire"
)

// Sample is what the collector emits on each successful poll. The producer
// (collector) is decoupled from the IoT-Hub-bound publisher (queue runner);
// the consumer owns wire mapping, cookId enrichment, and message-id minting.
type Sample struct {
	// Status is the raw V1 shape received from the device-controller. The
	// queue runner is responsible for mapping V1 -> V2 TemperatureReading
	// at enqueue time (so the active cookId is captured at the moment of
	// collection rather than at publish time).
	Status wire.V1Status

	// Timestamp is the wall-clock time the sample was observed by the
	// pusher (UTC). The queue runner threads this into wire.MintMessageId
	// so the message id stays stable across publish retries.
	Timestamp time.Time
}

// gobotCommandResponse is the {"result": "<json-string>"} envelope that
// gobot.io's HTTP API wraps every command handler in. The device-controller's
// get_status handler calls `json.Marshal(SmokerStatus)` and `return string(res)`,
// which gobot then JSON-encodes inside the "result" field, producing a
// JSON-encoded STRING (not a struct). The unwrap path is therefore: decode
// outer envelope -> read .Result -> json.Unmarshal that string into V1Status.
type gobotCommandResponse struct {
	Result string `json:"result"`
}

// Collector polls the device-controller on a fixed interval.
type Collector struct {
	deviceURL    string
	pollInterval time.Duration
	httpClient   *http.Client
	tracer       trace.Tracer
	samples      chan Sample
}

// New constructs a Collector. The samples buffer is small (16) so a slow
// downstream queue runner backpressures the poll loop rather than buffering
// arbitrarily many readings in memory.
func New(deviceURL string, pollInterval time.Duration, tracer trace.Tracer) (*Collector, error) {
	if deviceURL == "" {
		return nil, fmt.Errorf("device URL is required")
	}
	return &Collector{
		deviceURL:    deviceURL,
		pollInterval: pollInterval,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
		tracer:       tracer,
		samples:      make(chan Sample, 16),
	}, nil
}

// Samples returns the channel the collector writes to. It is closed when
// Start returns.
func (c *Collector) Samples() <-chan Sample {
	return c.samples
}

// Start polls until ctx is cancelled. Returns ctx.Err() on shutdown. The
// samples channel is closed on return so downstream consumers can use
// `range` to drive their own shutdown.
func (c *Collector) Start(ctx context.Context) error {
	defer close(c.samples)

	logrus.WithFields(logrus.Fields{
		"deviceURL":    c.deviceURL,
		"pollInterval": c.pollInterval,
	}).Info("Starting temperature collection")

	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	if err := c.pollOnce(ctx); err != nil {
		logrus.WithError(err).Warn("Initial poll failed")
	}

	for {
		select {
		case <-ctx.Done():
			logrus.Info("Temperature collection stopped")
			return ctx.Err()
		case <-ticker.C:
			if err := c.pollOnce(ctx); err != nil {
				logrus.WithError(err).Error("Poll failed")
			}
		}
	}
}

func (c *Collector) pollOnce(ctx context.Context) error {
	ctx, span := c.tracer.Start(ctx, "collector.poll")
	defer span.End()

	status, err := c.fetchDeviceStatus(ctx)
	if err != nil {
		return fmt.Errorf("failed to fetch device status: %w", err)
	}

	sample := Sample{
		Status:    *status,
		Timestamp: time.Now().UTC(),
	}

	select {
	case c.samples <- sample:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *Collector) fetchDeviceStatus(ctx context.Context) (*wire.V1Status, error) {
	ctx, span := c.tracer.Start(ctx, "collector.fetchDeviceStatus")
	defer span.End()

	url := fmt.Sprintf("%s/api/robots/MeatGeekBot/commands/get_status", c.deviceURL)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("device returned status %d", resp.StatusCode)
	}

	return decodeGobotStatus(resp.Body)
}

// decodeGobotStatus performs the two-step unwrap of the device-controller's
// gobot.io HTTP response. Exposed (lowercase but called by the test reader)
// via DecodeGobotStatus so collector_test.go can verify the unwrap against a
// canned response without spinning up an httptest.Server.
func decodeGobotStatus(r interface{ Read(p []byte) (int, error) }) (*wire.V1Status, error) {
	var env gobotCommandResponse
	if err := json.NewDecoder(r).Decode(&env); err != nil {
		return nil, fmt.Errorf("decode gobot envelope: %w", err)
	}
	if env.Result == "" {
		return nil, fmt.Errorf("gobot envelope missing 'result' field")
	}
	var status wire.V1Status
	if err := json.Unmarshal([]byte(env.Result), &status); err != nil {
		return nil, fmt.Errorf("decode V1Status from result string: %w", err)
	}
	return &status, nil
}

// DecodeGobotStatus is the exported entrypoint to decodeGobotStatus used
// by the package tests; production callers go through fetchDeviceStatus.
func DecodeGobotStatus(r interface{ Read(p []byte) (int, error) }) (*wire.V1Status, error) {
	return decodeGobotStatus(r)
}

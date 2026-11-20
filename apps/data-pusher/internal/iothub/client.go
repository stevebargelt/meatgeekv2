package iothub

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/sirupsen/logrus"
)

// CorrelationIDPropertyName is the IoT Hub message-property key used
// to carry the cook/cross-system correlation id on outbound telemetry.
//
// The name is a placeholder per ticket #5's brief — ticket #6 will
// finalize the propagation contract. Keep this constant the single
// rename site for the whole pusher.
const CorrelationIDPropertyName = "correlation.id"

// MessageIDPropertyName is the IoT Hub message-property key used to
// carry the deterministic per-message id minted by the queue runner
// (wire.MintMessageId). Sinks (e.g. CosmosDB) upsert on this id to
// dedupe replays.
const MessageIDPropertyName = "messageId"

// TraceParentPropertyName is the IoT Hub message-property key used to
// carry the W3C Trace Context traceparent (MG-6). The publisher injects
// the active publish span's context here so the downstream Functions/API
// layers can continue the distributed trace. Mirrors
// telemetry.TraceParentKey; kept here so the property contract is visible
// alongside the other IoT Hub property names.
const TraceParentPropertyName = "traceparent"

// ContentTypePropertyName and ContentEncodingPropertyName are the IoT Hub
// SYSTEM property keys for the message body's content type and encoding, in
// the form the MQTT topic property bag uses (MG-68). IoT Hub stores a routed
// body as JSON only when both are set to ContentTypeJSON / ContentEncodingUTF8;
// otherwise the Cosmos route stores the body as a base64 string.
const (
	ContentTypePropertyName     = "$.ct"
	ContentEncodingPropertyName = "$.ce"
	ContentTypeJSON             = "application/json"
	ContentEncodingUTF8         = "utf-8"
)

// systemPropertyPrefix marks IoT Hub system property keys in the topic
// property bag. Their keys go on the wire literally (`$.ct`, never `%24.ct`).
const systemPropertyPrefix = "$."

const (
	defaultSASTokenTTL     = 1 * time.Hour
	defaultConnectTimeout  = 10 * time.Second
	defaultPublishTimeout  = 10 * time.Second
	defaultRefreshMargin   = 5 * time.Minute
	defaultReconnectMin    = 1 * time.Second
	defaultReconnectMax    = 60 * time.Second
	mqttAPIVersion         = "2021-04-12"
	deviceEventTopicPrefix = "devices/"
	deviceEventTopicSuffix = "/messages/events/"
)

// Client publishes opaque telemetry payloads to Azure IoT Hub. The
// queue runner (single-writer) owns the payload-shape and message-id
// concerns; this interface is intentionally byte/string-only.
type Client interface {
	PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error
	Close() error
}

// AzureClient is the paho-MQTT-backed production implementation. One
// AzureClient holds the device's one MQTT connection (IoT Hub allows one per
// device id): telemetry publishes and, when WithCookTwin is set, the device
// twin share it.
type AzureClient struct {
	conn           *DeviceConnectionString
	brokerURL      string
	sasTokenTTL    time.Duration
	connectTimeout time.Duration
	publishTimeout time.Duration
	twinTimeout    time.Duration
	refreshMargin  time.Duration
	reconnectMin   time.Duration
	reconnectMax   time.Duration
	twinState      CookState

	mu         sync.Mutex
	mqttClient mqtt.Client
	sasExpiry  time.Time
	lost       chan struct{} // closed when the current connection drops or is replaced
	markLost   func()
	twin       *twin
	started    bool
	stop       context.CancelFunc
	wg         sync.WaitGroup
}

// Option configures an AzureClient.
type Option func(*AzureClient)

// WithSASTokenTTL overrides the SAS-token lifetime (default 1h).
func WithSASTokenTTL(ttl time.Duration) Option {
	return func(c *AzureClient) {
		if ttl > 0 {
			c.sasTokenTTL = ttl
		}
	}
}

// WithConnectTimeout overrides the MQTT CONNECT timeout (default 10s).
func WithConnectTimeout(d time.Duration) Option {
	return func(c *AzureClient) {
		if d > 0 {
			c.connectTimeout = d
		}
	}
}

// WithPublishTimeout overrides the per-publish ack timeout (default 10s).
func WithPublishTimeout(d time.Duration) Option {
	return func(c *AzureClient) {
		if d > 0 {
			c.publishTimeout = d
		}
	}
}

// WithCookTwin turns on the device twin: on every connect the client
// subscribes to the twin topics, GETs the twin, applies its desired cook to
// state and reports it; desired patches are applied as they arrive. The twin
// runs only while the client is started (Start).
func WithCookTwin(state CookState) Option {
	return func(c *AzureClient) {
		c.twinState = state
	}
}

// WithBrokerURL replaces the broker address, `tls://<HostName>:8883` from the
// connection string. A `tcp://` URL connects without TLS. Tests point it at
// an iothubtest.Broker; production never sets it.
func WithBrokerURL(u string) Option {
	return func(c *AzureClient) {
		if u != "" {
			c.brokerURL = u
		}
	}
}

// WithTwinTimeout overrides how long a twin request (subscribe, GET, reported
// patch) waits for IoT Hub's response (default 30s).
func WithTwinTimeout(d time.Duration) Option {
	return func(c *AzureClient) {
		if d > 0 {
			c.twinTimeout = d
		}
	}
}

// withReconnectBackoff overrides the reconnect backoff bounds (tests).
func withReconnectBackoff(lo, hi time.Duration) Option {
	return func(c *AzureClient) {
		c.reconnectMin, c.reconnectMax = lo, hi
	}
}

// NewAzureClient parses the per-device IoT Hub connection string and
// returns a client ready to publish. Nothing connects until Start (which
// connects at once and stays connected) or, without Start, the first publish.
func NewAzureClient(connectionString string, opts ...Option) (*AzureClient, error) {
	parsed, err := ParseDeviceConnectionString(connectionString)
	if err != nil {
		return nil, err
	}
	c := &AzureClient{
		conn:           parsed,
		brokerURL:      fmt.Sprintf("tls://%s:8883", parsed.HostName),
		sasTokenTTL:    defaultSASTokenTTL,
		connectTimeout: defaultConnectTimeout,
		publishTimeout: defaultPublishTimeout,
		twinTimeout:    defaultTwinTimeout,
		refreshMargin:  defaultRefreshMargin,
		reconnectMin:   defaultReconnectMin,
		reconnectMax:   defaultReconnectMax,
		markLost:       func() {},
	}
	for _, opt := range opts {
		opt(c)
	}
	// A token shorter than twice the margin would be refreshed constantly;
	// refresh such a token halfway through its life instead.
	if c.refreshMargin > c.sasTokenTTL/2 {
		c.refreshMargin = c.sasTokenTTL / 2
	}
	if c.twinState != nil {
		c.twin = newTwin(c.twinState, c.twinTimeout)
	}
	return c, nil
}

// DeviceID returns the deviceId sourced from the per-device connection
// string. Callers (the queue runner, MintMessageId) thread this through
// instead of relying on the hard-coded legacy value.
func (c *AzureClient) DeviceID() string { return c.conn.DeviceID }

// HostName returns the IoT Hub hostname sourced from the connection string.
func (c *AzureClient) HostName() string { return c.conn.HostName }

// Start connects to IoT Hub now and keeps the connection up until ctx is
// done or Close is called: it reconnects (with backoff) when the connection
// drops and reconnects with a fresh SAS token before the current one expires.
// Every connect, including those two, re-establishes the twin subscriptions
// and re-reads the twin. Start returns at once; calling it again is a no-op.
func (c *AzureClient) Start(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started {
		return
	}
	c.started = true
	ctx, c.stop = context.WithCancel(ctx)
	if c.twin != nil {
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.twin.run(ctx)
		}()
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.supervise(ctx)
	}()
}

// supervise is Start's connection loop.
func (c *AzureClient) supervise(ctx context.Context) {
	backoff := c.reconnectMin
	sleep := func(d time.Duration) bool {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		}
	}
	for ctx.Err() == nil {
		c.mu.Lock()
		err := c.ensureConnectedLocked()
		lost, refreshAt := c.lost, c.sasExpiry.Add(-c.refreshMargin)
		c.mu.Unlock()
		if err != nil {
			logrus.WithError(err).WithField("retryIn", backoff.String()).Warn("iothub: connect failed")
			if c.twin != nil {
				c.twin.noteErr(err)
			}
			if !sleep(backoff) {
				return
			}
			backoff = min(backoff*2, c.reconnectMax)
			continue
		}

		connectedAt := time.Now()
		timer := time.NewTimer(time.Until(refreshAt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			// SAS token near expiry: the next ensureConnectedLocked reconnects.
			continue
		case <-lost:
			timer.Stop()
		}
		// The connection dropped. Back off before redialling, unless it had
		// been up long enough to count as healthy.
		if time.Since(connectedAt) >= c.reconnectMax {
			backoff = c.reconnectMin
		}
		if !sleep(backoff) {
			return
		}
		backoff = min(backoff*2, c.reconnectMax)
	}
}

// ensureConnectedLocked makes sure we have a live MQTT session whose SAS
// token is not within the refresh margin (5 minutes) of expiry. Each new
// connection is handed to the twin. Caller must hold c.mu.
func (c *AzureClient) ensureConnectedLocked() error {
	if c.mqttClient != nil && c.mqttClient.IsConnectionOpen() && time.Now().Before(c.sasExpiry.Add(-c.refreshMargin)) {
		return nil
	}
	c.dropLocked()

	sas, expiry, err := GenerateSASToken(c.conn.HostName, c.conn.DeviceID, c.conn.SharedAccessKey, c.sasTokenTTL)
	if err != nil {
		return fmt.Errorf("iothub: mint SAS token: %w", err)
	}

	lost := make(chan struct{})
	var lostOnce sync.Once
	markLost := func() { lostOnce.Do(func() { close(lost) }) }

	opts := mqtt.NewClientOptions().
		AddBroker(c.brokerURL).
		SetClientID(c.conn.DeviceID).
		SetUsername(fmt.Sprintf("%s/%s/?api-version=%s", c.conn.HostName, c.conn.DeviceID, mqttAPIVersion)).
		SetPassword(sas).
		SetProtocolVersion(4).
		SetCleanSession(true).
		SetAutoReconnect(false).
		SetConnectTimeout(c.connectTimeout).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			logrus.WithError(err).Warn("iothub: connection lost")
			markLost()
		}).
		SetTLSConfig(&tls.Config{
			ServerName: c.conn.HostName,
			MinVersion: tls.VersionTLS12,
		})

	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(c.connectTimeout) {
		return fmt.Errorf("iothub: connect to %s timed out after %s", c.brokerURL, c.connectTimeout)
	}
	if err := token.Error(); err != nil {
		return fmt.Errorf("iothub: connect to %s failed: %w", c.brokerURL, err)
	}

	c.mqttClient = client
	c.sasExpiry = expiry
	c.lost = lost
	c.markLost = markLost
	logrus.WithField("sasExpiry", expiry.UTC().Format(time.RFC3339)).Info("iothub: connected")
	if c.twin != nil {
		c.twin.connected(twinConn{client: client, lost: lost})
	}
	return nil
}

// dropLocked closes the current connection, if any. Caller must hold c.mu.
func (c *AzureClient) dropLocked() {
	if c.mqttClient != nil {
		c.mqttClient.Disconnect(250)
		c.mqttClient = nil
	}
	c.markLost()
}

// PublishTelemetry publishes payload to `devices/<deviceId>/messages/events/`
// at QoS 1, attaching `properties` as IoT Hub message properties
// (encoded into the topic per the IoT Hub MQTT convention).
//
// Per-call timeout + a single retry. Durable retry is the queue
// runner's job — we surface failure quickly so the runner can re-Peek
// the same message.
func (c *AzureClient) PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	topic := buildPublishTopic(c.conn.DeviceID, properties)

	publish := func() error {
		c.mu.Lock()
		defer c.mu.Unlock()
		if err := c.ensureConnectedLocked(); err != nil {
			return err
		}
		token := c.mqttClient.Publish(topic, 1, false, payload)
		if !token.WaitTimeout(c.publishTimeout) {
			return fmt.Errorf("iothub: publish to %s timed out after %s", topic, c.publishTimeout)
		}
		return token.Error()
	}

	if err := publish(); err != nil {
		logrus.WithError(err).Warn("iothub: publish failed, retrying once")
		c.mu.Lock()
		c.dropLocked()
		c.mu.Unlock()
		if err2 := publish(); err2 != nil {
			return fmt.Errorf("iothub: publish failed after retry: %w", err2)
		}
	}
	return nil
}

// PublishTelemetryAsync starts the same QoS 1 publish as PublishTelemetry
// (same topic, same connection handling) but returns as soon as the message
// is handed to the MQTT client, without waiting for IoT Hub's PUBACK. The
// returned wait blocks until that acknowledgement arrives, the publish timeout
// (counted from the start) passes, or ctx is done, and returns the outcome.
//
// There is no retry here: the caller decides what to do with a failed
// acknowledgement (simdevice retries once through PublishTelemetry). Several
// async publishes may be in flight on the one connection at once. The Pi's
// queue runner does not use this; it keeps PublishTelemetry's one-at-a-time
// send.
func (c *AzureClient) PublishTelemetryAsync(ctx context.Context, payload []byte, properties map[string]string) (wait func() error, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	topic := buildPublishTopic(c.conn.DeviceID, properties)

	c.mu.Lock()
	if err := c.ensureConnectedLocked(); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	token := c.mqttClient.Publish(topic, 1, false, payload)
	c.mu.Unlock()

	deadline := time.Now().Add(c.publishTimeout)
	return func() error {
		timer := time.NewTimer(time.Until(deadline))
		defer timer.Stop()
		select {
		case <-token.Done():
			return token.Error()
		case <-timer.C:
			return fmt.Errorf("iothub: publish to %s timed out after %s", topic, c.publishTimeout)
		case <-ctx.Done():
			return ctx.Err()
		}
	}, nil
}

// WaitTwinSynced blocks until the twin has been read, applied and reported
// once since the client started, or ctx is done. On ctx it returns an error
// that carries the last twin failure, if any. Requires WithCookTwin.
func (c *AzureClient) WaitTwinSynced(ctx context.Context) error {
	if c.twin == nil {
		return errors.New("iothub: twin not enabled (WithCookTwin)")
	}
	select {
	case <-c.twin.synced:
		return nil
	case <-ctx.Done():
		if last := c.twin.lastError(); last != nil {
			return fmt.Errorf("%w (last twin error: %v)", ctx.Err(), last)
		}
		return ctx.Err()
	}
}

// GetTwin reads the whole twin over the current connection. It does not apply
// anything. Requires WithCookTwin and a started, connected client.
func (c *AzureClient) GetTwin(ctx context.Context) (Twin, error) {
	if c.twin == nil {
		return Twin{}, errors.New("iothub: twin not enabled (WithCookTwin)")
	}
	tw, err := c.twin.get(ctx)
	if err != nil {
		return Twin{}, fmt.Errorf("iothub: twin GET: %w", err)
	}
	return tw, nil
}

// Close stops Start's goroutines and shuts down the MQTT session if one
// exists.
func (c *AzureClient) Close() error {
	c.mu.Lock()
	stop := c.stop
	c.mu.Unlock()
	if stop != nil {
		stop()
	}
	c.wg.Wait()

	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropLocked()
	return nil
}

// buildPublishTopic appends message properties to the device-to-cloud event
// topic per Azure's MQTT convention:
//
//	devices/<deviceId>/messages/events/<k1>=<v1>&<k2>=<v2>&...
//
// Every value is URL-encoded. Application property keys are URL-encoded too,
// but system property keys (`$.ct`, `$.ce`, ...) are written literally: the
// documented form is `$.ct=application%2Fjson&$.ce=utf-8`, and IoT Hub does
// not recognise `%24.ct` as the content-type system property. Pairs are
// sorted by key so the topic is deterministic.
//
// When properties is empty the bare event topic is returned (trailing slash).
func buildPublishTopic(deviceID string, properties map[string]string) string {
	base := deviceEventTopicPrefix + deviceID + deviceEventTopicSuffix
	if len(properties) == 0 {
		return base
	}
	keys := make([]string, 0, len(properties))
	for k := range properties {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(base)
	for i, k := range keys {
		if i > 0 {
			b.WriteByte('&')
		}
		if strings.HasPrefix(k, systemPropertyPrefix) {
			b.WriteString(k)
		} else {
			b.WriteString(url.QueryEscape(k))
		}
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(properties[k]))
	}
	return b.String()
}

// MockClient implements Client by recording each call. The integration
// step uses this to assert end-to-end behavior without real Azure.
type MockClient struct {
	mu    sync.Mutex
	calls []MockPublishCall
}

// MockPublishCall is a recorded PublishTelemetry invocation.
type MockPublishCall struct {
	Payload    []byte
	Properties map[string]string
}

// NewMockClient returns a MockClient with an empty call log.
func NewMockClient() *MockClient { return &MockClient{} }

// PublishTelemetry records the call (deep-copying payload + properties
// so caller-side mutations after the call do not corrupt the log).
func (m *MockClient) PublishTelemetry(_ context.Context, payload []byte, properties map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	payloadCopy := make([]byte, len(payload))
	copy(payloadCopy, payload)
	propsCopy := make(map[string]string, len(properties))
	for k, v := range properties {
		propsCopy[k] = v
	}

	m.calls = append(m.calls, MockPublishCall{Payload: payloadCopy, Properties: propsCopy})

	logrus.WithFields(logrus.Fields{
		MessageIDPropertyName:     properties[MessageIDPropertyName],
		CorrelationIDPropertyName: properties[CorrelationIDPropertyName],
		"payloadBytes":            len(payload),
	}).Debug("iothub: MockClient.PublishTelemetry")
	return nil
}

// PublishTelemetryAsync records the call exactly as PublishTelemetry does
// and returns a wait that reports an immediate acknowledgement.
func (m *MockClient) PublishTelemetryAsync(ctx context.Context, payload []byte, properties map[string]string) (func() error, error) {
	if err := m.PublishTelemetry(ctx, payload, properties); err != nil {
		return nil, err
	}
	return func() error { return nil }, nil
}

// Close is a no-op for MockClient.
func (m *MockClient) Close() error { return nil }

// Calls returns a snapshot of recorded PublishTelemetry calls. Safe
// for concurrent use; the returned slice is a fresh copy.
func (m *MockClient) Calls() []MockPublishCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]MockPublishCall, len(m.calls))
	copy(out, m.calls)
	return out
}

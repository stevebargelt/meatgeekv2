package iothub

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/url"
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

const (
	defaultSASTokenTTL     = 1 * time.Hour
	defaultConnectTimeout  = 10 * time.Second
	defaultPublishTimeout  = 10 * time.Second
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

// AzureClient is the paho-MQTT-backed production implementation.
type AzureClient struct {
	conn           *DeviceConnectionString
	sasTokenTTL    time.Duration
	connectTimeout time.Duration
	publishTimeout time.Duration

	mu         sync.Mutex
	mqttClient mqtt.Client
	sasExpiry  time.Time
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

// NewAzureClient parses the per-device IoT Hub connection string and
// returns a client ready to publish. The MQTT session is connected
// lazily on the first PublishTelemetry call.
func NewAzureClient(connectionString string, opts ...Option) (*AzureClient, error) {
	parsed, err := ParseDeviceConnectionString(connectionString)
	if err != nil {
		return nil, err
	}
	c := &AzureClient{
		conn:           parsed,
		sasTokenTTL:    defaultSASTokenTTL,
		connectTimeout: defaultConnectTimeout,
		publishTimeout: defaultPublishTimeout,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c, nil
}

// DeviceID returns the deviceId sourced from the per-device connection
// string. Callers (the queue runner, MintMessageId) thread this through
// instead of relying on the hard-coded legacy value.
func (c *AzureClient) DeviceID() string { return c.conn.DeviceID }

// HostName returns the IoT Hub hostname sourced from the connection string.
func (c *AzureClient) HostName() string { return c.conn.HostName }

// ensureConnectedLocked makes sure we have a live MQTT session whose
// SAS token has at least 5 minutes of life remaining. Caller must hold c.mu.
func (c *AzureClient) ensureConnectedLocked() error {
	if c.mqttClient != nil && c.mqttClient.IsConnectionOpen() && time.Now().Before(c.sasExpiry.Add(-5*time.Minute)) {
		return nil
	}
	if c.mqttClient != nil {
		c.mqttClient.Disconnect(250)
		c.mqttClient = nil
	}

	sas, expiry, err := GenerateSASToken(c.conn.HostName, c.conn.DeviceID, c.conn.SharedAccessKey, c.sasTokenTTL)
	if err != nil {
		return fmt.Errorf("iothub: mint SAS token: %w", err)
	}

	opts := mqtt.NewClientOptions().
		AddBroker(fmt.Sprintf("tls://%s:8883", c.conn.HostName)).
		SetClientID(c.conn.DeviceID).
		SetUsername(fmt.Sprintf("%s/%s/?api-version=%s", c.conn.HostName, c.conn.DeviceID, mqttAPIVersion)).
		SetPassword(sas).
		SetProtocolVersion(4).
		SetCleanSession(true).
		SetAutoReconnect(false).
		SetConnectTimeout(c.connectTimeout).
		SetTLSConfig(&tls.Config{
			ServerName: c.conn.HostName,
			MinVersion: tls.VersionTLS12,
		})

	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(c.connectTimeout) {
		return fmt.Errorf("iothub: connect to %s:8883 timed out after %s", c.conn.HostName, c.connectTimeout)
	}
	if err := token.Error(); err != nil {
		return fmt.Errorf("iothub: connect to %s:8883 failed: %w", c.conn.HostName, err)
	}

	c.mqttClient = client
	c.sasExpiry = expiry
	return nil
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
		if c.mqttClient != nil {
			c.mqttClient.Disconnect(250)
			c.mqttClient = nil
		}
		c.mu.Unlock()
		if err2 := publish(); err2 != nil {
			return fmt.Errorf("iothub: publish failed after retry: %w", err2)
		}
	}
	return nil
}

// Close shuts down the MQTT session if one exists.
func (c *AzureClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.mqttClient != nil {
		c.mqttClient.Disconnect(250)
		c.mqttClient = nil
	}
	return nil
}

// buildPublishTopic appends URL-encoded message properties to the
// device-to-cloud event topic per Azure's MQTT convention:
//
//	devices/<deviceId>/messages/events/<k1>=<v1>&<k2>=<v2>&...
//
// When properties is empty the bare event topic is returned (trailing slash).
func buildPublishTopic(deviceID string, properties map[string]string) string {
	base := deviceEventTopicPrefix + deviceID + deviceEventTopicSuffix
	if len(properties) == 0 {
		return base
	}
	vals := url.Values{}
	for k, v := range properties {
		vals.Set(k, v)
	}
	return base + vals.Encode()
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

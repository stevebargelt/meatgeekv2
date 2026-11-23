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
	"github.com/eclipse/paho.mqtt.golang/packets"
	"github.com/sirupsen/logrus"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
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
	defaultConnectTimeout  = 10 * time.Second
	defaultPublishTimeout  = 10 * time.Second
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

// ErrNotAuthorized is wrapped by a connect error when IoT Hub refuses the
// connection as not authorised (MQTT CONNACK 4, bad user name or password, or
// 5, not authorised).
var ErrNotAuthorized = errors.New("iothub: IoT Hub refused the connection as not authorised")

// HubResolver returns the IoT Hub host name an X.509 device should connect
// to. refresh is false when the client simply has no hub yet (a cached
// assignment will do) and true after IoT Hub refused the connection as not
// authorised, when the device should register again.
type HubResolver func(ctx context.Context, refresh bool) (hostName string, err error)

// AzureClient is the paho-MQTT-backed production implementation. One
// AzureClient holds the device's one MQTT connection (IoT Hub allows one per
// device id): telemetry publishes and, when WithCookTwin is set, the device
// twin share it.
//
// It authenticates with the device's own X.509 client certificate in the TLS
// handshake (NewX509Client). There is no password and no token to refresh.
type AzureClient struct {
	deviceID       string
	cert           *tls.Certificate // the device's client certificate
	resolveHub     HubResolver      // optional
	resolveSem     chan struct{}    // one hub resolution at a time
	brokerFixed    bool             // WithBrokerURL was given
	connectTimeout time.Duration
	publishTimeout time.Duration
	twinTimeout    time.Duration
	reconnectMin   time.Duration
	reconnectMax   time.Duration
	twinState      CookState
	claimState     ClaimState
	clock          clock.Clock
	newMQTT        func(*mqtt.ClientOptions) mqtt.Client

	mu         sync.Mutex
	hostName   string // may change when resolveHub assigns another hub
	brokerURL  string
	refreshHub bool // IoT Hub refused the hub we have; resolve with refresh
	mqttClient mqtt.Client
	gen        uint64        // counts connections; a publish names the one it used by it
	lost       chan struct{} // closed when the current connection drops or is replaced
	markLost   func()
	twin       *twin
	started    bool
	stop       context.CancelFunc
	wg         sync.WaitGroup
}

// Option configures an AzureClient.
type Option func(*AzureClient)

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

// WithClaim adds the device's claim code to the twin (goal HAR-130): every
// full twin sync and desired patch applies the claim rule to the desired claim
// properties, and every reported patch carries the claim properties next to
// the cook ones. It does nothing without WithCookTwin. dpsmode.NewClient sets
// it.
func WithClaim(state ClaimState) Option {
	return func(c *AzureClient) {
		c.claimState = state
	}
}

// WithBrokerURL replaces the broker address, `tls://<HostName>:8883` for the
// device's hub. A `tcp://` URL connects without TLS. Tests point it at
// an iothubtest.Broker; production never sets it.
func WithBrokerURL(u string) Option {
	return func(c *AzureClient) {
		if u != "" {
			c.brokerURL = u
			c.brokerFixed = true
		}
	}
}

// WithHubResolver gives the client a way to find (and, after IoT Hub
// refuses it as not authorised, re-find) the hub to connect to: before a
// connect, when the client has no hub, it calls r with refresh false; after a
// CONNACK 4 or 5 it calls r with refresh true, once, before the next connect
// attempt. With a resolver, NewX509Client accepts an empty host name.
func WithHubResolver(r HubResolver) Option {
	return func(c *AzureClient) {
		c.resolveHub = r
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

// WithClock replaces the clock behind every wait the client times itself:
// reconnect backoff and the connect, publish and twin timeouts. Tests pass a clocktest.Fake; production never sets it.
// paho's own internal timers (its dial and keepalive) stay on real time.
func WithClock(clk clock.Clock) Option {
	return func(c *AzureClient) {
		if clk != nil {
			c.clock = clk
		}
	}
}

// withReconnectBackoff overrides the reconnect backoff bounds (tests).
func withReconnectBackoff(lo, hi time.Duration) Option {
	return func(c *AzureClient) {
		c.reconnectMin, c.reconnectMax = lo, hi
	}
}

// withMQTTClient replaces paho's mqtt.NewClient, so a test can wrap the client
// each connect makes (tests).
func withMQTTClient(f func(*mqtt.ClientOptions) mqtt.Client) Option {
	return func(c *AzureClient) {
		c.newMQTT = f
	}
}

// NewX509Client returns a client that authenticates to IoT Hub hostName as
// deviceID with the device's X.509 certificate: MQTT user name
// `<hub>/<deviceId>/?api-version=...`, no password, and cert presented in the
// TLS handshake. hostName may be empty only with WithHubResolver. Nothing
// connects until Start (which connects at once and stays connected) or,
// without Start, the first publish.
func NewX509Client(hostName, deviceID string, cert tls.Certificate, opts ...Option) (*AzureClient, error) {
	if deviceID == "" {
		return nil, errors.New("iothub: X.509 client needs a device id")
	}
	if len(cert.Certificate) == 0 || cert.PrivateKey == nil {
		return nil, errors.New("iothub: X.509 client needs a certificate and its key")
	}
	c := newAzureClient(hostName, deviceID, opts)
	if hostName == "" && c.resolveHub == nil {
		return nil, errors.New("iothub: X.509 client needs a hub host name or WithHubResolver")
	}
	c.cert = &cert
	return c, nil
}

func newAzureClient(hostName, deviceID string, opts []Option) *AzureClient {
	c := &AzureClient{
		deviceID:       deviceID,
		hostName:       hostName,
		resolveSem:     make(chan struct{}, 1),
		connectTimeout: defaultConnectTimeout,
		publishTimeout: defaultPublishTimeout,
		twinTimeout:    defaultTwinTimeout,
		reconnectMin:   defaultReconnectMin,
		reconnectMax:   defaultReconnectMax,
		markLost:       func() {},
		clock:          clock.Real(),
		newMQTT:        mqtt.NewClient,
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.twinState != nil {
		c.twin = newTwin(c.twinState, c.twinTimeout, c.clock)
		c.twin.claims = c.claimState
	}
	if !c.brokerFixed && hostName != "" {
		c.brokerURL = hubBrokerURL(hostName)
	}
	return c
}

func hubBrokerURL(hostName string) string { return fmt.Sprintf("tls://%s:8883", hostName) }

// DeviceID returns the device id given to NewX509Client. Callers (the queue runner, MintMessageId) thread this
// through instead of relying on the hard-coded legacy value.
func (c *AzureClient) DeviceID() string { return c.deviceID }

// HostName returns the IoT Hub host name the client connects to now ("" before
// a resolver has assigned one).
func (c *AzureClient) HostName() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hostName
}

// resolve asks the hub resolver for a hub when the client has none or IoT Hub
// refused the one it has. It is a no-op without a resolver. Only one
// resolution runs at a time; a caller that waits for another's sees its
// result and does not repeat it.
func (c *AzureClient) resolve(ctx context.Context) error {
	if c.resolveHub == nil {
		return nil
	}
	select {
	case c.resolveSem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-c.resolveSem }()

	c.mu.Lock()
	need, refresh := c.hostName == "" || c.refreshHub, c.refreshHub
	c.mu.Unlock()
	if !need {
		return nil
	}
	host, err := c.resolveHub(ctx, refresh)
	if err != nil {
		return fmt.Errorf("iothub: find the device's hub: %w", err)
	}
	if host == "" {
		return errors.New("iothub: find the device's hub: the resolver returned no host name")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if host != c.hostName {
		logrus.WithFields(logrus.Fields{"from": c.hostName, "to": host}).Info("iothub: hub assigned")
		c.dropLocked()
	}
	c.hostName = host
	if !c.brokerFixed {
		c.brokerURL = hubBrokerURL(host)
	}
	c.refreshHub = false
	return nil
}

// Start connects to IoT Hub now and keeps the connection up until ctx is
// done or Close is called: it reconnects (with backoff) when the connection
// drops. Every connect, including a reconnect, re-establishes the twin
// subscriptions and re-reads the twin. Start returns at once; calling it again is a no-op.
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
		timer := c.clock.NewTimer(d)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-timer.C():
			return true
		}
	}
	for ctx.Err() == nil {
		err := c.resolve(ctx)
		var lost chan struct{}
		if err == nil {
			c.mu.Lock()
			err = c.ensureConnectedLocked()
			lost = c.lost
			c.mu.Unlock()
		}
		if err != nil {
			if errors.Is(err, ErrNotAuthorized) && c.resolveHub != nil {
				// Register again now, then retry the connect after the
				// usual backoff. A failed resolution is retried before the
				// next connect, since refreshHub stays set.
				if rerr := c.resolve(ctx); rerr != nil {
					logrus.WithError(rerr).Warn("iothub: re-registration after a refused connect failed")
				}
			}
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

		connectedAt := c.clock.Now()
		// The connection has no token to refresh: it stays up until it drops.
		select {
		case <-ctx.Done():
			return
		case <-lost:
		}
		// The connection dropped. Back off before redialling, unless it had
		// been up long enough to count as healthy.
		if c.clock.Now().Sub(connectedAt) >= c.reconnectMax {
			backoff = c.reconnectMin
		}
		if !sleep(backoff) {
			return
		}
		backoff = min(backoff*2, c.reconnectMax)
	}
}

// ensureConnectedLocked makes sure we have a live MQTT session. Each new
// connection is handed to the twin. Caller must hold c.mu.
func (c *AzureClient) ensureConnectedLocked() error {
	if c.mqttClient != nil && c.mqttClient.IsConnectionOpen() {
		return nil
	}
	c.dropLocked()

	if c.hostName == "" {
		return errors.New("iothub: no IoT Hub assigned to this device yet")
	}
	if c.refreshHub {
		// The hub refused this device; connecting again before the device
		// has registered again would only be refused again.
		return fmt.Errorf("iothub: %s refused this device; waiting to register again", c.hostName)
	}
	opts := c.mqttOptionsLocked()
	lost := make(chan struct{})
	var lostOnce sync.Once
	markLost := func() { lostOnce.Do(func() { close(lost) }) }

	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		logrus.WithError(err).Warn("iothub: connection lost")
		markLost()
	})

	client := c.newMQTT(opts)
	token := client.Connect()
	if !c.waitTimeout(token, c.connectTimeout) {
		return fmt.Errorf("iothub: connect to %s timed out after %s", c.brokerURL, c.connectTimeout)
	}
	if err := token.Error(); err != nil {
		if errors.Is(err, packets.ErrorRefusedNotAuthorised) || errors.Is(err, packets.ErrorRefusedBadUsernameOrPassword) {
			if c.resolveHub != nil {
				c.refreshHub = true
			}
			return fmt.Errorf("iothub: connect to %s failed: %w (%v)", c.brokerURL, ErrNotAuthorized, err)
		}
		return fmt.Errorf("iothub: connect to %s failed: %w", c.brokerURL, err)
	}

	c.mqttClient = client
	c.gen++
	c.lost = lost
	c.markLost = markLost
	logrus.WithFields(logrus.Fields{"hub": c.hostName, "auth": "x509"}).Info("iothub: connected")
	if c.twin != nil {
		c.twin.connected(twinConn{client: client, lost: lost})
	}
	return nil
}

// mqttOptionsLocked builds the CONNECT options for the current hub: no
// password, and the device certificate in the TLS config. Caller must hold
// c.mu.
func (c *AzureClient) mqttOptionsLocked() *mqtt.ClientOptions {
	tlsConfig := &tls.Config{
		ServerName:   c.hostName,
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{*c.cert},
	}
	opts := mqtt.NewClientOptions().
		AddBroker(c.brokerURL).
		SetClientID(c.deviceID).
		SetUsername(fmt.Sprintf("%s/%s/?api-version=%s", c.hostName, c.deviceID, mqttAPIVersion)).
		SetProtocolVersion(4).
		SetCleanSession(true).
		SetAutoReconnect(false).
		SetConnectTimeout(c.connectTimeout).
		SetTLSConfig(tlsConfig)
	return opts
}

// waitTimeout is token.WaitTimeout on c.clock: it reports whether the token
// completed within d.
func (c *AzureClient) waitTimeout(token mqtt.Token, d time.Duration) bool {
	timer := c.clock.NewTimer(d)
	defer timer.Stop()
	select {
	case <-token.Done():
		return true
	case <-timer.C():
		return false
	}
}

// dropLocked closes the current connection, if any. Caller must hold c.mu.
func (c *AzureClient) dropLocked() {
	if c.mqttClient != nil {
		c.mqttClient.Disconnect(250)
		c.mqttClient = nil
	}
	c.markLost()
}

// publishConn is the connection a publish uses: taken under c.mu, used
// without it.
type publishConn struct {
	client mqtt.Client
	lost   <-chan struct{}
	gen    uint64
}

// connectForPublish connects if needed and returns the connection to publish
// on. gen is the current generation even on error, so the caller's retry can
// tell whether a newer connection has replaced the one that failed.
//
// Without Start it also finds the hub (WithHubResolver). Once started, only
// supervise does, on its backoff, so a publisher retrying every few seconds
// does not hammer DPS while it refuses the device.
func (c *AzureClient) connectForPublish(ctx context.Context) (publishConn, error) {
	c.mu.Lock()
	started := c.started
	c.mu.Unlock()
	if !started {
		if err := c.resolve(ctx); err != nil {
			c.mu.Lock()
			defer c.mu.Unlock()
			return publishConn{gen: c.gen}, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	err := c.ensureConnectedLocked()
	return publishConn{client: c.mqttClient, lost: c.lost, gen: c.gen}, err
}

// handOff calls paho's Publish on its own goroutine and returns its token, or
// an error when timer, the connection's lost signal or ctx comes first. paho
// blocks in Publish for up to its WriteTimeout (30s) when the connection drops
// between its connected check and the hand-off to its writer; no caller waits
// that out, and none holds c.mu while it runs, so supervise and the twin can
// redial meanwhile. An abandoned call returns on paho's own timeout.
func (c *AzureClient) handOff(ctx context.Context, timer clock.Timer, pc publishConn, topic string, payload []byte) (mqtt.Token, error) {
	called := make(chan mqtt.Token, 1)
	go func() { called <- pc.client.Publish(topic, 1, false, payload) }()
	select {
	case tok := <-called:
		return tok, nil
	case <-timer.C():
		return nil, c.publishTimedOut(topic)
	case <-pc.lost:
		return nil, publishConnLost(topic)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *AzureClient) publishTimedOut(topic string) error {
	return fmt.Errorf("iothub: publish to %s timed out after %s", topic, c.publishTimeout)
}

func publishConnLost(topic string) error {
	return fmt.Errorf("iothub: publish to %s: connection lost", topic)
}

// PublishTelemetry publishes payload to `devices/<deviceId>/messages/events/`
// at QoS 1, attaching `properties` as IoT Hub message properties
// (encoded into the topic per the IoT Hub MQTT convention).
//
// Per-call timeout + a single retry. Durable retry is the queue
// runner's job — we surface failure quickly so the runner can re-Peek
// the same message.
//
// c.mu is held only to connect and to take the connection; the paho call and
// the PUBACK wait run without it, bounded together by the publish timeout,
// the connection's lost signal and ctx. A failed attempt drops the
// connection it used, and only that one: when supervise has already replaced
// it, the retry goes out on the new connection and leaves it up.
func (c *AzureClient) PublishTelemetry(ctx context.Context, payload []byte, properties map[string]string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	topic := buildPublishTopic(c.deviceID, properties)

	publish := func() (gen uint64, err error) {
		pc, err := c.connectForPublish(ctx)
		if err != nil {
			return pc.gen, err
		}
		timer := c.clock.NewTimer(c.publishTimeout)
		defer timer.Stop()
		token, err := c.handOff(ctx, timer, pc, topic, payload)
		if err != nil {
			return pc.gen, err
		}
		select {
		case <-token.Done():
			return pc.gen, token.Error()
		case <-timer.C():
			return pc.gen, c.publishTimedOut(topic)
		case <-pc.lost:
			return pc.gen, publishConnLost(topic)
		case <-ctx.Done():
			return pc.gen, ctx.Err()
		}
	}

	gen, err := publish()
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil && errors.Is(err, ctxErr) {
		// The caller gave up; the connection is not at fault.
		return err
	}
	logrus.WithError(err).Warn("iothub: publish failed, retrying once")
	c.mu.Lock()
	if c.gen == gen {
		c.dropLocked()
	}
	c.mu.Unlock()
	if _, err2 := publish(); err2 != nil {
		return fmt.Errorf("iothub: publish failed after retry: %w", err2)
	}
	return nil
}

// PublishTelemetryAsync starts the same QoS 1 publish as PublishTelemetry
// (same topic, same connection handling) but returns as soon as the message
// is handed to the MQTT client, without waiting for IoT Hub's PUBACK. The
// returned wait blocks until that acknowledgement arrives, the publish timeout
// (counted from the start of the hand-off) passes, or ctx is done, and returns
// the outcome. Like PublishTelemetry it does not hold c.mu across the paho
// call; the hand-off itself is bounded by the publish timeout, the
// connection's lost signal and ctx.
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

	topic := buildPublishTopic(c.deviceID, properties)

	pc, err := c.connectForPublish(ctx)
	if err != nil {
		return nil, err
	}
	deadline := c.clock.Now().Add(c.publishTimeout)
	handOffTimer := c.clock.NewTimer(c.publishTimeout)
	token, err := c.handOff(ctx, handOffTimer, pc, topic, payload)
	handOffTimer.Stop()
	if err != nil {
		return nil, err
	}

	return func() error {
		timer := c.clock.NewTimer(deadline.Sub(c.clock.Now()))
		defer timer.Stop()
		select {
		case <-token.Done():
			return token.Error()
		case <-timer.C():
			return c.publishTimedOut(topic)
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

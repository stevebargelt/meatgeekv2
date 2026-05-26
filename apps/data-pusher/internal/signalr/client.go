package signalr

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

// Options configures a Client. Zero-valued fields take their documented
// defaults.
type Options struct {
	// ReconnectBaseDelay is the starting delay for exponential backoff.
	// Defaults to 1s.
	ReconnectBaseDelay time.Duration
	// ReconnectMaxDelay caps the backoff. Defaults to 30s.
	ReconnectMaxDelay time.Duration
	// HandshakeTimeout caps both the WebSocket upgrade and the SignalR
	// handshake exchange. Defaults to 10s.
	HandshakeTimeout time.Duration
	// EventBuffer sizes the Events() channel. Defaults to 64.
	EventBuffer int
	// HTTPClient is used for the negotiate POST. Defaults to
	// http.DefaultClient.
	HTTPClient *http.Client
	// Dialer is used for the WebSocket dial. Defaults to
	// websocket.DefaultDialer (a per-test override here is the seam used
	// by the package's tests).
	Dialer *websocket.Dialer
}

// Client speaks SignalR JSON protocol v1 against a hub URL and surfaces
// cook-lifecycle events on the channel returned by Events().
//
// NOTE: As of ticket #5 the producer side of this hub — the Functions app
// that owns the /negotiate endpoint and emits cook_started/cook_stopped
// envelopes — does NOT exist yet. The client tolerates this: a hub URL that
// 404s simply drives the reconnect loop, no goroutine is leaked, and the
// data-pusher main process pairs this client with a polling
// cooksession.Reconcile() fallback so the cook lifecycle is still observed
// during the SignalR producer's pre-existence window.
type Client struct {
	opts   Options
	events chan Event

	mu     sync.Mutex
	closed bool
	cancel context.CancelFunc
	doneCh chan struct{}

	// connectAttempts counts every iteration of the reconnect loop (success
	// or failure) so tests can assert reconnect behavior without sleeping
	// for the full backoff window.
	connectAttempts atomic.Int64
}

// New constructs a Client. Connect must be called to start the reconnect
// loop; Events and Close are valid immediately.
func New(opts Options) *Client {
	if opts.ReconnectBaseDelay == 0 {
		opts.ReconnectBaseDelay = 1 * time.Second
	}
	if opts.ReconnectMaxDelay == 0 {
		opts.ReconnectMaxDelay = 30 * time.Second
	}
	if opts.HandshakeTimeout == 0 {
		opts.HandshakeTimeout = 10 * time.Second
	}
	if opts.EventBuffer == 0 {
		opts.EventBuffer = 64
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = http.DefaultClient
	}
	if opts.Dialer == nil {
		opts.Dialer = websocket.DefaultDialer
	}
	return &Client{
		opts:   opts,
		events: make(chan Event, opts.EventBuffer),
		doneCh: make(chan struct{}),
	}
}

// Connect starts the reconnect loop and returns immediately. The first
// connection attempt runs in the background; failures drive the exponential
// backoff. The Client is single-use — calling Connect twice returns an
// error.
//
// Calling Connect with an empty hubURL returns an error so the caller can
// branch on "SignalR producer not configured" before spawning a goroutine
// that will never make progress.
func (c *Client) Connect(ctx context.Context, hubURL, deviceID string) error {
	if hubURL == "" {
		return fmt.Errorf("signalr: hub URL is required")
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return fmt.Errorf("signalr: client is closed")
	}
	if c.cancel != nil {
		c.mu.Unlock()
		return fmt.Errorf("signalr: Connect already called")
	}
	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.mu.Unlock()
	go c.runLoop(runCtx, hubURL, deviceID)
	return nil
}

// Events returns the channel that typed cook-lifecycle events are written
// to. The channel is closed by Close().
func (c *Client) Events() <-chan Event {
	return c.events
}

// Close cancels the reconnect loop, waits for the reader goroutine to exit,
// and closes the Events() channel. Safe to call multiple times.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	cancel := c.cancel
	hadLoop := cancel != nil
	c.mu.Unlock()

	if hadLoop {
		cancel()
		<-c.doneCh
	}
	close(c.events)
	return nil
}

// ConnectAttempts returns the number of reconnect iterations observed so
// far. Exposed for tests; production callers should not rely on it.
func (c *Client) ConnectAttempts() int64 {
	return c.connectAttempts.Load()
}

func (c *Client) runLoop(ctx context.Context, hubURL, deviceID string) {
	defer close(c.doneCh)

	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		c.connectAttempts.Add(1)
		handshakeOK, err := c.runOnce(ctx, hubURL, deviceID)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logrus.WithError(err).
				WithField("attempt", attempt+1).
				WithField("handshakeOK", handshakeOK).
				Warn("signalr: connection failed; will retry with backoff")
		}
		// If we successfully completed the handshake, the connection was
		// healthy at least briefly — reset the backoff so a stable hub that
		// dropped once isn't punished with a 30s wait.
		if handshakeOK {
			attempt = 0
		}
		delay := c.backoff(attempt)
		attempt++
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
	}
}

// backoff returns base * 2^attempt + up-to-25% jitter, capped at the
// configured maximum. attempt is clamped to 16 to prevent the multiplier
// from overflowing on very long-lived bad-hub-URL deployments.
func (c *Client) backoff(attempt int) time.Duration {
	if attempt > 16 {
		attempt = 16
	}
	mult := time.Duration(1) << uint(attempt)
	d := c.opts.ReconnectBaseDelay * mult
	if d <= 0 || d > c.opts.ReconnectMaxDelay {
		d = c.opts.ReconnectMaxDelay
	}
	jitter := time.Duration(float64(d) * 0.25 * rand.Float64())
	return d + jitter
}

// runOnce performs one negotiate + dial + handshake + read-loop cycle. The
// first return value reports whether the SignalR handshake completed (so
// the reconnect loop can reset its backoff after a once-healthy connection
// drops).
func (c *Client) runOnce(ctx context.Context, hubURL, deviceID string) (bool, error) {
	connID, err := c.negotiate(ctx, hubURL)
	if err != nil {
		return false, fmt.Errorf("negotiate: %w", err)
	}

	wsURL, err := buildWSURL(hubURL, connID)
	if err != nil {
		return false, fmt.Errorf("build ws url: %w", err)
	}

	dialer := *c.opts.Dialer
	dialer.HandshakeTimeout = c.opts.HandshakeTimeout
	conn, _, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return false, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	if err := signalrHandshake(conn, c.opts.HandshakeTimeout); err != nil {
		return false, fmt.Errorf("signalr handshake: %w", err)
	}

	return true, c.readLoop(ctx, conn, deviceID)
}

func (c *Client) negotiate(ctx context.Context, hubURL string) (string, error) {
	negURL, err := buildNegotiateURL(hubURL)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, negURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.opts.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("http %d", resp.StatusCode)
	}
	var n negotiateResponse
	if err := json.NewDecoder(resp.Body).Decode(&n); err != nil {
		return "", err
	}
	if n.ConnectionID == "" {
		return "", fmt.Errorf("negotiate response missing connectionId")
	}
	return n.ConnectionID, nil
}

func buildNegotiateURL(hubURL string) (string, error) {
	u, err := url.Parse(hubURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http", "https":
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported hub url scheme: %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/negotiate"
	q := u.Query()
	q.Set("negotiateVersion", "1")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func buildWSURL(hubURL, connID string) (string, error) {
	u, err := url.Parse(hubURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported hub url scheme: %q", u.Scheme)
	}
	q := u.Query()
	q.Set("id", connID)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func signalrHandshake(conn *websocket.Conn, timeout time.Duration) error {
	if err := conn.SetWriteDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	body, _ := json.Marshal(handshakeRequest{Protocol: "json", Version: 1})
	if err := conn.WriteMessage(websocket.TextMessage, frameWithSeparator(body)); err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Time{})

	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	_, payload, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Time{})

	frames, _ := splitFrames(payload)
	if len(frames) == 0 {
		return fmt.Errorf("empty handshake response")
	}
	var hr handshakeResponse
	if err := json.Unmarshal(frames[0], &hr); err != nil {
		return fmt.Errorf("decode handshake response: %w", err)
	}
	if hr.Error != "" {
		return fmt.Errorf("rejected: %s", hr.Error)
	}
	return nil
}

type rawFrame struct {
	data []byte
	err  error
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn, deviceID string) error {
	// Buffered so the pump can always deliver its terminal error frame even
	// if the main loop has already returned. The drain in the deferred
	// cleanup below empties any straggler frames so the pump can exit.
	framesCh := make(chan rawFrame, 4)
	pumpDone := make(chan struct{})

	go func() {
		defer close(pumpDone)
		var buf []byte
		for {
			_, payload, err := conn.ReadMessage()
			if err != nil {
				framesCh <- rawFrame{err: err}
				return
			}
			buf = append(buf, payload...)
			frames, rest := splitFrames(buf)
			buf = rest
			for _, f := range frames {
				framesCh <- rawFrame{data: f}
			}
		}
	}()

	defer func() {
		// Closing the conn unblocks the pump's ReadMessage and lets it post
		// its terminal error frame; the drain below makes room for that
		// post if framesCh has filled up.
		_ = conn.Close()
		for {
			select {
			case <-pumpDone:
				return
			case <-framesCh:
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case f := <-framesCh:
			if f.err != nil {
				if f.err == io.EOF ||
					websocket.IsCloseError(f.err,
						websocket.CloseNormalClosure,
						websocket.CloseGoingAway,
						websocket.CloseAbnormalClosure) {
					return f.err
				}
				return f.err
			}
			if len(f.data) == 0 {
				continue
			}
			if err := c.handleFrame(ctx, conn, f.data, deviceID); err != nil {
				return err
			}
		}
	}
}

func (c *Client) handleFrame(ctx context.Context, conn *websocket.Conn, data []byte, deviceID string) error {
	var msg signalRMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		// A buggy producer must not kill the connection: log and continue.
		logrus.WithError(err).
			WithField("raw", string(data)).
			Debug("signalr: dropping malformed frame")
		return nil
	}
	switch msg.Type {
	case msgInvocation:
		return c.dispatchInvocation(ctx, msg, deviceID)
	case msgPing:
		ping := frameWithSeparator([]byte(`{"type":6}`))
		if err := conn.WriteMessage(websocket.TextMessage, ping); err != nil {
			return fmt.Errorf("write ping: %w", err)
		}
	case msgClose:
		return fmt.Errorf("server sent close frame")
	default:
		// Completion, StreamItem, etc. — ignore. The pusher only invokes
		// server methods receive-side.
	}
	return nil
}

func (c *Client) dispatchInvocation(ctx context.Context, msg signalRMessage, deviceID string) error {
	eventType := EventType(msg.Target)
	switch eventType {
	case EventTypeCookStarted, EventTypeCookStopped, EventTypeCookPaused, EventTypeCookResumed:
	default:
		// Other targets (temperature_update, device_*, alert_triggered,
		// system_notification) are intentionally dropped — the pusher has
		// no role to play in them.
		return nil
	}
	if len(msg.Arguments) == 0 {
		logrus.WithField("target", msg.Target).
			Debug("signalr: invocation has no arguments; dropping")
		return nil
	}
	var env envelopeArgument
	if err := json.Unmarshal(msg.Arguments[0], &env); err != nil {
		logrus.WithError(err).
			WithField("target", msg.Target).
			Debug("signalr: dropping envelope with unparseable arguments[0]")
		return nil
	}

	ev := Event{
		Type:        eventType,
		Timestamp:   env.Timestamp,
		MessageID:   env.MessageID,
		DeviceID:    env.DeviceID,
		Correlation: env.Correlation,
	}
	// cook_stopped clears the active cook id regardless of what the
	// envelope carries — that is the lifecycle contract.
	if eventType != EventTypeCookStopped && env.CookID != nil {
		v := *env.CookID
		ev.CookID = &v
	}
	if len(env.Payload) > 0 && string(env.Payload) != "null" {
		var cook Cook
		if err := json.Unmarshal(env.Payload, &cook); err == nil {
			ev.Cook = &cook
			// Fall back to the payload's cook id if the envelope-level one
			// is empty (not all producers stamp both — they should, but
			// the spec only requires one).
			if ev.CookID == nil && cook.ID != "" && eventType != EventTypeCookStopped {
				v := cook.ID
				ev.CookID = &v
			}
		}
	}

	select {
	case c.events <- ev:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

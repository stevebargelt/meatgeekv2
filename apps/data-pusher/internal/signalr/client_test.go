package signalr

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// --- test fixture ---------------------------------------------------------

// fakeHub stands in for the Functions-app SignalR hub. It accepts the
// negotiate POST and the WebSocket upgrade, completes the SignalR
// handshake, and lets the test drive arbitrary invocation frames back to
// the client.
type fakeHub struct {
	t      *testing.T
	server *httptest.Server

	upgrader websocket.Upgrader

	// connections tracks every accepted WS connection so tests can close
	// them to simulate drops.
	mu          sync.Mutex
	conns       []*websocket.Conn
	handshakeOK atomic.Int32

	// dropAfterHandshake, if set, causes the server to close the WS
	// connection immediately after a successful handshake. Used to drive
	// the reconnect-backoff test.
	dropAfterHandshake atomic.Bool
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	h := &fakeHub{t: t}
	h.upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/hub/negotiate", h.handleNegotiate)
	mux.HandleFunc("/hub", h.handleWS)
	h.server = httptest.NewServer(mux)
	t.Cleanup(func() {
		h.server.Close()
		h.mu.Lock()
		for _, c := range h.conns {
			_ = c.Close()
		}
		h.mu.Unlock()
	})
	return h
}

func (h *fakeHub) hubURL() string {
	return h.server.URL + "/hub"
}

func (h *fakeHub) handleNegotiate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	resp := negotiateResponse{ConnectionID: "test-conn-id", NegotiateVersion: 1}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (h *fakeHub) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.t.Errorf("upgrade failed: %v", err)
		return
	}

	// Track for shutdown.
	h.mu.Lock()
	h.conns = append(h.conns, conn)
	h.mu.Unlock()

	// Read handshake frame.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		_ = conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	frames, _ := splitFrames(data)
	if len(frames) == 0 {
		_ = conn.Close()
		return
	}
	var hsReq handshakeRequest
	if err := json.Unmarshal(frames[0], &hsReq); err != nil || hsReq.Protocol != "json" || hsReq.Version != 1 {
		_ = conn.Close()
		return
	}

	// Send empty handshake response.
	if err := conn.WriteMessage(websocket.TextMessage, frameWithSeparator([]byte(`{}`))); err != nil {
		_ = conn.Close()
		return
	}
	h.handshakeOK.Add(1)

	if h.dropAfterHandshake.Load() {
		_ = conn.Close()
		return
	}

	// Park the goroutine until the connection dies — tests push frames via
	// sendInvocation, which writes directly to the conn.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// sendInvocation writes a SignalR invocation frame to the most-recently
// accepted connection. Tests call this after Connect to drive events.
func (h *fakeHub) sendInvocation(target string, arg any) error {
	h.mu.Lock()
	if len(h.conns) == 0 {
		h.mu.Unlock()
		return fmt.Errorf("no connections")
	}
	conn := h.conns[len(h.conns)-1]
	h.mu.Unlock()

	rawArg, err := json.Marshal(arg)
	if err != nil {
		return err
	}
	msg := signalRMessage{
		Type:      msgInvocation,
		Target:    target,
		Arguments: []json.RawMessage{rawArg},
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, frameWithSeparator(body))
}

// closeLatestConn forcibly closes the active websocket on the server side.
func (h *fakeHub) closeLatestConn() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.conns) == 0 {
		return
	}
	_ = h.conns[len(h.conns)-1].Close()
}

// envelopeBody constructs a wire-shape envelope as expected by the
// dispatcher.
func envelopeBody(typ, deviceID string, cookID *string, correlationID string) map[string]any {
	env := map[string]any{
		"type":      typ,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"messageId": "msg-" + typ,
		"deviceId":  deviceID,
		"correlation": map[string]any{
			"id": correlationID,
		},
		"payload": map[string]any{
			"id":       "cook-payload-" + typ,
			"deviceId": deviceID,
			"status":   "active",
			"name":     "Test Cook",
		},
	}
	if cookID != nil {
		env["cookId"] = *cookID
	}
	return env
}

// --- tests ----------------------------------------------------------------

func TestHandshakeCompletes(t *testing.T) {
	hub := newFakeHub(t)
	client := New(Options{
		HandshakeTimeout: 2 * time.Second,
	})
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Connect(ctx, hub.hubURL(), "device-1"); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}

	// Spin until the fake hub records the handshake (or test deadline hits).
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if hub.handshakeOK.Load() >= 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("handshake did not complete within deadline")
}

func TestCookStartedEventPropagates(t *testing.T) {
	hub := newFakeHub(t)
	client := New(Options{HandshakeTimeout: 2 * time.Second})
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Connect(ctx, hub.hubURL(), "device-1"); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}

	// Wait for the handshake before pushing a frame.
	waitFor(t, "handshake", func() bool { return hub.handshakeOK.Load() >= 1 })

	cookID := "cook-42"
	if err := hub.sendInvocation(string(EventTypeCookStarted),
		envelopeBody(string(EventTypeCookStarted), "device-1", &cookID, "corr-abc")); err != nil {
		t.Fatalf("sendInvocation: %v", err)
	}

	select {
	case ev := <-client.Events():
		if ev.Type != EventTypeCookStarted {
			t.Errorf("event type = %q, want cook_started", ev.Type)
		}
		if ev.DeviceID != "device-1" {
			t.Errorf("DeviceID = %q, want device-1", ev.DeviceID)
		}
		if ev.CookID == nil || *ev.CookID != "cook-42" {
			t.Errorf("CookID = %v, want pointer to cook-42", ev.CookID)
		}
		if ev.Correlation.ID != "corr-abc" {
			t.Errorf("Correlation.ID = %q, want corr-abc", ev.Correlation.ID)
		}
		if ev.Cook == nil || ev.Cook.ID != "cook-payload-cook_started" {
			t.Errorf("Cook payload unexpected: %+v", ev.Cook)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for cook_started event")
	}
}

func TestCookStoppedClearsCookID(t *testing.T) {
	hub := newFakeHub(t)
	client := New(Options{HandshakeTimeout: 2 * time.Second})
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Connect(ctx, hub.hubURL(), "device-1"); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}

	waitFor(t, "handshake", func() bool { return hub.handshakeOK.Load() >= 1 })

	cookID := "cook-99"
	if err := hub.sendInvocation(string(EventTypeCookStopped),
		envelopeBody(string(EventTypeCookStopped), "device-1", &cookID, "corr-xyz")); err != nil {
		t.Fatalf("sendInvocation: %v", err)
	}

	select {
	case ev := <-client.Events():
		if ev.Type != EventTypeCookStopped {
			t.Errorf("event type = %q, want cook_stopped", ev.Type)
		}
		if ev.CookID != nil {
			t.Errorf("CookID = %v, want nil on cook_stopped", *ev.CookID)
		}
		if ev.Correlation.ID != "corr-xyz" {
			t.Errorf("Correlation.ID = %q, want corr-xyz", ev.Correlation.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for cook_stopped event")
	}
}

func TestReconnectWithExponentialBackoff(t *testing.T) {
	hub := newFakeHub(t)
	// Configure tight backoff so the test runs in well under a second.
	client := New(Options{
		ReconnectBaseDelay: 10 * time.Millisecond,
		ReconnectMaxDelay:  50 * time.Millisecond,
		HandshakeTimeout:   500 * time.Millisecond,
	})
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hub.dropAfterHandshake.Store(true)

	if err := client.Connect(ctx, hub.hubURL(), "device-1"); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}

	// Expect at least 3 reconnect iterations within a short window — the
	// server is dropping us right after handshake, so each iteration is
	// negotiate + dial + handshake + drop.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if client.ConnectAttempts() >= 3 && hub.handshakeOK.Load() >= 3 {
			// Jitter ceiling: the maximum elapsed should not exceed the
			// max-delay * attempts + slack. The configured cap is 50ms;
			// 3 attempts should not take more than 3 * 50ms * 1.25 jitter
			// + iteration cost (~hundreds of ms slack).
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("did not observe enough reconnect attempts: connectAttempts=%d, serverHandshakes=%d",
		client.ConnectAttempts(), hub.handshakeOK.Load())
}

func TestCloseDrainsAndDoesNotLeakGoroutine(t *testing.T) {
	hub := newFakeHub(t)
	client := New(Options{HandshakeTimeout: 2 * time.Second})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := client.Connect(ctx, hub.hubURL(), "device-1"); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}

	waitFor(t, "handshake", func() bool { return hub.handshakeOK.Load() >= 1 })

	// Send one event so the channel has something on it; the test verifies
	// Close() still terminates cleanly.
	cookID := "cook-leak-test"
	if err := hub.sendInvocation(string(EventTypeCookStarted),
		envelopeBody(string(EventTypeCookStarted), "device-1", &cookID, "corr-1")); err != nil {
		t.Fatalf("sendInvocation: %v", err)
	}
	select {
	case <-client.Events():
	case <-time.After(2 * time.Second):
		t.Fatal("did not observe cook_started before close")
	}

	startG := runtime.NumGoroutine()
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Calling Close twice is idempotent.
	if err := client.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}

	// Events channel should be closed.
	select {
	case _, ok := <-client.Events():
		if ok {
			t.Errorf("expected Events channel to be closed")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Events channel did not close")
	}

	// Allow the reader pump time to fully unwind.
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if g := runtime.NumGoroutine(); g <= startG {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Logf("goroutine count delta after Close: start=%d now=%d", startG, runtime.NumGoroutine())
	// Allow some slack — the test runtime itself may spawn goroutines.
	if g := runtime.NumGoroutine(); g > startG+2 {
		t.Errorf("possible goroutine leak: started with %d, now %d", startG, g)
	}
}

func TestConnectEmptyHubURL(t *testing.T) {
	client := New(Options{})
	defer client.Close()
	err := client.Connect(context.Background(), "", "device-1")
	if err == nil || !strings.Contains(err.Error(), "hub URL is required") {
		t.Fatalf("expected hub URL required error, got %v", err)
	}
}

func TestSplitFrames(t *testing.T) {
	in := []byte("frame1\x1eframe2\x1epartial")
	frames, rest := splitFrames(in)
	if len(frames) != 2 {
		t.Fatalf("got %d frames, want 2", len(frames))
	}
	if string(frames[0]) != "frame1" || string(frames[1]) != "frame2" {
		t.Errorf("unexpected frames: %q, %q", frames[0], frames[1])
	}
	if string(rest) != "partial" {
		t.Errorf("rest = %q, want partial", rest)
	}
}

func TestBuildNegotiateURL(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"http://hub.example/notif", "http://hub.example/notif/negotiate?negotiateVersion=1"},
		{"https://hub.example/notif/", "https://hub.example/notif/negotiate?negotiateVersion=1"},
		{"ws://hub.example/notif", "http://hub.example/notif/negotiate?negotiateVersion=1"},
		{"wss://hub.example/notif", "https://hub.example/notif/negotiate?negotiateVersion=1"},
	}
	for _, tc := range cases {
		got, err := buildNegotiateURL(tc.in)
		if err != nil {
			t.Fatalf("buildNegotiateURL(%q) err: %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("buildNegotiateURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildWSURL(t *testing.T) {
	got, err := buildWSURL("https://hub.example/notif", "abc-123")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != "wss://hub.example/notif?id=abc-123" {
		t.Errorf("got %q", got)
	}
}

// waitFor spins until cond is true or 3 seconds elapse.
func waitFor(t *testing.T, label string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", label)
}

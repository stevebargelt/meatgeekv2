package iothub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/sirupsen/logrus"
)

// Device twin over the telemetry MQTT connection (HAR-58).
//
// The active cook is device state: the API writes it into the twin's desired
// properties and the device applies it. A twin persists, so a device that was
// offline when the cook started gets it on the GET it makes after connecting.
//
// Contract (decided in goal HAR-55):
//
//	desired  (API writes):    activeCookId, correlationId (string, or absent/null = none), $version
//	reported (device writes): activeCookId, correlationId (string or null), appliedDesiredVersion
//
// IoT Hub allows one MQTT connection per device id, so the twin shares the
// AzureClient's connection; it never dials its own.
const (
	TwinDesiredActiveCookID  = "activeCookId"
	TwinDesiredCorrelationID = "correlationId"
	TwinReportedAppliedVer   = "appliedDesiredVersion"

	twinResponseFilter     = "$iothub/twin/res/#"
	twinDesiredPatchFilter = "$iothub/twin/PATCH/properties/desired/#"

	twinResponsePrefix     = "$iothub/twin/res/"
	twinDesiredPatchPrefix = "$iothub/twin/PATCH/properties/desired/"
	twinGetTopicPrefix     = "$iothub/twin/GET/?$rid="
	twinReportTopicPrefix  = "$iothub/twin/PATCH/properties/reported/?$rid="

	defaultTwinTimeout = 30 * time.Second
	// twinPatchBuffer is how many desired patches may wait while the twin
	// worker is busy (e.g. mid-GET). On overflow the worker re-GETs instead.
	twinPatchBuffer = 64
)

// CookState is where the twin's desired cook lands. *cooksession.Store
// implements it (persisted on the Pi, in memory for simdevice).
//
// ApplyDesired must apply all three values or none: an error means the state
// is unchanged, and the twin does not report.
type CookState interface {
	AppliedDesired() (activeCookID, correlationID *string, version int64)
	ApplyDesired(activeCookID, correlationID *string, version int64) error
}

// TwinDesired is the desired section of a twin as the device reads it.
type TwinDesired struct {
	ActiveCookID  *string `json:"activeCookId"`
	CorrelationID *string `json:"correlationId"`
	Version       int64   `json:"$version"`
}

// TwinReported is the reported section of a twin. AppliedDesiredVersion is nil
// when the device has never reported.
type TwinReported struct {
	ActiveCookID          *string `json:"activeCookId"`
	CorrelationID         *string `json:"correlationId"`
	AppliedDesiredVersion *int64  `json:"appliedDesiredVersion"`
}

// Twin is one full twin document as returned by a GET.
type Twin struct {
	Desired  TwinDesired  `json:"desired"`
	Reported TwinReported `json:"reported"`
}

// reportedPatch is the body the device publishes after applying desired state.
// All three fields are always sent; nil ids go out as null.
type reportedPatch struct {
	ActiveCookID          *string `json:"activeCookId"`
	CorrelationID         *string `json:"correlationId"`
	AppliedDesiredVersion int64   `json:"appliedDesiredVersion"`
}

// twinConn is one MQTT connection as the twin worker sees it. lost closes when
// that connection drops or is replaced, so in-flight requests stop waiting.
type twinConn struct {
	client mqtt.Client
	lost   <-chan struct{}
}

type twinResponse struct {
	status  int
	payload []byte
}

type twinPatch struct {
	version int64
	payload []byte
}

// twin is the device-twin worker. A single goroutine (run) applies the GET on
// each connect and every desired patch, so state transitions never race.
// paho delivers messages to onMessage, which only hands them off: with paho's
// default ordered routing, a handler must not block or publish.
type twin struct {
	state   CookState
	timeout time.Duration

	conns    chan twinConn  // latest connection wins; capacity 1
	patches  chan twinPatch // capacity twinPatchBuffer
	overflow atomic.Bool    // a patch was dropped; re-GET

	rid atomic.Uint64

	mu      sync.Mutex
	pending map[string]chan twinResponse
	current twinConn
	lastErr error

	syncedOnce sync.Once
	synced     chan struct{} // closed after the first GET applied and reported
}

func newTwin(state CookState, timeout time.Duration) *twin {
	return &twin{
		state:   state,
		timeout: timeout,
		conns:   make(chan twinConn, 1),
		patches: make(chan twinPatch, twinPatchBuffer),
		pending: make(map[string]chan twinResponse),
		synced:  make(chan struct{}),
	}
}

// connected hands a freshly connected client to the worker. Called by the
// AzureClient (under its mutex, so there is one sender) after every CONNECT.
// It never blocks: an older connection still waiting is replaced.
func (t *twin) connected(c twinConn) {
	for {
		select {
		case t.conns <- c:
			return
		default:
			select {
			case <-t.conns:
			default:
			}
		}
	}
}

// run is the worker loop. It returns when ctx is done.
func (t *twin) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case c := <-t.conns:
			t.mu.Lock()
			t.current = c
			t.mu.Unlock()
			t.onConnect(ctx, c)
		case p := <-t.patches:
			t.onPatch(ctx, p)
		}
		if t.overflow.Swap(false) {
			logrus.Warn("iothub twin: desired patch buffer overflowed, re-reading the twin")
			t.fullSync(ctx, t.conn())
		}
	}
}

func (t *twin) conn() twinConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.current
}

// onConnect re-establishes the twin subscriptions (CleanSession=true, so none
// survive a reconnect) and then reads the whole twin.
func (t *twin) onConnect(ctx context.Context, c twinConn) {
	tok := c.client.SubscribeMultiple(map[string]byte{
		twinResponseFilter:     0,
		twinDesiredPatchFilter: 0,
	}, t.onMessage)
	if err := waitToken(ctx, tok, t.timeout, c.lost); err != nil {
		t.fail(fmt.Errorf("subscribe to twin topics: %w", err))
		return
	}
	t.fullSync(ctx, c)
}

// fullSync GETs the twin and applies its whole desired section. The GET is
// authoritative: its version replaces the applied one even when lower (a
// device re-created on the hub starts its twin versions again).
func (t *twin) fullSync(ctx context.Context, c twinConn) {
	if c.client == nil {
		return
	}
	resp, err := t.request(ctx, c, twinGetTopicPrefix, nil)
	if err != nil {
		t.fail(fmt.Errorf("twin GET: %w", err))
		return
	}
	if !is2xx(resp.status) {
		t.fail(fmt.Errorf("twin GET: status %d: %s", resp.status, truncate(resp.payload)))
		return
	}
	var doc struct {
		Desired map[string]json.RawMessage `json:"desired"`
	}
	if err := json.Unmarshal(resp.payload, &doc); err != nil {
		t.fail(fmt.Errorf("twin GET: decode response: %w", err))
		return
	}
	version, err := desiredVersion(doc.Desired)
	if err != nil {
		t.fail(fmt.Errorf("twin GET: %w", err))
		return
	}
	cook := desiredString(doc.Desired, TwinDesiredActiveCookID, nil)
	corr := desiredString(doc.Desired, TwinDesiredCorrelationID, nil)
	if t.apply(ctx, c, cook, corr, version, "get") {
		t.syncedOnce.Do(func() { close(t.synced) })
	}
}

// onPatch applies one desired patch. Only a version newer than the applied
// one counts; a version that skips ahead means a patch was missed, so the
// worker re-reads the whole twin rather than merge onto a stale base.
func (t *twin) onPatch(ctx context.Context, p twinPatch) {
	cook, corr, applied := t.state.AppliedDesired()
	log := logrus.WithFields(logrus.Fields{"patchVersion": p.version, "appliedVersion": applied})
	switch {
	case p.version <= applied:
		log.Debug("iothub twin: ignoring desired patch that is not newer than the applied version")
		return
	case p.version > applied+1:
		log.Info("iothub twin: desired version skipped ahead, re-reading the twin")
		t.fullSync(ctx, t.conn())
		return
	}

	var patch map[string]json.RawMessage
	if err := json.Unmarshal(p.payload, &patch); err != nil {
		log.WithError(err).Warn("iothub twin: undecodable desired patch, re-reading the twin")
		t.fullSync(ctx, t.conn())
		return
	}
	cook = desiredString(patch, TwinDesiredActiveCookID, cook)
	corr = desiredString(patch, TwinDesiredCorrelationID, corr)
	t.apply(ctx, t.conn(), cook, corr, p.version, "patch")
}

// apply stores the desired values and reports them. It returns true when both
// succeeded. A failed report is retried by the GET on the next connect.
func (t *twin) apply(ctx context.Context, c twinConn, cook, corr *string, version int64, source string) bool {
	if err := t.state.ApplyDesired(cook, corr, version); err != nil {
		t.fail(fmt.Errorf("apply desired version %d: %w", version, err))
		return false
	}
	body, err := json.Marshal(reportedPatch{ActiveCookID: cook, CorrelationID: corr, AppliedDesiredVersion: version})
	if err != nil {
		t.fail(fmt.Errorf("encode reported patch: %w", err))
		return false
	}
	resp, err := t.request(ctx, c, twinReportTopicPrefix, body)
	if err != nil {
		t.fail(fmt.Errorf("report applied version %d: %w", version, err))
		return false
	}
	if !is2xx(resp.status) {
		t.fail(fmt.Errorf("report applied version %d: status %d: %s", version, resp.status, truncate(resp.payload)))
		return false
	}
	logrus.WithFields(logrus.Fields{
		"source":                source,
		"appliedDesiredVersion": version,
		"cookId":                derefOr(cook, ""),
	}).Info("iothub twin: applied and reported desired properties")
	return true
}

// request publishes a twin request with a fresh $rid and waits for the
// matching $iothub/twin/res/<status>/?$rid= response.
func (t *twin) request(ctx context.Context, c twinConn, topicPrefix string, body []byte) (twinResponse, error) {
	if c.client == nil {
		return twinResponse{}, errors.New("not connected")
	}
	rid := strconv.FormatUint(t.rid.Add(1), 10)
	ch := make(chan twinResponse, 1)
	t.mu.Lock()
	t.pending[rid] = ch
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.pending, rid)
		t.mu.Unlock()
	}()

	if body == nil {
		body = []byte{}
	}
	if err := waitToken(ctx, c.client.Publish(topicPrefix+rid, 0, false, body), t.timeout, c.lost); err != nil {
		return twinResponse{}, fmt.Errorf("publish: %w", err)
	}

	timer := time.NewTimer(t.timeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r, nil
	case <-timer.C:
		return twinResponse{}, fmt.Errorf("no response within %s", t.timeout)
	case <-c.lost:
		return twinResponse{}, errors.New("connection lost while waiting for the response")
	case <-ctx.Done():
		return twinResponse{}, ctx.Err()
	}
}

// onMessage is the paho handler for both twin subscriptions.
func (t *twin) onMessage(_ mqtt.Client, m mqtt.Message) {
	topic := m.Topic()
	switch {
	case strings.HasPrefix(topic, twinResponsePrefix):
		rest := strings.TrimPrefix(topic, twinResponsePrefix)
		statusStr, query, _ := strings.Cut(rest, "/")
		status, err := strconv.Atoi(statusStr)
		if err != nil {
			logrus.WithField("topic", topic).Warn("iothub twin: response topic has no status")
			return
		}
		rid := topicQuery(query).Get("$rid")
		t.mu.Lock()
		ch := t.pending[rid]
		delete(t.pending, rid)
		t.mu.Unlock()
		if ch == nil {
			logrus.WithField("topic", topic).Debug("iothub twin: response for no pending request")
			return
		}
		ch <- twinResponse{status: status, payload: append([]byte(nil), m.Payload()...)}

	case strings.HasPrefix(topic, twinDesiredPatchPrefix):
		v, err := strconv.ParseInt(topicQuery(strings.TrimPrefix(topic, twinDesiredPatchPrefix)).Get("$version"), 10, 64)
		if err != nil {
			logrus.WithField("topic", topic).Warn("iothub twin: desired patch without a $version, re-reading the twin")
			t.overflow.Store(true)
			t.wake()
			return
		}
		select {
		case t.patches <- twinPatch{version: v, payload: append([]byte(nil), m.Payload()...)}:
		default:
			t.overflow.Store(true)
		}
	}
}

// wake nudges the worker so it notices the overflow flag. A patch with an
// impossible version (0) is ignored by onPatch, so it does nothing else.
func (t *twin) wake() {
	select {
	case t.patches <- twinPatch{version: 0}:
	default:
	}
}

func (t *twin) fail(err error) {
	t.mu.Lock()
	t.lastErr = err
	t.mu.Unlock()
	logrus.WithError(err).Warn("iothub twin: sync failed; it is retried on the next connect")
}

// noteErr records err as the last failure without logging it (the caller
// already has).
func (t *twin) noteErr(err error) {
	t.mu.Lock()
	t.lastErr = err
	t.mu.Unlock()
}

func (t *twin) lastError() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastErr
}

// get reads the whole twin over the current connection (simdevice's step 3).
func (t *twin) get(ctx context.Context) (Twin, error) {
	resp, err := t.request(ctx, t.conn(), twinGetTopicPrefix, nil)
	if err != nil {
		return Twin{}, err
	}
	if !is2xx(resp.status) {
		return Twin{}, fmt.Errorf("status %d: %s", resp.status, truncate(resp.payload))
	}
	var doc struct {
		Desired  map[string]json.RawMessage `json:"desired"`
		Reported map[string]json.RawMessage `json:"reported"`
	}
	if err := json.Unmarshal(resp.payload, &doc); err != nil {
		return Twin{}, fmt.Errorf("decode response: %w", err)
	}
	version, err := desiredVersion(doc.Desired)
	if err != nil {
		return Twin{}, err
	}
	out := Twin{
		Desired: TwinDesired{
			ActiveCookID:  desiredString(doc.Desired, TwinDesiredActiveCookID, nil),
			CorrelationID: desiredString(doc.Desired, TwinDesiredCorrelationID, nil),
			Version:       version,
		},
		Reported: TwinReported{
			ActiveCookID:  desiredString(doc.Reported, TwinDesiredActiveCookID, nil),
			CorrelationID: desiredString(doc.Reported, TwinDesiredCorrelationID, nil),
		},
	}
	if raw, ok := doc.Reported[TwinReportedAppliedVer]; ok {
		var v int64
		if json.Unmarshal(raw, &v) == nil {
			out.Reported.AppliedDesiredVersion = &v
		}
	}
	return out, nil
}

// desiredString reads one string property from a desired section or patch.
// Absent keeps prev; JSON null clears it. A value that is not a string is
// logged and treated as null.
func desiredString(props map[string]json.RawMessage, key string, prev *string) *string {
	raw, ok := props[key]
	if !ok {
		return prev
	}
	if string(raw) == "null" {
		return nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		logrus.WithField("property", key).Warn("iothub twin: desired property is not a string, treating it as null")
		return nil
	}
	return &s
}

func desiredVersion(desired map[string]json.RawMessage) (int64, error) {
	raw, ok := desired["$version"]
	if !ok {
		return 0, errors.New("desired section has no $version")
	}
	var v int64
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, fmt.Errorf("desired $version: %w", err)
	}
	return v, nil
}

// topicQuery parses the `?$rid=1&$version=2` tail of a twin topic.
func topicQuery(s string) url.Values {
	v, _ := url.ParseQuery(strings.TrimPrefix(s, "?"))
	return v
}

// waitToken waits for a paho token, the timeout, a lost connection or ctx.
func waitToken(ctx context.Context, tok mqtt.Token, timeout time.Duration, lost <-chan struct{}) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-tok.Done():
		return tok.Error()
	case <-timer.C:
		return fmt.Errorf("timed out after %s", timeout)
	case <-lost:
		return errors.New("connection lost")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func is2xx(status int) bool { return status >= 200 && status < 300 }

func truncate(b []byte) string {
	const max = 200
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}

func derefOr(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

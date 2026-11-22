package provision

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/identity"
)

const (
	regID   = "meatgeek-pi-7"
	idScope = "0ne00ABCDEF"
)

var start = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

// recClock is a fake clock that records the duration of every timer asked of
// it, so a test can assert the waits Register requested.
type recClock struct {
	*clocktest.Fake
	mu    sync.Mutex
	asked []time.Duration
}

func (r *recClock) NewTimer(d time.Duration) clock.Timer {
	r.mu.Lock()
	r.asked = append(r.asked, d)
	r.mu.Unlock()
	return r.Fake.NewTimer(d)
}

// waits is every timer asked for except the per-request timeouts.
func (r *recClock) waits() []time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []time.Duration
	for _, d := range r.asked {
		if d != defaultRequestTimeout {
			out = append(out, d)
		}
	}
	return out
}

// advanceWhenWaiting waits until Register is waiting d on clk, then advances
// clk by d.
func advanceWhenWaiting(t *testing.T, clk *clocktest.Fake, d time.Duration) {
	t.Helper()
	await.Until(t, fmt.Sprintf("Register waiting %s", d),
		func() bool { return slices.Contains(clk.Pending(), d) },
		func() any { return clk.Pending() }, clk)
	clk.Advance(d)
}

// request is one request the fake DPS saw.
type request struct {
	method, path, query string
	body                []byte
	clientCN            string
}

// fakeDPS is an HTTPS server that requires a client certificate and answers
// the n-th request (0-based) with respond(n, r).
type fakeDPS struct {
	srv *httptest.Server
	mu  sync.Mutex
	got []request
}

func newFakeDPS(t *testing.T, respond func(n int, w http.ResponseWriter, r *http.Request)) *fakeDPS {
	t.Helper()
	f := &fakeDPS{}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cn := ""
		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			cn = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		f.mu.Lock()
		n := len(f.got)
		f.got = append(f.got, request{r.Method, r.URL.Path, r.URL.RawQuery, body, cn})
		f.mu.Unlock()
		respond(n, w, r)
	}))
	f.srv.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeDPS) requests() []request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]request(nil), f.got...)
}

func (f *fakeDPS) endpoint() string { return f.srv.Listener.Addr().String() }

func (f *fakeDPS) client(t *testing.T, clk clock.Clock, opts ...Option) *Client {
	t.Helper()
	_, cert, err := identity.Ensure(t.TempDir(), regID, clk)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(f.srv.Certificate())
	c := New(cert, append([]Option{WithClock(clk), WithRootCAs(pool)}, opts...)...)
	t.Cleanup(c.CloseIdleConnections)
	return c
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func assigning(w http.ResponseWriter, retryAfter string) {
	if retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"operationId": "op-1", "status": "assigning"})
}

func assigned(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{
		"operationId": "op-1",
		"status":      "assigned",
		"registrationState": map[string]any{
			"registrationId": regID,
			"assignedHub":    "meatgeek-dev.azure-devices.net",
			"deviceId":       regID,
			"status":         "assigned",
		},
	})
}

type result struct {
	a   Assignment
	err error
}

func register(c *Client, endpoint string) <-chan result {
	done := make(chan result, 1)
	go func() {
		a, err := c.Register(context.Background(), endpoint, idScope, regID)
		done <- result{a, err}
	}()
	return done
}

func TestRegister_FollowsAssigningToAssigned(t *testing.T) {
	dps := newFakeDPS(t, func(n int, w http.ResponseWriter, r *http.Request) {
		switch n {
		case 0:
			assigning(w, "3") // the PUT
		case 1:
			assigning(w, "") // first poll: no Retry-After, so the default 2s
		default:
			assigned(w)
		}
	})
	clk := &recClock{Fake: clocktest.New(start)}
	done := register(dps.client(t, clk), dps.endpoint())

	advanceWhenWaiting(t, clk.Fake, 3*time.Second)
	advanceWhenWaiting(t, clk.Fake, 2*time.Second)
	res := <-done
	if res.err != nil {
		t.Fatalf("Register: %v", res.err)
	}
	want := Assignment{AssignedHub: "meatgeek-dev.azure-devices.net", DeviceID: regID, RegisteredAt: start.Add(5 * time.Second)}
	if res.a != want {
		t.Errorf("assignment = %+v, want %+v", res.a, want)
	}
	if got := clk.waits(); !slices.Equal(got, []time.Duration{3 * time.Second, 2 * time.Second}) {
		t.Errorf("requested waits = %v, want [3s 2s]", got)
	}

	reqs := dps.requests()
	if len(reqs) != 3 {
		t.Fatalf("DPS got %d requests, want 3: %+v", len(reqs), reqs)
	}
	put := reqs[0]
	if put.method != http.MethodPut || put.path != "/"+idScope+"/registrations/"+regID+"/register" || put.query != "api-version=2021-06-01" {
		t.Errorf("register request = %s %s?%s", put.method, put.path, put.query)
	}
	var body map[string]string
	if err := json.Unmarshal(put.body, &body); err != nil || len(body) != 1 || body["registrationId"] != regID {
		t.Errorf("register body = %s, want {\"registrationId\":%q}", put.body, regID)
	}
	for _, poll := range reqs[1:] {
		if poll.method != http.MethodGet || poll.path != "/"+idScope+"/registrations/"+regID+"/operations/op-1" || poll.query != "api-version=2021-06-01" {
			t.Errorf("status request = %s %s?%s", poll.method, poll.path, poll.query)
		}
	}
	for _, r := range reqs {
		if r.clientCN != regID {
			t.Errorf("request presented client certificate CN %q, want %q", r.clientCN, regID)
		}
	}
}

func TestRegister_DisabledIsRefused(t *testing.T) {
	dps := newFakeDPS(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n == 0 {
			assigning(w, "1")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"operationId": "op-1", "status": "disabled"})
	})
	clk := clocktest.New(start)
	done := register(dps.client(t, clk), dps.endpoint())
	advanceWhenWaiting(t, clk, time.Second)
	res := <-done
	if !errors.Is(res.err, ErrEnrollmentRefused) {
		t.Fatalf("err = %v, want ErrEnrollmentRefused", res.err)
	}
}

func TestRegister_401And403AreRefused(t *testing.T) {
	const secretish = "thumbprint-0123456789ABCDEF"
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			dps := newFakeDPS(t, func(n int, w http.ResponseWriter, r *http.Request) {
				writeJSON(w, status, map[string]any{"errorCode": 401002, "message": "no enrollment for " + secretish})
			})
			res := <-register(dps.client(t, clocktest.New(start)), dps.endpoint())
			if !errors.Is(res.err, ErrEnrollmentRefused) {
				t.Fatalf("err = %v, want ErrEnrollmentRefused", res.err)
			}
			msg := res.err.Error()
			if !strings.Contains(msg, fmt.Sprint(status)) || !strings.Contains(msg, "401002") {
				t.Errorf("error %q should carry the status %d and errorCode 401002", msg, status)
			}
			if strings.Contains(msg, secretish) {
				t.Errorf("error %q carries the response body", msg)
			}
		})
	}
}

func TestRegister_StopsAfterTheAttemptBound(t *testing.T) {
	dps := newFakeDPS(t, func(n int, w http.ResponseWriter, r *http.Request) {
		assigning(w, "") // forever, at the default 2s
	})
	clk := clocktest.New(start)
	done := register(dps.client(t, clk, WithMaxAttempts(3)), dps.endpoint())
	for range 3 {
		advanceWhenWaiting(t, clk, 2*time.Second)
	}
	res := <-done
	if res.err == nil || errors.Is(res.err, ErrEnrollmentRefused) {
		t.Fatalf("err = %v, want a retryable error", res.err)
	}
	if got := len(dps.requests()); got != 4 {
		t.Errorf("DPS got %d requests, want the PUT and 3 status checks", got)
	}
}

func TestRegister_OtherFailuresAreRetryable(t *testing.T) {
	cases := map[string]func(w http.ResponseWriter){
		"HTTP 500": func(w http.ResponseWriter) {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"errorCode": 500000})
		},
		"HTTP 429": func(w http.ResponseWriter) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"errorCode": 429001})
		},
		"status failed": func(w http.ResponseWriter) {
			writeJSON(w, http.StatusOK, map[string]any{"operationId": "op-1", "status": "failed",
				"registrationState": map[string]any{"status": "failed", "errorCode": 400209}})
		},
	}
	for name, respond := range cases {
		t.Run(name, func(t *testing.T) {
			dps := newFakeDPS(t, func(n int, w http.ResponseWriter, r *http.Request) { respond(w) })
			res := <-register(dps.client(t, clocktest.New(start)), dps.endpoint())
			if res.err == nil || errors.Is(res.err, ErrEnrollmentRefused) {
				t.Fatalf("err = %v, want a retryable error", res.err)
			}
		})
	}
}

func TestRegister_ContextCancelledDuringWait(t *testing.T) {
	dps := newFakeDPS(t, func(n int, w http.ResponseWriter, r *http.Request) { assigning(w, "5") })
	clk := clocktest.New(start)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	c := dps.client(t, clk)
	go func() {
		_, err := c.Register(ctx, dps.endpoint(), idScope, regID)
		done <- err
	}()
	await.Until(t, "Register waiting 5s", func() bool { return slices.Contains(clk.Pending(), 5*time.Second) },
		func() any { return clk.Pending() }, clk)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestAssignmentCache_RoundTripAndDelete(t *testing.T) {
	state := t.TempDir()
	if _, ok, err := LoadAssignment(state); ok || err != nil {
		t.Fatalf("empty state: ok=%v err=%v", ok, err)
	}
	want := Assignment{AssignedHub: "hub.azure-devices.net", DeviceID: regID, RegisteredAt: start}
	if err := SaveAssignment(state, want); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(state, "identity", "assignment.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"assignedHub", "deviceId", "registeredAt"} {
		if _, ok := fields[k]; !ok {
			t.Errorf("assignment.json lacks %q: %s", k, raw)
		}
	}
	got, ok, err := LoadAssignment(state)
	if err != nil || !ok || !got.RegisteredAt.Equal(want.RegisteredAt) || got.AssignedHub != want.AssignedHub || got.DeviceID != want.DeviceID {
		t.Fatalf("LoadAssignment = %+v, %v, %v; want %+v", got, ok, err, want)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("identity dir holds %d entries, want only assignment.json (no temp files)", len(entries))
	}
	if err := DeleteAssignment(state); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := LoadAssignment(state); ok {
		t.Error("assignment still cached after DeleteAssignment")
	}
	if err := DeleteAssignment(state); err != nil {
		t.Errorf("deleting a missing assignment: %v", err)
	}
}

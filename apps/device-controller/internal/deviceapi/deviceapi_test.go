package deviceapi

// Contract tests for the controller's real HTTP surface (HAR-148). They serve
// the gobot API this package builds, with fixed temperatures, and send
// get_status exactly as the data-pusher does. The body must equal the golden
// file the pusher's own test parses
// (apps/data-pusher/internal/collector/contract_test.go), so a change to
// either side's shape fails one of the two.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"gobot.io/x/gobot/v2"
	"gobot.io/x/gobot/v2/api"
)

// goldenFile is shared with the data-pusher's contract test.
const goldenFile = "../../../../libs/api-interfaces/test-vectors/controller-get-status.json"

var update = flag.Bool("update", false, "rewrite the golden file from the controller's current output")

const (
	statusPath = "/api/robots/MeatGeekBot/commands/get_status"
	tempsPath  = "/api/robots/MeatGeekBot/commands/get_temps"
)

// fixedSource is a StatusSource with fixed temperatures: what the owner's Pi
// read on 2026-11-23 (grill 64, P1 66, P2 66), with P3 reading exactly 0 °F
// (a real, in-range reading: since HAR-151 an unplugged probe is never 0) and
// P4 with no reading (NaN, served as null). Every field is fixed, so the body
// has nothing variable to normalise. Every reading is inside -40..800 °F, so
// the golden file did not change for HAR-151.
type fixedSource struct{}

func (fixedSource) Status() Status {
	return Status{
		TTL:         259200,
		SmokerID:    "meatgeek3",
		FireHealthy: true,
		Mode:        "test",
		SetPoint:    200,
		Temps: Temps{
			GrillTemp:  64.4,
			Probe1Temp: 66.2,
			Probe2Temp: 65.9,
			Probe3Temp: 0,
			Probe4Temp: math.NaN(),
		},
		CurrentTime: time.Date(2026, 11, 23, 15, 4, 5, 0, time.UTC),
	}
}

// serve starts an httptest server (random port) for h. net/http's own
// panic log goes to the test log, not stderr.
func serve(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ErrorLog = log.New(testWriter{t}, "", 0)
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// newHandler builds the real API with the fixed source, plus any extra
// commands a test needs.
func newHandler(t *testing.T, extra func(*gobot.Robot)) http.Handler {
	t.Helper()
	manager := gobot.NewManager()
	robot := NewRobot(fixedSource{}, nil, nil, nil)
	if extra != nil {
		extra(robot)
	}
	manager.AddRobot(robot)
	return NewHandler(manager, Config{})
}

// pusherRequest builds a request the way the data-pusher builds its poll:
// a copy of newStatusRequest in apps/data-pusher/internal/collector/collector.go.
// Method GET, no body (nil), and a W3C traceparent injected with the
// TraceContext propagator (the pusher's telemetry.Setup installs it as the
// global one). The client adds the same default headers (User-Agent,
// Accept-Encoding) the pusher's http.Client does.
func pusherRequest(t *testing.T, baseURL, path string) *http.Request {
	t.Helper()
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80, 0x31, 0x9c},
		SpanID:     trace.SpanID{0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31},
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	url := fmt.Sprintf("%s%s", baseURL, path)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(req.Header))
	if req.Header.Get("traceparent") == "" {
		t.Fatal("test request is missing traceparent")
	}
	return req
}

// do sends req and returns status and body; a transport error fails the test.
func do(t *testing.T, srv *httptest.Server, req *http.Request) (int, string, http.Header) {
	t.Helper()
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v (connection dropped?)", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, string(body), resp.Header
}

func readGolden(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(goldenFile)
	if err != nil {
		t.Fatalf("read golden %s: %v", goldenFile, err)
	}
	// The file ends with one newline so editors leave it alone; the body
	// does not. That newline is the only normalisation.
	return string(bytes.TrimSuffix(b, []byte("\n")))
}

// TestUnpatchedGobotAPI_DropsBodylessGET reproduces the bug found on the
// owner's Pi: gobot v2.5.0's API, served without this package's middleware,
// panics decoding the pusher's body-less GET, and net/http drops the
// connection, so the client sees EOF. If gobot ever fixes this, this test
// fails and the workaround can go.
func TestUnpatchedGobotAPI_DropsBodylessGET(t *testing.T) {
	manager := gobot.NewManager()
	manager.AddRobot(NewRobot(fixedSource{}, nil, nil, nil))
	raw := api.NewAPI(manager)
	raw.AddC3PIORoutes()
	srv := serve(t, raw)

	resp, err := srv.Client().Do(pusherRequest(t, srv.URL, statusPath))
	if err == nil {
		resp.Body.Close()
		t.Fatalf("unpatched gobot API answered %d; expected the connection to drop", resp.StatusCode)
	}
	if !errors.Is(err, io.EOF) {
		t.Fatalf("unpatched gobot API: got %v, want EOF", err)
	}
}

// TestGetStatus_PusherRequest_MatchesGolden is the fix and the contract: the
// pusher's exact request gets 200 and the golden body, byte for byte.
func TestGetStatus_PusherRequest_MatchesGolden(t *testing.T) {
	srv := serve(t, newHandler(t, nil))

	code, body, hdr := do(t, srv, pusherRequest(t, srv.URL, statusPath))
	if code != http.StatusOK {
		t.Fatalf("get_status: status %d, body %q; want 200", code, body)
	}
	if ct := hdr.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}

	if *update {
		if err := os.WriteFile(goldenFile, []byte(body+"\n"), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("rewrote %s", goldenFile)
	}
	if want := readGolden(t); body != want {
		t.Fatalf("get_status body differs from %s\n got: %s\nwant: %s", goldenFile, body, want)
	}
}

// TestGetTemps_PusherRequest answers the same body-less GET for get_temps.
func TestGetTemps_PusherRequest(t *testing.T) {
	srv := serve(t, newHandler(t, nil))

	code, body, _ := do(t, srv, pusherRequest(t, srv.URL, tempsPath))
	if code != http.StatusOK {
		t.Fatalf("get_temps: status %d, body %q; want 200", code, body)
	}
	want := `{"result":"{\"grillTemp\":64.4,\"probe1Temp\":66.2,\"probe2Temp\":65.9,\"probe3Temp\":0,\"probe4Temp\":null}"}`
	if body != want {
		t.Fatalf("get_temps body\n got: %s\nwant: %s", body, want)
	}
}

// TestGetStatus_EmptyJSONBody: a GET that does send "{}" (what gobot always
// expected) still gets the same answer.
func TestGetStatus_EmptyJSONBody(t *testing.T) {
	srv := serve(t, newHandler(t, nil))

	req := pusherRequest(t, srv.URL, statusPath)
	req.Body = io.NopCloser(strings.NewReader("{}"))
	req.ContentLength = 2

	code, body, _ := do(t, srv, req)
	if code != http.StatusOK {
		t.Fatalf("get_status with {}: status %d, body %q; want 200", code, body)
	}
	if want := readGolden(t); body != want {
		t.Fatalf("get_status with {} body\n got: %s\nwant: %s", body, want)
	}
}

// TestCommand_PanicAnswers500: a command that panics answers 500 with a JSON
// error, not a dropped connection.
func TestCommand_PanicAnswers500(t *testing.T) {
	srv := serve(t, newHandler(t, func(r *gobot.Robot) {
		r.AddCommand("explode", func(map[string]interface{}) interface{} {
			panic("probe on fire")
		})
	}))

	code, body, hdr := do(t, srv, pusherRequest(t, srv.URL, "/api/robots/MeatGeekBot/commands/explode"))
	assert500(t, code, body, hdr)
}

// TestCommand_MalformedBody500: a body gobot cannot decode still panics inside
// gobot; Recover turns that into a 500 too.
func TestCommand_MalformedBody500(t *testing.T) {
	srv := serve(t, newHandler(t, nil))

	req, err := http.NewRequest("POST", srv.URL+statusPath, strings.NewReader("not json"))
	if err != nil {
		t.Fatal(err)
	}
	code, body, hdr := do(t, srv, req)
	assert500(t, code, body, hdr)
}

func assert500(t *testing.T, code int, body string, hdr http.Header) {
	t.Helper()
	if code != http.StatusInternalServerError {
		t.Fatalf("status %d, body %q; want 500", code, body)
	}
	if ct := hdr.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	var e struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &e); err != nil || e.Error == "" {
		t.Fatalf("500 body %q is not a JSON error: %v", body, err)
	}
}

// TestDefaultCommandBody_LeavesOtherPathsAndBodiesAlone pins the middleware's
// scope: only body-less requests under /api/robots/ get "{}".
func TestDefaultCommandBody_LeavesOtherPathsAndBodiesAlone(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		body     io.Reader
		wantBody string
	}{
		{"command without body", statusPath, nil, "{}"},
		{"command with body", statusPath, strings.NewReader(`{"a":1}`), `{"a":1}`},
		{"other path without body", "/api/commands", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", tc.path, tc.body)
			DefaultCommandBody(httptest.NewRecorder(), r)
			got, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.wantBody {
				t.Fatalf("body = %q, want %q", got, tc.wantBody)
			}
		})
	}
}

// TestStore_UpdateIsVisibleToStatus checks the store hands readers the
// writer's latest state (and, under -race, that it is safe to share).
func TestStore_UpdateIsVisibleToStatus(t *testing.T) {
	st := NewStore(Status{SmokerID: "meatgeek3"})
	done := make(chan struct{})
	go func() {
		defer close(done)
		st.Update(func(s *Status) { s.Temps.GrillTemp = 225 })
	}()
	_ = st.Status() // a concurrent read, for the race detector
	<-done
	if got := st.Status(); got.Temps.GrillTemp != 225 || got.SmokerID != "meatgeek3" {
		t.Fatalf("Status() = %+v", got)
	}
}

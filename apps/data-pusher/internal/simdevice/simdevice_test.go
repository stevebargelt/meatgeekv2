package simdevice

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/telemetry"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/wire"

	"go.opentelemetry.io/otel"
)

const (
	fakeKey     = "ZmFrZS1rZXktZG8tbm90LXVzZS0xMjM0NTY3ODkw"
	validConn   = "HostName=hub-dev.azure-devices.net;DeviceId=sim-device-1;SharedAccessKey=" + fakeKey
	timeLayout  = "2006-01-02T15:04:05.000Z07:00"
	traceparent = "traceparent"
)

type runResult struct {
	code   int
	stdout string
	stderr string
	mock   *iothub.MockClient
}

func runMain(t *testing.T, args []string, env map[string]string, newClient ClientFactory) runResult {
	t.Helper()
	shutdown, err := telemetry.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	defer shutdown()

	mock := iothub.NewMockClient()
	if newClient == nil {
		newClient = func(string) (Client, error) { return mock, nil }
	}
	var stdout, stderr bytes.Buffer
	code := Main(context.Background(), Env{
		Args:      args,
		Getenv:    func(k string) string { return env[k] },
		Stdout:    &stdout,
		Stderr:    &stderr,
		NewClient: newClient,
		Tracer:    otel.Tracer("simdevice-test"),
	})
	return runResult{code: code, stdout: stdout.String(), stderr: stderr.String(), mock: mock}
}

func TestMain_CountThreeAgainstMockClient(t *testing.T) {
	res := runMain(t, []string{"--count", "3"}, map[string]string{EnvConnectionString: validConn}, nil)
	if res.code != ExitOK {
		t.Fatalf("exit = %d, want 0; stderr=%q", res.code, res.stderr)
	}

	calls := res.mock.Calls()
	if len(calls) != 3 {
		t.Fatalf("publish calls = %d, want 3", len(calls))
	}

	var lines []Sent
	sc := bufio.NewScanner(strings.NewReader(res.stdout))
	for sc.Scan() {
		var s Sent
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&s); err != nil {
			t.Fatalf("stdout line %q is not the documented JSON shape: %v", sc.Text(), err)
		}
		lines = append(lines, s)
	}
	if len(lines) != 3 {
		t.Fatalf("stdout lines = %d, want 3; stdout=%q", len(lines), res.stdout)
	}

	ids := map[string]bool{}
	stamps := map[string]bool{}
	traces := map[string]bool{}
	for i, line := range lines {
		ids[line.MessageID] = true
		stamps[line.Timestamp] = true
		if line.DeviceID != "sim-device-1" {
			t.Errorf("line %d deviceId = %q, want sim-device-1", i, line.DeviceID)
		}
		ts, err := time.Parse(timeLayout, line.Timestamp)
		if err != nil {
			t.Errorf("line %d timestamp %q is not RFC 3339 with milliseconds: %v", i, line.Timestamp, err)
		}
		if _, err := time.Parse(timeLayout, line.SentAt); err != nil {
			t.Errorf("line %d sentAt %q is not RFC 3339 with milliseconds: %v", i, line.SentAt, err)
		}

		var reading wire.TemperatureReading
		if err := json.Unmarshal(calls[i].Payload, &reading); err != nil {
			t.Fatalf("call %d payload is not a TemperatureReading: %v", i, err)
		}
		if reading.DeviceID != "sim-device-1" {
			t.Errorf("call %d payload deviceId = %q, want sim-device-1", i, reading.DeviceID)
		}
		if !reading.Timestamp.Equal(ts) {
			t.Errorf("call %d payload timestamp %s != stdout timestamp %s", i, reading.Timestamp, line.Timestamp)
		}
		if reading.GrillTemp == nil || reading.Probe1Temp == nil {
			t.Errorf("call %d payload lacks grill/probe temps: %s", i, calls[i].Payload)
		}

		props := calls[i].Properties
		if props["$.ct"] != "application/json" || props["$.ce"] != "utf-8" {
			t.Errorf("call %d content type/encoding = %q/%q", i, props["$.ct"], props["$.ce"])
		}
		if props["messageId"] != line.MessageID {
			t.Errorf("call %d messageId %q != stdout messageId %q", i, props["messageId"], line.MessageID)
		}
		if props[traceparent] == "" {
			t.Errorf("call %d carries no traceparent", i)
		}
		traces[props[traceparent][3:35]] = true
	}
	if len(ids) != 3 {
		t.Errorf("messageIds not distinct: %v", lines)
	}
	if len(stamps) != 3 {
		t.Errorf("timestamps not distinct: %v", lines)
	}
	if len(traces) != 3 {
		t.Errorf("each reading must ride its own trace; got %d distinct trace ids", len(traces))
	}
	if strings.Contains(res.stdout+res.stderr, fakeKey) {
		t.Error("the key leaked into output")
	}
}

func TestMain_DefaultCountIsOne(t *testing.T) {
	res := runMain(t, nil, map[string]string{EnvConnectionString: validConn}, nil)
	if res.code != ExitOK || len(res.mock.Calls()) != 1 || strings.Count(res.stdout, "\n") != 1 {
		t.Fatalf("exit=%d calls=%d stdout=%q stderr=%q", res.code, len(res.mock.Calls()), res.stdout, res.stderr)
	}
}

func TestMain_IntervalSpacesSends(t *testing.T) {
	start := time.Now()
	res := runMain(t, []string{"--count", "3", "--interval", "40ms"}, map[string]string{EnvConnectionString: validConn}, nil)
	if res.code != ExitOK {
		t.Fatalf("exit = %d; stderr=%q", res.code, res.stderr)
	}
	if el := time.Since(start); el < 80*time.Millisecond {
		t.Errorf("3 sends with a 40ms interval took %s, want >= 80ms", el)
	}
}

func TestMain_MissingConnectionString(t *testing.T) {
	res := runMain(t, []string{"--count", "1"}, map[string]string{}, nil)
	if res.code == ExitOK {
		t.Fatal("missing connection string must exit non-zero")
	}
	if !strings.Contains(res.stderr, EnvConnectionString) {
		t.Errorf("stderr must name %s; got %q", EnvConnectionString, res.stderr)
	}
	if res.stdout != "" {
		t.Errorf("stdout must be empty; got %q", res.stdout)
	}
	if len(res.mock.Calls()) != 0 {
		t.Error("nothing may be published without a credential")
	}
}

func TestMain_MalformedConnectionStringDoesNotLeak(t *testing.T) {
	for _, bad := range []string{
		"SharedAccessKey=" + fakeKey,                                // no HostName
		"HostName=hub.azure-devices.net;SharedAccessKey=" + fakeKey, // no DeviceId
		"HostName=hub.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=" + fakeKey,
		"garbage " + fakeKey + " more garbage",
	} {
		res := runMain(t, nil, map[string]string{EnvConnectionString: bad}, nil)
		if res.code == ExitOK {
			t.Errorf("malformed %q: exit 0, want non-zero", bad)
		}
		out := res.stdout + res.stderr
		if strings.Contains(out, fakeKey) {
			t.Errorf("malformed input: the fake key leaked into output %q", out)
		}
		if strings.Contains(out, bad) {
			t.Errorf("malformed input: the input string leaked into output %q", out)
		}
		if !strings.Contains(res.stderr, EnvConnectionString) {
			t.Errorf("stderr should name %s; got %q", EnvConnectionString, res.stderr)
		}
		if res.stdout != "" {
			t.Errorf("stdout must be empty; got %q", res.stdout)
		}
	}
}

type failingClient struct{ err error }

func (f failingClient) PublishTelemetry(context.Context, []byte, map[string]string) error {
	return f.err
}
func (f failingClient) PublishTelemetryAsync(context.Context, []byte, map[string]string) (func() error, error) {
	return func() error { return f.err }, nil
}
func (failingClient) Close() error { return nil }

func TestMain_SendFailureExitsNonZeroAndRedacts(t *testing.T) {
	// A worst-case client error that embeds the credential: the redactor must
	// still keep it off stderr.
	cli := failingClient{err: errors.New("connect failed using " + validConn)}
	res := runMain(t, []string{"--count", "2"}, map[string]string{EnvConnectionString: validConn},
		func(string) (Client, error) { return cli, nil })
	if res.code != ExitSendFailed {
		t.Fatalf("exit = %d, want %d", res.code, ExitSendFailed)
	}
	if res.stdout != "" {
		t.Errorf("no line may be printed for an unsent message; stdout=%q", res.stdout)
	}
	if strings.Contains(res.stderr, fakeKey) || strings.Contains(res.stderr, validConn) {
		t.Errorf("credential leaked into stderr: %q", res.stderr)
	}
	if !strings.Contains(res.stderr, "[REDACTED]") {
		t.Errorf("expected redaction marker in stderr: %q", res.stderr)
	}
}

func TestMain_BadFlags(t *testing.T) {
	for _, args := range [][]string{
		{"--count", "0"},
		{"--interval", "-1s"},
		{"--interval", "soon"},
		{"--inflight", "0"},
		{"--inflight", "-3"},
		{"--connection-string", validConn},
		{validConn},
	} {
		res := runMain(t, args, map[string]string{EnvConnectionString: validConn}, nil)
		if res.code != ExitUsage {
			t.Errorf("args %q: exit = %d, want %d", args, res.code, ExitUsage)
		}
		if len(res.mock.Calls()) != 0 {
			t.Errorf("args %q: published despite bad usage", args)
		}
		if strings.Contains(res.stdout+res.stderr, fakeKey) {
			t.Errorf("args %q: key leaked into output", args)
		}
	}
}

func TestMain_StrictlyIncreasingTimestampsWithFrozenClock(t *testing.T) {
	shutdown, _ := telemetry.SetupTracing(context.Background())
	defer shutdown()
	frozen := time.Date(2026, 11, 19, 12, 0, 0, 500_400_000, time.UTC)
	mock := iothub.NewMockClient()
	var stdout bytes.Buffer
	code := Main(context.Background(), Env{
		Args:      []string{"--count", "3"},
		Getenv:    func(string) string { return validConn },
		Stdout:    &stdout,
		Stderr:    &bytes.Buffer{},
		NewClient: func(string) (Client, error) { return mock, nil },
		Now:       func() time.Time { return frozen },
	})
	if code != ExitOK {
		t.Fatalf("exit = %d", code)
	}
	want := []string{"2026-11-19T12:00:00.500Z", "2026-11-19T12:00:00.501Z", "2026-11-19T12:00:00.502Z"}
	for i, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		var s Sent
		if err := json.Unmarshal([]byte(line), &s); err != nil {
			t.Fatal(err)
		}
		if s.Timestamp != want[i] {
			t.Errorf("line %d timestamp = %q, want %q", i, s.Timestamp, want[i])
		}
	}
}

// ackClient is a mock IoT Hub client whose acknowledgements take ackDelay.
// It counts how many publishes are awaiting their acknowledgement at once, and
// fails the acknowledgement of the async publishes and blocking retries it is
// told to. Messages are identified by their messageId property.
type ackClient struct {
	ackDelay time.Duration
	// failAsync fails the acknowledgement of the n-th async publish (1-based).
	failAsync map[int]bool
	// failRetry fails every blocking PublishTelemetry call.
	failRetry bool

	mu             sync.Mutex
	asyncCalls     int
	blockingCalls  int
	outstanding    int
	maxOutstanding int
	starts         []time.Time
	acked          []string // messageIds acknowledged, in ack order
}

func (c *ackClient) begin() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.outstanding++
	if c.outstanding > c.maxOutstanding {
		c.maxOutstanding = c.outstanding
	}
	c.starts = append(c.starts, time.Now())
	return c.outstanding
}

func (c *ackClient) end(messageID string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.outstanding--
	if ok {
		c.acked = append(c.acked, messageID)
	}
}

func (c *ackClient) PublishTelemetry(_ context.Context, _ []byte, props map[string]string) error {
	c.mu.Lock()
	c.blockingCalls++
	fail := c.failRetry
	c.mu.Unlock()
	c.begin()
	time.Sleep(c.ackDelay)
	c.end(props["messageId"], !fail)
	if fail {
		return errors.New("ack lost again")
	}
	return nil
}

func (c *ackClient) PublishTelemetryAsync(_ context.Context, _ []byte, props map[string]string) (func() error, error) {
	c.mu.Lock()
	c.asyncCalls++
	fail := c.failAsync[c.asyncCalls]
	c.mu.Unlock()
	c.begin()
	done := make(chan struct{})
	go func() {
		time.Sleep(c.ackDelay)
		c.end(props["messageId"], !fail)
		close(done)
	}()
	return func() error {
		<-done
		if fail {
			return errors.New("ack lost")
		}
		return nil
	}, nil
}

func (*ackClient) Close() error { return nil }

func (c *ackClient) snapshot() (asyncCalls, blockingCalls, maxOutstanding int, starts []time.Time, acked []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.asyncCalls, c.blockingCalls, c.maxOutstanding,
		append([]time.Time(nil), c.starts...), append([]string(nil), c.acked...)
}

// sentLines parses stdout into Sent lines, failing on anything else.
func sentLines(t *testing.T, stdout string) []Sent {
	t.Helper()
	var lines []Sent
	sc := bufio.NewScanner(strings.NewReader(stdout))
	for sc.Scan() {
		var s Sent
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&s); err != nil {
			t.Fatalf("stdout line %q is not the documented JSON shape: %v", sc.Text(), err)
		}
		lines = append(lines, s)
	}
	return lines
}

func distinctIDs(lines []Sent) map[string]bool {
	ids := map[string]bool{}
	for _, l := range lines {
		ids[l.MessageID] = true
	}
	return ids
}

func runWith(t *testing.T, cli *ackClient, args ...string) runResult {
	t.Helper()
	return runMain(t, args, map[string]string{EnvConnectionString: validConn},
		func(string) (Client, error) { return cli, nil })
}

// (a) --inflight 1, the default, keeps the old send: one blocking publish at a
// time, never the async one.
func TestMain_Inflight1SendsOneAtATime(t *testing.T) {
	for _, args := range [][]string{{"--count", "5"}, {"--count", "5", "--inflight", "1"}} {
		cli := &ackClient{ackDelay: 10 * time.Millisecond}
		res := runWith(t, cli, args...)
		if res.code != ExitOK {
			t.Fatalf("%q: exit = %d; stderr=%q", args, res.code, res.stderr)
		}
		async, blocking, maxOut, _, _ := cli.snapshot()
		if async != 0 || blocking != 5 {
			t.Errorf("%q: async=%d blocking=%d, want 0 and 5", args, async, blocking)
		}
		if maxOut != 1 {
			t.Errorf("%q: max outstanding = %d, want 1", args, maxOut)
		}
		if n := len(distinctIDs(sentLines(t, res.stdout))); n != 5 {
			t.Errorf("%q: %d distinct lines, want 5", args, n)
		}
	}
}

// (b) --count 100 --inflight 8: never more than 8 outstanding, 100 distinct lines.
func TestMain_InflightCapsOutstandingPublishes(t *testing.T) {
	cli := &ackClient{ackDelay: 15 * time.Millisecond}
	res := runWith(t, cli, "--count", "100", "--inflight", "8")
	if res.code != ExitOK {
		t.Fatalf("exit = %d; stderr=%q", res.code, res.stderr)
	}
	async, blocking, maxOut, _, acked := cli.snapshot()
	if async != 100 || blocking != 0 {
		t.Errorf("async=%d blocking=%d, want 100 and 0", async, blocking)
	}
	if maxOut > 8 {
		t.Errorf("max outstanding = %d, want <= 8", maxOut)
	}
	if maxOut < 2 {
		t.Errorf("max outstanding = %d: the sends were not pipelined", maxOut)
	}
	lines := sentLines(t, res.stdout)
	if len(lines) != 100 {
		t.Fatalf("stdout lines = %d, want 100", len(lines))
	}
	if n := len(distinctIDs(lines)); n != 100 {
		t.Errorf("distinct messageIds = %d, want 100", n)
	}
	for _, id := range acked {
		if !distinctIDs(lines)[id] {
			t.Errorf("acknowledged %s has no stdout line", id)
		}
	}
	for i, l := range lines {
		if _, err := time.Parse(timeLayout, l.SentAt); err != nil {
			t.Errorf("line %d sentAt %q: %v", i, l.SentAt, err)
		}
	}
}

// (c) --interval caps the start rate, whatever the ack latency: starts are at
// least the interval apart, and a slow ack does not add to the gap.
func TestMain_IntervalCapsStartRate(t *testing.T) {
	const interval = 20 * time.Millisecond
	cli := &ackClient{ackDelay: 100 * time.Millisecond}
	began := time.Now()
	res := runWith(t, cli, "--count", "10", "--inflight", "16", "--interval", "20ms")
	elapsed := time.Since(began)
	if res.code != ExitOK {
		t.Fatalf("exit = %d; stderr=%q", res.code, res.stderr)
	}
	_, _, _, starts, _ := cli.snapshot()
	if len(starts) != 10 {
		t.Fatalf("starts = %d, want 10", len(starts))
	}
	// Timer tolerance: a gap may be a little short of the interval only by
	// clock granularity, never by a whole interval.
	const slack = 5 * time.Millisecond
	for i := 1; i < len(starts); i++ {
		if gap := starts[i].Sub(starts[i-1]); gap < interval-slack {
			t.Errorf("start %d came %s after start %d, want >= %s", i, gap, i-1, interval)
		}
	}
	if total := starts[9].Sub(starts[0]); total < 9*(interval-slack) {
		t.Errorf("10 starts spanned %s, want >= %s", total, 9*interval)
	}
	// Sequential sends would take >= 10 × (100 ms ack + 20 ms) = 1.2 s.
	if elapsed > 900*time.Millisecond {
		t.Errorf("run took %s: the interval was added to the ack latency", elapsed)
	}
}

// (d) One failed ack, retried successfully with the blocking publish: exit 0
// and every line printed.
func TestMain_FailedAckRetriedOnce(t *testing.T) {
	cli := &ackClient{ackDelay: 5 * time.Millisecond, failAsync: map[int]bool{7: true}}
	res := runWith(t, cli, "--count", "20", "--inflight", "4")
	if res.code != ExitOK {
		t.Fatalf("exit = %d; stderr=%q", res.code, res.stderr)
	}
	async, blocking, _, _, acked := cli.snapshot()
	if async != 20 || blocking != 1 {
		t.Errorf("async=%d blocking=%d, want 20 and 1", async, blocking)
	}
	lines := sentLines(t, res.stdout)
	if len(lines) != 20 || len(distinctIDs(lines)) != 20 {
		t.Errorf("lines = %d (%d distinct), want 20", len(lines), len(distinctIDs(lines)))
	}
	if len(acked) != 20 {
		t.Errorf("acknowledged = %d, want 20", len(acked))
	}
}

// (e) An ack that fails twice: stop sending, drain what is in flight, exit 1,
// and print exactly one line per acknowledged message.
func TestMain_AckFailingTwiceExits1(t *testing.T) {
	cli := &ackClient{ackDelay: 10 * time.Millisecond, failAsync: map[int]bool{5: true}, failRetry: true}
	res := runWith(t, cli, "--count", "100", "--inflight", "8")
	if res.code != ExitSendFailed {
		t.Fatalf("exit = %d, want %d; stderr=%q", res.code, ExitSendFailed, res.stderr)
	}
	async, blocking, _, _, acked := cli.snapshot()
	if blocking != 1 {
		t.Errorf("blocking retries = %d, want 1", blocking)
	}
	if async >= 100 {
		t.Errorf("all %d readings were started: sending did not stop", async)
	}
	lines := sentLines(t, res.stdout)
	if len(lines) != len(acked) {
		t.Errorf("stdout lines = %d, acknowledged = %d: they must match", len(lines), len(acked))
	}
	if len(acked) != async-1 {
		t.Errorf("acknowledged = %d of %d started: the in-flight sends were not drained", len(acked), async)
	}
	ids := distinctIDs(lines)
	for _, id := range acked {
		if !ids[id] {
			t.Errorf("acknowledged %s has no stdout line", id)
		}
	}
	if !strings.Contains(res.stderr, "send reading 5 of 100") || !strings.Contains(res.stderr, "acknowledged") {
		t.Errorf("stderr should name the failed reading and the acknowledged count: %q", res.stderr)
	}
	if strings.Contains(res.stderr, fakeKey) {
		t.Error("the key leaked into stderr")
	}
}

func TestMain_PipelinedSendFailureExitsNonZeroAndRedacts(t *testing.T) {
	cli := failingClient{err: errors.New("connect failed using " + validConn)}
	res := runMain(t, []string{"--count", "5", "--inflight", "4"}, map[string]string{EnvConnectionString: validConn},
		func(string) (Client, error) { return cli, nil })
	if res.code != ExitSendFailed {
		t.Fatalf("exit = %d, want %d", res.code, ExitSendFailed)
	}
	if res.stdout != "" {
		t.Errorf("no line may be printed for an unacknowledged message; stdout=%q", res.stdout)
	}
	if strings.Contains(res.stderr, fakeKey) || strings.Contains(res.stderr, validConn) {
		t.Errorf("credential leaked into stderr: %q", res.stderr)
	}
}

// HAR-87: --start/--step stamp reading i as start + i×step, at millisecond
// precision, in both the sequential (--inflight 1) and pipelined senders. The
// wall clock is frozen far from start, so a clock stamp would show.
func TestMain_StartStepStampsSyntheticTimestamps(t *testing.T) {
	shutdown, _ := telemetry.SetupTracing(context.Background())
	defer shutdown()
	start := time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)
	frozen := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	for _, inflight := range []string{"1", "4"} {
		t.Run("inflight="+inflight, func(t *testing.T) {
			mock := iothub.NewMockClient()
			var stdout, stderr bytes.Buffer
			code := Main(context.Background(), Env{
				Args: []string{"--count", "6", "--inflight", inflight,
					"--start", "2026-11-01T06:00:00.000Z", "--step", "5s"},
				Getenv:    func(string) string { return validConn },
				Stdout:    &stdout,
				Stderr:    &stderr,
				NewClient: func(string) (Client, error) { return mock, nil },
				Tracer:    otel.Tracer("simdevice-test"),
				Now:       func() time.Time { return frozen },
			})
			if code != ExitOK {
				t.Fatalf("exit = %d; stderr=%q", code, stderr.String())
			}
			lines := sentLines(t, stdout.String())
			byID := map[string]Sent{}
			for _, l := range lines {
				byID[l.MessageID] = l
			}
			calls := mock.Calls() // in send-start order: reading 0 first
			if len(calls) != 6 || len(byID) != 6 {
				t.Fatalf("calls = %d, distinct lines = %d, want 6 and 6", len(calls), len(byID))
			}
			for i, call := range calls {
				want := start.Add(time.Duration(i) * 5 * time.Second)
				var reading wire.TemperatureReading
				if err := json.Unmarshal(call.Payload, &reading); err != nil {
					t.Fatalf("call %d payload: %v", i, err)
				}
				if !reading.Timestamp.Equal(want) {
					t.Errorf("reading %d payload timestamp = %s, want %s", i, reading.Timestamp, want)
				}
				line, ok := byID[call.Properties["messageId"]]
				if !ok {
					t.Fatalf("reading %d has no stdout line", i)
				}
				if line.Timestamp != want.Format(timeLayout) {
					t.Errorf("reading %d stdout timestamp = %q, want %q", i, line.Timestamp, want.Format(timeLayout))
				}
				if line.SentAt != frozen.Format(timeLayout) {
					t.Errorf("reading %d sentAt = %q, want the clock %q", i, line.SentAt, frozen.Format(timeLayout))
				}
			}
		})
	}
}

// HAR-87: sub-millisecond precision in --start is dropped, and the stamps stay
// strictly increasing at millisecond precision.
func TestMain_StartTruncatedToMilliseconds(t *testing.T) {
	cli := &ackClient{}
	res := runWith(t, cli, "--count", "3", "--start", "2026-11-01T06:00:00.123456789+02:00", "--step", "1ms")
	if res.code != ExitOK {
		t.Fatalf("exit = %d; stderr=%q", res.code, res.stderr)
	}
	want := []string{"2026-11-01T04:00:00.123Z", "2026-11-01T04:00:00.124Z", "2026-11-01T04:00:00.125Z"}
	for i, l := range sentLines(t, res.stdout) {
		if l.Timestamp != want[i] {
			t.Errorf("line %d timestamp = %q, want %q", i, l.Timestamp, want[i])
		}
	}
}

// HAR-87: --start without --step, or --step without --start, is a usage error,
// as are a bad --start and a --step under a millisecond. Nothing is sent.
func TestMain_StartStepUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"--start", "2026-11-01T06:00:00Z"},
		{"--step", "5s"},
		{"--step", "0s"},
		{"--start", "2026-11-01T06:00:00Z", "--step", "0s"},
		{"--start", "2026-11-01T06:00:00Z", "--step", "500us"},
		{"--start", "2026-11-01T06:00:00Z", "--step", "-5s"},
		{"--start", "yesterday", "--step", "5s"},
		{"--start", "2026-11-01", "--step", "5s"},
	} {
		res := runMain(t, args, map[string]string{EnvConnectionString: validConn}, nil)
		if res.code != ExitUsage {
			t.Errorf("args %q: exit = %d, want %d; stderr=%q", args, res.code, ExitUsage, res.stderr)
		}
		if len(res.mock.Calls()) != 0 {
			t.Errorf("args %q: published despite bad usage", args)
		}
	}
}

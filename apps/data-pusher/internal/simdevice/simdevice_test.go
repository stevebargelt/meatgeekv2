package simdevice

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
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

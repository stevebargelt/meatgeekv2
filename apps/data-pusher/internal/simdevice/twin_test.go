package simdevice

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"

	"go.opentelemetry.io/otel"
)

// runTwinMain runs Main with the real twin client (the Pi's code) pointed at
// the fake hub b.
func runTwinMain(t *testing.T, b *iothubtest.Broker, args ...string) runResult {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Main(context.Background(), Env{
		Args:   args,
		Getenv: func(k string) string { return map[string]string{EnvConnectionString: validConn}[k] },
		Stdout: &stdout,
		Stderr: &stderr,
		NewClient: func(string) (Client, error) {
			t.Fatal("--twin must use NewTwinClient")
			return nil, nil
		},
		NewTwinClient: func(cs string, opts ...iothub.Option) (TwinClient, error) {
			return iothub.NewAzureClient(cs, append(opts, iothub.WithBrokerURL(b.URL()))...)
		},
		Tracer: otel.Tracer("simdevice-twin-test"),
	})
	return runResult{code: code, stdout: stdout.String(), stderr: stderr.String()}
}

func stdoutLines(s string) []string {
	return strings.Split(strings.TrimRight(s, "\n"), "\n")
}

// --twin applies the desired cook, reports it, prints the twin read back as
// one JSON line, then sends --count readings carrying that cook.
func TestTwin_PrintsTwinLineThenSendsReadingsWithTheCook(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetDesiredQuietly(map[string]any{"activeCookId": "c1", "correlationId": "r1"}) // $version 2

	res := runTwinMain(t, b, "--twin", "--count", "2", "--timeout", "5s")
	if res.code != ExitOK {
		t.Fatalf("exit %d, stderr: %s", res.code, res.stderr)
	}
	lines := stdoutLines(res.stdout)
	if len(lines) != 3 {
		t.Fatalf("want 3 stdout lines (twin + 2 readings), got %d:\n%s", len(lines), res.stdout)
	}
	const wantTwin = `{"event":"twin","desired":{"activeCookId":"c1","correlationId":"r1","$version":2},"reported":{"activeCookId":"c1","correlationId":"r1","appliedDesiredVersion":2}}`
	if lines[0] != wantTwin {
		t.Errorf("twin line:\n got %s\nwant %s", lines[0], wantTwin)
	}
	for _, l := range lines[1:] {
		var s Sent
		if err := json.Unmarshal([]byte(l), &s); err != nil || s.MessageID == "" {
			t.Errorf("reading line %q: %v", l, err)
		}
	}

	tel := b.Telemetry()
	if len(tel) != 2 {
		t.Fatalf("hub got %d readings, want 2", len(tel))
	}
	for _, m := range tel {
		var body struct {
			CookID *string `json:"cookId"`
		}
		if err := json.Unmarshal(m.Payload, &body); err != nil {
			t.Fatalf("payload: %v", err)
		}
		if body.CookID == nil || *body.CookID != "c1" {
			t.Errorf("reading cookId = %v, want c1", body.CookID)
		}
		if got := m.Properties.Get(iothub.CorrelationIDPropertyName); got != "r1" {
			t.Errorf("reading correlation.id = %q, want r1", got)
		}
	}
	if n := b.Connections(); n != 1 {
		t.Errorf("connections = %d, want 1 (twin and telemetry share it)", n)
	}
}

func TestTwin_NoCookAndCountZero(t *testing.T) {
	b := iothubtest.NewBroker(t)
	res := runTwinMain(t, b, "--twin", "--count", "0", "--timeout", "5s")
	if res.code != ExitOK {
		t.Fatalf("exit %d, stderr: %s", res.code, res.stderr)
	}
	const want = `{"event":"twin","desired":{"activeCookId":null,"correlationId":null,"$version":1},"reported":{"activeCookId":null,"correlationId":null,"appliedDesiredVersion":1}}` + "\n"
	if res.stdout != want {
		t.Errorf("stdout:\n got %s\nwant %s", res.stdout, want)
	}
	if n := len(b.Telemetry()); n != 0 {
		t.Errorf("--count 0 sent %d readings", n)
	}
}

func TestTwin_NoTwinResponseExitsNonZero(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetUnresponsive(true)
	res := runTwinMain(t, b, "--twin", "--timeout", "300ms")
	if res.code == ExitOK {
		t.Fatal("exit 0 with no twin response")
	}
	if !strings.Contains(res.stderr, "no twin response from IoT Hub within 300ms") {
		t.Errorf("stderr should say no twin response arrived; got %q", res.stderr)
	}
	if res.stdout != "" {
		t.Errorf("stdout must be empty; got %q", res.stdout)
	}
	if strings.Contains(res.stderr, fakeKey) {
		t.Errorf("key leaked: %q", res.stderr)
	}
	if n := len(b.Telemetry()); n != 0 {
		t.Errorf("sent %d readings after a twin timeout", n)
	}
}

func TestTwin_BadFlags(t *testing.T) {
	b := iothubtest.NewBroker(t)
	for _, args := range [][]string{
		{"--twin", "--count", "-1"},
		{"--twin", "--timeout", "0s"},
		{"--count", "0"}, // --count 0 is only meaningful with --twin
	} {
		if res := runTwinMain(t, b, args...); res.code != ExitUsage {
			t.Errorf("%v: exit %d, want %d (stderr %q)", args, res.code, ExitUsage, res.stderr)
		}
	}
}

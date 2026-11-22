package simdevice

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/claim"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/dpsmode"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/provision"

	"go.opentelemetry.io/otel"
)

// runClaimCode runs `simdevice claim-code --state-dir dir` at now.
func runClaimCode(t *testing.T, dir string, now time.Time) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Main(context.Background(), Env{
		Args:   []string{"claim-code", "--state-dir", dir},
		Getenv: func(string) string { return "" },
		Stdout: &stdout,
		Stderr: &stderr,
		Clock:  clocktest.New(now),
	})
	return code, stdout.String(), stderr.String()
}

func TestClaimCode_Simdevice(t *testing.T) {
	const code = "7K3M9QXR2HTV"
	expires := clockStart.Add(time.Hour)
	st := claim.State{DeviceID: "sim-1", Code: code, CodeHash: claim.Hash("sim-1", code), ExpiresAt: expires}
	dir := t.TempDir()

	if c, out, errOut := runClaimCode(t, dir, clockStart); c != dpsmode.ExitNoClaim || out != "" {
		t.Fatalf("missing: exit %d, stdout %q, stderr %q", c, out, errOut)
	}
	if err := claim.Save(dir, st); err != nil {
		t.Fatal(err)
	}
	want := `{"deviceId":"sim-1","state":"unclaimed","claimCode":"7K3M-9QXR-2HTV","expiresAt":"` + expires.UTC().Format(time.RFC3339) + `"}` + "\n"
	if c, out, _ := runClaimCode(t, dir, clockStart); c != 0 || out != want {
		t.Errorf("unclaimed: exit %d, stdout %q, want %q", c, out, want)
	}
	if c, out, _ := runClaimCode(t, dir, expires); c != 0 || out != `{"deviceId":"sim-1","state":"expired"}`+"\n" {
		t.Errorf("expired: exit %d, stdout %q", c, out)
	}
	st.Claimed = true
	if err := claim.Save(dir, st); err != nil {
		t.Fatal(err)
	}
	if c, out, _ := runClaimCode(t, dir, clockStart); c != 0 || out != `{"deviceId":"sim-1","state":"claimed"}`+"\n" {
		t.Errorf("claimed: exit %d, stdout %q", c, out)
	}
}

// simdevice --twin --count 0 in DPS mode mints and reports a code, then
// exits; run again it re-reports the same code from its state dir; run after
// a release it mints a new one under the new generation. claim-code prints
// the code whose hash is in the twin.
func TestMain_DPSTwinMintsAClaimCodeAndANewOneAfterARelease(t *testing.T) {
	const deviceID = "sim-claim-1"
	state := t.TempDir()
	broker := iothubtest.NewBroker(t)
	clk := clocktest.New(clockStart)
	if err := provision.SaveAssignment(state, provision.Assignment{AssignedHub: "hub-dev.azure-devices.net", DeviceID: deviceID, RegisteredAt: clk.Now()}); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		dpsmode.EnvIDScope:  "0ne00ABCDEF",
		dpsmode.EnvDeviceID: deviceID,
		dpsmode.EnvStateDir: state,
	}
	twinRun := func() {
		t.Helper()
		var stdout, stderr bytes.Buffer
		code := Main(context.Background(), Env{
			Args:   []string{"--twin", "--count", "0"},
			Getenv: func(k string) string { return env[k] },
			Stdout: &stdout,
			Stderr: &stderr,
			NewDPSClient: func(cfg dpsmode.Config, clk clock.Clock, opts ...iothub.Option) (TwinClient, error) {
				return dpsmode.NewClient(cfg, clk, nil, append(opts, iothub.WithBrokerURL(broker.URL()))...)
			},
			NewTwinClient: AzureTwinClientFactory,
			Tracer:        otel.Tracer("simdevice-claim-test"),
			Clock:         clk,
		})
		if code != ExitOK {
			t.Fatalf("simdevice --twin --count 0: exit %d; stderr=%q", code, stderr.String())
		}
		var line TwinLine
		if err := json.Unmarshal(stdout.Bytes(), &line); err != nil || line.Event != "twin" {
			t.Fatalf("stdout = %q, want the twin line only", stdout.String())
		}
	}
	printed := func() dpsmode.ClaimCodeLine {
		t.Helper()
		c, out, errOut := runClaimCode(t, state, clk.Now())
		var line dpsmode.ClaimCodeLine
		if c != 0 || json.Unmarshal([]byte(out), &line) != nil {
			t.Fatalf("claim-code: exit %d, stdout %q, stderr %q", c, out, errOut)
		}
		return line
	}
	reportedFor := func(line dpsmode.ClaimCodeLine, gen string) {
		t.Helper()
		code, ok := claim.Normalize(line.ClaimCode)
		if line.State != "unclaimed" || !ok || line.DeviceID != deviceID {
			t.Fatalf("claim-code printed %+v", line)
		}
		r := broker.Reported()
		if r[claim.ReportedCodeHash] != claim.Hash(deviceID, code) || r[claim.Generation] != gen || r[claim.ReportedExpiresAt] != line.ExpiresAt {
			t.Fatalf("reported %v, want the hash of the printed code under generation %s", r, gen)
		}
	}

	twinRun()
	first := printed()
	reportedFor(first, "0")
	if first.ExpiresAt != clockStart.Add(claim.Lifetime).UTC().Format(time.RFC3339) {
		t.Errorf("expiresAt = %s, want 24h after the run", first.ExpiresAt)
	}

	twinRun()
	if again := printed(); again != first {
		t.Fatalf("a second run changed the code: %+v, then %+v", first, again)
	}

	broker.SetDesiredQuietly(map[string]any{claim.Generation: "1", claim.DesiredConsumedCodeHash: broker.Reported()[claim.ReportedCodeHash]})
	twinRun()
	released := printed()
	if released.ClaimCode == first.ClaimCode {
		t.Fatal("no new code after the release")
	}
	reportedFor(released, "1")
}

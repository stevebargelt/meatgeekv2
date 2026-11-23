package iothub

import (
	"bytes"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/await"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/claim"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/iothub/iothubtest"
)

// claimReader is a deterministic random source: plenty of bytes for several
// mints, each mint different.
func claimReader() *bytes.Reader {
	b := make([]byte, 0, 20*claim.Length)
	for i := 0; i < 20*claim.Length; i++ {
		b = append(b, byte(i*7))
	}
	return bytes.NewReader(b)
}

// newClaimDevice is the real claim code of dev1 under dir, on its own fake
// clock (no code expires in these tests) and the deterministic reader.
func newClaimDevice(dir string) *claim.Device {
	return claim.NewDevice(dir, "dev1", clocktest.New(testClockStart), claimReader())
}

// orderCheck records, for every reported patch the broker accepts, whether
// the claim file on disk already held the hash the patch reports.
type orderCheck struct {
	mu        sync.Mutex
	checked   int
	violation string
}

func watchClaimOrder(b *iothubtest.Broker, stateDir string) *orderCheck {
	oc := &orderCheck{}
	b.OnReport(func(patch map[string]any) {
		h, ok := patch[claim.ReportedCodeHash].(string)
		if !ok {
			return
		}
		s, err := claim.Load(stateDir)
		oc.mu.Lock()
		defer oc.mu.Unlock()
		oc.checked++
		if err != nil || s.CodeHash != h || patch[claim.Generation] != strconv.FormatInt(s.Generation, 10) {
			oc.violation = fmt.Sprintf("patch reported %s gen %v, but the claim file held %+v (%v)", h, patch[claim.Generation], s, err)
		}
	})
	return oc
}

func (oc *orderCheck) verify(t *testing.T) {
	t.Helper()
	oc.mu.Lock()
	defer oc.mu.Unlock()
	if oc.checked == 0 {
		t.Fatal("no reported patch carried a claim hash")
	}
	if oc.violation != "" {
		t.Fatal(oc.violation)
	}
}

func lastClaim(b *iothubtest.Broker) (hash, expires, gen any) {
	r := lastReport(b)
	return r[claim.ReportedCodeHash], r[claim.ReportedExpiresAt], r[claim.Generation]
}

// The whole device-side claim cycle against a fake hub: mint at start, keep
// across a cook-only patch, keep when claimed, mint under the new generation
// on a release. Every report carries both the cook and the claim properties,
// and the claim file always holds a hash before it is reported.
func TestTwinClaim_MintKeepClaimRelease(t *testing.T) {
	b := iothubtest.NewBroker(t)
	dir := t.TempDir()
	oc := watchClaimOrder(b, dir)
	st := &memState{}
	startTwinClient(t, b, st, WithClaim(newClaimDevice(dir)))

	// Start: a code is minted under generation 0 and reported with the cook.
	s, err := claim.Load(dir)
	if err != nil {
		t.Fatalf("no claim file after the first sync: %v", err)
	}
	first := lastReport(b)
	if first[claim.ReportedCodeHash] != s.CodeHash || s.CodeHash != claim.Hash("dev1", s.Code) {
		t.Fatalf("first report %v, claim file %+v", first, s)
	}
	if first[claim.Generation] != "0" || first[claim.ReportedExpiresAt] != s.ExpiresAt.UTC().Format(time.RFC3339) {
		t.Errorf("first report %v", first)
	}
	if _, ok := first["activeCookId"]; !ok || first["appliedDesiredVersion"] != float64(1) {
		t.Errorf("the claim report dropped the cook properties: %v", first)
	}

	// A patch touching only the cook: no new code, and the claim properties
	// ride along unchanged.
	v := b.SetDesired(map[string]any{"activeCookId": "c1", "correlationId": "r1"})
	awaitReport(t, b, "the cook patch's report", "c1", "r1", v)
	if h, e, g := lastClaim(b); h != s.CodeHash || e != first[claim.ReportedExpiresAt] || g != "0" {
		t.Fatalf("the cook report changed or dropped the claim: %v", lastReport(b))
	}

	// The API claims it: same code, recorded as claimed.
	v = b.SetDesired(map[string]any{claim.DesiredConsumedCodeHash: s.CodeHash, "claimClaimantHash": "claimant-of-dev1"})
	awaitReport(t, b, "the claim patch's report", "c1", "r1", v)
	if h, _, g := lastClaim(b); h != s.CodeHash || g != "0" {
		t.Fatalf("claimed: report %v", lastReport(b))
	}
	if got, _ := claim.Load(dir); !got.Claimed || got.CodeHash != s.CodeHash {
		t.Errorf("claim file after the claim = %+v", got)
	}

	// The API releases it: a new code under generation 1; the cook stays.
	v = b.SetDesired(map[string]any{claim.Generation: "1", "claimClaimantHash": nil})
	awaitReport(t, b, "the release patch's report", "c1", "r1", v)
	released, err := claim.Load(dir)
	if err != nil || released.CodeHash == s.CodeHash || released.Generation != 1 || released.Claimed {
		t.Fatalf("claim file after the release = %+v, %v", released, err)
	}
	if h, _, g := lastClaim(b); h != released.CodeHash || g != "1" {
		t.Fatalf("release report %v", lastReport(b))
	}
	if n := len(b.TwinGets()); n != 1 {
		t.Errorf("twin GETs = %d, want 1 (claim patches merge, not re-GET)", n)
	}
	oc.verify(t)
}

// A release written while the device was offline is applied by the GET on
// the next connect, and a twin that lost the reported claim gets it back.
func TestTwinClaim_ReleaseWhileOfflineAndReReportAfterReconnect(t *testing.T) {
	b := iothubtest.NewBroker(t)
	dir := t.TempDir()
	oc := watchClaimOrder(b, dir)
	st := &memState{}
	_, clk := startTwinClient(t, b, st, WithClaim(newClaimDevice(dir)))
	before, _ := claim.Load(dir)

	b.SetDesiredQuietly(map[string]any{claim.Generation: "5"})
	dropAndRedial(t, b, clk)
	await.Until(t, "the report under generation 5", func() bool {
		h, _, g := lastClaim(b)
		return g == "5" && h != before.CodeHash
	}, func() any { return lastReport(b) }, b)
	after, _ := claim.Load(dir)
	if after.Generation != 5 || after.CodeHash == before.CodeHash {
		t.Fatalf("claim file = %+v", after)
	}

	// Another reconnect with nothing changed re-reports the same code.
	n := len(b.ReportedPatches())
	dropAndRedial(t, b, clk)
	await.Until(t, "a report after the second reconnect", func() bool { return len(b.ReportedPatches()) > n },
		func() any { return b.ReportedPatches() }, b)
	if h, _, g := lastClaim(b); h != after.CodeHash || g != "5" {
		t.Fatalf("re-report = %v", lastReport(b))
	}
	oc.verify(t)
}

// A failed claim sync never holds up the cook: the report still goes out with
// the cook (and without a claim it cannot back with a file).
func TestTwinClaim_FailureStillReportsTheCook(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetDesiredQuietly(map[string]any{"activeCookId": "c1", "correlationId": "r1"})
	st := &memState{}
	failing := claim.NewDevice(t.TempDir(), "dev1", clocktest.New(testClockStart), bytes.NewReader(nil)) // no randomness: every mint fails
	startTwinClient(t, b, st, WithClaim(failing))
	r := lastReport(b)
	if !reportIs(b, "c1", "r1", 2)() {
		t.Fatalf("report = %v", r)
	}
	if _, ok := r[claim.ReportedCodeHash]; ok {
		t.Errorf("reported a claim hash with no code on disk: %v", r)
	}
}

// Without WithClaim the reported patch is exactly the cook properties, as
// before HAR-130.
func TestTwinClaim_NoClaimPropertiesWithoutWithClaim(t *testing.T) {
	b := iothubtest.NewBroker(t)
	b.SetDesiredQuietly(map[string]any{claim.Generation: "3", claim.DesiredConsumedCodeHash: "h"})
	startTwinClient(t, b, &memState{})
	for _, p := range b.ReportedPatches() {
		if len(p) != 3 {
			t.Errorf("reported patch %v, want only activeCookId, correlationId, appliedDesiredVersion", p)
		}
	}
}

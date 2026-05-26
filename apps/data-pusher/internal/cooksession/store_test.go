package cooksession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// newTestStore opens a Store at a unique temp path so tests do not
// collide and never need to write to /var/lib.
func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "cooksession.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

func strPtr(s string) *string { return &s }

// captureLogs swaps the logrus output for the duration of the callback and
// returns whatever was written. Lets tests assert on the "override" /
// "unreachable" log lines that operators rely on.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	orig := logrus.StandardLogger().Out
	origLevel := logrus.GetLevel()
	buf := &bytes.Buffer{}
	logrus.SetOutput(buf)
	logrus.SetLevel(logrus.DebugLevel)
	t.Cleanup(func() {
		logrus.SetOutput(orig)
		logrus.SetLevel(origLevel)
	})
	fn()
	return buf.String()
}

func TestSetActiveCookID_PersistsAcrossReopen(t *testing.T) {
	s, path := newTestStore(t)

	if got := s.ActiveCookID(); got != nil {
		t.Fatalf("fresh store: want nil cookId, got %q", *got)
	}

	if err := s.SetActiveCookID(strPtr("cook-abc")); err != nil {
		t.Fatalf("SetActiveCookID: %v", err)
	}

	// Reopen the same path and confirm the value survived.
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("Open (second): %v", err)
	}
	got := s2.ActiveCookID()
	if got == nil || *got != "cook-abc" {
		t.Fatalf("after reopen: want cook-abc, got %v", got)
	}

	// Confirm the file format on disk -- updatedAt should be present and
	// recent, cookId should be the string we set.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state file: %v", err)
	}
	var ps persistedState
	if err := json.Unmarshal(raw, &ps); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	if ps.CookID == nil || *ps.CookID != "cook-abc" {
		t.Fatalf("file cookId: want cook-abc, got %v", ps.CookID)
	}
	if time.Since(ps.UpdatedAt) > time.Minute {
		t.Fatalf("file updatedAt too old: %v", ps.UpdatedAt)
	}

	// Clearing also persists.
	if err := s2.SetActiveCookID(nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	s3, err := Open(path)
	if err != nil {
		t.Fatalf("Open (third): %v", err)
	}
	if got := s3.ActiveCookID(); got != nil {
		t.Fatalf("after reopen post-clear: want nil, got %q", *got)
	}
}

func TestActiveCookID_ReturnsIndependentCopy(t *testing.T) {
	s, _ := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("cook-1")); err != nil {
		t.Fatalf("SetActiveCookID: %v", err)
	}
	got := s.ActiveCookID()
	if got == nil {
		t.Fatal("got nil")
	}
	// Mutating the returned pointee must not affect internal state.
	*got = "mutated"
	again := s.ActiveCookID()
	if again == nil || *again != "cook-1" {
		t.Fatalf("internal state leaked through returned pointer: %v", again)
	}
}

// Race coverage: many concurrent ActiveCookID readers running alongside
// a SetActiveCookID writer must not data-race under -race.
func TestConcurrentReadersAndWriter(t *testing.T) {
	s, _ := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("seed")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	var wg sync.WaitGroup
	// Readers.
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				default:
					_ = s.ActiveCookID()
				}
			}
		}()
	}
	// Writer.
	wg.Add(1)
	go func() {
		defer wg.Done()
		i := 0
		for {
			select {
			case <-ctx.Done():
				return
			default:
				id := "cook-" + itoa(i)
				if err := s.SetActiveCookID(&id); err != nil {
					t.Errorf("SetActiveCookID: %v", err)
					return
				}
				i++
			}
		}
	}()

	wg.Wait()
}

// itoa avoids strconv import noise in the single line where we need it.
func itoa(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = digits[i%10]
		i /= 10
	}
	return string(b[pos:])
}

func TestReconcile_ActiveCookOverridesPersisted(t *testing.T) {
	s, _ := newTestStore(t)
	// Seed a now-stale value.
	if err := s.SetActiveCookID(strPtr("cook-old")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var capturedURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedURL = r.URL.String()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"cooks":[{"id":"cook-new","status":"active","deviceId":"meatgeek3"}],"total":1,"offset":0,"limit":20,"hasMore":false}`)
	}))
	defer srv.Close()

	logs := captureLogs(t, func() {
		if err := s.Reconcile(context.Background(), srv.URL, "meatgeek3"); err != nil {
			t.Fatalf("Reconcile: %v", err)
		}
	})

	if got := s.ActiveCookID(); got == nil || *got != "cook-new" {
		t.Fatalf("after reconcile: want cook-new, got %v", got)
	}

	if !strings.Contains(capturedURL, "deviceId=meatgeek3") {
		t.Errorf("request URL missing deviceId filter: %s", capturedURL)
	}
	if !strings.Contains(capturedURL, "status=active") {
		t.Errorf("request URL missing status filter: %s", capturedURL)
	}

	// Operator-visible "override" log line is required so the reason for
	// a swap is auditable in journald.
	if !strings.Contains(logs, "reconciled active cook id") {
		t.Errorf("expected override log line, got: %s", logs)
	}
	if !strings.Contains(logs, "cook-old") || !strings.Contains(logs, "cook-new") {
		t.Errorf("override log missing previous/current values: %s", logs)
	}
}

func TestReconcile_404ClearsPersisted(t *testing.T) {
	s, _ := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("cook-old")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	if err := s.Reconcile(context.Background(), srv.URL, "meatgeek3"); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	if got := s.ActiveCookID(); got != nil {
		t.Fatalf("after 404 reconcile: want nil, got %q", *got)
	}
}

func TestReconcile_UnreachableLeavesPersistedUnchanged(t *testing.T) {
	s, _ := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("cook-old")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// 127.0.0.1:1 is reliably refused by the OS without DNS or timeout
	// games. Combined with the short reconcileTimeout this stays fast.
	logs := captureLogs(t, func() {
		err := s.Reconcile(context.Background(), "http://127.0.0.1:1", "meatgeek3")
		if err == nil {
			t.Fatal("Reconcile: want error, got nil")
		}
		if !errors.Is(err, ErrAPIUnreachable) {
			t.Errorf("Reconcile: want ErrAPIUnreachable wrap, got %v", err)
		}
	})

	if got := s.ActiveCookID(); got == nil || *got != "cook-old" {
		t.Fatalf("persisted value changed despite unreachable API: %v", got)
	}
	if !strings.Contains(logs, "reconcile API call failed") {
		t.Errorf("expected operator-visible unreachable warning, got: %s", logs)
	}
}

func TestReconcile_CompletedCookClearsLocal(t *testing.T) {
	// Scenario 6: cook_stopped happened while pusher was offline; the
	// API now lists the previously-active cook as completed (or returns
	// no active cooks at all). Either way, our local file must clear so
	// subsequent TemperatureReadings don't carry the stale cookId.
	s, _ := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("cook-abc")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Server is honest about status=active filter: returns an
		// empty cooks list because cook-abc is now completed.
		_, _ = io.WriteString(w, `{"cooks":[],"total":0,"offset":0,"limit":20,"hasMore":false}`)
	}))
	defer srv.Close()

	if err := s.Reconcile(context.Background(), srv.URL, "meatgeek3"); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	if got := s.ActiveCookID(); got != nil {
		t.Fatalf("after stopped-cook reconcile: want nil, got %q", *got)
	}
}

func TestReconcile_NonActiveStatusInResponseIsIgnored(t *testing.T) {
	// Defense-in-depth: if the API ignores the status filter (or a
	// future schema change leaks a "paused" cook through), the picker
	// must still only treat status="active" as active.
	s, _ := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("cook-old")); err != nil {
		t.Fatalf("seed: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"cooks":[{"id":"cook-stale","status":"completed"},{"id":"cook-pending","status":"planning"}],"total":2,"offset":0,"limit":20,"hasMore":false}`)
	}))
	defer srv.Close()

	if err := s.Reconcile(context.Background(), srv.URL, "meatgeek3"); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := s.ActiveCookID(); got != nil {
		t.Fatalf("want nil after no-active response, got %q", *got)
	}
}

func TestReconcile_NoChangeDoesNotRewriteFile(t *testing.T) {
	// Steady-state reconcile must not churn disk: when the API and the
	// local state agree, the file's updatedAt is left alone.
	s, path := newTestStore(t)
	if err := s.SetActiveCookID(strPtr("cook-steady")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	// Sleep a beat so mtime resolution can distinguish a rewrite.
	time.Sleep(10 * time.Millisecond)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"cooks":[{"id":"cook-steady","status":"active"}],"total":1,"offset":0,"limit":20,"hasMore":false}`)
	}))
	defer srv.Close()

	if err := s.Reconcile(context.Background(), srv.URL, "meatgeek3"); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat after: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("steady-state reconcile rewrote the file (before=%v after=%v)", before.ModTime(), after.ModTime())
	}
}

func TestReconcile_RequiresBaseURLAndDeviceID(t *testing.T) {
	s, _ := newTestStore(t)
	if err := s.Reconcile(context.Background(), "", "meatgeek3"); err == nil {
		t.Error("want error for empty apiBaseURL")
	}
	if err := s.Reconcile(context.Background(), "http://example.test", ""); err == nil {
		t.Error("want error for empty deviceID")
	}
}

func TestOpen_FallsBackWhenDefaultPathUnwritable(t *testing.T) {
	// Probe via a path that should fail mkdir as non-root. We simulate
	// the production failure mode by pointing at a path under a regular
	// file (mkdir of a child fails with ENOTDIR).
	dir := t.TempDir()
	occupied := filepath.Join(dir, "occupied")
	if err := os.WriteFile(occupied, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed occupied file: %v", err)
	}
	// Now ask for a state path whose parent is `occupied` (a regular
	// file, not a dir): resolveWritablePath should fall back to the
	// user home location.
	requested := filepath.Join(occupied, "cooksession.json")

	// Redirect HOME so the fallback lands in our test sandbox.
	tmpHome := filepath.Join(dir, "home")
	if err := os.MkdirAll(tmpHome, 0o755); err != nil {
		t.Fatalf("mkdir home: %v", err)
	}
	t.Setenv("HOME", tmpHome)

	s, err := Open(requested)
	if err != nil {
		t.Fatalf("Open with fallback: %v", err)
	}
	if !strings.HasPrefix(s.Path(), tmpHome) {
		t.Fatalf("expected path under fallback HOME=%s, got %s", tmpHome, s.Path())
	}

	if err := s.SetActiveCookID(strPtr("cook-fb")); err != nil {
		t.Fatalf("SetActiveCookID on fallback: %v", err)
	}
}

func TestOpen_CorruptStateFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cooksession.json")
	if err := os.WriteFile(path, []byte("{not valid json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if got := s.ActiveCookID(); got != nil {
		t.Fatalf("corrupt-recovery: want nil cookId, got %q", *got)
	}
	// And a write should heal the file.
	if err := s.SetActiveCookID(strPtr("cook-healed")); err != nil {
		t.Fatalf("SetActiveCookID after corrupt: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	if got := s2.ActiveCookID(); got == nil || *got != "cook-healed" {
		t.Fatalf("after heal: want cook-healed, got %v", got)
	}
}

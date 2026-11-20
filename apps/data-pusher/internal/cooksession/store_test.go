package cooksession

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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

func deref(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestApplyDesired_PersistsAllThreeAcrossReopen(t *testing.T) {
	s, path := newTestStore(t)
	if got := s.Snapshot(); got.CookID != nil || got.CorrelationID != nil || got.AppliedDesiredVersion != 0 {
		t.Fatalf("fresh store not empty: %+v", got)
	}

	if err := s.ApplyDesired(strPtr("cook-1"), strPtr("corr-1"), 7); err != nil {
		t.Fatalf("ApplyDesired: %v", err)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := s2.Snapshot()
	if deref(got.CookID) != "cook-1" || deref(got.CorrelationID) != "corr-1" || got.AppliedDesiredVersion != 7 {
		t.Fatalf("after reopen: %+v (cook=%s corr=%s)", got, deref(got.CookID), deref(got.CorrelationID))
	}

	// The file is the documented shape.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var onDisk map[string]any
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("state file not JSON: %v", err)
	}
	for _, k := range []string{"cookId", "correlationId", "appliedDesiredVersion", "updatedAt"} {
		if _, ok := onDisk[k]; !ok {
			t.Errorf("state file missing %q: %s", k, raw)
		}
	}

	// Clearing persists nulls.
	if err := s2.ApplyDesired(nil, nil, 8); err != nil {
		t.Fatalf("clear: %v", err)
	}
	s3, err := Open(path)
	if err != nil {
		t.Fatalf("reopen 2: %v", err)
	}
	if got := s3.Snapshot(); got.CookID != nil || got.CorrelationID != nil || got.AppliedDesiredVersion != 8 {
		t.Fatalf("after clear+reopen: %+v", got)
	}
	cook, corr, v := s3.AppliedDesired()
	if cook != nil || corr != nil || v != 8 {
		t.Fatalf("AppliedDesired = %v %v %d", cook, corr, v)
	}
}

// A state file written before HAR-58 has only cookId; it still loads.
func TestOpen_LegacyStateFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cooksession.json")
	if err := os.WriteFile(path, []byte(`{"cookId":"old","updatedAt":"2026-01-01T00:00:00Z"}`), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got := s.Snapshot()
	if deref(got.CookID) != "old" || got.CorrelationID != nil || got.AppliedDesiredVersion != 0 {
		t.Fatalf("legacy load: %+v", got)
	}
}

func TestSnapshot_ReturnsIndependentCopy(t *testing.T) {
	s, _ := newTestStore(t)
	cook, corr := "cook-1", "corr-1"
	if err := s.ApplyDesired(&cook, &corr, 1); err != nil {
		t.Fatalf("ApplyDesired: %v", err)
	}
	// Mutating the caller's input after the call must not affect state.
	cook, corr = "x", "y"

	got := s.Snapshot()
	*got.CookID = "mutated"
	*got.CorrelationID = "mutated"
	again := s.Snapshot()
	if deref(again.CookID) != "cook-1" || deref(again.CorrelationID) != "corr-1" {
		t.Fatalf("internal state leaked: cook=%s corr=%s", deref(again.CookID), deref(again.CorrelationID))
	}
	if deref(s.ActiveCookID()) != "cook-1" {
		t.Fatalf("ActiveCookID = %s", deref(s.ActiveCookID()))
	}
}

// A failed write leaves the previous state in place: an error means nothing
// was applied, so the twin does not report a version it did not persist.
func TestApplyDesired_WriteFailureLeavesStateUnchanged(t *testing.T) {
	s, path := newTestStore(t)
	if err := s.ApplyDesired(strPtr("cook-1"), strPtr("corr-1"), 1); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Replace the directory with nothing so CreateTemp fails.
	if err := os.RemoveAll(filepath.Dir(path)); err != nil {
		t.Fatalf("remove dir: %v", err)
	}
	if err := s.ApplyDesired(strPtr("cook-2"), nil, 2); err == nil {
		t.Fatal("ApplyDesired into a removed dir: want error")
	}
	got := s.Snapshot()
	if deref(got.CookID) != "cook-1" || got.AppliedDesiredVersion != 1 {
		t.Fatalf("state changed despite failed write: %+v", got)
	}
}

func TestNewMemory_DoesNotTouchDisk(t *testing.T) {
	s := NewMemory()
	if s.Path() != "" {
		t.Fatalf("memory store path = %q", s.Path())
	}
	if err := s.ApplyDesired(strPtr("c"), strPtr("r"), 3); err != nil {
		t.Fatalf("ApplyDesired: %v", err)
	}
	if got := s.Snapshot(); deref(got.CookID) != "c" || deref(got.CorrelationID) != "r" || got.AppliedDesiredVersion != 3 {
		t.Fatalf("memory store: %+v", got)
	}
}

// Race coverage: many concurrent readers running alongside a writer must not
// data-race under -race, and every snapshot is internally consistent (both
// ids from the same applied version).
func TestConcurrentReadersAndWriter(t *testing.T) {
	s, _ := newTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				snap := s.Snapshot()
				if snap.CookID == nil {
					continue
				}
				v := strconv.FormatInt(snap.AppliedDesiredVersion, 10)
				if *snap.CookID != "cook-"+v || deref(snap.CorrelationID) != "corr-"+v {
					t.Errorf("torn snapshot: %s / %s / %s", *snap.CookID, deref(snap.CorrelationID), v)
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := int64(1); ctx.Err() == nil; i++ {
			v := strconv.FormatInt(i, 10)
			if err := s.ApplyDesired(strPtr("cook-"+v), strPtr("corr-"+v), i); err != nil {
				t.Errorf("ApplyDesired: %v", err)
				return
			}
		}
	}()
	wg.Wait()
}

func TestOpen_FallsBackWhenDefaultPathUnwritable(t *testing.T) {
	// Point at a path under a regular file (mkdir of a child fails with
	// ENOTDIR), the production failure mode of an unwritable /var/lib.
	dir := t.TempDir()
	occupied := filepath.Join(dir, "occupied")
	if err := os.WriteFile(occupied, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed occupied file: %v", err)
	}
	requested := filepath.Join(occupied, "cooksession.json")

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
	if err := s.ApplyDesired(strPtr("cook-fb"), nil, 1); err != nil {
		t.Fatalf("ApplyDesired on fallback: %v", err)
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
	if err := s.ApplyDesired(strPtr("cook-healed"), nil, 1); err != nil {
		t.Fatalf("ApplyDesired after corrupt: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	if got := s2.ActiveCookID(); got == nil || *got != "cook-healed" {
		t.Fatalf("after heal: want cook-healed, got %v", got)
	}
}

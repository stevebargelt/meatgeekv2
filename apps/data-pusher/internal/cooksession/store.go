// Package cooksession owns the active-cook-id state the data-pusher
// stamps onto every TemperatureReading it ships to IoT Hub.
//
// Authority boundary (architect's decision recorded in BACKLOG.md ticket #5):
// the V2 API is the source of truth for cook lifecycle. This package's
// persisted file is a RESTART CACHE ONLY -- it lets the pusher resume after
// a process crash without waiting for the next SignalR notification, and it
// lets the pusher continue running with a sane cookId while offline. The
// Reconcile call re-syncs against the API at boot and after extended
// disconnects; SignalR cook_started/cook_stopped updates flow in through
// SetActiveCookID at runtime.
//
// The seam between cook_stopped emission on the cloud side and the pusher
// observing it MAY carry a stale cookId for a tick or two. TemperatureReading
// consumers (CosmosDB ingest + the Functions real-time path) treat the cookId
// tag as informational and tolerate the brief disagreement; the alternative
// (blocking telemetry until reconciliation) would lose readings.
package cooksession

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// DefaultStatePath is the production location for the persisted state
// file. The package falls back to a user-home path when this is not
// writable (e.g. `go test` running as a non-root user), so callers
// generally do not need to override it.
const DefaultStatePath = "/var/lib/meatgeek-pusher/cooksession.json"

// fallbackStatePathSegment is appended to the user home directory when
// the configured path is not writable.
const fallbackStatePathSegment = ".meatgeek-pusher/cooksession.json"

// persistedState is the on-disk JSON shape.
type persistedState struct {
	CookID    *string   `json:"cookId"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Store is the in-memory + on-disk cook-session state holder. It is safe
// for concurrent use: many goroutines may call ActiveCookID() while a
// single writer goroutine drives SetActiveCookID / Reconcile.
type Store struct {
	mu       sync.RWMutex
	path     string
	cookID   *string
	updated  time.Time
}

// Open loads (or initializes) the state file at the given path. If path
// is empty, DefaultStatePath is used. If the chosen path is not writable
// (and not creatable), Open falls back to ~/.meatgeek-pusher/cooksession.json
// so tests and unprivileged runs still work.
func Open(path string) (*Store, error) {
	if path == "" {
		path = DefaultStatePath
	}

	resolved, err := resolveWritablePath(path)
	if err != nil {
		return nil, fmt.Errorf("cooksession: resolve state path: %w", err)
	}

	s := &Store{path: resolved}

	data, err := os.ReadFile(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, fmt.Errorf("cooksession: read %s: %w", resolved, err)
	}

	if len(data) == 0 {
		return s, nil
	}

	var ps persistedState
	if err := json.Unmarshal(data, &ps); err != nil {
		// A corrupt state file should not kill the pusher. Log and
		// continue with an empty in-memory state; the next write
		// will overwrite the file.
		logrus.WithError(err).WithField("path", resolved).
			Warn("cooksession: state file corrupt, starting with empty state")
		return s, nil
	}

	s.cookID = ps.CookID
	s.updated = ps.UpdatedAt
	return s, nil
}

// Path returns the file path the store is using. Useful for tests and
// operator logs.
func (s *Store) Path() string {
	return s.path
}

// ActiveCookID returns a copy of the current active cook id, or nil if
// no cook is active. The returned pointer is independent of internal
// state -- callers may retain it without holding any lock.
func (s *Store) ActiveCookID() *string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cookID == nil {
		return nil
	}
	id := *s.cookID
	return &id
}

// SetActiveCookID updates the in-memory and on-disk cook id atomically.
// Passing nil clears the active cook (used on cook_stopped). The on-disk
// write is best-effort durable: tmp-file + rename so a crash mid-write
// leaves the previous good state intact.
func (s *Store) SetActiveCookID(cookID *string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Copy the input so callers cannot mutate our state via the pointer.
	var stored *string
	if cookID != nil {
		v := *cookID
		stored = &v
	}

	s.cookID = stored
	s.updated = time.Now().UTC()

	if err := writeAtomic(s.path, persistedState{CookID: s.cookID, UpdatedAt: s.updated}); err != nil {
		return fmt.Errorf("cooksession: persist state: %w", err)
	}

	if stored == nil {
		logrus.Info("cooksession: cleared active cook id")
	} else {
		logrus.WithField("cookId", *stored).Info("cooksession: set active cook id")
	}
	return nil
}

// setFromReconcile is the internal path used by Reconcile. It compares
// the incoming value to the current in-memory value and only writes when
// they differ, so a steady-state reconcile loop does not churn disk.
// Returns true if a write happened.
func (s *Store) setFromReconcile(cookID *string, source string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if stringPtrEqual(s.cookID, cookID) {
		return false, nil
	}

	prev := stringPtrValue(s.cookID)
	next := stringPtrValue(cookID)

	var stored *string
	if cookID != nil {
		v := *cookID
		stored = &v
	}
	s.cookID = stored
	s.updated = time.Now().UTC()

	if err := writeAtomic(s.path, persistedState{CookID: s.cookID, UpdatedAt: s.updated}); err != nil {
		return false, fmt.Errorf("cooksession: persist state: %w", err)
	}

	logrus.WithFields(logrus.Fields{
		"source":   source,
		"previous": prev,
		"current":  next,
	}).Info("cooksession: reconciled active cook id (override)")

	return true, nil
}

// writeAtomic does a tmp+rename write so a crash mid-write does not leave
// a half-written state file. The directory must exist; resolveWritablePath
// guarantees that during Open.
func writeAtomic(path string, ps persistedState) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".cooksession-*.tmp")
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}
	tmpName := tmp.Name()
	// Ensure the tmp file is gone on any error path.
	defer func() {
		_ = os.Remove(tmpName)
	}()

	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(ps); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// resolveWritablePath ensures the directory for `path` exists and is
// writable; if it cannot create or write the directory (typical when a
// non-root test process targets /var/lib), it falls back to a path under
// the user's home directory.
func resolveWritablePath(path string) (string, error) {
	if dir := filepath.Dir(path); ensureWritableDir(dir) == nil {
		return path, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("user home dir: %w", err)
	}
	fallback := filepath.Join(home, fallbackStatePathSegment)
	if err := ensureWritableDir(filepath.Dir(fallback)); err != nil {
		return "", fmt.Errorf("prepare fallback dir %s: %w", filepath.Dir(fallback), err)
	}
	logrus.WithFields(logrus.Fields{
		"requested": path,
		"fallback":  fallback,
	}).Debug("cooksession: requested state path not writable, falling back")
	return fallback, nil
}

func ensureWritableDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Probe writability with a temp file; some paths exist but are
	// read-only (e.g. mounted volumes).
	probe, err := os.CreateTemp(dir, ".write-probe-*")
	if err != nil {
		return err
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return nil
}

func stringPtrEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func stringPtrValue(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

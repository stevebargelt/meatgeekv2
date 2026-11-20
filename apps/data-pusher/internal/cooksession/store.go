// Package cooksession owns the active-cook state the data-pusher stamps onto
// every TemperatureReading it ships to IoT Hub: the active cook id, the
// correlation id that rides as the `correlation.id` message property, and the
// device twin desired `$version` those two came from.
//
// Authority boundary: the active cook is device state, carried by the IoT Hub
// device twin's desired properties (HAR-55). internal/iothub reads the twin on
// every connect and applies each desired patch through ApplyDesired; this
// package's persisted file is a RESTART CACHE ONLY, so a boot with no network
// still stamps the last cook it was told about.
//
// The seam between the API clearing the cook and the device applying the
// twin patch MAY carry a stale cookId for a tick or two. TemperatureReading
// consumers treat the cookId tag as informational and tolerate the brief
// disagreement; blocking telemetry until the twin is read would lose readings.
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

// persistedState is the on-disk JSON shape. A file written before HAR-58
// carries only cookId and updatedAt; the missing fields load as nil / 0, and
// the twin read on the next connect overwrites all three.
type persistedState struct {
	CookID                *string   `json:"cookId"`
	CorrelationID         *string   `json:"correlationId"`
	AppliedDesiredVersion int64     `json:"appliedDesiredVersion"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

// Session is a consistent snapshot of the store: both ids come from the same
// applied twin desired version.
type Session struct {
	CookID                *string
	CorrelationID         *string
	AppliedDesiredVersion int64
}

// Store is the in-memory + on-disk cook-session state holder. It is safe for
// concurrent use: many goroutines may read while the twin applies updates.
type Store struct {
	mu      sync.RWMutex
	path    string // "" for an in-memory store
	state   Session
	updated time.Time
}

// NewMemory returns a Store that keeps its state in memory only. simdevice
// uses it so its twin mode runs the Pi's twin code without touching disk.
func NewMemory() *Store {
	return &Store{}
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

	s.state = Session{
		CookID:                ps.CookID,
		CorrelationID:         ps.CorrelationID,
		AppliedDesiredVersion: ps.AppliedDesiredVersion,
	}
	s.updated = ps.UpdatedAt
	return s, nil
}

// Path returns the file path the store is using ("" for an in-memory store).
// Useful for tests and operator logs.
func (s *Store) Path() string {
	return s.path
}

// Snapshot returns a copy of the current state. The pointers are independent
// of internal state, so callers may retain them without holding any lock.
func (s *Store) Snapshot() Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Session{
		CookID:                copyPtr(s.state.CookID),
		CorrelationID:         copyPtr(s.state.CorrelationID),
		AppliedDesiredVersion: s.state.AppliedDesiredVersion,
	}
}

// ActiveCookID returns a copy of the current active cook id, or nil if
// no cook is active.
func (s *Store) ActiveCookID() *string {
	return s.Snapshot().CookID
}

// AppliedDesired returns the twin desired properties last applied and their
// `$version`. It and ApplyDesired make *Store an iothub.CookState.
func (s *Store) AppliedDesired() (activeCookID, correlationID *string, version int64) {
	snap := s.Snapshot()
	return snap.CookID, snap.CorrelationID, snap.AppliedDesiredVersion
}

// ApplyDesired replaces the state with the given twin desired values. nil
// clears a field. The on-disk write is tmp-file + rename, so a crash mid-write
// leaves the previous good state intact; the in-memory state changes only
// after the write succeeds, so an error means nothing was applied.
func (s *Store) ApplyDesired(activeCookID, correlationID *string, version int64) error {
	next := Session{
		CookID:                copyPtr(activeCookID),
		CorrelationID:         copyPtr(correlationID),
		AppliedDesiredVersion: version,
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	if s.path != "" {
		if err := writeAtomic(s.path, persistedState{
			CookID:                next.CookID,
			CorrelationID:         next.CorrelationID,
			AppliedDesiredVersion: next.AppliedDesiredVersion,
			UpdatedAt:             now,
		}); err != nil {
			return fmt.Errorf("cooksession: persist state: %w", err)
		}
	}

	prev := s.state
	s.state = next
	s.updated = now

	logrus.WithFields(logrus.Fields{
		"previousCookId":        stringPtrValue(prev.CookID),
		"cookId":                stringPtrValue(next.CookID),
		"correlationId":         stringPtrValue(next.CorrelationID),
		"appliedDesiredVersion": next.AppliedDesiredVersion,
	}).Info("cooksession: applied twin desired properties")
	return nil
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

func copyPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func stringPtrValue(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

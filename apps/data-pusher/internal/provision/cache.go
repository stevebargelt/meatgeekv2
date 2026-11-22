package provision

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/atomicfile"
	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/identity"
)

// AssignmentFile is the cached assignment's name in the identity directory.
const AssignmentFile = "assignment.json"

// AssignmentPath is where the assignment for stateDir is cached.
func AssignmentPath(stateDir string) string {
	return filepath.Join(identity.Dir(stateDir), AssignmentFile)
}

// LoadAssignment reads the cached assignment. ok is false when there is none.
func LoadAssignment(stateDir string) (a Assignment, ok bool, err error) {
	path := AssignmentPath(stateDir)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Assignment{}, false, nil
	}
	if err != nil {
		return Assignment{}, false, fmt.Errorf("provision: read %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return Assignment{}, false, fmt.Errorf("provision: %s is not a valid assignment: %w", path, err)
	}
	if a.AssignedHub == "" || a.DeviceID == "" {
		return Assignment{}, false, fmt.Errorf("provision: %s names no hub or device id", path)
	}
	return a, true, nil
}

// SaveAssignment caches a, atomically.
func SaveAssignment(stateDir string, a Assignment) error {
	raw, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return fmt.Errorf("provision: encode assignment: %w", err)
	}
	if err := os.MkdirAll(identity.Dir(stateDir), 0o700); err != nil {
		return fmt.Errorf("provision: create %s: %w", identity.Dir(stateDir), err)
	}
	if err := atomicfile.Write(AssignmentPath(stateDir), append(raw, '\n'), 0o644); err != nil {
		return fmt.Errorf("provision: save assignment: %w", err)
	}
	return nil
}

// DeleteAssignment removes the cached assignment, if any.
func DeleteAssignment(stateDir string) error {
	if err := os.Remove(AssignmentPath(stateDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("provision: delete assignment: %w", err)
	}
	return nil
}

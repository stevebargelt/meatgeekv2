package claim

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/atomicfile"
)

const (
	// DirName is the claim directory under the state dir.
	DirName = "claim"
	// FileName is the claim file inside DirName.
	FileName = "claim.json"

	dirPerm  os.FileMode = 0o700
	filePerm os.FileMode = 0o600
)

// ErrNoClaim is Load's error when there is no claim file yet.
var ErrNoClaim = errors.New("claim: no claim file yet")

// State is the claim file: the current code, its hash, its expiry and the
// generation it was minted under. Claimed records that the device has seen
// its hash consumed under that generation.
type State struct {
	DeviceID   string    `json:"deviceId"`
	Code       string    `json:"code"`
	CodeHash   string    `json:"codeHash"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Generation int64     `json:"generation"`
	Claimed    bool      `json:"claimed,omitempty"`
}

// Reported is the claim properties to report for s.
func (s State) Reported() Reported {
	return Reported{
		CodeHash:   s.CodeHash,
		ExpiresAt:  s.ExpiresAt.UTC().Format(time.RFC3339),
		Generation: strconv.FormatInt(s.Generation, 10),
	}
}

// Path is the claim file for stateDir.
func Path(stateDir string) string { return filepath.Join(stateDir, DirName, FileName) }

// Load reads the claim file under stateDir. It returns an error matching
// ErrNoClaim when there is none.
func Load(stateDir string) (State, error) {
	path := Path(stateDir)
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, fmt.Errorf("%w (%s)", ErrNoClaim, path)
	}
	if err != nil {
		return State{}, fmt.Errorf("claim: read %s: %w", path, err)
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		// The error would quote the file, and the file holds the code.
		return State{}, fmt.Errorf("claim: %s is not a valid claim file", path)
	}
	if _, ok := Normalize(s.Code); !ok || s.CodeHash == "" || s.ExpiresAt.IsZero() {
		return State{}, fmt.Errorf("claim: %s is not a valid claim file", path)
	}
	return s, nil
}

// Save writes s as the claim file under stateDir, atomically: <stateDir>/claim
// is mode 0700 and the file 0600.
func Save(stateDir string, s State) error {
	dir := filepath.Join(stateDir, DirName)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return fmt.Errorf("claim: create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, dirPerm); err != nil {
		return fmt.Errorf("claim: chmod %s: %w", dir, err)
	}
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("claim: encode the claim file: %w", err)
	}
	return atomicfile.Write(Path(stateDir), append(b, '\n'), filePerm)
}

package claim

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock/clocktest"
)

// vectorFile is shared with the API's tests (apps/api), so the device and the
// API provably hash the same way.
const vectorFile = "../../../../libs/api-interfaces/test-vectors/claim-code.json"

var testStart = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

func TestHashAndNormalize_SharedVectors(t *testing.T) {
	raw, err := os.ReadFile(vectorFile)
	if err != nil {
		t.Fatalf("read the shared vectors: %v", err)
	}
	var file struct {
		Cases []struct {
			Note       string  `json:"note"`
			DeviceID   string  `json:"deviceId"`
			Input      string  `json:"input"`
			Normalized *string `json:"normalized"`
			Hash       *string `json:"hash"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("decode the shared vectors: %v", err)
	}
	if len(file.Cases) < 10 {
		t.Fatalf("only %d vectors; the file is not the one the API tests read", len(file.Cases))
	}
	hashed := 0
	for _, c := range file.Cases {
		got, ok := Normalize(c.Input)
		if c.Normalized == nil {
			if ok {
				t.Errorf("%s: Normalize(%q) = %q, want it refused", c.Note, c.Input, got)
			}
			continue
		}
		if !ok || got != *c.Normalized {
			t.Errorf("%s: Normalize(%q) = %q, %v; want %q", c.Note, c.Input, got, ok, *c.Normalized)
			continue
		}
		if c.Hash == nil {
			t.Errorf("%s: a valid vector has no hash", c.Note)
			continue
		}
		if h := Hash(c.DeviceID, got); h != *c.Hash {
			t.Errorf("%s: Hash(%q, %q) = %s, want %s", c.Note, c.DeviceID, got, h, *c.Hash)
		}
		hashed++
	}
	if hashed == 0 {
		t.Fatal("no vector was hashed")
	}
}

func TestMint_TwelveSymbolsFromTheAlphabet(t *testing.T) {
	// Each byte's low five bits pick the symbol; the high bits are ignored.
	in := []byte{0, 1, 2, 31, 32, 33, 0xff, 0xe0, 10, 18, 26, 30}
	code, err := Mint(bytes.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if want := "012Z01Z0AJTY"; code != want {
		t.Fatalf("Mint = %q, want %q", code, want)
	}
	if len(code) != Length {
		t.Fatalf("len = %d", len(code))
	}
	for _, c := range code {
		if !strings.ContainsRune(Alphabet, c) {
			t.Errorf("symbol %q is not in the alphabet", c)
		}
	}
	if n, ok := Normalize(code); !ok || n != code {
		t.Errorf("a minted code does not normalize to itself: %q, %v", n, ok)
	}
	if Format(code) != "012Z-01Z0-AJTY" {
		t.Errorf("Format = %q", Format(code))
	}

	// Every symbol is reachable.
	all := make([]byte, 0, 36)
	for i := 0; i < 36; i++ {
		all = append(all, byte(i))
	}
	r := bytes.NewReader(all)
	seen := map[rune]bool{}
	for i := 0; i < 3; i++ {
		c, err := Mint(r)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range c {
			seen[s] = true
		}
	}
	if len(seen) != len(Alphabet) {
		t.Errorf("%d distinct symbols, want %d", len(seen), len(Alphabet))
	}

	if _, err := Mint(bytes.NewReader([]byte{1, 2, 3})); err == nil {
		t.Error("a short random source minted a code")
	}
}

func stored(gen int64, hash string, expires time.Time) *State {
	return &State{DeviceID: "d1", Code: "7K3M9QXR2HTV", CodeHash: hash, ExpiresAt: expires, Generation: gen}
}

func TestDecide(t *testing.T) {
	now := testStart
	valid := now.Add(time.Hour)
	expired := now.Add(-time.Second)
	cases := []struct {
		name    string
		stored  *State
		desired Desired
		start   bool
		want    Decision
	}{
		{"fresh start: no stored code", nil, Desired{}, true, Decision{Action: MintNew, Generation: 0}},
		{"fresh start under an existing generation", nil, Desired{Generation: 4}, true, Decision{Action: MintNew, Generation: 4}},
		{"start with a valid stored code: re-report it", stored(0, "h1", valid), Desired{}, true, Decision{Action: Keep}},
		{"start with an expired code: mint", stored(0, "h1", expired), Desired{}, true, Decision{Action: MintNew, Generation: 0}},
		{"start exactly at expiry: mint", stored(0, "h1", now), Desired{}, true, Decision{Action: MintNew, Generation: 0}},
		{"expired while running: keep until a restart", stored(0, "h1", expired), Desired{}, false, Decision{Action: Keep}},
		{"desired generation bump (release): mint under it", stored(0, "h1", valid), Desired{Generation: 1, ConsumedCodeHash: "h1"}, false, Decision{Action: MintNew, Generation: 1}},
		{"release seen at start", stored(2, "h1", valid), Desired{Generation: 3, ConsumedCodeHash: "h1"}, true, Decision{Action: MintNew, Generation: 3}},
		{"desired generation lower (twin re-created): mint under it", stored(3, "h1", valid), Desired{Generation: 0}, false, Decision{Action: MintNew, Generation: 0}},
		{"claimed: nothing", stored(1, "h1", valid), Desired{Generation: 1, ConsumedCodeHash: "h1"}, false, Decision{Action: Keep, Claimed: true}},
		{"claimed at start, even expired: nothing", stored(1, "h1", expired), Desired{Generation: 1, ConsumedCodeHash: "h1"}, true, Decision{Action: Keep, Claimed: true}},
		{"another code consumed: still unclaimed", stored(0, "h1", valid), Desired{ConsumedCodeHash: "h0"}, false, Decision{Action: Keep}},
		{"a patch touching only cook properties: nothing", stored(0, "h1", valid), Desired{}, false, Decision{Action: Keep}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Decide(c.stored, c.desired, now, c.start); got != c.want {
				t.Errorf("Decide = %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestStore_FileIs0600InA0700Dir(t *testing.T) {
	dir := t.TempDir()
	s := State{DeviceID: "d1", Code: "7K3M9QXR2HTV", CodeHash: Hash("d1", "7K3M9QXR2HTV"), ExpiresAt: testStart, Generation: 2}
	if err := Save(dir, s); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, DirName))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("claim dir mode = %o, want 700", fi.Mode().Perm())
	}
	fi, err = os.Stat(Path(dir))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("claim file mode = %o, want 600", fi.Mode().Perm())
	}
	got, err := Load(dir)
	if err != nil || !got.ExpiresAt.Equal(s.ExpiresAt) || got.Code != s.Code || got.CodeHash != s.CodeHash || got.Generation != 2 || got.DeviceID != "d1" {
		t.Fatalf("Load = %+v, %v; want %+v", got, err, s)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, DirName))
	if len(entries) != 1 {
		t.Errorf("claim dir holds %d entries, want only the claim file (no temp files left)", len(entries))
	}
}

func TestStore_LoadMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	if _, err := Load(dir); !errors.Is(err, ErrNoClaim) {
		t.Fatalf("Load of nothing = %v, want ErrNoClaim", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, DirName), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(dir), []byte(`{"code":"7K3M9QXR2HTV",`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(dir)
	if err == nil || errors.Is(err, ErrNoClaim) {
		t.Fatalf("Load of a corrupt file = %v", err)
	}
	if strings.Contains(err.Error(), "7K3M9QXR2HTV") {
		t.Errorf("the error quotes the code: %v", err)
	}
}

// fixedReader returns codes from a fixed sequence of bytes, so tests know
// what each mint yields.
func fixedReader(seed byte) *bytes.Reader {
	b := make([]byte, 0, 10*Length)
	for i := 0; i < 10*Length; i++ {
		b = append(b, seed+byte(i))
	}
	return bytes.NewReader(b)
}

func TestDevice_MintStoresThenReports(t *testing.T) {
	dir := t.TempDir()
	clk := clocktest.New(testStart)
	d := NewDevice(dir, "meatgeek3", clk, fixedReader(0))

	rep, ok, err := d.Sync(Desired{}, true)
	if err != nil || !ok {
		t.Fatalf("Sync = %+v, %v, %v", rep, ok, err)
	}
	s, err := Load(dir)
	if err != nil {
		t.Fatalf("the code is not on disk after Sync returned its hash: %v", err)
	}
	if s.Code != "0123456789AB" || s.CodeHash != Hash("meatgeek3", s.Code) || rep.CodeHash != s.CodeHash {
		t.Fatalf("stored %+v, reported %+v", s, rep)
	}
	if rep.ExpiresAt != "2026-11-23T12:00:00Z" || rep.Generation != "0" {
		t.Errorf("reported = %+v", rep)
	}

	// A restart within the lifetime re-reports the same code.
	clk.Advance(23 * time.Hour)
	again, ok, err := NewDevice(dir, "meatgeek3", clk, fixedReader(100)).Sync(Desired{}, true)
	if err != nil || !ok || again != rep {
		t.Fatalf("restart within the lifetime: %+v, %v, %v; want %+v", again, ok, err, rep)
	}
	// Past it, the running process keeps the expired code...
	clk.Advance(time.Hour)
	if kept, _, _ := d.Sync(Desired{}, false); kept != rep {
		t.Errorf("a running process replaced an expired code: %+v", kept)
	}
	// ...and a restart mints a fresh one.
	fresh, ok, err := NewDevice(dir, "meatgeek3", clk, fixedReader(100)).Sync(Desired{}, true)
	if err != nil || !ok || fresh.CodeHash == rep.CodeHash || fresh.ExpiresAt != "2026-11-24T12:00:00Z" {
		t.Fatalf("restart after expiry: %+v, %v, %v", fresh, ok, err)
	}
}

func TestDevice_ClaimedThenReleased(t *testing.T) {
	dir := t.TempDir()
	clk := clocktest.New(testStart)
	d := NewDevice(dir, "d1", clk, fixedReader(0))
	first, _, err := d.Sync(Desired{}, true)
	if err != nil {
		t.Fatal(err)
	}

	// The API consumed the code: the device records it and reports the same.
	claimed, _, err := d.Sync(Desired{ConsumedCodeHash: first.CodeHash}, false)
	if err != nil || claimed != first {
		t.Fatalf("claimed: %+v, %v", claimed, err)
	}
	if s, _ := Load(dir); !s.Claimed {
		t.Error("the claim file does not record the claim")
	}

	// A release raises the generation: a new code under it, no longer claimed.
	released, _, err := d.Sync(Desired{Generation: 1, ConsumedCodeHash: first.CodeHash}, false)
	if err != nil || released.CodeHash == first.CodeHash || released.Generation != "1" {
		t.Fatalf("released: %+v, %v", released, err)
	}
	if s, _ := Load(dir); s.Claimed || s.Generation != 1 || s.CodeHash != released.CodeHash {
		t.Errorf("claim file after the release = %+v", s)
	}
}

func TestDevice_ClaimFileForAnotherDeviceIsReplaced(t *testing.T) {
	dir := t.TempDir()
	clk := clocktest.New(testStart)
	other, _, _ := NewDevice(dir, "other", clk, fixedReader(0)).Sync(Desired{}, true)
	mine, _, err := NewDevice(dir, "mine", clk, fixedReader(0)).Sync(Desired{}, true)
	if err != nil || mine.CodeHash == other.CodeHash || mine.CodeHash != Hash("mine", "0123456789AB") {
		t.Fatalf("Sync = %+v, %v", mine, err)
	}
}

func TestDevice_MintFailureReportsNothingNew(t *testing.T) {
	dir := t.TempDir()
	clk := clocktest.New(testStart)
	_, ok, err := NewDevice(dir, "d1", clk, bytes.NewReader(nil)).Sync(Desired{}, true)
	if err == nil || ok {
		t.Fatalf("Sync with no randomness = %v, %v; want an error and nothing to report", ok, err)
	}
	first, _, _ := NewDevice(dir, "d1", clk, fixedReader(0)).Sync(Desired{}, true)
	got, ok, err := NewDevice(dir, "d1", clk, bytes.NewReader(nil)).Sync(Desired{Generation: 1}, false)
	if err == nil || !ok || got != first {
		t.Fatalf("a failed release mint = %+v, %v, %v; want the stored code still reported", got, ok, err)
	}
}

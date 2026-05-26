package wire

import (
	"testing"
	"time"
)

func TestMintMessageId_StableForIdenticalInputs(t *testing.T) {
	ts := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)
	a := MintMessageId("meatgeek3", ts, 1)
	b := MintMessageId("meatgeek3", ts, 1)
	if a != b {
		t.Fatalf("MintMessageId must be deterministic, got %q vs %q", a, b)
	}
	if len(a) != 64 {
		t.Fatalf("expected 64-char hex SHA-256, got len %d (%q)", len(a), a)
	}
}

func TestMintMessageId_UniqueAcrossDistinctTriples(t *testing.T) {
	ts := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)
	base := MintMessageId("meatgeek3", ts, 1)

	diffSeq := MintMessageId("meatgeek3", ts, 2)
	if diffSeq == base {
		t.Fatalf("different seq should produce a different id, got %q == %q", diffSeq, base)
	}

	diffDevice := MintMessageId("meatgeek4", ts, 1)
	if diffDevice == base {
		t.Fatalf("different deviceId should produce a different id, got %q == %q", diffDevice, base)
	}

	diffTs := MintMessageId("meatgeek3", ts.Add(time.Second), 1)
	if diffTs == base {
		t.Fatalf("different ts should produce a different id, got %q == %q", diffTs, base)
	}
}

func TestMintMessageId_NormalizesTimezone(t *testing.T) {
	// A ts in a non-UTC zone should produce the same id as the UTC-
	// shifted equivalent — the helper unconditionally takes UnixNano on
	// the .UTC() version, so the encoded timestamp is location-stable.
	utc := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)
	tz, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	chi := utc.In(tz)
	if MintMessageId("meatgeek3", utc, 1) != MintMessageId("meatgeek3", chi, 1) {
		t.Fatalf("MintMessageId should be timezone-invariant for the same instant")
	}
}

func TestMintMessageId_NoForbiddenIoTHubChars(t *testing.T) {
	// IoT Hub message-id field validates against a charset that
	// excludes '+' and '/'. Hex output avoids both by construction —
	// this is an explicit guard against a future refactor to base64.
	id := MintMessageId("meatgeek3", time.Now().UTC(), 1)
	for _, r := range id {
		ok := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')
		if !ok {
			t.Fatalf("MintMessageId returned non-hex char %q in %q", r, id)
		}
	}
}

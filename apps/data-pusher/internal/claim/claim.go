// Package claim is the device side of claiming (goal HAR-130): the device
// mints a claim code, keeps the plaintext on disk, and reports only its hash in
// the twin's reported properties. A person who holds the device reads the code
// locally (`claim-code`) and submits it to POST /devices/claim, which compares
// its hash with the reported one. See
// learnings/decisions/har-130-device-provisioning-and-claim.md.
//
// The hash rules must match apps/api/src/shared/devices/claim-code.ts exactly;
// both sides test against libs/api-interfaces/test-vectors/claim-code.json.
//
// Nothing in this package logs, returns in an error, or puts in a span the
// code. Only the `claim-code` subcommand's stdout carries it.
package claim

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	// Alphabet is Crockford base32: no I, L, O or U.
	Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	// Length is the number of symbols in a code.
	Length = 12
	// Lifetime is how long a code is valid after it is minted, on the
	// device's clock.
	Lifetime = 24 * time.Hour

	hashPrefix = "meatgeek-claim-v1:"
)

// Twin property names. The device writes the reported ones and reads the
// desired ones; claimClaimantHash (desired) is deliberately not named here:
// the device never reads it.
const (
	ReportedCodeHash  = "claimCodeHash"
	ReportedExpiresAt = "claimExpiresAt"
	// Generation is both a reported and a desired property.
	Generation              = "claimGeneration"
	DesiredConsumedCodeHash = "claimConsumedCodeHash"
)

// Normalize returns the 12-symbol code input stands for, or false when it is
// not one: hyphens and ASCII whitespace are removed, ASCII letters are
// upper-cased, O maps to 0 and I and L to 1. Any other character, ASCII or
// not, makes the input invalid.
func Normalize(input string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(input); i++ {
		c := input[i]
		switch {
		case c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r':
			continue
		case c >= 'a' && c <= 'z':
			c -= 'a' - 'A'
		}
		switch c {
		case 'O':
			c = '0'
		case 'I', 'L':
			c = '1'
		}
		if strings.IndexByte(Alphabet, c) < 0 {
			return "", false
		}
		b.WriteByte(c)
	}
	if b.Len() != Length {
		return "", false
	}
	return b.String(), true
}

// Hash is the lowercase hex SHA-256 of `meatgeek-claim-v1:<deviceID>:<code>`,
// code being a normalized code (no hyphens).
func Hash(deviceID, code string) string {
	sum := sha256.Sum256([]byte(hashPrefix + deviceID + ":" + code))
	return hex.EncodeToString(sum[:])
}

// Format shows a normalized code as XXXX-XXXX-XXXX.
func Format(code string) string {
	if len(code) != Length {
		return code
	}
	return code[0:4] + "-" + code[4:8] + "-" + code[8:12]
}

// Mint draws a fresh normalized code from r (crypto/rand.Reader in
// production). Each symbol takes the low five bits of one byte; 256 is a
// multiple of 32, so every symbol is equally likely.
func Mint(r io.Reader) (string, error) {
	buf := make([]byte, Length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", fmt.Errorf("claim: read random bytes: %w", err)
	}
	out := make([]byte, Length)
	for i, b := range buf {
		out[i] = Alphabet[b&31]
	}
	return string(out), nil
}

// Desired is the claim part of the twin's desired section, as the API writes
// it. An absent claimGeneration is 0; an absent claimConsumedCodeHash is "".
type Desired struct {
	Generation       int64
	ConsumedCodeHash string
}

// Reported is the claim part of the reported section, as the device writes it:
// flat strings.
type Reported struct {
	CodeHash   string
	ExpiresAt  string // RFC 3339, UTC
	Generation string // decimal
}

// Action is what Decide tells the device to do.
type Action int

const (
	// Keep: leave the stored code as it is and report it as it is.
	Keep Action = iota
	// MintNew: mint a code under Decision.Generation, store it, then report it.
	MintNew
)

func (a Action) String() string {
	if a == MintNew {
		return "mint"
	}
	return "keep"
}

// Decision is Decide's answer.
type Decision struct {
	Action Action
	// Generation is the generation to mint under (MintNew only).
	Generation int64
	// Claimed is true when the stored code has been consumed under the
	// current generation: the device is claimed (Keep only).
	Claimed bool
}

// Decide is the device's claim rule, a pure function of the stored state (nil
// when there is none), the desired claim properties, the time, and whether
// this is the first sync of the process (start). It is applied on every full
// twin sync and every desired patch.
//
//   - Claimed: the stored hash is desired claimConsumedCodeHash and the
//     generations match. Keep.
//   - Released: desired claimGeneration is not the stored generation (an
//     API release raises it). Mint under the desired generation. A lower
//     desired generation (a twin re-created on the hub) mints too: a code
//     under any other generation than desired can never be claimed.
//   - At start, with no stored code or an expired one: mint under the
//     desired generation. Otherwise keep and re-report, which restores a
//     twin that lost the reported properties.
//
// A code that expires while the process runs is not replaced until the next
// start.
func Decide(stored *State, desired Desired, now time.Time, start bool) Decision {
	if stored == nil {
		return Decision{Action: MintNew, Generation: desired.Generation}
	}
	if stored.CodeHash != "" && stored.CodeHash == desired.ConsumedCodeHash && stored.Generation == desired.Generation {
		return Decision{Action: Keep, Claimed: true}
	}
	if desired.Generation != stored.Generation {
		return Decision{Action: MintNew, Generation: desired.Generation}
	}
	if start && !now.Before(stored.ExpiresAt) {
		return Decision{Action: MintNew, Generation: desired.Generation}
	}
	return Decision{Action: Keep}
}

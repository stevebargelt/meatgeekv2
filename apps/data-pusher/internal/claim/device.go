package claim

import (
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
)

// Device applies the claim rule for one device against its claim file. The
// twin worker calls Sync on every full twin sync and every desired patch, one
// call at a time.
type Device struct {
	stateDir string
	deviceID string
	clock    clock.Clock
	rand     io.Reader
}

// NewDevice returns the claim state of deviceID, stored under stateDir. rand
// is crypto/rand.Reader in production.
func NewDevice(stateDir, deviceID string, clk clock.Clock, rand io.Reader) *Device {
	if clk == nil {
		clk = clock.Real()
	}
	return &Device{stateDir: stateDir, deviceID: deviceID, clock: clk, rand: rand}
}

// Sync applies Decide to the stored state and desired, minting and storing a
// new code when it says so, and returns the claim properties to report. The
// claim file is always written before Sync returns them, so a reported hash
// always has its code on disk. ok is false when there is nothing to report (no
// stored code and minting failed); err says what failed, and when it is set
// with ok true the returned properties are the previous stored ones.
func (d *Device) Sync(desired Desired, start bool) (rep Reported, ok bool, err error) {
	var stored *State
	s, lerr := Load(d.stateDir)
	switch {
	case lerr == nil && s.DeviceID == d.deviceID:
		stored = &s
	case lerr == nil:
		logrus.WithFields(logrus.Fields{"deviceId": d.deviceID, "path": Path(d.stateDir)}).Warn("claim: the claim file is for another device id; minting a new code")
	case errors.Is(lerr, ErrNoClaim):
	default:
		logrus.WithError(lerr).Warn("claim: ignoring the unreadable claim file; minting a new code")
	}

	now := d.clock.Now()
	dec := Decide(stored, desired, now, start)
	if dec.Action == MintNew {
		next, err := d.mint(dec.Generation, now)
		if err != nil {
			if stored != nil {
				return stored.Reported(), true, err
			}
			return Reported{}, false, err
		}
		logrus.WithFields(logrus.Fields{
			"deviceId":        d.deviceID,
			"claimGeneration": next.Generation,
			"claimExpiresAt":  next.Reported().ExpiresAt,
			"start":           start,
		}).Info("claim: minted a new claim code; read it with the claim-code command")
		return next.Reported(), true, nil
	}

	if stored.Claimed != dec.Claimed {
		updated := *stored
		updated.Claimed = dec.Claimed
		if err := Save(d.stateDir, updated); err != nil {
			return stored.Reported(), true, err
		}
		if dec.Claimed {
			logrus.WithFields(logrus.Fields{"deviceId": d.deviceID, "claimGeneration": stored.Generation}).Info("claim: the device has been claimed")
		}
		stored = &updated
	}
	return stored.Reported(), true, nil
}

func (d *Device) mint(generation int64, now time.Time) (State, error) {
	code, err := Mint(d.rand)
	if err != nil {
		return State{}, err
	}
	s := State{
		DeviceID:   d.deviceID,
		Code:       code,
		CodeHash:   Hash(d.deviceID, code),
		ExpiresAt:  now.Add(Lifetime).UTC().Truncate(time.Second),
		Generation: generation,
	}
	if err := Save(d.stateDir, s); err != nil {
		return State{}, fmt.Errorf("claim: store the new code: %w", err)
	}
	return s, nil
}

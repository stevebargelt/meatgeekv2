package wire

import (
	"math"
	"time"
)

// MapV1ToTemperatureReading translates a V1Status (from the local
// device-controller HTTP feed) into a V2 TemperatureReading.
//
// cookId is threaded through as a pointer so the queue runner (the only
// caller that knows the active cook) can pass cooksession.ActiveCookID()
// directly; a nil cookId serializes as `cookId` absent on the wire,
// which is the V2 spec's nullable behavior.
//
// timestamp is taken as an explicit argument rather than time.Now() so
// the caller controls the wall clock for tests and so the MessageId
// (minted from the same ts) stays consistent with the reading.
//
// V1 grill probe quirk: the device-controller emits 0.0 for an unplugged
// grill probe (see formatTemp at apps/device-controller/main.go:246) and
// emits null (via Temps.MarshalJSON) for NaN/Inf. Both shapes mean
// "sensor unplugged" in the V1 contract; we collapse both to *float64(nil)
// here so the V2 reading carries a clean "absent" signal.
//
// The probe1..probe4 fields are NOT collapsed on 0.0 — a probe genuinely
// reading 0°F is a valid sample. They are still collapsed on NaN/null
// (the controller's MarshalJSON path).
func MapV1ToTemperatureReading(v1 V1Status, timestamp time.Time, cookID *string) TemperatureReading {
	return TemperatureReading{
		DeviceID:   v1.SmokerID,
		Timestamp:  timestamp,
		CookID:     cookID,
		GrillTemp:  cleanGrill(v1.Temps.GrillTemp),
		Probe1Temp: cleanProbe(v1.Temps.Probe1Temp),
		Probe2Temp: cleanProbe(v1.Temps.Probe2Temp),
		Probe3Temp: cleanProbe(v1.Temps.Probe3Temp),
		Probe4Temp: cleanProbe(v1.Temps.Probe4Temp),
	}
}

// MapV1ToDeviceStatus translates a V1Status into a V2DeviceStatus.
// systemHealth is populated with conservative defaults (the pusher does
// not currently sample host CPU/memory/disk); the integration step or a
// future ticket can wire real host metrics in.
//
// The grill currentTemp is required by the spec (it is not nullable),
// so unplugged/NaN maps to 0.0 here rather than absent. The probe fields
// remain nullable.
func MapV1ToDeviceStatus(v1 V1Status, timestamp time.Time) V2DeviceStatus {
	return V2DeviceStatus{
		DeviceID:    v1.SmokerID,
		Timestamp:   timestamp,
		AugerOn:     v1.AugerOn,
		BlowerOn:    v1.BlowerOn,
		IgniterOn:   v1.IgniterOn,
		FireHealthy: v1.FireHealthy,
		Mode:        v1.Mode,
		SetPoint:    float64(v1.SetPoint),
		CurrentTemps: V2CurrentTemps{
			Grill:  grillRequired(v1.Temps.GrillTemp),
			Probe1: cleanProbe(v1.Temps.Probe1Temp),
			Probe2: cleanProbe(v1.Temps.Probe2Temp),
			Probe3: cleanProbe(v1.Temps.Probe3Temp),
			Probe4: cleanProbe(v1.Temps.Probe4Temp),
		},
		SystemHealth: V2SystemHealth{
			NetworkStatus: "connected",
		},
	}
}

// cleanGrill collapses NaN/Inf/nil and the V1 unplugged-grill sentinel
// (0.0) into a nil *float64.
func cleanGrill(v *float64) *float64 {
	if v == nil {
		return nil
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	if *v == 0.0 {
		return nil
	}
	out := *v
	return &out
}

// cleanProbe collapses NaN/Inf/nil into a nil *float64 but preserves an
// explicit 0.0 — a probe reading exactly 0°F is valid sensor data.
func cleanProbe(v *float64) *float64 {
	if v == nil {
		return nil
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	out := *v
	return &out
}

// grillRequired returns a numeric grill value for the V2DeviceStatus
// shape, which requires `currentTemps.grill`. NaN/Inf/nil collapse to 0.0
// (the V1 unplugged contract).
func grillRequired(v *float64) float64 {
	if v == nil {
		return 0.0
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return 0.0
	}
	return *v
}

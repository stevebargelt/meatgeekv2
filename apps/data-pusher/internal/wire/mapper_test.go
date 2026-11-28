package wire

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func float64Ptr(v float64) *float64 { return &v }
func stringPtr(v string) *string    { return &v }

func TestMapV1ToTemperatureReading_NaNGrillMapsToNil(t *testing.T) {
	nan := math.NaN()
	ts := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)
	v1 := V1Status{
		SmokerID: "meatgeek3",
		Temps: V1Temps{
			GrillTemp:  &nan,
			Probe1Temp: float64Ptr(225.0),
		},
	}

	got := MapV1ToTemperatureReading(v1, ts, nil)

	if got.GrillTemp != nil {
		t.Fatalf("NaN grill should map to nil, got %v", *got.GrillTemp)
	}
	if got.Probe1Temp == nil || *got.Probe1Temp != 225.0 {
		t.Fatalf("Probe1 with valid reading should round-trip, got %v", got.Probe1Temp)
	}
	if got.DeviceID != "meatgeek3" {
		t.Fatalf("DeviceID should come from V1 SmokerID, got %q", got.DeviceID)
	}
	if !got.Timestamp.Equal(ts) {
		t.Fatalf("Timestamp should match caller-supplied ts, got %v", got.Timestamp)
	}
}

func TestMapV1ToTemperatureReading_ZeroGrillUnpluggedMapsToNil(t *testing.T) {
	v1 := V1Status{
		SmokerID: "meatgeek3",
		Temps: V1Temps{
			GrillTemp: float64Ptr(0.0),
		},
	}
	got := MapV1ToTemperatureReading(v1, fixedTS, nil)
	if got.GrillTemp != nil {
		t.Fatalf("0.0 grill (V1 unplugged sentinel) should map to nil, got %v", *got.GrillTemp)
	}
}

func TestMapV1ToTemperatureReading_ZeroProbePreserved(t *testing.T) {
	// 0°F on a probe is a valid reading (cold meat / ice bath); it must
	// not be collapsed to nil the way grill 0.0 is.
	v1 := V1Status{
		SmokerID: "meatgeek3",
		Temps: V1Temps{
			Probe2Temp: float64Ptr(0.0),
		},
	}
	got := MapV1ToTemperatureReading(v1, fixedTS, nil)
	if got.Probe2Temp == nil || *got.Probe2Temp != 0.0 {
		t.Fatalf("Probe 0.0 should round-trip, got %v", got.Probe2Temp)
	}
}

func TestMapV1ToTemperatureReading_NilTempsAreNil(t *testing.T) {
	// V1Temps with nil fields (the JSON `null` path from the
	// controller's NaN MarshalJSON quirk) should produce nil V2
	// pointers, not zero-valued ones.
	v1 := V1Status{
		SmokerID: "meatgeek3",
		Temps:    V1Temps{},
	}
	got := MapV1ToTemperatureReading(v1, fixedTS, nil)
	if got.GrillTemp != nil || got.Probe1Temp != nil || got.Probe2Temp != nil ||
		got.Probe3Temp != nil || got.Probe4Temp != nil {
		t.Fatalf("nil V1 temps should produce nil V2 pointers, got %+v", got)
	}
}

func TestMapV1ToTemperatureReading_ThreadsCookID(t *testing.T) {
	v1 := V1Status{SmokerID: "meatgeek3"}
	cookID := "cook-abc-123"
	got := MapV1ToTemperatureReading(v1, fixedTS, &cookID)
	if got.CookID == nil || *got.CookID != cookID {
		t.Fatalf("CookID should be threaded through, got %v", got.CookID)
	}

	got2 := MapV1ToTemperatureReading(v1, fixedTS, nil)
	if got2.CookID != nil {
		t.Fatalf("nil cookID should remain nil, got %v", *got2.CookID)
	}
}

func TestMapV1ToDeviceStatus_AllHardwareFlagsCarryThrough(t *testing.T) {
	ts := time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC)
	v1 := V1Status{
		SmokerID:    "meatgeek3",
		AugerOn:     true,
		BlowerOn:    true,
		IgniterOn:   false,
		FireHealthy: true,
		Mode:        "smoke",
		SetPoint:    225,
		Temps: V1Temps{
			GrillTemp:  float64Ptr(220.5),
			Probe1Temp: float64Ptr(150.0),
		},
	}

	got := MapV1ToDeviceStatus(v1, ts)

	if got.AugerOn != true || got.BlowerOn != true || got.IgniterOn != false || got.FireHealthy != true {
		t.Fatalf("hardware booleans should match V1, got %+v", got)
	}
	if got.Mode != "smoke" {
		t.Fatalf("Mode mismatch, got %q", got.Mode)
	}
	if got.SetPoint != 225.0 {
		t.Fatalf("SetPoint should widen int->float64, got %v", got.SetPoint)
	}
	if got.CurrentTemps.Grill != 220.5 {
		t.Fatalf("Grill currentTemp should be a numeric (not pointer), got %v", got.CurrentTemps.Grill)
	}
	if got.CurrentTemps.Probe1 == nil || *got.CurrentTemps.Probe1 != 150.0 {
		t.Fatalf("Probe1 currentTemp should be present, got %v", got.CurrentTemps.Probe1)
	}
	if got.CurrentTemps.Probe2 != nil {
		t.Fatalf("Missing Probe2 should be nil, got %v", *got.CurrentTemps.Probe2)
	}
	if got.SystemHealth.NetworkStatus != "connected" {
		t.Fatalf("SystemHealth default network status should be 'connected', got %q",
			got.SystemHealth.NetworkStatus)
	}
}

func TestMapV1ToDeviceStatus_NaNGrillCollapsesToZero(t *testing.T) {
	// V2DeviceStatus.currentTemps.grill is REQUIRED by the spec
	// (non-nullable), so unplugged/NaN must collapse to 0.0 here,
	// unlike the TemperatureReading mapper which uses nil.
	nan := math.NaN()
	v1 := V1Status{
		SmokerID: "meatgeek3",
		Temps:    V1Temps{GrillTemp: &nan},
	}
	got := MapV1ToDeviceStatus(v1, fixedTS)
	if got.CurrentTemps.Grill != 0.0 {
		t.Fatalf("NaN grill in V2DeviceStatus should collapse to 0.0, got %v", got.CurrentTemps.Grill)
	}
}

func TestTemperatureReading_JSON_OmitsCookIDWhenNil(t *testing.T) {
	r := TemperatureReading{
		DeviceID:  "meatgeek3",
		Timestamp: time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC),
		GrillTemp: float64Ptr(220.5),
	}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	s := string(b)
	if strings.Contains(s, "cookId") {
		t.Fatalf("nil cookId should be omitted from JSON, got %s", s)
	}
	if !strings.Contains(s, `"deviceId":"meatgeek3"`) {
		t.Fatalf("deviceId should be present, got %s", s)
	}
}

func TestTemperatureReading_JSON_IncludesCookIDWhenSet(t *testing.T) {
	cookID := "cook-xyz"
	r := TemperatureReading{
		DeviceID:  "meatgeek3",
		Timestamp: time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC),
		CookID:    &cookID,
	}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(b), `"cookId":"cook-xyz"`) {
		t.Fatalf("non-nil cookId should appear in JSON, got %s", string(b))
	}
}

func TestTemperatureReading_JSON_OmitsNilProbes(t *testing.T) {
	r := TemperatureReading{
		DeviceID:  "meatgeek3",
		Timestamp: time.Date(2026, 5, 26, 10, 0, 0, 0, time.UTC),
		GrillTemp: float64Ptr(220.5),
	}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	s := string(b)
	for _, k := range []string{"probe1Temp", "probe2Temp", "probe3Temp", "probe4Temp"} {
		if strings.Contains(s, k) {
			t.Fatalf("nil %s should be omitted, got %s", k, s)
		}
	}
}

// HAR-151: a grill or probe temperature outside -40..800 °F is "no reading".
// 2409.9 is what an unplugged probe read on the owner's Pi.
func TestMapV1_OutOfRangeIsNoReading(t *testing.T) {
	tests := []struct {
		name    string
		v       float64
		inRange bool
	}{
		{"unplugged probe on the owner's Pi", 2409.9, false},
		{"just above 800", 800.0001, false},
		{"just below -40", -40.0001, false},
		{"far below", -459.67, false},
		{"exactly 800", 800, true},
		{"exactly -40", -40, true},
		{"cook temperature", 225.5, true},
		{"room temperature", 66.2, true},
		{"below zero", -10, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v1 := V1Status{SmokerID: "meatgeek3", Temps: V1Temps{
				GrillTemp:  float64Ptr(tc.v),
				Probe1Temp: float64Ptr(tc.v),
				Probe2Temp: float64Ptr(tc.v),
				Probe3Temp: float64Ptr(tc.v),
				Probe4Temp: float64Ptr(tc.v),
			}}
			r := MapV1ToTemperatureReading(v1, fixedTS, nil)
			s := MapV1ToDeviceStatus(v1, fixedTS)
			fields := OutOfRangeFields(v1.Temps)
			all := map[string]*float64{
				"grill": r.GrillTemp, "probe1": r.Probe1Temp, "probe2": r.Probe2Temp,
				"probe3": r.Probe3Temp, "probe4": r.Probe4Temp,
				"status.probe1": s.CurrentTemps.Probe1, "status.probe4": s.CurrentTemps.Probe4,
			}
			for name, got := range all {
				if tc.inRange && (got == nil || *got != tc.v) {
					t.Errorf("%s = %v, want %v unchanged", name, got, tc.v)
				}
				if !tc.inRange && got != nil {
					t.Errorf("%s = %v, want absent (no reading)", name, *got)
				}
			}
			wantGrill := tc.v
			wantFields := 0
			if !tc.inRange {
				wantGrill = 0
				wantFields = 5
			}
			if s.CurrentTemps.Grill != wantGrill {
				t.Errorf("status grill = %v, want %v", s.CurrentTemps.Grill, wantGrill)
			}
			if len(fields) != wantFields {
				t.Errorf("OutOfRangeFields = %v, want %d fields", fields, wantFields)
			}
		})
	}
}

func TestOutOfRangeFields_NamesOnlyTheOutOfRangeNumbers(t *testing.T) {
	nan := math.NaN()
	got := OutOfRangeFields(V1Temps{
		GrillTemp:  float64Ptr(225),    // in range
		Probe1Temp: &nan,               // the controller's "no reading": not counted
		Probe2Temp: nil,                // null: not counted
		Probe3Temp: float64Ptr(2409.9), // out of range
		Probe4Temp: float64Ptr(-41),    // out of range
	})
	if strings.Join(got, ",") != "probe3,probe4" {
		t.Fatalf("OutOfRangeFields = %v, want [probe3 probe4]", got)
	}
	if got := OutOfRangeFields(V1Temps{GrillTemp: float64Ptr(801)}); strings.Join(got, ",") != "grill" {
		t.Fatalf("OutOfRangeFields = %v, want [grill]", got)
	}
	if got := OutOfRangeFields(V1Temps{}); got != nil {
		t.Fatalf("OutOfRangeFields(empty) = %v, want nil", got)
	}
}

// ADR 0001 (#286): each Reading carries its own Cosmos ttl in seconds. One
// in a Cook expires 7 days after it is written, one outside a Cook after 24h.
func TestMapV1ToTemperatureReading_TTLFollowsTheCook(t *testing.T) {
	v1 := V1Status{SmokerID: "meatgeek3"}
	cookID := "cook-abc-123"

	inCook := MapV1ToTemperatureReading(v1, fixedTS, &cookID)
	if inCook.TTL != 604800 {
		t.Errorf("ttl in a cook = %d, want 604800", inCook.TTL)
	}
	outside := MapV1ToTemperatureReading(v1, fixedTS, nil)
	if outside.TTL != 86400 {
		t.Errorf("ttl outside a cook = %d, want 86400", outside.TTL)
	}
}

func TestTemperatureReading_JSON_CarriesTTL(t *testing.T) {
	b, err := json.Marshal(MapV1ToTemperatureReading(V1Status{SmokerID: "meatgeek3"}, fixedTS, nil))
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(b), `"ttl":86400`) {
		t.Fatalf("ttl should appear in JSON as Cosmos reads it, got %s", b)
	}
}

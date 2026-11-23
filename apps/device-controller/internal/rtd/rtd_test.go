package rtd

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/stevebargelt/meatgeekv2/apps/device-controller/internal/deviceapi"
)

// window returns n copies of r.
func window(n int, r float64) []float64 {
	s := make([]float64, n)
	for i := range s {
		s[i] = r
	}
	return s
}

// floating is a window as an unplugged input fills it on the owner's Pi
// (2026-11-23): 59 zeros and 41 samples near 25 kΩ, averaging about
// 10,323 Ω, the "P3 resAverageQueue 10323.232323" in the controller log.
func floating() []float64 {
	s := window(100, 0)
	for i := 0; i < 41; i++ {
		s[i*2] = 25178.6
	}
	return s
}

func TestBoundsComeFromTheCoefficients(t *testing.T) {
	if math.Abs(MinResistance-842.74) > 0.01 {
		t.Errorf("MinResistance = %.4f, want about 842.74", MinResistance)
	}
	if math.Abs(MaxResistance-2562.41) > 0.01 {
		t.Errorf("MaxResistance = %.4f, want about 2562.41", MaxResistance)
	}
	for _, f := range []float64{MinTempF, 0, 70, 225, MaxTempF} {
		if got := TempF(ResistanceAt(f)); math.Abs(got-f) > 1e-9 {
			t.Errorf("TempF(ResistanceAt(%v)) = %v", f, got)
		}
	}
}

// TestFloatingWindowWasThe2410Reading pins the bug: the old code converted
// the floating window's average, which for P3 (correction -1) is the 2,410 °F
// the cook screen showed.
func TestFloatingWindowWasThe2410Reading(t *testing.T) {
	s := floating()
	sum := 0.0
	for _, v := range s {
		sum += v
	}
	avg := sum / float64(len(s))
	if math.Abs(avg-10323.2) > 0.1 {
		t.Fatalf("floating window average = %.3f, want about 10323.2", avg)
	}
	if old := TempF(avg) - 1; math.Abs(old-2410) > 1 {
		t.Fatalf("old conversion of the average = %.1f, want about 2410", old)
	}
}

func TestEvaluate(t *testing.T) {
	justInsideMin := MinResistance + 0.01
	justOutsideMin := MinResistance - 0.01
	justInsideMax := MaxResistance - 0.01
	justOutsideMax := MaxResistance + 0.01

	oneZero := window(100, 1100)
	oneZero[37] = 0

	oneHuge := window(100, 1100)
	oneHuge[99] = 25178.6

	oneNaN := window(100, 1100)
	oneNaN[0] = math.NaN()

	tests := []struct {
		name       string
		samples    []float64
		correction float64
		wantOK     bool
		wantF      float64 // checked to within 0.1 °F when wantOK
	}{
		// P1 on the owner's Pi: about 1,100 Ω, correction -8.
		{"all valid around 1100 ohm, correction applied", window(100, 1100), -8, true, 70.2},
		{"all valid, no correction", window(100, 1100), 0, true, 78.2},
		{"floating input (zeros and ~25k ohm)", floating(), -1, false, 0},
		{"all zero", window(100, 0), -1, false, 0},
		{"one zero in an otherwise valid window", oneZero, -8, false, 0},
		{"one huge sample in an otherwise valid window", oneHuge, -8, false, 0},
		{"one NaN sample", oneNaN, 0, false, 0},
		{"empty window", nil, 0, false, 0},
		{"just inside the lower bound", window(100, justInsideMin), 0, true, -40},
		{"just outside the lower bound", window(100, justOutsideMin), 0, false, 0},
		{"just inside the upper bound", window(100, justInsideMax), 0, true, 800},
		{"just outside the upper bound", window(100, justOutsideMax), 0, false, 0},
		{"correction pushes below -40 F", window(100, justInsideMin), -8, false, 0},
		{"correction pushes above 800 F", window(100, justInsideMax), 2, false, 0},
		{"correction keeps it inside", window(100, justInsideMin), 2, true, -38},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Evaluate(tc.samples, tc.correction)
			if ok != tc.wantOK {
				t.Fatalf("Evaluate ok = %v (temp %v), want %v", ok, got, tc.wantOK)
			}
			if ok && math.Abs(got-tc.wantF) > 0.1 {
				t.Fatalf("Evaluate = %.3f °F, want about %.1f", got, tc.wantF)
			}
			r := Reading(tc.samples, tc.correction)
			if ok != !math.IsNaN(r) {
				t.Fatalf("Reading = %v, want NaN exactly when Evaluate is not ok", r)
			}
		})
	}
}

// TestValidThenInvalidReportsNull is a probe that reads, then is unplugged:
// the second window is no reading (NaN), served as null and shown as unplg,
// never the previous temperature.
func TestValidThenInvalidReportsNull(t *testing.T) {
	var temps deviceapi.Temps

	temps.Probe3Temp = Reading(window(100, 1100), -1)
	if math.IsNaN(temps.Probe3Temp) {
		t.Fatal("first window: want a reading, got none")
	}
	b, err := json.Marshal(temps)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"probe3Temp":null`) {
		t.Fatalf("first window served as null: %s", b)
	}

	temps.Probe3Temp = Reading(floating(), -1)
	b, err = json.Marshal(temps)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"probe3Temp":null`) {
		t.Fatalf("second window: want probe3Temp null, got %s", b)
	}
	if got := Format("P3", temps.Probe3Temp); got != "P3 unplg" {
		t.Fatalf("second window LCD = %q, want %q", got, "P3 unplg")
	}
}

func TestSamples(t *testing.T) {
	got := Samples([]interface{}{1100.5, 0, float64(0), "x", nil})
	want := []float64{1100.5, 0, 0}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("Samples[%d] = %v, want %v", i, got[i], w)
		}
	}
	for _, i := range []int{3, 4} {
		if !math.IsNaN(got[i]) {
			t.Errorf("Samples[%d] = %v, want NaN for a non-number", i, got[i])
		}
	}
}

func TestFormat(t *testing.T) {
	tests := []struct {
		temp float64
		want string
	}{
		{225.4, "P1 225 F"},
		{0, "P1 0 F"},
		{-12.6, "P1 -13 F"},
		{math.NaN(), "P1 unplg"},
		{math.Inf(1), "P1 unplg"},
	}
	for _, tc := range tests {
		if got := Format("P1", tc.temp); got != tc.want {
			t.Errorf("Format(%v) = %q, want %q", tc.temp, got, tc.want)
		}
	}
}

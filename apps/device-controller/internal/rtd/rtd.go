// Package rtd turns a window of Pt1000 RTD resistance samples into a
// temperature, or into "no reading" when the window is not a plausible
// probe (HAR-151).
//
// An unplugged MCP3008 input floats: the sampling loop records a mix of zeros
// (ADC result <= 0) and huge resistances (tens of kΩ). Averaging that window
// gives a large positive resistance that the Callendar–Van Dusen formula turns
// into thousands of degrees. So a window gives a temperature only when every
// sample in it is non-zero and inside the resistance range of a smoker probe;
// otherwise it gives no reading. A previous value is never kept.
package rtd

import (
	"fmt"
	"math"
)

// Callendar–Van Dusen coefficients for a Pt1000 (IEC 60751). Only A and B are
// used: the controller has always converted with the quadratic form.
const (
	R0 = 1000.0     // resistance at 0 °C, ohms
	A  = 3.90830e-3 // coefficient A
	B  = -5.775e-7  // coefficient B
)

// The valid temperature range of a smoker probe, in Fahrenheit. A reading
// outside it is either an unplugged input or a faulty probe.
const (
	MinTempF = -40.0
	MaxTempF = 800.0
)

// MinResistance and MaxResistance are the resistances at MinTempF and
// MaxTempF, computed from the same coefficients the conversion uses
// (about 842.7 Ω and 2,562.4 Ω).
var (
	MinResistance = ResistanceAt(MinTempF)
	MaxResistance = ResistanceAt(MaxTempF)
)

// ResistanceAt is the Pt1000 resistance at tempF: R0·(1 + A·T + B·T²) with T
// in Celsius. TempF is its inverse.
func ResistanceAt(tempF float64) float64 {
	c := (tempF - 32) * 5 / 9
	return R0 * (1 + A*c + B*c*c)
}

// TempF converts a Pt1000 resistance to Fahrenheit by solving
// R = R0·(1 + A·T + B·T²) for T.
func TempF(resistance float64) float64 {
	c := (-A + math.Sqrt(A*A-4*B*(1-resistance/R0))) / (2 * B)
	return c*9/5 + 32
}

// Evaluate converts one window of resistance samples to a corrected
// temperature in Fahrenheit. ok is false (no reading) when the window is
// empty, when any sample is zero, NaN, or outside MinResistance..MaxResistance,
// or when the corrected temperature falls outside MinTempF..MaxTempF.
// correction is added to a valid reading only.
func Evaluate(samples []float64, correction float64) (tempF float64, ok bool) {
	if len(samples) == 0 {
		return 0, false
	}
	sum := 0.0
	for _, s := range samples {
		// Written so a NaN sample fails the check too.
		if !(s >= MinResistance && s <= MaxResistance) {
			return 0, false
		}
		sum += s
	}
	t := TempF(sum/float64(len(samples))) + correction
	if !(t >= MinTempF && t <= MaxTempF) {
		return 0, false
	}
	return t, true
}

// Reading is Evaluate with "no reading" as NaN, the value the controller
// stores: get_status serves NaN as null and Format shows it as unplugged.
func Reading(samples []float64, correction float64) float64 {
	t, ok := Evaluate(samples, correction)
	if !ok {
		return math.NaN()
	}
	return t
}

// Samples converts the sampling queue's values to float64. The loop pushes
// float64 resistances (and, historically, an int 0 for an unplugged input);
// anything that is not a number becomes NaN, so the window has no reading.
func Samples(values []interface{}) []float64 {
	out := make([]float64, len(values))
	for i, v := range values {
		switch n := v.(type) {
		case float64:
			out[i] = n
		case int:
			out[i] = float64(n)
		default:
			out[i] = math.NaN()
		}
	}
	return out
}

// Format is the LCD and console text for one probe: "P3 225 F", or
// "P3 unplg" when the probe has no reading (NaN). A real reading at or below
// 0 °F is shown as a number.
func Format(title string, tempF float64) string {
	if math.IsNaN(tempF) || math.IsInf(tempF, 0) {
		return fmt.Sprintf("%s unplg", title)
	}
	return fmt.Sprintf("%s %.0f F", title, math.Round(tempF))
}

// Package jsnum reproduces the small subset of JavaScript number formatting
// used by the alert notification path: Number.prototype.toString(10) for the
// template substitutions and Number.prototype.toFixed for the change label.
//
// Go's strconv package already produces the shortest round-trip decimal, but
// it differs from ECMAScript in two places: the thresholds that select
// exponential notation and the exponent spelling. ToFixed needs more than a
// formatting call because ECMAScript rounds the exact binary value, not the
// decimal text the user typed.
package jsnum

import (
	"math"
	"math/big"
	"strconv"
	"strings"
)

// Format reproduces JavaScript's Number.prototype.toString(10) for FINITE
// values: integers print without a fractional part, |v| >= 1e21 or |v| < 1e-6
// print in exponential form the way JS does, everything else prints the
// shortest decimal round-trip.
//
// The ECMAScript fixed/exponential switch is driven by the position of the
// decimal point in the shortest decimal representation (the spec's n): fixed
// notation for -6 < n <= 21 and exponential otherwise. For a magnitude that
// is exactly 1e-6 the position is -5, so it stays fixed; 1e-7 is the first
// exponential value. At the top end 1e21 is exponential while the largest
// double below it is still fixed.
//
// NaN and the infinities never reach this batch's callers, but to stay useful
// for diagnostics they return the same strings JavaScript's String() returns:
// "NaN", "Infinity" and "-Infinity".
//
// Negative zero prints as "0", matching String(-0) === "0".
func Format(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 0) {
		if value < 0 {
			return "-Infinity"
		}
		return "Infinity"
	}
	// Both +0 and -0 take this branch: JS prints "0" for each.
	if value == 0 {
		return "0"
	}
	absolute := math.Abs(value)
	if absolute >= 1e21 || absolute < 1e-6 {
		// Go's 'e' with precision -1 already yields the shortest round-trip
		// mantissa, but it pads the exponent to two digits ("1e-07"). JS has
		// no padding and always signs the exponent ("1e-7", "1e+21").
		return normalizeExponent(strconv.FormatFloat(value, 'e', -1, 64))
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// normalizeExponent rewrites a Go 'e' formatted float into the ECMAScript
// spelling: mantissa + "e" + explicit sign + exponent without leading zeros.
func normalizeExponent(raw string) string {
	index := strings.IndexByte(raw, 'e')
	if index < 0 {
		return raw
	}
	mantissa := raw[:index]
	exponent := raw[index+1:]
	sign := "+"
	switch {
	case strings.HasPrefix(exponent, "+"):
		exponent = exponent[1:]
	case strings.HasPrefix(exponent, "-"):
		sign = "-"
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

// ToFixed reproduces Number.prototype.toFixed(digits) for 0 <= digits <= 100.
//
// This is not strconv.FormatFloat with 'f'. ECMAScript first checks the
// magnitude: a non-finite value or |v| >= 1e21 returns ToString(v) unchanged.
// Otherwise it rounds the exact decimal expansion of the double, so
// (1.005).toFixed(2) is "1.00" (the double is 1.00499999999999989...) and
// (2.55).toFixed(1) is "2.5", while (0.125).toFixed(2) is "0.13" and
// (-0.125).toFixed(2) is "-0.13" because those doubles are exactly halfway.
// Ties round away from zero, which is what V8/JSC do: (0.5).toFixed(0) is
// "1" and (-0.5).toFixed(0) is "-1".
//
// The exact value is taken from math/big.Rat, multiplied by 10^digits, and
// rounded half away from zero on the integer quotient. A tiny negative value
// therefore keeps its sign even when every returned digit is zero:
// (-0.001).toFixed(2) is "-0.00", just like JavaScript; -0 itself is "0.00"
// because the sign test follows the value, not the bit pattern.
//
// JavaScript throws a RangeError when digits is outside 0..100. Those values
// cannot be produced by the alert callers, so this port instead falls back to
// Format(value) rather than panicking or returning an error.
func ToFixed(value float64, digits int) string {
	if digits < 0 || digits > 100 {
		return Format(value)
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) >= 1e21 {
		return Format(value)
	}
	// big.Rat stores the exact binary value; SetFloat64 returns nil only for
	// non-finite input, already handled above.
	exact := new(big.Rat).SetFloat64(value)
	if exact == nil {
		return Format(value)
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	scaled := new(big.Int).Mul(exact.Num(), scale)
	negative := scaled.Sign() < 0
	scaled.Abs(scaled)
	rounded, remainder := new(big.Int), new(big.Int)
	rounded.QuoRem(scaled, exact.Denom(), remainder)
	// Round half away from zero: twice the remainder >= denominator.
	if new(big.Int).Lsh(remainder, 1).Cmp(exact.Denom()) >= 0 {
		rounded.Add(rounded, big.NewInt(1))
	}
	return formatFixed(rounded, digits, negative)
}

// formatFixed renders the non-negative rounded integer scaled by 10^digits
// with exactly digits fractional characters.
func formatFixed(rounded *big.Int, digits int, negative bool) string {
	text := rounded.String()
	if digits > 0 {
		if len(text) <= digits {
			text = strings.Repeat("0", digits+1-len(text)) + text
		}
		split := len(text) - digits
		text = text[:split] + "." + text[split:]
	}
	if negative {
		return "-" + text
	}
	return text
}

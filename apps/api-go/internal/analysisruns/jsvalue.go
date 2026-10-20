package analysisruns

// This file reproduces the JavaScript string/number semantics the analysis
// prompts and detector reasons depend on: Number::toString, Number#toFixed and
// UTF-16 string length. It contains no business state.

import (
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf16"
)

// jsNumberString is ECMAScript Number::toString for a finite float64. The
// prompt templates interpolate user-supplied values with JavaScript's String(),
// so a Go 'g' format is not equivalent for small or large magnitudes.
func jsNumberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	if value == 0 {
		return "0"
	}
	negative := math.Signbit(value)
	absolute := math.Abs(value)
	scientific := strconv.FormatFloat(absolute, 'e', -1, 64)
	parts := strings.SplitN(scientific, "e", 2)
	if len(parts) != 2 {
		return scientific
	}
	mantissa := parts[0]
	exponent, err := strconv.Atoi(parts[1])
	if err != nil {
		return scientific
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits)
	n := exponent + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		out = digits[:1]
		if k > 1 {
			out += "." + digits[1:]
		}
		e := n - 1
		sign := "+"
		if e < 0 {
			sign = "-"
			e = -e
		}
		out += "e" + sign + strconv.Itoa(e)
	}
	if negative {
		return "-" + out
	}
	return out
}

// jsToFixed mirrors Number.prototype.toFixed for a finite value and a small
// non-negative digit count. It rounds the exact binary value half away from
// zero, which is what V8 does for the ties that Go's strconv would round to
// even.
func jsToFixed(value float64, digits int) string {
	if digits < 0 {
		digits = 0
	}
	rational := new(big.Rat).SetFloat64(value)
	if rational == nil {
		return jsNumberString(value)
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	rational.Mul(rational, new(big.Rat).SetInt(scale))
	numerator := rational.Num()
	denominator := rational.Denom()
	quotient, remainder := new(big.Int).QuoRem(numerator, denominator, new(big.Int))
	if remainder.Sign() != 0 {
		absRemainder := new(big.Int).Abs(remainder)
		absRemainder.Mul(absRemainder, big.NewInt(2))
		if absRemainder.Cmp(denominator) >= 0 {
			one := big.NewInt(1)
			if numerator.Sign() < 0 {
				quotient.Sub(quotient, one)
			} else {
				quotient.Add(quotient, one)
			}
		}
	}
	negative := quotient.Sign() < 0
	absolute := new(big.Int).Abs(quotient).String()
	if digits == 0 {
		if negative {
			return "-" + absolute
		}
		return absolute
	}
	for len(absolute) <= digits {
		absolute = "0" + absolute
	}
	integerPart := absolute[:len(absolute)-digits]
	fractionPart := absolute[len(absolute)-digits:]
	if negative {
		return "-" + integerPart + "." + fractionPart
	}
	return integerPart + "." + fractionPart
}

// utf16Len is JavaScript String#length: UTF-16 code units, not bytes and not
// runes. The flush thresholds use this length.
func utf16Len(value string) int {
	units := 0
	for _, r := range value {
		if r > 0xFFFF {
			units += 2
			continue
		}
		units++
	}
	return units
}

// utf16Truncate returns the first limit UTF-16 code units. It is only used by
// tests that assert the length helper; business truncation is not performed by
// this chain.
func utf16Truncate(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if limit >= len(units) {
		return value
	}
	if limit < 0 {
		limit = 0
	}
	return string(utf16.Decode(units[:limit]))
}

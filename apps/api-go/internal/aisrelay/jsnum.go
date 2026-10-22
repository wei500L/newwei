package aisrelay

import (
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/jsnum"
)

// This file holds the JavaScript primitives the AIS relay contract depends on.
//
// The Node relay builds its responses with JSON.stringify, which renders numbers
// through Number::toString and trims strings through String.prototype.trim. Go's
// standard helpers disagree with both at the edges (Go switches to exponent form
// at 1e6, JS only at 1e21; Go considers U+0085 whitespace, JS does not), so every
// helper below documents the exact JS rule it reproduces and is unit tested.
//
// The relay is contract-equivalent with the Node version, not merely
// behaviour-similar: snapshot bytes must match so that consumers and cached
// payloads stay interchangeable while both versions run side by side.

// jsNumber is a float64 that serialises exactly like JSON.stringify renders a JS
// number. Business payload structs use it for every non-integral numeric field;
// integral counters stay int because JSON renders those identically.
type jsNumber float64

// MarshalJSON writes the shorter of the two JS numeric forms so that the wire
// bytes match the Node relay.
func (n jsNumber) MarshalJSON() ([]byte, error) {
	return []byte(jsNumberString(float64(n))), nil
}

// jsNumberString reproduces String(number) for finite values, which is the algorithm
// JSON.stringify applies to every JS number: plain decimal notation for magnitudes in
// [1e-6, 1e21), scientific notation outside it, no trailing fractional zeros, and "0"
// for either zero.
//
// The implementation is shared with the alert notification path, whose labels need the
// same ECMAScript formatting; Go's strconv 'g' verb cannot be used because with the
// shortest round-trip precision it starts using exponents at 1e6, which would rewrite a
// coordinate such as 1234567 as "1.234567e+06".
func jsNumberString(value float64) string {
	return jsnum.Format(value)
}

// jsRound reproduces Math.round: the closest integer with an exact tie rounded
// toward +Infinity. math.Round rounds half away from zero, which differs for
// every negative half (Math.round(-1.5) === -1 but math.Round(-1.5) == -2).
func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value == 0 {
		return value
	}
	floor := math.Floor(value)
	if value-floor < 0.5 {
		return floor
	}
	return floor + 1
}

// jsRoundToInt is Math.round narrowed to an int. The relay only rounds bounded
// percentage values, so the conversion cannot overflow.
func jsRoundToInt(value float64) int {
	rounded := jsRound(value)
	if rounded == 0 {
		// Normalises -0, which would otherwise print as "-0" through strconv.
		return 0
	}
	return int(rounded)
}

// jsTrunc reproduces Math.trunc (toward zero for negatives).
func jsTrunc(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	return math.Trunc(value)
}

// isJSWhitespace reports whether a rune is trimmed by String.prototype.trim, i.e.
// ECMAScript WhiteSpace plus LineTerminator. Note that U+0085 (NEL) is *not* JS
// whitespace even though unicode.IsSpace accepts it, hence the explicit switch.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff', '\u2028', '\u2029':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// jsTrim reproduces String.prototype.trim.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

// parseJSNumber reproduces Number(string) for the inputs a relay payload can
// carry, returning ok=false where JS would produce NaN or ±Infinity (both of
// which the relay treats as "absent" through Number.isFinite).
//
// Recognised forms mirror StringNumericLiteral: optional surrounding JS
// whitespace, an optional sign, decimal and exponent notation, and the 0x/0b/0o
// integer prefixes. A Go-only form such as the hex float "0x1p-2" is rejected
// explicitly because JS yields NaN for it.
func parseJSNumber(value string) (float64, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		// Number("") and Number("   ") are both 0. Callers that must treat an
		// empty string as absent check it before calling.
		return 0, true
	}
	switch trimmed {
	case "Infinity", "+Infinity", "-Infinity", "NaN":
		return 0, false
	}
	if len(trimmed) > 2 && trimmed[0] == '0' {
		switch trimmed[1] {
		case 'x', 'X':
			parsed, err := strconv.ParseUint(trimmed[2:], 16, 64)
			if err != nil {
				return 0, false
			}
			return float64(parsed), true
		case 'b', 'B':
			parsed, err := strconv.ParseUint(trimmed[2:], 2, 64)
			if err != nil {
				return 0, false
			}
			return float64(parsed), true
		case 'o', 'O':
			parsed, err := strconv.ParseUint(trimmed[2:], 8, 64)
			if err != nil {
				return 0, false
			}
			return float64(parsed), true
		}
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// jsToUpper reproduces String.prototype.toUpperCase closely enough for the relay
// rule that uses it: the candidate classifier upper-cases a vessel name, and both
// regular expressions are ASCII-only, so a rune only matters when its JS uppercase
// form contains ASCII letters.
//
// strings.ToUpper maps one rune to one rune, while JS full-mapping expands a few
// German/Latin ligatures into two characters. Those expansions are the only place
// where a non-ASCII input can start matching an ASCII pattern ("ß" becomes "SS"),
// so they are applied explicitly; every other rune either maps identically or
// yields a non-ASCII letter that matches neither pattern.
func jsToUpper(value string) string {
	needsExpansion := false
	for _, r := range value {
		if _, ok := jsUpperExpansions[r]; ok {
			needsExpansion = true
			break
		}
	}
	if !needsExpansion {
		return strings.ToUpper(value)
	}

	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		if expansion, ok := jsUpperExpansions[r]; ok {
			builder.WriteString(expansion)
			continue
		}
		builder.WriteString(strings.ToUpper(string(r)))
	}
	return builder.String()
}

// jsUpperExpansions lists the runes whose JavaScript uppercase mapping is longer
// than the original rune and contains ASCII letters, which is the subset that can
// change a match against the ASCII-only candidate patterns.
var jsUpperExpansions = map[rune]string{
	'\u00df': "SS",      // ß LATIN SMALL LETTER SHARP S
	'\u0149': "\u02bcN", // ŉ LATIN SMALL LETTER N PRECEDED BY APOSTROPHE
	'\u01f0': "J\u030c", // ǰ LATIN SMALL LETTER J WITH CARON
	'\ufb00': "FF",      // ﬀ LATIN SMALL LIGATURE FF
	'\ufb01': "FI",      // ﬁ LATIN SMALL LIGATURE FI
	'\ufb02': "FL",      // ﬂ LATIN SMALL LIGATURE FL
	'\ufb03': "FFI",     // ﬃ LATIN SMALL LIGATURE FFI
	'\ufb04': "FFL",     // ﬄ LATIN SMALL LIGATURE FFL
	'\ufb05': "ST",      // ﬅ LATIN SMALL LIGATURE LONG S T
	'\ufb06': "ST",      // ﬆ LATIN SMALL LIGATURE ST
}

// isoMillis reproduces new Date(milliseconds).toISOString(): always UTC, always
// exactly three fractional digits and a trailing Z.
func isoMillis(milliseconds int64) string {
	return time.UnixMilli(milliseconds).UTC().Format("2006-01-02T15:04:05.000Z")
}

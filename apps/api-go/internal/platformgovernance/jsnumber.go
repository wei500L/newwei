package platformgovernance

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// jsNumberish decodes a JSON value with JavaScript's Number() coercion.
//
// The zero value is absent (NaN), which is what an omitted field produces: Go
// leaves the field untouched, and NestJS applies its fallback for undefined.
//
// Number() accepts numeric strings, the Infinity literal, hex/octal/binary
// integer literals, booleans, null and single-element arrays. It rejects "inf",
// "nan", hexadecimal floats and digit separators, so this file validates with
// the ECMAScript grammar instead of leaning on strconv.
type jsNumberish struct {
	value   float64
	present bool
}

// UnmarshalJSON implements the Number() coercion for the JSON token.
func (n *jsNumberish) UnmarshalJSON(data []byte) error {
	n.present = true
	n.value = jsNumberFromJSON(data)
	return nil
}

// Number returns the coerced value; an absent field is NaN.
func (n jsNumberish) Number() float64 {
	if !n.present {
		return math.NaN()
	}
	return n.value
}

// jsDecimalPattern is the ECMAScript StrDecimalLiteral grammar without the
// Infinity alternative, which is matched separately and case-insensitively.
var jsDecimalPattern = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsNumberFromJSON mirrors Number(value) for a decoded JSON value.
func jsNumberFromJSON(raw json.RawMessage) float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return math.NaN()
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return math.NaN()
		}
		return jsStringToNumber(text)
	case 't':
		return 1
	case 'f':
		return 0
	case 'n':
		return 0
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return math.NaN()
		}
		switch len(items) {
		case 0:
			// Number([]) === Number("") === 0.
			return 0
		case 1:
			// Number([x]) === Number(String(x)).
			return jsStringToNumber(jsValueToString(items[0]))
		default:
			// Number(["1","2"]) === Number("1,2") === NaN.
			return math.NaN()
		}
	case '{':
		// Number({}) === Number("[object Object]") === NaN.
		return math.NaN()
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				// Number("1e999") is Infinity, not an error.
				return value
			}
			return math.NaN()
		}
		return value
	}
}

// jsValueToString mirrors String(value) for the single-element array case.
//
// Numbers round-trip exactly through their own value, so they are returned
// numerically rather than formatted (Number(String(n)) === n for every finite
// double). Arrays join their elements with "," using the same null/undefined
// rule, and objects stringify to "[object Object]".
func jsValueToString(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return ""
		}
		return text
	case 't':
		return "true"
	case 'f':
		return "false"
	case 'n':
		return "null"
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return ""
		}
		parts := make([]string, 0, len(items))
		for _, item := range items {
			entry := bytes.TrimSpace(item)
			if len(entry) == 0 || bytes.Equal(entry, []byte("null")) {
				// Array.prototype.toString renders null and undefined as "".
				parts = append(parts, "")
				continue
			}
			parts = append(parts, jsValueToString(entry))
		}
		return strings.Join(parts, ",")
	case '{':
		return "[object Object]"
	default:
		return string(trimmed)
	}
}

// jsStringToNumber mirrors JavaScript's Number(string) coercion.
//
// It is deliberately grammar-driven: Number("inf"), Number("nan"),
// Number("0x1p3") and Number("1_000") are all NaN, while "0x10", "0o17" and
// "0b101" are integers and "Infinity" is a special value.
func jsStringToNumber(text string) float64 {
	trimmed := jsTrimSpace(text)
	if trimmed == "" {
		return 0
	}
	switch strings.ToLower(trimmed) {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	if len(trimmed) > 2 && trimmed[0] == '0' {
		switch trimmed[1] {
		case 'x', 'X':
			return jsRadixToNumber(trimmed[2:], 16)
		case 'o', 'O':
			return jsRadixToNumber(trimmed[2:], 8)
		case 'b', 'B':
			return jsRadixToNumber(trimmed[2:], 2)
		}
	}
	if !jsDecimalPattern.MatchString(trimmed) {
		return math.NaN()
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			return value
		}
		return math.NaN()
	}
	return value
}

// jsRadixToNumber mirrors Number() for the 0x/0o/0b integer literal forms. A
// literal beyond uint64 saturates to the nearest finite double, which is what
// Number() returns (never Infinity).
func jsRadixToNumber(digits string, base int) float64 {
	if digits == "" {
		return math.NaN()
	}
	for _, r := range digits {
		if jsDigitValue(r) >= base {
			return math.NaN()
		}
	}
	value, err := strconv.ParseUint(digits, base, 64)
	if err != nil {
		return float64(^uint64(0))
	}
	return float64(value)
}

// jsDigitValue returns the digit value of one ASCII character, or 16 for a
// character that is not a digit in a supported base.
func jsDigitValue(r rune) int {
	switch {
	case r >= '0' && r <= '9':
		return int(r - '0')
	case r >= 'a' && r <= 'f':
		return int(r-'a') + 10
	case r >= 'A' && r <= 'F':
		return int(r-'A') + 10
	default:
		return 16
	}
}

// jsTrimSpace mirrors JavaScript's String.prototype.trim, which also strips the
// U+FEFF byte order mark that unicode.IsSpace does not classify as space.
func jsTrimSpace(raw string) string {
	return strings.TrimFunc(raw, func(r rune) bool {
		return r == '\uFEFF' || strings.ContainsRune(" \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000", r)
	})
}

// jsIsInteger mirrors Number.isInteger: finite values with no fractional part.
func jsIsInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// jsToFixed4 mirrors Number(value.toFixed(4)).
//
// ECMAScript picks the integer n for which n/10^4 - x is closest to zero, and
// on an exact tie picks the LARGER n. The computation is done on the exact
// binary value with big.Rat so a genuine tie such as 0.03125 becomes 0.0313;
// strconv.FormatFloat would round half to even and produce the wrong digit.
func jsToFixed4(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	exact := new(big.Rat).SetFloat64(value)
	if exact == nil {
		return value
	}
	exact.Mul(exact, big.NewRat(10000, 1))
	// floor(x + 1/2) rounds half up, i.e. ties pick the larger integer.
	exact.Add(exact, big.NewRat(1, 2))
	scaled := new(big.Int).Div(exact.Num(), exact.Denom())
	result, _ := new(big.Rat).SetFrac(scaled, big.NewInt(10000)).Float64()
	return result
}

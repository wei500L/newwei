package crawlfrontierruns

import (
	"bytes"
	"encoding/json"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
)

// jsNumberish decodes an arbitrary JSON value and records the result of
// JavaScript's Number() coercion.
//
// NestJS feeds schema-less metadata values through Number() in toFiniteNumber
// and toNumericRecord. That conversion is not strconv.ParseFloat: it accepts
// "Infinity", "0x10"/"0o7"/"0b11", booleans and null, treats an empty string
// and an empty array as 0, unwraps a single-element array, and rejects
// "inf", "nan", hex floats, underscores and objects. This type reproduces those
// rules so numeric metadatamaps stay byte-identical.
type jsNumberish struct {
	// Value is the coerced number when OK is true.
	Value float64
	// OK is true when Number(value) is a finite number.
	OK bool
}

// UnmarshalJSON implements json.Unmarshaler without failing on non-numeric
// values: a non-finite result simply leaves OK false.
func (n *jsNumberish) UnmarshalJSON(data []byte) error {
	value, ok := jsNumberFromJSON(data)
	n.Value = value
	n.OK = ok
	return nil
}

// jsNumberFromJSON applies Number() to a decoded JSON value. Non-finite
// results (NaN and +/-Infinity) are reported as not OK because every caller
// keeps finite numbers only.
func jsNumberFromJSON(raw []byte) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if json.Unmarshal(trimmed, &text) != nil {
			return 0, false
		}
		return jsNumberString(text)
	case 't':
		if string(trimmed) == "true" {
			return 1, true
		}
		return 0, false
	case 'f':
		if string(trimmed) == "false" {
			return 0, true
		}
		return 0, false
	case 'n':
		if string(trimmed) == "null" {
			return 0, true
		}
		return 0, false
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return 0, false
		}
		// Array.prototype.toString semantics: [] -> 0, [x] -> Number(String(x)),
		// two or more elements -> NaN.
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			// Array.prototype.toString renders a null element as the empty
			// string, so [null] coerces to 0.
			if string(bytes.TrimSpace(items[0])) == "null" {
				return 0, true
			}
			text, ok := jsStringOfJSON(items[0])
			if !ok {
				return 0, false
			}
			return jsNumberString(text)
		default:
			return 0, false
		}
	case '{':
		// Plain objects coerce to NaN.
		return 0, false
	default:
		var number float64
		if json.Unmarshal(trimmed, &number) != nil {
			return 0, false
		}
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	}
}

// jsStringOfJSON implements JavaScript String(value) for JSON values.
func jsStringOfJSON(raw []byte) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if json.Unmarshal(trimmed, &text) != nil {
			return "", false
		}
		return text, true
	case 't':
		return "true", string(trimmed) == "true"
	case 'f':
		return "false", string(trimmed) == "false"
	case 'n':
		return "null", string(trimmed) == "null"
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return "", false
		}
		parts := make([]string, len(items))
		for index, item := range items {
			// Array.prototype.join renders null/undefined as the empty string.
			if string(bytes.TrimSpace(item)) == "null" {
				parts[index] = ""
				continue
			}
			text, ok := jsStringOfJSON(item)
			if !ok {
				return "", false
			}
			parts[index] = text
		}
		return strings.Join(parts, ","), true
	case '{':
		return "[object Object]", true
	default:
		var number float64
		if json.Unmarshal(trimmed, &number) != nil {
			return "", false
		}
		return jsNumberToString(number), true
	}
}

// jsNumberString implements Number(string) for a JavaScript string value.
func jsNumberString(text string) (float64, bool) {
	trimmed := jsTrim(text)
	if trimmed == "" {
		return 0, true
	}
	// Infinity is a valid Number() result but never a finite value.
	if trimmed == "Infinity" || trimmed == "+Infinity" || trimmed == "-Infinity" {
		return 0, false
	}
	if len(trimmed) >= 2 && trimmed[0] == '0' {
		switch trimmed[1] {
		case 'x', 'X':
			return parseRadixNumber(trimmed[2:], 16)
		case 'o', 'O':
			return parseRadixNumber(trimmed[2:], 8)
		case 'b', 'B':
			return parseRadixNumber(trimmed[2:], 2)
		}
	}
	if !validDecimalLiteral(trimmed) {
		return 0, false
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// parseRadixNumber parses the digits of a 0x/0o/0b literal. A signed literal
// is not accepted because JavaScript rejects +0x10 and -0x10.
func parseRadixNumber(digits string, base int) (float64, bool) {
	if digits == "" {
		return 0, false
	}
	for _, r := range digits {
		if digitValue(r) < 0 || digitValue(r) >= base {
			return 0, false
		}
	}
	number, ok := new(big.Int).SetString(digits, base)
	if !ok {
		return 0, false
	}
	value, _ := new(big.Float).SetInt(number).Float64()
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return 0, false
	}
	return value, true
}

// digitValue returns the radix value of an ASCII digit.
func digitValue(r rune) int {
	switch {
	case r >= '0' && r <= '9':
		return int(r - '0')
	case r >= 'a' && r <= 'f':
		return int(r-'a') + 10
	case r >= 'A' && r <= 'F':
		return int(r-'A') + 10
	}
	return -1
}

// validDecimalLiteral accepts the decimal forms JavaScript Number() accepts:
// an optional sign, digits with an optional fractional part, and an optional
// exponent. It rejects underscores, hex floats, "inf"/"nan" and lone signs.
func validDecimalLiteral(text string) bool {
	index := 0
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		index++
	}
	digits := 0
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
		digits++
	}
	if index < len(text) && text[index] == '.' {
		index++
		for index < len(text) && text[index] >= '0' && text[index] <= '9' {
			index++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if index < len(text) && (text[index] == 'e' || text[index] == 'E') {
		index++
		if index < len(text) && (text[index] == '+' || text[index] == '-') {
			index++
		}
		exponentDigits := 0
		for index < len(text) && text[index] >= '0' && text[index] <= '9' {
			index++
			exponentDigits++
		}
		if exponentDigits == 0 {
			return false
		}
	}
	return index == len(text)
}

// jsTrim removes the ECMAScript WhiteSpace and LineTerminator set.
func jsTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff', '\u2028', '\u2029':
			return true
		}
		return unicode.Is(unicode.Zs, r)
	})
}

// jsNumberToString is the JavaScript Number::toString form used inside trace
// detail strings ("2 pending", "3 judged").
func jsNumberToString(value float64) string {
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
	abs := math.Abs(value)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	marker := strings.IndexByte(formatted, 'e')
	if marker < 0 {
		return formatted
	}
	mantissa := formatted[:marker]
	exponent := formatted[marker+1:]
	sign := ""
	if strings.HasPrefix(exponent, "+") || strings.HasPrefix(exponent, "-") {
		sign = exponent[:1]
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

// finiteNumber converts a jsNumberish to a JSON-ready number, returning nil for
// non-finite values (which serialize as JSON null).
func finiteNumber(value jsNumberish) *float64 {
	if !value.OK || math.IsNaN(value.Value) || math.IsInf(value.Value, 0) {
		return nil
	}
	out := value.Value
	return &out
}

// jsMathRound implements Math.round for the non-negative values used by the
// pending judge job counter.
func jsMathRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	return math.Floor(value + 0.5)
}

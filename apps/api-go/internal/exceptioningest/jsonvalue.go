package exceptioningest

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// looseTimeLayouts covers the ISO-8601 shapes JavaScript new Date(string)
// accepts for report timestamps; a missing timezone is interpreted as UTC.
var looseTimeLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02",
	"2006-01",
	"2006",
}

// jsonKind reports the JSON kind of a raw leaf without decoding it. The zero
// length value (field absent) reports "invalid" so callers can treat absence
// like a non-matching type.
func jsonKind(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "invalid"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "bool"
	case 'n':
		return "null"
	default:
		return "number"
	}
}

// jsonString decodes a raw leaf that is a JSON string. Every other kind
// (including absence and null) reports false, which the normalizers treat like
// the Nest typeof value !== "string" branch.
func jsonString(raw json.RawMessage) (string, bool) {
	if jsonKind(raw) != "string" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsNumberFromJSON mirrors JavaScript Number(value) for a JSON leaf:
//
//	number   -> itself
//	string   -> Number(string) (JS numeric string grammar)
//	bool     -> 1 / 0
//	null     -> 0
//	missing  -> NaN (Number(undefined))
//	object   -> NaN
//	array    -> 0 for [] and [n]..., NaN otherwise (close enough: the value only
//	            matters when it lands in [100, 599] after Math.floor)
func jsNumberFromJSON(raw json.RawMessage) float64 {
	switch jsonKind(raw) {
	case "null":
		return 0
	case "number":
		var parsed float64
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return math.NaN()
		}
		return parsed
	case "string":
		text, _ := jsonString(raw)
		parsed, ok := jsNumber(text)
		if !ok {
			return math.NaN()
		}
		return parsed
	case "bool":
		if strings.TrimSpace(string(raw)) == "true" {
			return 1
		}
		return 0
	default:
		return math.NaN()
	}
}

// jsNumber mirrors the JavaScript Number(string) coercion used by the Nest
// normalizers: leading/trailing whitespace is allowed, decimal and scientific
// notation are allowed, 0x/0b/0o prefixes and Infinity/NaN are recognized, and
// a numeric separator makes the whole conversion NaN.
func jsNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	if strings.ContainsRune(trimmed, '_') {
		return 0, false
	}
	lower := strings.ToLower(trimmed)
	unsigned := strings.TrimLeft(trimmed, "+-")
	if len(lower) >= 2 && lower[0] == '0' {
		base := 0
		switch lower[1] {
		case 'x':
			base = 16
		case 'b':
			base = 2
		case 'o':
			base = 8
		}
		if base != 0 {
			digits := unsigned[2:]
			if digits == "" {
				return 0, false
			}
			parsed, err := strconv.ParseInt(digits, base, 64)
			if err != nil {
				return 0, false
			}
			if strings.HasPrefix(trimmed, "-") {
				return -float64(parsed), true
			}
			return float64(parsed), true
		}
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	case "NaN":
		return math.NaN(), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// jsStringLength mirrors JavaScript String.prototype.length in UTF-16 code
// units (an astral character counts as two).
func jsStringLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// jsSliceUTF16 mirrors JavaScript String.prototype.slice(0, max) in UTF-16
// code units. A cut that lands inside a surrogate pair keeps the unpaired
// surrogate, matching the JS output.
func jsSliceUTF16(value string, max int) string {
	if max <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(value))
	if len(units) <= max {
		return value
	}
	return string(utf16.Decode(units[:max]))
}

// parseLooseTime covers the ISO-8601 shapes JavaScript new Date(string)
// accepts for the report timestamps; a missing timezone is interpreted as UTC.
func parseLooseTime(value string) (parsed time.Time, ok bool) {
	for _, layout := range looseTimeLayouts {
		if candidate, err := time.Parse(layout, value); err == nil {
			return candidate.UTC(), true
		}
	}
	return time.Time{}, false
}

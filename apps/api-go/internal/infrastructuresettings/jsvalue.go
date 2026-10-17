package infrastructuresettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// This file holds the JavaScript compatibility primitives the stored-value
// readers, the DTO equivalents and the ordering helpers depend on. They exist
// because the NestJS contracts are defined in terms of JS semantics
// (Number(), String.prototype.length, localeCompare) that Go types do not match
// by default.

// jsNumberFromJSON mirrors JavaScript's Number(value) for a decoded JSON value.
//
// The NestJS vector-service reader coerces stored values with Number(), which
// accepts numeric strings ("4", " 4 ", "0x4"), booleans (true -> 1, false -> 0),
// null (-> 0) and single-element arrays ([4] -> 4). The second return value is
// false only when raw is empty, which means "the key is absent" rather than
// "the value is NaN": absent fields fall back to their defaults, present but
// unparseable fields fall back too (the vector reader never rejects a stored
// row).
func jsNumberFromJSON(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return math.NaN(), true
		}
		return jsStringToNumber(text), true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return 0, true
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return math.NaN(), true
		}
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			return jsNumberFromJSON(items[0])
		default:
			// JS Array.prototype.toString joins with "," which Number() cannot
			// parse, so a multi-element array is NaN.
			return math.NaN(), true
		}
	case '{':
		return math.NaN(), true
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				// JSON.parse("1e999") and Number("1e999") are Infinity.
				return value, true
			}
			return math.NaN(), true
		}
		return value, true
	}
}

// jsStringToNumber mirrors JavaScript's Number(string) coercion, including the
// hex/octal/binary literal forms and the empty-string rule (Number("") === 0).
func jsStringToNumber(text string) float64 {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0o") || strings.HasPrefix(lower, "0b") {
		base := 16
		switch lower[1] {
		case 'o':
			base = 8
		case 'b':
			base = 2
		}
		value, err := strconv.ParseInt(trimmed[2:], base, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(value)
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

// jsIsInteger mirrors Number.isInteger: finite values with no fractional part.
func jsIsInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// jsFloor mirrors Math.floor for the finite range the readers accept.
func jsFloor(value float64) float64 { return math.Floor(value) }

// jsonNumberStrict parses a raw JSON token that must itself be a number (not a
// numeric string). class-validator's @IsInt/@Min/@Max never coerce.
func jsonNumberStrict(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return 0, false
	}
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// utf16Length returns String.prototype.length for the given text: the number of
// UTF-16 code units, so an astral character (emoji) counts as two. The service
// layer (but not the DTO layer, which counts code points) uses this.
func utf16Length(value string) int {
	length := 0
	for _, r := range value {
		if r > 0xFFFF {
			length += 2
			continue
		}
		length++
	}
	return length
}

// utf16Slice mirrors String.prototype.slice(start, end) measured in UTF-16 code
// units (used for the access-key-id fingerprint).
func utf16Slice(value string, start, end int) string {
	if end <= start {
		return ""
	}
	units := make([]uint16, 0, len(value))
	for _, r := range value {
		if r > 0xFFFF {
			r -= 0x10000
			units = append(units, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
			continue
		}
		units = append(units, uint16(r))
	}
	if start >= len(units) {
		return ""
	}
	if end > len(units) {
		end = len(units)
	}
	return string(utf16Decode(units[start:end]))
}

// utf16Decode converts UTF-16 code units back into a Go string.
func utf16Decode(units []uint16) []rune {
	out := make([]rune, 0, len(units))
	for i := 0; i < len(units); i++ {
		unit := units[i]
		if unit >= 0xD800 && unit <= 0xDBFF && i+1 < len(units) {
			next := units[i+1]
			if next >= 0xDC00 && next <= 0xDFFF {
				out = append(out, rune(0x10000+(int32(unit-0xD800)<<10)+int32(next-0xDC00)))
				i++
				continue
			}
		}
		out = append(out, rune(unit))
	}
	return out
}

// localeCollator caches the English collator used by localeCompare. The
// collator is not goroutine-safe, so access is serialized.
var (
	localeOnce     sync.Once
	localeCollator *collate.Collator
	localeMu       sync.Mutex
)

// localeCompare aligns JavaScript's default localeCompare English collation
// order, which the runtime-secret entry ordering depends on. Sorting by raw
// UTF-8 bytes would order "key" before "Key" differently from the NestJS
// response.
func localeCompare(a, b string) int {
	localeOnce.Do(func() {
		localeCollator = collate.New(language.English)
	})
	localeMu.Lock()
	defer localeMu.Unlock()
	return localeCollator.CompareString(a, b)
}

// trimSpace trims ASCII whitespace from a raw JSON token without copying the
// caller's bytes.
func trimSpace(raw json.RawMessage) []byte { return bytes.TrimSpace(raw) }

// boolRaw renders a boolean as the JSON value stored in a SystemSetting row.
func boolRaw(value bool) json.RawMessage {
	if value {
		return json.RawMessage("true")
	}
	return json.RawMessage("false")
}

// stringRaw renders an optional string as JSON: nil becomes the literal null.
func stringRaw(value *string) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	encoded, err := json.Marshal(*value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

// numberRaw renders an integer as JSON.
func numberRaw(value int) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("0")
	}
	return encoded
}

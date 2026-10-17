package llmgatewayprofiles

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
)

// This file mirrors the JavaScript value semantics the NestJS service relies
// on. The stored document is untyped JSON written by older releases, so every
// read has to reproduce exactly what `Number(value)`, `typeof value`,
// `Array.isArray(value)` and `value.trim()` would do in Node. All helpers take
// concrete json.RawMessage boundaries and return concrete named types; the
// package never widens a document into interface{} or map[string]any.

// present reports whether a decoded field holds any JSON at all. An absent key
// leaves json.RawMessage nil; an explicit null is present with four bytes.
func present(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// isJSONNull reports whether the field holds the JSON literal null.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// jsNumberKind classifies the outcome of JavaScript's Number(value).
type jsNumberKind int

const (
	// jsNumberAbsent means the value was undefined (a missing JSON key).
	jsNumberAbsent jsNumberKind = iota
	// jsNumberValue means the conversion produced a number (possibly ±Inf).
	jsNumberValue
	// jsNumberNaN means the conversion produced NaN.
	jsNumberNaN
)

// jsNumber is the named result of JavaScript's Number(value) applied to one
// JSON token.
type jsNumber struct {
	kind  jsNumberKind
	value float64
}

// isFinite mirrors Number.isFinite(parsed): only a real, finite number passes.
func (n jsNumber) isFinite() bool {
	return n.kind == jsNumberValue && !math.IsNaN(n.value) && !math.IsInf(n.value, 0)
}

// numberJSNumber builds a finite-or-not numeric result.
func numberJSNumber(value float64) jsNumber {
	return jsNumber{kind: jsNumberValue, value: value}
}

// parseJSNumber converts one JSON token exactly like JavaScript's Number():
// null -> 0, true -> 1, false -> 0, "" -> 0, numeric strings -> their value,
// [] -> 0, [x] -> Number(x), longer arrays and objects -> NaN.
func parseJSNumber(raw json.RawMessage) jsNumber {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return jsNumber{kind: jsNumberAbsent}
	}
	switch trimmed[0] {
	case 'n': // null
		return numberJSNumber(0)
	case 't':
		return numberJSNumber(1)
	case 'f':
		return numberJSNumber(0)
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return jsNumber{kind: jsNumberNaN}
		}
		return parseJSNumberString(text)
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return jsNumber{kind: jsNumberNaN}
		}
		switch len(items) {
		case 0:
			return numberJSNumber(0)
		case 1:
			return parseJSNumber(items[0])
		default:
			return jsNumber{kind: jsNumberNaN}
		}
	case '{':
		return jsNumber{kind: jsNumberNaN}
	}
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		if isRangeError(err) {
			// Out-of-range literals behave like JavaScript: 1e999 is +Inf,
			// 1e-999 underflows to 0. Both fail Number.isFinite or clamp to 0
			// exactly like Node.
			return numberJSNumber(value)
		}
		return jsNumber{kind: jsNumberNaN}
	}
	return numberJSNumber(value)
}

// parseJSNumberString converts a JSON string the way Number(string) does.
func parseJSNumberString(value string) jsNumber {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return numberJSNumber(0)
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return numberJSNumber(math.Inf(1))
	case "-Infinity":
		return numberJSNumber(math.Inf(-1))
	}
	// Go's ParseFloat accepts "inf"/"nan"/"Infinity" case-insensitively and
	// "0x1p-2"/"1_000"; JavaScript does not. Reject those spellings first.
	lower := strings.ToLower(trimmed)
	switch lower {
	case "nan", "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity":
		return jsNumber{kind: jsNumberNaN}
	}
	if strings.ContainsAny(trimmed, "_xXpP") {
		return jsNumber{kind: jsNumberNaN}
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		if isRangeError(err) {
			return numberJSNumber(parsed)
		}
		return jsNumber{kind: jsNumberNaN}
	}
	return numberJSNumber(parsed)
}

// isRangeError reports whether a strconv.ParseFloat failure was a range error
// (the returned value is still the closest float, ±Inf or zero).
func isRangeError(err error) bool {
	return errors.Is(err, strconv.ErrRange)
}

// asPositiveInt mirrors the service helper: finite and > 0 then Math.floor,
// otherwise the fallback. Note that Number(null) === 0 and Number([]) === 0
// therefore fall back, while Number(true) === 1 is accepted.
func asPositiveInt(n jsNumber, fallback float64) float64 {
	if !n.isFinite() || n.value <= 0 {
		return fallback
	}
	return math.Floor(n.value)
}

// clampNumber mirrors the service helper: finite then clamp into [min,max],
// otherwise the fallback.
func clampNumber(n jsNumber, fallback, min, max float64) float64 {
	if !n.isFinite() {
		return fallback
	}
	return math.Min(max, math.Max(min, n.value))
}

// jsString reports the string value of a JSON string token.
func jsString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsBool reports the value of a JSON boolean token.
func jsBool(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// normalizeString mirrors the service normalizeString: trimmed non-empty
// strings survive, everything else (including null) becomes absent.
func normalizeString(raw json.RawMessage) *string {
	text, ok := jsString(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeEnabled is the GP3 rule: booleans are preserved, absent/null keep the
// historical default true, and every other JSON type degrades to false instead
// of being enabled by JavaScript truthiness.
func normalizeEnabled(raw json.RawMessage) bool {
	if value, ok := jsBool(raw); ok {
		return value
	}
	if !present(raw) || isJSONNull(raw) {
		return true
	}
	return false
}

// normalizeBool mirrors the service normalizeBoolean: strict booleans only.
func normalizeBool(raw json.RawMessage, fallback bool) bool {
	if value, ok := jsBool(raw); ok {
		return value
	}
	return fallback
}

// nonNilStrings guarantees a JSON array (never null) in the response.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// normalizeStringList mirrors the service normalizeStringList: non-arrays keep
// the fallback, array items are trimmed, empties dropped, and the first
// occurrence order is preserved.
func normalizeStringList(raw json.RawMessage, fallback []string) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nonNilStrings(fallback)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nonNilStrings(fallback)
	}
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		text, ok := jsString(item)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" || seen[text] {
			continue
		}
		seen[text] = true
		out = append(out, text)
	}
	return out
}

// jsLengthUTF16 reports the UTF-16 code unit length, which is what JavaScript's
// String#length and validator.js length checks use.
func jsLengthUTF16(value string) int {
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

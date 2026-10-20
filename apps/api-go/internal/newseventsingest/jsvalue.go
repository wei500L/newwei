package newseventsingest

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// This file holds the JavaScript value semantics the port has to reproduce
// byte for byte. Go's standard helpers are close but not identical:
//
//   - strings.TrimSpace does not strip U+FEFF and does strip U+0085, while
//     String.prototype.trim is the specification WhiteSpace + LineTerminator
//     set, which includes U+FEFF and excludes U+0085;
//   - `\s` in a JavaScript regular expression is that same set, while Go's
//     regexp `\s` is [\t\n\f\r ] only;
//   - `typeof value === "number"` is false for a JSON string, so a stored
//     number must never be coerced.

// jsWhitespace reports whether r belongs to the ECMAScript WhiteSpace or
// LineTerminator production. That is exactly the set String.prototype.trim
// removes and the set `\s` matches.
func jsWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	// Unicode category Zs between U+2000 and U+200A (the en/em quad family).
	return r >= '\u2000' && r <= '\u200a'
}

// jsTrim implements String.prototype.trim.
func jsTrim(value string) string {
	return strings.TrimFunc(value, jsWhitespace)
}

// jsNormalizeOptionalString implements
//
//	typeof value === "string" ? (value.trim() || null) : null
func jsNormalizeOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrim(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// jsClampUnit implements clamp01: a non-finite value collapses to 0, everything
// else is clamped into 0..1 without rounding.
func jsClampUnit(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// jsClampPenalty implements Math.min(Math.max(value, 0), 1), the language and
// category penalty clamp. Unlike clamp01 it does not special-case NaN; a NaN
// value keeps NaN, exactly like Math.min/Math.max do.
func jsClampPenalty(value float64) float64 {
	if math.IsNaN(value) {
		return value
	}
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// isFinite reports Number.isFinite.
func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// jsonNumber reads a JSON number. present reports whether the member existed;
// ok reports whether it was a number (a string, boolean, null or object is not).
func jsonNumber(raw json.RawMessage) (value float64, present, ok bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false, false
	}
	if !isJSONNumberLiteral(trimmed) {
		return 0, true, false
	}
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, true, false
	}
	return value, true, true
}

// isJSONNumberLiteral reports whether raw starts like a JSON number. null, a
// string, a boolean, an object and an array all start with another byte.
func isJSONNumberLiteral(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	switch raw[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return true
	}
	return false
}

// jsonString reads a JSON string. ok is false for every other JSON type.
func jsonString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

// jsonArrayElements decodes a JSON array into its raw elements. A non-array
// value (including null) yields (nil, false), which is the `Array.isArray`
// negative branch.
func jsonArrayElements(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(trimmed, &elements); err != nil {
		return nil, false
	}
	return elements, true
}

// jsonObjectFields decodes a JSON object into its typed field reader. The second
// result is false for null, arrays and scalars, which is the
// `value && typeof value === "object" && !Array.isArray(value)` negative branch.
//
// The object is re-read through a typed projection instead of a map so no
// schema-less container carries business data.
func jsonObjectFields(raw json.RawMessage, projection any) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	if err := json.Unmarshal(trimmed, projection); err != nil {
		return false
	}
	return true
}

// sleepContext waits for the duration or until the context is done.
func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// itoa renders an integer in base 10.
func itoa(value int) string {
	return strconv.Itoa(value)
}

// strconvParseFloat parses a JavaScript Number() argument.
func strconvParseFloat(value string) (float64, error) {
	if value == "" {
		// Number("") is 0.
		return 0, nil
	}
	return strconv.ParseFloat(value, 64)
}

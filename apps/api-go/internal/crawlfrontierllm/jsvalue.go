package crawlfrontierllm

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// This file ports the JavaScript value semantics the judge/learn chains rely
// on. The notable differences from the Go defaults are documented per helper
// because they are easy to get wrong:
//   - strings.TrimSpace and JavaScript String.prototype.trim do not share the
//     same whitespace set (JS trims U+FEFF and every Unicode space separator);
//   - Number("") is 0, Number("0x10") is 16, and Number(true) is 1;
//   - Array.prototype.sort is stable and localeCompare ordering is not byte
//     ordering.

// jsTrim is String.prototype.trim: it removes WhiteSpace and LineTerminator
// code points, including U+FEFF which strings.TrimSpace keeps.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// isFinite reports Number.isFinite.
func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// numberJSON renders a finite number like JSON.stringify: integral values have
// no fractional part, everything else uses the shortest round-trip form.
func numberJSON(value float64) json.RawMessage {
	if value == 0 {
		// JSON.stringify(-0) is "0".
		return json.RawMessage("0")
	}
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return json.RawMessage(strconv.FormatInt(int64(value), 10))
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

// toFiniteNumber is toFiniteNumber from crawl-frontier.service.ts: a finite
// number is returned as-is, everything else goes through Number() semantics
// and only a finite result is kept.
func toFiniteNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return 0, false
		}
		value, ok := jsNumberString(text)
		return value, ok
	case 't':
		if string(trimmed) == "true" {
			return 1, true
		}
	case 'f':
		if string(trimmed) == "false" {
			return 0, true
		}
	case 'n':
		if string(trimmed) == "null" {
			return 0, true
		}
	default:
		var value float64
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return 0, false
		}
		return value, isFinite(value)
	}
	return 0, false
}

// jsNumberString implements the string branch of Number().
func jsNumberString(value string) (float64, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return 0, true
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1), false
	case "-Infinity":
		return math.Inf(-1), false
	}
	sign := 1.0
	body := trimmed
	if strings.HasPrefix(body, "+") {
		body = body[1:]
	} else if strings.HasPrefix(body, "-") {
		sign = -1
		body = body[1:]
	}
	if len(body) > 2 {
		prefix := strings.ToLower(body[:2])
		if prefix == "0x" || prefix == "0b" || prefix == "0o" {
			base := 16
			switch prefix {
			case "0b":
				base = 2
			case "0o":
				base = 8
			}
			parsed, err := strconv.ParseUint(body[2:], base, 64)
			if err != nil {
				return 0, false
			}
			return sign * float64(parsed), true
		}
	}
	// Go's ParseFloat accepts "NaN" and "Inf" spellings JS rejects, so guard
	// the alphabet before parsing.
	for _, char := range body {
		if (char >= '0' && char <= '9') || char == '.' || char == 'e' || char == 'E' || char == '+' || char == '-' {
			continue
		}
		return 0, false
	}
	parsed, err := strconv.ParseFloat(body, 64)
	if err != nil {
		return 0, false
	}
	if !isFinite(parsed) {
		return 0, false
	}
	return sign * parsed, true
}

// roundToFixed is Number.prototype.toFixed for a fixed digit count. It rounds
// half away from zero, which matches toFixed for the values this chain stores
// (scores and ratios).
func roundToFixed(value float64, digits int) float64 {
	if !isFinite(value) {
		return 0
	}
	scale := math.Pow(10, float64(digits))
	return math.Round(value*scale) / scale
}

// uniqueStringList mirrors uniqueStringList: flatMap over the lists, trim each
// entry, drop empty ones, de-duplicate in first-seen order, and return nil when
// nothing is left.
func uniqueStringList(lists ...[]string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0)
	for _, list := range lists {
		for _, entry := range list {
			trimmed := jsTrim(entry)
			if trimmed == "" {
				continue
			}
			if _, ok := seen[trimmed]; ok {
				continue
			}
			seen[trimmed] = struct{}{}
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// coerceStringArray mirrors coerceStringArray: only strings are kept, each is
// trimmed, empty entries are dropped, and an empty result is nil.
func coerceStringArray(values []json.RawMessage) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			continue
		}
		trimmed := jsTrim(text)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// decodeStringArray decodes a raw JSON array into string entries.
func decodeStringArray(raw json.RawMessage) ([]string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil, false
	}
	var values []json.RawMessage
	if err := json.Unmarshal(trimmed, &values); err != nil {
		return nil, false
	}
	return coerceStringArray(values), true
}

// nestISOString is Date.prototype.toISOString: UTC, exactly three fractional
// digits, ending in Z.
func nestISOString(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// nestNowISOString is new Date().toISOString().
func nestNowISOString() string {
	return nestISOString(time.Now())
}

// truncateMillis is the millisecond precision MySQL DATETIME(3) keeps.
func truncateMillis(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

// parseJSONTime parses the ISO spellings the chain stores.
func parseJSONTime(value string) (time.Time, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

// jsonOrNull returns a nullable SQL string argument.
func jsonOrNull(raw json.RawMessage) any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	return string(trimmed)
}

// marshalRawOr returns the raw value or a fallback JSON literal.
func marshalRawOr(raw json.RawMessage, fallback string) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return json.RawMessage(fallback)
	}
	return trimmed
}

// cloneRaw copies a raw leaf.
func cloneRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

// isEmptyJSON reports a missing or JSON-null raw value.
func isEmptyJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || string(trimmed) == "null"
}

// runeLen is String.prototype.length for the truncation helpers.
func runeLen(value string) int {
	return len([]rune(value))
}

// sliceRunes is String.prototype.slice(0, limit) over code points.
func sliceRunes(value string, limit int) string {
	runes := []rune(value)
	if limit >= len(runes) {
		return value
	}
	if limit <= 0 {
		return ""
	}
	return string(runes[:limit])
}

// isWhitespaceRune reports the JS whitespace set for split helpers.
func isWhitespaceRune(r rune) bool {
	return isJSWhitespace(r) || unicode.IsSpace(r)
}

// marshalJSON encodes a value without HTML escaping, matching JSON.stringify:
// URLs with `&` must stay `&`, not `\u0026`, or the prompt body differs from
// the NestJS request.
func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := buffer.Bytes()
	if len(encoded) > 0 && encoded[len(encoded)-1] == '\n' {
		encoded = encoded[:len(encoded)-1]
	}
	return encoded, nil
}

// prettyJSON is JSON.stringify(value, null, 2): two-space indentation, no HTML
// escaping and the same member order as the raw document.
func prettyJSON(raw []byte) string {
	var buffer bytes.Buffer
	if err := json.Indent(&buffer, raw, "", "  "); err != nil {
		return string(raw)
	}
	return buffer.String()
}

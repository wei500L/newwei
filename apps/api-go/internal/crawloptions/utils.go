package crawloptions

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// NormalizeKeywords is crawl.utils.ts normalizeKeywords: trim, lower-case, drop
// empties, de-duplicate in first-occurrence order and cap at 25.
func NormalizeKeywords(input []string) []string {
	if len(input) == 0 {
		return []string{}
	}
	normalized := make([]string, 0, len(input))
	for _, keyword := range input {
		trimmed := strings.ToLower(strings.TrimSpace(keyword))
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, trimmed)
	}
	seen := make(map[string]bool, len(normalized))
	out := make([]string, 0, len(normalized))
	for _, keyword := range normalized {
		if len(out) >= 25 {
			break
		}
		if seen[keyword] {
			continue
		}
		seen[keyword] = true
		out = append(out, keyword)
	}
	return out
}

// CoerceDate is crawl.utils.ts coerceDate: an empty value and an unparseable
// value both become undefined.
func CoerceDate(value string) *time.Time {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	parsed, ok := parseJSDate(trimmed)
	if !ok {
		return nil
	}
	return &parsed
}

// parseJSDate accepts the shapes `new Date(string)` accepts for the values the
// API receives: RFC 3339, a space-separated date-time, a date-only value and a
// numeric timestamp string. An unparseable value reports ok=false.
func parseJSDate(value string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"2006-01",
		"2006",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), true
		}
	}
	// Numeric timestamps are milliseconds, like new Date(number).
	if digits, err := strconv.ParseInt(value, 10, 64); err == nil {
		return time.UnixMilli(digits).UTC(), true
	}
	return time.Time{}, false
}

// jsToNumber mirrors JavaScript Number(value) for the JSON shapes a request
// body can carry. ok=false is NaN.
func jsToNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return math.NaN(), false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal([]byte(trimmed), &text); err != nil {
			return math.NaN(), false
		}
		return jsNumberFromString(text)
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return math.NaN(), false
	case '[':
		var entries []json.RawMessage
		if err := json.Unmarshal([]byte(trimmed), &entries); err != nil {
			return math.NaN(), false
		}
		switch len(entries) {
		case 0:
			return 0, true
		case 1:
			return jsToNumber(entries[0])
		default:
			return math.NaN(), false
		}
	case '{':
		return math.NaN(), false
	default:
		var number json.Number
		if err := json.Unmarshal([]byte(trimmed), &number); err != nil {
			return math.NaN(), false
		}
		value, err := number.Float64()
		if err != nil {
			return math.NaN(), false
		}
		return value, true
	}
}

// jsNumberFromString mirrors Number(string).
func jsNumberFromString(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "infinity", "+infinity":
		return math.Inf(1), true
	case "-infinity":
		return math.Inf(-1), true
	}
	sign := 1.0
	body := trimmed
	if strings.HasPrefix(body, "+") {
		body = body[1:]
	} else if strings.HasPrefix(body, "-") {
		sign = -1
		body = body[1:]
	}
	lowerBody := strings.ToLower(body)
	if strings.HasPrefix(lowerBody, "0x") {
		if parsed, err := strconv.ParseUint(body[2:], 16, 64); err == nil {
			return sign * float64(parsed), true
		}
		return math.NaN(), false
	}
	if strings.HasPrefix(lowerBody, "0b") {
		if parsed, err := strconv.ParseUint(body[2:], 2, 64); err == nil {
			return sign * float64(parsed), true
		}
		return math.NaN(), false
	}
	if strings.HasPrefix(lowerBody, "0o") {
		if parsed, err := strconv.ParseUint(body[2:], 8, 64); err == nil {
			return sign * float64(parsed), true
		}
		return math.NaN(), false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return math.NaN(), false
	}
	return parsed, true
}

// jsonIntValue converts a JSON number to an int with JavaScript Math.round,
// used only after validation proved the value is an integer.
func jsonIntValue(raw json.RawMessage) (int, bool) {
	value, ok := jsToNumber(raw)
	if !ok || !isFinite(value) {
		return 0, false
	}
	return int(value), true
}

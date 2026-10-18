package accountsecurity

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// This file holds the JavaScript compatibility primitives the DTO equivalents,
// the stored-value readers and the date formatting depend on.

// present reports whether a decoded field holds any JSON at all. An absent key
// leaves json.RawMessage nil; `null` is present with the four bytes "null".
func present(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// isNull reports whether the field holds the JSON literal null. NestJS
// distinguishes undefined (absent) from null in the @IsOptional paths.
func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// skippedOptional reports whether @IsOptional() short-circuits every decorator
// on the property (absent or null).
func skippedOptional(raw json.RawMessage) bool {
	return !present(raw) || isNull(raw)
}

// jsonString decodes one raw JSON token as a Go string. Numeric strings are
// never coerced and a non-string token reports false.
func jsonString(raw json.RawMessage) (string, bool) {
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

// jsonNumberStrict parses a raw JSON token that must itself be a number (not a
// numeric string). class-validator's numeric decorators never coerce.
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

// jsIsFiniteNumber reports whether raw is a finite JSON number.
func jsIsFiniteNumber(raw json.RawMessage) (float64, bool) {
	value, ok := jsonNumberStrict(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// clamp bounds a value the way the NestJS auth-cache clamp helper does.
func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// maxInt returns the largest of the given integers.
func maxInt(values ...int) int {
	result := values[0]
	for _, value := range values[1:] {
		if value > result {
			result = value
		}
	}
	return result
}

// runeLength is JavaScript's validator.isLength length for a string: it counts
// Unicode code points (surrogate pairs count once).
func runeLength(value string) int {
	return len([]rune(value))
}

// jsDateLayout is the exact `new Date().toISOString()` member layout
// (millisecond precision, UTC, trailing Z).
const jsDateLayout = "2006-01-02T15:04:05.000Z"

// formatJSDate renders a nullable time as an ISO string or JSON null. The value
// is truncated to milliseconds because MySQL DATETIME(3) has no sub-millisecond
// precision and JavaScript Date has none either.
func formatJSDate(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Truncate(time.Millisecond).Format(jsDateLayout)
	return &formatted
}

// formatJSMillis renders a millisecond epoch as the ISO string NestJS returns.
func formatJSMillis(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format(jsDateLayout)
}

// ttlSecondsUntilSeconds mirrors the NestJS ttlSecondsUntil helper:
// max(0, ceil((expiresAt - now) / 1000)).
func ttlSecondsUntil(expiresAt, now time.Time) int {
	remainingMillis := expiresAt.UnixMilli() - now.UnixMilli()
	if remainingMillis <= 0 {
		return 0
	}
	return int((remainingMillis + 999) / 1000)
}

// isURL reproduces the validator.js isURL defaults used by @IsUrl({
// require_protocol: true }): an absolute http/https/ftp URL with a host and no
// whitespace. It intentionally does not reject based on the storage base URL —
// that is the separate StorageService.isPublicUrl check.
func isURL(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.ContainsAny(trimmed, " \t\r\n") {
		return false
	}
	schemeEnd := strings.Index(trimmed, "://")
	if schemeEnd <= 0 {
		return false
	}
	scheme := strings.ToLower(trimmed[:schemeEnd])
	switch scheme {
	case "http", "https", "ftp":
	default:
		return false
	}
	rest := trimmed[schemeEnd+3:]
	// Host is everything before the first /, ? or #.
	hostEnd := len(rest)
	for index := 0; index < len(rest); index++ {
		switch rest[index] {
		case '/', '?', '#':
			hostEnd = index
			index = len(rest)
		}
	}
	host := rest[:hostEnd]
	if host == "" {
		return false
	}
	// validator.js requires a hostname with at least one label; a bare ":8080"
	// or "[::1" style garbage has no host label. Bracketed IPv6 is allowed.
	if strings.HasPrefix(host, "[") {
		return strings.Contains(host, "]")
	}
	hostname := host
	if colon := strings.LastIndex(hostname, ":"); colon >= 0 {
		hostname = hostname[:colon]
	}
	return hostname != "" && !strings.Contains(hostname, ":")
}

// iso8601Extended matches the validator.js isISO8601 extended forms the NestJS
// @IsDateString() decorator accepts: a date, optionally followed by a time with
// optional seconds/fraction/offset.
var iso8601Extended = []string{
	"2006-01-02",
	"2006-01-02T15:04",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04:05Z07:00",
	"2006-01-02 15:04",
	"2006-01-02 15:04:05",
}

// isISODateString validates the value the way @IsDateString() does for the
// extended ISO 8601 forms this contract uses.
func isISODateString(value string) bool {
	if strings.TrimSpace(value) != value || value == "" {
		return false
	}
	for _, layout := range iso8601Extended {
		parsed, err := time.Parse(layout, value)
		if err != nil {
			continue
		}
		// time.Parse rejects out-of-range months/days/hours, which mirrors
		// validator.js range checks.
		if parsed.Year() < 0 {
			return false
		}
		return true
	}
	return false
}

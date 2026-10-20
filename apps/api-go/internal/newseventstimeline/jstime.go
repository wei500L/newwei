package newseventstimeline

import (
	"errors"
	"strings"
	"time"
)

// dateOnlyLayout and the local date-time layouts are the ECMAScript
// Date.parse shapes this package accepts beyond RFC 3339.
const (
	dateOnlyLayout        = "2006-01-02"
	localMinuteLayout     = "2006-01-02T15:04"
	localSecondLayout     = "2006-01-02T15:04:05"
	localFractionalLayout = "2006-01-02T15:04:05.999999999"
)

var errNotJSTimestamp = errors.New("newseventstimeline: not a JavaScript-parseable timestamp")

// parseDateOnly handles the date-only form, which ECMAScript interprets as UTC
// midnight.
func parseDateOnly(value string) (time.Time, error) {
	if len(value) != len(dateOnlyLayout) || strings.Count(value, "-") != 2 {
		return time.Time{}, errNotJSTimestamp
	}
	if value[4] != '-' || value[7] != '-' {
		return time.Time{}, errNotJSTimestamp
	}
	return time.ParseInLocation(dateOnlyLayout, value, time.UTC)
}

// timeParseRFC3339 handles the only shape NestJS writes: Date.toISOString with a
// Z suffix, plus any explicit numeric offset.
func timeParseRFC3339(value string) (time.Time, error) {
	if !strings.ContainsAny(value, "Zz") && !hasNumericOffset(value) {
		return time.Time{}, errNotJSTimestamp
	}
	return time.Parse(time.RFC3339Nano, value)
}

// hasNumericOffset reports whether the value ends in "+HH:MM" or "-HH:MM".
func hasNumericOffset(value string) bool {
	if len(value) < 6 {
		return false
	}
	tail := value[len(value)-6:]
	return (tail[0] == '+' || tail[0] == '-') && tail[3] == ':'
}

// parseLocalDateTime handles a date-time without an offset, which ECMAScript
// interprets in the host's local time zone.
func parseLocalDateTime(value string) (time.Time, error) {
	if !strings.Contains(value, "T") {
		return time.Time{}, errNotJSTimestamp
	}
	for _, layout := range []string{localFractionalLayout, localSecondLayout, localMinuteLayout} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, errNotJSTimestamp
}

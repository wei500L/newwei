package economic

import (
	"strings"
	"time"
)

// parseDateTime accepts the DateTime strings Nest's GraphQLISODateTime scalar
// accepts for this input: RFC3339 (including fractional seconds and offsets)
// and a date-only YYYY-MM-DD. Date-only is UTC midnight. Calendar overflow
// matches JavaScript Date, so 2026-02-31 is 2026-03-03. Invalid input returns
// false; callers must return a resolver error instead of the zero time.
func parseDateTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	if parsed, ok := parseDateOnly(value); ok {
		return parsed, true
	}
	normalized := normalizeDateTime(value)
	if parsed, err := time.Parse(time.RFC3339Nano, normalized); err == nil {
		return parsed.UTC().Round(time.Millisecond), true
	}
	if parsed, err := time.Parse(time.RFC3339, normalized); err == nil {
		return parsed.UTC().Round(time.Millisecond), true
	}
	if parsed, ok := parseOverflowDateTime(normalized); ok {
		return parsed.UTC().Round(time.Millisecond), true
	}
	return time.Time{}, false
}

func parseDateOnly(value string) (time.Time, bool) {
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return time.Time{}, false
	}
	year, okY := atoiStrict(value[:4])
	month, okM := atoiStrict(value[5:7])
	day, okD := atoiStrict(value[8:])
	if !okY || !okM || !okD || month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC), true
}

func parseOverflowDateTime(value string) (time.Time, bool) {
	if len(value) < 11 || value[4] != '-' || value[7] != '-' || value[10] != 'T' {
		return time.Time{}, false
	}
	year, okY := atoiStrict(value[0:4])
	month, okM := atoiStrict(value[5:7])
	day, okD := atoiStrict(value[8:10])
	if !okY || !okM || !okD || month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	synthetic := value[:8] + "01" + value[10:]
	var parsed time.Time
	var err error
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		parsed, err = time.Parse(layout, synthetic)
		if err == nil {
			break
		}
	}
	if err != nil {
		return time.Time{}, false
	}
	return time.Date(year, time.Month(month), day, parsed.Hour(), parsed.Minute(), parsed.Second(), parsed.Nanosecond(), parsed.Location()), true
}

func normalizeDateTime(value string) string {
	buf := []byte(value)
	for i, ch := range buf {
		switch ch {
		case 't':
			buf[i] = 'T'
		case 'z':
			buf[i] = 'Z'
		}
	}
	return insertOffsetColon(string(buf))
}

func insertOffsetColon(value string) string {
	if len(value) < 5 {
		return value
	}
	tail := value[len(value)-5:]
	if (tail[0] != '+' && tail[0] != '-') || strings.Contains(tail, ":") {
		return value
	}
	for _, ch := range tail[1:] {
		if ch < '0' || ch > '9' {
			return value
		}
	}
	return value[:len(value)-5] + tail[:3] + ":" + tail[3:]
}

func atoiStrict(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	number := 0
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		number = number*10 + int(ch-'0')
	}
	return number, true
}

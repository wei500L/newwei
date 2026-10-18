package situationsignals

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	// The distroless runtime image has no system tzdata; the Asia/Jerusalem
	// lookup below needs the embedded database.
	_ "time/tzdata"
)

// jerusalemLocation is the zone OREF wall-clock timestamps are expressed in.
var jerusalemLocation = mustLoadJerusalem()

// mustLoadJerusalem resolves Asia/Jerusalem once. The embedded tzdata makes the
// lookup succeed in the production image; if it somehow fails the converter
// falls back to a fixed +02:00 offset rather than panicking.
func mustLoadJerusalem() *time.Location {
	location, err := time.LoadLocation("Asia/Jerusalem")
	if err != nil {
		return time.FixedZone("Asia/Jerusalem", 2*60*60)
	}
	return location
}

// orefDateToUTC mirrors apps/api/src/modules/situation-monitor/signals/oref-date.ts.
//
// OREF emits naive "YYYY-MM-DD HH:mm:ss" wall-clock times with no zone. The
// converter tries the UTC+2 and UTC+3 interpretations, keeps the ones that
// round-trip in Asia/Jerusalem and selects the earliest; anything malformed
// becomes the current instant.
func orefDateToUTC(dateStr string) string {
	if dateStr == "" || !strings.Contains(dateStr, " ") {
		return nestISOTime(float64(time.Now().UnixMilli()))
	}
	parts := strings.SplitN(dateStr, " ", 2)
	dateSegments := strings.Split(parts[0], "-")
	timeSegments := strings.Split(parts[1], ":")
	if len(dateSegments) != 3 || len(timeSegments) != 3 {
		return nestISOTime(float64(time.Now().UnixMilli()))
	}
	year, okYear := parseJSInt(dateSegments[0])
	month, okMonth := parseJSInt(dateSegments[1])
	day, okDay := parseJSInt(dateSegments[2])
	hours, okHours := parseJSInt(timeSegments[0])
	minutes, okMinutes := parseJSInt(timeSegments[1])
	seconds, okSeconds := parseJSInt(timeSegments[2])
	if !okYear || !okMonth || !okDay || !okHours || !okMinutes || !okSeconds {
		return nestISOTime(float64(time.Now().UnixMilli()))
	}

	utcPlus2 := time.Date(year, time.Month(month), day, hours-2, minutes, seconds, 0, time.UTC)
	utcPlus3 := time.Date(year, time.Month(month), day, hours-3, minutes, seconds, 0, time.UTC)

	// Both offsets can round-trip during the DST fall-back hour; JavaScript
	// collects the candidates and picks the earliest instant, so the ambiguous
	// hour resolves to the UTC+3 interpretation.
	candidates := make([]time.Time, 0, 2)
	if formatInJerusalem(utcPlus2) == dateStr {
		candidates = append(candidates, utcPlus2)
	}
	if formatInJerusalem(utcPlus3) == dateStr {
		candidates = append(candidates, utcPlus3)
	}
	selected := utcPlus2
	if len(candidates) > 0 {
		selected = candidates[0]
		for _, candidate := range candidates[1:] {
			if candidate.Before(selected) {
				selected = candidate
			}
		}
	}
	return nestISOTimeFromMillis(selected.UnixMilli())
}

// formatInJerusalem renders the instant the way the Intl formatter in oref-date.ts
// does: "YYYY-MM-DD HH:mm:ss" in Asia/Jerusalem with a 24-hour clock.
func formatInJerusalem(instant time.Time) string {
	return instant.In(jerusalemLocation).Format("2006-01-02 15:04:05")
}

// parseJSInt parses a decimal integer with JavaScript Number() semantics.
func parseJSInt(value string) (int, bool) {
	number, ok := parseJSNumberString(value)
	if !ok {
		return 0, false
	}
	return int(number), true
}

// jsonStringValue encodes a Go string as a JSON string literal.
func jsonStringValue(value string) rawJSON {
	encoded, err := json.Marshal(value)
	if err != nil {
		return rawJSON{raw: []byte(`""`)}
	}
	return rawJSON{raw: encoded}
}

// jsDateParseOrNow mirrors `Date.parse(value) || Date.now()`: an unparseable
// value and the exact epoch both fall back to the current instant, because
// JavaScript treats 0 as falsy.
func jsDateParseOrNow(value string) time.Time {
	parsed, ok := parseJSTime(jsonStringValue(value))
	if !ok || parsed.UnixMilli() == 0 {
		return time.Now()
	}
	return parsed
}

// intString renders an int without importing strconv at every call site.
func intString(value int) string {
	return strconv.Itoa(value)
}

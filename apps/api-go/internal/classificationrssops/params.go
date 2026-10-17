package classificationrssops

import (
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// querySingle reads a query parameter that must appear exactly once. A repeated
// parameter yields the empty string, which callers treat as "not supplied" —
// the same way the NestJS DTO transforms behave when Express hands them an
// array instead of a string.
func querySingle(values url.Values, name string) string {
	items := values[name]
	if len(items) != 1 {
		return ""
	}
	return items[0]
}

// parseQualityWindow mirrors `query.window ?? "24h"` plus @IsIn(QUALITY_WINDOWS).
// An empty value selects the default; any other unlisted value is a 400.
func parseQualityWindow(raw string) (QualityWindow, error) {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return QualityWindow24h, nil
	}
	switch QualityWindow(normalized) {
	case QualityWindow1h, QualityWindow24h, QualityWindow7d:
		return QualityWindow(normalized), nil
	}
	return QualityWindow24h, newStatus(400,
		"window must be one of the following values: "+strings.Join(qualityWindows, ", "))
}

// parseOptionalStringQuery mirrors normalizeOptionalString: a value that is
// empty after trimming becomes absent.
func parseOptionalStringQuery(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// parseOptionalBooleanQuery mirrors normalizeOptionalBoolean plus @IsBoolean.
// present is false when the value is absent (or repeated, see querySingle);
// any other spelling is a 400.
func parseOptionalBooleanQuery(raw string) (value bool, present bool, err error) {
	if raw == "" {
		return false, false, nil
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1":
		return true, true, nil
	case "false", "0":
		return false, true, nil
	}
	return false, false, newStatus(400, "onlyUnreviewed must be a boolean value")
}

// parseOptionalIntQuery mirrors normalizeOptionalInteger plus @IsInt/@Min/@Max.
// A present but non-numeric value is a 400 (class-validator rejects NaN); a
// finite value is truncated with Math.floor and range checked.
func parseOptionalIntQuery(raw, name string, min, max int) (*int, error) {
	if raw == "" {
		return nil, nil
	}
	parsed, ok := finiteNumber(raw)
	if !ok {
		return nil, newStatus(400, name+" must be an integer number")
	}
	floored := int(math.Floor(parsed))
	if floored < min {
		return nil, newStatus(400, name+" must not be less than "+strconv.Itoa(min))
	}
	if floored > max {
		return nil, newStatus(400, name+" must not be greater than "+strconv.Itoa(max))
	}
	return &floored, nil
}

// parseOptionalFloatQuery mirrors normalizeOptionalNumber plus
// @IsNumber({maxDecimalPlaces: 6})/@Min/@Max.
func parseOptionalFloatQuery(raw, name string, min, max float64) (*float64, error) {
	if raw == "" {
		return nil, nil
	}
	parsed, ok := finiteNumber(raw)
	if !ok {
		return nil, newStatus(400, name+" must be a number conforming to the specified constraints")
	}
	if parsed < min {
		return nil, newStatus(400, name+" must not be less than "+formatJSNumber(min))
	}
	if parsed > max {
		return nil, newStatus(400, name+" must not be greater than "+formatJSNumber(max))
	}
	return &parsed, nil
}

// formatJSNumber renders a bound the way class-validator interpolates it into a
// message (0 and 1 for the confidence range).
func formatJSNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// validObjectID mirrors mongoose's Types.ObjectId.isValid: a 12-character
// string or a 24-character hexadecimal string. Anything else (for example
// "not-an-object-id") must never reach a Mongo _id query, because Mongoose
// would raise an uncaught CastError and answer 500.
func validObjectID(value string) bool {
	if len(value) == 12 {
		return true
	}
	if len(value) != 24 {
		return false
	}
	for _, char := range value {
		switch {
		case char >= '0' && char <= '9':
		case char >= 'a' && char <= 'f':
		case char >= 'A' && char <= 'F':
		default:
			return false
		}
	}
	return true
}

// resolveWindow mirrors the private resolveWindow helper: the window start/end
// and the trend bucket size in minutes.
func resolveWindow(window QualityWindow) (time.Time, time.Time, int) {
	now := time.Now().UTC()
	hours := 24
	bucketMinutes := 60
	switch window {
	case QualityWindow1h:
		hours = 1
		bucketMinutes = 5
	case QualityWindow7d:
		hours = 24 * 7
		bucketMinutes = 360
	}
	from := now.Add(-time.Duration(hours) * time.Hour)
	return from, now, bucketMinutes
}

// parseCursor mirrors the private parseCursor helper: an unparseable cursor is
// ignored rather than rejected.
func parseCursor(cursor *string) *time.Time {
	if cursor == nil {
		return nil
	}
	return parseJSDate(*cursor)
}

// expiryDate mirrors the private computeExpiryDate helper.
func expiryDate(retentionDays int) time.Time {
	days := maxInt(retentionDays, 1)
	return nowMillis().Add(time.Duration(days) * 24 * time.Hour)
}

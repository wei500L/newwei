package newsnowsources

import (
	"math"
	"strconv"
	"strings"
)

// jsNumberString mirrors Number.prototype.toString for the values these
// providers emit. Integers never use exponent notation, which matters for
// percentages and vote counts.
func jsNumberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if value == 0 {
		return "0"
	}
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// jsNumberFromString mirrors Number(value): empty and whitespace strings are 0,
// anything else must parse as a float.
func jsNumberFromString(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return math.NaN(), false
	}
	return parsed, true
}

// pickNonEmpty mirrors JavaScript `a || b` for strings.
func pickNonEmpty(primary, fallback string) string {
	if primary != "" {
		return primary
	}
	return fallback
}

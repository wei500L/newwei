package crawloptions

import (
	"net/url"
	"strconv"
	"time"
)

// Small JavaScript formatting helpers used by the validator messages. They live
// here so the validator reads like the decorators it mirrors.

func formatInt(value int) string { return strconv.Itoa(value) }

// formatFloat renders a number the way class-validator interpolates
// $constraint1 (JavaScript String(number)).
func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func urlParse(value string) (*url.URL, error) { return url.Parse(value) }

// utf16Length is JavaScript String.length.
func utf16Length(value string) int {
	length := 0
	for _, r := range value {
		if r > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

// parseLayout parses one explicit time layout, used by the ISO 8601 check for
// the offset variants JavaScript Date accepts.
func parseLayout(layout, value string) (time.Time, bool) {
	parsed, err := time.Parse(layout, value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

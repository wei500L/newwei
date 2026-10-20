package analysis

import (
	"regexp"
	"strconv"
	"strings"
)

var idTitleWordPattern = regexp.MustCompile(`\b\w`)

// formatIDTitle mirrors controller.formatIdTitle:
//
//	id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
//
// JavaScript's \w is ASCII-only, so non-ASCII letters never start a word here
// either.
func formatIDTitle(id string) string {
	spaced := strings.ReplaceAll(id, "-", " ")
	return idTitleWordPattern.ReplaceAllStringFunc(spaced, func(match string) string {
		return strings.ToUpper(match)
	})
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

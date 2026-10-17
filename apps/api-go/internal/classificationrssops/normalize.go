package classificationrssops

import (
	"regexp"
	"strings"
)

// truncateJS truncates a string the way JavaScript's String.prototype.slice
// does, counting UTF-16 code units. Slicing Go strings by bytes or runes would
// diverge for astral characters (emoji, rare CJK extensions).
func truncateJS(value string, maxUnits int) string {
	if maxUnits <= 0 {
		return ""
	}
	units := 0
	for index, char := range value {
		size := 1
		if char > 0xFFFF {
			size = 2
		}
		if units+size > maxUnits {
			return value[:index]
		}
		units += size
	}
	return value
}

// utf16Length counts the UTF-16 code units JavaScript would see.
func utf16Length(value string) int {
	units := 0
	for _, char := range value {
		if char > 0xFFFF {
			units += 2
			continue
		}
		units++
	}
	return units
}

// truncateJSUnits caps a string at maxUnits UTF-16 code units.
func truncateJSUnits(value string, maxUnits int) string {
	if utf16Length(value) <= maxUnits {
		return value
	}
	return truncateJS(value, maxUnits)
}

// normalizePath mirrors the private normalizePath helper: trim, lowercase,
// collapse repeated slashes, strip leading and trailing slashes, then cap at
// 160 UTF-16 units. An empty result becomes nil.
func normalizePath(value string) *string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = collapseSlashes(normalized)
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return nil
	}
	trimmed := truncateJSUnits(normalized, 160)
	return &trimmed
}

// normalizeText mirrors the private normalizeText helper.
func normalizeText(value string, maxLength int) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	result := truncateJSUnits(trimmed, maxLength)
	return &result
}

// normalizeQuickTags mirrors the private normalizeQuickTags helper: trim,
// lowercase, deduplicate, cap each tag at 60 units and the list at 20 entries.
func normalizeQuickTags(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, entry := range values {
		normalized := strings.ToLower(strings.TrimSpace(entry))
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		out = append(out, truncateJSUnits(normalized, 60))
		if len(out) >= 20 {
			break
		}
	}
	return out
}

// normalizeMethod mirrors the private normalizeMethod helper: a missing method
// is reported as the literal "unknown".
func normalizeMethod(value *string) string {
	if value == nil {
		return "unknown"
	}
	return *value
}

// toConfidenceBand mirrors the private toConfidenceBand helper.
func toConfidenceBand(value float64) ConfidenceBand {
	if value < 0.4 {
		return ConfidenceBandLow
	}
	if value < 0.75 {
		return ConfidenceBandMedium
	}
	return ConfidenceBandHigh
}

// extractCategoryPrefix mirrors the private extractCategoryPrefix helper: the
// first two non-empty path segments, or "unknown".
func extractCategoryPrefix(path *string) string {
	if path == nil {
		return "unknown"
	}
	parts := make([]string, 0, 4)
	for _, entry := range strings.Split(*path, "/") {
		trimmed := strings.TrimSpace(entry)
		if trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	if len(parts) == 0 {
		return "unknown"
	}
	limit := len(parts)
	if limit > 2 {
		limit = 2
	}
	return strings.Join(parts[:limit], "/")
}

// buildCategoryPrefixRegex mirrors the private buildCategoryPrefixRegex helper:
// the normalized prefix anchored at the start and followed by a slash or the
// end of the path. regexp.QuoteMeta is the Go equivalent of escapeRegExp.
func buildCategoryPrefixRegex(prefix string) string {
	return "^" + regexp.QuoteMeta(prefix) + "(?:/|$)"
}

// collapseSlashes mirrors value.replace(/\/+/g, "/").
func collapseSlashes(value string) string {
	if !strings.Contains(value, "//") {
		return value
	}
	var builder strings.Builder
	builder.Grow(len(value))
	previousSlash := false
	for _, char := range value {
		if char == '/' {
			if previousSlash {
				continue
			}
			previousSlash = true
		} else {
			previousSlash = false
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

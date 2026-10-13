package situationmonitors

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

const (
	maxManualMonitors      = 20
	maxKeywords            = 30
	maxApprovedTerms       = 36
	maxApprovedSuggestions = 24
	maxNameLen             = 64
	maxValueLen            = 128
	legacyMonitorsKey      = "ui:situation-monitor:monitors:v1"
	systemSyncName         = "Subscription Sync"
	systemSyncColor        = "#9254de"
	previewCandidateLimit  = 120
	previewSuggestionLimit = 6
)

var (
	colorPattern = regexp.MustCompile(`(?i)^#[0-9a-f]{3}$|^#[0-9a-f]{6}$`)
	spacePattern = regexp.MustCompile(`\s+`)
)

func normalizeDisplayValue(value string) string {
	value = strings.TrimSpace(value)
	value = spacePattern.ReplaceAllString(value, " ")
	return clipUTF16(value, maxValueLen)
}

func normalizeTerm(value string) string {
	return strings.ToLower(normalizeDisplayValue(value))
}

func normalizeName(value string) string {
	return clipUTF16(strings.TrimSpace(value), maxNameLen)
}

func clipUTF16(value string, limit int) string {
	encoded := utf16.Encode([]rune(value))
	if len(encoded) <= limit {
		return value
	}
	return string(utf16.Decode(encoded[:limit]))
}

func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func normalizeStringList(values []string, limit int) []string {
	out := make([]string, 0)
	seen := map[string]struct{}{}
	for _, entry := range values {
		displayValue := normalizeDisplayValue(entry)
		normalized := strings.ToLower(displayValue)
		if displayValue == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, displayValue)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func normalizeKeywordList(values []string) []string {
	split := make([]string, 0, len(values))
	for _, entry := range values {
		for _, part := range strings.Split(entry, ",") {
			split = append(split, part)
		}
	}
	return normalizeStringList(split, maxKeywords)
}

func normalizeColor(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	if !strings.HasPrefix(trimmed, "#") {
		trimmed = "#" + trimmed
	}
	if !colorPattern.MatchString(trimmed) {
		return "", false
	}
	return strings.ToLower(trimmed), true
}

func subscriptionKey(kind, normalized string) string {
	return kind + ":" + normalized
}

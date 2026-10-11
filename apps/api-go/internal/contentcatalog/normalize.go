package contentcatalog

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

var spaceRE = regexp.MustCompile(`\s+`)

func cleanDisplay(value string) string {
	value = strings.TrimSpace(value)
	value = spaceRE.ReplaceAllString(value, " ")
	return truncateRunes(value, 128)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func knownKind(kind string) bool {
	switch kind {
	case personalnews.KindTopic, personalnews.KindEntity, personalnews.KindSource, personalnews.KindKeyword, personalnews.KindGeo:
		return true
	default:
		return false
	}
}

func normalizeValue(value, kind string) (string, string) {
	if kind == personalnews.KindGeo {
		geo := canonicalizeGeoValue(value)
		return geo.Display, geo.Normalized
	}
	display := cleanDisplay(value)
	if display == "" {
		return "", ""
	}
	if kind == personalnews.KindSource {
		return display, display
	}
	return display, strings.ToLower(display)
}

func normalizeInput(entries []personalnews.EntryInput) []inputEntry {
	seen := map[string]struct{}{}
	out := make([]inputEntry, 0, len(entries))
	for _, entry := range entries {
		if !knownKind(entry.Kind) {
			continue
		}
		raw := entry.Value
		if strings.TrimSpace(raw) == "" {
			raw = entry.DisplayValue
		}
		if strings.TrimSpace(raw) == "" {
			raw = entry.NormalizedValue
		}
		display, normalized := normalizeValue(raw, entry.Kind)
		if normalized == "" {
			continue
		}
		key := subscriptionKey(entry.Kind, normalized)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, inputEntry{
			Kind:            entry.Kind,
			NormalizedValue: normalized,
			DisplayValue:    display,
			Source:          entry.Source,
		})
	}
	return out
}

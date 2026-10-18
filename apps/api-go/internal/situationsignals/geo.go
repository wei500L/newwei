package situationsignals

import (
	"regexp"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
)

// This file reproduces the two geo helpers
// apps/api/src/common/geo-subscription.ts exposes to the matcher:
// extractGeoCountryAlpha2 and canonicalizeGeoValue.
//
// The country tables themselves are already migrated and exported by
// internal/contentsubscriptions (NormalizeCountryAlpha2 / CountryEnglishName),
// so only the wrapper semantics live here. The one deliberate narrowing: the
// nested alias/name substring scan of the TypeScript
// extractCountryCodeFromText is replaced by an exact token lookup, which covers
// country names, alpha-2 and alpha-3 codes and the US/UK abbreviations. Names
// that only match as an embedded substring inside a longer token are not
// resolved.

// ambiguousRegionCodes mirrors AMBIGUOUS_REGION_CODES: region labels that must
// never be treated as a country.
var ambiguousRegionCodes = map[string]bool{
	"AP": true, "APAC": true, "EA": true, "EMEA": true, "EU": true, "GCC": true,
	"LA": true, "LATAM": true, "MEA": true, "MENA": true, "NA": true,
	"ROW": true, "SA": true, "SEA": true, "SSA": true, "WA": true, "WORLD": true,
}

var usUKPattern = regexp.MustCompile(`(?i)\bU\.?S\.?A?\.?\b|\bU\.?K\.?\b`)

// canonicalGeoValue is the projection canonicalizeGeoValue returns.
type canonicalGeoValue struct {
	NormalizedValue   string
	DisplayValue      string
	CountryCodeAlpha2 string
}

// normalizeGeoDisplayValue mirrors normalizeGeoDisplayValue.
func normalizeGeoDisplayValue(value string) string {
	collapsed := whitespaceRunPattern.ReplaceAllString(strings.TrimSpace(value), " ")
	return clipUTF16(collapsed, maxDisplayValueLen)
}

// extractGeoCountryAlpha2 mirrors extractGeoCountryAlpha2.
func extractGeoCountryAlpha2(value string) (string, bool) {
	display := normalizeGeoDisplayValue(value)
	if display == "" {
		return "", false
	}
	if ambiguousRegionCodes[strings.ToUpper(display)] {
		return "", false
	}
	if alpha2 := contentsubscriptions.NormalizeCountryAlpha2(display); alpha2 != "" {
		return alpha2, true
	}
	sanitized := usUKPattern.ReplaceAllStringFunc(display, func(match string) string {
		if strings.Contains(strings.ToUpper(match), "K") {
			return "UK"
		}
		return "USA"
	})
	if alpha2 := contentsubscriptions.NormalizeCountryAlpha2(sanitized); alpha2 != "" {
		return alpha2, true
	}
	for _, token := range strings.FieldsFunc(sanitized, isGeoTokenSeparator) {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		if utf16Len(token) <= 3 && token != strings.ToUpper(token) {
			continue
		}
		if alpha2 := contentsubscriptions.NormalizeCountryAlpha2(token); alpha2 != "" {
			return alpha2, true
		}
	}
	return "", false
}

// isGeoTokenSeparator mirrors isTokenSep in the country index.
func isGeoTokenSeparator(r rune) bool {
	switch r {
	case ' ', ',', ';', ':', '.', '(', ')', '/', '-', '\t', '\n', '\r':
		return true
	}
	return false
}

// canonicalizeGeoValue mirrors canonicalizeGeoValue.
func canonicalizeGeoValue(value string) canonicalGeoValue {
	display := normalizeGeoDisplayValue(value)
	if display == "" {
		return canonicalGeoValue{}
	}
	alpha2 := ""
	if !ambiguousRegionCodes[strings.ToUpper(display)] {
		alpha2 = contentsubscriptions.NormalizeCountryAlpha2(display)
	}
	if alpha2 == "" {
		return canonicalGeoValue{
			NormalizedValue: strings.ToLower(display),
			DisplayValue:    display,
		}
	}
	name := contentsubscriptions.CountryEnglishName(alpha2)
	if name == "" {
		name = display
	}
	return canonicalGeoValue{
		NormalizedValue:   strings.ToLower(alpha2),
		DisplayValue:      name,
		CountryCodeAlpha2: alpha2,
	}
}

// collectGeoHits mirrors collectGeoHits.
func collectGeoHits(expected []string, values []string) []string {
	structuredValues := make([]string, 0, len(values))
	for _, value := range values {
		if normalized := normalizeTerm(value); normalized != "" {
			structuredValues = append(structuredValues, normalized)
		}
	}
	structuredCountries := map[string]bool{}
	for _, value := range values {
		if alpha2, ok := extractGeoCountryAlpha2(value); ok {
			structuredCountries[alpha2] = true
		}
	}

	hits := make([]string, 0, lexicalHitLimit)
	for _, entry := range normalizeStringList(expected, maxApprovedTerms) {
		canonical := canonicalizeGeoValue(entry)
		matched := false
		if canonical.CountryCodeAlpha2 != "" && structuredCountries[canonical.CountryCodeAlpha2] {
			matched = true
		} else {
			display := canonical.DisplayValue
			if display == "" {
				display = canonical.NormalizedValue
			}
			normalized := normalizeTerm(display)
			if isShortAscii(normalized) {
				for _, value := range structuredValues {
					if value == normalized {
						matched = true
						break
					}
				}
			} else {
				for _, value := range structuredValues {
					if value == normalized || strings.Contains(value, normalized) {
						matched = true
						break
					}
				}
			}
		}
		if !matched {
			continue
		}
		hits = append(hits, entry)
		if len(hits) >= lexicalHitLimit {
			break
		}
	}
	return hits
}

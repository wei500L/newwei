// Country-code helpers ported from packages/utils/src/geo.ts.
//
// Only the two functions the domestic opinion index pipeline selector needs are
// ported: normalizeCountryCode and extractCountryCodeFromText. getCountryName
// and getCountryAlpha2 are intentionally left out, but alpha3ToName is still
// derived so the lookup tables match the NestJS module state one for one.
package newsnowclusteringops

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// geoOrderedCode is one entry of a lookup table whose iteration order is
// observable by callers. JavaScript Map keeps the first insertion slot when a
// key is assigned again, so the entry slices preserve that slot order while the
// companion maps keep the last assigned value.
type geoOrderedCode struct {
	Key  string
	Code string
}

var (
	// geoNonAlnumRe collapses a run of characters outside [a-z0-9] into a single
	// space, mirroring /[^a-z0-9]+/g after the lowercase step of normalizeKey.
	geoNonAlnumRe = regexp.MustCompile(`[^a-z0-9]+`)

	// geoLocaleStripRe removes the characters normalizeLocaleKey drops. The
	// whitespace alternatives are the JavaScript \s set spelled out, because Go's
	// regexp \s is ASCII only and \p{Zs} is avoided inside a bracket expression.
	geoLocaleStripRe = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}'"·•，、,;:.()（）\[\]{}<>《》“”‘’]`)

	// geoUSASpellingRe mirrors /\bU\.S\.A?\.?/gi.
	geoUSASpellingRe = regexp.MustCompile(`(?i)\bU\.S\.A?\.?`)

	// geoUKSpellingRe mirrors /\bU\.K\.?/gi.
	geoUKSpellingRe = regexp.MustCompile(`(?i)\bU\.K\.?`)

	// geoTokenSplitRe mirrors the token split /[\s,;:.()/-]+/ with the JavaScript
	// \s set spelled out, for the same reason as geoLocaleStripRe.
	geoTokenSplitRe = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff},;:.()/-]+`)

	// geoAlpha3Re mirrors /^[A-Z]{3}$/.
	geoAlpha3Re = regexp.MustCompile(`^[A-Z]{3}$`)

	// geoAlpha2Re mirrors /^[A-Z]{2}$/.
	geoAlpha2Re = regexp.MustCompile(`^[A-Z]{2}$`)
)

var (
	// geoAlpha2ToAlpha3 mirrors the ALPHA2_TO_ALPHA3 map.
	geoAlpha2ToAlpha3 map[string]string

	// geoAlpha3Set mirrors the ALPHA3_SET set.
	geoAlpha3Set map[string]struct{}

	// geoNameToAlpha3 mirrors NAME_TO_ALPHA3; geoNameOrder keeps the key slots
	// in first-insertion order so the "name appears in the text" scan stays
	// deterministic.
	geoNameToAlpha3 map[string]string
	geoNameOrder    []string

	// geoAlpha3ToName mirrors ALPHA3_TO_NAME. It is not consumed by the two
	// ported functions (getCountryName is out of scope) but keeps the derived
	// table identical to the NestJS module.
	geoAlpha3ToName map[string]string

	// geoAliasToAlpha3 mirrors ALIAS_TO_ALPHA3; geoAliasOrder keeps the alias
	// slots in first-insertion order for the alias scan.
	geoAliasToAlpha3 map[string]string
	geoAliasOrder    []string

	// geoLocaleToAlpha3 mirrors LOCALE_NAME_TO_ALPHA3 for the explicit locale
	// alias pairs.
	geoLocaleToAlpha3 map[string]string

	// geoLocaleMatchers mirrors LOCALE_MATCHERS: the locale aliases sorted by
	// descending label length with insertion order kept on ties.
	geoLocaleMatchers []geoOrderedCode
)

func init() {
	geoAlpha2ToAlpha3 = make(map[string]string, len(countryRecords))
	geoAlpha3Set = make(map[string]struct{}, len(countryRecords))
	geoNameToAlpha3 = make(map[string]string, len(countryRecords))
	geoAlpha3ToName = make(map[string]string, len(countryRecords))
	geoAliasToAlpha3 = make(map[string]string, len(countryAliasPairs))
	geoLocaleToAlpha3 = make(map[string]string, len(countryLocaleAliasPairs))

	// setOrdered reproduces Map.set: a repeated key keeps its first slot and
	// takes the latest value.
	setOrdered := func(order *[]string, table map[string]string, key, code string) {
		if _, exists := table[key]; !exists {
			*order = append(*order, key)
		}
		table[key] = code
	}

	for _, entry := range countryRecords {
		alpha2 := strings.ToUpper(entry.Alpha2)
		alpha3 := strings.ToUpper(entry.Alpha3)
		geoAlpha2ToAlpha3[alpha2] = alpha3
		geoAlpha3Set[alpha3] = struct{}{}
		setOrdered(&geoNameOrder, geoNameToAlpha3, normalizeKey(entry.Name), alpha3)
		geoAlpha3ToName[alpha3] = entry.Name
	}
	for _, pair := range countryAliasPairs {
		setOrdered(&geoAliasOrder, geoAliasToAlpha3, normalizeKey(pair[0]), pair[1])
	}

	localeOrder := make([]string, 0, len(countryLocaleAliasPairs))
	for _, pair := range countryLocaleAliasPairs {
		setOrdered(&localeOrder, geoLocaleToAlpha3, normalizeLocaleKey(pair[0]), pair[1])
	}
	geoLocaleMatchers = make([]geoOrderedCode, 0, len(localeOrder))
	for _, key := range localeOrder {
		geoLocaleMatchers = append(geoLocaleMatchers, geoOrderedCode{Key: key, Code: geoLocaleToAlpha3[key]})
	}
	// Array.prototype.sort is stable, so equal-length labels keep their
	// insertion order; the stable sort below preserves that.
	sort.SliceStable(geoLocaleMatchers, func(i, j int) bool {
		return utf8.RuneCountInString(geoLocaleMatchers[i].Key) > utf8.RuneCountInString(geoLocaleMatchers[j].Key)
	})
}

// normalizeKey mirrors normalizeKey in geo.ts: trim, NFD decomposition,
// combining-mark removal, lowercase, apostrophe and dot removal, ampersand
// expansion, then non-alphanumeric collapsing.
//
// The JS original strips exactly U+0300..U+036F, so this port removes that same
// range instead of every Unicode Mn mark: marks outside the range survive the
// decomposition and are then turned into a separator by geoNonAlnumRe, exactly
// as they are in JavaScript.
func normalizeKey(value string) string {
	decomposed := norm.NFD.String(strings.TrimSpace(value))
	var builder strings.Builder
	builder.Grow(len(decomposed))
	for _, r := range decomposed {
		if r >= 0x0300 && r <= 0x036f {
			continue
		}
		builder.WriteRune(r)
	}
	text := strings.ToLower(builder.String())
	text = strings.ReplaceAll(text, "'", "")
	text = strings.ReplaceAll(text, ".", "")
	text = strings.ReplaceAll(text, "&", "and")
	text = geoNonAlnumRe.ReplaceAllString(text, " ")
	// Only [a-z0-9] and spaces remain, so collapsing whitespace runs and
	// trimming is the same as the JS /\s+/g replacement followed by trim.
	return strings.Join(strings.Fields(text), " ")
}

// normalizeLocaleKey mirrors normalizeLocaleKey in geo.ts: trim, NFKC, strip
// the punctuation set, then lowercase.
//
// NFKC is kept even though it is a no-op for every CJK and Latin alias shipped
// in data_gen.go, because the JS original applies it before the strip and it
// matters for full-width input coming from article text.
func normalizeLocaleKey(value string) string {
	text := norm.NFKC.String(strings.TrimSpace(value))
	text = geoLocaleStripRe.ReplaceAllString(text, "")
	return strings.ToLower(text)
}

// normalizeCountryCode mirrors normalizeCountryCode in geo.ts. The JS function
// returns null; this port returns the empty string as the "no match" value so
// callers can use a plain string.
func normalizeCountryCode(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}

	upper := strings.ToUpper(trimmed)
	if geoAlpha3Re.MatchString(upper) {
		if _, ok := geoAlpha3Set[upper]; ok {
			return upper
		}
	}
	if geoAlpha2Re.MatchString(upper) {
		// A missing alpha-2 code yields "" here, which is the JS null.
		return geoAlpha2ToAlpha3[upper]
	}

	normalized := normalizeKey(trimmed)
	if code := geoAliasToAlpha3[normalized]; code != "" {
		return code
	}
	if code := geoNameToAlpha3[normalized]; code != "" {
		return code
	}
	return geoLocaleToAlpha3[normalizeLocaleKey(trimmed)]
}

// extractCountryCodeFromText mirrors extractCountryCodeFromText in geo.ts.
//
// Deliberate omission: the JS original also seeds LOCALE_NAME_TO_ALPHA3 with
// Intl.DisplayNames region names for zh-Hans, zh-Hant and zh. Those labels come
// from ICU data and cannot be reproduced here, so only the explicit
// countryLocaleAliasPairs entries take part in the locale scan. The regex
// rewrites, the direct normalization, the token scan and the alias/name scans
// are ported literally.
func extractCountryCodeFromText(text string) string {
	sanitized := geoUSASpellingRe.ReplaceAllString(text, "USA")
	sanitized = geoUKSpellingRe.ReplaceAllString(sanitized, "UK")

	if direct := normalizeCountryCode(sanitized); direct != "" {
		return direct
	}

	for _, rawToken := range geoTokenSplitRe.Split(sanitized, -1) {
		token := strings.TrimSpace(rawToken)
		if token == "" {
			continue
		}
		// JS measures token.length in UTF-16 code units. Rune count differs
		// only for astral characters, which never appear in the token tables.
		if utf8.RuneCountInString(token) <= 3 && token != strings.ToUpper(token) {
			continue
		}
		if code := normalizeCountryCode(token); code != "" {
			return code
		}
	}

	normalizedText := " " + normalizeKey(sanitized) + " "
	for _, alias := range geoAliasOrder {
		// The length guard mirrors the JS alias.length <= 3 skip; see the rune
		// count note above.
		if utf8.RuneCountInString(alias) <= 3 {
			continue
		}
		if strings.Contains(normalizedText, " "+alias+" ") {
			return geoAliasToAlpha3[alias]
		}
	}

	for _, name := range geoNameOrder {
		if strings.Contains(normalizedText, " "+name+" ") {
			return geoNameToAlpha3[name]
		}
	}

	localeText := normalizeLocaleKey(sanitized)
	if localeText == "" {
		return ""
	}
	for _, matcher := range geoLocaleMatchers {
		if utf8.RuneCountInString(matcher.Key) <= 1 {
			continue
		}
		if strings.Contains(localeText, matcher.Key) {
			return matcher.Code
		}
	}

	return ""
}

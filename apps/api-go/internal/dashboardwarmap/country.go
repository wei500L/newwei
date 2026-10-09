package dashboardwarmap

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/text/language"
	"golang.org/x/text/language/display"
	"golang.org/x/text/unicode/norm"
)

type country struct {
	name   string
	alpha2 string
	alpha3 string
}

type countryIndex struct {
	alpha3       map[string]struct{}
	alpha2To3    map[string]string
	alpha3To2    map[string]string
	alpha3ToName map[string]string
	nameTo3      map[string]string
	aliasTo3     map[string]string
	localeTo3    map[string]string
	aliasScan    []codeName
	nameScan     []codeName
	localeScan   []codeName
}

type codeName struct {
	label string
	code  string
}

var (
	countriesOnce sync.Once
	countries     *countryIndex
)

func countryCodes() *countryIndex {
	countriesOnce.Do(func() {
		countries = buildCountryIndex()
	})
	return countries
}

func buildCountryIndex() *countryIndex {
	idx := &countryIndex{
		alpha3:       map[string]struct{}{},
		alpha2To3:    map[string]string{},
		alpha3To2:    map[string]string{},
		alpha3ToName: map[string]string{},
		nameTo3:      map[string]string{},
		aliasTo3:     map[string]string{},
		localeTo3:    map[string]string{},
	}
	for _, entry := range countryData {
		addCountry(idx, entry.name, entry.alpha2, entry.alpha3)
	}
	addCountry(idx, "Kosovo", "XK", "XKX")
	for _, pair := range aliasEntries {
		label := normalizeKey(pair[0])
		idx.aliasTo3[label] = pair[1]
		idx.aliasScan = append(idx.aliasScan, codeName{label: label, code: pair[1]})
	}
	for _, pair := range localeAliasEntries {
		rememberLocale(idx, normalizeLocaleKey(pair[0]), pair[1])
	}
	for _, tag := range []language.Tag{language.SimplifiedChinese, language.TraditionalChinese, language.Chinese} {
		namer := display.Regions(tag)
		entries := append([]country{}, countryData...)
		entries = append(entries, country{name: "Kosovo", alpha2: "XK", alpha3: "XKX"})
		for _, entry := range entries {
			region, err := language.ParseRegion(entry.alpha2)
			if err != nil {
				continue
			}
			label := strings.TrimSpace(namer.Name(region))
			if label == "" || strings.EqualFold(label, entry.alpha2) {
				continue
			}
			rememberLocale(idx, normalizeLocaleKey(label), entry.alpha3)
		}
	}
	for _, entry := range countryData {
		idx.nameScan = append(idx.nameScan, codeName{label: normalizeKey(entry.name), code: strings.ToUpper(entry.alpha3)})
	}
	idx.nameScan = append(idx.nameScan, codeName{label: normalizeKey("Kosovo"), code: "XKX"})
	sort.SliceStable(idx.localeScan, func(i, j int) bool {
		return len([]rune(idx.localeScan[i].label)) > len([]rune(idx.localeScan[j].label))
	})
	return idx
}

func rememberLocale(idx *countryIndex, key, code string) {
	if key == "" {
		return
	}
	if _, exists := idx.localeTo3[key]; exists {
		return
	}
	idx.localeTo3[key] = code
	idx.localeScan = append(idx.localeScan, codeName{label: key, code: code})
}

func addCountry(idx *countryIndex, name, alpha2, alpha3 string) {
	alpha2 = strings.ToUpper(alpha2)
	alpha3 = strings.ToUpper(alpha3)
	idx.alpha2To3[alpha2] = alpha3
	idx.alpha3[alpha3] = struct{}{}
	idx.alpha3To2[alpha3] = alpha2
	idx.nameTo3[normalizeKey(name)] = alpha3
	idx.alpha3ToName[alpha3] = name
}

func normalizeCountryCode(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}
	upper := strings.ToUpper(trimmed)
	idx := countryCodes()
	if len(upper) == 3 {
		if _, ok := idx.alpha3[upper]; ok {
			return upper
		}
	}
	if len(upper) == 2 {
		if code, ok := idx.alpha2To3[upper]; ok {
			return code
		}
	}
	if code, ok := idx.aliasTo3[normalizeKey(trimmed)]; ok {
		return code
	}
	if code, ok := idx.nameTo3[normalizeKey(trimmed)]; ok {
		return code
	}
	if code, ok := idx.localeTo3[normalizeLocaleKey(trimmed)]; ok {
		return code
	}
	return ""
}

func extractCountryCodeFromText(text string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	sanitized := usUKPattern.ReplaceAllStringFunc(text, func(match string) string {
		if strings.Contains(strings.ToUpper(match), "K") {
			return "UK"
		}
		return "USA"
	})
	if code := normalizeCountryCode(sanitized); code != "" {
		return code
	}
	for _, token := range strings.FieldsFunc(sanitized, isTokenSep) {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		if len([]rune(token)) <= 3 && token != strings.ToUpper(token) {
			continue
		}
		if code := normalizeCountryCode(token); code != "" {
			return code
		}
	}
	normalizedText := " " + normalizeKey(sanitized) + " "
	idx := countryCodes()
	for _, alias := range idx.aliasScan {
		if len(alias.label) <= 3 {
			continue
		}
		if strings.Contains(normalizedText, " "+alias.label+" ") {
			return alias.code
		}
	}
	for _, name := range idx.nameScan {
		if name.label == "" {
			continue
		}
		if strings.Contains(normalizedText, " "+name.label+" ") {
			return name.code
		}
	}
	localeText := normalizeLocaleKey(sanitized)
	if localeText == "" {
		return ""
	}
	for _, matcher := range idx.localeScan {
		if len([]rune(matcher.label)) <= 1 {
			continue
		}
		if strings.Contains(localeText, matcher.label) {
			return matcher.code
		}
	}
	return ""
}

func countryName(code string) string {
	normalized := normalizeCountryCode(code)
	if normalized == "" {
		return ""
	}
	return countryCodes().alpha3ToName[normalized]
}

func countryAlpha2(code string) string {
	normalized := normalizeCountryCode(code)
	if normalized == "" {
		return ""
	}
	return countryCodes().alpha3To2[normalized]
}

func normalizeKey(value string) string {
	value = strings.TrimSpace(norm.NFD.String(value))
	var stripped strings.Builder
	for _, r := range value {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		stripped.WriteRune(r)
	}
	value = strings.ToLower(stripped.String())
	value = strings.NewReplacer("'", "", ".", "", "&", "and").Replace(value)
	var b strings.Builder
	space := false
	started := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			space = false
			started = true
			continue
		}
		if started && !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

func normalizeLocaleKey(value string) string {
	value = strings.TrimSpace(norm.NFKC.String(value))
	var b strings.Builder
	for _, r := range value {
		if strings.ContainsRune(" \t\r\n'\"·•，、,;:.()（）[]{}<>《》“”‘’", r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

func isTokenSep(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', ',', ';', ':', '.', '(', ')', '/', '-':
		return true
	default:
		return false
	}
}

var usUKPattern = regexp.MustCompile(`(?i)\bU\.S\.A?\.?|\bU\.K\.?`)

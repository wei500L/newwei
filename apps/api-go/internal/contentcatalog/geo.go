package contentcatalog

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/language"
	"golang.org/x/text/language/display"
	"golang.org/x/text/unicode/norm"
)

type geoValue struct {
	Normalized  string
	Display     string
	CountryCode string
}

var (
	nonAlnum    = regexp.MustCompile(`[^a-z0-9]+`)
	localeStrip = regexp.MustCompile(`[\s'"·•，、,;:.()（）\[\]{}<>《》“”‘’]+`)

	alpha2ToAlpha3 = map[string]string{}
	alpha3Set      = map[string]struct{}{}
	nameToAlpha3   = map[string]string{}
	alpha3ToName   = map[string]string{}
	alpha3ToAlpha2 = map[string]string{}
	aliasToAlpha3  = map[string]string{}
	localeToAlpha3 = map[string]string{}

	ambiguousRegions = map[string]struct{}{
		"AP": {}, "APAC": {}, "EA": {}, "EMEA": {}, "EU": {}, "GCC": {},
		"LA": {}, "LATAM": {}, "MEA": {}, "MENA": {}, "NA": {}, "ROW": {},
		"SA": {}, "SEA": {}, "SSA": {}, "WA": {}, "WORLD": {},
	}
)

type countryRow struct{ name, alpha2, alpha3 string }

func init() {
	var countries []countryRow
	for _, line := range strings.Split(countryTable, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) != 3 {
			continue
		}
		countries = append(countries, countryRow{name: parts[0], alpha2: parts[1], alpha3: parts[2]})
	}
	countries = append(countries, countryRow{name: "Kosovo", alpha2: "XK", alpha3: "XKX"})
	for _, entry := range countries {
		alpha2 := strings.ToUpper(entry.alpha2)
		alpha3 := strings.ToUpper(entry.alpha3)
		alpha2ToAlpha3[alpha2] = alpha3
		alpha3Set[alpha3] = struct{}{}
		alpha3ToAlpha2[alpha3] = alpha2
		nameToAlpha3[normalizeKey(entry.name)] = alpha3
		alpha3ToName[alpha3] = entry.name
	}
	for _, pair := range [][2]string{
		{"America", "USA"}, {"Bolivia", "BOL"}, {"Bosnia", "BIH"}, {"Burma", "MMR"},
		{"Cabo Verde", "CPV"}, {"Cape Verde", "CPV"}, {"Czech Republic", "CZE"}, {"Czechia", "CZE"},
		{"DRC", "COD"}, {"Democratic Republic of the Congo", "COD"}, {"Congo-Kinshasa", "COD"},
		{"Republic of the Congo", "COG"}, {"Congo-Brazzaville", "COG"}, {"Eswatini", "SWZ"},
		{"Iran", "IRN"}, {"Ivory Coast", "CIV"}, {"Korea", "KOR"}, {"Laos", "LAO"},
		{"Macedonia", "MKD"}, {"North Macedonia", "MKD"}, {"North Korea", "PRK"},
		{"Palestine", "PSE"}, {"Russia", "RUS"}, {"South Korea", "KOR"}, {"Syria", "SYR"},
		{"Tanzania", "TZA"}, {"Turkey", "TUR"}, {"UK", "GBR"}, {"U.K.", "GBR"}, {"UAE", "ARE"},
		{"United Kingdom", "GBR"}, {"United Arab Emirates", "ARE"}, {"United States", "USA"},
		{"United States of America", "USA"}, {"US", "USA"}, {"USA", "USA"}, {"U.S.", "USA"},
		{"East Timor", "TLS"}, {"Viet Nam", "VNM"}, {"Venezuela", "VEN"}, {"Vietnam", "VNM"},
	} {
		aliasToAlpha3[normalizeKey(pair[0])] = pair[1]
	}
	for _, pair := range [][2]string{
		{"中国", "CHN"}, {"中國", "CHN"}, {"中国台湾", "TWN"}, {"中国台灣", "TWN"},
		{"中國台湾", "TWN"}, {"中國台灣", "TWN"}, {"中國臺灣", "TWN"}, {"中国台北", "TWN"},
		{"中國台北", "TWN"}, {"中國臺北", "TWN"}, {"台湾", "TWN"}, {"台灣", "TWN"},
		{"美国", "USA"}, {"美國", "USA"}, {"英国", "GBR"}, {"英國", "GBR"},
		{"俄罗斯", "RUS"}, {"俄羅斯", "RUS"}, {"乌克兰", "UKR"}, {"烏克蘭", "UKR"},
		{"日本", "JPN"}, {"韩国", "KOR"}, {"韓國", "KOR"}, {"朝鲜", "PRK"}, {"朝鮮", "PRK"},
		{"以色列", "ISR"}, {"巴勒斯坦", "PSE"}, {"伊朗", "IRN"}, {"土耳其", "TUR"},
		{"叙利亚", "SYR"}, {"敘利亞", "SYR"}, {"中华人民共和国", "CHN"}, {"中華人民共和國", "CHN"},
		{"东帝汶", "TLS"}, {"東帝汶", "TLS"},
	} {
		localeToAlpha3[normalizeLocaleKey(pair[0])] = pair[1]
	}
	for _, tag := range []language.Tag{
		language.MustParse("zh-Hans"),
		language.MustParse("zh-Hant"),
		language.Chinese,
	} {
		addLocaleDisplayNames(tag, countries)
	}
}

func addLocaleDisplayNames(tag language.Tag, countries []countryRow) {
	namer := display.Regions(tag)
	for _, entry := range countries {
		region, err := language.ParseRegion(strings.ToUpper(entry.alpha2))
		if err != nil {
			continue
		}
		name := strings.TrimSpace(namer.Name(region))
		if name == "" || strings.EqualFold(name, entry.alpha2) {
			continue
		}
		key := normalizeLocaleKey(name)
		if key == "" {
			continue
		}
		if _, exists := localeToAlpha3[key]; exists {
			continue
		}
		localeToAlpha3[key] = strings.ToUpper(entry.alpha3)
	}
}

func normalizeKey(value string) string {
	decomposed := norm.NFD.String(strings.TrimSpace(value))
	var builder strings.Builder
	for _, r := range decomposed {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		builder.WriteRune(r)
	}
	text := strings.ToLower(builder.String())
	text = strings.ReplaceAll(text, "'", "")
	text = strings.ReplaceAll(text, ".", "")
	text = strings.ReplaceAll(text, "&", "and")
	text = nonAlnum.ReplaceAllString(text, " ")
	return strings.Join(strings.Fields(text), " ")
}

func normalizeLocaleKey(value string) string {
	text := norm.NFKC.String(strings.TrimSpace(value))
	text = localeStrip.ReplaceAllString(text, "")
	return strings.ToLower(text)
}

func normalizeCountryCode(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}
	upper := strings.ToUpper(trimmed)
	if len(upper) == 3 && isASCIIAlpha(upper) {
		if _, ok := alpha3Set[upper]; ok {
			return upper
		}
	}
	if len(upper) == 2 && isASCIIAlpha(upper) {
		return alpha2ToAlpha3[upper]
	}
	if code := aliasToAlpha3[normalizeKey(trimmed)]; code != "" {
		return code
	}
	if code := nameToAlpha3[normalizeKey(trimmed)]; code != "" {
		return code
	}
	return localeToAlpha3[normalizeLocaleKey(trimmed)]
}

func isASCIIAlpha(value string) bool {
	for _, r := range value {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func canonicalizeGeoValue(value string) geoValue {
	display := cleanDisplay(value)
	if display == "" {
		return geoValue{}
	}
	if _, ambiguous := ambiguousRegions[strings.ToUpper(display)]; ambiguous {
		return geoValue{Normalized: strings.ToLower(display), Display: display}
	}
	code := normalizeCountryCode(display)
	alpha2 := alpha3ToAlpha2[code]
	if code == "" || alpha2 == "" {
		return geoValue{Normalized: strings.ToLower(display), Display: display}
	}
	name := alpha3ToName[code]
	if name == "" {
		name = display
	}
	return geoValue{Normalized: strings.ToLower(alpha2), Display: name, CountryCode: alpha2}
}

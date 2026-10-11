package userdigest

import (
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// ambiguousRegions 与 apps/api/src/common/geo-subscription.ts 的集合一致。
// canonicalizeGeoValue 碰到这些代码时不解析成国家；geoCountryVariants 里的
// normalizeCountryCode 调用不受这个集合影响（Nest 就是这样分开的）。
var ambiguousRegions = map[string]struct{}{
	"AP": {}, "APAC": {}, "EA": {}, "EMEA": {}, "EU": {}, "GCC": {},
	"LA": {}, "LATAM": {}, "MEA": {}, "MENA": {}, "NA": {}, "ROW": {},
	"SA": {}, "SEA": {}, "SSA": {}, "WA": {}, "WORLD": {},
}

type geoCanon struct {
	normalized string
	display    string
	alpha2     string
}

func canonicalizeGeo(value string) geoCanon {
	display := normalizeGeoDisplay(value)
	if display == "" {
		return geoCanon{}
	}
	upper := strings.ToUpper(display)
	if _, ambiguous := ambiguousRegions[upper]; ambiguous {
		return geoCanon{normalized: strings.ToLower(display), display: display}
	}
	alpha3 := dashboardwarmap.CanonicalCountry(display)
	if alpha3 == "" {
		return geoCanon{normalized: strings.ToLower(display), display: display}
	}
	alpha2 := dashboardwarmap.CountryAlpha2(alpha3)
	if alpha2 == "" {
		return geoCanon{normalized: strings.ToLower(display), display: display}
	}
	name := countryNames[alpha3]
	if name == "" {
		name = display
	}
	return geoCanon{normalized: strings.ToLower(alpha2), display: name, alpha2: alpha2}
}

func normalizeGeoDisplay(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return jsSlice(strings.Join(strings.Fields(value), " "), 128)
}

func normalizeTerm(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return jsSlice(strings.ToLower(strings.Join(strings.Fields(value), " ")), 128)
}

func geoCountryVariants(code string) []string {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	if normalized == "" {
		return nil
	}
	canonical := canonicalizeGeo(normalized)
	// Nest 这里无条件调用 normalizeCountryCode，歧义地区码仍可能得到 alpha-3。
	alpha3 := dashboardwarmap.CanonicalCountry(normalized)
	return dedupeKeep(nonEmptyStrings(normalized, alpha3, canonical.alpha2, canonical.display))
}

func keywordFilter(keyword string) bson.D {
	trimmed := strings.TrimSpace(keyword)
	if trimmed == "" {
		return nil
	}
	pattern := bson.D{
		{Key: "$regex", Value: escapeRegExp(trimmed)},
		{Key: "$options", Value: "i"},
	}
	fields := []string{
		"result.title",
		"result.headline",
		"result.title_zh",
		"result.titleZh",
		"result.summary",
		"result.abstract",
		"result.subtitle",
		"result.topics",
		"result.entities",
		"result.entities.name",
		"result.keyPoints",
	}
	or := make(bson.A, 0, len(fields))
	for _, field := range fields {
		or = append(or, bson.D{{Key: field, Value: pattern}})
	}
	return bson.D{{Key: "$or", Value: or}}
}

func geoFilter(display, normalized, countryCode string) bson.D {
	canonical := canonicalizeGeo(firstText(display, normalized))
	phrase := normalizeTerm(firstText(canonical.display, canonical.normalized))
	expected := strings.TrimSpace(countryCode)
	if expected == "" {
		expected = canonical.alpha2
	}
	fields := []string{"result.location", "result.region", "result.country", "result.area"}
	or := make(bson.A, 0, 16)
	if phrase != "" {
		or = append(or, phraseMatchers(fields, `(^|[^a-z0-9])`+escapeRegExp(phrase)+`([^a-z0-9]|$)`)...)
	}
	for _, variant := range geoCountryVariants(expected) {
		or = append(or, phraseMatchers(fields, `(^|[^a-z0-9])`+escapeRegExp(variant)+`([^a-z0-9]|$)`)...)
	}
	if len(or) == 0 {
		return nil
	}
	return bson.D{{Key: "$or", Value: or}}
}

func phraseMatchers(fields []string, pattern string) bson.A {
	regex := bson.D{{Key: "$regex", Value: pattern}, {Key: "$options", Value: "i"}}
	out := make(bson.A, 0, len(fields))
	for _, field := range fields {
		out = append(out, bson.D{{Key: field, Value: regex}})
	}
	return out
}

func firstText(left, right string) string {
	if strings.TrimSpace(left) != "" {
		return left
	}
	return right
}

func escapeRegExp(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch r {
		case '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

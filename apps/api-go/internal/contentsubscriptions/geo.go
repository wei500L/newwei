package contentsubscriptions

// canonicalizeGeoValue 对齐 apps/api/src/common/geo-subscription.ts。
// 歧义区域码（EU、LATAM 等）保持原文小写，不进国家表。
// 本文件不发 HTTP，也不调用地理编码。

var ambiguousRegionCodes = map[string]struct{}{
	"AP": {}, "APAC": {}, "EA": {}, "EMEA": {}, "EU": {}, "GCC": {},
	"LA": {}, "LATAM": {}, "MEA": {}, "MENA": {}, "NA": {}, "ROW": {},
	"SA": {}, "SEA": {}, "SSA": {}, "WA": {}, "WORLD": {},
}

type canonicalGeo struct {
	NormalizedValue   string
	DisplayValue      string
	CountryCodeAlpha2 string
}

// NormalizeCountryAlpha2 把国家名、alpha2 或 alpha3 收成 alpha2。无法识别时为空。
func NormalizeCountryAlpha2(value string) string {
	alpha3 := normalizeCountryCode(value)
	if alpha3 == "" {
		return ""
	}
	return countryAlpha2(alpha3)
}

// CountryEnglishName 返回国家英文名。无法识别时为空。
func CountryEnglishName(code string) string {
	return countryName(code)
}

func canonicalizeGeoValue(value string) canonicalGeo {
	displayValue := normalizeDisplayValue(value)
	if displayValue == "" {
		return canonicalGeo{}
	}
	upper := stringsToUpper(displayValue)
	if _, ambiguous := ambiguousRegionCodes[upper]; ambiguous {
		return canonicalGeo{
			NormalizedValue: stringsToLower(displayValue),
			DisplayValue:    displayValue,
		}
	}
	alpha3 := normalizeCountryCode(displayValue)
	alpha2 := ""
	if alpha3 != "" {
		alpha2 = countryAlpha2(alpha3)
	}
	if alpha2 == "" {
		return canonicalGeo{
			NormalizedValue: stringsToLower(displayValue),
			DisplayValue:    displayValue,
		}
	}
	name := countryName(alpha2)
	if name == "" {
		name = displayValue
	}
	return canonicalGeo{
		NormalizedValue:   stringsToLower(alpha2),
		DisplayValue:      name,
		CountryCodeAlpha2: alpha2,
	}
}

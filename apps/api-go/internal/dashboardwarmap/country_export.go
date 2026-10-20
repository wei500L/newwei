package dashboardwarmap

// Exported aliases of the country normalisation port. The alert worker
// (internal/alertworker) needs the same normalizeCountryCode / getCountryName
// semantics as @modular/utils/geo.ts when it normalises an alert event context,
// and this package already carries the table-compatible port. Exposing two thin
// wrappers is cheaper and safer than a second copy of the table.
//
// An empty result means "not a country", which is the null the NestJS helpers
// return.

// NormalizeCountryCode returns the ISO alpha-3 code of input, or "" when input
// is not a recognised country code, name, alias or locale name.
func NormalizeCountryCode(input string) string {
	return normalizeCountryCode(input)
}

// CountryName returns the English country name of an alpha-3 code, or "".
func CountryName(code string) string {
	return countryName(code)
}

package legacyproxy

import "net/http"

// GeocodingKey is the handler registration key for the two geocoding routes.
// They share one handler because they share the cache, rate limit and Nominatim
// client; only the permission differs.
const GeocodingKey = "/api/geo#geocoding"

// WithGeocoding takes over exactly two routes when mode is go:
//
//	POST /api/geo/geocode
//	POST /api/system-settings/geo/nominatim/test
//
// Both are longer than the legacy /api/ rule and than the data runtime settings
// GET/PUT rule for /api/system-settings/geo/nominatim, so the exact match wins
// regardless of registration order. Other methods, the trailing-slash forms and
// longer paths keep falling back to NestJS.
func WithGeocoding(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	rules = appendExactKeyed(rules, GeocodingKey, "/api/geo/geocode", http.MethodPost)
	return appendExactKeyed(rules, GeocodingKey, "/api/system-settings/geo/nominatim/test", http.MethodPost)
}

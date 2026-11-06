package httproute

import "net/http"

// GeocodingKey is the handler registration key for the two geocoding routes.
// They share one handler because they share the cache, rate limit and Nominatim
// client; only the permission differs.
const GeocodingKey = "/api/geo#geocoding"

// WithGeocoding registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/geo/geocode
//	POST /api/system-settings/geo/nominatim/test
func WithGeocoding(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, GeocodingKey, "/api/geo/geocode", http.MethodPost)
	return appendExactKeyed(rules, GeocodingKey, "/api/system-settings/geo/nominatim/test", http.MethodPost)
}

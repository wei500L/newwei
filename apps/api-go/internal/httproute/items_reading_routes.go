package httproute

import "net/http"

// ItemsReadingKey is the handler registration key for the two migrated item
// reading REST routes.
const ItemsReadingKey = "/api/items"

// WithItemsReading registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET /api/items      (exact)
//	GET /api/items/:id  (exactly one path segment)
func WithItemsReading(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, ItemsReadingKey, "/api/items", http.MethodGet)
	return appendSegmentRule(rules, ItemsReadingKey, "/api/items/", true, false, "", http.MethodGet)
}

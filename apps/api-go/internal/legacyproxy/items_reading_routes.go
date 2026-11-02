package legacyproxy

import "net/http"

// ItemsReadingKey is the handler registration key for the two migrated item
// reading REST routes.
const ItemsReadingKey = "/api/items"

// WithItemsReading takes over the two exact item reading GET routes when mode is
// go:
//
//	GET /api/items      (exact)
//	GET /api/items/:id  (exactly one path segment)
//
// Only GET (and the matching CORS preflight) reaches Go. POST /api/items, any
// other method and any deeper path fall through to the shorter /api/ rule and
// stay on NestJS, so the un-migrated methods are never answered with a Go 405.
// The five migrated GraphQL roots are decided by API_GO_GRAPHQL_READ_MODE and
// API_GO_ITEMS_READING_MODE inside the /graphql executor, not by this table.
func WithItemsReading(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, ItemsReadingKey, "/api/items", http.MethodGet)
	return appendSegmentRule(rules, ItemsReadingKey, "/api/items/", true, false, "", http.MethodGet)
}

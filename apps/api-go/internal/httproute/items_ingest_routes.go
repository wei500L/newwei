package httproute

import "net/http"

// ItemsIngestKey is the handler registration key for POST /api/items. It is the
// same key as the items reading routes; a process with both switches go
// registers one dispatcher that sends GET to itemsreading and POST to
// itemsingest.
const ItemsIngestKey = "/api/items"

// WithItemsIngest registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
func WithItemsIngest(rules []Rule) []Rule {
	return appendExactKeyed(rules, ItemsIngestKey, "/api/items", http.MethodPost)
}

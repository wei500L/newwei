package legacyproxy

import "net/http"

// ItemsIngestKey is the handler registration key for POST /api/items. It is the
// same key as the items reading routes; a process with both switches go
// registers one dispatcher that sends GET to itemsreading and POST to
// itemsingest.
const ItemsIngestKey = "/api/items"

// WithItemsIngest takes over exactly POST /api/items when mode is go. GET,
// OPTIONS and longer paths are controlled by WithItemsReading or stay on
// NestJS.
func WithItemsIngest(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactKeyed(rules, ItemsIngestKey, "/api/items", http.MethodPost)
}

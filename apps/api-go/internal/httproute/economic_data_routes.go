package httproute

import "net/http"

// EconomicDataKey is the handler registration key for the three AkShare gateway
// admin routes. The path itself is static, so no dynamic segment is involved.
const EconomicDataKey = "/api/admin/akshare"

// WithEconomicData registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/admin/akshare/version
//	GET  /api/admin/akshare/status
//	POST /api/admin/akshare/upgrade
func WithEconomicData(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, EconomicDataKey, "/api/admin/akshare/version", http.MethodGet)
	rules = appendExactKeyed(rules, EconomicDataKey, "/api/admin/akshare/status", http.MethodGet)
	return appendExactKeyed(rules, EconomicDataKey, "/api/admin/akshare/upgrade", http.MethodPost)
}

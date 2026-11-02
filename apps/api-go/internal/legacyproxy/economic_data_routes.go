package legacyproxy

import "net/http"

// EconomicDataKey is the handler registration key for the three AkShare gateway
// admin routes. The path itself is static, so no dynamic segment is involved.
const EconomicDataKey = "/api/admin/akshare"

// WithEconomicData takes over exactly these three paths when mode is go:
//
//	GET  /api/admin/akshare/version
//	GET  /api/admin/akshare/status
//	POST /api/admin/akshare/upgrade
//
// The GraphQL mutations share API_GO_ECONOMIC_DATA_MODE but are routed through
// the /graphql handler, not through this rule set. Every other method, trailing
// slash and similar path falls back to NestJS.
func WithEconomicData(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, EconomicDataKey, "/api/admin/akshare/version", http.MethodGet)
	rules = appendExactKeyed(rules, EconomicDataKey, "/api/admin/akshare/status", http.MethodGet)
	return appendExactKeyed(rules, EconomicDataKey, "/api/admin/akshare/upgrade", http.MethodPost)
}

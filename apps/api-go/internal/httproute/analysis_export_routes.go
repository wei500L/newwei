package httproute

import "net/http"

// The exact handler registration keys of the two analysis CSV export routes.
const (
	AnalysisExportItemsKey  = "/api/analysis/exports/items"
	AnalysisExportEventsKey = "/api/analysis/exports/events"
)

// WithAnalysisExport registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/analysis/exports/items
//	POST /api/analysis/exports/events
func WithAnalysisExport(rules []Rule) []Rule {
	methods := map[string]bool{http.MethodPost: true, http.MethodOptions: true}
	return append(rules,
		Rule{Prefix: AnalysisExportItemsKey, Exact: true, HandlerKey: AnalysisExportItemsKey, Methods: methods},
		Rule{Prefix: AnalysisExportEventsKey, Exact: true, HandlerKey: AnalysisExportEventsKey, Methods: methods},
	)
}

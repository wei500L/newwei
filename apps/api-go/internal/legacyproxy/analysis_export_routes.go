package legacyproxy

import "net/http"

// The exact handler registration keys of the two analysis CSV export routes.
const (
	AnalysisExportItemsKey  = "/api/analysis/exports/items"
	AnalysisExportEventsKey = "/api/analysis/exports/events"
)

// WithAnalysisExport takes over the two exact POST CSV export routes when mode
// is go:
//
//	POST /api/analysis/exports/items
//	POST /api/analysis/exports/events
//
// Only POST and the matching CORS preflight reach Go. POST
// /api/analysis/exports/search, every other method and every deeper path fall
// through to the shorter /api/ rule and stay on NestJS, so the
// archive-preparing search export and the un-migrated methods are never
// answered by a partial Go handler.
func WithAnalysisExport(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	methods := map[string]bool{http.MethodPost: true, http.MethodOptions: true}
	return append(rules,
		Rule{Prefix: AnalysisExportItemsKey, Mode: ModeGo, Exact: true, HandlerKey: AnalysisExportItemsKey, Methods: methods},
		Rule{Prefix: AnalysisExportEventsKey, Mode: ModeGo, Exact: true, HandlerKey: AnalysisExportEventsKey, Methods: methods},
	)
}

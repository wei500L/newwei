package legacyproxy

import "net/http"

// ClassificationReportsKey is the handler registration key for the report
// creation endpoint. It is a separate key from ClassificationRssOpsKey so the
// report queue switch (API_GO_CLASSIFICATION_REPORTS_MODE) stays independent of
// the classification quality read switch (API_GO_CLASSIFICATION_RSS_OPS_MODE).
const ClassificationReportsKey = "/api/admin/quality/classification/reports"

// WithClassificationReports registers exactly one route when mode is go:
//
//	POST /api/admin/quality/classification/reports
//
// The existing 13 classification rules are untouched. The GET
// /reports/:jobId rule owned by WithClassificationRssOps keeps its own switch:
// with reports=go and rss-ops=legacy, a POST is served by Go while the GET of the
// job it created keeps proxying to NestJS (and NestJS reads the same Mongo
// documents, so the report is visible either way).
//
// The rule claims POST plus the CORS preflight OPTIONS on the same exact path
// (appendExactKeyed does that for every migrated exact route). Every other
// method falls back to NestJS, so the request never sees a Go 404.
// Default (empty or legacy) appends nothing.
func WithClassificationReports(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactKeyed(rules, ClassificationReportsKey,
		"/api/admin/quality/classification/reports", http.MethodPost)
}

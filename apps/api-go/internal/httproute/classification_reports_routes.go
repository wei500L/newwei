package httproute

import "net/http"

// ClassificationReportsKey is the handler registration key for the report
// creation endpoint. It is a separate key from ClassificationRssOpsKey so the
// report queue switch (API_GO_CLASSIFICATION_REPORTS_MODE) stays independent of
// the classification quality read switch (API_GO_CLASSIFICATION_RSS_OPS_MODE).
const ClassificationReportsKey = "/api/admin/quality/classification/reports"

// WithClassificationReports registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/admin/quality/classification/reports
func WithClassificationReports(rules []Rule) []Rule {
	return appendExactKeyed(rules, ClassificationReportsKey,
		"/api/admin/quality/classification/reports", http.MethodPost)
}

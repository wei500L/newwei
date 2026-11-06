package httproute

import "net/http"

// NewsnowClusteringOpsKey is the handler registration key for the nine NewsNow
// local-computation and news-event clustering failure endpoints. The key is a
// stable static path; per-request paths are derived from the request itself so
// that one handler serves both the NewsNow and the clustering groups.
const NewsnowClusteringOpsKey = "/api/news-aggregator/metadata"

// WithNewsnowClusteringOps registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/news-aggregator/metadata                        (public)
//	GET  /api/news-aggregator/resolve                         (public)
//	POST /api/news-aggregator/sources/order                   (items.read)
//	GET  /api/news-aggregator/domestic-opinion-index          (items.read)
//	GET  /api/system-settings/news-events/clustering/readiness
//	GET  /api/system-settings/news-events/clustering/overview
//	GET  /api/system-settings/news-events/clustering/failures
//	POST /api/system-settings/news-events/clustering/failures/:groupId/vector-backfill
//	POST /api/system-settings/news-events/clustering/failures/:groupId/ignore
//
// GET /api/news-aggregator/hottest-analysis and GET /api/news-aggregator/recommended
func WithNewsnowClusteringOps(rules []Rule) []Rule {
	// NewsNow local computation: metadata, URL reverse lookup, personalized
	// source ordering and the domestic opinion index. None of them fetch an
	// external source, so all four can be served by Go.
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, "/api/news-aggregator/metadata", http.MethodGet)
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, "/api/news-aggregator/resolve", http.MethodGet)
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, "/api/news-aggregator/sources/order", http.MethodPost)
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, "/api/news-aggregator/domestic-opinion-index", http.MethodGet)

	// News-event clustering failure administration. The three GETs are exact;
	// vector-backfill and ignore carry one dynamic :groupId segment.
	clusterBase := "/api/system-settings/news-events/clustering"
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, clusterBase+"/failures", http.MethodGet)
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, clusterBase+"/overview", http.MethodGet)
	rules = appendExactKeyed(rules, NewsnowClusteringOpsKey, clusterBase+"/readiness", http.MethodGet)
	rules = appendSegmentRule(rules, NewsnowClusteringOpsKey, clusterBase+"/failures/", true, false, "/vector-backfill", http.MethodPost)
	return appendSegmentRule(rules, NewsnowClusteringOpsKey, clusterBase+"/failures/", true, false, "/ignore", http.MethodPost)
}

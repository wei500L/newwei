package legacyproxy

import "net/http"

// NewsnowClusteringOpsKey is the handler registration key for the nine NewsNow
// local-computation and news-event clustering failure endpoints. The key is a
// stable static path; per-request paths are derived from the request itself so
// that one handler serves both the NewsNow and the clustering groups.
const NewsnowClusteringOpsKey = "/api/news-aggregator/metadata"

// WithNewsnowClusteringOps registers, only when mode is go, exactly nine routes:
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
// Every rule is a method whitelist plus either an exact path or a single
// dynamic segment with a fixed tail, so OPTIONS preflight reaches the Go
// handler while anything else falls back to NestJS. In particular the four
// NewsNow endpoints that fetch external sources stay on NestJS under this
// switch (GET /api/news-aggregator/source, POST /api/news-aggregator/sources/batch,
// GET /api/news-aggregator/hottest-analysis, GET /api/news-aggregator/recommended);
// the first two belong to WithNewsnowSources only when its own independent
// switch is go,
// as does POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill,
// which enqueues a BullMQ job. Longer paths, sibling paths such as
// /api/news-aggregator/sources, and every unlisted method also stay on NestJS;
// Go never answers with its own 404. The default (empty or legacy) appends no
// rule at all.
func WithNewsnowClusteringOps(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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

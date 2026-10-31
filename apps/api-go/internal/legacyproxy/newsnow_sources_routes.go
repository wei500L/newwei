package legacyproxy

import "net/http"

// NewsnowSourcesKey is the handler registration key for the two public NewsNow
// source fetch routes. Both rules share the key because they are served by the
// same handler.
const NewsnowSourcesKey = "/api/news-aggregator/source"

// WithNewsnowSources registers, only when mode is go, exactly two routes:
//
//	GET  /api/news-aggregator/source
//	POST /api/news-aggregator/sources/batch
//
// Every other NewsNow path keeps its current owner: metadata/resolve/order,
// domestic-opinion-index and clustering stay on WithNewsnowClusteringOps,
// hottest-analysis and recommended belong to WithNewsnowHottest (their own
// independent switch; NestJS while it is legacy), and unknown methods or longer
// paths fall through to the legacy proxy. The default (empty or legacy) appends
// no rule at all, so rollback is a single variable change.
func WithNewsnowSources(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, NewsnowSourcesKey, "/api/news-aggregator/source", http.MethodGet)
	return appendExactKeyed(rules, NewsnowSourcesKey, "/api/news-aggregator/sources/batch", http.MethodPost)
}

package httproute

import "net/http"

// NewsnowHottestKey is the handler registration key for the two authenticated
// NewsNow reading routes. Both rules share the key because one handler serves
// them.
const NewsnowHottestKey = "/api/news-aggregator/hottest-analysis"

// WithNewsnowHottest appends exactly two routes: GET
// /api/news-aggregator/hottest-analysis and GET /api/news-aggregator/recommended.
// Both are exact paths with a GET (+ OPTIONS) method whitelist. Their prefixes are
// longer than the source and clustering-ops prefixes, so the longest-prefix match
// never lets a sibling path reach this handler.
func WithNewsnowHottest(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, NewsnowHottestKey, "/api/news-aggregator/hottest-analysis", http.MethodGet)
	return appendExactKeyed(rules, NewsnowHottestKey, "/api/news-aggregator/recommended", http.MethodGet)
}

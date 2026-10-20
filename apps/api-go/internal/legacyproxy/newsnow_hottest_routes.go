package legacyproxy

import "net/http"

// NewsnowHottestKey is the handler registration key for the two authenticated
// NewsNow reading routes. Both rules share the key because one handler serves
// them.
const NewsnowHottestKey = "/api/news-aggregator/hottest-analysis"

// WithNewsnowHottest registers, only when mode is go, exactly two routes:
//
//	GET /api/news-aggregator/hottest-analysis
//	GET /api/news-aggregator/recommended
//
// Both are exact paths with a GET (+ OPTIONS) method whitelist, so a sibling
// path such as /api/news-aggregator/hottest-analysis/export, an unknown method or
// the two public source routes never reach this handler. The rule prefixes are
// longer than the source and clustering-ops prefixes, so the longest-prefix match
// in the gateway cannot shadow them in either direction. The default (empty or
// legacy) appends no rule at all, so rollback is a single variable change.
func WithNewsnowHottest(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	rules = appendExactKeyed(rules, NewsnowHottestKey, "/api/news-aggregator/hottest-analysis", http.MethodGet)
	return appendExactKeyed(rules, NewsnowHottestKey, "/api/news-aggregator/recommended", http.MethodGet)
}

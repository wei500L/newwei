package legacyproxy

import "net/http"

// NewsClusteringLlmBackfillKey is the handler registration key for the manual
// news-event clustering LLM backfill route. The route has one dynamic segment,
// so the key is a stable static path that never collides with a real request
// path.
const NewsClusteringLlmBackfillKey = "/api/system-settings/news-events/clustering/failures/llm-backfill"

// WithNewsClusteringLlmBackfill registers exactly one route when mode is go:
//
//	POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill
//
// It is deliberately separate from WithNewsnowClusteringOps: the nine-route
// clustering administration switch and the manual LLM backfill switch are
// independent, so enabling one never takes over the other route. The rule
// matches one non-empty segment and the exact /llm-backfill tail, so
// /vector-backfill, /ignore, longer paths and every unlisted method keep
// falling back to NestJS. The default (empty or legacy) appends no rule.
func WithNewsClusteringLlmBackfill(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendSegmentRule(rules, NewsClusteringLlmBackfillKey,
		"/api/system-settings/news-events/clustering/failures/", true, false, "/llm-backfill",
		http.MethodPost)
}

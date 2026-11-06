package httproute

import "net/http"

// PipelineRecoveryKey is the handler registration key for the pipeline recovery
// read route.
const PipelineRecoveryKey = "/api/admin/quality/pipeline/runs"

// PipelineRecoveryWriteKey is the handler registration key for the two pipeline
// recovery write routes. It is a synthetic path so one handler can dispatch
// replay and rollback by URL path.
const PipelineRecoveryWriteKey = "/__go/pipeline-recovery-write"

// WithPipelineRecovery registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET /api/admin/quality/pipeline/runs
func WithPipelineRecovery(rules []Rule) []Rule {
	return appendExactKeyed(rules, PipelineRecoveryKey,
		"/api/admin/quality/pipeline/runs", http.MethodGet)
}

// WithPipelineRecoveryWrite registers the two write routes when mode is go:
//
//	POST /api/admin/quality/pipeline/replay
//	POST /api/admin/quality/pipeline/rollback
//
// Both are exact paths with their own method; OPTIONS is registered for CORS.
// GET on either path, longer paths and the parent path are answered with the
// unmatched-route 404; the runs read is registered by WithPipelineRecovery.
func WithPipelineRecoveryWrite(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, PipelineRecoveryWriteKey,
		"/api/admin/quality/pipeline/replay", http.MethodPost)
	return appendExactKeyed(rules, PipelineRecoveryWriteKey,
		"/api/admin/quality/pipeline/rollback", http.MethodPost)
}

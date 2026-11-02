package legacyproxy

import "net/http"

// PipelineRecoveryKey is the handler registration key for the pipeline recovery
// read route.
const PipelineRecoveryKey = "/api/admin/quality/pipeline/runs"

// PipelineRecoveryWriteKey is the handler registration key for the two pipeline
// recovery write routes. It is a synthetic path so one handler can dispatch
// replay and rollback by URL path.
const PipelineRecoveryWriteKey = "/__go/pipeline-recovery-write"

// WithPipelineRecovery registers exactly one route when mode is go:
//
//	GET /api/admin/quality/pipeline/runs
//
// The rule claims GET plus the CORS preflight OPTIONS on the same exact path
// (appendExactKeyed registers both for the PipelineRecoveryKey handler).
// The two write routes are registered separately by
// API_GO_PIPELINE_RECOVERY_WRITE_MODE (see WithPipelineRecoveryWrite), so the
// read and write ownership can be switched independently. Because the rule pins
// GET, a POST to the same prefix is not swallowed by this handler.
//
// Default (empty or legacy) appends nothing.
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
// GET on either path, longer paths and the parent path keep falling back to
// NestJS, and the runs read keeps its own switch.
func WithPipelineRecoveryWrite(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, PipelineRecoveryWriteKey,
		"/api/admin/quality/pipeline/replay", http.MethodPost)
	return appendExactKeyed(rules, PipelineRecoveryWriteKey,
		"/api/admin/quality/pipeline/rollback", http.MethodPost)
}

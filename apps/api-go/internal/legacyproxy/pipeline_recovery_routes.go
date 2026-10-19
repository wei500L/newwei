package legacyproxy

import "net/http"

// PipelineRecoveryKey is the handler registration key for the pipeline recovery
// read route.
const PipelineRecoveryKey = "/api/admin/quality/pipeline/runs"

// WithPipelineRecovery registers exactly one route when mode is go:
//
//	GET /api/admin/quality/pipeline/runs
//
// The rule claims GET plus the CORS preflight OPTIONS on the same exact path.
// The two write routes (POST /replay and POST /rollback) are deliberately
// absent: they need the item pipeline producer (pipelineenqueue) that is not on
// main yet, so they keep proxying to NestJS. Because the rule pins GET, a POST to
// the same prefix is not swallowed by this handler.
//
// Default (empty or legacy) appends nothing.
func WithPipelineRecovery(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactGET(rules, "/api/admin/quality/pipeline/runs")
}

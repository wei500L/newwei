package legacyproxy

// healthzLivePath is the public liveness probe served by the Go health handler.
// It stays an exact, GET-only rule (plus the matching OPTIONS preflight) so
// POST/HEAD, similar paths (/api/healthz/liveness) and the trailing slash form
// do not reach it.
const healthzLivePath = "/api/healthz/live"

// WithHealthzLive appends the exact GET /api/healthz/live route and its CORS
// preflight. The Go health handler answers it directly; the probe no longer has
// a shadow/legacy switch because the Go runtime owns every entrypoint.
func WithHealthzLive(rules []Rule) []Rule {
	return appendExactGET(rules, healthzLivePath)
}

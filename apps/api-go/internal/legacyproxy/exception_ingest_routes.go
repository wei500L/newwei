package legacyproxy

import "net/http"

// Handler registration keys for the two migrated exception-report POST
// endpoints. Both are exact paths, so the keys can be the paths themselves.
const (
	ExceptionIngestClientKey   = "/api/observability/exception-events/client"
	ExceptionIngestInternalKey = "/api/internal/observability/exception-events"
)

// WithExceptionIngest takes over the two exception-report POST endpoints when
// mode is go:
//
//	POST /api/observability/exception-events/client
//	POST /api/internal/observability/exception-events
//
// Both are exact path + method allowlist (POST plus preflight OPTIONS, which
// the wiring forwards to the legacy proxy when it is not a preflight request).
// Similar paths (for example /api/observability/exception-events/clients) and
// other methods keep falling through to NestJS; Go never answers its own 404.
// The default (empty / legacy) appends no rules, and the seven admin log read
// GETs stay on their own API_GO_ADMIN_LOGS_MODE switch.
func WithExceptionIngest(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, ExceptionIngestClientKey,
		"/api/observability/exception-events/client", http.MethodPost)
	return appendExactKeyed(rules, ExceptionIngestInternalKey,
		"/api/internal/observability/exception-events", http.MethodPost)
}

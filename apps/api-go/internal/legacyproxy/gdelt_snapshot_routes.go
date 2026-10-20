package legacyproxy

import "net/http"

// GdeltSnapshotKey is the handler registration key for the situation-monitor
// GDELT external snapshot refresh. It is one exact route, so the key is the path
// itself.
const GdeltSnapshotKey = "/api/system-settings/situation-monitor/external-snapshot/refresh"

// WithGdeltSnapshotRefresh takes over the forced-refresh entry when mode is go:
//
//	POST /api/system-settings/situation-monitor/external-snapshot/refresh
//
// The rule is an exact path with an explicit method whitelist plus OPTIONS for
// the CORS preflight. Every other method, a trailing slash, a longer path and
// the rest of the situation-monitor settings surface (GET/PUT/DELETE
// /api/system-settings/situation-monitor) keep falling back to the legacy /api/
// rule. An empty or legacy mode adds nothing, so the default deployment is
// unchanged and rollback flips only this switch.
//
// This switch is independent of API_GO_GDELT_SNAPSHOT_MODE: the scheduler owner
// never enables the HTTP entry and vice versa. Both executions share the Redis
// rebuild lease, so the route can safely be served by Go while NestJS still owns
// the schedule.
func WithGdeltSnapshotRefresh(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactKeyed(rules, GdeltSnapshotKey, GdeltSnapshotKey, http.MethodPost)
}

package httproute

import "net/http"

// GdeltSnapshotKey is the handler registration key for the situation-monitor
// GDELT external snapshot refresh. It is one exact route, so the key is the path
// itself.
const GdeltSnapshotKey = "/api/system-settings/situation-monitor/external-snapshot/refresh"

// WithGdeltSnapshotRefresh registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/system-settings/situation-monitor/external-snapshot/refresh
func WithGdeltSnapshotRefresh(rules []Rule) []Rule {
	return appendExactKeyed(rules, GdeltSnapshotKey, GdeltSnapshotKey, http.MethodPost)
}

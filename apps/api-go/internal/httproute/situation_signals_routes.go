package httproute

import "net/http"

// SituationSignalsKey is the handler registration key for the seven situation
// monitor signal read and feedback routes. It must stay distinct from
// SituationMonitorsKey ("/api/situation-monitor/monitors"): the two switches are
// independent, and a shared key would let one takeover answer the other's paths.
// A single key is enough because the handler dispatches on path and method.
const SituationSignalsKey = "/api/situation-monitor#signals"

// WithSituationSignals registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/situation-monitor/catalog                  (items.read)
//	POST /api/situation-monitor/feedback                 (items.write, 201)
//	GET  /api/situation-monitor/refresh-runs/:refreshId  (items.read, 200/404)
//	GET  /api/situation-monitor/telegram-feed            (items.read)
//	GET  /api/situation-monitor/oref-alerts              (items.read)
//	GET  /api/situation-monitor/oref-history             (items.read)
//	GET  /api/situation-monitor/live-hls-proxy-config    (items.read)
func WithSituationSignals(rules []Rule) []Rule {
	base := "/api/situation-monitor"
	rules = appendExactKeyed(rules, SituationSignalsKey, base+"/catalog", http.MethodGet)
	rules = appendExactKeyed(rules, SituationSignalsKey, base+"/feedback", http.MethodPost)
	rules = appendExactKeyed(rules, SituationSignalsKey, base+"/telegram-feed", http.MethodGet)
	rules = appendExactKeyed(rules, SituationSignalsKey, base+"/oref-alerts", http.MethodGet)
	rules = appendExactKeyed(rules, SituationSignalsKey, base+"/oref-history", http.MethodGet)
	rules = appendExactKeyed(rules, SituationSignalsKey, base+"/live-hls-proxy-config", http.MethodGet)
	// `:refreshId` is exactly one non-empty path segment: /refresh-runs itself and
	// /refresh-runs/x/y never match, and POST /refresh lives on a different path.
	return appendSegmentRule(rules, SituationSignalsKey, base+"/refresh-runs/", true, false, "",
		http.MethodGet)
}

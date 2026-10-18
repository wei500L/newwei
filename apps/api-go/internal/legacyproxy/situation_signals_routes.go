package legacyproxy

import "net/http"

// SituationSignalsKey is the handler registration key for the seven situation
// monitor signal read and feedback routes. It must stay distinct from
// SituationMonitorsKey ("/api/situation-monitor/monitors"): the two switches are
// independent, and a shared key would let one takeover answer the other's paths.
// A single key is enough because the handler dispatches on path and method.
const SituationSignalsKey = "/api/situation-monitor#signals"

// WithSituationSignals takes over exactly seven situation monitor routes when
// mode is go:
//
//	GET  /api/situation-monitor/catalog                  (items.read)
//	POST /api/situation-monitor/feedback                 (items.write, 201)
//	GET  /api/situation-monitor/refresh-runs/:refreshId  (items.read, 200/404)
//	GET  /api/situation-monitor/telegram-feed            (items.read)
//	GET  /api/situation-monitor/oref-alerts              (items.read)
//	GET  /api/situation-monitor/oref-history             (items.read)
//	GET  /api/situation-monitor/live-hls-proxy-config    (items.read)
//
// Registration order and shape matter. The three exact paths that extend
// "/api/situation-monitor/monitors" do not exist here, but "/api/situation-monitor/"
// is also the prefix of the monitors rules, which is why every rule below is an
// exact path or an exact one-segment rule and none of them can shadow the
// monitors handler.
//
// Everything else keeps falling back to NestJS under the shared /api/ prefix:
// /insights, /monitors** (owned by API_GO_SITUATION_MONITORS_MODE), POST
// /refresh, /api/system-settings/realtime-signals/runtime, every other method on
// the seven paths, a trailing slash and any longer path such as
// /refresh-runs/x/y. An empty or legacy mode adds no rules at all, so the default
// deployment is unchanged and rollback only flips this one switch.
//
// The shared rule helpers also whitelist OPTIONS for the taken-over paths, so CORS
// preflight is answered by the Go handler instead of reaching NestJS.
func WithSituationSignals(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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

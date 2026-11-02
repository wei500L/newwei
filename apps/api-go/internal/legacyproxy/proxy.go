// Package legacyproxy is the Go HTTP router for the api-go process.
//
// The package is a durable Go router rather than a Strangler Fig gateway: the
// process owns every migrated HTTP entrypoint directly and never forwards a
// request to another backend. There is no reverse proxy, no shadow comparison
// and no canary split. A request either matches a declared Go route (and is
// dispatched to its registered handler) or it is rejected with the NestJS
// unmatched-route 404 contract rendered by internal/nestnotfound, so an unknown
// path can never leak to a stopped backend or surface as a 502.
//
// Route tables are declared as an ordered list of Rule values. Matching keeps
// the semantics the migration relied on:
//
//   - a rule with Exact matches the concrete path exactly;
//   - a rule with OneSegment/TwoSegments matches a fixed prefix followed by one
//     or two non-empty dynamic segments (optionally a fixed Tail);
//   - every other rule matches by prefix;
//   - a rule with a non-empty Methods whitelist only matches those methods;
//   - the most specific (longest Prefix) rule wins; ties keep declaration order.
//
// Handlers are registered by key (RegisterGoHandler) and looked up by the
// matched rule's HandlerKey (falling back to Prefix). The gateway also owns the
// bounded HTTP route label used by the metrics histogram and the CORS policy and
// exception recorder used by the unmatched-route 404.
package legacyproxy

import (
	"net/http"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// Rule declares one Go-owned route.
//
// Prefix is the fixed path (or fixed leading path for dynamic rules). Exact
// requires the whole path to equal Prefix. OneSegment/TwoSegments require one
// or two non-empty dynamic segments after Prefix. Tail is an optional fixed
// suffix after the dynamic segment(s). TailSegment (used with OneSegment)
// expresses <dynamic><Tail>/<dynamic>; TailSuffix appends a fixed suffix to the
// last dynamic segment. HandlerKey overrides the handler lookup key when the
// static prefix differs from the registration key (for example a trailing slash
// on a dynamic prefix). Methods is a method whitelist; empty means any method.
type Rule struct {
	Prefix      string
	Exact       bool
	OneSegment  bool
	TwoSegments bool
	Tail        string
	TailSegment bool
	TailSuffix  string
	HandlerKey  string
	Methods     map[string]bool
}

// GoHandler is a native Go request handler registered on the gateway.
type GoHandler func(w http.ResponseWriter, r *http.Request)

// Gateway routes every request to a registered Go handler and rejects the rest.
type Gateway struct {
	rules      []Rule
	goHandlers map[string]GoHandler
	// corsPolicy answers browser preflights and adds the actual-request CORS
	// headers to the unmatched-route 404 the gateway writes itself.
	corsPolicy cors.Policy
	// notFoundRecorder is the best-effort exception event side channel used when
	// no Go route matches. Nil means "do not record".
	notFoundRecorder nestnotfound.Recorder
}

// New builds the router from an ordered route table. Go handlers are injected
// afterwards with RegisterGoHandler / SetGoHandler.
func New(rules []Rule) *Gateway {
	return &Gateway{
		rules:      rules,
		goHandlers: make(map[string]GoHandler),
	}
}

// SetNotFound installs the CORS policy and the best-effort exception recorder
// used to answer a request no Go route claims. The gateway must not be serving
// requests while this runs: cmd/api wires it once before the listener starts.
func (g *Gateway) SetNotFound(policy cors.Policy, record nestnotfound.Recorder) {
	g.corsPolicy = policy
	g.notFoundRecorder = record
}

// SetGoHandler registers the process introspection handler at /__go/healthz.
func (g *Gateway) SetGoHandler(handler GoHandler) {
	g.goHandlers["/__go/healthz"] = handler
}

// RegisterGoHandler registers a native Go handler under a lookup key.
func (g *Gateway) RegisterGoHandler(prefix string, handler GoHandler) {
	g.goHandlers[prefix] = handler
}

// Reject answers a request that must not be served as a matched Go route with
// the NestJS unmatched-route 404 contract. It is the single exit for a method
// the registered handler does not own and for a path no rule claims. CORS is
// answered first; no backend is ever contacted.
func (g *Gateway) Reject(w http.ResponseWriter, r *http.Request) {
	nestnotfound.Write(w, r, g.corsPolicy, g.notFoundRecorder)
}

// ServeHTTP matches the request against the route table and dispatches to the
// registered Go handler. A request that no rule claims, or whose matched rule
// has no handler, is answered with the NestJS unmatched-route 404.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rule, matched := g.matchRule(r.Method, r.URL.Path)
	if matched {
		// Record the bounded route label while the route-table decision is in
		// hand; the outer metrics middleware reads it back after ServeHTTP
		// returns. An unmatched request keeps the NestJS "unmatched" literal
		// (the metric middleware default) so a scanned path cannot create a
		// series.
		httpx.SetRouteLabel(r.Context(), httpx.RouteFamily(r.URL.Path))
		key := rule.Prefix
		if rule.HandlerKey != "" {
			key = rule.HandlerKey
		}
		if handler := g.matchGoHandler(key); handler != nil {
			handler(w, r)
			return
		}
	}
	g.Reject(w, r)
}

func (g *Gateway) matchGoHandler(prefix string) GoHandler {
	// Exact handler-key match first (route table HandlerKey = registration key).
	if handler, ok := g.goHandlers[prefix]; ok {
		return handler
	}
	// Compatibility for dynamic prefixes: the longest registered key that is a
	// prefix of the rule key wins, so a board handler never answers a task
	// route.
	keys := make([]string, 0, len(g.goHandlers))
	for key := range g.goHandlers {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	for _, key := range keys {
		if strings.HasPrefix(prefix, key) {
			return g.goHandlers[key]
		}
	}
	return nil
}

// match returns the rule that claims method+path (or the zero Rule when none).
func (g *Gateway) match(method, path string) Rule {
	rule, _ := g.matchRule(method, path)
	return rule
}

// matchRule is match plus whether a declared rule actually matched. The metrics
// route label needs the difference: an unclaimed path is reported with the
// bounded "unmatched" literal rather than a path-derived family.
func (g *Gateway) matchRule(method, path string) (Rule, bool) {
	method = strings.ToUpper(method)
	sorted := make([]Rule, len(g.rules))
	copy(sorted, g.rules)
	sort.SliceStable(sorted, func(i, j int) bool {
		return len(sorted[i].Prefix) > len(sorted[j].Prefix)
	})
	for _, rule := range sorted {
		if !rule.matchesPath(path) {
			continue
		}
		if len(rule.Methods) > 0 && !rule.Methods[method] {
			continue
		}
		return rule, true
	}
	return Rule{}, false
}

func (rule Rule) matchesPath(path string) bool {
	if rule.OneSegment || rule.TwoSegments {
		if !strings.HasPrefix(path, rule.Prefix) {
			return false
		}
		rest := path[len(rule.Prefix):]
		if rule.Tail != "" {
			if !strings.HasPrefix(rule.Tail, "/") {
				return false
			}
			if rule.TailSegment {
				// <dynamic>/<Tail>/<dynamic>: take the last <Tail>/ occurrence so
				// a dynamic segment that itself contains Tail still matches.
				marker := rule.Tail + "/"
				idx := strings.LastIndex(rest, marker)
				if idx <= 0 {
					return false
				}
				tailSegment := rest[idx+len(marker):]
				if rule.TailSuffix != "" {
					if !strings.HasSuffix(tailSegment, rule.TailSuffix) {
						return false
					}
					tailSegment = strings.TrimSuffix(tailSegment, rule.TailSuffix)
				}
				if tailSegment == "" || strings.Contains(tailSegment, "/") {
					return false
				}
				rest = rest[:idx]
			} else {
				if !strings.HasSuffix(rest, rule.Tail) {
					return false
				}
				rest = rest[:len(rest)-len(rule.Tail)]
			}
		}
		if rest == "" || strings.HasPrefix(rest, "/") || strings.HasSuffix(rest, "/") {
			return false
		}
		parts := strings.Split(rest, "/")
		if rule.OneSegment {
			return len(parts) == 1 && parts[0] != ""
		}
		return len(parts) == 2 && parts[0] != "" && parts[1] != ""
	}
	if rule.Exact {
		return path == rule.Prefix
	}
	return strings.HasPrefix(path, rule.Prefix)
}

// Rules exports a copy of the current route table.
func (g *Gateway) Rules() []Rule {
	out := make([]Rule, len(g.rules))
	copy(out, g.rules)
	return out
}

func appendExactGET(rules []Rule, path string) []Rule {
	return appendExactMethods(rules, http.MethodGet, path)
}

// appendExactMethods appends an exact rule for method plus the matching OPTIONS
// rule, so a browser preflight reaches the Go handler.
func appendExactMethods(rules []Rule, method, path string) []Rule {
	return append(rules,
		Rule{Prefix: path, Exact: true, Methods: map[string]bool{method: true}},
		Rule{Prefix: path, Exact: true, Methods: map[string]bool{http.MethodOptions: true}},
	)
}

// userSettingsReadPaths are the six user-settings read GET exact paths. The PUT
// and OPTIONS rules share the same paths.
var userSettingsReadPaths = []string{
	"/api/user-settings/ui/onboarding",
	"/api/user-settings/ui/rss-reader",
	"/api/user-settings/ui/spacetime-timeline",
	"/api/user-settings/ui/war-map",
	"/api/user-settings/ui/newsnow",
	"/api/user-settings/ui/situation-monitor",
}

// BaseRules is the always-on route table every Go-only deployment serves: the
// six user-settings GET/PUT/OPTIONS routes and the process introspection probe.
// Every other unit is appended by its own builder through AllRoutes.
func BaseRules() []Rule {
	getOnly := map[string]bool{http.MethodGet: true}
	putOnly := map[string]bool{http.MethodPut: true}
	optionsOnly := map[string]bool{http.MethodOptions: true}
	rules := []Rule{{Prefix: "/__go/healthz"}}
	for _, path := range userSettingsReadPaths {
		rules = append(rules,
			Rule{Prefix: path, Exact: true, Methods: getOnly},
			Rule{Prefix: path, Exact: true, Methods: putOnly},
			Rule{Prefix: path, Exact: true, Methods: optionsOnly},
		)
	}
	return rules
}

// WithPublicPortal appends the public home, channel and two story-detail reads.
func WithPublicPortal(rules []Rule) []Rule {
	getOnly := map[string]bool{http.MethodGet: true}
	return append(rules,
		Rule{Prefix: "/api/public-portal/home", Exact: true, Methods: getOnly},
		Rule{Prefix: "/api/public-portal/channels/", OneSegment: true, Methods: getOnly},
		Rule{Prefix: "/api/public-portal/stories/id/", OneSegment: true, Methods: getOnly},
		Rule{Prefix: "/api/public-portal/stories/slug/", OneSegment: true, Methods: getOnly},
	)
}

// WithNotificationsSocket appends the dedicated Engine.IO path used by the Go
// notifications transport (GET upgrades only). It is separate from /socket.io.
func WithNotificationsSocket(rules []Rule) []Rule {
	return append(rules, Rule{
		Prefix:  "/socket.io-notifications",
		Methods: map[string]bool{http.MethodGet: true},
	})
}

// WithRealtimeSocket appends the dedicated Engine.IO path used by the Go
// five-namespace realtime transport (GET upgrades only).
func WithRealtimeSocket(rules []Rule) []Rule {
	return append(rules, Rule{
		Prefix:  "/socket.io-realtime",
		Methods: map[string]bool{http.MethodGet: true},
	})
}

// WithDashboardStats appends the exact GET /api/dashboard/stats (and OPTIONS).
func WithDashboardStats(rules []Rule) []Rule {
	return appendExactGET(rules, "/api/dashboard/stats")
}

// WithDashboardCharts appends the three exact chart GETs (and OPTIONS).
func WithDashboardCharts(rules []Rule) []Rule {
	for _, path := range []string{
		"/api/dashboard/sector-heatmap",
		"/api/dashboard/financial-candlestick",
		"/api/dashboard/war-map/geojson",
	} {
		rules = appendExactGET(rules, path)
	}
	return rules
}

// WithDashboardWarMap appends the two exact war-map GETs (and OPTIONS).
func WithDashboardWarMap(rules []Rule) []Rule {
	for _, path := range []string{
		"/api/dashboard/war-map/events",
		"/api/dashboard/war-map/news-markers",
	} {
		rules = appendExactGET(rules, path)
	}
	return rules
}

// WithDashboardWarMapTransport appends the exact transport-detail GET (OPTIONS).
func WithDashboardWarMapTransport(rules []Rule) []Rule {
	return appendExactGET(rules, "/api/dashboard/war-map/transport-detail")
}

// WithDashboardWarMapLayers appends the exact layers GET (OPTIONS).
func WithDashboardWarMapLayers(rules []Rule) []Rule {
	return appendExactGET(rules, "/api/dashboard/war-map/layers")
}

// WithDashboardSpacetimeGeo appends the geo-heatmap overview and drill-down GETs.
func WithDashboardSpacetimeGeo(rules []Rule) []Rule {
	rules = appendExactGET(rules, "/api/dashboard/spacetime/geo-heatmap")
	return appendExactGET(rules, "/api/dashboard/spacetime/geo-heatmap/articles")
}

// WithDashboardSpacetimePropagation appends the propagation overview and
// drill-down GETs.
func WithDashboardSpacetimePropagation(rules []Rule) []Rule {
	rules = appendExactGET(rules, "/api/dashboard/spacetime/propagation")
	return appendExactGET(rules, "/api/dashboard/spacetime/propagation/articles")
}

// WithDashboardStream appends the exact SSE GET /api/dashboard/stream (OPTIONS).
func WithDashboardStream(rules []Rule) []Rule {
	return appendExactGET(rules, "/api/dashboard/stream")
}

// NewsSourcesKey is the handler registration key of the news-source admin routes.
const NewsSourcesKey = "/api/admin/news-sources"

// WithNewsSources appends the fifteen news-source admin read/write routes. GET
// :id/preview and longer paths are excluded.
func WithNewsSources(rules []Rule) []Rule {
	base := "/api/admin/news-sources"
	rules = appendExactKeyed(rules, NewsSourcesKey, base, http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/options", http.MethodGet)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/groups", http.MethodGet)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/opml-presets", http.MethodGet)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/batch/frequency", http.MethodPost)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/opml/preview", http.MethodPost)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/opml/import", http.MethodPost)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/batch/group", http.MethodPatch)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/batch/active", http.MethodPatch)
	rules = appendExactKeyed(rules, NewsSourcesKey, base+"/batch", http.MethodDelete)
	rules = appendSegmentRule(rules, NewsSourcesKey, base+"/", true, false, "", http.MethodPatch, http.MethodDelete)
	rules = appendSegmentRule(rules, NewsSourcesKey, base+"/", true, false, "/run", http.MethodPost)
	return appendSegmentRule(rules, NewsSourcesKey, base+"/", true, false, "/schedule", http.MethodPost)
}

// SituationMonitorsKey is the handler registration key of the situation
// monitor custom-monitor routes.
const SituationMonitorsKey = "/api/situation-monitor/monitors"

// WithSituationMonitors appends the five custom-monitor routes.
func WithSituationMonitors(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, SituationMonitorsKey, "/api/situation-monitor/monitors",
		http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, SituationMonitorsKey, "/api/situation-monitor/monitors/preview",
		http.MethodPost)
	return appendSegmentRule(rules, SituationMonitorsKey, "/api/situation-monitor/monitors/", true, false, "",
		http.MethodPatch, http.MethodDelete)
}

// WithContentSubscriptions appends the seven exact content-subscription routes.
func WithContentSubscriptions(rules []Rule) []Rule {
	rules = appendExactMethods(rules, http.MethodGet, "/api/user-content-subscriptions")
	rules = appendExactMethods(rules, http.MethodPost, "/api/user-content-subscriptions/batch-upsert")
	rules = appendExactMethods(rules, http.MethodPost, "/api/user-content-subscriptions/batch-delete")
	rules = appendExactMethods(rules, http.MethodGet, "/api/user-content-subscriptions/catalog")
	rules = appendExactMethods(rules, http.MethodGet, "/api/user-content-subscriptions/recommendations")
	rules = appendExactMethods(rules, http.MethodPost, "/api/user-content-subscriptions/catalog/lookup")
	return appendExactMethods(rules, http.MethodGet, "/api/user-content-subscriptions/related-topics")
}

// WithUserNewsBehavior appends the behavior record, profile read and clear routes.
func WithUserNewsBehavior(rules []Rule) []Rule {
	rules = appendExactMethods(rules, http.MethodPost, "/api/user-news-behavior")
	rules = appendExactMethods(rules, http.MethodGet, "/api/user-news-behavior/profile")
	return appendExactMethods(rules, http.MethodDelete, "/api/user-news-behavior/profile")
}

// WithUserDigest appends the digest preference, delivery and daily-digest routes.
func WithUserDigest(rules []Rule) []Rule {
	rules = appendExactMethods(rules, http.MethodGet, "/api/user-digest/preference")
	rules = appendExactMethods(rules, http.MethodPut, "/api/user-digest/preference")
	rules = appendExactMethods(rules, http.MethodGet, "/api/user-digest/delivery")
	rules = appendExactMethods(rules, http.MethodPut, "/api/user-digest/delivery")
	return appendExactMethods(rules, http.MethodGet, "/api/user-digest")
}

// WithAuthenticatedHealth appends the exact authenticated GET /api/healthz.
func WithAuthenticatedHealth(rules []Rule) []Rule {
	return append(rules, Rule{
		Prefix:  "/api/healthz",
		Exact:   true,
		Methods: map[string]bool{http.MethodGet: true},
	})
}

// WithGraphQLRead appends the exact /graphql GET/POST/OPTIONS rules and the
// GraphQL read-stats introspection GET. The registered roots decide which
// documents execute; an unregistered root is rejected by the handler before any
// side effect (there is no whole-operation fallback).
func WithGraphQLRead(rules []Rule) []Rule {
	getOnly := map[string]bool{http.MethodGet: true}
	return append(rules,
		Rule{Prefix: "/graphql", Exact: true, Methods: map[string]bool{http.MethodGet: true}},
		Rule{Prefix: "/graphql", Exact: true, Methods: map[string]bool{http.MethodPost: true}},
		Rule{Prefix: "/graphql", Exact: true, Methods: map[string]bool{http.MethodOptions: true}},
		Rule{Prefix: "/__go/graphql-read-stats", Exact: true, Methods: getOnly},
	)
}

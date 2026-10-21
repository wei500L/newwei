package legacyproxy

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
)

// allGoRules is the rule table the gateway assembles when every API_GO_* switch
// is go. It mirrors the production assembly in cmd/api/main.go (one builder per
// switch, same order); when a builder is added there it must be added here, and
// the route fixture assertion below then proves the new routes are covered.
func allGoRules() []Rule {
	rules := DefaultRulesWithWrite(ModeGo, "go", "go")
	rules = WithAccountData(rules, "go", "go")
	rules = WithAccountSecurity(rules, "go")
	rules = WithAdminLogs(rules, "go")
	rules = WithAnalysisBoards(rules, "go")
	rules = WithAnalysisExport(rules, "go")
	rules = WithAnalysisThreads(rules, "go")
	rules = WithAnalysisViews(rules, "go")
	rules = WithArchiveReadingSearch(rules, "go")
	rules = WithAuthFactors(rules, "go")
	rules = WithAuthLogin(rules, "go")
	rules = WithAuthenticatedHealth(rules, "go")
	rules = WithClassificationReports(rules, "go")
	rules = WithClassificationRssOps(rules, "go")
	rules = WithContentSubscriptions(rules, "go")
	rules = WithCrawlFrontierRuns(rules, "go")
	rules = WithCrawlMetadata(rules, "go")
	rules = WithCrawlProfiles(rules, "go")
	rules = WithCrawlQueueOps(rules, "go")
	rules = WithCrawlReadTelemetry(rules, "go")
	rules = WithCrawlTaskWrite(rules, "go")
	rules = WithCrawlTemplates(rules, "go")
	rules = WithCrawlWorkflowTrial(rules, "go")
	rules = WithCrawlWorkflows(rules, "go")
	rules = WithDashboardCharts(rules, "go")
	rules = WithDashboardSpacetimeGeo(rules, "go")
	rules = WithDashboardSpacetimePropagation(rules, "go")
	rules = WithDashboardStats(rules, "go")
	rules = WithDashboardStream(rules, "go")
	rules = WithDashboardWarMap(rules, "go")
	rules = WithDashboardWarMapLayers(rules, "go")
	rules = WithDashboardWarMapTransport(rules, "go")
	rules = WithDataRuntimeSettings(rules, "go")
	rules = WithEconomicData(rules, "go")
	rules = WithEmailSettings(rules, "go")
	rules = WithExceptionIngest(rules, "go")
	rules = WithGdeltSnapshotRefresh(rules, "go")
	rules = WithGeocoding(rules, "go")
	rules = WithGraphQLRead(rules, "go")
	rules = WithIdentityOnboarding(rules, "go")
	rules = WithInfrastructureSettings(rules, "go")
	rules = WithItemsIngest(rules, "go")
	rules = WithItemsReading(rules, "go")
	rules = WithLLMGatewayOps(rules, "go")
	rules = WithLLMGatewayProfiles(rules, "go")
	rules = WithLlmLogs(rules, "go")
	rules = WithMetrics(rules, "go")
	rules = WithModelAccessSettings(rules, "go")
	rules = WithNewsClusteringLlmBackfill(rules, "go")
	rules = WithNewsIndicators(rules, "go")
	rules = WithNewsSourceOps(rules, "go")
	rules = WithNewsSourcePreview(rules, "go")
	rules = WithNewsSources(rules, "go")
	rules = WithNewsnowClusteringOps(rules, "go")
	rules = WithNewsnowHottest(rules, "go")
	rules = WithNewsnowSources(rules, "go")
	rules = WithNotificationsSocket(rules, "go")
	rules = WithOIDCLogin(rules, "go")
	rules = WithPipelineRecovery(rules, "go")
	rules = WithPipelineRecoveryWrite(rules, "go")
	rules = WithPlatformGovernanceSettings(rules, "go")
	rules = WithProxyLoadBalancing(rules, "go")
	rules = WithPublicPortal(rules, "go")
	rules = WithQualityOverview(rules, "go")
	rules = WithRbac(rules, "go")
	rules = WithRealtimeSocket(rules, "go")
	rules = WithRuntimeDiagnostics(rules, "go")
	rules = WithRuntimeSettings(rules, "go")
	rules = WithSearchReindex(rules, "go")
	rules = WithSituationInsights(rules, "go")
	rules = WithSituationMonitors(rules, "go")
	rules = WithSituationRefresh(rules, "go")
	rules = WithSituationSettings(rules, "go")
	rules = WithSituationSignals(rules, "go")
	rules = WithSituationTelegramAuth(rules, "go")
	rules = WithStorageDiagnostics(rules, "go")
	rules = WithUserDigest(rules, "go")
	rules = WithUserNewsBehavior(rules, "go")
	// refactor/go-ops-entrypoints (C-1/C-5/C-7): the three takeovers that closed
	// the operational C items. The order mirrors cmd/api/main.go: the public
	// liveness probe sits next to the authenticated health route, the vector
	// diagnostics route next to the settings takeovers, and /docs last.
	rules = WithHealthzLive(rules, "go")
	rules = WithVectorDiagnostics(rules, "go")
	rules = WithDocs(rules, "go")
	// The order of the builder calls does not affect matching: match() sorts the
	// rules by prefix length. New builders are appended at the end so parallel
	// cutover batches never touch the same alphabetical region.
	rules = WithCrawlFrontierWrites(rules, "go")
	return rules
}

// loadRouteFixture reads "METHOD /path" lines, skipping comments and blanks.
func loadRouteFixture(t *testing.T, path string) [][2]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open route fixture %s: %v", path, err)
	}
	defer file.Close()

	var routes [][2]string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("invalid route fixture line %q", line)
		}
		routes = append(routes, [2]string{strings.ToUpper(fields[0]), fields[1]})
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan route fixture %s: %v", path, err)
	}
	if len(routes) < 100 {
		t.Fatalf("route fixture %s has %d routes; refusing to pass on a truncated list", path, len(routes))
	}
	return routes
}

// TestAllGoCutoverRoutesAreOwnedByGo is the T2 cutover gate: every A-class REST
// route from the ownership audit must match a ModeGo rule under the all-go
// configuration. A route that only matches the /api/ legacy fallback means the
// migration map or the rule table has a real gap.
func TestAllGoCutoverRoutesAreOwnedByGo(t *testing.T) {
	gateway, err := New("http://legacy.invalid", allGoRules())
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	for _, route := range loadRouteFixture(t, "testdata/nest-routes.txt") {
		method, path := route[0], route[1]
		rule := gateway.match(method, path)
		if rule.Mode != ModeGo {
			t.Errorf("%s %s matched rule %q mode %q, want go (legacy fallback would send it to NestJS)", method, path, rule.Prefix, rule.Mode)
			continue
		}
		if rule.Prefix == "/api/" {
			t.Errorf("%s %s matched the generic /api/ fallback with mode go; expected an exact migration rule", method, path)
		}
	}
}

// TestAllGoRulesKeepNonMigratedPathsOnLegacy guards the inverse direction: the
// all-go table must not silently claim paths that still belong to NestJS.
// /docs is no longer in this list: refactor/go-ops-entrypoints moved it to a
// Go rule (C-7), including its sub-paths, which the handler answers with the
// NestJS-equivalent 404 for unknown entries.
func TestAllGoRulesKeepNonMigratedPathsOnLegacy(t *testing.T) {
	gateway, err := New("http://legacy.invalid", allGoRules())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, probe := range [][2]string{
		{http.MethodGet, "/admin/queues"},
		{http.MethodGet, "/api/not-migrated-yet"},
		{http.MethodGet, "/"},
	} {
		rule := gateway.match(probe[0], probe[1])
		if rule.Mode != ModeLegacy {
			t.Errorf("%s %s matched mode %q, want legacy until that entry is migrated", probe[0], probe[1], rule.Mode)
		}
	}
	for _, path := range []string{"/docs", "/docs/", "/docs/json", "/docs/swagger-ui.css", "/docsx"} {
		if rule := gateway.match(http.MethodGet, path); rule.Mode != ModeGo {
			t.Errorf("GET %s matched mode %q, want go after the C-7 takeover", path, rule.Mode)
		}
	}
}

// TestAllGoRejectModeAnswers404WithoutProxying is the C-9 cutover gate: with
// every switch go and the legacy fallback in reject mode, a request that still
// has no Go owner must be answered by the gateway itself (NestJS-equivalent
// 404) and must never reach the legacy API.
func TestAllGoRejectModeAnswers404WithoutProxying(t *testing.T) {
	reached := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()

	gateway, err := New(upstream.URL, allGoRules())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	gateway.SetLegacyFallback(string(LegacyFallbackReject), cors.New(""), nil)

	for _, probe := range []struct {
		method string
		target string
	}{
		{http.MethodGet, "/admin/queues"},
		{http.MethodGet, "/api/not-migrated-yet"},
		{http.MethodGet, "/"},
		{http.MethodGet, "/unknown?x=1"},
	} {
		recorder := httptest.NewRecorder()
		gateway.ServeHTTP(recorder, httptest.NewRequest(probe.method, probe.target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s status = %d, want 404", probe.method, probe.target, recorder.Code)
			continue
		}
		if got := recorder.Header().Get("x-trace-id"); got == "" {
			t.Errorf("%s %s missing x-trace-id", probe.method, probe.target)
		}
		body := recorder.Body.String()
		if !strings.Contains(body, `"statusCode":404`) || !strings.Contains(body, `"error":"Not Found"`) {
			t.Errorf("%s %s body = %s, want the NestJS 404 body", probe.method, probe.target, body)
		}
		wantPath := probe.target
		if !strings.Contains(body, `"path":"`+wantPath+`"`) {
			t.Errorf("%s %s body = %s, want path %q", probe.method, probe.target, body, wantPath)
		}
	}
	if reached != 0 {
		t.Fatalf("reject mode forwarded %d requests to the legacy API", reached)
	}
}

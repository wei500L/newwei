package legacyproxy

import (
	"bufio"
	"net/http"
	"os"
	"strings"
	"testing"
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
	// refactor/go-queue-ops: the queue operations console is a Go-only surface
	// with no NestJS route, so it is never listed in nest-routes.txt. The builder
	// stays last to keep the shared append point stable for parallel windows.
	rules = WithQueueOps(rules, "go")
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
func TestAllGoRulesKeepNonMigratedPathsOnLegacy(t *testing.T) {
	gateway, err := New("http://legacy.invalid", allGoRules())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, probe := range [][2]string{
		{http.MethodGet, "/admin/queues"},
		{http.MethodGet, "/docs"},
		{http.MethodGet, "/api/not-migrated-yet"},
	} {
		rule := gateway.match(probe[0], probe[1])
		if rule.Mode != ModeLegacy {
			t.Errorf("%s %s matched mode %q, want legacy until that entry is migrated", probe[0], probe[1], rule.Mode)
		}
	}
}

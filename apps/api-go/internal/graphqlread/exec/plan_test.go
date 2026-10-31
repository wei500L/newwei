package exec

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

func TestPlanRoutesWholeOperation(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	reg.RegisterType("AlertChannelModel", alertChannel{})
	reg.RegisterRoot(contract.Root{
		Name:       "alertChannels",
		Permission: "alerts.read",
		Resolve: func(contract.Context) (any, error) {
			return []alertChannel{{
				ID: "c1", Name: "mail", Type: "email", Target: "a@example.com", IsActive: true,
				CreatedAt: time.Unix(0, 0).UTC(), UpdatedAt: time.Unix(0, 0).UTC(),
			}}, nil
		},
	})
	engine := New(loaded, reg, 8, 2000, nil)

	owned := engine.PlanDocument(`query { alertChannels { id name } }`, nil, nil)
	if owned.Kind != KindExecute {
		t.Fatalf("owned query kind %s", owned.Kind)
	}
	mixed := engine.PlanDocument(`query { alertChannels { id } alertRules { id } }`, nil, nil)
	if mixed.Kind != KindProtocol {
		t.Fatalf("mixed query kind %s", mixed.Kind)
	}
	skipped := engine.PlanDocument(`query { alertRules @skip(if: true) { id } alertChannels { id } }`, nil, nil)
	if skipped.Kind != KindProtocol {
		t.Fatalf("@skip on an unmigrated field kind %s", skipped.Kind)
	}
	mutation := engine.PlanDocument(`mutation { markAllNotificationsRead }`, nil, nil)
	if mutation.Kind != KindProtocol {
		t.Fatalf("mutation kind %s", mutation.Kind)
	}
	name := "Moved"
	multi := engine.PlanDocument(`query Moved { alertChannels { id } } mutation Other { markAllNotificationsRead }`, &name, nil)
	if multi.Kind != KindExecute {
		t.Fatalf("selected migrated query kind %s", multi.Kind)
	}
	other := "Other"
	selectedMutation := engine.PlanDocument(`query Moved { alertChannels { id } } mutation Other { markAllNotificationsRead }`, &other, nil)
	if selectedMutation.Kind != KindProtocol {
		t.Fatalf("selected mutation kind %s", selectedMutation.Kind)
	}
	ambiguous := engine.PlanDocument(`query A { alertChannels { id } } query B { alertChannels { name } }`, nil, nil)
	if ambiguous.Kind != KindProtocol || !strings.Contains(string(ambiguous.Result.Body), "Must provide operation name") {
		t.Fatalf("ambiguous body %s", ambiguous.Result.Body)
	}
}

// TestUnregisteredOperationsRejectWithGraphQLError pins the whole-operation
// rejection: a document the Go executor does not own is answered with HTTP 200
// and an errors entry, never forwarded to the NestJS executor.
func TestUnregisteredOperationsRejectWithGraphQLError(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	engine := New(loaded, reg, 8, 2000, nil)

	for _, query := range []string{
		`query { alertRules { id } }`,
		`mutation { markAllNotificationsRead }`,
		`query { alertRules { id } alertChannels { id } }`,
		`query { newsEvents { id } }`,
	} {
		plan := engine.PlanDocument(query, nil, nil)
		if plan.Kind != KindProtocol {
			t.Fatalf("%s kind = %s, want protocol", query, plan.Kind)
		}
		if plan.Result.Status != 200 {
			t.Fatalf("%s status = %d, want 200", query, plan.Result.Status)
		}
		body := string(plan.Result.Body)
		if !strings.Contains(body, `"errors"`) || !strings.Contains(body, "Operation is not supported") {
			t.Fatalf("%s body = %s, want a GraphQL not-supported error", query, body)
		}
	}
}

func TestRegisteredRootsExecuteAndUnregisteredDocumentsStayLegacy(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	engine := New(loaded, reg, 8, 2000, nil)

	const owned = `query {
		alertChannels { id }
		alertEvents { id }
		alertEventReplay(eventId: "e") { eventId }
		alertRuleTuningSuggestion(ruleId: "r") { ruleId }
		analysisResults { id }
		assistantRuns { id }
		assistantEconomicSeriesSuggestions(term: "gdp") { slug }
		assistantRuntimeCapabilities { webSearchSupported }
		notifications { id }
		unreadNotificationCount
		getEconomicData(category: "fx", timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }) { value }
		getEconomicDataWithInsights(category: "fx", timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }) { points { value } }
		getEconomicDataInsights(category: "fx", timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }) { itemSlug }
		getEconomicDataPaginated(category: "fx", timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }) { data { value } }
		economicDataFetchConfigs { id }
		economicDataRefreshPresetStatus(preset: keyMonitor) { preset }
	}`
	if got := engine.PlanDocument(owned, nil, nil); got.Kind != KindExecute {
		t.Fatalf("registered document kind %s body %s", got.Kind, got.Result.Body)
	}
	for _, query := range []string{
		`query { alertRules { id } }`,
		`mutation { markAllNotificationsRead }`,
		`query { newsEvents { id } }`,
		`query { alertChannels { id } alertRules { id } }`,
	} {
		if got := engine.PlanDocument(query, nil, nil); got.Kind != KindProtocol {
			t.Fatalf("%s kind %s", query, got.Kind)
		}
	}

	// API_GO_GRAPHQL_READ_MODE=go 且 API_GO_GRAPHQL_NEWS_EVENTS_MODE=legacy：
	// 不登记新闻事件 root。只含 newsEvents 的文档整包回 Nest，上面的 16 个 query 仍由 Go 执行。
	newsOnly := engine.PlanDocument(`query { newsEvents { id } }`, nil, nil)
	if newsOnly.Kind != KindProtocol {
		t.Fatalf("news events legacy mode kind %s", newsOnly.Kind)
	}

	negative := engine.PlanDocument(`query { notifications(limit: -1) { id } }`, nil, nil)
	if negative.Kind != KindExecute {
		t.Fatalf("negative notifications kind %s", negative.Kind)
	}
	result := engine.Execute(context.Background(), negative, func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "user", OrgID: "org"}, nil
	}, nil, false, 30, "schema", "")
	if strings.Contains(string(result.Body), "take must be a non-negative integer") {
		t.Fatalf("negative limit invented a 400: %s", result.Body)
	}
}

func TestNewsEventsRootsExecuteOnlyWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	newsevents.Register(reg, nil, nil, nil, newsevents.Options{BriefEnabled: true})
	engine := New(loaded, reg, 8, 2000, nil)

	const six = `query {
		newsEvents { id }
		newsEvent(id: "e") { id }
		newsEventBrief(eventId: "e") { version }
		newsEventReferencedArticles(eventId: "e", articleIds: ["a"]) { id }
		topicGroups { topic }
		eventGroups { eventId }
	}`
	if got := engine.PlanDocument(six, nil, nil); got.Kind != KindExecute {
		t.Fatalf("both modes go kind %s body %s", got.Kind, got.Result.Body)
	}
	mixed := engine.PlanDocument(`query { newsEvents { id } newsEventSourcePolicySyncStatus { degraded } }`, nil, nil)
	if mixed.Kind != KindProtocol {
		t.Fatalf("source policy mix kind %s", mixed.Kind)
	}
	pilot := engine.PlanDocument(`query { alertChannels { id } }`, nil, nil)
	if pilot.Kind != KindExecute {
		t.Fatalf("pilot query kind %s", pilot.Kind)
	}
}

func TestKnowledgeGraphRootsExecuteOnlyWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)

	const six = `query {
		getKnowledgeGraphSubgraph(input: { seedName: "600519" }) { seed { id } }
		articleEntityLinks(articleId: "a") { articleId }
		knowledgeGraphEdgeEvidence(edgeId: "e") { id }
		entityIntelligenceCard(input: { entityId: "x" }) { entity { id } }
		entityIntelligenceEvidence(input: { entityId: "x" }) { restricted }
		knowledgeEntityByName(name: "600519") { id }
	}`

	legacyEngine := New(loaded, reg, 8, 2000, nil)
	if got := legacyEngine.PlanDocument(six, nil, nil); got.Kind != KindProtocol {
		t.Fatalf("knowledge graph legacy mode kind %s body %s", got.Kind, got.Result.Body)
	}

	knowledgegraph.Register(reg, nil, nil)
	goEngine := New(loaded, reg, 8, 2000, nil)
	if got := goEngine.PlanDocument(six, nil, nil); got.Kind != KindExecute {
		t.Fatalf("knowledge graph go mode kind %s body %s", got.Kind, got.Result.Body)
	}

	for _, query := range []string{
		`query { getKnowledgeGraphSubgraph(input: { seedName: "x" }) { seed { id } } getEntityImpactGraph { nodes { id } } }`,
		`query { entityIntelligenceCard(input: { entityId: "x" }) { entity { id } } knowledgeGraphEvidenceReviewQueue { id } }`,
		`query { getExecutiveChangeImpact(input: { seed: { name: "x", type: "company" } }) { scenario } }`,
		`query { getCommodityMoveImpact(input: { commodityName: "gold" }) { scenario } }`,
		`query { getPolicyEventImpact(input: { policyName: "rate" }) { scenario } }`,
		`query { knowledgeGraphSettings { enabled } }`,
	} {
		if got := goEngine.PlanDocument(query, nil, nil); got.Kind != KindProtocol {
			t.Fatalf("%s kind %s body %s", query, got.Kind, got.Result.Body)
		}
	}
}

type alertChannel struct {
	ID        string    `graphql:"id"`
	Name      string    `graphql:"name"`
	Type      string    `graphql:"type"`
	Target    string    `graphql:"target"`
	IsActive  bool      `graphql:"isActive"`
	Config    any       `graphql:"config"`
	CreatedAt time.Time `graphql:"createdAt"`
	UpdatedAt time.Time `graphql:"updatedAt"`
}

// TestWorkspaceRootsExecuteOnlyWhenRegistered covers the switch combination:
// the twelve workspace roots stay legacy until workspace.Register runs, and
// mutations plus unmigrated roots keep the whole document on NestJS.
func TestWorkspaceRootsExecuteOnlyWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)

	const twelve = `query {
		me { id email }
		myOrganizations { id }
		users { id }
		userLoginRecords(userId: "u") { id }
		roles { id }
		permissions { id }
		memberships { id }
		dashboards { id }
		queueStats { itemCount }
		entitySentimentSeries(entityName: "x") { entityName }
		topicSentimentSeries(topic: "x") { topic }
		processedItemById(id: "64c0000000000000000000a1") { id }
	}`

	legacyEngine := New(loaded, reg, 8, 2000, nil)
	if got := legacyEngine.PlanDocument(twelve, nil, nil); got.Kind != KindProtocol {
		t.Fatalf("workspace legacy mode kind %s body %s", got.Kind, got.Result.Body)
	}

	workspace.Register(reg, nil, nil, nil)
	goEngine := New(loaded, reg, 8, 2000, nil)
	if got := goEngine.PlanDocument(twelve, nil, nil); got.Kind != KindExecute {
		t.Fatalf("workspace go mode kind %s body %s", got.Kind, got.Result.Body)
	}

	for _, query := range []string{
		`mutation { deleteDashboard(id: "x") }`,
		`mutation { setUserActive(input: { userId: "u", isActive: true }) { id } }`,
		`query { me { id } alertRules { id } }`,
		`query { newsEvents { id } }`,
	} {
		if got := goEngine.PlanDocument(query, nil, nil); got.Kind != KindProtocol {
			t.Fatalf("%s kind %s body %s", query, got.Kind, got.Result.Body)
		}
	}
}

// TestFieldPermissionFailsClosed verifies that a guarded nested field is
// rejected with FORBIDDEN when the caller lacks the permission and still
// projects when the permission is present.
func TestFieldPermissionFailsClosed(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	reg.RegisterType("UserModel", guardedUserModel{})
	reg.RegisterFieldPermission("UserModel", "roleIds", "users.read")
	reg.RegisterRoot(contract.Root{
		Name:               "me",
		AllowAuthenticated: true,
		Resolve: func(contract.Context) (any, error) {
			return guardedUserModel{ID: "u1", RoleIDs: []string{"r1"}}, nil
		},
	})
	engine := New(loaded, reg, 8, 2000, nil)
	identity := contract.Identity{UserID: "u1", OrgID: "o1"}

	guarded := engine.PlanDocument(`query { me { id roleIds } }`, nil, nil)
	if guarded.Kind != KindExecute {
		t.Fatalf("guarded plan kind %s", guarded.Kind)
	}
	result := engine.Execute(context.Background(), guarded, func(context.Context, string, string) (contract.Identity, error) {
		return identity, nil
	}, nil, false, 30, "schema", "")
	if result.Status != 403 || !strings.Contains(string(result.Body), "FORBIDDEN") {
		t.Fatalf("guarded field status %d body %s", result.Status, result.Body)
	}

	allowed := engine.PlanDocument(`query { me { id roleIds } }`, nil, nil)
	withPermission := contract.Identity{UserID: "u1", OrgID: "o1", Permissions: map[string]bool{"users.read": true}}
	result = engine.Execute(context.Background(), allowed, func(context.Context, string, string) (contract.Identity, error) {
		return withPermission, nil
	}, nil, false, 30, "schema", "")
	if result.Status != 200 || !strings.Contains(string(result.Body), `"roleIds"`) || strings.Contains(string(result.Body), "errors") {
		t.Fatalf("granted field status %d body %s", result.Status, result.Body)
	}
}

type guardedUserModel struct {
	ID      string   `graphql:"id"`
	RoleIDs []string `graphql:"roleIds"`
}

// TestSettingsCrawlRootsPlanToExecute pins the ownership decision for the
// twenty settings center, source policy, sync status, review queue and crawl
// task roots: every one of them must be planned as an executable Go query when
// only this package is registered. crawlMetadata stays unowned because it
// fetches the public internet, and every mutation stays on NestJS.
func TestSettingsCrawlRootsPlanToExecute(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	settingscrawl.Register(reg, nil, settingscrawl.Options{})
	engine := New(loaded, reg, 8, 2000, nil)

	owned := []string{
		`query { rateLimitSettings { login { limit windowSeconds } crawlCreate { limit } rbacWrite { windowSeconds } } }`,
		`query { entityImpactGraphSettings { enabled categories cacheTtlSeconds } }`,
		`query { knowledgeGraphSettings { enabled ingestionEnabled minEdgeConfidence } }`,
		`query { newsEventSettings { enabled clusteringMode forceMinAuthoritativeSources } }`,
		`query { newsEventSourcePolicy { activeRevision authoritativeDomains overrides { blogDomainsAdd } warnings { hasConflicts domainConflicts } revisions { revision operation delta { blogLabelsAdd } } syncWarnings updatedAt } }`,
		`query { newsEventSourcePolicyPresets { authoritativeLabels blogLabels categoryAuthority { categoryPrefix domainBoosts { domain delta } } updatedAt syncWarnings } }`,
		`query { newsEventSourcePolicyRevisionDiff(baseRevision: 1, targetRevision: 2) { baseRevision targetRevision blogDomainsAdd blogDomainsRemove } }`,
		`query { newsClassificationSettings { enabled taxonomyVersion taxonomy { path displayName keywords synonyms } llmModel } }`,
		`query { classificationQualitySettings { lowConfidenceThreshold reportMinPairCount cacheTtlSeconds } }`,
		`query { newsDedupeSettings { defaultThreshold scopedThresholds { sourceId language categoryPath threshold } llmJudgeModel } }`,
		`query { newsIndicatorSettings { enabled indicatorSlugs windowDays backtestHoldoutDays } }`,
		`query { authCacheSettings { profileTtlSeconds lockTtlMs maxWaitMs retryDelayMs } }`,
		`query { crawlClientSettings { requestTimeoutMs requestTimeoutNormalMs adaptiveConcurrencyEnabled } }`,
		`query { auditLogRetention { retentionDays } }`,
		`query { newsExtractionSettings { pipelineMode preflightGate { enabled minWordCount } postCleanGate { requireSummary } capabilities { kg } providers { clean entities sentiment kg } } }`,
		`query { newsPromptConfig { version systemPromptTemplate userPromptTemplate kgUserPromptTemplate } }`,
		`query { newsEventSourcePolicySyncStatus { degraded policyCacheStale presetCacheStale warningCodes forceAuthoritativeMode forceMinAuthoritativeSources } }`,
		`query { knowledgeGraphEvidenceReviewQueue(limit: 5, maxConfidence: 0.9, onlyUnreviewed: true) { id confidence createdAt extractorVersion evidence edge { id type confidence weight properties fromEntity { id name type properties } toEntity { id name } } article { id url title summary language crawlAt } } }`,
		`query { crawlTasks(first: 5, status: completed) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { id status targetUrl keywords memoryStats { peakMemoryMb } lastRunSummary { inserted } results { id sourceUrl tables linkAnalysis { stats { totalLinks } buckets { kind links { href } } topLinks { href } lowQualityLinks { href } } } } } } }`,
		`query { crawlTask(id: "task-1", resultLimit: 5) { id status config results { id metadata media mediaAssets } } }`,
	}
	for _, query := range owned {
		plan := engine.PlanDocument(query, nil, nil)
		if plan.Kind != KindExecute {
			t.Fatalf("query %s planned as %s", query, plan.Kind)
		}
	}

	legacy := []string{
		// crawlMetadata fetches crawl4ai over the network and is not migrated.
		`query { crawlMetadata(input: { url: "https://example.com" }) { url } }`,
		// alertRules can enqueue a BullMQ job when a default rule is missing.
		`query { alertRules { id } }`,
		// Any mutation stays on NestJS.
		`mutation { updateRateLimitSettings(input: { login: { limit: 5, windowSeconds: 60 }, crawlCreate: { limit: 5, windowSeconds: 60 }, rbacWrite: { limit: 5, windowSeconds: 60 } }) { login { limit } } }`,
	}
	for _, query := range legacy {
		plan := engine.PlanDocument(query, nil, nil)
		if plan.Kind != KindProtocol {
			t.Fatalf("query %s planned as %s", query, plan.Kind)
		}
	}

	// A document mixing a migrated root with an unregistered one must fall back
	// as a whole, so a partial ownership never runs.
	mixed := engine.PlanDocument(`query { rateLimitSettings { login { limit } } crawlMetadata(input: { url: "https://example.com" }) { url } }`, nil, nil)
	if mixed.Kind != KindProtocol {
		t.Fatalf("mixed document planned as %s", mixed.Kind)
	}
}

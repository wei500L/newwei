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
	if mixed.Kind != KindLegacy {
		t.Fatalf("mixed query kind %s", mixed.Kind)
	}
	skipped := engine.PlanDocument(`query { alertRules @skip(if: true) { id } alertChannels { id } }`, nil, nil)
	if skipped.Kind != KindLegacy {
		t.Fatalf("@skip on an unmigrated field kind %s", skipped.Kind)
	}
	mutation := engine.PlanDocument(`mutation { markAllNotificationsRead }`, nil, nil)
	if mutation.Kind != KindLegacy {
		t.Fatalf("mutation kind %s", mutation.Kind)
	}
	name := "Moved"
	multi := engine.PlanDocument(`query Moved { alertChannels { id } } mutation Other { markAllNotificationsRead }`, &name, nil)
	if multi.Kind != KindExecute {
		t.Fatalf("selected migrated query kind %s", multi.Kind)
	}
	other := "Other"
	selectedMutation := engine.PlanDocument(`query Moved { alertChannels { id } } mutation Other { markAllNotificationsRead }`, &other, nil)
	if selectedMutation.Kind != KindLegacy {
		t.Fatalf("selected mutation kind %s", selectedMutation.Kind)
	}
	ambiguous := engine.PlanDocument(`query A { alertChannels { id } } query B { alertChannels { name } }`, nil, nil)
	if ambiguous.Kind != KindProtocol || !strings.Contains(string(ambiguous.Result.Body), "Must provide operation name") {
		t.Fatalf("ambiguous body %s", ambiguous.Result.Body)
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
		if got := engine.PlanDocument(query, nil, nil); got.Kind != KindLegacy {
			t.Fatalf("%s kind %s", query, got.Kind)
		}
	}

	// API_GO_GRAPHQL_READ_MODE=go 且 API_GO_GRAPHQL_NEWS_EVENTS_MODE=legacy：
	// 不登记新闻事件 root。只含 newsEvents 的文档整包回 Nest，上面的 16 个 query 仍由 Go 执行。
	newsOnly := engine.PlanDocument(`query { newsEvents { id } }`, nil, nil)
	if newsOnly.Kind != KindLegacy {
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
	newsevents.Register(reg, nil, nil, nil)
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
	if mixed.Kind != KindLegacy {
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
	if got := legacyEngine.PlanDocument(six, nil, nil); got.Kind != KindLegacy {
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
		if got := goEngine.PlanDocument(query, nil, nil); got.Kind != KindLegacy {
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
	if got := legacyEngine.PlanDocument(twelve, nil, nil); got.Kind != KindLegacy {
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
		if got := goEngine.PlanDocument(query, nil, nil); got.Kind != KindLegacy {
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

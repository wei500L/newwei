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
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
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

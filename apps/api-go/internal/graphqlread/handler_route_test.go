package graphqlread

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicators"
)

func TestHandlerExecutesRegisteredAndForwardsUnregistered(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	var forwarded int
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			forwarded++
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"upstream":"nest"}`))
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	post := func(body string) (int, string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "http://gateway/graphql", strings.NewReader(body))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		before := forwarded
		handler.ServeHTTP(rec, req)
		if forwarded != before && strings.Contains(rec.Body.String(), `"upstream":"nest"`) {
			return rec.Code, "forwarded"
		}
		if forwarded != before {
			t.Fatalf("legacy called but body = %s", rec.Body.String())
		}
		return rec.Code, rec.Body.String()
	}

	if _, body := post(`{"query":"{ alertChannels { id } }"}`); body == "forwarded" || strings.Contains(body, "take must be a non-negative integer") {
		t.Fatalf("registered query was not executed by Go: %s", body)
	}
	for _, body := range []string{
		`{"query":"{ alertRules { id } }"}`,
		`{"query":"mutation { markAllNotificationsRead }"}`,
		`{"query":"{ newsEvents { id } }"}`,
		`{"query":"{ alertChannels { id } alertRules { id } }"}`,
		`[{"query":"{ alertChannels { id } }"}]`,
	} {
		if _, got := post(body); got != "forwarded" {
			t.Fatalf("body %s was not forwarded: %s", body, got)
		}
	}
	if _, body := post(`{"query":"{ notifications(limit: -1) { id } }"}`); body == "forwarded" || strings.Contains(body, "take must be a non-negative integer") {
		t.Fatalf("negative notification limit = %s", body)
	}
}

func TestKnowledgeGraphRegistrationChangesOnlyThoseDocuments(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	var forwarded int
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			forwarded++
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"upstream":"nest"}`))
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	post := func(body string) (bool, string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "http://gateway/graphql", strings.NewReader(body))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		before := forwarded
		handler.ServeHTTP(rec, req)
		return forwarded != before, rec.Body.String()
	}

	legacyDocument := `{"query":"{ getKnowledgeGraphSubgraph(input: { seedName: \"600519\" }) { seed { id } } }"}`
	if wasForwarded, _ := post(legacyDocument); !wasForwarded {
		t.Fatal("knowledge graph legacy mode did not forward")
	}

	knowledgegraph.Register(reg, nil, nil)
	if wasForwarded, _ := post(legacyDocument); wasForwarded {
		t.Fatal("knowledge graph go mode was forwarded")
	}
	if wasForwarded, body := post(`{"query":"{ getKnowledgeGraphSubgraph(input: { seedName: \"600519\" }) { seed { id } } getEntityImpactGraph { nodes { id } } }"}`); !wasForwarded {
		t.Fatalf("mixed impact document was executed by Go: %s", body)
	}
	if wasForwarded, _ := post(`{"query":"{ entityIntelligenceCard(input: { entityId: \"x\" }) { entity { id } } knowledgeGraphEvidenceReviewQueue { id } }"}`); !wasForwarded {
		t.Fatal("review queue mix was executed by Go")
	}
	if wasForwarded, _ := post(`{"query":"{ alertChannels { id } }"}`); wasForwarded {
		t.Fatal("alertChannels was forwarded")
	}
}

func TestNewsEventsRegistrationChangesOnlyThoseDocuments(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	newsevents.Register(reg, nil, nil, nil)
	var forwarded int
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			forwarded++
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"upstream":"nest"}`))
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	post := func(body string) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "http://gateway/graphql", strings.NewReader(body))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		before := forwarded
		handler.ServeHTTP(rec, req)
		if forwarded != before {
			return "forwarded"
		}
		return rec.Body.String()
	}
	if got := post(`{"query":"{ newsEvents { id } }"}`); got == "forwarded" {
		t.Fatal("registered newsEvents was forwarded")
	}
	if got := post(`{"query":"{ alertChannels { id } }"}`); got == "forwarded" {
		t.Fatal("alertChannels was forwarded")
	}
	if got := post(`{"query":"{ newsEvents { id } newsEventSourcePolicySyncStatus { degraded } }"}`); got != "forwarded" {
		t.Fatalf("mixed source-policy document = %s", got)
	}
}

func TestNewsIndicatorRegistrationChangesOnlyThoseDocuments(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	newsindicators.Register(reg, nil)
	var forwarded int
	handler, err := NewHandler(Options{
		Registry: reg,
		Legacy: func(w http.ResponseWriter, _ *http.Request) {
			forwarded++
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"upstream":"nest"}`))
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	post := func(body string) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "http://gateway/graphql", strings.NewReader(body))
		req.Header.Set("content-type", "application/json")
		rec := httptest.NewRecorder()
		before := forwarded
		handler.ServeHTTP(rec, req)
		if forwarded != before {
			return "forwarded"
		}
		return rec.Body.String()
	}
	if got := post(`{"query":"{ newsIndicatorAssociations { id } }"}`); got == "forwarded" {
		t.Fatal("registered newsIndicatorAssociations was forwarded")
	}
	if got := post(`{"query":"{ newsIndicatorAssociation(id: \"assoc-1\") { id } }"}`); got == "forwarded" {
		t.Fatal("registered newsIndicatorAssociation was forwarded")
	}
	if got := post(`{"query":"{ newsIndicatorSettings { enabled } }"}`); got != "forwarded" {
		t.Fatalf("unregistered newsIndicatorSettings = %s", got)
	}
	if got := post(`{"query":"{ newsIndicatorAssociations { id } newsIndicatorSettings { enabled } }"}`); got != "forwarded" {
		t.Fatalf("mixed settings document = %s", got)
	}
}

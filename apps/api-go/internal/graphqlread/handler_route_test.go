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

const notSupportedMessage = "Operation is not supported by the Go GraphQL executor"

func postBody(t *testing.T, handler *Handler, body string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "http://gateway/graphql", strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestHandlerExecutesRegisteredAndRejectsUnregistered(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	handler, err := NewHandler(Options{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}

	if _, body := postBody(t, handler, `{"query":"{ alertChannels { id } }"}`); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("registered query was rejected by Go: %s", body)
	}
	for _, body := range []string{
		`{"query":"{ alertRules { id } }"}`,
		`{"query":"mutation { markAllNotificationsRead }"}`,
		`{"query":"{ newsEvents { id } }"}`,
		`{"query":"{ alertChannels { id } alertRules { id } }"}`,
	} {
		code, got := postBody(t, handler, body)
		if code != http.StatusOK {
			t.Fatalf("body %s status = %d, want 200 protocol rejection: %s", body, code, got)
		}
		if !strings.Contains(got, notSupportedMessage) {
			t.Fatalf("body %s was not rejected with a GraphQL error: %s", body, got)
		}
	}

	// A batched (JSON array) request is not handled locally and must not be
	// forwarded to NestJS; it is rejected as a protocol error.
	if code, got := postBody(t, handler, `[{"query":"{ alertChannels { id } }"}]`); code != http.StatusBadRequest || !strings.Contains(got, `"errors"`) {
		t.Fatalf("batch request = %d %s, want 400 GraphQL errors", code, got)
	}

	if _, body := postBody(t, handler, `{"query":"{ notifications(limit: -1) { id } }"}`); strings.Contains(body, "take must be a non-negative integer") {
		t.Fatalf("negative notification limit = %s", body)
	}
}

func TestKnowledgeGraphRegistrationChangesOnlyThoseDocuments(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	handler, err := NewHandler(Options{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}

	legacyDocument := `{"query":"{ getKnowledgeGraphSubgraph(input: { seedName: \"600519\" }) { seed { id } } }"}`
	if _, body := postBody(t, handler, legacyDocument); !strings.Contains(body, notSupportedMessage) {
		t.Fatalf("unregistered knowledge graph document was not rejected: %s", body)
	}

	knowledgegraph.Register(reg, nil, nil)
	if _, body := postBody(t, handler, legacyDocument); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("registered knowledge graph document was rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ getKnowledgeGraphSubgraph(input: { seedName: \"600519\" }) { seed { id } } getEntityImpactGraph { nodes { id } } }"}`); !strings.Contains(body, notSupportedMessage) {
		t.Fatalf("mixed impact document was not rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ entityIntelligenceCard(input: { entityId: \"x\" }) { entity { id } } knowledgeGraphEvidenceReviewQueue { id } }"}`); !strings.Contains(body, notSupportedMessage) {
		t.Fatalf("review queue mix was not rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ alertChannels { id } }"}`); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("alertChannels was rejected: %s", body)
	}
}

func TestNewsEventsRegistrationChangesOnlyThoseDocuments(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	newsevents.Register(reg, nil, nil, nil, newsevents.Options{BriefEnabled: true})
	handler, err := NewHandler(Options{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	if _, body := postBody(t, handler, `{"query":"{ newsEvents { id } }"}`); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("registered newsEvents was rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ alertChannels { id } }"}`); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("alertChannels was rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ newsEvents { id } newsEventSourcePolicySyncStatus { degraded } }"}`); !strings.Contains(body, notSupportedMessage) {
		t.Fatalf("mixed source-policy document was not rejected: %s", body)
	}
}

func TestNewsIndicatorRegistrationChangesOnlyThoseDocuments(t *testing.T) {
	reg := contract.NewRegistry()
	alerts.Register(reg, nil)
	history.Register(reg, nil, nil, nil)
	economic.Register(reg, nil)
	newsindicators.Register(reg, nil)
	handler, err := NewHandler(Options{Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	if _, body := postBody(t, handler, `{"query":"{ newsIndicatorAssociations { id } }"}`); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("registered newsIndicatorAssociations was rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ newsIndicatorAssociation(id: \"assoc-1\") { id } }"}`); strings.Contains(body, notSupportedMessage) {
		t.Fatalf("registered newsIndicatorAssociation was rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ newsIndicatorSettings { enabled } }"}`); !strings.Contains(body, notSupportedMessage) {
		t.Fatalf("unregistered newsIndicatorSettings was not rejected: %s", body)
	}
	if _, body := postBody(t, handler, `{"query":"{ newsIndicatorAssociations { id } newsIndicatorSettings { enabled } }"}`); !strings.Contains(body, notSupportedMessage) {
		t.Fatalf("mixed settings document was not rejected: %s", body)
	}
}

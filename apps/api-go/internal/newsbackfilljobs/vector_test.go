package newsbackfilljobs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
)

type fakeVectorConfig struct {
	cfg infrastructuresettings.VectorRuntimeConfig
	err error
}

func (f fakeVectorConfig) VectorRuntimeConfig(context.Context) (infrastructuresettings.VectorRuntimeConfig, error) {
	return f.cfg, f.err
}

func vectorRequest() newsnowclusteringops.SummaryVectorSearchRequest {
	return newsnowclusteringops.SummaryVectorSearchRequest{
		OrgID:          "org-1",
		EmbeddingModel: "text-embedding-3-small",
		Vector:         []float64{0.1, 0.2, 0.3},
		Limit:          50,
		MinScore:       0.82,
		Lookback:       30 * 24 * time.Hour,
	}
}

func TestVectorSearcherSendsTheNestJSRequest(t *testing.T) {
	var gotPath string
	var gotToken string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("x-internal-token")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"collection":"processed_item_summary","matches":[{"processedItemId":" item-2 ","itemMetaId":"meta-2","score":0.91,"createdAtMs":1},{"processedItemId":"item-3","itemMetaId":"meta-3","score":0.88,"createdAtMs":2}]}`))
	}))
	defer server.Close()

	searcher := NewVectorSearcher(fakeVectorConfig{cfg: infrastructuresettings.VectorRuntimeConfig{
		Enabled:    true,
		BaseURL:    server.URL + "/",
		Token:      "internal-token",
		TimeoutMs:  5000,
		MaxRetries: 0,
	}})
	matches, err := searcher.SearchSummaryVectors(context.Background(), vectorRequest())
	if err != nil {
		t.Fatalf("SearchSummaryVectors: %v", err)
	}
	if gotPath != "/v1/search" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotToken != "internal-token" {
		t.Fatalf("token = %q", gotToken)
	}
	if gotBody["orgId"] != "org-1" || gotBody["embeddingModel"] != "text-embedding-3-small" ||
		gotBody["minScore"] != 0.82 || gotBody["limit"] != float64(50) {
		t.Fatalf("body = %+v", gotBody)
	}
	if loan, ok := gotBody["lookbackMs"].(float64); !ok || int64(loan) != (30*24*time.Hour).Milliseconds() {
		t.Fatalf("lookbackMs = %v", gotBody["lookbackMs"])
	}
	if len(matches) != 2 || matches[0].ProcessedItemID != "item-2" || matches[0].Score != 0.91 {
		t.Fatalf("matches = %+v", matches)
	}
}

func TestVectorSearcherReturnsNoCandidatesWhenDisabled(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"collection":"c","matches":[]}`))
	}))
	defer server.Close()

	searcher := NewVectorSearcher(fakeVectorConfig{cfg: infrastructuresettings.VectorRuntimeConfig{
		Enabled: false,
		BaseURL: server.URL,
		Token:   "token",
	}})
	matches, err := searcher.SearchSummaryVectors(context.Background(), vectorRequest())
	if err != nil || matches != nil {
		t.Fatalf("matches=%v err=%v", matches, err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestVectorSearcherRetriesServerErrors(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"collection":"c","matches":[]}`))
	}))
	defer server.Close()

	searcher := NewVectorSearcher(fakeVectorConfig{cfg: infrastructuresettings.VectorRuntimeConfig{
		Enabled:    true,
		BaseURL:    server.URL,
		Token:      "token",
		TimeoutMs:  5000,
		MaxRetries: 1,
	}})
	matches, err := searcher.SearchSummaryVectors(context.Background(), vectorRequest())
	if err != nil {
		t.Fatalf("SearchSummaryVectors: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("matches = %+v", matches)
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestVectorSearcherDoesNotRetryAuthFailures(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	searcher := NewVectorSearcher(fakeVectorConfig{cfg: infrastructuresettings.VectorRuntimeConfig{
		Enabled:    true,
		BaseURL:    server.URL,
		Token:      "token",
		TimeoutMs:  5000,
		MaxRetries: 2,
	}})
	if _, err := searcher.SearchSummaryVectors(context.Background(), vectorRequest()); err == nil {
		t.Fatal("expected an error")
	}
	if requests != 1 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestVectorSearcherRejectsMalformedPayloadWithoutRetry(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"collection":"","matches":[]}`))
	}))
	defer server.Close()

	searcher := NewVectorSearcher(fakeVectorConfig{cfg: infrastructuresettings.VectorRuntimeConfig{
		Enabled:    true,
		BaseURL:    server.URL,
		Token:      "token",
		TimeoutMs:  5000,
		MaxRetries: 2,
	}})
	if _, err := searcher.SearchSummaryVectors(context.Background(), vectorRequest()); err == nil {
		t.Fatal("expected an error")
	}
	if requests != 1 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestVectorSearcherWithoutSettingsReturnsNoCandidates(t *testing.T) {
	searcher := NewVectorSearcher(nil)
	matches, err := searcher.SearchSummaryVectors(context.Background(), vectorRequest())
	if err != nil || matches != nil {
		t.Fatalf("matches=%v err=%v", matches, err)
	}
}

package newseventsingest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestVectorSearchRequestShape locks the POST /v1/search body and headers
// against the @modular/vector-client contract.
func TestVectorSearchRequestShape(t *testing.T) {
	var captured struct {
		path  string
		token string
		body  struct {
			OrgID          string    `json:"orgId"`
			EmbeddingModel string    `json:"embeddingModel"`
			Vector         []float64 `json:"vector"`
			Limit          int       `json:"limit"`
			MinScore       float64   `json:"minScore"`
			LookbackMs     int64     `json:"lookbackMs"`
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		captured.path = request.URL.Path
		captured.token = request.Header.Get("x-internal-token")
		if err := json.NewDecoder(request.Body).Decode(&captured.body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"collection":"items","matches":[{"processedItemId":"675f1f2e9d3c4b5a6e7f8a90","itemMetaId":"m1","score":0.93,"createdAtMs":1700000000000}]}`))
	}))
	defer server.Close()

	searcher := NewVectorSearcher(VectorSearcherOptions{
		Enabled:    true,
		BaseURL:    server.URL + "/",
		Token:      "vector-secret",
		TimeoutMs:  2000,
		MaxRetries: 0,
	})
	matches, ok := searcher.SearchBestEffort(context.Background(), VectorSearchRequest{
		OrgID:          "org_1",
		EmbeddingModel: "text-embedding-3-small",
		Vector:         []float64{0.1, 0.2},
		Limit:          50,
		MinScore:       0.82,
		LookbackMs:     30 * 24 * 60 * 60 * 1000,
	})
	if !ok {
		t.Fatal("search reported unavailable")
	}
	if captured.path != "/v1/search" || captured.token != "vector-secret" {
		t.Fatalf("path/token = %q/%q", captured.path, captured.token)
	}
	if captured.body.OrgID != "org_1" || captured.body.EmbeddingModel != "text-embedding-3-small" {
		t.Fatalf("body identity = %+v", captured.body)
	}
	if captured.body.Limit != 50 || captured.body.MinScore != 0.82 || captured.body.LookbackMs != 2592000000 {
		t.Fatalf("body options = %+v", captured.body)
	}
	if len(captured.body.Vector) != 2 || captured.body.Vector[0] != 0.1 {
		t.Fatalf("vector = %#v", captured.body.Vector)
	}
	if len(matches) != 1 || matches[0].ProcessedItemID != "675f1f2e9d3c4b5a6e7f8a90" || matches[0].Score != 0.93 {
		t.Fatalf("matches = %#v", matches)
	}
}

// TestVectorSearchBestEffortReturnsUnavailable locks the best-effort contract:
// disabled, incomplete, 401, 5xx and malformed payloads all return
// nil-and-false, which the assignment treats as an empty match list.
func TestVectorSearchBestEffortReturnsUnavailable(t *testing.T) {
	request := VectorSearchRequest{OrgID: "org_1", EmbeddingModel: "m", Vector: []float64{1}, Limit: 50}

	if _, ok := NewVectorSearcher(VectorSearcherOptions{Enabled: false}).SearchBestEffort(context.Background(), request); ok {
		t.Fatal("disabled service reported available")
	}
	if _, ok := NewVectorSearcher(VectorSearcherOptions{Enabled: true, BaseURL: "http://127.0.0.1:1"}).SearchBestEffort(context.Background(), request); ok {
		t.Fatal("missing token reported available")
	}

	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"unauthorized", http.StatusUnauthorized, `{"detail":"no"}`},
		{"server error", http.StatusServiceUnavailable, `{"detail":"down"}`},
		{"bad payload", http.StatusOK, `{"matches":[]}`},
		{"blank id", http.StatusOK, `{"collection":"c","matches":[{"processedItemId":"","itemMetaId":"m","score":1,"createdAtMs":1}]}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.WriteHeader(testCase.status)
				_, _ = writer.Write([]byte(testCase.body))
			}))
			defer server.Close()
			searcher := NewVectorSearcher(VectorSearcherOptions{
				Enabled:    true,
				BaseURL:    server.URL,
				Token:      "t",
				TimeoutMs:  1000,
				MaxRetries: 0,
			})
			if _, ok := searcher.SearchBestEffort(context.Background(), request); ok {
				t.Fatalf("%s reported available", testCase.name)
			}
		})
	}
}

// TestVectorSearchRetriesServerErrors locks the VectorClient retry policy: 5xx is
// retried up to maxRetries, a bad payload is final.
func TestVectorSearchRetriesServerErrors(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if calls.Add(1) == 1 {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"collection":"items","matches":[]}`))
	}))
	defer server.Close()

	searcher := NewVectorSearcher(VectorSearcherOptions{
		Enabled:    true,
		BaseURL:    server.URL,
		Token:      "t",
		TimeoutMs:  1000,
		MaxRetries: 1,
	})
	matches, ok := searcher.SearchBestEffort(context.Background(), VectorSearchRequest{OrgID: "org_1", EmbeddingModel: "m"})
	if !ok {
		t.Fatal("retry did not reach the healthy response")
	}
	if len(matches) != 0 {
		t.Fatalf("matches = %#v, want empty", matches)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2", calls.Load())
	}
}

// TestVectorEnvDefaults locks the environment projection, including the
// trailing-slash normalization.
func TestVectorEnvDefaults(t *testing.T) {
	searcher := &vectorSearcher{options: VectorSearcherOptions{
		Enabled:         true,
		FallbackToMongo: true,
		BaseURL:         " http://vector:8080/ ",
		Token:           "  token  ",
		TimeoutMs:       2500,
		MaxRetries:      3,
	}, now: func() time.Time { return fixedNow }, http: &http.Client{}}
	config := searcher.envDefaults()
	if !config.Enabled || !config.FallbackToMongo {
		t.Fatalf("flags = %+v", config)
	}
	if config.BaseURL != "http://vector:8080" {
		t.Fatalf("base url = %q", config.BaseURL)
	}
	if config.Token != "token" {
		t.Fatalf("token = %q", config.Token)
	}
	if config.Timeout != 2500*time.Millisecond || config.MaxRetries != 3 {
		t.Fatalf("timeout/retries = %v/%d", config.Timeout, config.MaxRetries)
	}
}

// TestJSNumberCoercion locks the stored-value coercion the vector settings use.
func TestJSNumberCoercion(t *testing.T) {
	cases := []struct {
		raw string
		got float64
		ok  bool
	}{
		{`5`, 5, true},
		{`"7.5"`, 7.5, true},
		{`true`, 1, true},
		{`false`, 0, true},
		{`null`, 0, false},
		{`"abc"`, 0, false},
		{``, 0, false},
	}
	for _, testCase := range cases {
		got, ok := jsNumberCoercion(json.RawMessage(testCase.raw))
		if ok != testCase.ok || (ok && got != testCase.got) {
			t.Fatalf("%q => %v,%v want %v,%v", testCase.raw, got, ok, testCase.got, testCase.ok)
		}
	}
	if value, ok := jsPositiveInt(json.RawMessage(`"0"`)); ok || value != 0 {
		t.Fatalf("jsPositiveInt(0) = %v,%v", value, ok)
	}
	if value, ok := jsNonNegativeInt(json.RawMessage(`"0"`)); !ok || value != 0 {
		t.Fatalf("jsNonNegativeInt(0) = %v,%v", value, ok)
	}
}

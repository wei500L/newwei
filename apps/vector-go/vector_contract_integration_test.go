//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/vector-go/internal/httpapi"
	"github.com/wei500L/newwei/apps/vector-go/internal/qdrant"
)

// TestVectorContractIntegration is the Go single-end contract check that replaced
// the retired NestJS-vs-vector-go differential. It drives the exact httpapi
// handler that main.go serves against a real Qdrant service and asserts the
// saved contract independently (expected status codes, body shapes and orgId
// isolation are encoded here, not derived from the same request's response):
//
//   - GET  /healthz            -> 200 {"ok":true}
//   - POST /v1/upsert          -> requires x-internal-token; 201 on success
//   - POST /v1/search          -> requires x-internal-token; 201; orgId-filtered
//   - missing/invalid token    -> 401 NestJS error envelope
//   - invalid request body     -> 400 NestJS error envelope
//
// It runs only under -tags=integration because it needs a live Qdrant.
func TestVectorContractIntegration(t *testing.T) {
	qdrantURL := strings.TrimSpace(os.Getenv("QDRANT_URL"))
	if qdrantURL == "" {
		qdrantURL = "http://localhost:6333"
	}
	internalToken := strings.TrimSpace(os.Getenv("VECTOR_INTERNAL_TOKEN"))
	if internalToken == "" {
		internalToken = "integration-internal-token"
	}
	collectionPrefix := strings.TrimSpace(os.Getenv("VECTOR_COLLECTION_PREFIX"))
	if collectionPrefix == "" {
		collectionPrefix = "integration_processed"
	}

	// A per-run embedding model isolates this test's collection from any other
	// run: the collection name is derived from the model string.
	model := fmt.Sprintf("vector-contract-%d", time.Now().UnixNano())

	client := qdrant.New(qdrant.Options{
		BaseURL:          qdrantURL,
		APIKey:           strings.TrimSpace(os.Getenv("QDRANT_API_KEY")),
		TimeoutMs:        5000,
		CollectionPrefix: collectionPrefix,
	})
	server := httptest.NewServer(httpapi.New(httpapi.Deps{
		InternalToken: internalToken,
		Qdrant:        client,
	}))
	defer server.Close()

	type apiError struct {
		StatusCode int    `json:"statusCode"`
		Message    string `json:"message"`
		Error      string `json:"error"`
	}
	type upsertResult struct {
		Upserted   int    `json:"upserted"`
		Collection string `json:"collection"`
	}
	type match struct {
		ProcessedItemID string  `json:"processedItemId"`
		ItemMetaID      string  `json:"itemMetaId"`
		Score           float64 `json:"score"`
		CreatedAtMs     int64   `json:"createdAtMs"`
	}
	type searchResult struct {
		Collection string  `json:"collection"`
		Matches    []match `json:"matches"`
	}

	post := func(t *testing.T, path, token string, body any) (int, []byte) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s body: %v", path, err)
		}
		req, err := http.NewRequest(http.MethodPost, server.URL+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("new request %s: %v", path, err)
		}
		req.Header.Set("content-type", "application/json")
		if token != "" {
			req.Header.Set("x-internal-token", token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, out
	}

	decode := func(t *testing.T, raw []byte, into any) {
		t.Helper()
		if err := json.Unmarshal(raw, into); err != nil {
			t.Fatalf("decode %q: %v", string(raw), err)
		}
	}

	// --- GET /healthz: public, exact shape. ---
	resp, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	healthBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/healthz status = %d, want 200 (body %q)", resp.StatusCode, string(healthBody))
	}
	var health map[string]bool
	decode(t, healthBody, &health)
	if !health["ok"] {
		t.Fatalf("/healthz body = %q, want {\"ok\":true}", string(healthBody))
	}

	// --- Internal token guard: missing then invalid. ---
	status, raw := post(t, "/v1/upsert", "", map[string]any{"orgId": "org-a"})
	var missing apiError
	decode(t, raw, &missing)
	if status != http.StatusUnauthorized || missing.StatusCode != 401 || missing.Message != "Missing internal token" || missing.Error != "Unauthorized" {
		t.Fatalf("missing-token upsert = %d %q, want 401 Missing internal token", status, string(raw))
	}
	status, raw = post(t, "/v1/upsert", "wrong-token", map[string]any{"orgId": "org-a"})
	var invalid apiError
	decode(t, raw, &invalid)
	if status != http.StatusUnauthorized || invalid.Message != "Invalid internal token" {
		t.Fatalf("invalid-token upsert = %d %q, want 401 Invalid internal token", status, string(raw))
	}

	// --- Validation error: empty orgId. ---
	status, raw = post(t, "/v1/upsert", internalToken, map[string]any{"orgId": "", "embeddingModel": model, "points": []any{}})
	var badRequest apiError
	decode(t, raw, &badRequest)
	if status != http.StatusBadRequest || badRequest.Message != "Invalid upsert request" {
		t.Fatalf("invalid-body upsert = %d %q, want 400 Invalid upsert request", status, string(raw))
	}

	// --- Upsert org-a (2 points) and org-b (1 point). ---
	upsertA := map[string]any{
		"orgId":          "org-a",
		"embeddingModel": model,
		"points": []map[string]any{
			{"processedItemId": "a-1", "itemMetaId": "meta-a1", "createdAtMs": 1_700_000_000_000, "vector": []float64{1, 0, 0, 0}},
			{"processedItemId": "a-2", "itemMetaId": "meta-a2", "createdAtMs": 1_700_000_001_000, "vector": []float64{0.9, 0.1, 0, 0}},
		},
	}
	status, raw = post(t, "/v1/upsert", internalToken, upsertA)
	var resultA upsertResult
	decode(t, raw, &resultA)
	if status != http.StatusCreated || resultA.Upserted != 2 || resultA.Collection == "" {
		t.Fatalf("upsert org-a = %d %q, want 201 upserted=2", status, string(raw))
	}

	upsertB := map[string]any{
		"orgId":          "org-b",
		"embeddingModel": model,
		"points": []map[string]any{
			{"processedItemId": "b-1", "itemMetaId": "meta-b1", "createdAtMs": 1_700_000_002_000, "vector": []float64{1, 0, 0, 0}},
		},
	}
	status, raw = post(t, "/v1/upsert", internalToken, upsertB)
	var resultB upsertResult
	decode(t, raw, &resultB)
	if status != http.StatusCreated || resultB.Upserted != 1 {
		t.Fatalf("upsert org-b = %d %q, want 201 upserted=1", status, string(raw))
	}

	// --- Search org-a: only org-a points, exact match first. ---
	status, raw = post(t, "/v1/search", internalToken, map[string]any{
		"orgId":          "org-a",
		"embeddingModel": model,
		"vector":         []float64{1, 0, 0, 0},
		"limit":          10,
	})
	var found searchResult
	decode(t, raw, &found)
	if status != http.StatusCreated {
		t.Fatalf("search org-a = %d %q, want 201", status, string(raw))
	}
	if found.Collection != resultA.Collection {
		t.Fatalf("search collection %q != upsert collection %q", found.Collection, resultA.Collection)
	}
	if len(found.Matches) == 0 {
		t.Fatalf("search org-a returned no matches (body %q)", string(raw))
	}
	seen := map[string]bool{}
	for _, m := range found.Matches {
		seen[m.ProcessedItemID] = true
		if m.ProcessedItemID == "b-1" {
			t.Fatalf("search org-a leaked org-b point b-1: %q", string(raw))
		}
	}
	if !seen["a-1"] || !seen["a-2"] {
		t.Fatalf("search org-a missing own points, got %v (body %q)", seen, string(raw))
	}
	if found.Matches[0].ProcessedItemID != "a-1" || found.Matches[0].Score < 0.99 {
		t.Fatalf("search org-a top match = %+v, want a-1 with score ~1", found.Matches[0])
	}
	if found.Matches[0].ItemMetaID != "meta-a1" || found.Matches[0].CreatedAtMs != 1_700_000_000_000 {
		t.Fatalf("search org-a payload round-trip = %+v", found.Matches[0])
	}

	// --- Search validation error: empty vector. ---
	status, raw = post(t, "/v1/search", internalToken, map[string]any{
		"orgId":          "org-a",
		"embeddingModel": model,
		"vector":         []float64{},
	})
	var badSearch apiError
	decode(t, raw, &badSearch)
	if status != http.StatusBadRequest || badSearch.Message != "Invalid search request" {
		t.Fatalf("invalid search = %d %q, want 400 Invalid search request", status, string(raw))
	}
}

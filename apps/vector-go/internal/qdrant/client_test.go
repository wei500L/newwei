package qdrant

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// recordedRequest 记录发往 Qdrant 桩的请求（镜像 apps/vector qdrant.service.test.ts
// 通过 vi.stubGlobal('fetch') 捕获调用的方式）。
type recordedRequest struct {
	Method string
	Path   string
	Body   string
	Header http.Header
}

type recorder struct {
	mu       sync.Mutex
	requests []recordedRequest
}

func (rec *recorder) add(req recordedRequest) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rec.requests = append(rec.requests, req)
}

func (rec *recorder) find(method, pathContains string) *recordedRequest {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for i := range rec.requests {
		if rec.requests[i].Method == method && strings.Contains(rec.requests[i].Path, pathContains) {
			return &rec.requests[i]
		}
	}
	return nil
}

// newStub 启动记录型 Qdrant 桩：handler 决定业务响应。
func newStub(t *testing.T, handler http.HandlerFunc) (*recorder, *httptest.Server) {
	t.Helper()
	rec := &recorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.add(recordedRequest{Method: r.Method, Path: r.URL.Path, Body: string(body), Header: r.Header.Clone()})
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return rec, server
}

// existingCollection 返回「集合已存在且维度为 size」的桩处理器。
func existingCollection(size int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/collections/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"config": map[string]any{
						"params": map[string]any{"vectors": map[string]any{"size": size}},
					},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "result": []any{}})
	}
}

// autoCreateCollection 返回「GET 404 → 创建成功」的桩处理器。
func autoCreateCollection() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/collections/") {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"result": nil})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "result": []any{}})
	}
}

func testClient(baseURL, apiKey string) *Client {
	return New(Options{
		BaseURL:          baseURL,
		APIKey:           apiKey,
		TimeoutMs:        5000,
		CollectionPrefix: "processed_item_summary",
	})
}

// 镜像 TS 用例 1：search 按 orgId 过滤并发送 api-key 头。
func TestSearchFiltersByOrgIDAndSendsAPIKeyHeader(t *testing.T) {
	rec, server := newStub(t, existingCollection(2))
	client := testClient(server.URL, "qdrant-secret")

	if _, err := client.Search(t.Context(), SearchRequest{
		OrgID:          "org-42",
		EmbeddingModel: "text-embedding-3-small",
		Vector:         []float64{0.1, 0.2},
		Limit:          8,
	}); err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	search := rec.find(http.MethodPost, "/points/search")
	if search == nil {
		t.Fatal("expected a /points/search request to reach Qdrant")
	}
	if got := search.Header.Get("content-type"); got != "application/json" {
		t.Errorf("content-type = %q, want application/json", got)
	}
	if got := search.Header.Get("api-key"); got != "qdrant-secret" {
		t.Errorf("api-key = %q, want qdrant-secret", got)
	}
	var body struct {
		Filter struct {
			Must []struct {
				Key   string `json:"key"`
				Match struct {
					Value string `json:"value"`
				} `json:"match"`
			} `json:"must"`
		} `json:"filter"`
	}
	if err := json.Unmarshal([]byte(search.Body), &body); err != nil {
		t.Fatalf("search body not JSON: %v", err)
	}
	found := false
	for _, cond := range body.Filter.Must {
		if cond.Key == "orgId" && cond.Match.Value == "org-42" {
			found = true
		}
	}
	if !found {
		t.Errorf("filter.must missing orgId match for org-42: %s", search.Body)
	}
}

// 镜像 TS 用例 2：未配置 api-key 时不发送该头。
func TestSearchOmitsAPIKeyHeaderWhenUnset(t *testing.T) {
	rec, server := newStub(t, existingCollection(2))
	client := testClient(server.URL, "")

	if _, err := client.Search(t.Context(), SearchRequest{
		OrgID:          "org-7",
		EmbeddingModel: "text-embedding-3-small",
		Vector:         []float64{0.4, 0.5},
		Limit:          3,
	}); err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	search := rec.find(http.MethodPost, "/points/search")
	if search == nil {
		t.Fatal("expected a /points/search request to reach Qdrant")
	}
	if got := search.Header.Get("api-key"); got != "" {
		t.Errorf("api-key = %q, want absent", got)
	}
}

// upsert：确定性 point ID + payload 形状 + wait=true（走 404 → 创建链路）。
func TestUpsertSendsDeterministicPointsWithWait(t *testing.T) {
	rec, server := newStub(t, autoCreateCollection())
	client := testClient(server.URL, "")

	result, err := client.UpsertPoints(t.Context(), UpsertRequest{
		OrgID:          "org-1",
		EmbeddingModel: "text-embedding-3-small",
		Points: []Point{{
			ProcessedItemID: "p1",
			ItemMetaID:      "m1",
			CreatedAtMs:     42,
			Vector:          []float64{0.1, 0.2},
		}},
	})
	if err != nil {
		t.Fatalf("UpsertPoints() error = %v", err)
	}
	if result.Upserted != 1 {
		t.Errorf("Upserted = %d, want 1", result.Upserted)
	}
	if result.Collection != client.CollectionName("text-embedding-3-small") {
		t.Errorf("Collection = %q, want %q", result.Collection, client.CollectionName("text-embedding-3-small"))
	}

	upsert := rec.find(http.MethodPut, "/points")
	if upsert == nil {
		t.Fatal("expected PUT /collections/{name}/points?wait=true")
	}
	var body struct {
		Points []struct {
			ID      string    `json:"id"`
			Vector  []float64 `json:"vector"`
			Payload struct {
				OrgID           string `json:"orgId"`
				EmbeddingModel  string `json:"embeddingModel"`
				ProcessedItemID string `json:"processedItemId"`
				ItemMetaID      string `json:"itemMetaId"`
				CreatedAtMs     int64  `json:"createdAtMs"`
			} `json:"payload"`
		} `json:"points"`
	}
	if err := json.Unmarshal([]byte(upsert.Body), &body); err != nil {
		t.Fatalf("upsert body not JSON: %v", err)
	}
	if len(body.Points) != 1 {
		t.Fatalf("points len = %d, want 1", len(body.Points))
	}
	point := body.Points[0]
	if point.ID != StableUUID("text-embedding-3-small:p1") {
		t.Errorf("point id = %q, want deterministic StableUUID", point.ID)
	}
	if point.Payload.OrgID != "org-1" || point.Payload.ProcessedItemID != "p1" ||
		point.Payload.ItemMetaID != "m1" || point.Payload.CreatedAtMs != 42 {
		t.Errorf("payload mismatch: %+v", point.Payload)
	}

	// 创建链路应包含 collection PUT 与两个 payload 索引。
	if rec.find(http.MethodPut, "/index") == nil {
		t.Error("expected payload index creation requests")
	}
}

// 空 points：不触碰 Qdrant，直接返回（镜像 TS 早退）。
func TestUpsertEmptyPointsSkipsQdrant(t *testing.T) {
	rec, server := newStub(t, autoCreateCollection())
	client := testClient(server.URL, "")

	result, err := client.UpsertPoints(t.Context(), UpsertRequest{
		OrgID:          "org-1",
		EmbeddingModel: "m",
		Points:         nil,
	})
	if err != nil {
		t.Fatalf("UpsertPoints() error = %v", err)
	}
	if result.Upserted != 0 || result.Collection == "" {
		t.Errorf("unexpected result: %+v", result)
	}
	rec.mu.Lock()
	count := len(rec.requests)
	rec.mu.Unlock()
	if count != 0 {
		t.Errorf("empty upsert must not touch Qdrant, got %d requests", count)
	}
}

// 集合已存在但维度不符 → 报错（镜像 TS size mismatch）。
func TestEnsureCollectionRejectsSizeMismatch(t *testing.T) {
	_, server := newStub(t, existingCollection(3))
	client := testClient(server.URL, "")

	_, err := client.Search(t.Context(), SearchRequest{
		OrgID:          "org-1",
		EmbeddingModel: "text-embedding-3-small",
		Vector:         []float64{0.1, 0.2},
		Limit:          5,
	})
	if err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size mismatch error, got %v", err)
	}
}

// 检索结果：过滤字段缺失项 + 按 score 降序（镜像 TS 映射逻辑）。
func TestSearchParsesSortsAndFiltersMatches(t *testing.T) {
	_, server := newStub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/collections/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"config": map[string]any{"params": map[string]any{"vectors": map[string]any{"size": 2}}},
				},
			})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/points/search") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok",
				"result": []map[string]any{
					{"score": 0.42, "payload": map[string]any{"processedItemId": "low", "itemMetaId": "m", "createdAtMs": 1}},
					{"score": 0.91, "payload": map[string]any{"processedItemId": "high", "itemMetaId": "m", "createdAtMs": 2}},
					{"score": 0.7, "payload": map[string]any{"processedItemId": "no-meta"}},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "result": []any{}})
	})
	client := testClient(server.URL, "")

	result, err := client.Search(t.Context(), SearchRequest{
		OrgID:          "org-1",
		EmbeddingModel: "text-embedding-3-small",
		Vector:         []float64{0.1, 0.2},
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Matches) != 2 {
		t.Fatalf("matches len = %d, want 2 (invalid entry filtered)", len(result.Matches))
	}
	if result.Matches[0].ProcessedItemID != "high" || result.Matches[1].ProcessedItemID != "low" {
		t.Errorf("matches not sorted by score desc: %+v", result.Matches)
	}
}

// 确定性 UUID：与 TS stableUuidFromString 逐字节一致（version/variant 位）。
func TestStableUUIDDeterministicAndVersioned(t *testing.T) {
	first := StableUUID("text-embedding-3-small:p1")
	if first != StableUUID("text-embedding-3-small:p1") {
		t.Fatalf("StableUUID not deterministic: %s", first)
	}
	parts := strings.Split(first, "-")
	if len(parts) != 5 || len(first) != 36 {
		t.Fatalf("StableUUID shape invalid: %s", first)
	}
	if !strings.HasPrefix(parts[2], "4") {
		t.Errorf("StableUUID version nibble != 4: %s", first)
	}
	if !strings.ContainsRune("89ab", rune(parts[3][0])) {
		t.Errorf("StableUUID variant invalid: %s", first)
	}
	if StableUUID("a") == StableUUID("b") {
		t.Error("different inputs must produce different UUIDs")
	}
}

// 集合命名：prefix + sha256(lower-trim(model))[:16]。
func TestCollectionNameNormalizesModel(t *testing.T) {
	client := testClient("http://qdrant.local", "")
	normalized := client.CollectionName("text-embedding-3-small")
	if got := client.CollectionName("  TEXT-embedding-3-Small "); got != normalized {
		t.Errorf("collection name not normalized: %q vs %q", got, normalized)
	}
	if !strings.HasPrefix(normalized, "processed_item_summary_") {
		t.Errorf("collection name missing prefix: %q", normalized)
	}
	if len(normalized) != len("processed_item_summary_")+16 {
		t.Errorf("collection name hash length wrong: %q", normalized)
	}
}

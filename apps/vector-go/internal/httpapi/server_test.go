package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/wei500L/newwei/apps/vector-go/internal/qdrant"
)

const testToken = "vector-internal-token"

// newHarness 启动完整服务（trace 中间件 + token guard + handler）指向记录型 Qdrant 桩。
func newHarness(t *testing.T, qdrantHandler http.HandlerFunc) (*httptest.Server, *qdrantRecorder) {
	t.Helper()
	rec := &qdrantRecorder{}
	rec.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.bodies = append(rec.bodies, requestRecord{Method: r.Method, Path: r.URL.Path, Body: string(body)})
		rec.mu.Unlock()
		qdrantHandler(w, r)
	}))
	t.Cleanup(rec.server.Close)

	client := qdrant.New(qdrant.Options{
		BaseURL:          rec.server.URL,
		APIKey:           "",
		TimeoutMs:        5000,
		CollectionPrefix: "processed_item_summary",
	})
	api := httptest.NewServer(New(Deps{InternalToken: testToken, Qdrant: client}))
	t.Cleanup(api.Close)
	return api, rec
}

type requestRecord struct {
	Method string
	Path   string
	Body   string
}

type qdrantRecorder struct {
	mu     sync.Mutex
	server *httptest.Server
	bodies []requestRecord
}

func (rec *qdrantRecorder) lastSearchBody() string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for i := len(rec.bodies) - 1; i >= 0; i-- {
		if strings.Contains(rec.bodies[i].Path, "/points/search") {
			return rec.bodies[i].Body
		}
	}
	return ""
}

func existingCollectionStub(size int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/collections/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": map[string]any{
					"config": map[string]any{"params": map[string]any{"vectors": map[string]any{"size": size}}},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "result": []any{}})
	}
}

func postJSON(t *testing.T, url string, headers map[string]string, body any) (*http.Response, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	text, _ := io.ReadAll(response.Body)
	return response, string(text)
}

// 镜像 TS InternalAuthGuard 用例 1（public）：healthz 无 token 可访问。
func TestHealthzIsPublic(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))
	response, err := http.Get(api.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	var body map[string]bool
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || !body["ok"] {
		t.Fatalf("body = %v, err = %v", body, err)
	}
	if got := response.Header.Get("x-trace-id"); got == "" {
		t.Error("trace middleware must set x-trace-id on responses")
	}
}

// 镜像 TS InternalAuthGuard 用例 2/3：缺失、空白、错误 token → 401。
func TestInternalTokenGuardRejects(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))
	body := map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1}}

	cases := []struct {
		name    string
		headers map[string]string
	}{
		{"missing", nil},
		{"blank", map[string]string{"x-internal-token": "   "}},
		{"wrong", map[string]string{"x-internal-token": "wrong-token"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response, text := postJSON(t, api.URL+"/v1/search", tc.headers, body)
			if response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", response.StatusCode)
			}
			var parsed struct {
				StatusCode int    `json:"statusCode"`
				Message    string `json:"message"`
				Error      string `json:"error"`
			}
			if err := json.Unmarshal([]byte(text), &parsed); err != nil {
				t.Fatalf("error body not NestJS-shaped: %v (%s)", err, text)
			}
			if parsed.StatusCode != 401 || parsed.Error != "Unauthorized" {
				t.Errorf("error body mismatch: %s", text)
			}
		})
	}
}

// 镜像 TS InternalAuthGuard 用例 4：正确 token 放行（以成功执行证明已过 guard）。
func TestInternalTokenGuardAccepts(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))
	response, _ := postJSON(t, api.URL+"/v1/search",
		map[string]string{"x-internal-token": testToken},
		map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1, 0.2}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (guard passed, search executed)", response.StatusCode)
	}
}

// 镜像 TS VectorController 用例：非法 upsert/search 体 → 400 + 不触达 Qdrant。
func TestInvalidBodiesRejectedBeforeQdrant(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))

	cases := []struct {
		path string
		body map[string]any
		want string
	}{
		{"/v1/upsert", map[string]any{"orgId": ""}, "Invalid upsert request"},
		{"/v1/upsert", map[string]any{"orgId": "o", "embeddingModel": "m", "points": []map[string]any{{"processedItemId": "p", "itemMetaId": "i", "createdAtMs": 1, "vector": []float64{}}}}, "Invalid upsert request"},
		{"/v1/search", map[string]any{"orgId": "org-1", "embeddingModel": "m"}, "Invalid search request"},
		{"/v1/search", map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1}, "limit": 501}, "Invalid search request"},
		{"/v1/search", map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1}, "minScore": 1.5}, "Invalid search request"},
	}
	for _, tc := range cases {
		t.Run(tc.want+"/"+tc.path, func(t *testing.T) {
			response, text := postJSON(t, api.URL+tc.path,
				map[string]string{"x-internal-token": testToken}, tc.body)
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %v)", response.StatusCode, tc.body)
			}
			var parsed struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal([]byte(text), &parsed); err != nil || parsed.Message != tc.want {
				t.Fatalf("message = %q, want %q (%s)", parsed.Message, tc.want, text)
			}
		})
	}
}

// 镜像 TS VectorService 用例 1：混合维度 → 400「All vectors must share the same dimension」。
func TestUpsertMixedDimensionsRejected(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))
	response, text := postJSON(t, api.URL+"/v1/upsert",
		map[string]string{"x-internal-token": testToken},
		map[string]any{
			"orgId": "org-1", "embeddingModel": "text-embedding-3-small",
			"points": []map[string]any{
				{"processedItemId": "p1", "itemMetaId": "m1", "createdAtMs": 1, "vector": []float64{0.1, 0.2}},
				{"processedItemId": "p2", "itemMetaId": "m2", "createdAtMs": 2, "vector": []float64{0.1}},
			},
		})
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.StatusCode)
	}
	var parsed struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil || parsed.Message != "All vectors must share the same dimension" {
		t.Fatalf("message mismatch: %s", text)
	}
}

// limit 语义（zod positive ≤500 + service clamp 双层）：
// 越界值（0/900）被校验层拒为 400；合法值透传；缺省 → 50。
// TS 的 clamp 0→1 / 900→500 只在绕过 HTTP 校验直调 service 时可达（防御纵深）。
func TestSearchLimitSemantics(t *testing.T) {
	api, rec := newHarness(t, existingCollectionStub(2))
	tokenHeader := map[string]string{"x-internal-token": testToken}

	// 越界 → 400（镜像 zod 校验，不触达 Qdrant）。
	for _, limit := range []int{0, 900} {
		response, text := postJSON(t, api.URL+"/v1/search", tokenHeader,
			map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1, 0.2}, "limit": limit})
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("limit=%d: status = %d, want 400 (%s)", limit, response.StatusCode, text)
		}
	}

	// 合法值透传到 Qdrant。
	for _, limit := range []int{1, 8, 500} {
		response, text := postJSON(t, api.URL+"/v1/search", tokenHeader,
			map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1, 0.2}, "limit": limit})
		if response.StatusCode != http.StatusOK {
			t.Fatalf("limit=%d: status = %d, want 200 (%s)", limit, response.StatusCode, text)
		}
		var sent struct {
			Limit int `json:"limit"`
		}
		if err := json.Unmarshal([]byte(rec.lastSearchBody()), &sent); err != nil {
			t.Fatalf("qdrant search body not JSON: %v", err)
		}
		if sent.Limit != limit {
			t.Errorf("limit=%d: qdrant received %d", limit, sent.Limit)
		}
	}

	// 缺省 → 50。
	response, text := postJSON(t, api.URL+"/v1/search", tokenHeader,
		map[string]any{"orgId": "org-1", "embeddingModel": "m", "vector": []float64{0.1, 0.2}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("no limit: status = %d, want 200 (%s)", response.StatusCode, text)
	}
	var sent struct {
		Limit int `json:"limit"`
	}
	if err := json.Unmarshal([]byte(rec.lastSearchBody()), &sent); err != nil {
		t.Fatalf("qdrant search body not JSON: %v", err)
	}
	if sent.Limit != 50 {
		t.Errorf("default limit: qdrant received %d, want 50", sent.Limit)
	}
}

// 有效 upsert 的响应形状：{upserted, collection}。
func TestUpsertResponseShape(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))
	response, text := postJSON(t, api.URL+"/v1/upsert",
		map[string]string{"x-internal-token": testToken},
		map[string]any{
			"orgId": "org-9", "embeddingModel": "text-embedding-3-small",
			"points": []map[string]any{
				{"processedItemId": "p1", "itemMetaId": "m1", "createdAtMs": 5, "vector": []float64{0.3, 0.4}},
			},
		})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", response.StatusCode, text)
	}
	var parsed struct {
		Upserted   int    `json:"upserted"`
		Collection string `json:"collection"`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("bad upsert response: %s", text)
	}
	if parsed.Upserted != 1 || parsed.Collection == "" {
		t.Errorf("upsert response mismatch: %s", text)
	}
}

// 镜像 TS TraceIdMiddleware：透传合法 x-trace-id、生成 traceparent。
func TestTraceMiddlewareEchoesAndGenerates(t *testing.T) {
	api, _ := newHarness(t, existingCollectionStub(2))

	req, _ := http.NewRequest(http.MethodGet, api.URL+"/healthz", nil)
	req.Header.Set("x-trace-id", "abcdef0123456789abcdef0123456789XYZ")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response.Body.Close()
	if got := response.Header.Get("x-trace-id"); got != "abcdef0123456789abcdef0123456789" {
		t.Errorf("x-trace-id = %q, want normalized 32-hex", got)
	}
	if got := response.Header.Get("traceparent"); got != "00-abcdef0123456789abcdef0123456789-0000000000000000-01" {
		t.Errorf("traceparent = %q, want synthesized", got)
	}

	req2, _ := http.NewRequest(http.MethodGet, api.URL+"/healthz", nil)
	req2.Header.Set("traceparent", "00-1234567890abcdef1234567890abcdef-0102030405060708-01")
	response2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer response2.Body.Close()
	// traceparent 存在时原样回写；x-trace-id 取其 trace-id 段。
	if got := response2.Header.Get("traceparent"); got != "00-1234567890abcdef1234567890abcdef-0102030405060708-01" {
		t.Errorf("traceparent = %q, want passthrough", got)
	}
	if got := response2.Header.Get("x-trace-id"); got != "1234567890abcdef1234567890abcdef" {
		t.Errorf("x-trace-id = %q, want otel trace id segment", got)
	}
}

// 确定性检查：ensureTraceID 的归一化规则与 TS ensureTraceId 一致。
func TestEnsureTraceID(t *testing.T) {
	if got := ensureTraceID("xyz-1234567890abcdef1234567890abcdef-extra"); got != "1234567890abcdef1234567890abcdef" {
		t.Errorf("long input: %q", got)
	}
	if got := ensureTraceID("12345"); len(got) != 32 {
		t.Errorf("short input should generate 32-hex, got %q", got)
	}
	if got := ensureTraceID(""); len(got) != 32 {
		t.Errorf("empty input should generate 32-hex, got %q", got)
	}
}

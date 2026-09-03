package legacyproxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// legacyStub 记录到达 NestJS 替身的请求（方法/路径/头/体）。
type legacyStub struct {
	mu       sync.Mutex
	server   *httptest.Server
	requests []recordedRequest
}

type recordedRequest struct {
	Method string
	Path   string
	Header http.Header
	Body   string
}

func newLegacyStub(t *testing.T) *legacyStub {
	t.Helper()
	stub := &legacyStub{}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		stub.mu.Lock()
		stub.requests = append(stub.requests, recordedRequest{Method: r.Method, Path: r.URL.Path, Header: r.Header.Clone(), Body: string(body)})
		stub.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"upstream":"legacy"}`))
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func newTestGateway(t *testing.T, legacyURL string, rules []Rule, goHandler GoHandler) http.Handler {
	t.Helper()
	gateway, err := New(legacyURL, rules)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if goHandler != nil {
		gateway.SetGoHandler(goHandler)
	}
	return httpx.TraceMiddleware(gateway)
}

// newTestGatewayWithShadow 构造带差分分发器的网关（返回 *Gateway 以便
// 直接调 ServeHTTPWithShadow）。goHandler 注册到路由表中首个 go/canary
// 模式规则的前缀（无此类规则时落 /__go/healthz）。
func newTestGatewayWithShadow(t *testing.T, legacyURL string, rules []Rule, goHandler GoHandler, _ ShadowDispatcher) *Gateway {
	t.Helper()
	gateway, err := New(legacyURL, rules)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if goHandler != nil {
		handlerPrefix := "/__go/healthz"
		for _, rule := range rules {
			if rule.Mode == ModeGo || rule.Mode == ModeCanary {
				handlerPrefix = rule.Prefix
				break
			}
		}
		gateway.RegisterGoHandler(handlerPrefix, goHandler)
	}
	return gateway
}

// 未迁移路由（/api/*）原样代理到 NestJS：路径/方法/请求体不变。
func TestLegacyRoutesProxyThrough(t *testing.T) {
	stub := newLegacyStub(t)
	gateway := newTestGateway(t, stub.server.URL, DefaultRules(), func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	req, _ := http.NewRequest(http.MethodPost, "http://gateway/api/items?limit=5", strings.NewReader(`{"q":"x"}`))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); !strings.Contains(got, "legacy") {
		t.Fatalf("response should come from legacy upstream: %s", got)
	}

	stub.mu.Lock()
	defer stub.mu.Unlock()
	if len(stub.requests) != 1 {
		t.Fatalf("upstream requests = %d, want 1", len(stub.requests))
	}
	upstream := stub.requests[0]
	if upstream.Method != http.MethodPost || upstream.Path != "/api/items" {
		t.Errorf("upstream saw %s %s, want POST /api/items", upstream.Method, upstream.Path)
	}
	if upstream.Header.Get("authorization") != "Bearer test-token" {
		t.Error("authorization header must be forwarded unchanged")
	}
	if upstream.Body != `{"q":"x"}` {
		t.Errorf("body = %q, want passthrough", upstream.Body)
	}
}

// 三个无 /api 前缀的挂载点同样代理：/graphql、/socket.io、/admin/queues。
func TestNonApiPrefixesProxyThrough(t *testing.T) {
	stub := newLegacyStub(t)
	gateway := newTestGateway(t, stub.server.URL, DefaultRules(), nil)

	for _, path := range []string{"/graphql", "/socket.io/notifications", "/admin/queues", "/docs"} {
		req, _ := http.NewRequest(http.MethodPost, "http://gateway"+path, strings.NewReader("{}"))
		rec := httptest.NewRecorder()
		gateway.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, rec.Code)
		}
	}

	stub.mu.Lock()
	defer stub.mu.Unlock()
	seen := map[string]bool{}
	for _, r := range stub.requests {
		seen[r.Path] = true
	}
	for _, path := range []string{"/graphql", "/socket.io/notifications", "/admin/queues", "/docs"} {
		if !seen[path] {
			t.Errorf("%s did not reach upstream", path)
		}
	}
}

// Go 原生路由（/__go/healthz）由网关应答，不触达 NestJS。
func TestGoRouteServedNatively(t *testing.T) {
	stub := newLegacyStub(t)
	gateway := newTestGateway(t, stub.server.URL, DefaultRules(), func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "routes": []map[string]string{{"prefix": "/__go/healthz", "mode": "go"}}})
	})

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway/__go/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		OK     bool `json:"ok"`
		Routes []struct {
			Prefix string `json:"prefix"`
			Mode   string `json:"mode"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !body.OK {
		t.Fatalf("body = %s, err = %v", rec.Body.String(), err)
	}
	if len(body.Routes) == 0 || body.Routes[0].Mode != "go" {
		t.Errorf("routes missing go entry: %s", rec.Body.String())
	}

	stub.mu.Lock()
	count := len(stub.requests)
	stub.mu.Unlock()
	if count != 0 {
		t.Errorf("go route must not reach upstream, got %d requests", count)
	}
}

// go 路由未注册 handler → 501（fail-closed，不静默回落 legacy）。
func TestGoRouteWithoutHandlerFailsClosed(t *testing.T) {
	stub := newLegacyStub(t)
	gateway := newTestGateway(t, stub.server.URL, DefaultRules(), nil)

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway/__go/healthz", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", rec.Code)
	}
}

// 上游不可达 → 502 JSON（含 traceId），而不是连接重置。
func TestUpstreamUnreachableReturns502(t *testing.T) {
	// 127.0.0.1:1 几乎必然拒绝连接。
	gateway := newTestGateway(t, "http://127.0.0.1:1", DefaultRules(), nil)

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	var body struct {
		StatusCode int    `json:"statusCode"`
		TraceID    string `json:"traceId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("502 body not JSON: %s", rec.Body.String())
	}
	if body.StatusCode != 502 || body.TraceID == "" {
		t.Errorf("502 body missing fields: %s", rec.Body.String())
	}
}

// trace 中间件：代理请求也带 x-trace-id 响应头，并透传到上游。
func TestTraceHeadersOnProxiedRequest(t *testing.T) {
	stub := newLegacyStub(t)
	gateway := newTestGateway(t, stub.server.URL, DefaultRules(), nil)

	req, _ := http.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil)
	req.Header.Set("x-trace-id", "abcdef0123456789abcdef0123456789")
	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, req)

	if got := rec.Header().Get("x-trace-id"); got != "abcdef0123456789abcdef0123456789" {
		t.Errorf("response x-trace-id = %q", got)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if len(stub.requests) != 1 {
		t.Fatalf("upstream requests = %d, want 1", len(stub.requests))
	}
	if got := stub.requests[0].Header.Get("x-trace-id"); got != "abcdef0123456789abcdef0123456789" {
		t.Errorf("upstream x-trace-id = %q, want passthrough", got)
	}
}

// 更长（更具体）的前缀优先于短前缀——切换单条路由不影响其余。
func TestLongestPrefixWins(t *testing.T) {
	stub := newLegacyStub(t)
	rules := []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/healthz/", Mode: ModeGo},
	}
	gateway := newTestGateway(t, stub.server.URL, rules, func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]bool{"go": true})
	})

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil))
	if !strings.Contains(rec.Body.String(), "go") {
		t.Fatalf("/api/healthz/live should hit go route, got %s", rec.Body.String())
	}

	rec2 := httptest.NewRecorder()
	gateway.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "http://gateway/api/items", nil))
	if !strings.Contains(rec2.Body.String(), "legacy") {
		t.Fatalf("/api/items should stay legacy, got %s", rec2.Body.String())
	}
}

// ---- shadow / canary 四态实现测试 ----

// fakeDispatcher 记录 shadow 差分触发与 canary 分流决策。
type fakeDispatcher struct {
	mu         sync.Mutex
	observed   int
	skipped    map[string]int
	lastLegacy []byte
	lastStatus int
	canaryGo   bool
}

func (d *fakeDispatcher) ObserveShadow(_ *http.Request, status int, _ http.Header, legacyBody []byte, reason ShadowSkipReason) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if reason != "" {
		if d.skipped == nil {
			d.skipped = make(map[string]int)
		}
		d.skipped[string(reason)]++
		return
	}
	d.observed++
	d.lastLegacy = legacyBody
	d.lastStatus = status
}

func (d *fakeDispatcher) skipCount(reason ShadowSkipReason) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.skipped[string(reason)]
}

func (d *fakeDispatcher) observedCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.observed
}

func (d *fakeDispatcher) CanaryRoute(_ *http.Request) bool {
	return d.canaryGo
}

// shadow 路由：客户端响应来自 NestJS（上游返回体原样送达），差分被异步触发。
func TestShadowRouteServesLegacyResponseAndTriggersDiff(t *testing.T) {
	stub := newLegacyStub(t)
	disp := &fakeDispatcher{}
	gateway := newTestGatewayWithShadow(t, stub.server.URL, DefaultRules(), nil, disp)

	req, _ := http.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil)
	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, req, disp)

	// 主响应来自上游（legacy stub 的响应体）。
	if !strings.Contains(rec.Body.String(), "legacy") {
		t.Fatalf("shadow response must come from legacy upstream: %s", rec.Body.String())
	}
	// 上游确实收到请求（NestJS 是执行者）。
	stub.mu.Lock()
	upstreamCount := len(stub.requests)
	stub.mu.Unlock()
	if upstreamCount != 1 {
		t.Fatalf("upstream requests = %d, want 1", upstreamCount)
	}
	// 差分异步触发（等一小会）。
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		disp.mu.Lock()
		observed := disp.observed
		disp.mu.Unlock()
		if observed == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("shadow diff was not triggered")
}

// shadow 路由的写请求：不触发差分（禁止双发），但主响应正常。
func TestShadowRouteSkipsDiffForWriteMethods(t *testing.T) {
	stub := newLegacyStub(t)
	disp := &fakeDispatcher{}
	gateway := newTestGatewayWithShadow(t, stub.server.URL, DefaultRules(), nil, disp)

	req, _ := http.NewRequest(http.MethodPost, "http://gateway/api/healthz/live", strings.NewReader(`{"x":1}`))
	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, req, disp)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	// 写请求同步跳过差分：无 goroutine——立即检查为 0。
	disp.mu.Lock()
	defer disp.mu.Unlock()
	if disp.observed != 0 {
		t.Fatalf("write request triggered diff (%d times) — 禁止对写请求双发", disp.observed)
	}
}

// shadow 路由无 dispatcher（纯代理）：不差分、不报错。
func TestShadowRouteWithoutDispatcherStillProxies(t *testing.T) {
	stub := newLegacyStub(t)
	gateway := newTestGateway(t, stub.server.URL, DefaultRules(), nil)

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "legacy") {
		t.Fatalf("status=%d body=%s, want proxied legacy response", rec.Code, rec.Body.String())
	}
}

// canary：分流命中 → go handler；未命中 → legacy。
func TestCanaryRouteSplitting(t *testing.T) {
	stub := newLegacyStub(t)
	disp := &fakeDispatcher{}
	rules := []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/healthz/live", Mode: ModeCanary},
	}
	gateway := newTestGatewayWithShadow(t, stub.server.URL, rules, func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"impl": "go"})
	}, disp)

	// 未命中（canaryGo=false）→ legacy。
	disp.canaryGo = false
	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)
	if !strings.Contains(rec.Body.String(), "legacy") {
		t.Fatalf("canary miss should stay legacy, got %s", rec.Body.String())
	}

	// 命中 → go。
	disp.canaryGo = true
	rec2 := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec2, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)
	if !strings.Contains(rec2.Body.String(), "go") {
		t.Fatalf("canary hit should serve go handler, got %s", rec2.Body.String())
	}
}

// canary 命中但无 go handler：回退 legacy（fail-safe，不 501 客户端）。
func TestCanaryHitWithoutHandlerFallsBackToLegacy(t *testing.T) {
	stub := newLegacyStub(t)
	disp := &fakeDispatcher{canaryGo: true}
	rules := []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/healthz/live", Mode: ModeCanary},
	}
	gateway := newTestGatewayWithShadow(t, stub.server.URL, rules, nil, disp)

	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)
	if !strings.Contains(rec.Body.String(), "legacy") {
		t.Fatalf("canary without handler must fall back to legacy, got %s", rec.Body.String())
	}
}

// 注册前缀的 go handler：路由表与注册键一致时由 go 处理。
func TestRegisterGoHandlerServesNative(t *testing.T) {
	stub := newLegacyStub(t)
	gateway, err := New(stub.server.URL, []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/healthz/live", Mode: ModeGo},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.RegisterGoHandler("/api/healthz/live", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	rec := httptest.NewRecorder()
	gateway.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil))
	if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Fatalf("go handler not served: %s", rec.Body.String())
	}
	stub.mu.Lock()
	count := len(stub.requests)
	stub.mu.Unlock()
	if count != 0 {
		t.Fatalf("go route must not reach upstream, got %d", count)
	}
}

// ---- shadow 有界捕获（bounded capture）测试 ----

// stubHandler 返回可配置响应的上游替身。
type stubHandler struct {
	mu          sync.Mutex
	status      int
	contentType string
	body        []byte
	flushChunks int
	bodies      []string // 收到的请求体（回显验证用）
}

func (s *stubHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.bodies = append(s.bodies, string(body))
	status, contentType, respBody, chunks := s.status, s.contentType, s.body, s.flushChunks
	s.mu.Unlock()

	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(status)
	if chunks > 1 {
		// 分块流式写：每块后 Flush（模拟 SSE/渐进响应）。
		chunkSize := len(respBody) / chunks
		for i := 0; i < chunks; i++ {
			start := i * chunkSize
			end := start + chunkSize
			if i == chunks-1 {
				end = len(respBody)
			}
			_, _ = w.Write(respBody[start:end])
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		return
	}
	_, _ = w.Write(respBody)
}

func newStubServer(t *testing.T, handler *stubHandler) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func waitFor(t *testing.T, condition func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// 响应体超过捕获预算：客户端仍收到完整响应（流式透传不受影响），
// 差分按 response-too-large 记账丢弃。
func TestShadowResponseOverBudgetStillStreamsFully(t *testing.T) {
	handler := &stubHandler{
		status:      http.StatusOK,
		contentType: "application/json",
		body:        bytes.Repeat([]byte(`{"chunk":"0123456789"}`), 200), // ~4KB
	}
	upstream := newStubServer(t, handler)

	disp := &fakeDispatcher{}
	gateway, err := New(upstream.URL, DefaultRules())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.SetShadowBudget(ShadowBudget{MaxRequestBodyByte: 4096, MaxResponseCaptureByte: 1024}) // 捕获预算 1KB

	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)

	// 客户端收到完整响应（不受捕获预算影响）。
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != len(handler.body) {
		t.Fatalf("client body = %d bytes, want full %d bytes（捕获预算不得截断主响应）", rec.Body.Len(), len(handler.body))
	}
	if !bytes.Contains(rec.Body.Bytes(), handler.body[len(handler.body)-20:]) {
		t.Fatal("client response tail missing — streaming passthrough broken")
	}
	// 差分被跳过并按原因记账。
	waitFor(t, func() bool { return disp.skipCount(ShadowSkipResponseTooLarge) == 1 }, "response-too-large skip")
	if disp.observedCount() != 0 {
		t.Fatalf("diff executed despite oversized response (%d)", disp.observedCount())
	}
}

// SSE 响应：客户端收到事件流，差分按 streaming-skipped 丢弃。
func TestShadowSSEResponseSkipsDiffButPassesThrough(t *testing.T) {
	handler := &stubHandler{
		status:      http.StatusOK,
		contentType: "text/event-stream",
		body:        []byte("data: one\n\ndata: two\n\n"),
		flushChunks: 2,
	}
	upstream := newStubServer(t, handler)

	disp := &fakeDispatcher{}
	gateway, err := New(upstream.URL, DefaultRules())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.SetShadowBudget(ShadowBudget{MaxRequestBodyByte: 4096, MaxResponseCaptureByte: 1 << 20})

	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("client Content-Type = %q, want text/event-stream", got)
	}
	if rec.Body.String() != "data: one\n\ndata: two\n\n" {
		t.Fatalf("client body = %q, want full SSE stream", rec.Body.String())
	}
	waitFor(t, func() bool { return disp.skipCount(ShadowSkipStreaming) == 1 }, "streaming skip")
	if disp.observedCount() != 0 {
		t.Fatalf("diff executed on SSE response (%d)", disp.observedCount())
	}
}

// 协议升级（WebSocket）请求：不进入差分（无意义且 stdlib 代理不支持），
// 记 streaming-skipped。
func TestShadowUpgradeRequestSkipsDiff(t *testing.T) {
	handler := &stubHandler{status: http.StatusOK, body: []byte(`{}`)}
	upstream := newStubServer(t, handler)

	disp := &fakeDispatcher{}
	gateway, err := New(upstream.URL, DefaultRules())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")

	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, req, disp)

	waitFor(t, func() bool { return disp.skipCount(ShadowSkipStreaming) == 1 }, "upgrade skip")
	if disp.observedCount() != 0 {
		t.Fatalf("diff executed on upgrade request (%d)", disp.observedCount())
	}
}

// 请求体超过差分预算：上游仍收到完整请求体（MultiReader 拼回），
// 差分按 request-too-large 记账丢弃。
func TestShadowRequestOverBudgetStillForwardsFullBody(t *testing.T) {
	handler := &stubHandler{
		status:      http.StatusOK,
		contentType: "application/json",
		body:        []byte(`{"ok":true}`),
	}
	upstream := newStubServer(t, handler)

	disp := &fakeDispatcher{}
	gateway, err := New(upstream.URL, DefaultRules())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.SetShadowBudget(ShadowBudget{MaxRequestBodyByte: 16, MaxResponseCaptureByte: 1 << 20})

	fullBody := `{"payload":"` + strings.Repeat("x", 200) + `"}`
	req := httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", strings.NewReader(fullBody))
	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, req, disp)

	// 差分跳过。
	waitFor(t, func() bool { return disp.skipCount(ShadowSkipRequestTooLarge) == 1 }, "request-too-large skip")
	// 上游收到完整请求体。
	handler.mu.Lock()
	upstreamBody := handler.bodies[0]
	handler.mu.Unlock()
	if upstreamBody != fullBody {
		t.Fatalf("upstream body = %d bytes, want full %d bytes（超预算请求仍需完整转发）", len(upstreamBody), len(fullBody))
	}
}

// 预算内的正常响应：差分拿到完整捕获（status + body）。
func TestShadowSmallResponseCapturedForDiff(t *testing.T) {
	handler := &stubHandler{
		status:      http.StatusOK,
		contentType: "application/json",
		body:        []byte(`{"upstream":"legacy"}`),
	}
	upstream := newStubServer(t, handler)

	disp := &fakeDispatcher{}
	gateway, err := New(upstream.URL, DefaultRules())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	gateway.SetShadowBudget(ShadowBudget{MaxRequestBodyByte: 4096, MaxResponseCaptureByte: 4096})

	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)

	if !strings.Contains(rec.Body.String(), "legacy") {
		t.Fatalf("client body = %s, want upstream response", rec.Body.String())
	}
	waitFor(t, func() bool { return disp.observedCount() == 1 }, "diff observation")
	disp.mu.Lock()
	defer disp.mu.Unlock()
	if string(disp.lastLegacy) != `{"upstream":"legacy"}` {
		t.Fatalf("captured legacy body = %q, want full upstream body", disp.lastLegacy)
	}
	if disp.lastStatus != http.StatusOK {
		t.Fatalf("captured status = %d, want 200", disp.lastStatus)
	}
}

// 客户端响应头透传：上游设置的头（含 Content-Type）原样到达客户端。
func TestShadowForwardsUpstreamHeaders(t *testing.T) {
	handler := &stubHandler{
		status:      http.StatusTeapot,
		contentType: "application/json",
		body:        []byte(`{"a":1}`),
	}
	upstream := newStubServer(t, handler)

	disp := &fakeDispatcher{}
	gateway, err := New(upstream.URL, DefaultRules())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	rec := httptest.NewRecorder()
	gateway.ServeHTTPWithShadow(rec, httptest.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil), disp)

	if rec.Code != http.StatusTeapot {
		t.Fatalf("client status = %d, want 418（非 200 状态也必须透传）", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("client Content-Type = %q, want application/json", got)
	}
}

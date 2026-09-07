package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/canary"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// forgedJWT 构造一个完整可解析、但签名是伪造的 JWT 形 token——攻击者
// 可以任选 payload（含 orgId）。这正是 canary 信任边界要拦的输入。
func forgedJWT() string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"user-1","orgId":"attacker-chosen-org","permissions":["settings.manage"]}`))
	signature := base64.RawURLEncoding.EncodeToString([]byte("forged-signature-value"))
	return header + "." + payload + "." + signature
}

// 信任边界端到端测试：生产装配的 dispatcher + 真实 canary router。
//
// 证明：伪造、损坏、未验签或缺失身份的请求不会进入受保护的 Go
// handler——即使 CANARY_PERCENT=100（误配场景）。这是 PR 静态审查
// 任务 3 的远端回归锚点。
func TestDispatcherCanaryNeverRoutesUnverifiedIdentityToGo(t *testing.T) {
	disp := &dispatcher{
		shadowRunner: shadow.NewRunner(shadow.Budget{}),
		canaryRouter: canary.NewRouter(canary.Options{Percent: 100}), // 生产同款装配（不开信任开关）
	}

	cases := []struct {
		name   string
		header string
	}{
		{"forged-valid-shaped-jwt", "Bearer " + forgedJWT()},
		{"corrupted-token", "Bearer aaa.bbb.ccc"},
		{"garbage", "Bearer not-a-jwt"},
		{"machine-token", "Bearer mtk_xxxxxxxxxxxxxxxx"},
		{"missing-header", ""},
		{"wrong-scheme", "Basic dXNlcjpwYXNz"},
	}
	for _, tc := range cases {
		req, _ := http.NewRequest(http.MethodGet, "http://gateway/api/some-protected-route", nil)
		req.Header.Set("Authorization", tc.header)
		if disp.CanaryRoute(req) {
			t.Errorf("%s: CanaryRoute = true — 未验证身份不得进入 Go handler", tc.name)
		}
	}
}

// 路由表现状契约：没有任何路由处于 ModeCanary（canary 是待鉴权基础
// 设施接入的分流组件，不是已激活能力）。若后续迁移把路由切到
// ModeCanary，此测试失败——提醒先落地可信身份来源（JWT 验签 +
// membership 重推导，迁移序 5）或证明路由无鉴权语义差异。
func TestDefaultRulesHaveNoCanaryRoutes(t *testing.T) {
	for _, rule := range legacyproxy.DefaultRules(legacyproxy.ModeShadow, "") {
		if rule.Mode == legacyproxy.ModeCanary {
			t.Fatalf("route %q is ModeCanary — canary 分流依赖未验签身份，先落地可信身份来源", rule.Prefix)
		}
	}
}

// 首个迁移单元的状态契约：/api/healthz/live 处于 shadow（NestJS 仍是
// 响应方），不是 go 全量接管。
func TestHealthzLiveIsShadowNotGo(t *testing.T) {
	for _, rule := range legacyproxy.DefaultRules(legacyproxy.ModeShadow, "") {
		if rule.Prefix == "/api/healthz/live" {
			if rule.Mode != legacyproxy.ModeShadow {
				t.Fatalf("/api/healthz/live mode = %s, want shadow（NestJS 仍是事实源）", rule.Mode)
			}
			return
		}
	}
	t.Fatal("/api/healthz/live not found in DefaultRules")
}

// countingRepo 统计六个 user-settings 查询的调用次数（验证零执行/执行
// 一次语义）。计数由互斥锁保护——runner 在独立 goroutine 异步执行。
type countingRepo struct {
	mu              sync.Mutex
	calls           map[string]int
	situationCalls  int
}

func (c *countingRepo) record(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.calls == nil {
		c.calls = map[string]int{}
	}
	c.calls[path]++
}

func (c *countingRepo) FindOnboarding(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.record("/api/user-settings/ui/onboarding")
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindRSSReader(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.record("/api/user-settings/ui/rss-reader")
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindSpacetimeTimeline(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.record("/api/user-settings/ui/spacetime-timeline")
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindWarMap(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.record("/api/user-settings/ui/war-map")
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindNewsnow(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.record("/api/user-settings/ui/newsnow")
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindSituationMonitor(_ context.Context, _, _ string) (usersettings.SituationMonitorRecords, error) {
	c.mu.Lock()
	c.situationCalls++
	c.mu.Unlock()
	return usersettings.SituationMonitorRecords{}, nil
}

// callsFor 返回该 shadow 单元路径对应的查询计数（未知路径返回 0）。
// situation-monitor 是聚合查询（一次查询覆盖三段），单独计数。
func (c *countingRepo) callsFor(path string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if path == "/api/user-settings/ui/situation-monitor" {
		return c.situationCalls
	}
	return c.calls[path]
}

// totalCalls 返回全部查询的总调用数（捕获「误路由到别的端点」类缺陷）。
func (c *countingRepo) totalCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := c.situationCalls
	for _, count := range c.calls {
		total += count
	}
	return total
}

// userSettingsTestDispatcher 构造与生产同结构的 dispatcher：直接复用
// 生产的 userSettingsShadowUnits 接线（测试覆盖真实单元表，不是测试
// 专用的副本——批2B 起三个端点共用同一 executant 流程）。
func userSettingsTestDispatcher(repo *countingRepo) *dispatcher {
	return &dispatcher{
		shadowUnits:  userSettingsShadowUnits(repo),
		shadowRunner: shadow.NewRunner(shadow.Budget{}),
	}
}

// Go-批2A/2B 核心安全边界：legacy-approved shadow identity 的执行语义
//（代表性非 200，不为每个状态码写重复测试）。三个 user-settings 端点
// 共用同一 userSettingsExecutant——表格覆盖各端点 GET 执行一次，以及
// PUT / 非 200 / 坏 token / 相似前缀路径的零执行。
func TestUserSettingsShadowIdentityGate(t *testing.T) {
	// 合法形态 Bearer（forgedJWT 只返回裸 JWT——这里补 Bearer 前缀）。
	validToken := "Bearer " + forgedJWT()

	cases := []struct {
		name          string
		path          string
		method        string
		auth          string
		legacyStatus  int
		wantRepoCalls int
	}{
		// 批2A 既有语义（onboarding）：
		// legacy 200 + 合法形态 Bearer payload → 执行一次。
		{"onboarding-legacy-200-executes-once", "/api/user-settings/ui/onboarding", http.MethodGet, validToken, http.StatusOK, 1},
		// legacy 非 200（401/403/404/500 同语义）→ 零执行。
		{"onboarding-legacy-401-zero-execution", "/api/user-settings/ui/onboarding", http.MethodGet, validToken, http.StatusUnauthorized, 0},
		{"onboarding-legacy-404-zero-execution", "/api/user-settings/ui/onboarding", http.MethodGet, validToken, http.StatusNotFound, 0},
		{"onboarding-legacy-500-zero-execution", "/api/user-settings/ui/onboarding", http.MethodGet, validToken, http.StatusInternalServerError, 0},
		// token 缺失/损坏 → 零执行。
		{"onboarding-missing-token-zero-execution", "/api/user-settings/ui/onboarding", http.MethodGet, "", http.StatusOK, 0},
		{"onboarding-corrupted-token-zero-execution", "/api/user-settings/ui/onboarding", http.MethodGet, "Bearer aaa.bbb.ccc", http.StatusOK, 0},
		// PUT 绝不双发（即使 token 与 legacy 状态都合法）。
		{"onboarding-put-zero-execution", "/api/user-settings/ui/onboarding", http.MethodPut, validToken, http.StatusOK, 0},
		// 精确路径：同前缀的其他路径不进入该 shadow 单元。
		{"onboarding-other-path-zero-execution", "/api/user-settings/ui/onboarding-x", http.MethodGet, validToken, http.StatusOK, 0},
		// 批2B：两个新端点——GET 执行一次；PUT 与 legacy 非 200 零执行。
		{"rss-reader-legacy-200-executes-once", "/api/user-settings/ui/rss-reader", http.MethodGet, validToken, http.StatusOK, 1},
		{"rss-reader-put-zero-execution", "/api/user-settings/ui/rss-reader", http.MethodPut, validToken, http.StatusOK, 0},
		{"spacetime-legacy-200-executes-once", "/api/user-settings/ui/spacetime-timeline", http.MethodGet, validToken, http.StatusOK, 1},
		{"spacetime-legacy-403-zero-execution", "/api/user-settings/ui/spacetime-timeline", http.MethodGet, validToken, http.StatusForbidden, 0},
		// 批3B：三个新端点（shadow 单元表新增）——GET 执行一次；PUT 零执行。
		{"war-map-legacy-200-executes-once", "/api/user-settings/ui/war-map", http.MethodGet, validToken, http.StatusOK, 1},
		{"war-map-put-zero-execution", "/api/user-settings/ui/war-map", http.MethodPut, validToken, http.StatusOK, 0},
		{"newsnow-legacy-200-executes-once", "/api/user-settings/ui/newsnow", http.MethodGet, validToken, http.StatusOK, 1},
		{"newsnow-put-zero-execution", "/api/user-settings/ui/newsnow", http.MethodPut, validToken, http.StatusOK, 0},
		{"situation-monitor-legacy-200-executes-once", "/api/user-settings/ui/situation-monitor", http.MethodGet, validToken, http.StatusOK, 1},
		{"situation-monitor-put-zero-execution", "/api/user-settings/ui/situation-monitor", http.MethodPut, validToken, http.StatusOK, 0},
	}

	for _, tc := range cases {
		repo := &countingRepo{}
		disp := userSettingsTestDispatcher(repo)
		req, _ := http.NewRequest(tc.method, "http://g"+tc.path, nil)
		req.Header.Set("Authorization", tc.auth)
		disp.ObserveShadow(req, tc.legacyStatus, http.Header{}, []byte(`{}`), "")
		if tc.wantRepoCalls == 0 {
			// 零执行用例给一个短暂宽限：错误触发是异步的，立即断言会漏报。
			time.Sleep(25 * time.Millisecond)
		}
		// ObserveResult 是异步的——等待 runner 执行完成（轮询目标端点
		// 计数，上限 2s）。
		deadline := time.Now().Add(2 * time.Second)
		for repo.callsFor(tc.path) < tc.wantRepoCalls && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if got := repo.callsFor(tc.path); got != tc.wantRepoCalls {
			t.Errorf("%s: repo calls = %d, want %d", tc.name, got, tc.wantRepoCalls)
		}
		if got := repo.totalCalls(); got != tc.wantRepoCalls {
			t.Errorf("%s: total repo calls = %d, want %d（不得误路由到其他端点）", tc.name, got, tc.wantRepoCalls)
		}
	}
}

// 路由表精确规则（Go-批3A 起 onboarding 模式可配置）：shadow 模式下
// 三个 user-settings 只读 GET 路径均处于 shadow，且不是 canary/go。
func TestUserSettingsRoutesAreShadow(t *testing.T) {
	for _, prefix := range []string{
		"/api/user-settings/ui/onboarding",
		"/api/user-settings/ui/rss-reader",
		"/api/user-settings/ui/spacetime-timeline",
	} {
		found := false
		for _, rule := range legacyproxy.DefaultRules(legacyproxy.ModeShadow, "") {
			if rule.Prefix == prefix {
				found = true
				if rule.Mode != legacyproxy.ModeShadow {
					t.Fatalf("%s mode = %s, want shadow", prefix, rule.Mode)
				}
			}
		}
		if !found {
			t.Fatalf("%s not found in DefaultRules", prefix)
		}
	}
}

// user-settings 端点的路由表现状契约（Go-批3A 起 onboarding 模式可配置）：
// shadow 模式（默认）下三个端点都是 shadow——没有客户端可见的 Go
// handler；go 模式下仅 onboarding 是 ModeGo（Go 鉴权 + 全响应，由
// API_GO_ONBOARDING_MODE=go 显式启用），rss-reader / spacetime-timeline
// 仍必须保持 shadow（若有人误把它们切到 go，此测试失败——它们的 Go
// 侧实现仍是 legacy-approved shadow identity，不具备独立鉴权）。
func TestUserSettingsHaveNoClientGoHandler(t *testing.T) {
	for _, tc := range []struct {
		mode           legacyproxy.Mode
		wantOnboarding legacyproxy.Mode
	}{
		{legacyproxy.ModeShadow, legacyproxy.ModeShadow},
		{legacyproxy.ModeGo, legacyproxy.ModeGo},
	} {
		gateway, err := legacyproxy.New("http://legacy:4000", legacyproxy.DefaultRules(tc.mode, ""))
		if err != nil {
			t.Fatal(err)
		}
		for _, prefix := range []string{
			"/api/user-settings/ui/onboarding",
			"/api/user-settings/ui/rss-reader",
			"/api/user-settings/ui/spacetime-timeline",
		} {
			want := legacyproxy.ModeShadow
			if prefix == "/api/user-settings/ui/onboarding" {
				want = tc.wantOnboarding
			}
			for _, rule := range gateway.Rules() {
				if rule.Prefix == prefix && rule.Mode != want {
					t.Fatalf("mode=%s: %s mode = %s, want %s", tc.mode, prefix, rule.Mode, want)
				}
			}
		}
	}
}

// Go-批3B：统一读模式（API_GO_USER_SETTINGS_READ_MODE）的路由表契约 +
// exact GET 路由与 PUT/相似路径回落 legacy（扩展现有路由表测试）。
//
//	ModeShadow: 六个 GET 全部 shadow（含三个原本 legacy 的端点）。
//	ModeGo:     六个 GET 全部 go（统一 usersettingsread handler）。
//	空（兼容）: onboarding 由 onboardingMode 决定，rss/spacetime shadow，
//	            war-map/newsnow/situation-monitor legacy。
//
// 同时验证 go 模式下 PUT（同路径）与相似路径回落 legacy——exact path +
// method 白名单边界（六个 PUT 由 NestJS 单写）。
func TestUserSettingsReadModeRouting(t *testing.T) {
	sixPaths := []string{
		"/api/user-settings/ui/onboarding",
		"/api/user-settings/ui/rss-reader",
		"/api/user-settings/ui/spacetime-timeline",
		"/api/user-settings/ui/war-map",
		"/api/user-settings/ui/newsnow",
		"/api/user-settings/ui/situation-monitor",
	}

	for _, tc := range []struct {
		name      string
		readMode  string
		onboard   legacyproxy.Mode
		wantModes map[string]legacyproxy.Mode
	}{
		{
			name:     "read-mode-shadow-unifies-all-six",
			readMode: string(legacyproxy.ModeShadow),
			onboard:  legacyproxy.ModeGo, // readMode 优先——onboarding 也回到 shadow
			wantModes: func() map[string]legacyproxy.Mode {
				m := map[string]legacyproxy.Mode{}
				for _, p := range sixPaths {
					m[p] = legacyproxy.ModeShadow
				}
				return m
			}(),
		},
		{
			name:     "read-mode-go-unifies-all-six",
			readMode: string(legacyproxy.ModeGo),
			onboard:  legacyproxy.ModeShadow,
			wantModes: func() map[string]legacyproxy.Mode {
				m := map[string]legacyproxy.Mode{}
				for _, p := range sixPaths {
					m[p] = legacyproxy.ModeGo
				}
				return m
			}(),
		},
		{
			name:     "empty-read-mode-keeps-legacy-compat",
			readMode: "",
			onboard:  legacyproxy.ModeShadow,
			wantModes: func() map[string]legacyproxy.Mode {
				return map[string]legacyproxy.Mode{
					"/api/user-settings/ui/onboarding":         legacyproxy.ModeShadow,
					"/api/user-settings/ui/rss-reader":         legacyproxy.ModeShadow,
					"/api/user-settings/ui/spacetime-timeline": legacyproxy.ModeShadow,
					"/api/user-settings/ui/war-map":            legacyproxy.ModeLegacy,
					"/api/user-settings/ui/newsnow":            legacyproxy.ModeLegacy,
					"/api/user-settings/ui/situation-monitor":  legacyproxy.ModeLegacy,
				}
			}(),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, rule := range legacyproxy.DefaultRules(tc.onboard, tc.readMode) {
				if want, ok := tc.wantModes[rule.Prefix]; ok && rule.Mode != want {
					t.Fatalf("%s: mode = %s, want %s（readMode=%q）", rule.Prefix, rule.Mode, want, tc.readMode)
				}
			}
		})
	}

	// exact GET 边界（go 模式）：PUT 同路径与相似路径回落 legacy 代理。
	stub := newLegacyStubFor(t)
	gateway, err := legacyproxy.New(stub.URL(), legacyproxy.DefaultRules(legacyproxy.ModeShadow, string(legacyproxy.ModeGo)))
	if err != nil {
		t.Fatal(err)
	}
	goHandlerCalls := 0
	for _, path := range sixPaths {
		gateway.RegisterGoHandler(path, func(w http.ResponseWriter, _ *http.Request) {
			goHandlerCalls++
			w.WriteHeader(http.StatusOK)
		})
	}
	handler := httpx.TraceMiddleware(gateway)

	for _, tc := range []struct {
		name   string
		method string
		path   string
		wantGo bool
	}{
		{"war-map-get", http.MethodGet, "/api/user-settings/ui/war-map", true},
		{"newsnow-get", http.MethodGet, "/api/user-settings/ui/newsnow", true},
		{"situation-monitor-get", http.MethodGet, "/api/user-settings/ui/situation-monitor", true},
		{"war-map-put-falls-legacy", http.MethodPut, "/api/user-settings/ui/war-map", false},
		{"newsnow-post-falls-legacy", http.MethodPost, "/api/user-settings/ui/newsnow", false},
		{"situation-monitor-head-falls-legacy", http.MethodHead, "/api/user-settings/ui/situation-monitor", false},
		{"war-map-suffix-does-not-match", http.MethodGet, "/api/user-settings/ui/war-map-x", false},
		{"newsnow-subpath-does-not-match", http.MethodGet, "/api/user-settings/ui/newsnow/other", false},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil))
		if tc.wantGo {
			if rec.Code != http.StatusOK {
				t.Errorf("%s: status = %d, want 200 (go handler)", tc.name, rec.Code)
			}
		}
		// 非 Go 用例：上游收到请求即证明回落 legacy（stub 返回 200）。
	}

	if goHandlerCalls != 3 {
		t.Errorf("go handler calls = %d, want 3（只有三个 GET 命中 Go handler）", goHandlerCalls)
	}
	// 5 个非 Go 用例（PUT/POST/HEAD + 两个相似路径）全部回落 legacy 代理
	// ——上游恰好收到 5 次请求（Go 命中不触达上游）。
	stub.AssertRequestCount(t, 5)
}

// stubCountingServer 断言 legacy stub 收到的请求数（exact-method 路由
// 测试的 helper）。
type stubCountingServer struct {
	mu      sync.Mutex
	server  *httptest.Server
	request int
}

func newLegacyStubFor(t *testing.T) *stubCountingServer {
	t.Helper()
	stub := &stubCountingServer{}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.mu.Lock()
		stub.request++
		stub.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *stubCountingServer) URL() string { return s.server.URL }

func (s *stubCountingServer) AssertRequestCount(t *testing.T, want int) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.request != want {
		t.Errorf("legacy upstream requests = %d, want %d", s.request, want)
	}
}

// healthcheck 子命令的退出码契约（Go-批2C 新增的正常启动入口分支）：
// 2xx → 0；非 2xx 或目标不可达 → 1。这里的 httptest 只模拟「本进程
// 探测目标」的响应行为，不涉及 legacy upstream。
func TestRunHealthcheckExitCodes(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unhealthy.Close()

	// PORT 复用 httptest 端口：从 URL 提取端口写入进程 env（测试结束后
	// 恢复，避免污染同包其他测试）。
	portOf := func(url string) string {
		return url[strings.LastIndex(url, ":")+1:]
	}
	original := os.Getenv("PORT")
	defer os.Setenv("PORT", original)

	os.Setenv("PORT", portOf(healthy.URL))
	if code := runHealthcheck(); code != 0 {
		t.Errorf("2xx: exit code = %d, want 0", code)
	}
	os.Setenv("PORT", portOf(unhealthy.URL))
	if code := runHealthcheck(); code != 1 {
		t.Errorf("5xx: exit code = %d, want 1", code)
	}
	os.Setenv("PORT", "1") // 不可达端口：连接失败 → 1
	if code := runHealthcheck(); code != 1 {
		t.Errorf("unreachable: exit code = %d, want 1", code)
	}
}

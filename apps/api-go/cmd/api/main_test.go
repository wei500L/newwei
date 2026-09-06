package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/canary"
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
	for _, rule := range legacyproxy.DefaultRules() {
		if rule.Mode == legacyproxy.ModeCanary {
			t.Fatalf("route %q is ModeCanary — canary 分流依赖未验签身份，先落地可信身份来源", rule.Prefix)
		}
	}
}

// 首个迁移单元的状态契约：/api/healthz/live 处于 shadow（NestJS 仍是
// 响应方），不是 go 全量接管。
func TestHealthzLiveIsShadowNotGo(t *testing.T) {
	for _, rule := range legacyproxy.DefaultRules() {
		if rule.Prefix == "/api/healthz/live" {
			if rule.Mode != legacyproxy.ModeShadow {
				t.Fatalf("/api/healthz/live mode = %s, want shadow（NestJS 仍是事实源）", rule.Mode)
			}
			return
		}
	}
	t.Fatal("/api/healthz/live not found in DefaultRules")
}

// countingRepo 统计三个 user-settings 查询的调用次数（验证零执行/执行
// 一次语义）。计数由互斥锁保护——runner 在独立 goroutine 异步执行。
type countingRepo struct {
	mu              sync.Mutex
	onboardingCalls int
	rssReaderCalls  int
	spacetimeCalls  int
}

func (c *countingRepo) FindOnboarding(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onboardingCalls++
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindRSSReader(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rssReaderCalls++
	return usersettings.Record{Found: false}, nil
}

func (c *countingRepo) FindSpacetimeTimeline(_ context.Context, _, _ string) (usersettings.Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spacetimeCalls++
	return usersettings.Record{Found: false}, nil
}

// callsFor 返回该 shadow 单元路径对应的查询计数（未知路径返回 0）。
func (c *countingRepo) callsFor(path string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch path {
	case "/api/user-settings/ui/onboarding":
		return c.onboardingCalls
	case "/api/user-settings/ui/rss-reader":
		return c.rssReaderCalls
	case "/api/user-settings/ui/spacetime-timeline":
		return c.spacetimeCalls
	}
	return 0
}

// totalCalls 返回三个查询的总调用数（捕获「误路由到别的端点」类缺陷）。
func (c *countingRepo) totalCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.onboardingCalls + c.rssReaderCalls + c.spacetimeCalls
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

// 路由表精确规则：三个 user-settings 只读 GET 路径均处于 shadow，且不是
// canary/go。
func TestUserSettingsRoutesAreShadow(t *testing.T) {
	for _, prefix := range []string{
		"/api/user-settings/ui/onboarding",
		"/api/user-settings/ui/rss-reader",
		"/api/user-settings/ui/spacetime-timeline",
	} {
		found := false
		for _, rule := range legacyproxy.DefaultRules() {
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

// user-settings 端点未注册客户端可见的 Go handler：shadow 是旁路差分，
// 不是客户端响应路径（若有人误加 RegisterGoHandler 接管响应，此测试
// 失败——提醒先完成 Go Auth/RBAC）。
func TestUserSettingsHaveNoClientGoHandler(t *testing.T) {
	gateway, err := legacyproxy.New("http://legacy:4000", legacyproxy.DefaultRules())
	if err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{
		"/api/user-settings/ui/onboarding",
		"/api/user-settings/ui/rss-reader",
		"/api/user-settings/ui/spacetime-timeline",
	} {
		for _, rule := range gateway.Rules() {
			if rule.Prefix == prefix && rule.Mode != legacyproxy.ModeShadow {
				t.Fatalf("%s mode = %s, want shadow", prefix, rule.Mode)
			}
		}
	}
}

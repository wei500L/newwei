package main

import (
	"context"
	"encoding/base64"
	"net/http"
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

// countingRepo 统计 FindOnboarding 调用次数（验证零执行/执行一次语义）。
type countingRepo struct {
	calls int
}

func (c *countingRepo) FindOnboarding(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
	c.calls++
	return usersettings.Record{Found: false}, nil
}

// onboardingTestDispatcher 构造与生产同结构的 dispatcher（shadow 单元表
// 带真实 onboarding executant）。
func onboardingTestDispatcher(repo *countingRepo) *dispatcher {
	return &dispatcher{
		shadowUnits: []shadowUnit{
			{
				Path:            "/api/user-settings/ui/onboarding",
				Methods:         map[string]bool{http.MethodGet: true},
				RequireLegacyOK: true,
				Executant:       onboardingExecutant{repo: repo},
			},
		},
		shadowRunner: shadow.NewRunner(shadow.Budget{}),
	}
}

// Go-批2A 核心安全边界：legacy-approved shadow identity 的执行语义
//（代表性非 200，不为每个状态码写重复测试）。
func TestOnboardingShadowIdentityGate(t *testing.T) {
	onboardingRequest := func(method, auth string) *http.Request {
		req, _ := http.NewRequest(method, "http://g/api/user-settings/ui/onboarding", nil)
		req.Header.Set("Authorization", auth)
		return req
	}
	// 合法形态 Bearer（forgedJWT 只返回裸 JWT——这里补 Bearer 前缀）。
	validToken := "Bearer " + forgedJWT()

	cases := []struct {
		name          string
		request       *http.Request
		legacyStatus  int
		wantRepoCalls int
	}{
		// legacy 200 + 合法形态 Bearer payload → 执行一次。
		{"legacy-200-executes-once", onboardingRequest(http.MethodGet, validToken), http.StatusOK, 1},
		// legacy 非 200（401/403/404/500 同语义）→ 零执行。
		{"legacy-401-zero-execution", onboardingRequest(http.MethodGet, validToken), http.StatusUnauthorized, 0},
		{"legacy-404-zero-execution", onboardingRequest(http.MethodGet, validToken), http.StatusNotFound, 0},
		{"legacy-500-zero-execution", onboardingRequest(http.MethodGet, validToken), http.StatusInternalServerError, 0},
		// token 缺失/损坏 → 零执行。
		{"missing-token-zero-execution", onboardingRequest(http.MethodGet, ""), http.StatusOK, 0},
		{"corrupted-token-zero-execution", onboardingRequest(http.MethodGet, "Bearer aaa.bbb.ccc"), http.StatusOK, 0},
		// PUT 绝不双发（即使 token 与 legacy 状态都合法）。
		{"put-zero-execution", onboardingRequest(http.MethodPut, validToken), http.StatusOK, 0},
		// 精确路径：同前缀的其他路径不进入该 shadow 单元。
		{"other-path-zero-execution", func() *http.Request {
			req, _ := http.NewRequest(http.MethodGet, "http://g/api/user-settings/ui/onboarding-x", nil)
			req.Header.Set("Authorization", validToken)
			return req
		}(), http.StatusOK, 0},
	}

	for _, tc := range cases {
		repo := &countingRepo{}
		disp := onboardingTestDispatcher(repo)
		disp.ObserveShadow(tc.request, tc.legacyStatus, http.Header{}, []byte(`{}`), "")
		// ObserveResult 是异步的——等待 runner 执行完成（runShadowSync
		// 轮询 repo.calls，上限 2s）。
		deadline := time.Now().Add(2 * time.Second)
		for repo.calls < tc.wantRepoCalls && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if repo.calls != tc.wantRepoCalls {
			t.Errorf("%s: repo calls = %d, want %d", tc.name, repo.calls, tc.wantRepoCalls)
		}
	}
}

// 路由表精确规则：onboarding 路径处于 shadow，且不是 canary/go。
func TestOnboardingRouteIsShadow(t *testing.T) {
	for _, rule := range legacyproxy.DefaultRules() {
		if rule.Prefix == "/api/user-settings/ui/onboarding" {
			if rule.Mode != legacyproxy.ModeShadow {
				t.Fatalf("/api/user-settings/ui/onboarding mode = %s, want shadow", rule.Mode)
			}
			return
		}
	}
	t.Fatal("/api/user-settings/ui/onboarding not found in DefaultRules")
}

// onboarding 端点未注册客户端可见的 Go handler：shadow 是旁路差分，
// 不是客户端响应路径（若有人误加 RegisterGoHandler 接管响应，此测试
// 失败——提醒先完成 Go Auth/RBAC）。
func TestOnboardingHasNoClientGoHandler(t *testing.T) {
	gateway, err := legacyproxy.New("http://legacy:4000", legacyproxy.DefaultRules())
	if err != nil {
		t.Fatal(err)
	}
	for _, rule := range gateway.Rules() {
		if rule.Prefix == "/api/user-settings/ui/onboarding" && rule.Mode != legacyproxy.ModeShadow {
			t.Fatalf("onboarding rule mode = %s, want shadow", rule.Mode)
		}
	}
}

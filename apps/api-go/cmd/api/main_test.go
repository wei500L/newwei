package main

import (
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/canary"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
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

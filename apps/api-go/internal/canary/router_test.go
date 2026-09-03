package canary

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// makeJWT 构造一个不签名的 JWT 形 token（payload 够解析 orgId 即可——
// 注意：canary 只读 claim 不验签，这正是被测的信任边界）。
func makeJWT(t *testing.T, orgID string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, err := json.Marshal(map[string]any{"sub": "user-1", "orgId": orgID, "permissions": []string{"items.read"}})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	signature := base64.RawURLEncoding.EncodeToString([]byte("forged-signature"))
	return header + "." + payloadB64 + "." + signature
}

// 分流数学组件测试：显式开启 AllowUnverifiedIdentity 后的桶位语义。
// 生产装配（cmd/api/main.go）不开启该开关——见信任边界测试。
func newTestRouter(percent int) *Router {
	return NewRouter(Options{Percent: percent, AllowUnverifiedIdentity: true})
}

func TestPercentZeroMeansLegacy(t *testing.T) {
	router := newTestRouter(0)
	// 比例 0 等价 legacy：无论 orgId 桶位如何都不进 go。
	if got := router.Route("Bearer " + makeJWT(t, "org-a")); got != ModeLegacy {
		t.Errorf("percent=0 → %s, want legacy", got)
	}
}

func TestPercent100MeansGoForKnownOrg(t *testing.T) {
	router := newTestRouter(100)
	if got := router.Route("Bearer " + makeJWT(t, "org-a")); got != ModeGo {
		t.Errorf("percent=100 → %s, want go", got)
	}
}

func TestRoutingIsStablePerOrg(t *testing.T) {
	router := newTestRouter(50)
	token := makeJWT(t, "org-stable")
	first := router.Route("Bearer " + token)
	for i := 0; i < 100; i++ {
		if got := router.Route("Bearer " + token); got != first {
			t.Fatalf("routing unstable for same org: first=%s, later=%s", first, got)
		}
	}
}

func TestSameOrgSameModeAcrossPercentChange(t *testing.T) {
	// 桶位是 org 的属性：比例变化只改变边界，不重排组织。
	orgA := makeJWT(t, "org-boundary")
	r10 := newTestRouter(10)
	r60 := newTestRouter(60)
	if newTestRouter(100).Route("Bearer "+orgA) != ModeGo {
		t.Fatal("percent=100 must route go")
	}
	b := Bucket("org-boundary")
	if r10.Route("Bearer "+orgA) == ModeGo && b >= 10 {
		t.Fatalf("bucket=%d routed go at 10%%", b)
	}
	if r60.Route("Bearer "+orgA) == ModeGo && b >= 60 {
		t.Fatalf("bucket=%d routed go at 60%%", b)
	}
}

func TestMissingTokenFallsBackToLegacy(t *testing.T) {
	router := newTestRouter(100)
	for _, header := range []string{"", "Bearer ", "Basic abc", "Bearer mtk_machine-token"} {
		if got := router.Route(header); got != ModeLegacy {
			t.Errorf("Route(%q) = %s, want legacy (无法解析身份回退)", header, got)
		}
	}
}

func TestMalformedJWTTokenFallsBackToLegacy(t *testing.T) {
	router := newTestRouter(100)
	for _, token := range []string{
		"not-a-jwt",
		"only-two.parts",
		"Bearer .invalid-base64().sig",
	} {
		if got := router.Route("Bearer " + token); got != ModeLegacy {
			t.Errorf("Route(Bearer %q) = %s, want legacy", token, got)
		}
	}
}

func TestOrgIDWithoutClaimFallsBack(t *testing.T) {
	router := newTestRouter(100)
	// payload 无 orgId claim（sub-only token）→ legacy。
	header := "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) +
		"." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"u1"}`)) +
		"." + base64.RawURLEncoding.EncodeToString([]byte("s"))
	if got := router.Route(header); got != ModeLegacy {
		t.Errorf("token without orgId → %s, want legacy", got)
	}
}

func TestPercentBoundsAreClamped(t *testing.T) {
	if NewRouter(Options{Percent: -5}).Percent() != 0 {
		t.Error("negative percent must clamp to 0")
	}
	if NewRouter(Options{Percent: 150}).Percent() != 100 {
		t.Error("percent >100 must clamp to 100")
	}
}

func TestBucketIsInUnitRange(t *testing.T) {
	for _, org := range []string{"org-a", "org-b", "", "x", "very-long-organization-id"} {
		if b := Bucket(org); b >= 100 {
			t.Errorf("Bucket(%q) = %d, want < 100", org, b)
		}
	}
}

// ---- 信任边界（fail-safe）测试 ----

// 默认构造（不开启 AllowUnverifiedIdentity）：即使 percent=100、token
// 是完整可解析的 JWT 形状，也一律回 legacy——伪造身份不可能通过误配
// 比例进入受保护的 Go 实现。
func TestDefaultGateNeverRoutesUnverifiedIdentityToGo(t *testing.T) {
	router := NewRouter(Options{Percent: 100}) // 生产装配同款：不开开关
	for _, tc := range []struct {
		name  string
		token string
	}{
		{"forged-valid-shaped-jwt", makeJWT(t, "attacker-chosen-org")},
		{"forged-other-org", makeJWT(t, "org-any")},
		{"garbage", "not-a-jwt-at-all"},
		{"empty", ""},
	} {
		if got := router.Route("Bearer " + tc.token); got != ModeLegacy {
			t.Errorf("%s: Route = %s, want legacy（默认门禁必须拦下未验证身份）", tc.name, got)
		}
	}
	// 无 Authorization 头同理。
	if got := router.Route(""); got != ModeLegacy {
		t.Errorf("no auth header: Route = %s, want legacy", got)
	}
}

// 信任边界是版本间契约：开关一旦被误删（默认翻转），此测试立即失败，
// 提醒评审者重新审视 canary 的身份来源。
func TestRouterDefaultsToUnverifiedClaimDisallowed(t *testing.T) {
	router := NewRouter(Options{Percent: 100})
	if router.allowUnverifiedClaim {
		t.Fatal("AllowUnverifiedIdentity must default to false — canary 不得依赖未验签 claim 分流")
	}
}

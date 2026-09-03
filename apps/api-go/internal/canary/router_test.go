package canary

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// makeJWT 构造一个不签名的 JWT 形 token（payload 够解析 orgId 即可——
// canary 只读 claim 不验签）。
func makeJWT(t *testing.T, orgID string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, err := json.Marshal(map[string]any{"sub": "user-1", "orgId": orgID, "permissions": []string{"items.read"}})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(payload)
	signature := base64.RawURLEncoding.EncodeToString([]byte("sig"))
	return header + "." + payloadB64 + "." + signature
}

func TestPercentZeroMeansLegacy(t *testing.T) {
	router := NewRouter(0)
	// 比例 0 等价 legacy：无论 orgId 桶位如何都不进 go。
	if got := router.Route("Bearer " + makeJWT(t, "org-a")); got != ModeLegacy {
		t.Errorf("percent=0 → %s, want legacy", got)
	}
}

func TestPercent100MeansGoForKnownOrg(t *testing.T) {
	router := NewRouter(100)
	if got := router.Route("Bearer " + makeJWT(t, "org-a")); got != ModeGo {
		t.Errorf("percent=100 → %s, want go", got)
	}
}

func TestRoutingIsStablePerOrg(t *testing.T) {
	router := NewRouter(50)
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
	r10 := NewRouter(10)
	r60 := NewRouter(60)
	r100 := NewRouter(100)
	if r100.Route("Bearer "+orgA) != ModeGo {
		t.Fatal("percent=100 must route go")
	}
	// 桶位 < 10 才会在 10% 也走 go；>= 10 则 60% 也不该走（除非桶位<60）。
	b := Bucket("org-boundary")
	if r10.Route("Bearer "+orgA) == ModeGo && b >= 10 {
		t.Fatalf("bucket=%d routed go at 10%%", b)
	}
	if r60.Route("Bearer "+orgA) == ModeGo && b >= 60 {
		t.Fatalf("bucket=%d routed go at 60%%", b)
	}
}

func TestMissingTokenFallsBackToLegacy(t *testing.T) {
	router := NewRouter(100)
	for _, header := range []string{"", "Bearer ", "Basic abc", "Bearer mtk_machine-token"} {
		if got := router.Route(header); got != ModeLegacy {
			t.Errorf("Route(%q) = %s, want legacy (无可靠 orgId 回退)", header, got)
		}
	}
}

func TestMalformedJWTTokenFallsBackToLegacy(t *testing.T) {
	router := NewRouter(100)
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

func TestPercentBoundsAreClamped(t *testing.T) {
	if NewRouter(-5).Percent() != 0 {
		t.Error("negative percent must clamp to 0")
	}
	if NewRouter(150).Percent() != 100 {
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

func TestOrgIDWithoutClaimFallsBack(t *testing.T) {
	router := NewRouter(100)
	// payload 无 orgId claim（sub-only token）→ legacy。
	header := "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) +
		"." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"u1"}`)) +
		"." + base64.RawURLEncoding.EncodeToString([]byte("s"))
	if got := router.Route(header); got != ModeLegacy {
		t.Errorf("token without orgId → %s, want legacy", got)
	}
}

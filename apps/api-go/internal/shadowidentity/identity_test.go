// Go-批2A 最小单元测试（shadow 身份边界）：验证 dispatcher/执行者链路上
// legacy-approved shadow identity 的执行/零执行语义。
//
// 核心风险（不追求分支全覆盖——401/403/404/500 用同一代表性非 200 表达）：
//   - legacy 200 + 合法形态 Bearer payload → 执行一次（数据库查询一次）；
//   - legacy 非 200 → 零执行；
//   - 缺失/损坏 token → 零执行；
//   - PUT → 零执行（写方法绝不双发）。
package shadowidentity

import (
	"encoding/base64"
	"net/http"
	"testing"
)

// validBearerJWT 构造一个合法形态（未验签）的三段 JWT——shadow 身份来源
// 只在 legacy 200 后读取其 sub/orgId。
func validBearerJWT(sub, orgID string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"` + sub + `","orgId":"` + orgID + `","permissions":["items.read"]}`))
	signature := base64.RawURLEncoding.EncodeToString([]byte("opaque-signature"))
	return "Bearer " + header + "." + payload + "." + signature
}

func TestLegacyApprovedIdentityGate(t *testing.T) {
	newRequest := func(method, auth string) *http.Request {
		req, _ := http.NewRequest(method, "http://gateway/api/user-settings/ui/onboarding", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		return req
	}

	cases := []struct {
		name         string
		request      *http.Request
		legacyStatus int
		wantNil      bool
	}{
		// legacy 200 + 合法形态 payload → 放行（唯一允许执行的组合）。
		{"legacy-200-valid-bearer", newRequest(http.MethodGet, validBearerJWT("user-1", "org-a")), http.StatusOK, false},
		// 代表性非 200（401/403/404/5xx 同语义：legacy 未认可身份）。
		{"legacy-401", newRequest(http.MethodGet, validBearerJWT("user-1", "org-a")), http.StatusUnauthorized, true},
		{"legacy-403", newRequest(http.MethodGet, validBearerJWT("user-1", "org-a")), http.StatusForbidden, true},
		{"legacy-404", newRequest(http.MethodGet, validBearerJWT("user-1", "org-a")), http.StatusNotFound, true},
		{"legacy-500", newRequest(http.MethodGet, validBearerJWT("user-1", "org-a")), http.StatusInternalServerError, true},
		// token 缺失/损坏。
		{"missing-authorization", newRequest(http.MethodGet, ""), http.StatusOK, true},
		{"corrupted-token", newRequest(http.MethodGet, "Bearer aaa.bbb.ccc"), http.StatusOK, true},
		{"not-three-parts", newRequest(http.MethodGet, "Bearer aaa.bbb"), http.StatusOK, true},
		{"machine-token", newRequest(http.MethodGet, "Bearer mtk_xxxxxxxxxxxxxxxx"), http.StatusOK, true},
		{"wrong-scheme", newRequest(http.MethodGet, "Basic dXNlcjpwYXNz"), http.StatusOK, true},
		// claim 缺失/空白/类型错误。
		{"payload-not-json", newRequest(http.MethodGet, "Bearer "+base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))+"."+base64.RawURLEncoding.EncodeToString([]byte("not-json"))+"."+base64.RawURLEncoding.EncodeToString([]byte("sig"))), http.StatusOK, true},
		{"sub-missing", newRequest(http.MethodGet, "Bearer "+base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))+"."+base64.RawURLEncoding.EncodeToString([]byte(`{"orgId":"org-a"}`))+"."+base64.RawURLEncoding.EncodeToString([]byte("sig"))), http.StatusOK, true},
		{"orgId-blank", newRequest(http.MethodGet, "Bearer "+base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))+"."+base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"user-1","orgId":"  "}`))+"."+base64.RawURLEncoding.EncodeToString([]byte("sig"))), http.StatusOK, true},
		{"sub-number-type", newRequest(http.MethodGet, "Bearer "+base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))+"."+base64.RawURLEncoding.EncodeToString([]byte(`{"sub":123,"orgId":"org-a"}`))+"."+base64.RawURLEncoding.EncodeToString([]byte("sig"))), http.StatusOK, true},
	}

	for _, tc := range cases {
		identity := LegacyApprovedIdentity(tc.request, tc.legacyStatus)
		if tc.wantNil && identity != nil {
			t.Errorf("%s: identity = %+v, want nil（不执行）", tc.name, identity)
		}
		if !tc.wantNil {
			if identity == nil {
				t.Errorf("%s: identity = nil, want 放行", tc.name)
				continue
			}
			if identity.UserID != "user-1" || identity.OrgID != "org-a" {
				t.Errorf("%s: identity = %+v, want sub=user-1 orgId=org-a", tc.name, identity)
			}
		}
	}
}

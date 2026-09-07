// authn 的 access token 验签表格测试（Go-批3A）。
//
// 用 golang-jwt 以与 NestJS jsonwebtoken.sign 相同的 claim 形态签发
// 测试 token（HS256 + sub/orgId/permissions/jti/iat/exp/iss/aud），
// 覆盖代表性情况（不为每个错误分支单独建函数）：
//   - 真实形态 HS256 合法 token（含 permissions claim——验签结果不含
//     permissions：结构上 Token 就没有该字段，授权永不读 claim）；
//   - 签名错误（不同 secret）；
//   - alg=none 与 HS384（算法混淆拒绝）；
//   - issuer / audience 错误；
//   - 过期（exp 过去）与 nbf 未到（两者 NestJS 均拒绝）；
//   - jti 缺失按 NestJS 当前语义放行（JTI 为空，blacklist 由调用方跳过）；
//   - sub / orgId 缺失拒绝；
//   - Bearer 提取：缺失 header、非 Bearer scheme、mtk_ 机器令牌拒绝，
//     小写 bearer 与多空格容忍（passport-jwt 正则语义）。
package authn

import (
	"net/http"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	testSecret     = "0f1e2d3c4b5a69788697a5b4c3d2e1f0a9b8c7d6e5f40312030211c1d1e1f20"
	otherSecret    = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	testIssuer     = "modular-monolith"
	testAudience   = "modular-monolith-clients"
	otherIssuer    = "someone-else"
	otherAudience  = "someone-else-clients"
)

// signToken 用指定算法与 secret 签发测试 token（claim 形态镜像
// NestJS signAccessToken：sub/orgId/permissions + jwtid + exp/iat）。
func signToken(t *testing.T, method jwt.SigningMethod, secret any, overrides map[string]any, deleteKeys ...string) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":         "user-authn-1",
		"orgId":       "org-authn-1",
		"permissions": []string{"items.read", "settings.manage"},
		"iat":         now.Add(-time.Minute).Unix(),
		"exp":         now.Add(14 * time.Minute).Unix(),
		"jti":         "jti-authn-1",
		"iss":         testIssuer,
		"aud":         testAudience,
	}
	for key, value := range overrides {
		if value == nil {
			delete(claims, key)
			continue
		}
		claims[key] = value
	}
	for _, key := range deleteKeys {
		delete(claims, key)
	}
	token := jwt.NewWithClaims(method, claims)
	signed, err := token.SignedString(secret)
	if err != nil {
		t.Fatalf("sign test token: %v", err)
	}
	return signed
}

func TestVerifyTable(t *testing.T) {
	verifier := NewVerifier(testSecret, testIssuer, testAudience)
	valid := signToken(t, jwt.SigningMethodHS256, []byte(testSecret), nil)

	cases := []struct {
		name    string
		token   string
		wantErr bool
		wantJTI string
	}{
		{"valid-hs256", valid, false, "jti-authn-1"},
		{"valid-without-jti", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), nil, "jti"), false, ""},
		{"wrong-secret", signToken(t, jwt.SigningMethodHS256, []byte(otherSecret), nil), true, ""},
		{"alg-none", signToken(t, jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, nil), true, ""},
		{"alg-hs384", signToken(t, jwt.SigningMethodHS384, []byte(testSecret), nil), true, ""},
		{"wrong-issuer", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), map[string]any{"iss": otherIssuer}), true, ""},
		{"missing-issuer", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), nil, "iss"), true, ""},
		{"wrong-audience", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), map[string]any{"aud": otherAudience}), true, ""},
		{"expired", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), map[string]any{"exp": time.Now().Add(-time.Minute).Unix()}), true, ""},
		{"nbf-in-future", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), map[string]any{"nbf": time.Now().Add(time.Hour).Unix()}), true, ""},
		{"missing-sub", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), map[string]any{"sub": nil}), true, ""},
		{"missing-orgid", signToken(t, jwt.SigningMethodHS256, []byte(testSecret), map[string]any{"orgId": nil}), true, ""},
		{"garbage", "aaa.bbb.ccc", true, ""},
	}
	for _, tc := range cases {
		token, err := verifier.Verify(tc.token)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: Verify succeeded, want error", tc.name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: Verify error = %v, want success", tc.name, err)
			continue
		}
		if token.Subject != "user-authn-1" || token.OrgID != "org-authn-1" || token.JTI != tc.wantJTI {
			t.Errorf("%s: token = %+v, want sub=org-authn-1 身份字段", tc.name, token)
		}
	}

	// Bearer 提取（authn 的提取边界；权限判定在 authz/smoke 层验证）。
	bearerCases := []struct {
		name   string
		header string
		want   string
	}{
		{"missing-header", "", ""},
		{"wrong-scheme", "Basic dXNlcjpwYXNz", ""},
		{"machine-token", "Bearer mtk_xxxxxxxxxxxxxxxx", ""},
		{"empty-bearer", "Bearer ", ""},
		{"lowercase-bearer", "bearer " + valid, valid},
		{"extra-space", "Bearer   " + valid, valid},
		{"valid", "Bearer " + valid, valid},
	}
	for _, tc := range bearerCases {
		req, _ := http.NewRequest(http.MethodGet, "http://gateway/api/user-settings/ui/onboarding", nil)
		if tc.header != "" {
			req.Header.Set("Authorization", tc.header)
		}
		if got := ExtractBearerToken(req); got != tc.want {
			t.Errorf("%s: ExtractBearerToken = %q, want %q", tc.name, got, tc.want)
		}
	}
}

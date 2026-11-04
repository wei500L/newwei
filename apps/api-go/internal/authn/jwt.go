// Package authn 是 api-go 的 access token 认证层（Go-批3A）。
//
// 职责：Bearer 提取、NestJS 签发 access token 的独立验签（HS256/issuer/
// audience/exp）、registered claims 中业务必需字段的提取、Redis
// access-token blacklist 查询。
//
// 契约对齐（NestJS 事实源，逐行核实于本批开工）：
//   - 签发：jsonwebtoken.sign(payload, secret, {expiresIn, audience,
//     issuer, jwtid})——未指定 algorithm，即 HS256（auth.service.ts
//     signAccessToken）；
//   - 验证：passport-jwt + @nestjs/passport——HMAC 签名、issuer 严格相等、
//     audience 包含、exp 存在即校验（ignoreExpiration:false）、nbf 存在即
//     校验、iat 不校验；任何 passport 层失败统一 401 message "Unauthorized"
//     （auth.guard.js handleRequest 抛无参 UnauthorizedException）；
//   - jti：NestJS 当前 token 恒有 jti（签发点恒写 UUIDv4），Go 在此强制
//     要求 jti 非空——缺 jti 的 token 一律验签失败（对外 401）。这是有意
//     变更：历史 Nest 语义对缺 jti 的 token 跳过 blacklist 而放行，导致这类
//     token 无法登出/吊销；强制 jti 后所有合法 token 都能被撤销；
//   - permissions claim：一律不读取、不信任（授权只来自 authz 的 MySQL
//     重推导）；
//   - mtk_ 机器令牌：authn.ExtractBearerToken 仍拒绝 mtk_（人类端点不接受
//     机器令牌）；机器令牌由 authhttp 的 MachineResolver 单独解析。
//
// 信任边界：Verify 成功只代表「token 是 NestJS 以同一 secret 签发的」，
// 不代表「请求已被授权」——可信用户上下文要等 authz 完成 membership 与
// permission 检查后才成立。
package authn

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken 是验签失败的统一错误（对调用方只暴露这一种——NestJS
// 对应路径就是无差别的 401 "Unauthorized"；具体原因只进服务端日志，
// 且 golang-jwt 的错误文本不含 token 原文）。
var ErrInvalidToken = errors.New("invalid access token")

// ExtractBearerToken extracts the token part of `Authorization: Bearer <token>`.
//
// Contract note (verified, do not repeat the older claim of regex parity):
// passport-jwt's fromAuthHeaderAsBearerToken splits the header on a single space
// and requires exactly two parts whose scheme equals "Bearer"
// case-insensitively; it does not trim the credentials. This function instead
// tolerates any number of spaces and trims the token, so `Bearer   <jwt>` is
// extracted here and yields null (→ 401) under passport-jwt. The difference only
// makes Go more permissive, and any accepted token still has to verify, so the
// behaviour is kept and locked by jwt_test.go.
//
// Both sides reject a missing header, a non-Bearer scheme and an empty token
// (→ 401 "Unauthorized"). mtk_ machine tokens are rejected on purpose: this
// extractor only serves human endpoints, which must keep rejecting machine
// tokens with the same 401. Routes that accept machine tokens use
// authhttp.Authenticator.AuthenticateWithMachine, which extracts the raw bearer
// itself and hands mtk_ tokens to the shared MachineResolver.
func ExtractBearerToken(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	token := strings.TrimSpace(header[7:])
	if token == "" || strings.HasPrefix(token, "mtk_") {
		return ""
	}
	return token
}

// Token 是已验签 access token 的身份材料（最小字段集——本批端点只需要
// sub/orgId/jti/exp；permissions 刻意不存在）。
type Token struct {
	Subject string // sub → userId
	OrgID   string // orgId → 待验证的组织上下文（须再经 authz 重推导）
	JTI     string // jti（Verify 保证非空——缺 jti 即验签失败）
	// ExpiresAt is the verified exp claim as a UTC instant. NestJS-issued
	// tokens always carry exp; when it is missing the field stays at its zero
	// value so callers omit the JWT metadata instead of fabricating 0. The
	// value comes exclusively from the verified claims and is never derived
	// from an unsigned jwt decode, so it is safe for blacklist TTLs.
	ExpiresAt time.Time
}

// Verifier 用与 NestJS 相同的 HMAC secret 验证 access token。
type Verifier struct {
	secret   []byte
	issuer   string
	audience string
}

// NewVerifier 构造验签器。secret/issuer/audience 来自与 NestJS api 服务
// 相同的环境变量（config 层保证非空）。
func NewVerifier(secret, issuer, audience string) *Verifier {
	return &Verifier{secret: []byte(secret), issuer: issuer, audience: audience}
}

// Verify 验证 rawToken 并提取身份字段。
//
// 只接受 HS256（WithValidMethods 同时拒绝 alg=none 与 HS384/HS512/RS256
// 等算法混淆）；issuer 严格相等；audience 包含匹配；exp/nbf 存在即校验
// （leeway 0——与 jsonwebtoken 默认一致，不自行扩大时钟容忍）；iat 不
// 校验（jsonwebtoken 亦不校验）。sub/orgId/jti 必须是非空字符串（NestJS
// 签发的 token 恒有三者；缺失说明不是合法签发形态，且无 jti 的 token 无法
// 撤销，故一律拒绝）。jti 去空白后返回。
func (v *Verifier) Verify(rawToken string) (Token, error) {
	parsed, err := jwt.Parse(rawToken, func(*jwt.Token) (any, error) {
		return v.secret, nil
	},
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
	)
	if err != nil {
		return Token{}, ErrInvalidToken
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !parsed.Valid {
		return Token{}, ErrInvalidToken
	}

	sub, _ := claims["sub"].(string)
	orgID, _ := claims["orgId"].(string)
	jti, _ := claims["jti"].(string)
	jti = strings.TrimSpace(jti)
	if strings.TrimSpace(sub) == "" || strings.TrimSpace(orgID) == "" {
		return Token{}, ErrInvalidToken
	}
	// A token without jti cannot be blacklisted, so logout/revocation would be
	// silently ineffective for it. Reject it here (uniform 401) instead of
	// letting it bypass the revocation list.
	if jti == "" {
		return Token{}, ErrInvalidToken
	}
	// exp is already validated by the jwt library during verification (when
	// present it must not be expired). Convert it to a UTC instant here; a
	// missing or non-positive value keeps the zero time so callers omit the
	// metadata.
	expiresAt := time.Time{}
	switch rawExp := claims["exp"].(type) {
	case float64:
		if rawExp > 0 {
			expiresAt = time.Unix(int64(rawExp), 0).UTC()
		}
	case json.Number:
		if value, convErr := rawExp.Int64(); convErr == nil && value > 0 {
			expiresAt = time.Unix(value, 0).UTC()
		}
	}
	return Token{Subject: sub, OrgID: orgID, JTI: jti, ExpiresAt: expiresAt}, nil
}

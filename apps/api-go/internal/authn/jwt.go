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
//   - jti：NestJS 当前 token 恒有 jti，但 JwtStrategy 对缺失 jti 的旧
//     token 不查 blacklist 仍放行——Go 严格复刻该语义（jti 为空 → 跳过
//     blacklist）；
//   - permissions claim：一律不读取、不信任（授权只来自 authz 的 MySQL
//     重推导）；
//   - mtk_ 机器令牌：机器令牌迁移不在本批范围，Go 端点不接受
//     （见下方 ExtractBearerToken 的说明）。
//
// 信任边界：Verify 成功只代表「token 是 NestJS 以同一 secret 签发的」，
// 不代表「请求已被授权」——可信用户上下文要等 authz 完成 membership 与
// permission 检查后才成立。
package authn

import (
	"errors"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken 是验签失败的统一错误（对调用方只暴露这一种——NestJS
// 对应路径就是无差别的 401 "Unauthorized"；具体原因只进服务端日志，
// 且 golang-jwt 的错误文本不含 token 原文）。
var ErrInvalidToken = errors.New("invalid access token")

// ExtractBearerToken 提取 Authorization: Bearer <token> 的 token 部分。
//
// 契约对齐：passport-jwt 的 fromAuthHeaderAsBearerToken 用大小写不敏感
// 的 /^Bearer\s+(.+)$/i 提取；缺失 header、非 Bearer scheme、空 token
// 都返回 ""（→ 401 "Unauthorized"）。mtk_ 机器令牌明确拒绝：机器令牌
// 迁移不在 Go-批3A 范围（NestJS 侧 mtk_ 走独立的机器令牌校验路径），
// Go 端点只接受 NestJS 签发的 JWT。
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
// sub/orgId/jti；permissions 刻意不存在）。
type Token struct {
	Subject string // sub → userId
	OrgID   string // orgId → 待验证的组织上下文（须再经 authz 重推导）
	JTI     string // jti（可为空——空时按 NestJS 语义跳过 blacklist）
}

// Verifier 用与 NestJS 相同的 HMAC secret 验证 access token。
type Verifier struct {
	secret    []byte
	issuer    string
	audience  string
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
//（leeway 0——与 jsonwebtoken 默认一致，不自行扩大时钟容忍）；iat 不
// 校验（jsonwebtoken 亦不校验）。sub/orgId 必须是非空字符串（NestJS
// 签发的 token 恒有两者；缺失说明不是合法签发形态）。jti 原样返回，
// 是否查询 blacklist 由调用方按 NestJS 语义决定。
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
	if strings.TrimSpace(sub) == "" || strings.TrimSpace(orgID) == "" {
		return Token{}, ErrInvalidToken
	}
	return Token{Subject: sub, OrgID: orgID, JTI: strings.TrimSpace(jti)}, nil
}

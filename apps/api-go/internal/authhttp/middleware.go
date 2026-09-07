// authhttp 的鉴权链装配：Bearer 提取 → JWT 验签（authn）→ Redis
// blacklist（authn）→ membership/permission 重推导（authz）→ 可信身份。
//
// 顺序与 NestJS 完全一致（JwtAuthGuard.validate → PermissionsGuard）：
// 认证失败（401）先于权限判断（403）；任何一层失败都立即写出契约等价
// 错误并终止——绝不降级为相信 JWT 的 permissions claim，也绝不错误后
// 偷偷代理 NestJS。
//
// 「成功解析 JWT」不等于「授权成功」：Authenticate 返回非 nil Identity
// 才代表 membership 与 permission 检查全部完成（Go-批3A 的核心边界）。
package authhttp

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

// Authenticator 串联认证与授权（由 main 注入具体实现，依赖方向单向：
// authhttp → authn → authz）。
type Authenticator struct {
	verifier  *authn.Verifier
	blacklist authn.Blacklist
	authz     authz.Repository
}

// NewAuthenticator 构造鉴权链。
func NewAuthenticator(verifier *authn.Verifier, blacklist authn.Blacklist, authzRepo authz.Repository) *Authenticator {
	return &Authenticator{verifier: verifier, blacklist: blacklist, authz: authzRepo}
}

// Identity 是鉴权链全部通过后的可信用户上下文（request context 的等价
// 物——以显式返回值交给 handler，类型安全且不可被下游伪造）。
type Identity struct {
	UserID string
	OrgID  string
	// permissions 来自 authz 的 MySQL 重推导（绝无 JWT claim 参与）。
	permissions map[string]bool
}

// HasPermission 按数据库推导的权限集判定。
func (id *Identity) HasPermission(name string) bool {
	return id.permissions[name]
}

// Authenticate 执行完整鉴权链。
//
// 失败时写出契约等价错误并返回 nil（调用方必须立即 return）；成功时
// 返回可信身份。所有失败路径 fail-closed：Redis/MySQL 查询错误不作为
// 「未撤销/未拒绝」处理。
func (a *Authenticator) Authenticate(w http.ResponseWriter, r *http.Request) *Identity {
	// 1. Bearer 提取（authn——含 mtk_ 机器令牌拒绝）。
	raw := authn.ExtractBearerToken(r)
	if raw == "" {
		WriteUnauthorized(w, r, "")
		return nil
	}

	// 2. JWT 验签（HS256/iss/aud/exp；sub/orgId 非空）。失败原因只进
	//    服务端日志（golang-jwt 错误文本不含 token 原文），响应统一为
	//    NestJS 的无差别 401 "Unauthorized"。
	token, err := a.verifier.Verify(raw)
	if err != nil {
		log.Printf("authn: token rejected: %v", err)
		WriteUnauthorized(w, r, "")
		return nil
	}

	// 3. Redis blacklist（仅当 jti 非空——严格复刻 NestJS 对缺失 jti
	//    旧 token 的放行语义）。查询失败 fail-closed 500，绝不放行。
	if token.JTI != "" {
		revoked, err := a.blacklist.Revoked(r.Context(), token.JTI)
		if err != nil {
			log.Printf("authn: blacklist query failed: %v", err)
			WriteRedisFailure(w, r)
			return nil
		}
		if revoked {
			WriteUnauthorized(w, r, "Access token revoked")
			return nil
		}
	}

	// 4. membership/user/permission 重推导（真实 MySQL）。
	authorization, err := a.authz.Authorize(r.Context(), token.Subject, token.OrgID)
	if err != nil {
		var rejection *authz.Rejection
		if errors.As(err, &rejection) {
			log.Printf("authz: rejected: %s", rejection.Message)
			WriteUnauthorized(w, r, rejection.Message)
			return nil
		}
		// 数据库错误 fail-closed 503（绝不把查询失败当作拒绝之外的第
		// 叁种结果，更绝不放行）。
		log.Printf("authz: database error: %v", err)
		WriteDatabaseFailure(w, r)
		return nil
	}

	return &Identity{
		UserID:      authorization.UserID,
		OrgID:       authorization.OrgID,
		permissions: authorization.Permissions,
	}
}

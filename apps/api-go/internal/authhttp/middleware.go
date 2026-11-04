// authhttp 的鉴权链装配：Bearer 提取 → JWT 验签（authn）→ Redis
// blacklist（authn）→ membership/permission 重推导（authz）→ 可信身份；
// mtk_ 机器令牌走 authhttp.MachineResolver。
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
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

// Authenticator 串联认证与授权（由 main 注入具体实现，依赖方向单向：
// authhttp → authn → authz）。machines 是唯一的机器令牌解析器，人类链与
// 机器链共用同一实例。
type Authenticator struct {
	verifier  *authn.Verifier
	blacklist authn.Blacklist
	authz     authz.Repository
	machines  *MachineResolver
}

// NewAuthenticator 构造鉴权链。
func NewAuthenticator(verifier *authn.Verifier, blacklist authn.Blacklist, authzRepo authz.Repository, machines *MachineResolver) *Authenticator {
	return &Authenticator{verifier: verifier, blacklist: blacklist, authz: authzRepo, machines: machines}
}

// Machines exposes the shared machine-token resolver so callers that keep their
// own decision logic (account security profile, metrics platform-admin check,
// health probe) reuse the same query implementation.
func (a *Authenticator) Machines() *MachineResolver {
	if a == nil {
		return nil
	}
	return a.machines
}

// Verifier, Blacklist and Authz expose the shared human-chain dependencies so
// the Socket.IO transports can be wired from the single construction instead of
// building their own verifier/blacklist/authz.
func (a *Authenticator) Verifier() *authn.Verifier {
	if a == nil {
		return nil
	}
	return a.verifier
}

// Blacklist exposes the shared revocation-list dependency.
func (a *Authenticator) Blacklist() authn.Blacklist {
	if a == nil {
		return nil
	}
	return a.blacklist
}

// Authz exposes the shared authorization repository dependency.
func (a *Authenticator) Authz() authz.Repository {
	if a == nil {
		return nil
	}
	return a.authz
}

// Identity 是鉴权链全部通过后的可信用户上下文（request context 的等价
// 物——以显式返回值交给 handler，类型安全且不可被下游伪造）。
type Identity struct {
	UserID string
	OrgID  string
	// permissions 来自 authz 的 MySQL 重推导（绝无 JWT claim 参与）。
	permissions map[string]bool

	// Verified access-token metadata. Populated by the human chain from the
	// verified claims; zero for machine identities (which have no jti/exp and
	// whose claim org equals the row org).
	tokenID        string
	tokenExpiresAt time.Time
	claimOrgID     string
}

// NewIdentity 组装一份已完成重推导的身份，供接管端点的测试使用。
// 生产路径只经过 Authenticate，不从请求参数填这个结构。
func NewIdentity(userID, orgID string, permissions []string) *Identity {
	set := make(map[string]bool, len(permissions))
	for _, permission := range permissions {
		set[permission] = true
	}
	return &Identity{UserID: userID, OrgID: orgID, permissions: set}
}

// TokenID is the verified jti (empty for machine identities).
func (id *Identity) TokenID() string {
	if id == nil {
		return ""
	}
	return id.tokenID
}

// TokenExpiresAt is the verified exp instant (zero when absent or machine).
func (id *Identity) TokenExpiresAt() time.Time {
	if id == nil {
		return time.Time{}
	}
	return id.tokenExpiresAt
}

// ClaimOrgID is the raw orgId access-token claim (membership OrgID may differ
// when the token was issued with an organization slug). Machine identities use
// their row org.
func (id *Identity) ClaimOrgID() string {
	if id == nil {
		return ""
	}
	return id.claimOrgID
}

// HasPermission 按数据库推导的权限集判定。
func (id *Identity) HasPermission(name string) bool {
	return id.permissions[name]
}

// AuthFailure is an authentication failure that the caller maps into its own
// response shape. Status is 401, 500 (Redis), or 503 (MySQL).
type AuthFailure struct {
	Status  int
	Message string
}

func (f *AuthFailure) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// resolve runs Bearer verification, the Redis blacklist and the authz
// re-derivation for a human JWT. It is the single core behind Identify,
// Authenticate and the socket ResolveToken entry. It never writes a response and
// never touches the request-scoped verified-identity publication; callers that
// have a *http.Request do that themselves.
func (a *Authenticator) resolve(ctx context.Context, raw string) (*Identity, *AuthFailure) {
	if raw == "" {
		return nil, &AuthFailure{Status: http.StatusUnauthorized, Message: "Unauthorized"}
	}
	token, err := a.verifier.Verify(raw)
	if err != nil {
		// Only the server-side log sees the reason; the response is the uniform
		// 401 "Unauthorized" passport produces.
		log.Printf("authn: token rejected: %v", err)
		return nil, &AuthFailure{Status: http.StatusUnauthorized, Message: "Unauthorized"}
	}
	// Verify now rejects tokens without jti, so the blacklist lookup is
	// unconditional: every accepted token can be revoked.
	revoked, err := a.blacklist.Revoked(ctx, token.JTI)
	if err != nil {
		log.Printf("authn: blacklist query failed: %v", err)
		return nil, &AuthFailure{Status: http.StatusInternalServerError, Message: "Internal server error"}
	}
	if revoked {
		return nil, &AuthFailure{Status: http.StatusUnauthorized, Message: "Access token revoked"}
	}
	authorization, err := a.authz.Authorize(ctx, token.Subject, token.OrgID)
	if err != nil {
		var rejection *authz.Rejection
		if errors.As(err, &rejection) {
			log.Printf("authz: rejected: %s", rejection.Message)
			return nil, &AuthFailure{Status: http.StatusUnauthorized, Message: rejection.Message}
		}
		log.Printf("authz: database error: %v", err)
		return nil, &AuthFailure{Status: http.StatusServiceUnavailable, Message: "Internal server error"}
	}
	return &Identity{
		UserID:         authorization.UserID,
		OrgID:          authorization.OrgID,
		permissions:    authorization.Permissions,
		tokenID:        token.JTI,
		tokenExpiresAt: token.ExpiresAt,
		claimOrgID:     token.OrgID,
	}, nil
}

// resolveMachine resolves an mtk_ token through the shared resolver. A missing
// resolver or a database error maps to 503; only ErrInvalidMachineToken maps to
// the 401 "Invalid machine token" contract.
func (a *Authenticator) resolveMachine(ctx context.Context, raw string) (*Identity, *AuthFailure) {
	if a == nil || a.machines == nil {
		return nil, &AuthFailure{Status: http.StatusServiceUnavailable, Message: "Internal server error"}
	}
	identity, err := a.machines.Resolve(ctx, raw)
	if err != nil {
		if errors.Is(err, ErrInvalidMachineToken) {
			return nil, &AuthFailure{Status: http.StatusUnauthorized, Message: "Invalid machine token"}
		}
		log.Printf("authhttp: machine token lookup failed: %v", err)
		return nil, &AuthFailure{Status: http.StatusServiceUnavailable, Message: "Internal server error"}
	}
	return identity, nil
}

// writeFailure maps an AuthFailure onto the contract error responses:
// 401 → WriteUnauthorized, 500 (Redis) → WriteRedisFailure, else → 503.
func (a *Authenticator) writeFailure(w http.ResponseWriter, r *http.Request, failure *AuthFailure) {
	switch failure.Status {
	case http.StatusUnauthorized:
		WriteUnauthorized(w, r, failure.Message)
	case http.StatusInternalServerError:
		WriteRedisFailure(w, r)
	default:
		WriteDatabaseFailure(w, r)
	}
}

// Identify runs the same chain as Authenticate without writing a response.
// GraphQL uses it so errors stay in the GraphQL envelope.
func (a *Authenticator) Identify(r *http.Request) (*Identity, *AuthFailure) {
	identity, failure := a.resolve(r.Context(), authn.ExtractBearerToken(r))
	if failure != nil {
		return nil, failure
	}
	// GraphQL failures are recorded by the executor, but the identity it reports
	// comes from this chain; publishing it here keeps one source of truth for
	// orgId/userId.
	SetVerifiedIdentity(r, identity)
	return identity, nil
}

// PermissionSet copies the derived permission names. The map is safe for the
// caller to keep; it is not the authenticator's internal map.
func (id *Identity) PermissionSet() map[string]bool {
	if id == nil {
		return nil
	}
	out := make(map[string]bool, len(id.permissions))
	for name, ok := range id.permissions {
		if ok {
			out[name] = true
		}
	}
	return out
}

// Authenticate 执行完整鉴权链。
//
// 失败时写出契约等价错误并返回 nil（调用方必须立即 return）；成功时
// 返回可信身份。所有失败路径 fail-closed：Redis/MySQL 查询错误不作为
// 「未撤销/未拒绝」处理。
func (a *Authenticator) Authenticate(w http.ResponseWriter, r *http.Request) *Identity {
	identity, failure := a.resolve(r.Context(), authn.ExtractBearerToken(r))
	if failure != nil {
		a.writeFailure(w, r, failure)
		return nil
	}
	// Publish the verified identity so a failure written later in the same request
	// (a permission check, a validation error, a service error) is attributed to
	// this tenant in the exception event.
	SetVerifiedIdentity(r, identity)
	return identity
}

// AuthenticateWithMachine is the single entry point for routes that accept both
// human JWTs and mtk_ machine tokens. It extracts the raw bearer itself (authn's
// extractor deliberately rejects mtk_), routes mtk_ to the machine resolver and
// everything else to the human core, then enforces the optional permission gate.
// Failure order is unchanged: authentication (401) before permission (403).
func (a *Authenticator) AuthenticateWithMachine(w http.ResponseWriter, r *http.Request, permission string) *Identity {
	raw := extractRawBearer(r)
	if raw == "" {
		WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *Identity
	var failure *AuthFailure
	if strings.HasPrefix(raw, "mtk_") {
		identity, failure = a.resolveMachine(r.Context(), raw)
	} else {
		identity, failure = a.resolve(r.Context(), raw)
	}
	if failure != nil {
		a.writeFailure(w, r, failure)
		return nil
	}
	if permission != "" && !identity.HasPermission(permission) {
		WriteForbidden(w, r, []string{permission})
		return nil
	}
	SetVerifiedIdentity(r, identity)
	return identity
}

// ResolveToken is the request-free entry for Socket.IO handshakes, where the
// token arrives from the handshake payload/query rather than a normal
// Authorization header. Callers keep their own handshake error wording.
func (a *Authenticator) ResolveToken(ctx context.Context, raw string) (*Identity, *AuthFailure) {
	return a.resolve(ctx, raw)
}

// ResolveHandshakeToken is the shared handshake core for socket packages that
// hold the authn/authz dependencies directly instead of a fully assembled
// Authenticator (they also need the individual steps for revalidation). It runs
// the exact same human chain as the HTTP Authenticator and returns the same
// AuthFailure shape, so the socket packages only keep their error wording.
func ResolveHandshakeToken(ctx context.Context, verifier *authn.Verifier, blacklist authn.Blacklist, authzRepo authz.Repository, raw string) (*Identity, *AuthFailure) {
	authenticator := &Authenticator{verifier: verifier, blacklist: blacklist, authz: authzRepo}
	return authenticator.resolve(ctx, raw)
}

// extractRawBearer returns the raw bearer token without filtering mtk_ tokens.
// Routes that reject machine tokens must keep using authn.ExtractBearerToken;
// only AuthenticateWithMachine uses this.
func extractRawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

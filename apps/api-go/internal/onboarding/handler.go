// Package onboarding 是首个由 Go 全响应的业务迁移单元（Go-批3A）：
//
//	GET /api/user-settings/ui/onboarding
//
// 请求顺序（任务书第十二节，与 NestJS JwtAuthGuard → PermissionsGuard →
// controller 的真实顺序一致）：
//
//	提取 Bearer token → JWT 验签 → Redis blacklist → MySQL
//	user/org/membership → MySQL role/permission → items.read →
//	UserSetting 查询 → normalization → Go 写出响应
//
// 边界（与 legacy-approved shadow identity 的本质区别）：
//   - 不请求 NestJS、不等待 legacy 200、不读取 JWT 的 permissions claim；
//   - 身份与权限全部由 Go 独立验证（authn 验签 + authz MySQL 重推导）；
//   - 响应正文/头部与 NestJS 契约一致（usersettings.BuildOnboardingResponse
//     复用既有 normalization，本包不重复实现）；
//   - 非 GET 不进入本 handler（路由层 method 白名单 + 本包防御性检查）。
//
// 回滚：API_GO_ONBOARDING_MODE=shadow（配置变更，无数据迁移耦合）。
package onboarding

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// Path 是本迁移单元的精确路由（路由表 exact 匹配键）。
const Path = "/api/user-settings/ui/onboarding"

// RequiredPermission 是本端点的数据库推导权限要求（@Permissions("items.read")）。
const RequiredPermission = "items.read"

// Handler 依赖注入：完整 Go 鉴权链 + 既有 onboarding repository。
type Handler struct {
	auth authhttp.Authenticator
	repo usersettings.Repository
}

// NewHandler 构造 onboarding GET 的 Go 原生 handler。
func NewHandler(auth *authhttp.Authenticator, repo usersettings.Repository) *Handler {
	return &Handler{auth: *auth, repo: repo}
}

// ServeHTTP 处理 GET /api/user-settings/ui/onboarding。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 路由层已按 method 白名单只放行 GET；此处防御性兜底（NestJS 该
	// 路由只注册 GET，其他方法 404）。
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}

	// 完整 Go 鉴权链（失败时已写出契约错误）。
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}

	// items.read 由 Go 从数据库推导的权限集独立判定（JWT claim 不参与）。
	if !identity.HasPermission(RequiredPermission) {
		authhttp.WriteForbidden(w, r, []string{RequiredPermission})
		return
	}

	// 业务查询：复用既有 onboarding repository 与 normalization（固定
	// key，租户隔离 orgId+userId）。
	record, err := h.repo.FindOnboarding(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		log.Printf("onboarding: query failed: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}

	body, err := json.Marshal(usersettings.BuildOnboardingResponse(record))
	if err != nil {
		log.Printf("onboarding: marshal response failed: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}

	// 契约头部：Cache-Control: no-store（@Header 装饰器）；content-type
	// 与 Express res.json 一致（含 charset）。正文不追加换行（与
	// res.json 字节形态一致）。
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

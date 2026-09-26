// Package usersettingsread 是 user-settings 六个只读 GET 的统一 Go
// 迁移单元（Go-批3B 收敛 Go-批3A 的 internal/onboarding——不新增第六套
// 鉴权，全部端点共用同一 authn/authz/authhttp 链）。
//
// 六个端点：
//
//	GET /api/user-settings/ui/onboarding
//	GET /api/user-settings/ui/rss-reader
//	GET /api/user-settings/ui/spacetime-timeline
//	GET /api/user-settings/ui/war-map
//	GET /api/user-settings/ui/newsnow
//	GET /api/user-settings/ui/situation-monitor
//
// 请求链（与 NestJS JwtAuthGuard → PermissionsGuard → controller 顺序
// 一致）：
//
//	提取 Bearer token → JWT 验签 → Redis blacklist → MySQL
//	user/org/membership → MySQL role/permission → items.read →
//	对应固定 UserSetting 查询 → normalization → Go 写出响应
//
// 边界：
//   - 不请求 NestJS、不等待 legacy 200、不读取 JWT 的 permissions claim；
//   - 身份与权限全部由 Go 独立验证（authhttp.Authenticate 一次装配，
//     六个端点共享）；
//   - 响应正文/头部与 NestJS 契约一致（usersettings.Build*Response 复用
//     normalization，本包不重复实现）；
//   - 非 GET 不进入本 handler（路由层 method 白名单 + 本包防御性检查）；
//   - repository 查询 key 是编译期固定常量（usersettings 包封闭集合）。
//
// 回滚：API_GO_USER_SETTINGS_READ_MODE=shadow（配置变更，无数据迁移
// 耦合）。
package usersettingsread

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// RequiredPermission 是六个端点共同的数据库推导权限要求
//（@Permissions("items.read")）。
const RequiredPermission = "items.read"

// Paths 是六个只读 GET 的精确路由（路由表 exact 匹配键——顺序固定，
// 注册时逐条登记）。
var Paths = [6]string{
	"/api/user-settings/ui/onboarding",
	"/api/user-settings/ui/rss-reader",
	"/api/user-settings/ui/spacetime-timeline",
	"/api/user-settings/ui/war-map",
	"/api/user-settings/ui/newsnow",
	"/api/user-settings/ui/situation-monitor",
}

// Handler 是六个 GET 共享的统一 Go 原生 handler：同一鉴权链 +
// usersettings repository；只有「查询哪个端点语义」由请求 path 决定。
type Handler struct {
	auth authhttp.Authenticator
	repo usersettings.Repository
}

// NewHandler 构造统一 handler。auth 是六个端点共享的鉴权链装配
//（Bearer 提取 → JWT 验签 → Redis blacklist → MySQL membership/RBAC）；
// repo 是同一 MySQL 连接池上的 user-settings 只读 repository。
func NewHandler(auth *authhttp.Authenticator, repo usersettings.Repository) *Handler {
	return &Handler{auth: *auth, repo: repo}
}

// ServeHTTP 处理一个 user-settings 只读 GET。
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

	// 固定 repository 查询（按端点语义——key 是 usersettings 包内编译期
	// 常量）+ normalization + 响应写出。六个端点共用同一 handler 流程，
	// 只有 query/build 这一步不同——以一个闭包字段承接，不复制六份 handler。
	query, build, ok := endpointBinding(r.URL.Path)
	if !ok {
		// 路由层 exact 匹配保证不会走到这里；防御性 404。
		http.NotFound(w, r)
		return
	}
	response, err := query(r.Context(), h.repo, identity.OrgID, identity.UserID)
	if err != nil {
		log.Printf("user-settings read: query failed: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	body, err := json.Marshal(build(response))
	if err != nil {
		log.Printf("user-settings read: marshal response failed: %v", err)
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

// queryContext 是查询闭包的 context 参数类型（r.Context() 的等价物——
// 显式类型避免闭包签名里直接引用 net/http 上下文细节）。
type queryContext = context.Context

// endpointBinding 返回该 path 的固定查询与响应构建（编译期绑定表——
// 不是注册框架：新增端点 = 在此表加一行 + usersettings 加 key/normalizer）。
func endpointBinding(path string) (func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error), func(any) any, bool) {
	switch path {
	case Paths[0]:
		return func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error) {
				return repo.FindOnboarding(ctx, orgID, userID)
			},
			func(response any) any {
				return usersettings.BuildOnboardingResponse(response.(usersettings.Record))
			}, true
	case Paths[1]:
		return func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error) {
				return repo.FindRSSReader(ctx, orgID, userID)
			},
			func(response any) any {
				return usersettings.BuildRSSReaderResponse(response.(usersettings.Record))
			}, true
	case Paths[2]:
		return func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error) {
				return repo.FindSpacetimeTimeline(ctx, orgID, userID)
			},
			func(response any) any {
				return usersettings.BuildSpacetimeTimelineResponse(response.(usersettings.Record))
			}, true
	case Paths[3]:
		return func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error) {
				return repo.FindWarMap(ctx, orgID, userID)
			},
			func(response any) any {
				return usersettings.BuildWarMapResponse(response.(usersettings.Record))
			}, true
	case Paths[4]:
		return func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error) {
				return repo.FindNewsnow(ctx, orgID, userID)
			},
			func(response any) any {
				return usersettings.BuildNewsnowResponse(response.(usersettings.Record))
			}, true
	case Paths[5]:
		return func(ctx queryContext, repo usersettings.Repository, orgID, userID string) (any, error) {
				return repo.FindSituationMonitor(ctx, orgID, userID)
			},
			func(response any) any {
				return usersettings.BuildSituationMonitorResponse(response.(usersettings.SituationMonitorRecords))
			}, true
	}
	return nil, nil, false
}

// Package authhttp 把 authn/authz 的鉴权结果装配为可用的请求上下文，
// 并写出与 NestJS GlobalExceptionFilter 契约等价的错误响应。
//
// 契约对齐（apps/api/src/common/filters/global-exception.filter.ts，
// 逐行核实）：
//
//	statusCode / message / error / code / detail / requiredPermissions /
//	permissionsMode / missingPermissions / traceId / path / timestamp
//
// 时间戳为 JavaScript Date.toISOString() 等价格式（毫秒 UTC）。traceId
// 由 httpx.TraceMiddleware 注入（所有响应都会带 x-trace-id——与 NestJS
// 错误过滤器的 setHeader 行为一致）。
//
// 错误映射（与 NestJS 真实行为逐一对齐，不凭空设计）：
//   - JWT 无效（缺 Authorization/非 Bearer/mtk_/签名/算法/iss/aud/exp/
//     sub-orgId 缺失）→ 401 {message:"Unauthorized", error:"Unauthorized"}
//     （@nestjs/passport handleRequest 抛无参 UnauthorizedException）；
//   - token 已撤销 → 401 {message:"Access token revoked"}（JwtStrategy
//     validate 内主动抛出，原样透传）；
//   - user/org/membership 状态拒绝 → 401 + authz.Rejection 的具体 message
//     （getUserProfile 同序同文案）；
//   - 缺权限 → 403 INSUFFICIENT_PERMISSIONS（@Permissions 为 any 模式：
//     detail="Requires any permission: …"，missingPermissions 为 undefined
//     不出现在 JSON）；
//   - Redis 查询失败 → 500 {statusCode:500, message:"Internal server
//     error"}（NestJS：ioredis 抛非 HttpException 错误，生产环境无
//     error 字段）——fail-closed；
//   - MySQL 查询失败 → 503 同形状（NestJS：Prisma 连接类错误 → 503）
//     ——fail-closed。
package authhttp

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// nestTimestamp 是 new Date().toISOString() 等价格式（毫秒 UTC）。
func nestTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// errorBody 是 GlobalExceptionFilter REST 错误形状的最小 Go 镜像。
// 字段声明顺序即序列化顺序（与 NestJS 展开顺序一致；缺省字段不出现）。
type errorBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error,omitempty"`

	// 以下为 safe payload（仅当 code 通过 ^[A-Z0-9_]+$ 白名单时携带）。
	Code                string   `json:"code,omitempty"`
	Detail              string   `json:"detail,omitempty"`
	RequiredPermissions []string `json:"requiredPermissions,omitempty"`
	PermissionsMode     string   `json:"permissionsMode,omitempty"`

	TraceID   string `json:"traceId"`
	Path      string `json:"path"`
	Timestamp string `json:"timestamp"`
}

// writeError 写出契约错误（content-type 与 NestJS Express res.json 一致）。
func writeError(w http.ResponseWriter, r *http.Request, body errorBody) {
	traceID := httpx.TraceIDFromContext(r.Context())
	body.TraceID = traceID
	body.Path = r.URL.Path
	body.Timestamp = nestTimestamp()
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(body.StatusCode)
	// 不追加换行（与 Express res.json 的字节形态一致——契约比对按字节
	// 等价成立）。
	data, err := json.Marshal(body)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}

// WriteUnauthorized 写 401。message 为空时用 NestJS 无参
// UnauthorizedException 的默认值 "Unauthorized"（passport 层失败的统一
// 形态）；非空时是 validate 内主动抛出的具体文案（如 "Access token
// revoked"、"Organization disabled"）。
func WriteUnauthorized(w http.ResponseWriter, r *http.Request, message string) {
	if message == "" {
		message = "Unauthorized"
	}
	writeError(w, r, errorBody{
		StatusCode: http.StatusUnauthorized,
		Message:    message,
		Error:      "Unauthorized",
	})
}

// WriteForbidden 写 403 INSUFFICIENT_PERMISSIONS（any 模式——与
// @Permissions 装饰器一致；missingPermissions 为 undefined，不出现）。
func WriteForbidden(w http.ResponseWriter, r *http.Request, requiredPermissions []string) {
	writeError(w, r, errorBody{
		StatusCode:          http.StatusForbidden,
		Message:             "Insufficient permissions",
		Error:               "Forbidden",
		Code:                "INSUFFICIENT_PERMISSIONS",
		Detail:              "Requires any permission: " + strings.Join(requiredPermissions, ", "),
		RequiredPermissions: requiredPermissions,
		PermissionsMode:     "any",
	})
}

// WriteRedisFailure 写 Redis 查询失败的 fail-closed 500（NestJS：非
// HttpException → 生产环境 {statusCode, message:"Internal server error"}，
// 无 error 字段）。
func WriteRedisFailure(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusInternalServerError,
		Message:    "Internal server error",
	})
}

// WriteDatabaseFailure 写 MySQL 查询失败的 fail-closed 503（NestJS：
// Prisma 连接类错误 → 503；正文同为通用 "Internal server error"）。
func WriteDatabaseFailure(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusServiceUnavailable,
		Message:    "Internal server error",
	})
}

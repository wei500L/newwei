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
	// path is Express request.url: the escaped path *and* the query string, so a
	// 401 on /api/auth/x?a=1 reports "/api/auth/x?a=1". RequestURI is the only
	// accessor that keeps both parts (URL.Path drops the query and decodes the
	// path, which also differs from Express's raw url).
	body.Path = r.URL.RequestURI()
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

// WriteInternalFailure 写非 HttpException 的生产 500（NestJS：
// {statusCode, message:"Internal server error"}，无 error 字段）。
// Redis 查询失败与 Mongo 查询失败都是这个形状。
func WriteInternalFailure(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusInternalServerError,
		Message:    "Internal server error",
	})
}

// WriteRedisFailure 写 Redis 查询失败的 fail-closed 500。
func WriteRedisFailure(w http.ResponseWriter, r *http.Request) {
	WriteInternalFailure(w, r)
}

// WriteDatabaseFailure 写 MySQL 查询失败的 fail-closed 503（NestJS：
// Prisma 连接类错误 → 503；正文同为通用 "Internal server error"）。
func WriteDatabaseFailure(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusServiceUnavailable,
		Message:    "Internal server error",
	})
}

// WriteHTTPException 写 Nest HttpException 的生产形状：message 原样，
// error 由状态码枚举名转成 "Bad Request" / "Not Found" / "Forbidden"。
// 不带 code。权限不足仍用 WriteForbidden，那是另一套安全载荷。
func WriteHTTPException(w http.ResponseWriter, r *http.Request, status int, message string) {
	writeError(w, r, errorBody{
		StatusCode: status,
		Message:    message,
		Error:      httpStatusErrorName(status),
	})
}

func httpStatusErrorName(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "Bad Request"
	case http.StatusUnauthorized:
		return "Unauthorized"
	case http.StatusForbidden:
		return "Forbidden"
	case http.StatusNotFound:
		return "Not Found"
	case http.StatusConflict:
		return "Conflict"
	case http.StatusTooManyRequests:
		return "Too Many Requests"
	default:
		if status >= 500 {
			return "Internal Server Error"
		}
		return "Error"
	}
}

// WriteBadRequest 写 ValidationPipe / body-parser 映射后的 400
// （GlobalExceptionFilter 把 class-validator 的 message 数组用 "; " 拼成
// 一个字符串；error 为 "Bad Request"）。非法 JSON 也走这个形状：Nest
// 的 RoutesResolver.mapExternalException 把它收成 BadRequestException。
func WriteBadRequest(w http.ResponseWriter, r *http.Request, message string) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusBadRequest,
		Message:    message,
		Error:      "Bad Request",
	})
}

// WriteCodedBadRequest 写带安全 code 的 400。GlobalExceptionFilter 对
// HttpException 对象体保留 ^[A-Z0-9_]+$ 的 code，error 名来自 HTTP 状态。
func WriteCodedBadRequest(w http.ResponseWriter, r *http.Request, code, message string) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusBadRequest,
		Message:    message,
		Error:      "Bad Request",
		Code:       code,
	})
}

// WriteCodedConflict writes a 409 whose payload carries a safe error code and a
// detail string, mirroring ConflictException({ code, message, detail }) after
// GlobalExceptionFilter spread it (statusCode, message, error, code, detail).
// The code must match ^[A-Z0-9_]+$; a code outside that whitelist would be
// dropped by the filter, so it is dropped here as well.
func WriteCodedConflict(w http.ResponseWriter, r *http.Request, code, message, detail string) {
	if !isSafeErrorCode(code) {
		WriteHTTPException(w, r, http.StatusConflict, message)
		return
	}
	body := errorBody{
		StatusCode: http.StatusConflict,
		Message:    message,
		Error:      "Conflict",
		Code:       code,
	}
	if strings.TrimSpace(detail) != "" {
		body.Detail = detail
	}
	writeError(w, r, body)
}

// isSafeErrorCode mirrors GlobalExceptionFilter.isSafeErrorCode: a non-empty
// trimmed value consisting only of A-Z, 0-9 and underscore.
func isSafeErrorCode(code string) bool {
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return false
	}
	for _, r := range trimmed {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '_':
		default:
			return false
		}
	}
	return true
}

// WritePayloadTooLarge 写超过 JSON 体上限的响应。
//
// body-parser 自己的错误是 413 "request entity too large"，但 Nest 的
// GlobalExceptionFilter 不把它当成 HttpException。生产环境
// （NODE_ENV=production，远端 smoke run 36270657639）因此返回 500
// {"statusCode":500,"message":"Internal server error"}，没有 error 字段。
// 100KiB+1 仍低于 10MiB，继续走 JSON 400，不进这里。
func WritePayloadTooLarge(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, errorBody{
		StatusCode: http.StatusInternalServerError,
		Message:    "Internal server error",
	})
}

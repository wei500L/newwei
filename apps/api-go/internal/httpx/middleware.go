// Package httpx 是 api-go 的横切 HTTP 中间件与响应工具。
//
// trace 中间件镜像 apps/api 的 TraceIdMiddleware（common/middleware/trace-id.middleware.ts）：
// 读 x-trace-id / x-request-id / traceparent，回写 x-trace-id + traceparent。
// 生成规则与 @modular/utils 的 ensureTraceId 一致（≥16 位 hex 取前 32；否则随机 16 字节）。
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

type traceKey struct{}

// TraceIDFromContext 取当前请求的 trace id（无则空串）。
func TraceIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(traceKey{}).(string); ok {
		return v
	}
	return ""
}

// TraceMiddleware 为每个请求解析/生成 trace id 并回写响应头。
func TraceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceparent := r.Header.Get("traceparent")
		var otelTraceID string
		if traceparent != "" {
			parts := strings.Split(traceparent, "-")
			if len(parts) > 1 {
				otelTraceID = parts[1]
			}
		}
		source := r.Header.Get("x-trace-id")
		if source == "" {
			source = r.Header.Get("x-request-id")
		}
		if source == "" {
			source = otelTraceID
		}
		traceID := EnsureTraceID(source)
		normalizedTraceparent := traceparent
		if normalizedTraceparent == "" {
			normalizedTraceparent = "00-" + traceID + "-0000000000000000-01"
		}
		w.Header().Set("x-trace-id", traceID)
		w.Header().Set("traceparent", normalizedTraceparent)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), traceKey{}, traceID)))
	})
}

// EnsureTraceID 镜像 @modular/utils 的 ensureTraceId。
func EnsureTraceID(incoming string) string {
	var builder strings.Builder
	for _, r := range strings.TrimSpace(incoming) {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			builder.WriteRune(r)
		}
	}
	normalized := builder.String()
	if len(normalized) >= 16 {
		if len(normalized) > 32 {
			return normalized[:32]
		}
		return normalized
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		for i := range buf {
			buf[i] = byte(i + 1)
		}
	}
	return hex.EncodeToString(buf)
}

// WriteJSON 输出 JSON 响应。
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

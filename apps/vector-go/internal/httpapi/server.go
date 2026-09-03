// Package httpapi 实现 vector 服务的 HTTP 契约，逐条对齐
// apps/vector/src/modules/vector/vector.controller.ts（zod 校验语义）与
// apps/vector/src/common/middleware/trace-id.middleware.ts：
//   - POST /v1/upsert、POST /v1/search：需 x-internal-token（常量时间比较，
//     修复 TS 版非常量时间比较的 SEC-04）
//   - GET /healthz：公开
//   - 错误体沿用 NestJS 默认形状（statusCode/message/error），保证调用方
//     （packages/vector-client）无感切换
//   - trace 中间件：回写 x-trace-id + traceparent，生成规则与 TS ensureTraceId 一致
package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/vector-go/internal/qdrant"
)

const (
	// internalTokenHeader 与 TS InternalAuthGuard 读取的头一致。
	internalTokenHeader = "x-internal-token"
)

// Deps 注入 Qdrant 客户端（测试可替换）。
type Deps struct {
	InternalToken string
	Qdrant        *qdrant.Client
}

// New 构造 vector 服务的 http.Handler。
func New(deps Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("POST /v1/upsert", requireInternalToken(deps.InternalToken, handleUpsert(deps.Qdrant)))
	mux.HandleFunc("POST /v1/search", requireInternalToken(deps.InternalToken, handleSearch(deps.Qdrant)))
	return traceMiddleware(mux)
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func handleUpsert(client *qdrant.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw upsertRequest
		if err := decodeJSON(r, &raw); err != nil || !raw.validate() {
			writeNestError(w, http.StatusBadRequest, "Invalid upsert request")
			return
		}
		// 维度一致性在进入 Qdrant 前校验（镜像 TS VectorService.upsert 的分层）。
		if raw.mixedDimensions() {
			writeNestError(w, http.StatusBadRequest, "All vectors must share the same dimension")
			return
		}
		points := make([]qdrant.Point, 0, len(raw.Points))
		for _, p := range raw.Points {
			points = append(points, qdrant.Point{
				ProcessedItemID: p.ProcessedItemID,
				ItemMetaID:      p.ItemMetaID,
				CreatedAtMs:     numInt64(p.CreatedAtMs),
				Vector:          numsFloat64s(p.Vector),
			})
		}
		result, err := client.UpsertPoints(r.Context(), qdrant.UpsertRequest{
			OrgID:          raw.OrgID,
			EmbeddingModel: raw.EmbeddingModel,
			Points:         points,
		})
		if err != nil {
			writeInternalError(w)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func handleSearch(client *qdrant.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw searchRequest
		if err := decodeJSON(r, &raw); err != nil || !raw.validate() {
			writeNestError(w, http.StatusBadRequest, "Invalid search request")
			return
		}
		limit := 50
		if raw.Limit != nil {
			limit = numInt(*raw.Limit)
		}
		// 与 TS VectorService 一致：clamp 到 [1, 500]。
		if limit < 1 {
			limit = 1
		}
		if limit > 500 {
			limit = 500
		}
		var minScore *float64
		if raw.MinScore != nil {
			minScore = numFloatPtr(*raw.MinScore)
		}
		var lookbackMs *int64
		if raw.LookbackMs != nil {
			lookbackMs = numInt64Ptr(*raw.LookbackMs)
		}
		result, err := client.Search(r.Context(), qdrant.SearchRequest{
			OrgID:          raw.OrgID,
			EmbeddingModel: raw.EmbeddingModel,
			Vector:         numsFloat64s(raw.Vector),
			Limit:          limit,
			MinScore:       minScore,
			LookbackMs:     lookbackMs,
		})
		if err != nil {
			writeInternalError(w)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

// requireInternalToken 镜像 TS InternalAuthGuard：
// 空/缺失 token → 401 Missing；不匹配 → 401 Invalid。
// 比较使用 crypto/subtle.ConstantTimeCompare（TS 版为普通 ===，SEC-04）。
func requireInternalToken(expected string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get(internalTokenHeader)
		if strings.TrimSpace(token) == "" {
			writeNestError(w, http.StatusUnauthorized, "Missing internal token")
			return
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(expected)) != 1 {
			writeNestError(w, http.StatusUnauthorized, "Invalid internal token")
			return
		}
		next(w, r)
	}
}

type traceKey struct{}

// TraceIDFromContext 供日志侧取当前 trace。
func TraceIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(traceKey{}).(string); ok {
		return v
	}
	return ""
}

// traceMiddleware 镜像 apps/vector 的 TraceIdMiddleware。
func traceMiddleware(next http.Handler) http.Handler {
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
		traceID := ensureTraceID(source)
		normalizedTraceparent := traceparent
		if normalizedTraceparent == "" {
			normalizedTraceparent = "00-" + traceID + "-0000000000000000-01"
		}
		w.Header().Set("x-trace-id", traceID)
		w.Header().Set("traceparent", normalizedTraceparent)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), traceKey{}, traceID)))
	})
}

// ensureTraceID 镜像 @modular/utils 的 ensureTraceId：
// 去掉非 hex 字符；≥16 位取前 32 位；否则随机 16 字节 hex。
func ensureTraceID(incoming string) string {
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

func decodeJSON(r *http.Request, out any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(out); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeNestError 输出 NestJS 默认异常体形状，保证调用方兼容。
func writeNestError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"statusCode": status,
		"message":    message,
		"error":      http.StatusText(status),
	})
}

func writeInternalError(w http.ResponseWriter) {
	writeNestError(w, http.StatusInternalServerError, "Internal server error")
}

// ---- json.Number 校验/转换工具（镜像 zod 的 int/finite 语义）----

// numInt 把 JSON 数字安全转为 int（非法值返回 0，调用方已在 validate 阶段拦截）。
func numInt(n json.Number) int {
	f, err := n.Float64()
	if err != nil {
		return 0
	}
	return int(f)
}

// numInt64 把 JSON 数字安全转为 int64。
func numInt64(n json.Number) int64 {
	f, err := n.Float64()
	if err != nil {
		return 0
	}
	return int64(f)
}

// numFloatPtr 把可选 JSON 数字转为 *float64：缺失（空串）或非有限数为 nil。
func numFloatPtr(n json.Number) *float64 {
	if n == "" {
		return nil
	}
	f, err := n.Float64()
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	value := f
	return &value
}

// numInt64Ptr 把可选 JSON 数字转为 *int64：缺失、非有限数或非整数为 nil。
func numInt64Ptr(n json.Number) *int64 {
	if n == "" {
		return nil
	}
	f, err := n.Float64()
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return nil
	}
	value := int64(f)
	return &value
}

// numsFloat64s 把 JSON 数字数组转为 []float64。
func numsFloat64s(a []json.Number) []float64 {
	out := make([]float64, 0, len(a))
	for _, item := range a {
		if f, err := item.Float64(); err == nil {
			out = append(out, f)
		}
	}
	return out
}

// numsFiniteNonEmpty 校验：至少 1 个元素且全部为有限数。
func numsFiniteNonEmpty(a []json.Number) bool {
	if len(a) == 0 {
		return false
	}
	for _, item := range a {
		f, err := item.Float64()
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return false
		}
	}
	return true
}

// numIntInRange 校验整数值且落在 [min, max]（zod int + min/max 语义）。
func numIntInRange(n json.Number, min, max int64) bool {
	if n == "" {
		return false
	}
	f, err := n.Float64()
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return false
	}
	return f >= float64(min) && f <= float64(max)
}

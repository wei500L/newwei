// Package canary 实现 canary 模式的稳定分流（go-migration-adr §4）。
//
// 语义：
//   - 分流依据是稳定一致的：orgId 的 sha256 前 8 字节（big-endian uint64）
//     映射到 [0,100) 的桶位；桶位 < percent → go，否则 legacy。
//   - 有可靠 orgId（Bearer JWT payload 的 orgId claim）时按 orgId 稳定
//     哈希——同一组织永远进同一实现。
//   - 无法安全获得 orgId（无 token / 解不出 claim / 机器令牌格式）时
//     默认回 legacy（fail-safe：未知流量不进新实现）。
//   - percent=0 等价 legacy；percent=100 等价 go。
//   - 回滚：percent 调回 0（或路由表规则改回 legacy）——纯配置变更。
//
// 注意：canary 只读 JWT 的 orgId claim 用于分流，不验签——签名校验仍是
// NestJS（或 Go handler 内部）的职责。伪造 orgId 只能影响自己这条请求的
// 分流去向，两个实现共享同一鉴权语义，因此不构成提权。
package canary

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
)

// Router 按 orgId 稳定分流。
type Router struct {
	percent int
}

// NewRouter 构造 canary 分流器。percent 越界视为 0（fail-safe 回 legacy）。
func NewRouter(percent int) *Router {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return &Router{percent: percent}
}

// Percent 返回当前分流比例。
func (r *Router) Percent() int { return r.percent }

// Route 决定该请求去哪个实现。无可靠 orgId → legacy。
func (r *Router) Route(authorizationHeader string) Mode {
	if r.percent <= 0 {
		return ModeLegacy
	}
	orgID, ok := orgIDFromBearer(authorizationHeader)
	if !ok {
		return ModeLegacy
	}
	if Bucket(orgID) < uint64(r.percent) {
		return ModeGo
	}
	return ModeLegacy
}

// Mode 是分流结果。
type Mode string

const (
	ModeLegacy Mode = "legacy"
	ModeGo     Mode = "go"
)

// Bucket 把 orgId 映射到 [0,100) 的桶位（稳定：同 orgId 同桶）。
func Bucket(orgID string) uint64 {
	return shadow.StableHash("canary-org:"+orgID) % 100
}

// orgIDFromBearer 从 Authorization: Bearer 头解析 JWT payload 的 orgId。
// 返回 (orgId, ok)：token 缺失、格式不对、payload 无 orgId 都返回 ok=false。
//
// 机器令牌（mtk_ 前缀）不是 JWT——直接 ok=false（回 legacy）。
func orgIDFromBearer(header string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	if token == "" || strings.HasPrefix(token, "mtk_") {
		return "", false
	}
	return orgIDFromJWT(token)
}

func orgIDFromJWT(token string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	var claims struct {
		OrgID string `json:"orgId"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", false
	}
	if claims.OrgID == "" {
		return "", false
	}
	return claims.OrgID, true
}

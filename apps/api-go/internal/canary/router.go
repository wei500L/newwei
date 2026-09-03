// Package canary 实现 canary 模式的稳定分流（go-migration-adr §4）。
//
// 信任边界（诚实声明）：当前分流的 orgId 取自 Bearer JWT payload 的
// orgId claim，**未经验签**——NestJS 侧该 claim 只有在签名验证后才被
// 信任，且真实 org 上下文由 getUserProfile 从 DB membership 重推导
// （auth.service.ts:1452-1479：membership 查询 + active 校验）。Go 侧
// 尚未实现 JWT 验签与 membership 重推导（ADR 迁移序 5），因此：
//
//  1. 未验签 claim 不是「可靠 orgId」——伪造 token 可以任选 orgId，
//     从而选择自己这条请求进哪个实现；
//  2. Options.AllowUnverifiedIdentity 默认 false：Router 一律回 legacy，
//     即使 CANARY_PERCENT 被误配为 100——受保护业务路由不可能根据
//     未验证身份进入 Go；
//  3. 该开关只允许在「两个实现共享同一鉴权语义、且 shadow 差分已通过」
//     的场景显式开启，并在 Go 完成真实验签（迁移序 5）后被替换。
//
// 分流数学（开关开启后生效）：orgId 的 sha256 前 8 字节（big-endian
// uint64）映射到 [0,100) 桶位；桶位 < percent → go，否则 legacy。
// 同一 orgId 恒定同桶；percent 变化只移动边界，不重排组织。
// percent=0 等价 legacy；100 等价 go。
//
// 回滚：percent 调回 0（或路由表规则改回 legacy）——纯配置变更。
package canary

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
)

// Options 是 canary 分流器的构造参数。
type Options struct {
	Percent int
	// AllowUnverifiedIdentity 显式承认分流依据是未验签的 orgId claim。
	// 默认 false：Route() 永远回 legacy（fail-safe，percent 不起作用）。
	AllowUnverifiedIdentity bool
}

// Router 按稳定哈希分流。
type Router struct {
	percent              int
	allowUnverifiedClaim bool
}

// NewRouter 构造 canary 分流器。percent 越界 clamp 到 [0,100]。
func NewRouter(opts Options) *Router {
	percent := opts.Percent
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return &Router{
		percent:              percent,
		allowUnverifiedClaim: opts.AllowUnverifiedIdentity,
	}
}

// Percent 返回当前分流比例。
func (r *Router) Percent() int { return r.percent }

// Route 决定该请求去哪个实现。
//
// fail-safe 链（任何一环命中都回 legacy）：
//  1. 未显式开启 AllowUnverifiedIdentity（默认）——未验证身份不得
//     作为受保护路由的分流依据；
//  2. percent <= 0；
//  3. 无法解析 orgId claim（无 token / 非 JWT / mtk_ 机器令牌 / 无
//     claim / 解析失败）。
//
// 只有三者全部通过（且 claim 已知是未验签的——见包注释）才按桶位分流。
func (r *Router) Route(authorizationHeader string) Mode {
	if !r.allowUnverifiedClaim {
		return ModeLegacy
	}
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
// 注意：解析不等于验证——该函数不做签名校验。返回的 orgId 是客户端
// 可伪造的声明，只能作为「未验证的分流提示」，不得用于鉴权决策。
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

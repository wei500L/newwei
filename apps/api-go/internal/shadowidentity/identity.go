// legacy-approved shadow identity（Go-批2A 最重要的安全边界）。
//
// 语义：Go 尚未完成 JWT 验签、jti blacklist、membership 重推导与 RBAC，
// 因此受保护业务端点的 shadow 差分不得信任任何「Go 侧自认证」身份。
// 唯一允许的临时身份来源是 legacy 信任委托：
//
//  1. 同一请求先由 NestJS 执行（网关代理）；
//  2. 只有 NestJS 返回 HTTP 200，才认为「legacy 已认可该请求的身份与
//     权限」（JWT 验签 + jti 检查 + membership + items.read 全部通过）；
//  3. 此时才允许从 Bearer JWT payload 读取 sub（userId）与 orgId 作为
//     本次只读查询的输入。
//
// 这不是「Go 已验证身份」：payload 未验签、permissions claim 不读取也
// 不信任。它只在 legacy 200 的前提下把身份透传给本次只读 repository。
// NestJS 非 200（401/403/404/5xx 等）→ 零执行、零数据库查询。
package shadowidentity

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
)

// Identity 是 legacy-approved shadow 身份（只含本次只读查询所需字段）。
type Identity struct {
	OrgID  string
	UserID string
}

// LegacyApprovedIdentity 按信任边界链解析身份：
//   - authorization 缺失或非 Bearer → 不执行（nil）；
//   - JWT 不是三段结构 / payload Base64URL 或 JSON 无效 → 不执行；
//   - sub 或 orgId 缺失、空白或类型错误 → 不执行；
//   - legacyStatus != 200 → 不执行（NestJS 未认可身份）。
//
// 不读取、不信任 payload 里的 permissions claim。机器令牌（mtk_ 前缀）
// 不是 JWT → 不执行。
func LegacyApprovedIdentity(r *http.Request, legacyStatus int) *Identity {
	if legacyStatus != http.StatusOK {
		return nil
	}
	if r == nil {
		return nil
	}
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, prefix) {
		return nil
	}
	token := strings.TrimSpace(header[len(prefix):])
	if token == "" || strings.HasPrefix(token, "mtk_") {
		return nil
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	// 只声明需要的两个字段——permissions 等其余 claim 一律不读。
	var claims struct {
		Sub   string `json:"sub"`
		OrgID string `json:"orgId"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	if strings.TrimSpace(claims.Sub) == "" || strings.TrimSpace(claims.OrgID) == "" {
		return nil
	}
	return &Identity{OrgID: claims.OrgID, UserID: claims.Sub}
}

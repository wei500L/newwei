// Package authz 是 api-go 的授权层（Go-批3A）：从真实 MySQL 重新确认
// User/Org/Membership 有效性，并按 MembershipRole/RolePermission/
// Permission 重推导权限。
//
// 契约对齐（NestJS 事实源 AuthService.getUserProfile +
// membership-permissions.ts，逐行核实）：
//
//  1. token 的 sub 只作为 userId 查询条件；已验签的 orgId 只作为待验证
//     的组织上下文——membership 必须真实存在于该 user 与该 org 之间；
//  2. 用户无任何 membership → 401 "User is not assigned to an organization"；
//  3. 有 membership 但不匹配 orgId（或 slug）→ 401 "User is not assigned
//     to the specified organization"；
//  4. Org inactive → 401 "Organization disabled"（先于 membership 检查）；
//  5. Membership inactive → 401 "Organization access disabled"；
//  6. User 不存在 → 401 "Invalid access token"；User inactive → 401
//     "User disabled"（NestJS 在 membership 检查之后才查 user）；
//  7. 权限来源：MembershipRole 关联的多角色集合；仅当 MembershipRole
//     为空时回退 Membership.role（primary role）——两种情况下权限名都
//     来自 RolePermission → Permission.name，非空且去重；
//  8. JWT 内的 permissions claim 一律不参与（authn.Token 根本不携带）。
//
// 本包只输出当前端点所需的最小授权结果（userId/orgId/permission set），
// 不复制 NestJS AuthenticatedUser 的其余字段，也不实现通用权限引擎。
package authz

import "fmt"

// Rejection 表示「已验签身份被数据库状态拒绝」——按 NestJS 语义映射为
// 401 + 上述具体 message（由 authhttp 写出契约等价错误）。
type Rejection struct {
	Message string
}

func (r *Rejection) Error() string {
	return fmt.Sprintf("authorization rejected: %s", r.Message)
}

// Authorization 是 membership 与 permission 检查全部通过后的最小授权结果。
type Authorization struct {
	UserID string
	OrgID  string
	// permissions 是从数据库推导的权限名集合（去重）。来源与去重语义同
	// NestJS collectMembershipPermissionSet。
	Permissions map[string]bool
}

// HasPermission 报告数据库推导的权限集中是否包含 name。
func (a *Authorization) HasPermission(name string) bool {
	return a.Permissions[name]
}

// 拒绝语义常量（与 NestJS UnauthorizedException 的 message 一字不差）。
const (
	RejectNoMembership      = "User is not assigned to an organization"
	RejectMembershipMissing = "User is not assigned to the specified organization"
	RejectOrgDisabled       = "Organization disabled"
	RejectMembershipOff     = "Organization access disabled"
	RejectUserMissing       = "Invalid access token"
	RejectUserDisabled      = "User disabled"
)

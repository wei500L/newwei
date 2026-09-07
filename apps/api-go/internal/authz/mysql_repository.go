// authz 的 MySQL 实现——复用 api-go 已有的同一个 *sql.DB 连接池
//（与 user-settings 只读 repository 共享，绝不另开第二个 MySQL pool）。
//
// 查询约束：
//   - 全参数化（占位符），不拼接任何用户输入；
//   - 使用调用方传入的 ctx（请求上下文——请求取消即查询取消）；
//   - 表名/列名一律反引号转义（与 Prisma migration DDL 一致）；
//   - 查询失败只返回通用 ErrDatabase（详细错误进服务端日志，响应正文
//     不含 SQL/host/凭据）。
package authz

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ErrDatabase 是授权查询失败的通用错误（fail-closed 信号——调用方绝不
// 得将其当作拒绝或放行之外的第叁种结果）。
var ErrDatabase = errors.New("authz database error")

// MySQLRepository 是授权重推导的 MySQL 只读实现。
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository 用共享连接池构造（与 usersettings repository 同一个
// *sql.DB 实例）。
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

// membershipRow 是一次 membership 候选行的最小列集（pickMembership 判定
// 所需：orgId 精确/大小写不敏感匹配、org slug 匹配、双方 active 状态）。
type membershipRow struct {
	MembershipID string
	OrgID        string
	Active       bool
	OrgSlug      string
	OrgActive    bool
}

// Authorize 按 membership-permissions.ts + getUserProfile 的真实语义重推导。
func (r *MySQLRepository) Authorize(ctx context.Context, userID, orgID string) (*Authorization, error) {
	// 1. 该 user 的全部 membership（createdAt 升序——与 Prisma findMany
	//    orderBy 一致，pickMembership 在此顺序上取首个匹配）。列名全部
	//    限定（Membership 与 Org 都有 id/isActive，不限定即歧义）。
	rows, err := r.db.QueryContext(ctx,
		"SELECT `m`.`id`, `m`.`orgId`, `m`.`isActive`, `o`.`slug`, `o`.`isActive` FROM `Membership` `m` "+
			"JOIN `Org` `o` ON `o`.`id` = `m`.`orgId` "+
			"WHERE `m`.`userId` = ? ORDER BY `m`.`createdAt` ASC", userID)
	if err != nil {
		return nil, fmt.Errorf("%w: query membership: %v", ErrDatabase, err)
	}
	var memberships []membershipRow
	for rows.Next() {
		var row membershipRow
		if err := rows.Scan(&row.MembershipID, &row.OrgID, &row.Active, &row.OrgSlug, &row.OrgActive); err != nil {
			rows.Close()
			return nil, fmt.Errorf("%w: scan membership: %v", ErrDatabase, err)
		}
		memberships = append(memberships, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("%w: iterate membership: %v", ErrDatabase, err)
	}
	rows.Close()

	if len(memberships) == 0 {
		return nil, &Rejection{Message: RejectNoMembership}
	}

	// 2. pickMembership：按 claim 匹配 orgId（精确或大小写不敏感）或
	//    org slug（大小写不敏感）——与 auth.service.ts 的匹配谓词一致。
	var matched *membershipRow
	for i := range memberships {
		row := memberships[i]
		if row.OrgID == orgID ||
			strings.EqualFold(row.OrgID, orgID) ||
			(len(row.OrgSlug) > 0 && strings.EqualFold(row.OrgSlug, orgID)) {
			matched = &memberships[i]
			break
		}
	}
	if matched == nil {
		return nil, &Rejection{Message: RejectMembershipMissing}
	}

	// 3. assertMembershipAccessible：org 先于 membership（NestJS 同序）。
	if !matched.OrgActive {
		return nil, &Rejection{Message: RejectOrgDisabled}
	}
	if !matched.Active {
		return nil, &Rejection{Message: RejectMembershipOff}
	}

	// 4. user 存在且 active（NestJS 在 membership 检查之后才查 user）。
	var userActive bool
	err = r.db.QueryRowContext(ctx,
		"SELECT `isActive` FROM `User` WHERE `id` = ?", userID).Scan(&userActive)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &Rejection{Message: RejectUserMissing}
	}
	if err != nil {
		return nil, fmt.Errorf("%w: query user: %v", ErrDatabase, err)
	}
	if !userActive {
		return nil, &Rejection{Message: RejectUserDisabled}
	}

	// 5. 权限重推导：MembershipRole 关联角色优先；仅当无任何
	//    MembershipRole 行时回退 Membership.role（primary role）。两种
	//    路径的权限名都来自 RolePermission → Permission.name，非空去重
	//    （DISTINCT + map；与 collectMembershipPermissionSet 的 Set 语义
	//    一致）。
	permissions, err := r.permissionNames(ctx, matched.MembershipID)
	if err != nil {
		return nil, err
	}

	return &Authorization{
		UserID:      userID,
		OrgID:       matched.OrgID,
		Permissions: permissions,
	}, nil
}

// permissionNames 推导该 membership 的权限名集合。
func (r *MySQLRepository) permissionNames(ctx context.Context, membershipID string) (map[string]bool, error) {
	// MembershipRole 行存在（FK 保证其 role 必然存在）→ 多角色路径；
	// 否则 primary role 回退——边界判定与 collectMembershipRoles 的
	// roles.length > 0 一致。
	var hasMembershipRoles bool
	err := r.db.QueryRowContext(ctx,
		"SELECT EXISTS(SELECT 1 FROM `MembershipRole` WHERE `membershipId` = ?)", membershipID).
		Scan(&hasMembershipRoles)
	if err != nil {
		return nil, fmt.Errorf("%w: query membership roles: %v", ErrDatabase, err)
	}

	var query string
	if hasMembershipRoles {
		query = "SELECT DISTINCT `p`.`name` FROM `MembershipRole` `mr` " +
			"JOIN `RolePermission` `rp` ON `rp`.`roleId` = `mr`.`roleId` " +
			"JOIN `Permission` `p` ON `p`.`id` = `rp`.`permissionId` " +
			"WHERE `mr`.`membershipId` = ?"
	} else {
		query = "SELECT DISTINCT `p`.`name` FROM `Membership` `m` " +
			"JOIN `RolePermission` `rp` ON `rp`.`roleId` = `m`.`roleId` " +
			"JOIN `Permission` `p` ON `p`.`id` = `rp`.`permissionId` " +
			"WHERE `m`.`id` = ?"
	}

	rows, err := r.db.QueryContext(ctx, query, membershipID)
	if err != nil {
		return nil, fmt.Errorf("%w: query permissions: %v", ErrDatabase, err)
	}
	defer rows.Close()

	permissions := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("%w: scan permission: %v", ErrDatabase, err)
		}
		// 与 collectMembershipPermissionSet 一致：trim 后非空才收录。
		if strings.TrimSpace(name) != "" {
			permissions[name] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: iterate permissions: %v", ErrDatabase, err)
	}
	return permissions, nil
}

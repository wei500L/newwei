package rbacapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// systemAdminRoleName 与 NestJS 的 SYSTEM_ADMIN_ROLE_NAME 一致。
const systemAdminRoleName = "admin"

// Service 承载 SQL、Redis 与响应构造。handler 只做路由、鉴权与体解析。
type Service struct {
	db    *sql.DB
	redis *redis.Client
}

func NewService(db *sql.DB, redisClient *redis.Client) *Service {
	return &Service{db: db, redis: redisClient}
}

// dbtx 让读路径在连接池与事务之间复用同一批查询函数。
type dbtx interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID 写入 Prisma cuid 列（MySQL 没有客户端默认值，必须显式插入;
// 形状与既有 Go 批次一致：c + 24 位十六进制）。
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func boolArg(value bool) int {
	if value {
		return 1
	}
	return 0
}

// AuthenticateMachine 与 newssources/crawlprofile/crawlworkflow 相同：
// SHA-256 十六进制查 MachineAccessToken.tokenHash，连 Org.isActive；查不到、
// 已撤销、已过期、组织停用 → 401 Invalid machine token；查到更新 lastUsedAt。
// 权限只解析令牌行 permissions JSON 里的字符串数组；orgId 只用令牌行的。
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(401, "Invalid machine token")
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, newStatus(401, "Invalid machine token")
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowMillis(), id)
	return authhttp.NewIdentity("machine:"+id, orgID, permissionList(permissions)), nil
}

// permissionList keeps only the string entries of the MachineAccessToken
// permissions document. The tokens are decoded as raw JSON so a non-string
// element is dropped instead of failing the whole document, and no untyped
// container carries the business values.
//
// The token must also BE a JSON string literal: json.Unmarshal accepts a JSON
// null into a string and leaves it empty, so without the prefix check a null
// element would become an empty permission name rather than being dropped like
// every other non-string element (which is what NestJS's `typeof === "string"`
// filter does).
func permissionList(raw []byte) []string {
	var parsed []json.RawMessage
	if json.Unmarshal(raw, &parsed) != nil {
		return nil
	}
	out := make([]string, 0, len(parsed))
	for _, item := range parsed {
		trimmed := strings.TrimSpace(string(item))
		if trimmed == "" || trimmed[0] != '"' {
			continue
		}
		if text, ok := jsString(item); ok {
			out = append(out, text)
		}
	}
	return out
}

// ListPermissions 对齐 listPermissions：全局权限目录，按 name asc，
// 不按组织过滤。
func (s *Service) ListPermissions(ctx context.Context) ([]permissionJSON, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, name, description FROM Permission ORDER BY name ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []permissionJSON{}
	for rows.Next() {
		var item permissionJSON
		var description sql.NullString
		if err := rows.Scan(&item.ID, &item.Name, &description); err != nil {
			return nil, err
		}
		item.Description = stringOrNil(description)
		out = append(out, item)
	}
	return out, rows.Err()
}

// ListRoles 对齐 listRoles：只查该 orgId；includeSystem 为 false 时只返回
// isSystem 为 false 的角色。排序 name asc，响应带 permissions。
func (s *Service) ListRoles(ctx context.Context, orgID string, includeSystem bool) ([]roleJSON, error) {
	query := "SELECT id, name, description, isSystem, orgId FROM Role WHERE orgId = ?"
	if !includeSystem {
		query += " AND isSystem = 0"
	}
	query += " ORDER BY name ASC"
	rows, err := s.db.QueryContext(ctx, query, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []roleJSON{}
	for rows.Next() {
		role, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, role)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range out {
		permissions, err := loadRolePermissions(ctx, s.db, out[index].ID)
		if err != nil {
			return nil, err
		}
		out[index].Permissions = permissions
	}
	return out, nil
}

// ListMembers 对齐 listMembers：只查该 orgId，包含 user、primary role 与
// membershipRole 的角色链。不做 orderBy（与 NestJS 的 findMany 一致）。
func (s *Service) ListMembers(ctx context.Context, orgID string) ([]membershipJSON, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM Membership WHERE orgId = ?", orgID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	out := []membershipJSON{}
	for _, id := range ids {
		membership, err := loadMembershipJSON(ctx, s.db, orgID, id)
		if err != nil {
			return nil, err
		}
		out = append(out, membership)
	}
	return out, nil
}

// AuditLogs 对齐 auditLogs：只查该 orgId，createdAt desc，take limit。
func (s *Service) AuditLogs(ctx context.Context, orgID string, limit int) ([]auditLogJSON, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, orgId, actorId, resource, action, metadata, ipAddress, createdAt FROM AuditLog WHERE orgId = ? ORDER BY createdAt DESC LIMIT ?",
		orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []auditLogJSON{}
	for rows.Next() {
		var item auditLogJSON
		var actorID, ipAddress sql.NullString
		var metadata []byte
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.OrgID, &actorID, &item.Resource, &item.Action, &metadata, &ipAddress, &createdAt); err != nil {
			return nil, err
		}
		item.ActorID = stringOrNil(actorID)
		item.IPAddress = stringOrNil(ipAddress)
		if len(metadata) > 0 {
			item.Metadata = json.RawMessage(metadata)
		}
		item.CreatedAt = nestFromTime(createdAt)
		out = append(out, item)
	}
	return out, rows.Err()
}

// CreateRole 对齐 createRole：限流 → 组织管理员 → 名字校验 → 权限存在性 →
// 权限范围 → 建角色（含 rolePermission）→ 唯一冲突 409 → 审计（best-effort）。
func (s *Service) CreateRole(ctx context.Context, orgID, actorID string, actorPermissions map[string]bool, name, description string, permissions []string) (roleJSON, error) {
	if err := s.EnforceRbacWrite(ctx, orgID, actorID); err != nil {
		return roleJSON{}, err
	}
	if err := s.assertActorIsOrgAdmin(ctx, orgID, actorID); err != nil {
		return roleJSON{}, err
	}
	normalizedName := strings.TrimSpace(name)
	normalizedDescription := strings.TrimSpace(description)
	if normalizedName == "" {
		return roleJSON{}, &inputError{Message: "Role name is required"}
	}
	if strings.ToLower(normalizedName) == systemAdminRoleName {
		return roleJSON{}, &inputError{Message: "System administrator role name is reserved"}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return roleJSON{}, err
	}
	defer func() { _ = tx.Rollback() }()

	type permissionRow struct {
		id   string
		name string
	}
	found := []permissionRow{}
	if len(permissions) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(permissions)), ",")
		args := make([]any, 0, len(permissions))
		for _, name := range permissions {
			args = append(args, name)
		}
		rows, err := tx.QueryContext(ctx, "SELECT id, name FROM Permission WHERE name IN ("+placeholders+")", args...)
		if err != nil {
			return roleJSON{}, err
		}
		for rows.Next() {
			var row permissionRow
			if err := rows.Scan(&row.id, &row.name); err != nil {
				rows.Close()
				return roleJSON{}, err
			}
			found = append(found, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return roleJSON{}, err
		}
		rows.Close()
	}
	if len(found) != len(permissions) {
		// 重复名字导致 find 结果变少时也是这句；不去重后成功。
		return roleJSON{}, newStatus(404, "One or more permissions not found")
	}
	for _, permission := range found {
		if !actorPermissions[permission.name] {
			return roleJSON{}, newStatus(403, "Insufficient permission scope for RBAC change")
		}
	}

	roleID, err := newRowID()
	if err != nil {
		return roleJSON{}, err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO Role (id, name, description, isSystem, orgId) VALUES (?, ?, ?, 0, ?)",
		roleID, normalizedName, nullableString(normalizedDescription), orgID); err != nil {
		if uniqueConflict(err) {
			return roleJSON{}, newStatus(409, "Role name already exists")
		}
		return roleJSON{}, err
	}
	for _, permission := range found {
		rolePermissionID, err := newRowID()
		if err != nil {
			return roleJSON{}, err
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO RolePermission (id, roleId, permissionId) VALUES (?, ?, ?)",
			rolePermissionID, roleID, permission.id); err != nil {
			return roleJSON{}, err
		}
	}
	created, err := loadRoleWithPermissionsInOrg(ctx, tx, roleID, orgID)
	if err != nil {
		return roleJSON{}, err
	}
	if err := tx.Commit(); err != nil {
		if uniqueConflict(err) {
			return roleJSON{}, newStatus(409, "Role name already exists")
		}
		return roleJSON{}, err
	}

	writeAuditLogBestEffort(ctx, s.db, orgID, actorID, "roles", "create", roleCreateAudit{
		RoleID:      created.ID,
		Name:        normalizedName,
		Permissions: permissions,
	})
	return created, nil
}

// AssignRole 对齐 assignRole：限流 → 组织管理员 → 目标保护 → 角色归属 →
// 权限范围 → 事务内先锁成员行再替换 membershipRole（消除并发空角色）→
// 缓存失效 → 审计（best-effort）。
func (s *Service) AssignRole(ctx context.Context, orgID, actorID string, actorPermissions map[string]bool, userID, roleID string) (membershipJSON, error) {
	if err := s.EnforceRbacWrite(ctx, orgID, actorID); err != nil {
		return membershipJSON{}, err
	}
	if err := s.assertActorIsOrgAdmin(ctx, orgID, actorID); err != nil {
		return membershipJSON{}, err
	}

	targetRoles, _, err := loadMembershipRolesForCheck(ctx, s.db, orgID, userID)
	if err != nil {
		return membershipJSON{}, err
	}
	if userID == actorID || containsSystemAdmin(targetRoles) {
		return membershipJSON{}, newStatus(403, "System administrators cannot be managed")
	}

	role, err := loadRoleWithPermissionsInOrg(ctx, s.db, roleID, orgID)
	if err != nil {
		return membershipJSON{}, err
	}
	if role.IsSystem && strings.EqualFold(role.Name, systemAdminRoleName) {
		return membershipJSON{}, newStatus(403, "System administrator role cannot be assigned from user management")
	}
	for _, permission := range role.Permissions {
		if !actorPermissions[permission.Permission.Name] {
			return membershipJSON{}, newStatus(403, "Insufficient permission scope for RBAC change")
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return membershipJSON{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var membershipID string
	err = tx.QueryRowContext(ctx,
		"SELECT id FROM Membership WHERE userId = ? AND orgId = ? FOR UPDATE", userID, orgID).Scan(&membershipID)
	if errors.Is(err, sql.ErrNoRows) {
		// 目标还不是本组织成员：保持 NestJS 的 upsert 创建行为，然后
		// 在同一事务里再次锁住新行，再替换 membershipRole。
		newID, idErr := newRowID()
		if idErr != nil {
			return membershipJSON{}, idErr
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO Membership (id, userId, orgId, roleId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?) "+
				"ON DUPLICATE KEY UPDATE roleId = VALUES(roleId)",
			newID, userID, orgID, roleID, nowMillis()); err != nil {
			return membershipJSON{}, err
		}
		if err := tx.QueryRowContext(ctx,
			"SELECT id FROM Membership WHERE userId = ? AND orgId = ? FOR UPDATE", userID, orgID).Scan(&membershipID); err != nil {
			return membershipJSON{}, err
		}
	} else if err != nil {
		return membershipJSON{}, err
	} else {
		if _, err := tx.ExecContext(ctx, "UPDATE Membership SET roleId = ? WHERE id = ?", roleID, membershipID); err != nil {
			return membershipJSON{}, err
		}
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM MembershipRole WHERE membershipId = ?", membershipID); err != nil {
		return membershipJSON{}, err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO MembershipRole (membershipId, orgId, roleId, createdAt) VALUES (?, ?, ?, ?)",
		membershipID, orgID, roleID, nowMillis()); err != nil {
		return membershipJSON{}, err
	}

	membership, err := loadMembershipJSON(ctx, tx, orgID, membershipID)
	if err != nil {
		return membershipJSON{}, err
	}
	if err := tx.Commit(); err != nil {
		return membershipJSON{}, err
	}

	s.invalidateUsersWithRole(ctx, orgID, roleID)
	writeAuditLogBestEffort(ctx, s.db, orgID, actorID, "users", "assign_role", roleAssignAudit{
		TargetUserID: userID,
		RoleID:       roleID,
	})
	return membership, nil
}

// assertActorIsOrgAdmin 对齐 user-admin.service.ts 的 assertActorIsOrgAdmin
// （130 行）：非成员 403 Actor is not a member of the organization；成员但
// 没有系统管理员角色 403 Admin access required。
func (s *Service) assertActorIsOrgAdmin(ctx context.Context, orgID, actorID string) error {
	roles, found, err := loadMembershipRolesForCheck(ctx, s.db, orgID, actorID)
	if err != nil {
		return err
	}
	if !found {
		return newStatus(403, "Actor is not a member of the organization")
	}
	if !containsSystemAdmin(roles) {
		return newStatus(403, "Admin access required")
	}
	return nil
}

// invalidateUsersWithRole 对齐 user-admin.service.ts 的 invalidateUsersWithRole
// （460 行）：删 profile:<userId>:<orgId>，以及该用户每个 membership 的
// profile:<userId>:<那个 orgId>。Redis 失败只记日志，不回滚已分配角色。
func (s *Service) invalidateUsersWithRole(ctx context.Context, orgID, roleID string) {
	if s.redis == nil {
		return
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT DISTINCT m.userId FROM Membership m
LEFT JOIN MembershipRole mr ON mr.membershipId = m.id AND mr.orgId = m.orgId
WHERE m.orgId = ? AND (m.roleId = ? OR mr.roleId = ?)`, orgID, roleID, roleID)
	if err != nil {
		return
	}
	userIDs := []string{}
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return
		}
		userIDs = append(userIDs, userID)
	}
	rows.Close()
	for _, userID := range userIDs {
		_ = s.redis.Del(ctx, "profile:"+userID+":"+orgID).Err()
		memberships, err := s.db.QueryContext(ctx, "SELECT orgId FROM Membership WHERE userId = ?", userID)
		if err != nil {
			continue
		}
		for memberships.Next() {
			var memberOrgID string
			if err := memberships.Scan(&memberOrgID); err != nil {
				break
			}
			_ = s.redis.Del(ctx, "profile:"+userID+":"+memberOrgID).Err()
		}
		memberships.Close()
	}
}

// ---- 查询助手 ----

type roleRow struct {
	ID       string
	Name     string
	IsSystem bool
}

func containsSystemAdmin(roles []roleRow) bool {
	for _, role := range roles {
		if role.IsSystem && strings.EqualFold(role.Name, systemAdminRoleName) {
			return true
		}
	}
	return false
}

// loadMembershipRolesForCheck 按 collectMembershipRoles 的语义返回成员的
// 角色集合：优先 membershipRole 关联；为空时回退 primary role。found 表示
// membership 是否存在，用于区分「非成员」。
func loadMembershipRolesForCheck(ctx context.Context, q dbtx, orgID, userID string) ([]roleRow, bool, error) {
	var membershipID, primaryRoleID string
	err := q.QueryRowContext(ctx,
		"SELECT id, roleId FROM Membership WHERE userId = ? AND orgId = ?", userID, orgID).
		Scan(&membershipID, &primaryRoleID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	roles := []roleRow{}
	rows, err := q.QueryContext(ctx, `
SELECT r.id, r.name, r.isSystem FROM MembershipRole mr
JOIN Role r ON r.id = mr.roleId AND r.orgId = mr.orgId
WHERE mr.membershipId = ? AND mr.orgId = ?`, membershipID, orgID)
	if err != nil {
		return nil, true, err
	}
	for rows.Next() {
		var role roleRow
		var isSystem int
		if err := rows.Scan(&role.ID, &role.Name, &isSystem); err != nil {
			rows.Close()
			return nil, true, err
		}
		role.IsSystem = isSystem != 0
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, true, err
	}
	rows.Close()
	if len(roles) == 0 && primaryRoleID != "" {
		var role roleRow
		var isSystem int
		err := q.QueryRowContext(ctx,
			"SELECT id, name, isSystem FROM Role WHERE id = ? AND orgId = ?", primaryRoleID, orgID).
			Scan(&role.ID, &role.Name, &isSystem)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, true, err
		}
		if err == nil {
			role.IsSystem = isSystem != 0
			roles = append(roles, role)
		}
	}
	return roles, true, nil
}

func scanRole(row interface{ Scan(dest ...any) error }) (roleJSON, error) {
	var out roleJSON
	var description sql.NullString
	var isSystem int
	if err := row.Scan(&out.ID, &out.Name, &description, &isSystem, &out.OrgID); err != nil {
		return roleJSON{}, err
	}
	out.Description = stringOrNil(description)
	out.IsSystem = isSystem != 0
	out.Permissions = []rolePermissionJSON{}
	return out, nil
}

func loadRolePermissions(ctx context.Context, q dbtx, roleID string) ([]rolePermissionJSON, error) {
	rows, err := q.QueryContext(ctx, `
SELECT rp.id, rp.roleId, rp.permissionId, p.id, p.name, p.description
FROM RolePermission rp JOIN Permission p ON p.id = rp.permissionId
WHERE rp.roleId = ?`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []rolePermissionJSON{}
	for rows.Next() {
		var item rolePermissionJSON
		var description sql.NullString
		if err := rows.Scan(&item.ID, &item.RoleID, &item.PermissionID, &item.Permission.ID, &item.Permission.Name, &description); err != nil {
			return nil, err
		}
		item.Permission.Description = stringOrNil(description)
		out = append(out, item)
	}
	return out, rows.Err()
}

// loadRoleWithPermissionsInOrg 按 id + orgId 查角色；不存在或跨组织都是
// 404 Role not found（对齐 findFirst where id + orgId）。
func loadRoleWithPermissionsInOrg(ctx context.Context, q dbtx, roleID, orgID string) (roleJSON, error) {
	var out roleJSON
	var description sql.NullString
	var isSystem int
	err := q.QueryRowContext(ctx,
		"SELECT id, name, description, isSystem, orgId FROM Role WHERE id = ? AND orgId = ?", roleID, orgID).
		Scan(&out.ID, &out.Name, &description, &isSystem, &out.OrgID)
	if errors.Is(err, sql.ErrNoRows) {
		return roleJSON{}, newStatus(404, "Role not found")
	}
	if err != nil {
		return roleJSON{}, err
	}
	out.Description = stringOrNil(description)
	out.IsSystem = isSystem != 0
	permissions, err := loadRolePermissions(ctx, q, roleID)
	if err != nil {
		return roleJSON{}, err
	}
	out.Permissions = permissions
	return out, nil
}

func loadUser(ctx context.Context, q dbtx, userID string) (userJSON, error) {
	var out userJSON
	var emailVerified, lastLoginAt sql.NullTime
	var pendingEmail, avatarURL sql.NullString
	var isActive int
	var createdAt, updatedAt time.Time
	err := q.QueryRowContext(ctx, `
SELECT id, email, emailVerified, pendingEmail, passwordHash, firstName, lastName, avatarUrl, isActive, lastLoginAt, createdAt, updatedAt
FROM User WHERE id = ?`, userID).
		Scan(&out.ID, &out.Email, &emailVerified, &pendingEmail, &out.PasswordHash, &out.FirstName, &out.LastName,
			&avatarURL, &isActive, &lastLoginAt, &createdAt, &updatedAt)
	if err != nil {
		return userJSON{}, err
	}
	out.EmailVerified = nestFromNullTime(emailVerified)
	out.PendingEmail = stringOrNil(pendingEmail)
	out.AvatarURL = stringOrNil(avatarURL)
	out.IsActive = isActive != 0
	out.LastLoginAt = nestFromNullTime(lastLoginAt)
	out.CreatedAt = nestFromTime(createdAt)
	out.UpdatedAt = nestFromTime(updatedAt)
	return out, nil
}

func loadMembershipRoles(ctx context.Context, q dbtx, membershipID, orgID string) ([]membershipRoleJSON, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT membershipId, orgId, roleId, createdAt FROM MembershipRole WHERE membershipId = ? AND orgId = ?",
		membershipID, orgID)
	if err != nil {
		return nil, err
	}
	type link struct {
		membershipID string
		orgID        string
		roleID       string
		createdAt    time.Time
	}
	links := []link{}
	for rows.Next() {
		var item link
		if err := rows.Scan(&item.membershipID, &item.orgID, &item.roleID, &item.createdAt); err != nil {
			rows.Close()
			return nil, err
		}
		links = append(links, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	out := []membershipRoleJSON{}
	for _, item := range links {
		role, err := loadRoleWithPermissionsInOrg(ctx, q, item.roleID, orgID)
		if err != nil {
			return nil, err
		}
		out = append(out, membershipRoleJSON{
			MembershipID: item.membershipID,
			OrgID:        item.orgID,
			RoleID:       item.roleID,
			CreatedAt:    nestFromTime(item.createdAt),
			Role:         role,
		})
	}
	return out, nil
}

func loadMembershipJSON(ctx context.Context, q dbtx, orgID, membershipID string) (membershipJSON, error) {
	var out membershipJSON
	var isActive int
	var createdAt time.Time
	err := q.QueryRowContext(ctx,
		"SELECT id, userId, orgId, roleId, isActive, createdAt FROM Membership WHERE id = ? AND orgId = ?",
		membershipID, orgID).
		Scan(&out.ID, &out.UserID, &out.OrgID, &out.RoleID, &isActive, &createdAt)
	if err != nil {
		return membershipJSON{}, err
	}
	out.IsActive = isActive != 0
	out.CreatedAt = nestFromTime(createdAt)
	out.User, err = loadUser(ctx, q, out.UserID)
	if err != nil {
		return membershipJSON{}, err
	}
	out.Role, err = loadRoleWithPermissionsInOrg(ctx, q, out.RoleID, orgID)
	if err != nil {
		return membershipJSON{}, err
	}
	out.Roles, err = loadMembershipRoles(ctx, q, out.ID, orgID)
	if err != nil {
		return membershipJSON{}, err
	}
	return out, nil
}

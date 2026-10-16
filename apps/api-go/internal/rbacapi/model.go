package rbacapi

import (
	"database/sql"
	"encoding/json"
	"time"
)

// nestTime 是 new Date().toISOString() 等价格式（毫秒 UTC）。NestJS 的
// Prisma DateTime 经 JSON.stringify 输出该格式；Go 的 time.Time 默认
// RFC3339Nano 小数位不同，必须显式转换。
type nestTime time.Time

func (t *nestTime) MarshalJSON() ([]byte, error) {
	if t == nil {
		return []byte("null"), nil
	}
	return json.Marshal(time.Time(*t).UTC().Format("2006-01-02T15:04:05.000Z"))
}

func nestFromTime(value time.Time) *nestTime {
	out := nestTime(value)
	return &out
}

func nestFromNullTime(value sql.NullTime) *nestTime {
	if !value.Valid {
		return nil
	}
	return nestFromTime(value.Time)
}

func stringOrNil(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

// permissionJSON 对齐 Prisma Permission 的标量字段。
type permissionJSON struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

// rolePermissionJSON 对齐 RolePermission include permission。
type rolePermissionJSON struct {
	ID           string         `json:"id"`
	RoleID       string         `json:"roleId"`
	PermissionID string         `json:"permissionId"`
	Permission   permissionJSON `json:"permission"`
}

// roleJSON 对齐 Role include permissions.permission。
type roleJSON struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	Description *string              `json:"description"`
	IsSystem    bool                 `json:"isSystem"`
	OrgID       string               `json:"orgId"`
	Permissions []rolePermissionJSON `json:"permissions"`
}

// userJSON 对齐 Prisma User 的全部标量字段（listMembers 的 include user
// 返回整行，包含 passwordHash——与 NestJS 现状一致，仅管理员可读）。
type userJSON struct {
	ID            string    `json:"id"`
	Email         string    `json:"email"`
	EmailVerified *nestTime `json:"emailVerified"`
	PendingEmail  *string   `json:"pendingEmail"`
	PasswordHash  string    `json:"passwordHash"`
	FirstName     string    `json:"firstName"`
	LastName      string    `json:"lastName"`
	AvatarURL     *string   `json:"avatarUrl"`
	IsActive      bool      `json:"isActive"`
	LastLoginAt   *nestTime `json:"lastLoginAt"`
	CreatedAt     *nestTime `json:"createdAt"`
	UpdatedAt     *nestTime `json:"updatedAt"`
}

// membershipRoleJSON 对齐 MembershipRole include role.permissions.permission。
type membershipRoleJSON struct {
	MembershipID string    `json:"membershipId"`
	OrgID        string    `json:"orgId"`
	RoleID       string    `json:"roleId"`
	CreatedAt    *nestTime `json:"createdAt"`
	Role         roleJSON  `json:"role"`
}

// membershipJSON 对齐 Membership include user/role/roles。
type membershipJSON struct {
	ID        string               `json:"id"`
	UserID    string               `json:"userId"`
	OrgID     string               `json:"orgId"`
	RoleID    string               `json:"roleId"`
	IsActive  bool                 `json:"isActive"`
	CreatedAt *nestTime            `json:"createdAt"`
	User      userJSON             `json:"user"`
	Role      roleJSON             `json:"role"`
	Roles     []membershipRoleJSON `json:"roles"`
}

// auditLogJSON 对齐 Prisma AuditLog 的标量字段。
type auditLogJSON struct {
	ID        string          `json:"id"`
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt *nestTime       `json:"createdAt"`
}

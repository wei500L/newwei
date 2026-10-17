package rbacapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

// This file is the strongly typed GraphQL adapter over the RBAC writes. The
// HTTP handler keeps using the JSON-shaped records; the GraphQL mutation
// resolvers use only the views and methods below, so no model is ever moved
// through a serialized form.

// PermissionView is the GraphQL PermissionModel projection of one permission.
type PermissionView struct {
	ID          string
	Name        string
	Description *string
}

// RoleView is the GraphQL RoleModel projection of a role with its permissions.
type RoleView struct {
	ID          string
	Name        string
	Description *string
	IsSystem    bool
	Permissions []PermissionView
}

// UserView is the GraphQL UserModel projection of a membership's user. The
// permission set is the union across the membership's effective roles and the
// active flag combines User.isActive with Membership.isActive.
type UserView struct {
	ID            string
	Email         string
	FirstName     string
	LastName      string
	AvatarURL     *string
	EmailVerified *time.Time
	LastLoginAt   *time.Time
	IsActive      bool
	PrimaryRoleID *string
	RoleIDs       []string
	Permissions   []string
}

// MembershipView is the GraphQL MembershipModel projection.
type MembershipView struct {
	ID    string
	OrgID string
	Role  RoleView
	Roles []RoleView
	User  UserView
}

// roleUpdateAudit is the AuditLog metadata written by UpdateRoleView.
type roleUpdateAudit struct {
	RoleID      string   `json:"roleId"`
	Description *string  `json:"description"`
	Permissions []string `json:"permissions"`
}

// membershipRolesAudit is the AuditLog metadata written by
// UpdateMembershipRolesView.
type membershipRolesAudit struct {
	TargetUserID  string   `json:"targetUserId"`
	PrimaryRoleID string   `json:"primaryRoleId"`
	RoleIDs       []string `json:"roleIds"`
}

// setActiveAudit is the AuditLog metadata written by SetUserActiveView.
type setActiveAudit struct {
	TargetUserID string `json:"targetUserId"`
	IsActive     bool   `json:"isActive"`
}

// StatusOf maps a service error onto the HTTP status and message the NestJS
// GlobalExceptionFilter would produce for the same failure. The GraphQL
// executor turns the pair into the matching GraphQL error extensions.
func StatusOf(err error) (int, string) {
	if err == nil {
		return http.StatusInternalServerError, "Internal server error"
	}
	var statusErr *statusError
	if errors.As(err, &statusErr) {
		return normalizeServiceStatus(statusErr.status, statusErr.message)
	}
	var inputErr *inputError
	if errors.As(err, &inputErr) {
		return http.StatusBadRequest, inputErr.Message
	}
	if unavailable(err) {
		return http.StatusServiceUnavailable, "Internal server error"
	}
	return http.StatusInternalServerError, "Internal server error"
}

func normalizeServiceStatus(status int, message string) (int, string) {
	if status == 0 {
		status = http.StatusInternalServerError
	}
	if status >= 500 || message == "" {
		return status, "Internal server error"
	}
	return status, message
}

// ActorHasPermission reports whether the actor's effective roles in orgID grant
// permission, re-deriving the set from MySQL exactly like
// hasMembershipPermission: the MembershipRole links decide the roles, and the
// primary role is used only when no link exists. found is false when the actor
// is not a member of the organization.
func (s *Service) ActorHasPermission(ctx context.Context, orgID, actorID, permission string) (bool, bool, error) {
	roles, found, err := loadMembershipRolesForCheck(ctx, s.db, orgID, actorID)
	if err != nil {
		return false, false, err
	}
	if !found {
		return false, false, nil
	}
	for _, role := range roles {
		links, err := loadRolePermissions(ctx, s.db, role.ID)
		if err != nil {
			return false, true, err
		}
		for _, link := range links {
			if link.Permission.Name == permission {
				return true, true, nil
			}
		}
	}
	return false, true, nil
}

// CreateRoleView is the GraphQL createRole write. It reuses CreateRole and
// converts the result to the GraphQL role model.
func (s *Service) CreateRoleView(ctx context.Context, orgID, actorID string, actorPermissions map[string]bool, name, description string, permissions []string) (RoleView, error) {
	created, err := s.CreateRole(ctx, orgID, actorID, actorPermissions, name, description, permissions)
	if err != nil {
		return RoleView{}, err
	}
	return roleView(created), nil
}

// AssignRoleView is the GraphQL assignRole write. It reuses AssignRole and
// converts the membership, including its user and effective permission union,
// to the GraphQL membership model.
func (s *Service) AssignRoleView(ctx context.Context, orgID, actorID string, actorPermissions map[string]bool, userID, roleID string) (MembershipView, error) {
	membership, err := s.AssignRole(ctx, orgID, actorID, actorPermissions, userID, roleID)
	if err != nil {
		return MembershipView{}, err
	}
	return membershipView(membership), nil
}

// UpdateRoleView is the GraphQL updateRole write, mirroring
// RbacService.updateRole: rate limit, organization administrator check, both
// the existing and the requested permission sets must stay inside the actor's
// scope, system roles are rejected, and the permission rows are replaced and
// the description written in one transaction. An omitted or null description
// is stored as NULL, which is the current behavior.
func (s *Service) UpdateRoleView(ctx context.Context, orgID, actorID string, actorPermissions map[string]bool, roleID string, description *string, permissions []string) (RoleView, error) {
	if err := s.EnforceRbacWrite(ctx, orgID, actorID); err != nil {
		return RoleView{}, err
	}
	if err := s.assertActorIsOrgAdmin(ctx, orgID, actorID); err != nil {
		return RoleView{}, err
	}
	existing, err := loadRoleWithPermissionsInOrg(ctx, s.db, roleID, orgID)
	if err != nil {
		return RoleView{}, err
	}
	if existing.IsSystem {
		return RoleView{}, newStatus(http.StatusForbidden, "System roles cannot be edited")
	}
	for _, link := range existing.Permissions {
		if !actorPermissions[link.Permission.Name] {
			return RoleView{}, newStatus(http.StatusForbidden, "Insufficient permission scope for RBAC change")
		}
	}
	found, err := loadPermissionsIn(ctx, s.db, permissions)
	if err != nil {
		return RoleView{}, err
	}
	if len(found) != len(permissions) {
		// A duplicated permission name shrinks the result set; the current
		// behavior is this same 404 rather than a deduplicated success.
		return RoleView{}, newStatus(http.StatusNotFound, "One or more permissions not found")
	}
	for _, permission := range found {
		if !actorPermissions[permission.Name] {
			return RoleView{}, newStatus(http.StatusForbidden, "Insufficient permission scope for RBAC change")
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RoleView{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, "DELETE FROM RolePermission WHERE roleId = ?", roleID); err != nil {
		return RoleView{}, err
	}
	for _, permission := range found {
		linkID, err := newRowID()
		if err != nil {
			return RoleView{}, err
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO RolePermission (id, roleId, permissionId) VALUES (?, ?, ?)",
			linkID, roleID, permission.ID); err != nil {
			return RoleView{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE Role SET description = ? WHERE id = ?", nullableDescription(description), roleID); err != nil {
		return RoleView{}, err
	}
	updated, err := loadRoleWithPermissionsInOrg(ctx, tx, roleID, orgID)
	if err != nil {
		return RoleView{}, err
	}
	if err := tx.Commit(); err != nil {
		return RoleView{}, err
	}

	s.invalidateUsersWithRole(ctx, orgID, roleID)
	writeAuditLogBestEffort(ctx, s.db, orgID, actorID, "roles", "update", roleUpdateAudit{
		RoleID:      roleID,
		Description: description,
		Permissions: permissions,
	})
	return roleView(updated), nil
}

// UpdateMembershipRolesView is the GraphQL updateMembershipRoles write,
// mirroring UserAdminService.updateMembershipRoles: rate limit, organization
// administrator check, target protection, role normalization and scope
// checks, then one transaction that replaces the primary role and the
// MembershipRole rows. It returns the updated user model.
func (s *Service) UpdateMembershipRolesView(ctx context.Context, orgID, actorID string, actorPermissions map[string]bool, userID, primaryRoleID string, roleIDs []string) (UserView, error) {
	if err := s.EnforceRbacWrite(ctx, orgID, actorID); err != nil {
		return UserView{}, err
	}
	if err := s.assertActorIsOrgAdmin(ctx, orgID, actorID); err != nil {
		return UserView{}, err
	}
	targetRoles, found, err := loadMembershipRolesForCheck(ctx, s.db, orgID, userID)
	if err != nil {
		return UserView{}, err
	}
	if !found {
		return UserView{}, newStatus(http.StatusNotFound, "User is not a member of the organization")
	}
	if userID == actorID {
		return UserView{}, newStatus(http.StatusForbidden, "Administrators cannot change their own roles")
	}
	if containsSystemAdmin(targetRoles) {
		return UserView{}, newStatus(http.StatusForbidden, "System administrators cannot be managed")
	}
	normalized := normalizeRoleIDs(roleIDs)
	if len(normalized) == 0 {
		return UserView{}, &inputError{Message: "At least one role is required"}
	}
	if !containsString(normalized, primaryRoleID) {
		return UserView{}, &inputError{Message: "Primary role must be included in the selected roles"}
	}
	roles, err := loadRolesInOrg(ctx, s.db, orgID, normalized)
	if err != nil {
		return UserView{}, err
	}
	if len(roles) != len(normalized) {
		return UserView{}, newStatus(http.StatusNotFound, "One or more roles not found")
	}
	for _, role := range roles {
		if role.IsSystem && strings.EqualFold(role.Name, systemAdminRoleName) {
			return UserView{}, newStatus(http.StatusForbidden, "System administrator role cannot be assigned from user management")
		}
	}
	for _, role := range roles {
		for _, link := range role.Permissions {
			name := link.Permission.Name
			if strings.TrimSpace(name) == "" {
				continue
			}
			if !actorPermissions[name] {
				return UserView{}, newStatus(http.StatusForbidden, "Insufficient permission scope for RBAC change")
			}
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return UserView{}, err
	}
	defer func() { _ = tx.Rollback() }()

	// RowsAffected is deliberately not checked: MySQL reports zero changed rows
	// when the primary role already matches. A vanished membership surfaces as
	// sql.ErrNoRows from the id lookup below, which is the Prisma P2025
	// equivalent.
	if _, err := tx.ExecContext(ctx, "UPDATE Membership SET roleId = ? WHERE userId = ? AND orgId = ?", primaryRoleID, userID, orgID); err != nil {
		return UserView{}, err
	}
	membershipID, err := membershipIDForUser(ctx, tx, orgID, userID)
	if err != nil {
		return UserView{}, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM MembershipRole WHERE membershipId = ?", membershipID); err != nil {
		return UserView{}, err
	}
	for _, roleID := range normalized {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO MembershipRole (membershipId, orgId, roleId, createdAt) VALUES (?, ?, ?, ?)",
			membershipID, orgID, roleID, nowMillis()); err != nil {
			return UserView{}, err
		}
	}
	membership, err := loadMembershipJSON(ctx, tx, orgID, membershipID)
	if err != nil {
		return UserView{}, err
	}
	if err := tx.Commit(); err != nil {
		return UserView{}, err
	}

	s.invalidateProfileCache(ctx, userID, orgID)
	writeAuditLogBestEffort(ctx, s.db, orgID, actorID, "users", "update_membership_roles", membershipRolesAudit{
		TargetUserID:  userID,
		PrimaryRoleID: primaryRoleID,
		RoleIDs:       normalized,
	})
	return userViewFromMembership(membership, effectiveRoleIDs(membership)), nil
}

// SetUserActiveView is the GraphQL setUserActive write, mirroring
// UserAdminService.setUserActive: it updates Membership.isActive, never
// User.isActive, and returns the user model with the combined active flag.
func (s *Service) SetUserActiveView(ctx context.Context, orgID, actorID, userID string, isActive bool) (UserView, error) {
	if err := s.EnforceRbacWrite(ctx, orgID, actorID); err != nil {
		return UserView{}, err
	}
	if err := s.assertActorIsOrgAdmin(ctx, orgID, actorID); err != nil {
		return UserView{}, err
	}
	targetRoles, found, err := loadMembershipRolesForCheck(ctx, s.db, orgID, userID)
	if err != nil {
		return UserView{}, err
	}
	if !found {
		return UserView{}, newStatus(http.StatusNotFound, "User is not a member of the organization")
	}
	if userID == actorID {
		return UserView{}, newStatus(http.StatusForbidden, "Administrators cannot change their own status")
	}
	if containsSystemAdmin(targetRoles) {
		return UserView{}, newStatus(http.StatusForbidden, "System administrators cannot be managed")
	}

	// RowsAffected is deliberately not checked: setting the flag to its current
	// value changes no rows. A vanished membership surfaces as sql.ErrNoRows
	// from the id lookup below, which is the Prisma P2025 equivalent.
	if _, err := s.db.ExecContext(ctx, "UPDATE Membership SET isActive = ? WHERE userId = ? AND orgId = ?", boolValue(isActive), userID, orgID); err != nil {
		return UserView{}, err
	}
	membershipID, err := membershipIDForUser(ctx, s.db, orgID, userID)
	if err != nil {
		return UserView{}, err
	}
	membership, err := loadMembershipJSON(ctx, s.db, orgID, membershipID)
	if err != nil {
		return UserView{}, err
	}

	s.invalidateProfileCache(ctx, userID, orgID)
	writeAuditLogBestEffort(ctx, s.db, orgID, actorID, "users", "set_active", setActiveAudit{
		TargetUserID: userID,
		IsActive:     isActive,
	})
	return userViewFromMembership(membership, linkedRoleIDs(membership)), nil
}

// roleView converts a JSON-shaped role record to the GraphQL role model.
func roleView(role roleJSON) RoleView {
	permissions := make([]PermissionView, 0, len(role.Permissions))
	for _, link := range role.Permissions {
		permissions = append(permissions, PermissionView{
			ID:          link.Permission.ID,
			Name:        link.Permission.Name,
			Description: link.Permission.Description,
		})
	}
	return RoleView{
		ID:          role.ID,
		Name:        role.Name,
		Description: role.Description,
		IsSystem:    role.IsSystem,
		Permissions: permissions,
	}
}

// membershipView converts a membership record to the GraphQL membership model
// using the role-link fallback rules of mapMembership.
func membershipView(membership membershipJSON) MembershipView {
	roles := make([]RoleView, 0, len(membership.Roles))
	for _, link := range membership.Roles {
		roles = append(roles, roleView(link.Role))
	}
	if len(roles) == 0 {
		roles = append(roles, roleView(membership.Role))
	}
	return MembershipView{
		ID:    membership.ID,
		OrgID: membership.OrgID,
		Role:  roleView(membership.Role),
		Roles: roles,
		User:  userViewFromMembership(membership, linkedRoleIDs(membership)),
	}
}

// effectiveRoleIDs mirrors collectMembershipRoles for the returned role id
// list: the resolved roles of the MembershipRole links in link order, falling
// back to the primary role when no link resolves.
func effectiveRoleIDs(membership membershipJSON) []string {
	out := make([]string, 0, len(membership.Roles))
	for _, link := range membership.Roles {
		out = append(out, link.Role.ID)
	}
	if len(out) == 0 {
		if membership.Role.ID != "" {
			out = append(out, membership.Role.ID)
		} else if membership.RoleID != "" {
			out = append(out, membership.RoleID)
		}
	}
	return out
}

// linkedRoleIDs mirrors the resolver's roleLinks branch: the MembershipRole
// role ids when links exist, otherwise the primary role id.
func linkedRoleIDs(membership membershipJSON) []string {
	if len(membership.Roles) > 0 {
		out := make([]string, 0, len(membership.Roles))
		for _, link := range membership.Roles {
			if link.RoleID != "" {
				out = append(out, link.RoleID)
			}
		}
		return out
	}
	if membership.RoleID != "" {
		return []string{membership.RoleID}
	}
	return []string{}
}

// userViewFromMembership builds the GraphQL user model of a membership. The
// permission union preserves first-seen order, matching a JavaScript Set.
func userViewFromMembership(membership membershipJSON, roleIDs []string) UserView {
	roles := make([]roleJSON, 0, len(membership.Roles))
	for _, link := range membership.Roles {
		roles = append(roles, link.Role)
	}
	if len(roles) == 0 {
		roles = append(roles, membership.Role)
	}
	seen := make(map[string]struct{})
	permissions := make([]string, 0)
	for _, role := range roles {
		for _, link := range role.Permissions {
			name := link.Permission.Name
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			permissions = append(permissions, name)
		}
	}
	var primaryRoleID *string
	if membership.RoleID != "" {
		value := membership.RoleID
		primaryRoleID = &value
	}
	return UserView{
		ID:            membership.User.ID,
		Email:         membership.User.Email,
		FirstName:     membership.User.FirstName,
		LastName:      membership.User.LastName,
		AvatarURL:     membership.User.AvatarURL,
		EmailVerified: nestTimeValue(membership.User.EmailVerified),
		LastLoginAt:   nestTimeValue(membership.User.LastLoginAt),
		IsActive:      membership.User.IsActive && membership.IsActive,
		PrimaryRoleID: primaryRoleID,
		RoleIDs:       roleIDs,
		Permissions:   permissions,
	}
}

func nestTimeValue(value *nestTime) *time.Time {
	if value == nil {
		return nil
	}
	stamp := time.Time(*value).UTC()
	return &stamp
}

// nullableDescription mirrors `dto.description ?? null`: only nil becomes SQL
// NULL, so an empty string is stored as an empty string.
func nullableDescription(description *string) any {
	if description == nil {
		return nil
	}
	return *description
}

func boolValue(value bool) int {
	if value {
		return 1
	}
	return 0
}

// normalizeRoleIDs mirrors Array.from(new Set(ids.map(id => id.trim()).filter(id => id.length > 0))).
func normalizeRoleIDs(roleIDs []string) []string {
	seen := make(map[string]struct{}, len(roleIDs))
	out := make([]string, 0, len(roleIDs))
	for _, roleID := range roleIDs {
		trimmed := jsTrim(roleID)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// jsTrim mirrors String.prototype.trim: ASCII whitespace plus the Unicode
// space separators and the zero-width no-break space.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

// loadPermissionsIn returns the Permission rows whose name is in names. The
// row order follows the database, matching an unordered Prisma findMany.
func loadPermissionsIn(ctx context.Context, q dbtx, names []string) ([]permissionJSON, error) {
	out := []permissionJSON{}
	if len(names) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(names)), ",")
	args := make([]any, 0, len(names))
	for _, name := range names {
		args = append(args, name)
	}
	rows, err := q.QueryContext(ctx, "SELECT id, name, description FROM Permission WHERE name IN ("+placeholders+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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

// loadRolesInOrg returns the roles of one organization by id with their
// permissions. Missing and cross-organization ids are simply absent, which
// lets the caller compare the row count.
func loadRolesInOrg(ctx context.Context, q dbtx, orgID string, roleIDs []string) ([]roleJSON, error) {
	out := []roleJSON{}
	if len(roleIDs) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(roleIDs)), ",")
	args := make([]any, 0, len(roleIDs)+1)
	args = append(args, orgID)
	for _, roleID := range roleIDs {
		args = append(args, roleID)
	}
	rows, err := q.QueryContext(ctx, "SELECT id, name, description, isSystem, orgId FROM Role WHERE orgId = ? AND id IN ("+placeholders+")", args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		role, err := scanRole(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, role)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for index := range out {
		permissions, err := loadRolePermissions(ctx, q, out[index].ID)
		if err != nil {
			return nil, err
		}
		out[index].Permissions = permissions
	}
	return out, nil
}

// membershipIDForUser resolves the unique (userId, orgId) membership id.
func membershipIDForUser(ctx context.Context, q dbtx, orgID, userID string) (string, error) {
	var membershipID string
	if err := q.QueryRowContext(ctx,
		"SELECT id FROM Membership WHERE userId = ? AND orgId = ? LIMIT 1", userID, orgID).Scan(&membershipID); err != nil {
		return "", err
	}
	return membershipID, nil
}

// invalidateProfileCache mirrors UserAdminService.invalidateProfileCache: drop
// the target's profile key for this organization and for every other
// membership. Redis failures never fail the write.
func (s *Service) invalidateProfileCache(ctx context.Context, userID, orgID string) {
	if s.redis == nil {
		return
	}
	_ = s.redis.Del(ctx, "profile:"+userID+":"+orgID).Err()
	rows, err := s.db.QueryContext(ctx, "SELECT orgId FROM Membership WHERE userId = ?", userID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var memberOrgID string
		if err := rows.Scan(&memberOrgID); err != nil {
			return
		}
		_ = s.redis.Del(ctx, "profile:"+userID+":"+memberOrgID).Err()
	}
}

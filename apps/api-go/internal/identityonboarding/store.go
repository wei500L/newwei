package identityonboarding

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// dbtx is the query surface shared by *sql.DB and *sql.Tx.
type dbtx interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// placeholders renders "?,?,?" for an IN list.
func placeholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func argsOf(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

func stringOrNil(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func timeOrNil(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	return &value.Time
}

// ---- platform and organization authorization ----

// isPlatformAdmin reads GlobalRoleAssignment. It never looks at an organization
// admin role and never trusts a permission claim in the token.
func (s *Service) isPlatformAdmin(ctx context.Context, userID string) (bool, error) {
	if userID == "" {
		return false, nil
	}
	var id string
	err := s.db.QueryRowContext(ctx,
		"SELECT `id` FROM `GlobalRoleAssignment` WHERE `userId` = ? AND `role` = 'platform_admin' LIMIT 1",
		userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// assertPlatformAdmin mirrors PlatformAccessService.assertPlatformAdmin.
func (s *Service) assertPlatformAdmin(ctx context.Context, userID string) error {
	allowed, err := s.isPlatformAdmin(ctx, userID)
	if err != nil {
		return err
	}
	if !allowed {
		return forbidden("Platform admin access required")
	}
	return nil
}

// assertOrgAdmin mirrors OrgInviteService.assertOrgAdmin: the caller must be a
// member of that organization and hold users.write there. It is permission
// based, not role-name based, so the default "manager" role can manage members.
func (s *Service) assertOrgAdmin(ctx context.Context, orgID, actorID string) error {
	allowed, found, err := s.rbac.ActorHasPermission(ctx, orgID, actorID, "users.write")
	if err != nil {
		return err
	}
	if !found || !allowed {
		return forbidden("Organization admin access required")
	}
	return nil
}

// ---- roles ----

const roleColumns = "`id`, `name`, `description`, `isSystem`, `orgId`"

func scanRole(scanner interface{ Scan(dest ...any) error }) (roleRecord, error) {
	var role roleRecord
	var description sql.NullString
	var isSystem int
	if err := scanner.Scan(&role.ID, &role.Name, &description, &isSystem, &role.OrgID); err != nil {
		return roleRecord{}, err
	}
	role.Description = stringOrNil(description)
	role.IsSystem = isSystem != 0
	return role, nil
}

// loadRolesInOrg reads the roles of one organization by id. The result keeps the
// database order; the caller compares the length with the requested id count.
func loadRolesInOrg(ctx context.Context, q dbtx, orgID string, ids []string) ([]roleRecord, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	query := "SELECT " + roleColumns + " FROM `Role` WHERE `orgId` = ? AND `id` IN (" + placeholders(len(ids)) + ")"
	args := append([]any{orgID}, argsOf(ids)...)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]roleRecord, 0, len(ids))
	for rows.Next() {
		role, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, role)
	}
	return out, rows.Err()
}

// loadRoleByIDOrg reads one role inside an organization. A cross-organization id
// is treated as absent, matching findFirst with id + orgId.
func loadRoleByIDOrg(ctx context.Context, q dbtx, orgID, roleID string) (roleRecord, bool, error) {
	role, err := scanRole(q.QueryRowContext(ctx,
		"SELECT "+roleColumns+" FROM `Role` WHERE `id` = ? AND `orgId` = ? LIMIT 1", roleID, orgID))
	if errors.Is(err, sql.ErrNoRows) {
		return roleRecord{}, false, nil
	}
	if err != nil {
		return roleRecord{}, false, err
	}
	return role, true, nil
}

// loadRolePermissions reads the permission names of the given roles in one
// query. Grant-scope validation must see the whole set per role.
func loadRolePermissions(ctx context.Context, q dbtx, roleIDs []string) (map[string][]string, error) {
	out := make(map[string][]string, len(roleIDs))
	if len(roleIDs) == 0 {
		return out, nil
	}
	query := "SELECT `rp`.`roleId`, `p`.`name` FROM `RolePermission` `rp` " +
		"JOIN `Permission` `p` ON `p`.`id` = `rp`.`permissionId` " +
		"WHERE `rp`.`roleId` IN (" + placeholders(len(roleIDs)) + ")"
	rows, err := q.QueryContext(ctx, query, argsOf(roleIDs)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var roleID, name string
		if err := rows.Scan(&roleID, &name); err != nil {
			return nil, err
		}
		if strings.TrimSpace(name) == "" {
			continue
		}
		out[roleID] = append(out[roleID], name)
	}
	return out, rows.Err()
}

// assertRolesAssignable mirrors OrgInviteService.assertRolesAssignable: the
// actor may not grant the system administrator role, and every permission of
// every granted role must be inside the actor's own permission set.
func (s *Service) assertRolesAssignable(ctx context.Context, actorID, orgID string, roleIDs []string) error {
	unique := sortedUniqueStrings(roleIDs)
	actorPermissions, found, err := s.rbac.ActorPermissionSet(ctx, orgID, actorID)
	if err != nil {
		return err
	}
	if !found {
		return forbidden("Actor is not a member of the organization")
	}
	roles, err := loadRolesInOrg(ctx, s.db, orgID, unique)
	if err != nil {
		return err
	}
	if len(roles) != len(unique) {
		return badRequest("One or more roles are invalid")
	}
	permissionSets, err := loadRolePermissions(ctx, s.db, unique)
	if err != nil {
		return err
	}
	for _, role := range roles {
		if role.IsSystem && strings.EqualFold(role.Name, "admin") {
			return forbidden("System administrator role cannot be granted via invitations")
		}
		for _, permission := range permissionSets[role.ID] {
			if !actorPermissions[permission] {
				return forbidden("Insufficient permission scope to grant the selected roles")
			}
		}
	}
	return nil
}

// ensureRoleSet mirrors OrgInviteService.ensureRoleSet.
func (s *Service) ensureRoleSet(ctx context.Context, orgID, primaryRoleID string, roleIDs []string) error {
	roles, err := loadRolesInOrg(ctx, s.db, orgID, roleIDs)
	if err != nil {
		return err
	}
	if len(roles) != len(roleIDs) {
		return badRequest("One or more roles are invalid")
	}
	for _, roleID := range roleIDs {
		if roleID == primaryRoleID {
			return nil
		}
	}
	return badRequest("Primary role must be included in roleIds")
}

// normalizeRoleIDs mirrors OrgInviteService.normalizeRoleIds exactly, including
// its use of the untrimmed primaryRoleId for the membership check. Changing that
// would silently turn a whitespace-padded id into a different grant.
func normalizeRoleIDs(roleIDs []string, primaryRoleID string) []string {
	combined := make([]string, 0, len(roleIDs)+1)
	combined = append(combined, primaryRoleID)
	combined = append(combined, roleIDs...)
	trimmed := make([]string, 0, len(combined))
	for _, value := range combined {
		candidate := jsTrim(value)
		if candidate == "" {
			continue
		}
		trimmed = append(trimmed, candidate)
	}
	ids := sortedUniqueStrings(trimmed)
	for _, roleID := range ids {
		if roleID == primaryRoleID {
			return ids
		}
	}
	return append([]string{primaryRoleID}, ids...)
}

// readRoleIDs mirrors OrgInviteService.readRoleIds for the JSON column.
func readRoleIDs(raw []byte, primaryRoleID string) []string {
	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		return []string{primaryRoleID}
	}
	ids := make([]string, 0, len(elements))
	for _, element := range elements {
		text, ok := decodeJSONString(element)
		if !ok {
			continue
		}
		candidate := jsTrim(text)
		if candidate == "" {
			continue
		}
		ids = append(ids, candidate)
	}
	return normalizeRoleIDs(ids, primaryRoleID)
}

// ---- users ----

const publicUserColumns = "`id`, `email`, `emailVerified`, `pendingEmail`, `firstName`, `lastName`, " +
	"`avatarUrl`, `isActive`, `lastLoginAt`, `createdAt`, `updatedAt`"

func scanPublicUser(scanner interface{ Scan(dest ...any) error }) (userRecord, error) {
	var user userRecord
	var emailVerified, lastLoginAt sql.NullTime
	var pendingEmail, avatarURL sql.NullString
	var isActive int
	var createdAt, updatedAt time.Time
	if err := scanner.Scan(&user.ID, &user.Email, &emailVerified, &pendingEmail, &user.FirstName,
		&user.LastName, &avatarURL, &isActive, &lastLoginAt, &createdAt, &updatedAt); err != nil {
		return userRecord{}, err
	}
	user.EmailVerified = timeOrNil(emailVerified)
	user.PendingEmail = stringOrNil(pendingEmail)
	user.AvatarURL = stringOrNil(avatarURL)
	user.IsActive = isActive != 0
	user.LastLoginAt = timeOrNil(lastLoginAt)
	user.CreatedAt = createdAt
	user.UpdatedAt = updatedAt
	return user, nil
}

// loadUserByID reads the non-credential projection; the accept path only needs
// the stored email and a stable id.
func loadUserByID(ctx context.Context, q dbtx, userID string) (userRecord, bool, error) {
	user, err := scanPublicUser(q.QueryRowContext(ctx,
		"SELECT "+publicUserColumns+" FROM `User` WHERE `id` = ? LIMIT 1", userID))
	if errors.Is(err, sql.ErrNoRows) {
		return userRecord{}, false, nil
	}
	if err != nil {
		return userRecord{}, false, err
	}
	return user, true, nil
}

// loadUserByEmail reads the row with passwordHash so the public accept path can
// decide between "existing account, sign in" and "create the account".
func loadUserByEmail(ctx context.Context, q dbtx, email string) (userRecord, string, bool, error) {
	var user userRecord
	var passwordHash string
	var emailVerified, lastLoginAt sql.NullTime
	var pendingEmail, avatarURL sql.NullString
	var isActive int
	var createdAt, updatedAt time.Time
	err := q.QueryRowContext(ctx,
		"SELECT "+publicUserColumns+", `passwordHash` FROM `User` WHERE `email` = ? LIMIT 1", email).
		Scan(&user.ID, &user.Email, &emailVerified, &pendingEmail, &user.FirstName, &user.LastName,
			&avatarURL, &isActive, &lastLoginAt, &createdAt, &updatedAt, &passwordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return userRecord{}, "", false, nil
	}
	if err != nil {
		return userRecord{}, "", false, err
	}
	user.EmailVerified = timeOrNil(emailVerified)
	user.PendingEmail = stringOrNil(pendingEmail)
	user.AvatarURL = stringOrNil(avatarURL)
	user.IsActive = isActive != 0
	user.LastLoginAt = timeOrNil(lastLoginAt)
	user.CreatedAt = createdAt
	user.UpdatedAt = updatedAt
	return user, passwordHash, true, nil
}

// loadUsersByIDs batches the reviewedBy relation so a list never issues one user
// query per row.
func loadUsersByIDs(ctx context.Context, q dbtx, ids []string) (map[string]userRecord, error) {
	out := make(map[string]userRecord, len(ids))
	unique := sortedUniqueStrings(ids)
	if len(unique) == 0 {
		return out, nil
	}
	query := "SELECT " + publicUserColumns + " FROM `User` WHERE `id` IN (" + placeholders(len(unique)) + ")"
	rows, err := q.QueryContext(ctx, query, argsOf(unique)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		user, err := scanPublicUser(rows)
		if err != nil {
			return nil, err
		}
		out[user.ID] = user
	}
	return out, rows.Err()
}

// ---- organizations ----

const orgColumns = "`id`, `name`, `slug`, `description`, `planTier`, `subscriptionStatus`, `isActive`, `createdAt`, `updatedAt`"

func scanOrg(scanner interface{ Scan(dest ...any) error }) (orgRecord, error) {
	var org orgRecord
	var description, planTier, subscriptionStatus sql.NullString
	var isActive int
	if err := scanner.Scan(&org.ID, &org.Name, &org.Slug, &description, &planTier, &subscriptionStatus,
		&isActive, &org.CreatedAt, &org.UpdatedAt); err != nil {
		return orgRecord{}, err
	}
	org.Description = stringOrNil(description)
	org.PlanTier = stringOrNil(planTier)
	org.SubscriptionStatus = stringOrNil(subscriptionStatus)
	org.IsActive = isActive != 0
	return org, nil
}

func loadOrgByID(ctx context.Context, q dbtx, orgID string) (orgRecord, bool, error) {
	org, err := scanOrg(q.QueryRowContext(ctx,
		"SELECT "+orgColumns+" FROM `Org` WHERE `id` = ? LIMIT 1", orgID))
	if errors.Is(err, sql.ErrNoRows) {
		return orgRecord{}, false, nil
	}
	if err != nil {
		return orgRecord{}, false, err
	}
	return org, true, nil
}

func loadOrgBySlug(ctx context.Context, q dbtx, slug string) (orgRecord, bool, error) {
	org, err := scanOrg(q.QueryRowContext(ctx,
		"SELECT "+orgColumns+" FROM `Org` WHERE `slug` = ? LIMIT 1", slug))
	if errors.Is(err, sql.ErrNoRows) {
		return orgRecord{}, false, nil
	}
	if err != nil {
		return orgRecord{}, false, err
	}
	return org, true, nil
}

// loadOrgsByIDs batches organization relations for the application lists.
func loadOrgsByIDs(ctx context.Context, q dbtx, ids []string) (map[string]orgRecord, error) {
	out := make(map[string]orgRecord, len(ids))
	unique := sortedUniqueStrings(ids)
	if len(unique) == 0 {
		return out, nil
	}
	query := "SELECT " + orgColumns + " FROM `Org` WHERE `id` IN (" + placeholders(len(unique)) + ")"
	rows, err := q.QueryContext(ctx, query, argsOf(unique)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		org, err := scanOrg(rows)
		if err != nil {
			return nil, err
		}
		out[org.ID] = org
	}
	return out, rows.Err()
}

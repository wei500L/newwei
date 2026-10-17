package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// membershipRow is one Membership row without its relations.
type membershipRow struct {
	ID       string
	UserID   string
	OrgID    string
	RoleID   string
	IsActive bool
}

// roleRow is one Role row.
type roleRow struct {
	ID          string
	Name        string
	Description sql.NullString
	IsSystem    bool
}

// permissionRow is one Permission row.
type permissionRow struct {
	ID          string
	Name        string
	Description sql.NullString
}

// membershipBundle is a membership plus its effective roles and their
// permissions. roleLinks mirrors the MembershipRole rows: when it is empty
// the primary membership role is the only effective role, exactly like
// collectMembershipRoles in NestJS.
type membershipBundle struct {
	membership  membershipRow
	roleLinks   []string
	roles       map[string]roleRow
	permissions map[string][]permissionRow
}

// effectiveRoleIDs returns the MembershipRole role ids when any link exists,
// otherwise the primary role id.
func (b *membershipBundle) effectiveRoleIDs() []string {
	if len(b.roleLinks) > 0 {
		return uniqueStrings(b.roleLinks)
	}
	if b.membership.RoleID != "" {
		return []string{b.membership.RoleID}
	}
	return nil
}

// effectiveRoles returns the roles that contribute permissions, in role id
// order, skipping ids whose Role row is missing.
func (b *membershipBundle) effectiveRoles() []roleRow {
	roles := make([]roleRow, 0, len(b.roleLinks))
	for _, roleID := range b.effectiveRoleIDs() {
		if role, ok := b.roles[roleID]; ok {
			roles = append(roles, role)
		}
	}
	return roles
}

// permissionNames returns the deduplicated permission names of the effective
// roles in first-seen order, the same order a JavaScript Set produces.
func (b *membershipBundle) permissionNames() []string {
	names := make([]string, 0)
	for _, role := range b.effectiveRoles() {
		for _, permission := range b.permissions[role.ID] {
			name := strings.TrimSpace(permission.Name)
			if name != "" {
				names = append(names, name)
			}
		}
	}
	return uniqueStrings(names)
}

// permissionModels returns the permission objects of the effective roles.
func (b *membershipBundle) permissionModels() []PermissionModel {
	models := make([]PermissionModel, 0)
	for _, role := range b.effectiveRoles() {
		for _, permission := range b.permissions[role.ID] {
			models = append(models, PermissionModel{
				Description: nullStringPtr(permission.Description),
				ID:          permission.ID,
				Name:        permission.Name,
			})
		}
	}
	return models
}

// isSystemAdmin reports whether any effective role is the system admin role
// (isSystem = true and name, lowercased, equals "admin").
func (b *membershipBundle) isSystemAdmin() bool {
	for _, role := range b.effectiveRoles() {
		if role.IsSystem && strings.ToLower(role.Name) == "admin" {
			return true
		}
	}
	return false
}

// roleModels maps effective role ids to GraphQL role objects.
func (b *membershipBundle) roleModels() []RoleModel {
	roles := b.effectiveRoles()
	out := make([]RoleModel, 0, len(roles))
	for _, role := range roles {
		out = append(out, RoleModel{
			Description: nullStringPtr(role.Description),
			ID:          role.ID,
			IsSystem:    role.IsSystem,
			Name:        role.Name,
			Permissions: b.permissionModelsFor(role.ID),
		})
	}
	return out
}

// permissionModelsFor returns the permission objects of one role.
func (b *membershipBundle) permissionModelsFor(roleID string) []PermissionModel {
	out := make([]PermissionModel, 0, len(b.permissions[roleID]))
	for _, permission := range b.permissions[roleID] {
		out = append(out, PermissionModel{
			Description: nullStringPtr(permission.Description),
			ID:          permission.ID,
			Name:        permission.Name,
		})
	}
	return out
}

// primaryRoleModel returns the primary membership role. The relation is
// required in the schema, so a missing row renders an empty role rather than
// dropping the membership.
func (b *membershipBundle) primaryRoleModel() RoleModel {
	role, ok := b.roles[b.membership.RoleID]
	if !ok {
		return RoleModel{Permissions: []PermissionModel{}}
	}
	return RoleModel{
		Description: nullStringPtr(role.Description),
		ID:          role.ID,
		IsSystem:    role.IsSystem,
		Name:        role.Name,
		Permissions: b.permissionModelsFor(role.ID),
	}
}

const membershipColumns = "id, userId, orgId, roleId, isActive"

// loadMembershipForUserInOrg loads the unique (userId, orgId) membership.
func (s *service) loadMembershipForUserInOrg(ctx context.Context, orgID, userID string) (*membershipRow, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	var row membershipRow
	err := s.db.QueryRowContext(ctx,
		"SELECT "+membershipColumns+" FROM Membership WHERE orgId = ? AND userId = ? LIMIT 1",
		orgID, userID).Scan(&row.ID, &row.UserID, &row.OrgID, &row.RoleID, &row.IsActive)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// loadMembershipsForUser loads every membership of a user in creation order.
func (s *service) loadMembershipsForUser(ctx context.Context, userID string) ([]membershipRow, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+membershipColumns+" FROM Membership WHERE userId = ? ORDER BY createdAt ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMembershipRows(rows)
}

// loadMembershipsForOrg loads every membership of an organization. No ORDER
// BY is added so the row order matches Prisma's unordered findMany, which the
// memberships root projects verbatim.
func (s *service) loadMembershipsForOrg(ctx context.Context, orgID string) ([]membershipRow, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+membershipColumns+" FROM Membership WHERE orgId = ?", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMembershipRows(rows)
}

// loadMembershipsForUsers loads the memberships of the given users in one
// organization.
func (s *service) loadMembershipsForUsers(ctx context.Context, orgID string, userIDs []string) ([]membershipRow, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	list, ok := sqlIDList(userIDs)
	if !ok {
		return nil, nil
	}
	query := "SELECT " + membershipColumns + " FROM Membership WHERE orgId = ? AND userId IN (" + list + ")"
	rows, err := s.db.QueryContext(ctx, query, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMembershipRows(rows)
}

func scanMembershipRows(rows *sql.Rows) ([]membershipRow, error) {
	out := make([]membershipRow, 0)
	for rows.Next() {
		var row membershipRow
		if err := rows.Scan(&row.ID, &row.UserID, &row.OrgID, &row.RoleID, &row.IsActive); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// enrichBundles attaches MembershipRole links, roles, and role permissions to
// the given membership rows with three batched queries.
func (s *service) enrichBundles(ctx context.Context, orgID string, rows []membershipRow) (map[string]*membershipBundle, error) {
	bundles := make(map[string]*membershipBundle, len(rows))
	if len(rows) == 0 {
		return bundles, nil
	}
	membershipIDs := make([]string, 0, len(rows))
	roleIDSet := make(map[string]struct{})
	for _, row := range rows {
		bundles[row.ID] = &membershipBundle{
			membership:  row,
			roles:       map[string]roleRow{},
			permissions: map[string][]permissionRow{},
		}
		membershipIDs = append(membershipIDs, row.ID)
		if row.RoleID != "" {
			roleIDSet[row.RoleID] = struct{}{}
		}
	}

	// MembershipRole links decide the multi-role path. A membership with no
	// link row falls back to its primary role.
	if list, ok := sqlIDList(membershipIDs); ok {
		rows, err := s.db.QueryContext(ctx,
			"SELECT membershipId, roleId FROM MembershipRole WHERE orgId = ? AND membershipId IN ("+list+")", orgID)
		if err != nil {
			return nil, err
		}
		func() {
			defer rows.Close()
			for rows.Next() {
				var membershipID, roleID string
				if scanErr := rows.Scan(&membershipID, &roleID); scanErr != nil {
					err = scanErr
					return
				}
				if bundle, ok := bundles[membershipID]; ok {
					bundle.roleLinks = append(bundle.roleLinks, roleID)
				}
				if roleID != "" {
					roleIDSet[roleID] = struct{}{}
				}
			}
			if err == nil {
				err = rows.Err()
			}
		}()
		if err != nil {
			return nil, err
		}
	}

	roleIDs := make([]string, 0, len(roleIDSet))
	for roleID := range roleIDSet {
		roleIDs = append(roleIDs, roleID)
	}
	roles, err := s.loadRoles(ctx, orgID, roleIDs)
	if err != nil {
		return nil, err
	}
	for _, bundle := range bundles {
		bundle.roles = roles
	}
	permissions, err := s.loadRolePermissions(ctx, orgID, roleIDs)
	if err != nil {
		return nil, err
	}
	for _, bundle := range bundles {
		bundle.permissions = permissions
	}
	return bundles, nil
}

// enrichBundle loads the relations of a single membership.
func (s *service) enrichBundle(ctx context.Context, orgID string, row *membershipRow) (*membershipBundle, error) {
	if row == nil {
		return nil, nil
	}
	bundles, err := s.enrichBundles(ctx, orgID, []membershipRow{*row})
	if err != nil {
		return nil, err
	}
	return bundles[row.ID], nil
}

// loadRoles loads Role rows by id inside one organization.
func (s *service) loadRoles(ctx context.Context, orgID string, roleIDs []string) (map[string]roleRow, error) {
	out := make(map[string]roleRow, len(roleIDs))
	list, ok := sqlIDList(roleIDs)
	if !ok {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, name, description, isSystem FROM Role WHERE orgId = ? AND id IN ("+list+")", orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var role roleRow
		if err := rows.Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem); err != nil {
			return nil, err
		}
		out[role.ID] = role
	}
	return out, rows.Err()
}

// loadRolePermissions loads the permissions of the given roles. The join on
// Role keeps the query organization-scoped even though RolePermission itself
// has no orgId column.
func (s *service) loadRolePermissions(ctx context.Context, orgID string, roleIDs []string) (map[string][]permissionRow, error) {
	out := make(map[string][]permissionRow, len(roleIDs))
	list, ok := sqlIDList(roleIDs)
	if !ok {
		return out, nil
	}
	query := fmt.Sprintf(
		"SELECT rp.roleId, p.id, p.name, p.description FROM RolePermission rp "+
			"JOIN Permission p ON p.id = rp.permissionId "+
			"JOIN Role r ON r.id = rp.roleId WHERE r.orgId = ? AND rp.roleId IN (%s)", list)
	rows, err := s.db.QueryContext(ctx, query, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var roleID string
		var permission permissionRow
		if err := rows.Scan(&roleID, &permission.ID, &permission.Name, &permission.Description); err != nil {
			return nil, err
		}
		out[roleID] = append(out[roleID], permission)
	}
	return out, rows.Err()
}

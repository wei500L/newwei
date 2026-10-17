package workspace

import (
	"context"
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// roles implements the roles root. includeSystem defaults to true; when it is
// false only non-system roles are returned. Roles sort by name ascending.
func (s *service) roles(ctx contract.Context) ([]RoleModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	includeSystem := true
	if value, state := contract.Lookup(ctx.Args, "includeSystem"); state == contract.ArgValue {
		if boolean, ok := value.(bool); ok {
			includeSystem = boolean
		}
	}
	callCtx := s.call(ctx)
	query := "SELECT id, name, description, isSystem FROM Role WHERE orgId = ?"
	if !includeSystem {
		query += " AND isSystem = 0"
	}
	query += " ORDER BY name ASC"
	rows, err := s.db.QueryContext(callCtx, query, ctx.Identity.OrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	roles := make([]roleRow, 0)
	for rows.Next() {
		var role roleRow
		if err := rows.Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	roleIDs := make([]string, 0, len(roles))
	for _, role := range roles {
		roleIDs = append(roleIDs, role.ID)
	}
	permissions, err := s.loadRolePermissions(callCtx, ctx.Identity.OrgID, roleIDs)
	if err != nil {
		return nil, err
	}
	out := make([]RoleModel, 0, len(roles))
	for _, role := range roles {
		models := make([]PermissionModel, 0, len(permissions[role.ID]))
		for _, permission := range permissions[role.ID] {
			models = append(models, PermissionModel{
				Description: nullStringPtr(permission.Description),
				ID:          permission.ID,
				Name:        permission.Name,
			})
		}
		out = append(out, RoleModel{
			Description: nullStringPtr(role.Description),
			ID:          role.ID,
			IsSystem:    role.IsSystem,
			Name:        role.Name,
			Permissions: models,
		})
	}
	return out, nil
}

// permissions implements the permissions root: the global table, name
// ascending.
func (s *service) permissions(ctx contract.Context) ([]PermissionModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := s.db.QueryContext(s.call(ctx),
		"SELECT id, name, description FROM Permission ORDER BY name ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PermissionModel, 0)
	for rows.Next() {
		var id, name string
		var description sql.NullString
		if err := rows.Scan(&id, &name, &description); err != nil {
			return nil, err
		}
		out = append(out, PermissionModel{Description: nullStringPtr(description), ID: id, Name: name})
	}
	return out, rows.Err()
}

// memberships implements the memberships root: every membership of the
// organization with its primary role, effective roles, and user.
func (s *service) memberships(ctx contract.Context) ([]MembershipModel, error) {
	callCtx := s.call(ctx)
	rows, err := s.loadMembershipsForOrg(callCtx, ctx.Identity.OrgID)
	if err != nil {
		return nil, err
	}
	bundles, err := s.enrichBundles(callCtx, ctx.Identity.OrgID, rows)
	if err != nil {
		return nil, err
	}
	userIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		userIDs = append(userIDs, row.UserID)
	}
	users, err := s.loadUsersByIDs(callCtx, userIDs)
	if err != nil {
		return nil, err
	}
	out := make([]MembershipModel, 0, len(rows))
	for _, row := range rows {
		bundle := bundles[row.ID]
		if bundle == nil {
			continue
		}
		user, ok := users[row.UserID]
		if !ok {
			user = userRow{ID: row.UserID}
		}
		out = append(out, MembershipModel{
			ID:    row.ID,
			OrgID: row.OrgID,
			Role:  bundle.primaryRoleModel(),
			Roles: bundle.roleModels(),
			User:  userModelFromListRow(user, bundle, row.OrgID),
		})
	}
	return out, nil
}

// loadUsersByIDs loads User rows by id, keyed by id.
func (s *service) loadUsersByIDs(ctx context.Context, userIDs []string) (map[string]userRow, error) {
	out := make(map[string]userRow, len(userIDs))
	list, ok := sqlIDList(userIDs)
	if !ok {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, email, firstName, lastName, avatarUrl, isActive, emailVerified, lastLoginAt, createdAt "+
			"FROM User WHERE id IN ("+list+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var row userRow
		if err := rows.Scan(&row.ID, &row.Email, &row.FirstName, &row.LastName, &row.AvatarURL,
			&row.IsActive, &row.EmailVerified, &row.LastLoginAt, &row.CreatedAt); err != nil {
			return nil, err
		}
		out[row.ID] = row
	}
	return out, rows.Err()
}

// myOrganizations implements the myOrganizations root: memberships of the
// caller in creation order, deduplicated by organization, with isActive
// following `org.isActive && (membership.isActive ?? true)`.
func (s *service) myOrganizations(ctx contract.Context) ([]OrgModel, error) {
	callCtx := s.call(ctx)
	memberships, orgs, err := s.loadMembershipsWithOrgs(callCtx, ctx.Identity.UserID)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(memberships))
	out := make([]OrgModel, 0, len(memberships))
	for _, membership := range memberships {
		if _, ok := seen[membership.OrgID]; ok {
			continue
		}
		seen[membership.OrgID] = struct{}{}
		org, ok := orgs[membership.OrgID]
		if !ok {
			continue
		}
		out = append(out, OrgModel{
			CreatedAt:   utcTime(org.CreatedAt),
			Description: nullStringPtr(org.Description),
			ID:          org.ID,
			IsActive:    org.IsActive && membership.IsActive,
			Name:        org.Name,
			Slug:        org.Slug,
			UpdatedAt:   utcTime(org.UpdatedAt),
		})
	}
	return out, nil
}

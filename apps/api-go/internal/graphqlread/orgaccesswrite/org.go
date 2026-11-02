package orgaccesswrite

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

// permissionRow is one Permission row, used to bootstrap the default roles.
type permissionRow struct {
	ID   string
	Name string
}

// createOrg mirrors OrgService.createOrg: normalize name, slug and description,
// then create the organization, the three default roles with their permissions,
// the creator's system administrator membership, and the audit row in one
// transaction. The active organization list is invalidated after the commit.
func (s *service) createOrg(ctx contract.Context, input createOrgInput) (workspace.OrgModel, error) {
	return s.createOrgForActor(callContext(ctx), ctx.Identity.UserID, input.Name, input.Slug, input.Description)
}

// createOrgForActor is the shared organization bootstrap used by the GraphQL
// createOrg mutation and by the narrow port the identity onboarding batch calls
// when a platform administrator approves a new-organization application. It
// keeps the exact validation, transaction, audit and active-org invalidation
// order of the mutation, and it never reads a request body or a feature switch.
func (s *service) createOrgForActor(ctx context.Context, actorID, rawName, rawSlug string, rawDescription *string) (workspace.OrgModel, error) {
	if s == nil || s.db == nil {
		return workspace.OrgModel{}, errDatabaseUnavailable
	}
	name := jsTrim(rawName)
	slug := strings.ToLower(jsTrim(rawSlug))
	description := trimmedOptional(rawDescription)
	if name == "" {
		return workspace.OrgModel{}, badRequest("Organization name is required")
	}
	if slug == "" {
		return workspace.OrgModel{}, badRequest("Organization slug is required")
	}
	if !slugPattern.MatchString(slug) {
		return workspace.OrgModel{}, badRequest("Invalid organization slug")
	}
	org, err := s.insertOrg(ctx, actorID, name, slug, description)
	if err != nil {
		return workspace.OrgModel{}, err
	}
	if err := s.invalidateActiveOrgs(ctx); err != nil {
		return workspace.OrgModel{}, err
	}
	return org, nil
}

// insertOrg writes the whole organization bootstrap in one transaction. Any
// duplicate-key error is reported as the slug conflict, matching the P2002
// mapping in OrgService.createOrg.
func (s *service) insertOrg(ctx context.Context, actorID, name, slug string, description *string) (workspace.OrgModel, error) {
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workspace.OrgModel{}, err
	}
	defer func() { _ = tx.Rollback() }()

	orgID, _, _, err := insertOrgTx(ctx, tx, actorID, name, slug, description, now)
	if err != nil {
		return workspace.OrgModel{}, err
	}
	if err := tx.Commit(); err != nil {
		return workspace.OrgModel{}, slugConflict(err)
	}
	return orgModel(orgID, name, slug, description, true, now, now), nil
}

// insertOrgTx is the statement body of the organization bootstrap. It runs on
// the caller's executor so the shared GraphQL createOrg mutation keeps owning
// its transaction, while the identity onboarding approval can run the same
// bootstrap inside a wider transaction that also records the application
// association and the invitation. It never commits and never invalidates the
// active organization cache; the caller owns both.
func insertOrgTx(ctx context.Context, exec dbtx, actorID, name, slug string, description *string, now time.Time) (orgID, adminRoleID string, warnings []bootstrapWarning, err error) {
	orgID, err = newRowID()
	if err != nil {
		return "", "", nil, err
	}
	if _, err := exec.ExecContext(ctx,
		"INSERT INTO Org (id, name, slug, description, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)",
		orgID, name, slug, sqlNullableString(description), now, now); err != nil {
		return "", "", nil, slugConflict(err)
	}

	permissions, err := loadAllPermissions(ctx, exec)
	if err != nil {
		return "", "", nil, err
	}
	permissionIDByName := make(map[string]string, len(permissions))
	allPermissionIDs := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		permissionIDByName[permission.Name] = permission.ID
		allPermissionIDs = append(allPermissionIDs, permission.ID)
	}

	warnings = make([]bootstrapWarning, 0)
	adminRoleID = ""
	for _, roleDef := range defaultRoles {
		roleID, err := newRowID()
		if err != nil {
			return "", "", nil, err
		}
		if _, err := exec.ExecContext(ctx,
			"INSERT INTO Role (id, name, description, isSystem, orgId) VALUES (?, ?, ?, ?, ?)",
			roleID, roleDef.Name, roleDef.Description, boolValue(roleDef.IsSystem), orgID); err != nil {
			return "", "", nil, slugConflict(err)
		}
		missing := make([]string, 0)
		for _, permissionName := range roleDef.Permissions {
			if _, ok := permissionIDByName[permissionName]; !ok {
				missing = append(missing, permissionName)
			}
		}
		if len(missing) > 0 {
			warnings = append(warnings, bootstrapWarning{Role: roleDef.Name, MissingPermissions: missing})
		}
		// The admin role receives every Permission row, not just the ones named
		// by DEFAULT_ROLES; the other roles receive their named subset and skip
		// the names the database does not have.
		permissionIDs := make([]string, 0, len(roleDef.Permissions))
		if roleDef.Name == systemAdminRoleName {
			permissionIDs = allPermissionIDs
		} else {
			for _, permissionName := range roleDef.Permissions {
				if permissionID, ok := permissionIDByName[permissionName]; ok {
					permissionIDs = append(permissionIDs, permissionID)
				}
			}
		}
		for _, permissionID := range permissionIDs {
			linkID, err := newRowID()
			if err != nil {
				return "", "", nil, err
			}
			if _, err := exec.ExecContext(ctx,
				"INSERT INTO RolePermission (id, roleId, permissionId) VALUES (?, ?, ?)",
				linkID, roleID, permissionID); err != nil {
				return "", "", nil, slugConflict(err)
			}
		}
		if roleDef.Name == systemAdminRoleName {
			adminRoleID = roleID
		}
	}
	if adminRoleID == "" {
		// Unreachable: the loop above always creates the admin role.
		return "", "", nil, errMirroredServerError
	}

	membershipID, err := newRowID()
	if err != nil {
		return "", "", nil, err
	}
	if _, err := exec.ExecContext(ctx,
		"INSERT INTO Membership (id, userId, orgId, roleId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)",
		membershipID, actorID, orgID, adminRoleID, now); err != nil {
		return "", "", nil, slugConflict(err)
	}
	if _, err := exec.ExecContext(ctx,
		"INSERT INTO MembershipRole (membershipId, orgId, roleId, createdAt) VALUES (?, ?, ?, ?)",
		membershipID, orgID, adminRoleID, now); err != nil {
		return "", "", nil, slugConflict(err)
	}

	writeAuditLogBestEffort(ctx, exec, orgID, actorID, "org", "create", orgCreateAudit{
		Slug:              slug,
		Name:              name,
		BootstrapWarnings: warnings,
	})
	return orgID, adminRoleID, warnings, nil
}

// slugConflict maps a duplicate-key error to the NestJS P2002 response and
// passes every other error through.
func slugConflict(err error) error {
	if uniqueConflict(err) {
		return badRequest("Organization slug already exists")
	}
	return err
}

// updateOrg mirrors OrgService.updateOrg: the caller must hold org.write in the
// target organization, name and slug are re-validated after trimming, and only
// the supplied properties are written. description keeps its three states:
// omitted leaves the column, null or blank clears it, and any other value is
// trimmed and stored.
func (s *service) updateOrg(ctx contract.Context, input updateOrgInput) (workspace.OrgModel, error) {
	if s == nil || s.db == nil {
		return workspace.OrgModel{}, errDatabaseUnavailable
	}
	callCtx := callContext(ctx)
	orgID := jsTrim(input.ID)
	if orgID == "" {
		return workspace.OrgModel{}, badRequest("Organization id is required")
	}
	if err := s.assertActorCanManageOrg(callCtx, ctx.Identity.UserID, orgID); err != nil {
		return workspace.OrgModel{}, err
	}

	assignments := make([]string, 0, 4)
	args := make([]any, 0, 5)
	metadata := orgUpdateAudit{}
	if input.NamePresent && input.Name != nil {
		name := jsTrim(*input.Name)
		if name == "" {
			return workspace.OrgModel{}, badRequest("Organization name is required")
		}
		assignments = append(assignments, "name = ?")
		args = append(args, name)
		metadata.Name = auditString(&name)
	}
	if input.SlugPresent && input.Slug != nil {
		slug := strings.ToLower(jsTrim(*input.Slug))
		if slug == "" {
			return workspace.OrgModel{}, badRequest("Organization slug is required")
		}
		if !slugPattern.MatchString(slug) {
			return workspace.OrgModel{}, badRequest("Invalid organization slug")
		}
		assignments = append(assignments, "slug = ?")
		args = append(args, slug)
		metadata.Slug = auditString(&slug)
	}
	if input.DescriptionPresent {
		trimmed := trimmedOptional(input.Description)
		assignments = append(assignments, "description = ?")
		args = append(args, sqlNullableString(trimmed))
		// The audit keeps the raw value, matching the NestJS metadata literal.
		metadata.Description = auditString(input.Description)
	}
	now := nowMillis()
	assignments = append(assignments, "updatedAt = ?")
	args = append(args, now, orgID)

	// RowsAffected is not used to detect a missing organization: MySQL reports
	// zero changed rows when the update is a no-op, so existence is checked by
	// reading the row back below.
	if _, err := s.db.ExecContext(callCtx, "UPDATE Org SET "+strings.Join(assignments, ", ")+" WHERE id = ?", args...); err != nil {
		return workspace.OrgModel{}, slugConflict(err)
	}
	org, err := s.loadOrg(callCtx, orgID)
	if err != nil {
		return workspace.OrgModel{}, err
	}
	writeAuditLogBestEffort(callCtx, s.db, orgID, ctx.Identity.UserID, "org", "update", metadata)
	// The active organization list only stores ids and NestJS does not
	// invalidate it on update, so a Redis failure here must not turn the already
	// committed update into a GraphQL error: the drop is best effort.
	_ = s.invalidateActiveOrgs(callCtx)
	return org, nil
}

// setOrgActive mirrors OrgService.setOrgActive: re-derive org.write in the
// target organization, write Org.isActive, audit enable/disable, invalidate the
// active organization list, and drop every member's profile cache when the
// organization is disabled.
func (s *service) setOrgActive(ctx contract.Context, input setOrgActiveInput) (workspace.OrgModel, error) {
	if s == nil || s.db == nil {
		return workspace.OrgModel{}, errDatabaseUnavailable
	}
	callCtx := callContext(ctx)
	orgID := jsTrim(input.ID)
	if err := s.assertActorCanManageOrg(callCtx, ctx.Identity.UserID, orgID); err != nil {
		return workspace.OrgModel{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(callCtx,
		"UPDATE Org SET isActive = ?, updatedAt = ? WHERE id = ?", boolValue(input.IsActive), now, orgID); err != nil {
		return workspace.OrgModel{}, err
	}
	org, err := s.loadOrg(callCtx, orgID)
	if err != nil {
		return workspace.OrgModel{}, err
	}
	action := "disable"
	if input.IsActive {
		action = "enable"
	}
	writeAuditLogBestEffort(callCtx, s.db, orgID, ctx.Identity.UserID, "org", action, orgSetActiveAudit{IsActive: input.IsActive})
	if err := s.invalidateActiveOrgs(callCtx); err != nil {
		return workspace.OrgModel{}, err
	}
	if !input.IsActive {
		s.deleteMemberProfileCaches(callCtx, orgID)
	}
	return org, nil
}

// assertActorCanManageOrg mirrors OrgService.assertActorCanManageOrg: the actor
// must be a member of the target organization and hold org.write there. The
// permission set is re-derived from the target organization, never from the
// caller's active-organization claims.
func (s *service) assertActorCanManageOrg(ctx context.Context, actorID, orgID string) error {
	if actorID == "" {
		return forbidden("Missing actor context")
	}
	if orgID == "" {
		return badRequest("Organization id is required")
	}
	allowed, found, err := s.rbac.ActorHasPermission(ctx, orgID, actorID, "org.write")
	if err != nil {
		return err
	}
	if !found {
		return forbidden("Not a member of the organization")
	}
	if !allowed {
		return forbidden("org.write permission required in the target organization")
	}
	return nil
}

// loadOrg reads one organization row as the GraphQL model.
func (s *service) loadOrg(ctx context.Context, orgID string) (workspace.OrgModel, error) {
	var id, name, slug string
	var description sql.NullString
	var isActive int
	var createdAt, updatedAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT id, name, slug, description, isActive, createdAt, updatedAt FROM Org WHERE id = ? LIMIT 1", orgID).
		Scan(&id, &name, &slug, &description, &isActive, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return workspace.OrgModel{}, errMirroredServerError
	}
	if err != nil {
		return workspace.OrgModel{}, err
	}
	return orgModel(id, name, slug, nullStringPtr(description), isActive != 0, createdAt, updatedAt), nil
}

// loadAllPermissions reads the global permission catalog, matching an unordered
// Prisma findMany.
func loadAllPermissions(ctx context.Context, q dbtx) ([]permissionRow, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, name FROM Permission")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []permissionRow{}
	for rows.Next() {
		var permission permissionRow
		if err := rows.Scan(&permission.ID, &permission.Name); err != nil {
			return nil, err
		}
		out = append(out, permission)
	}
	return out, rows.Err()
}

// invalidateActiveOrgs drops the cached active organization list. A Redis
// failure is reported, matching ActiveOrgRegistryService.invalidate which is
// not wrapped in a try/catch.
func (s *service) invalidateActiveOrgs(ctx context.Context) error {
	if s.redis == nil {
		return nil
	}
	return s.redis.Del(ctx, activeOrgListKey).Err()
}

// deleteMemberProfileCaches drops profile:<userId>:<orgId> for every member of
// a disabled organization. Redis failures are logged and never fail the write,
// matching the Promise.allSettled try/catch in OrgService.setOrgActive.
func (s *service) deleteMemberProfileCaches(ctx context.Context, orgID string) {
	if s.redis == nil {
		return
	}
	rows, err := s.db.QueryContext(ctx, "SELECT userId FROM Membership WHERE orgId = ?", orgID)
	if err != nil {
		log.Printf("orgaccesswrite: failed to list organization members for profile invalidation: %v", err)
		return
	}
	userIDs := make([]string, 0)
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			log.Printf("orgaccesswrite: failed to scan organization member: %v", err)
			return
		}
		userIDs = append(userIDs, userID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		log.Printf("orgaccesswrite: failed to list organization members: %v", err)
		return
	}
	rows.Close()
	for _, userID := range userIDs {
		_ = s.redis.Del(ctx, "profile:"+userID+":"+orgID).Err()
	}
}

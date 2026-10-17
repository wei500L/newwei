package orgaccesswrite

import (
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// orgModel builds the GraphQL OrgModel from a stored row. The three mutation
// results expose Org.isActive only; the membership-aware combination belongs to
// the myOrganizations read root.
func orgModel(id, name, slug string, description *string, isActive bool, createdAt, updatedAt time.Time) workspace.OrgModel {
	return workspace.OrgModel{
		CreatedAt:   createdAt.UTC(),
		Description: description,
		ID:          id,
		IsActive:    isActive,
		Name:        name,
		Slug:        slug,
		UpdatedAt:   updatedAt.UTC(),
	}
}

// roleModelOf converts a typed RBAC role view to the shared GraphQL model,
// flattening the Prisma relation wrapper into PermissionModel objects.
func roleModelOf(role rbacapi.RoleView) workspace.RoleModel {
	permissions := make([]workspace.PermissionModel, 0, len(role.Permissions))
	for _, permission := range role.Permissions {
		permissions = append(permissions, workspace.PermissionModel{
			Description: permission.Description,
			ID:          permission.ID,
			Name:        permission.Name,
		})
	}
	return workspace.RoleModel{
		Description: role.Description,
		ID:          role.ID,
		IsSystem:    role.IsSystem,
		Name:        role.Name,
		Permissions: permissions,
	}
}

// membershipModelOf converts a typed RBAC membership view to the shared GraphQL
// model.
func membershipModelOf(membership rbacapi.MembershipView) workspace.MembershipModel {
	roles := make([]workspace.RoleModel, 0, len(membership.Roles))
	for _, role := range membership.Roles {
		roles = append(roles, roleModelOf(role))
	}
	return workspace.MembershipModel{
		ID:    membership.ID,
		OrgID: membership.OrgID,
		Role:  roleModelOf(membership.Role),
		Roles: roles,
		User:  userModelOf(membership.OrgID, membership.User),
	}
}

// userModelOf converts a typed RBAC user view to the shared GraphQL model.
// planTier and subscriptionStatus stay null: the two user mutations never
// populate them.
func userModelOf(orgID string, user rbacapi.UserView) workspace.UserModel {
	model := workspace.UserModel{
		AvatarURL:     user.AvatarURL,
		Email:         user.Email,
		EmailVerified: user.EmailVerified,
		FirstName:     user.FirstName,
		ID:            user.ID,
		IsActive:      user.IsActive,
		LastLoginAt:   user.LastLoginAt,
		LastName:      user.LastName,
		OrgID:         orgID,
		Permissions:   []string{},
		PrimaryRoleID: user.PrimaryRoleID,
		RoleIDs:       []string{},
	}
	if len(user.RoleIDs) > 0 {
		model.RoleIDs = user.RoleIDs
	}
	if len(user.Permissions) > 0 {
		model.Permissions = user.Permissions
	}
	return model
}

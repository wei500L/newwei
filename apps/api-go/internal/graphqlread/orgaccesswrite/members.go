package orgaccesswrite

import (
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

// updateMembershipRoles mirrors UserAdminService.updateMembershipRoles through
// the reused rbacapi write: the role ids are trimmed, emptied and deduplicated,
// the primary role must be part of the result, and one transaction replaces the
// primary role and the MembershipRole rows. The response is the updated user
// model with the effective permission union.
func (s *service) updateMembershipRoles(ctx contract.Context, input updateMembershipRolesInput) (workspace.UserModel, error) {
	user, err := s.rbac.UpdateMembershipRolesView(
		callContext(ctx),
		ctx.Identity.OrgID,
		ctx.Identity.UserID,
		ctx.Identity.Permissions,
		input.UserID,
		input.PrimaryRoleID,
		input.RoleIDs,
	)
	if err != nil {
		return workspace.UserModel{}, err
	}
	return userModelOf(ctx.Identity.OrgID, user), nil
}

// setUserActive mirrors UserAdminService.setUserActive through the reused
// rbacapi write: Membership.isActive is updated, never User.isActive, and the
// response combines both flags.
func (s *service) setUserActive(ctx contract.Context, input setUserActiveInput) (workspace.UserModel, error) {
	user, err := s.rbac.SetUserActiveView(
		callContext(ctx),
		ctx.Identity.OrgID,
		ctx.Identity.UserID,
		input.UserID,
		input.IsActive,
	)
	if err != nil {
		return workspace.UserModel{}, err
	}
	return userModelOf(ctx.Identity.OrgID, user), nil
}

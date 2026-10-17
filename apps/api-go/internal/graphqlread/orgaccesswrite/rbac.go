package orgaccesswrite

import (
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

// createRole mirrors RbacService.createRole through the reused rbacapi write:
// rate limit, organization administrator check, reserved-name rejection,
// permission existence and scope checks, then one transaction that creates the
// role and its RolePermission rows.
func (s *service) createRole(ctx contract.Context, input createRoleInput) (workspace.RoleModel, error) {
	description := ""
	if input.Description != nil {
		description = *input.Description
	}
	role, err := s.rbac.CreateRoleView(
		callContext(ctx),
		ctx.Identity.OrgID,
		ctx.Identity.UserID,
		ctx.Identity.Permissions,
		input.Name,
		description,
		input.Permissions,
	)
	if err != nil {
		return workspace.RoleModel{}, err
	}
	return roleModelOf(role), nil
}

// updateRole mirrors RbacService.updateRole through the reused rbacapi write.
// The description keeps its three states: omitted or null is stored as NULL and
// an empty string stays an empty string.
func (s *service) updateRole(ctx contract.Context, input updateRoleInput) (workspace.RoleModel, error) {
	role, err := s.rbac.UpdateRoleView(
		callContext(ctx),
		ctx.Identity.OrgID,
		ctx.Identity.UserID,
		ctx.Identity.Permissions,
		input.ID,
		input.Description,
		input.Permissions,
	)
	if err != nil {
		return workspace.RoleModel{}, err
	}
	return roleModelOf(role), nil
}

// assignRole mirrors RbacService.assignRole through the reused rbacapi write:
// the membership row is locked before its roles are replaced, a target that is
// not yet a member is created in the same transaction, and the response is the
// full membership including the user's effective permission union.
func (s *service) assignRole(ctx contract.Context, input assignRoleInput) (workspace.MembershipModel, error) {
	membership, err := s.rbac.AssignRoleView(
		callContext(ctx),
		ctx.Identity.OrgID,
		ctx.Identity.UserID,
		ctx.Identity.Permissions,
		input.UserID,
		input.RoleID,
	)
	if err != nil {
		return workspace.MembershipModel{}, err
	}
	return membershipModelOf(membership), nil
}

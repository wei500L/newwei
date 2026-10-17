package orgaccesswrite

import (
	"database/sql"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// service holds the write backends. rbac owns the role and membership write
// semantics; db and redis are used by the organization path.
type service struct {
	db    *sql.DB
	redis *redis.Client
	rbac  *rbacapi.Service
}

// Register adds the eight mutations and their root permissions.
//
// It registers no object type on purpose: the mutation results project the
// shared workspace models, whose registration (and field-level permissions)
// must happen exactly once. The caller therefore registers the models through
// either workspace.Register or workspace.RegisterModels and then calls
// Register here.
func Register(reg *contract.Registry, db *sql.DB, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: orgaccesswrite.Register requires a registry")
	}
	svc := &service{
		db:    db,
		redis: redisClient,
		rbac:  rbacapi.NewService(db, redisClient),
	}
	reg.RegisterMutation(contract.Root{Name: "createOrg", Permission: "org.write", Resolve: contract.Bind(svc.createOrgResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateOrg", Permission: "org.write", Resolve: contract.Bind(svc.updateOrgResolver)})
	reg.RegisterMutation(contract.Root{Name: "setOrgActive", Permission: "org.write", Resolve: contract.Bind(svc.setOrgActiveResolver)})
	reg.RegisterMutation(contract.Root{Name: "createRole", Permission: "roles.write", Resolve: contract.Bind(svc.createRoleResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateRole", Permission: "roles.write", Resolve: contract.Bind(svc.updateRoleResolver)})
	reg.RegisterMutation(contract.Root{Name: "assignRole", Permission: "roles.write", Resolve: contract.Bind(svc.assignRoleResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateMembershipRoles", Permission: "users.write", Resolve: contract.Bind(svc.updateMembershipRolesResolver)})
	reg.RegisterMutation(contract.Root{Name: "setUserActive", Permission: "users.write", Resolve: contract.Bind(svc.setUserActiveResolver)})
}

// RegisteredMutations lists the mutation names Register adds. The startup log
// and the migration tests use it.
var RegisteredMutations = []string{
	"createOrg",
	"updateOrg",
	"setOrgActive",
	"createRole",
	"updateRole",
	"assignRole",
	"updateMembershipRoles",
	"setUserActive",
}

func (s *service) createOrgResolver(ctx contract.Context) (workspace.OrgModel, error) {
	input, err := parseCreateOrgInput(ctx.Args)
	if err == nil {
		var org workspace.OrgModel
		if org, err = s.createOrg(ctx, input); err == nil {
			return org, nil
		}
	}
	return workspace.OrgModel{}, graphqlFailure(err)
}

func (s *service) updateOrgResolver(ctx contract.Context) (workspace.OrgModel, error) {
	input, err := parseUpdateOrgInput(ctx.Args)
	if err == nil {
		var org workspace.OrgModel
		if org, err = s.updateOrg(ctx, input); err == nil {
			return org, nil
		}
	}
	return workspace.OrgModel{}, graphqlFailure(err)
}

func (s *service) setOrgActiveResolver(ctx contract.Context) (workspace.OrgModel, error) {
	input, err := parseSetOrgActiveInput(ctx.Args)
	if err == nil {
		var org workspace.OrgModel
		if org, err = s.setOrgActive(ctx, input); err == nil {
			return org, nil
		}
	}
	return workspace.OrgModel{}, graphqlFailure(err)
}

func (s *service) createRoleResolver(ctx contract.Context) (workspace.RoleModel, error) {
	input, err := parseCreateRoleInput(ctx.Args)
	if err == nil {
		var role workspace.RoleModel
		if role, err = s.createRole(ctx, input); err == nil {
			return role, nil
		}
	}
	return workspace.RoleModel{}, graphqlFailure(err)
}

func (s *service) updateRoleResolver(ctx contract.Context) (workspace.RoleModel, error) {
	input, err := parseUpdateRoleInput(ctx.Args)
	if err == nil {
		var role workspace.RoleModel
		if role, err = s.updateRole(ctx, input); err == nil {
			return role, nil
		}
	}
	return workspace.RoleModel{}, graphqlFailure(err)
}

func (s *service) assignRoleResolver(ctx contract.Context) (workspace.MembershipModel, error) {
	input, err := parseAssignRoleInput(ctx.Args)
	if err == nil {
		var membership workspace.MembershipModel
		if membership, err = s.assignRole(ctx, input); err == nil {
			return membership, nil
		}
	}
	return workspace.MembershipModel{}, graphqlFailure(err)
}

func (s *service) updateMembershipRolesResolver(ctx contract.Context) (workspace.UserModel, error) {
	input, err := parseUpdateMembershipRolesInput(ctx.Args)
	if err == nil {
		var user workspace.UserModel
		if user, err = s.updateMembershipRoles(ctx, input); err == nil {
			return user, nil
		}
	}
	return workspace.UserModel{}, graphqlFailure(err)
}

func (s *service) setUserActiveResolver(ctx contract.Context) (workspace.UserModel, error) {
	input, err := parseSetUserActiveInput(ctx.Args)
	if err == nil {
		var user workspace.UserModel
		if user, err = s.setUserActive(ctx, input); err == nil {
			return user, nil
		}
	}
	return workspace.UserModel{}, graphqlFailure(err)
}

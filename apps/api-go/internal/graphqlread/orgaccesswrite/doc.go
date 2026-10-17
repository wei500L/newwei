// Package orgaccesswrite serves the eight organization, role and membership
// GraphQL mutations that the workspace console writes through:
//
//	createOrg, updateOrg, setOrgActive,
//	createRole, updateRole, assignRole,
//	updateMembershipRoles, setUserActive
//
// The mutations are registered only when API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE
// is go. While it is legacy (or unset) every document that selects one of them
// falls back to NestJS as a whole, which is also the rollback: set the switch
// back to legacy.
//
// The package owns the GraphQL input adaptation, the organization write path
// and the projection onto the shared workspace models. The role and membership
// write semantics stay in internal/rbacapi and are reused through its typed
// view API; no model is moved through a serialized form and no HTTP call is
// made to this process.
//
// Only JWT, MySQL and Redis are needed. Writing does not require Mongo and
// does not initialize any read-only Mongo service.
package orgaccesswrite

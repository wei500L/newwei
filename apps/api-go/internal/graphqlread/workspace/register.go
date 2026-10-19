// Package workspace serves the identity, organization, RBAC, dashboard,
// queue, sentiment, and processed-item GraphQL read roots that were the
// workspace console's first reads.
//
// Registered roots: me, myOrganizations, users, userLoginRecords, roles,
// permissions, memberships, dashboards, queueStats, entitySentimentSeries,
// topicSentimentSeries, processedItemById.
//
// The roots are registered only when both API_GO_GRAPHQL_READ_MODE and
// API_GO_GRAPHQL_WORKSPACE_READ_MODE are go; otherwise every document that
// selects one of them stays on NestJS. The remaining mutations fall back; the
// queueEvents subscription is served by the independent
// graphqlsubscriptions executor (its QueueEventModel projection is registered
// here by RegisterQueueEventModel). The eight organization, role and
// membership mutations live in the orgaccesswrite package behind their own
// switch and reuse the models registered here.
//
// Field-level @HasPermission is declared through
// contract.Registry.RegisterFieldPermission: UserModel.primaryRoleId,
// isActive, emailVerified, lastLoginAt, and roleIds require users.read;
// RoleModel.permissions requires roles.read; MembershipModel.role, roles, and
// user require users.read.
package workspace

import (
	"database/sql"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register adds the twelve read roots, the object types they project, and
// the field-level permission guards. The database handles may be nil for
// tests; a resolver reports an internal error if it needs a missing handle.
func Register(reg *contract.Registry, db *sql.DB, mongoDB *mongo.Database, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: workspace.Register requires a registry")
	}
	registerModels(reg)

	svc := &service{db: db, mongo: mongoDB, redis: redisClient}
	reg.RegisterRoot(contract.Root{Name: "me", AllowAuthenticated: true, Resolve: contract.Bind(svc.me)})
	reg.RegisterRoot(contract.Root{Name: "myOrganizations", AllowAuthenticated: true, Resolve: contract.Bind(svc.myOrganizations)})
	reg.RegisterRoot(contract.Root{Name: "users", Permission: "users.read", Resolve: contract.Bind(svc.users)})
	reg.RegisterRoot(contract.Root{Name: "userLoginRecords", Permission: "users.read", Resolve: contract.Bind(svc.userLoginRecords)})
	reg.RegisterRoot(contract.Root{Name: "roles", Permission: "roles.read", Resolve: contract.Bind(svc.roles)})
	reg.RegisterRoot(contract.Root{Name: "permissions", Permission: "permissions.read", Resolve: contract.Bind(svc.permissions)})
	reg.RegisterRoot(contract.Root{Name: "memberships", Permission: "users.read", Resolve: contract.Bind(svc.memberships)})
	reg.RegisterRoot(contract.Root{Name: "dashboards", Permission: "dashboards.read", Resolve: contract.Bind(svc.dashboards)})
	reg.RegisterRoot(contract.Root{Name: "queueStats", Permission: "queue.manage", Resolve: contract.Bind(svc.queueStats)})
	reg.RegisterRoot(contract.Root{Name: "entitySentimentSeries", Permission: "dashboards.read", Resolve: contract.Bind(svc.entitySentimentSeries)})
	reg.RegisterRoot(contract.Root{Name: "topicSentimentSeries", Permission: "dashboards.read", Resolve: contract.Bind(svc.topicSentimentSeries)})
	reg.RegisterRoot(contract.Root{Name: "processedItemById", Permission: "items.read", Resolve: contract.Bind(svc.processedItemByID)})
}

// RegisterModels registers the identity, organization, and RBAC object types
// projected by the workspace roots together with their field-level permission
// guards, without registering any read root.
//
// It exists so the organization/role/membership mutation batch can project the
// same shared models while the workspace read switch is legacy. Every type and
// every field permission may be registered exactly once per registry, so a
// caller must choose between Register (reads plus models) and RegisterModels
// (models only), never both.
func RegisterModels(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: workspace.RegisterModels requires a registry")
	}
	registerModels(reg)
}

// RegisterQueueEventModel registers only the QueueEventModel projection. The
// local graphql-transport-ws subscription executor returns this model without
// assembling any workspace read root, Mongo service or field permission.
func RegisterQueueEventModel(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: workspace.RegisterQueueEventModel requires a registry")
	}
	reg.RegisterType("QueueEventModel", QueueEventModel{})
}

func registerModels(reg *contract.Registry) {
	reg.RegisterType("UserModel", UserModel{})
	reg.RegisterType("UserLoginRecordModel", UserLoginRecordModel{})
	reg.RegisterType("OrgModel", OrgModel{})
	reg.RegisterType("PermissionModel", PermissionModel{})
	reg.RegisterType("RoleModel", RoleModel{})
	reg.RegisterType("MembershipModel", MembershipModel{})
	reg.RegisterType("DashboardModel", DashboardModel{})
	reg.RegisterType("DashboardWidgetModel", DashboardWidgetModel{})
	reg.RegisterType("QueueCountsModel", QueueCountsModel{})
	reg.RegisterType("QueueEventModel", QueueEventModel{})
	reg.RegisterType("QueueStatsModel", QueueStatsModel{})
	reg.RegisterType("EntitySentimentSnapshotModel", EntitySentimentSnapshotModel{})
	reg.RegisterType("TopicSentimentSnapshotModel", TopicSentimentSnapshotModel{})
	reg.RegisterType("ProcessedItemErrorModelGraph", ProcessedItemErrorModelGraph{})
	reg.RegisterType("ProcessedItemLlmModel", ProcessedItemLlmModel{})
	reg.RegisterType("ProcessedItemModelGraph", ProcessedItemModelGraph{})

	// Field-level permissions from the SDL models: selecting a guarded field
	// without the permission fails closed with FORBIDDEN exactly like the
	// NestJS GqlPermissionsGuard.
	registerFieldPermissions(reg)
}

// registerFieldPermissions declares the nested @HasPermission guards. The
// users.read guards on MembershipModel are redundant with the root
// permission today but keep the type safe for any future root that projects a
// membership.
func registerFieldPermissions(reg *contract.Registry) {
	for _, field := range []string{"primaryRoleId", "isActive", "emailVerified", "lastLoginAt", "roleIds"} {
		reg.RegisterFieldPermission("UserModel", field, "users.read")
	}
	reg.RegisterFieldPermission("RoleModel", "permissions", "roles.read")
	for _, field := range []string{"role", "roles", "user"} {
		reg.RegisterFieldPermission("MembershipModel", field, "users.read")
	}
}

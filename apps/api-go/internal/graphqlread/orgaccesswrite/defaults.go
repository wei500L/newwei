package orgaccesswrite

// defaultRole is one DEFAULT_ROLES entry: the role created for every new
// organization together with the permission names it should receive.
type defaultRole struct {
	Name        string
	Description string
	IsSystem    bool
	Permissions []string
}

// corePermissions is the CORE_PERMISSIONS catalog of packages/config, in
// declaration order. The admin role grants every Permission row that exists,
// but this list still drives its bootstrapWarnings.
var corePermissions = []string{
	"org.read",
	"org.write",
	"settings.manage",
	"users.read",
	"users.write",
	"roles.read",
	"roles.write",
	"permissions.read",
	"permissions.write",
	"items.read",
	"items.write",
	"dashboards.read",
	"dashboards.write",
	"knowledgegraph.review",
	"alerts.read",
	"alerts.manage",
	"metrics.read",
	"analysis.read",
	"analysis.write",
	"analysis.run",
	"assistant.read",
	"assistant.run",
	"queue.manage",
	"crawl.read",
	"crawl.write",
	"economicdata.read",
	"economicdata.manage",
	"akshare.fetch",
}

// defaultRoles mirrors DEFAULT_ROLES in packages/config/src/rbac.ts: three
// system roles per organization, created in this order.
var defaultRoles = []defaultRole{
	{
		Name:        "admin",
		Description: "Manage workspace access, system settings, data operations, and review flows.",
		IsSystem:    true,
		Permissions: corePermissions,
	},
	{
		Name:        "manager",
		Description: "Manage members, content, and operational workflows without full system settings access.",
		IsSystem:    true,
		Permissions: []string{
			"org.read",
			"users.read",
			"users.write",
			"roles.read",
			"permissions.read",
			"items.read",
			"items.write",
			"dashboards.read",
			"dashboards.write",
			"alerts.read",
			"alerts.manage",
			"analysis.read",
			"analysis.write",
			"analysis.run",
			"assistant.read",
			"assistant.run",
			"queue.manage",
			"crawl.read",
			"crawl.write",
			"economicdata.read",
			"akshare.fetch",
		},
	},
	{
		Name:        "analyst",
		Description: "View workspace data, dashboards, alerts, and analysis tools without write access.",
		IsSystem:    true,
		Permissions: []string{
			"org.read",
			"users.read",
			"roles.read",
			"items.read",
			"dashboards.read",
			"alerts.read",
			"analysis.read",
			"analysis.write",
			"assistant.read",
			"crawl.read",
			"economicdata.read",
		},
	},
}

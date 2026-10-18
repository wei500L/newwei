package workspacewrite

import (
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// service holds the MySQL handle shared by the eight workspace mutations.
type service struct {
	db *sql.DB
}

// Register adds the eight workspace mutations and their root permissions.
//
// It registers no object type on purpose: the mutation results project the
// shared workspace, alert and history models, whose registration (and
// field-level permissions) must happen exactly once. The caller therefore
// registers those model sets through workspace.RegisterModels,
// alerts.RegisterModels and history.RegisterModels whenever the matching read
// registration did not already do it, and then calls Register here.
func Register(reg *contract.Registry, db *sql.DB) {
	if reg == nil {
		panic("graphqlread: workspacewrite.Register requires a registry")
	}
	svc := &service{db: db}
	reg.RegisterMutation(contract.Root{
		Name:               "markNotificationRead",
		AllowAuthenticated: true,
		Resolve:            contract.Bind(svc.markNotificationReadResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:               "markAllNotificationsRead",
		AllowAuthenticated: true,
		Resolve:            contract.Bind(svc.markAllNotificationsReadResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "upsertDashboard",
		Permission: "dashboards.write",
		Resolve:    contract.Bind(svc.upsertDashboardResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "deleteDashboard",
		Permission: "dashboards.write",
		Resolve:    contract.Bind(svc.deleteDashboardResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "createAlertChannel",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.createAlertChannelResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "updateAlertChannel",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.updateAlertChannelResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "deleteAlertChannel",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.deleteAlertChannelResolver),
	})
	reg.RegisterMutation(contract.Root{
		Name:       "updateAlertEventStatus",
		Permission: "alerts.manage",
		Resolve:    contract.Bind(svc.updateAlertEventStatusResolver),
	})
}

// RegisteredMutations lists the mutation names Register adds. The startup log
// and the migration tests use it.
var RegisteredMutations = []string{
	"markNotificationRead",
	"markAllNotificationsRead",
	"upsertDashboard",
	"deleteDashboard",
	"createAlertChannel",
	"updateAlertChannel",
	"deleteAlertChannel",
	"updateAlertEventStatus",
}

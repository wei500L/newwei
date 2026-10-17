package newsindicators

import (
	"database/sql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register wires the two news-indicator Query roots and their object types.
// It must run after economic.Register so the nested EconomicDataItemModel type
// is already registered.
func Register(reg *contract.Registry, db *sql.DB) {
	if reg == nil {
		panic("graphqlread: newsindicators.Register requires a registry")
	}
	reg.RegisterType("NewsIndicatorAssociationModel", NewsIndicatorAssociationModel{})
	reg.RegisterType("NewsIndicatorAssociationBacktestRunModel", NewsIndicatorAssociationBacktestRunModel{})

	reader := &reader{db: db}
	reg.RegisterRoot(contract.Root{
		Name:       "newsIndicatorAssociations",
		Permission: "dashboards.read",
		Resolve:    reader.list,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsIndicatorAssociation",
		Permission: "dashboards.read",
		Resolve:    reader.detail,
	})
}

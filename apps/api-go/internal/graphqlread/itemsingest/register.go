// Package itemsingestgraphql registers the five items/crawl write mutations
// and their return models. It shares the read-side ItemModel projection and the
// settingscrawl CrawlTask model, and never registers a read root.
package itemsingestgraphql

import (
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	itemsgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

type resolver struct {
	svc   *itemsingest.Service
	items *itemsdomain.Service
}

// Register adds the five write mutations. Every root uses AllowAuthenticated
// plus an explicit NestJS-order permission check, so an ALL requirement keeps
// its required/missingPermissions shape instead of being downgraded to any.
func Register(reg *contract.Registry, svc *itemsingest.Service, itemRead *itemsdomain.Service) {
	if reg == nil {
		panic("graphqlread: itemsingest.Register requires a registry")
	}
	itemsgraphql.RegisterWriteModelTypes(reg)
	settingscrawl.RegisterCrawlTaskModelTypes(reg)
	reg.RegisterType("CrawlIngestBatchModel", CrawlIngestBatchModel{})

	instance := &resolver{svc: svc, items: itemRead}
	reg.RegisterMutation(contract.Root{Name: "createItem", AllowAuthenticated: true, Resolve: contract.Bind(instance.createItem)})
	reg.RegisterMutation(contract.Root{Name: "updateItem", AllowAuthenticated: true, Resolve: contract.Bind(instance.updateItem)})
	reg.RegisterMutation(contract.Root{Name: "createItemFromCrawlResult", AllowAuthenticated: true, Resolve: contract.Bind(instance.createItemFromCrawlResult)})
	reg.RegisterMutation(contract.Root{Name: "ingestCrawlTaskResultsToItems", AllowAuthenticated: true, Resolve: contract.Bind(instance.ingestCrawlTaskResultsToItems)})
	reg.RegisterMutation(contract.Root{Name: "updateCrawlTaskIngestToItems", AllowAuthenticated: true, Resolve: contract.Bind(instance.updateCrawlTaskIngestToItems)})
}

// RegisteredMutations is the diagnostic list printed at startup.
var RegisteredMutations = []string{
	"createItem",
	"updateItem",
	"createItemFromCrawlResult",
	"ingestCrawlTaskResultsToItems",
	"updateCrawlTaskIngestToItems",
}

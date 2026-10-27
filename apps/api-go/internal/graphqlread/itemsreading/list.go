package itemsreading

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// RegisterList adds the items connection root. It must be called after Register
// so the ItemModel and shared processed-item types already exist. PageInfo is
// registered only when no other package owns it, because the registry maps a
// type name to exactly one projection struct; the already registered types are
// never overwritten.
func RegisterList(reg *contract.Registry, svc *itemsdomain.Service) {
	if reg == nil {
		panic("graphqlread: itemsreading.RegisterList requires a registry")
	}
	reg.RegisterType("ItemConnection", ItemConnectionModel{})
	reg.RegisterType("ItemEdge", ItemEdgeModel{})
	if !reg.HasType("PageInfo") {
		reg.RegisterType("PageInfo", settingscrawl.PageInfo{})
	}
	instance := &resolver{svc: svc}
	reg.RegisterRoot(contract.Root{Name: "items", Permission: itemsdomain.ReadPermission, Resolve: contract.Bind(instance.items)})
}

// items resolves the items connection root.
//
// The resolver owns only the argument contract: the mutual-exclusion check, the
// ranking-mode default taken from the raw search argument (before the
// historical payload is decoded), and the presence of the filters object. The
// data path lives in ItemsListService.ListItems.
func (r *resolver) items(ctx contract.Context) (ItemConnectionModel, error) {
	orgID := strings.TrimSpace(ctx.Identity.OrgID)
	if orgID == "" {
		// The GraphQL items root answers the missing-requester case with the
		// NestJS BadRequestException("Unauthenticated"), not a 401.
		return ItemConnectionModel{}, &contract.Failure{Message: "Unauthenticated", Status: http.StatusBadRequest}
	}

	first := 10
	if value, ok := contract.IntArg(ctx.Args, "first"); ok {
		first = value
	} else if _, state := contract.Lookup(ctx.Args, "first"); state == contract.ArgValue {
		return ItemConnectionModel{}, &contract.Failure{Message: "Bad Request", Status: http.StatusBadRequest}
	}
	if first < 1 {
		// Mirrors the DTO @Min(1) validation that runs before the resolver.
		return ItemConnectionModel{}, &contract.Failure{Message: "Bad Request", Status: http.StatusBadRequest}
	}

	var page *int
	if value, ok := contract.IntArg(ctx.Args, "page"); ok {
		if value < 1 {
			return ItemConnectionModel{}, &contract.Failure{Message: "Bad Request", Status: http.StatusBadRequest}
		}
		page = &value
	}
	var after *string
	if value, ok := contract.StringArg(ctx.Args, "after"); ok && strings.TrimSpace(value) != "" {
		after = &value
	}
	// The mutual-exclusion check mirrors `if (args.after && args.page)`: only a
	// non-blank cursor and a present page conflict, not an empty cursor or a
	// null page.
	if after != nil && page != nil {
		return ItemConnectionModel{}, &contract.Failure{
			Message: "Use either 'after' cursor or 'page' pagination, not both.",
			Status:  http.StatusBadRequest,
		}
	}

	var search *string
	if value, ok := contract.StringArg(ctx.Args, "search"); ok {
		search = &value
	}
	rankingMode := ""
	if value, ok := contract.StringArg(ctx.Args, "rankingMode"); ok {
		rankingMode = value
	}
	if rankingMode == "" {
		// The default is picked from the raw search argument so a historical
		// filters payload that carries no query term still ranks by recency.
		if strings.TrimSpace(derefSearch(search)) != "" {
			rankingMode = string(itemsdomain.ItemsRankingRelevance)
		} else {
			rankingMode = string(itemsdomain.ItemsRankingRecency)
		}
	}
	orderBy := string(itemsdomain.ItemsListOrderCreatedDesc)
	if value, ok := contract.StringArg(ctx.Args, "orderBy"); ok && strings.TrimSpace(value) != "" {
		orderBy = value
	}

	filtersPresent := false
	if _, ok := contract.MapArg(ctx.Args, "filters"); ok {
		filtersPresent = true
	}

	query := itemsdomain.ItemsListQuery{
		First:             first,
		After:             after,
		Page:              page,
		Search:            search,
		Filters:           r.decodeFilters(ctx),
		FiltersPresent:    filtersPresent,
		OrderBy:           itemsdomain.ItemsListOrderBy(orderBy),
		RankingMode:       itemsdomain.ItemsRankingMode(rankingMode),
		IncludeTotalCount: ctx.Selection.Has("totalCount"),
	}
	result, err := r.svc.ListItems(ctx.Ctx, orgID, ctx.Identity.UserID, query)
	if err != nil {
		return ItemConnectionModel{}, internalFailure(err)
	}

	rows := make([]itemsdomain.ItemMetaRow, 0, len(result.Edges))
	for _, edge := range result.Edges {
		rows = append(rows, edge.Row)
	}
	nodeSelection := ctx.Selection.Child("edges")
	models, err := r.buildItemModels(ctx, orgID, rows, itemNeedsFromSelection(nodeSelection.Child("node")))
	if err != nil {
		return ItemConnectionModel{}, err
	}

	edges := make([]ItemEdgeModel, 0, len(result.Edges))
	for _, edge := range result.Edges {
		model, ok := models[edge.Row.ID]
		if !ok {
			continue
		}
		if edge.RelevanceScore != nil {
			model.RelevanceScore = edge.RelevanceScore
		}
		if edge.SearchHighlights != nil {
			model.SearchHighlights = convertHighlights(edge.SearchHighlights)
		}
		edges = append(edges, ItemEdgeModel{Cursor: edge.Cursor, Node: *model})
	}
	return ItemConnectionModel{
		Edges:      edges,
		PageInfo:   settingscrawl.PageInfo{HasNextPage: result.HasNextPage, EndCursor: result.EndCursor},
		TotalCount: result.TotalCount,
	}, nil
}

// convertHighlights projects the domain highlight slice onto the GraphQL list.
//
// The order is preserved verbatim: NestJS renders Object.entries(hit.highlight),
// so the Elasticsearch member order is the wire order. Ranging over a map here
// would make the same response come back in a different order on every request.
func convertHighlights(raw []itemsdomain.ItemSearchHighlight) []ItemSearchHighlightModel {
	out := make([]ItemSearchHighlightModel, 0, len(raw))
	for _, highlight := range raw {
		if len(highlight.Snippets) == 0 {
			continue
		}
		snippets := make([]string, len(highlight.Snippets))
		copy(snippets, highlight.Snippets)
		out = append(out, ItemSearchHighlightModel{Field: highlight.Field, Snippets: snippets})
	}
	return out
}

// derefSearch unwraps the optional search argument.
func derefSearch(search *string) string {
	if search == nil {
		return ""
	}
	return *search
}

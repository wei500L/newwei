package itemsreading

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// itemFacets resolves itemFacets(search, filters). The filters input is decoded
// at the executor boundary and immediately converted into the domain type.
func (r *resolver) itemFacets(ctx contract.Context) (ItemFacetsModel, error) {
	orgID, err := r.requireOrgID(ctx)
	if err != nil {
		return ItemFacetsModel{}, err
	}
	search, _ := contract.StringArg(ctx.Args, "search")
	facets, err := r.svc.Facets(ctx.Ctx, orgID, search, r.decodeFilters(ctx))
	if err != nil {
		return ItemFacetsModel{}, internalFailure(err)
	}
	return ItemFacetsModel{
		ContentTypes: convertFacetOptions(facets.ContentTypes),
		Regions:      convertFacetOptions(facets.Regions),
		Sentiments:   convertFacetOptions(facets.Sentiments),
		Topics:       convertFacetOptions(facets.Topics),
	}, nil
}

// convertFacetOptions converts one facet group, keeping empty groups as [].
func convertFacetOptions(options []itemsdomain.FacetOption) []ItemFacetOption {
	out := make([]ItemFacetOption, 0, len(options))
	for _, option := range options {
		out = append(out, ItemFacetOption{Count: option.Count, Value: option.Value})
	}
	return out
}

// rssSources resolves rssSources(windowDays, onlyWithItems). An omitted
// onlyWithItems stays nil so the domain applies the true default, while an
// explicit false is preserved.
func (r *resolver) rssSources(ctx contract.Context) ([]RssSourceOptionModel, error) {
	orgID, err := r.requireOrgID(ctx)
	if err != nil {
		return nil, err
	}
	var windowDays *int
	if value, ok := contract.IntArg(ctx.Args, "windowDays"); ok {
		windowDays = &value
	}
	var onlyWithItems *bool
	if value, state := contract.Lookup(ctx.Args, "onlyWithItems"); state == contract.ArgValue {
		if boolean, ok := value.(bool); ok {
			onlyWithItems = &boolean
		}
	}
	options, err := r.svc.RssSources(ctx.Ctx, orgID, windowDays, onlyWithItems)
	if err != nil {
		return nil, internalFailure(err)
	}
	out := make([]RssSourceOptionModel, 0, len(options))
	for _, option := range options {
		out = append(out, RssSourceOptionModel{
			FeedURL:         option.FeedURL,
			ID:              option.ID,
			ItemCountWindow: option.ItemCountWindow,
			Language:        option.Language,
			LatestItemAt:    option.LatestItemAt,
			Name:            option.Name,
			SiteURL:         option.SiteURL,
		})
	}
	return out, nil
}

// rssTranslationStatus resolves rssTranslationStatus(targetLanguage). The
// element order is always deeplx then llm; the domain computation only reports
// configuration availability.
func (r *resolver) rssTranslationStatus(ctx contract.Context) ([]RssTranslationProviderStatusModel, error) {
	if _, err := r.requireOrgID(ctx); err != nil {
		return nil, err
	}
	var targetLanguage *string
	if value, ok := contract.StringArg(ctx.Args, "targetLanguage"); ok {
		targetLanguage = &value
	}
	statuses, err := r.svc.RssTranslationStatus(ctx.Ctx, targetLanguage)
	if err != nil {
		return nil, internalFailure(err)
	}
	out := make([]RssTranslationProviderStatusModel, 0, len(statuses))
	for _, status := range statuses {
		out = append(out, RssTranslationProviderStatusModel{
			Available:               status.Available,
			Message:                 status.Message,
			Provider:                status.Provider,
			TargetLanguageSupported: status.TargetLanguageSupported,
		})
	}
	return out, nil
}

// searchSuggestions resolves searchSuggestions(prefix, limit). The SDL type of
// limit is Float, so a fractional value keeps its fractional form for the cache
// key while the slice truncates.
func (r *resolver) searchSuggestions(ctx contract.Context) ([]SearchSuggestionModel, error) {
	orgID, err := r.requireOrgID(ctx)
	if err != nil {
		return nil, err
	}
	prefix, _ := contract.StringArg(ctx.Args, "prefix")
	var limit *float64
	if value, state := contract.Lookup(ctx.Args, "limit"); state == contract.ArgValue {
		if number, ok := contract.AsFloat(value); ok {
			limit = &number
		}
	}
	suggestions, err := r.svc.SearchSuggestions(ctx.Ctx, orgID, prefix, limit)
	if err != nil {
		return nil, internalFailure(err)
	}
	out := make([]SearchSuggestionModel, 0, len(suggestions))
	for _, suggestion := range suggestions {
		out = append(out, SearchSuggestionModel{
			Origin: suggestion.Origin,
			Type:   suggestion.Type,
			Value:  suggestion.Value,
		})
	}
	return out, nil
}

// permissionFailure is a small helper for guard-style failures.
func permissionFailure(message string) *contract.Failure {
	return &contract.Failure{Message: strings.TrimSpace(message), Status: http.StatusForbidden}
}

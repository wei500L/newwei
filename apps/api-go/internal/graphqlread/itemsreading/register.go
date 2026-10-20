package itemsreading

import (
	"errors"
	"log"
	"net/http"
	"reflect"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// resolver owns the migrated items roots.
type resolver struct {
	svc *itemsdomain.Service
}

// Register adds the five item reading roots, the object types they project, and
// the nested types the item projection needs. workspaceRegistered reports
// whether the workspace package already registered the three shared
// processed-item types, in which case they are reused as-is instead of being
// registered twice.
//
// The items connection root is registered separately by RegisterList, which is
// gated on its own sub-switch.
func Register(reg *contract.Registry, svc *itemsdomain.Service, workspaceRegistered bool) {
	if reg == nil {
		panic("graphqlread: itemsreading.Register requires a registry")
	}
	reg.RegisterType("ItemModel", ItemModel{})
	reg.RegisterType("ItemMetaModel", ItemMetaModel{})
	reg.RegisterType("RawItemModelGraph", RawItemModelGraph{})
	reg.RegisterType("RawItemPreviewModelGraph", RawItemPreviewModelGraph{})
	reg.RegisterType("ProcessedItemPreviewModelGraph", ProcessedItemPreviewModelGraph{})
	reg.RegisterType("ItemFacets", ItemFacetsModel{})
	reg.RegisterType("ItemFacetOption", ItemFacetOption{})
	reg.RegisterType("SeriesPointModel", SeriesPointModel{})
	reg.RegisterType("ItemSearchHighlightModel", ItemSearchHighlightModel{})
	reg.RegisterType("RssSourceOptionModel", RssSourceOptionModel{})
	reg.RegisterType("RssTranslationProviderStatusModel", RssTranslationProviderStatusModel{})
	reg.RegisterType("SearchSuggestionModel", SearchSuggestionModel{})
	registerItemFieldPermissions(reg)
	if !workspaceRegistered {
		// The workspace package registers these three when its own switch is
		// go. Registering the identical exported structs again is harmless
		// (RegisterType overwrites the projection), but skipping keeps exactly
		// one owner per type name when both batches are enabled.
		reg.RegisterType("ProcessedItemErrorModelGraph", workspace.ProcessedItemErrorModelGraph{})
		reg.RegisterType("ProcessedItemLlmModel", workspace.ProcessedItemLlmModel{})
		reg.RegisterType("ProcessedItemModelGraph", workspace.ProcessedItemModelGraph{})
	}

	instance := &resolver{svc: svc}
	reg.RegisterRoot(contract.Root{Name: "item", Permission: itemsdomain.ReadPermission, Resolve: contract.Bind(instance.item)})
	reg.RegisterRoot(contract.Root{Name: "itemFacets", Permission: itemsdomain.ReadPermission, Resolve: contract.Bind(instance.itemFacets)})
	reg.RegisterRoot(contract.Root{Name: "rssSources", Permission: itemsdomain.ReadPermission, Resolve: contract.Bind(instance.rssSources)})
	reg.RegisterRoot(contract.Root{Name: "rssTranslationStatus", Permission: itemsdomain.ReadPermission, Resolve: contract.Bind(instance.rssTranslationStatus)})
	reg.RegisterRoot(contract.Root{Name: "searchSuggestions", Permission: itemsdomain.ReadPermission, Resolve: contract.Bind(instance.searchSuggestions)})
}

// requireOrgID derives the tenant binding from the authenticated identity.
func (r *resolver) requireOrgID(ctx contract.Context) (string, error) {
	orgID := strings.TrimSpace(ctx.Identity.OrgID)
	if orgID == "" {
		return "", &contract.Failure{Message: "Unauthorized", Status: http.StatusUnauthorized}
	}
	return orgID, nil
}

// item resolves the nullable item(id: String!) root. A miss resolves to null
// without a GraphQL error, matching the NestJS contract.
func (r *resolver) item(ctx contract.Context) (*ItemModel, error) {
	orgID, err := r.requireOrgID(ctx)
	if err != nil {
		return nil, err
	}
	identifier, ok := contract.StringArg(ctx.Args, "id")
	if !ok {
		return nil, &contract.Failure{Message: "Unauthenticated", Status: http.StatusBadRequest}
	}
	meta, err := r.svc.ItemMetaOrNull(ctx.Ctx, orgID, identifier)
	if err != nil {
		return nil, internalFailure(err)
	}
	if meta == nil {
		return nil, nil
	}
	models, err := r.buildItemModels(ctx, orgID, []itemsdomain.ItemMetaRow{*meta}, itemNeedsFromSelection(ctx.Selection))
	if err != nil {
		return nil, err
	}
	model, ok := models[meta.ID]
	if !ok {
		return nil, nil
	}
	return model, nil
}

// buildRawPreviewModel converts the domain preview projection into the GraphQL
// object. The object is always returned when a raw document exists; individual
// fields stay null, exactly like the NestJS resolver.
func buildRawPreviewModel(preview itemsdomain.RawPreview) *RawItemPreviewModelGraph {
	model := &RawItemPreviewModelGraph{
		ChangePercent: preview.ChangePercent,
		Location:      optionalString(preview.Location),
		Price:         preview.Price,
		Region:        optionalString(preview.Region),
		Sentiment:     optionalString(preview.Sentiment),
		SourceName:    optionalString(preview.SourceName),
		Summary:       optionalString(preview.Summary),
		Thumbnail:     optionalString(preview.Thumbnail),
		Ticker:        optionalString(preview.Ticker),
		URL:           optionalString(preview.URL),
	}
	if len(preview.History) > 0 {
		model.History = make([]SeriesPointModel, 0, len(preview.History))
		for _, point := range preview.History {
			model.History = append(model.History, SeriesPointModel{Timestamp: point.Timestamp, Value: point.Value})
		}
	}
	return model
}

// optionalString returns nil for an empty string.
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	copied := value
	return &copied
}

// convertLlm maps the stored llm document onto the reused workspace model.
func convertLlm(source *itemsdomain.ProcessedItemLlmDoc) *workspace.ProcessedItemLlmModel {
	if source == nil {
		return nil
	}
	return &workspace.ProcessedItemLlmModel{
		CompletionTokens: source.CompletionTokens,
		CostUSD:          source.CostUSD,
		LatencyMs:        source.LatencyMs,
		Model:            source.Model,
		PromptTokens:     source.PromptTokens,
		PromptVersion:    source.PromptVersion,
		TotalTokens:      source.TotalTokens,
	}
}

// convertError maps the stored error document onto the GraphQL object.
func convertError(source *itemsdomain.ProcessedItemErrorDoc) *workspace.ProcessedItemErrorModelGraph {
	if source == nil {
		return nil
	}
	return &workspace.ProcessedItemErrorModelGraph{Message: source.Message, Name: source.Name}
}

// nonNil returns the first non-empty list, otherwise an empty non-nil list so a
// non-null GraphQL list projects as [].
func nonNil(primary, secondary []string) []string {
	if len(primary) > 0 {
		return primary
	}
	if len(secondary) > 0 {
		return secondary
	}
	return []string{}
}

// firstOptional returns the first non-empty optional string.
func firstOptional(values ...*string) *string {
	for _, value := range values {
		if value != nil && strings.TrimSpace(*value) != "" {
			return value
		}
	}
	return nil
}

// firstOptionalFloat returns the first non-nil float pointer.
func firstOptionalFloat(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// internalFailure maps an unexpected error to the GraphQL failure contract. The
// two typed external-boundary failures keep their appCode and safe detail; a
// plain error becomes a masked 500 with a server-side log line.
func internalFailure(err error) error {
	if err == nil {
		return nil
	}
	var failure *contract.Failure
	if errors.As(err, &failure) {
		return failure
	}
	var vectorError *itemsdomain.ItemVectorUnavailableError
	if errors.As(err, &vectorError) {
		return &contract.Failure{
			Message: vectorError.Message,
			Status:  http.StatusServiceUnavailable,
			AppCode: "VECTOR_SEARCH_UNAVAILABLE",
		}
	}
	var rerankError *itemsdomain.RerankUnavailableError
	if errors.As(err, &rerankError) {
		return &contract.Failure{
			Message: rerankError.Error(),
			Status:  http.StatusServiceUnavailable,
			AppCode: "RERANK_UNAVAILABLE",
			Detail:  rerankError.Detail,
		}
	}
	// Server-side diagnostics only: the GraphQL response keeps the generic
	// message, exactly like NestJS, but the operator can see the cause in the
	// container log.
	log.Printf("api-go: itemsreading graphql failure: %v", err)
	return &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
}

// decodeFilters decodes the ItemsFiltersInput argument at the executor
// boundary. contract.MapArg hands input objects through as an untyped value;
// reflect is used so the adapter never names an untyped Go type, and the result
// is immediately converted into the domain's typed filter struct.
func (r *resolver) decodeFilters(ctx contract.Context) *itemsdomain.ItemFilters {
	record, ok := contract.MapArg(ctx.Args, "filters")
	if !ok {
		return nil
	}
	filters := &itemsdomain.ItemFilters{}
	if value, exists := record["sourceIds"]; exists {
		filters.SourceIDs = stringListValue(reflect.ValueOf(value))
	}
	if value, exists := record["regions"]; exists {
		filters.Regions = stringListValue(reflect.ValueOf(value))
	}
	if value, exists := record["topics"]; exists {
		filters.Topics = stringListValue(reflect.ValueOf(value))
	}
	if value, exists := record["sentiments"]; exists {
		filters.Sentiments = stringListValue(reflect.ValueOf(value))
	}
	if value, exists := record["contentTypes"]; exists {
		filters.ContentTypes = stringListValue(reflect.ValueOf(value))
	}
	if value, exists := record["excludeDuplicates"]; exists {
		if boolean, ok := boolValue(reflect.ValueOf(value)); ok {
			filters.ExcludeDuplicates = boolean
		}
	}
	if dateRange, ok := contract.MapArg(record, "dateRange"); ok {
		rangeFilter := &itemsdomain.ItemDateRangeFilter{}
		if value, exists := dateRange["start"]; exists {
			if text, ok := textValue(reflect.ValueOf(value)); ok {
				if parsed, ok := itemsdomain.ParseTimeValue(text); ok {
					rangeFilter.Start = &parsed
				}
			}
		}
		if value, exists := dateRange["end"]; exists {
			if text, ok := textValue(reflect.ValueOf(value)); ok {
				if parsed, ok := itemsdomain.ParseTimeValue(text); ok {
					rangeFilter.End = &parsed
				}
			}
		}
		if rangeFilter.Start != nil || rangeFilter.End != nil {
			filters.DateRange = rangeFilter
		}
	}
	if !filters.Active() {
		return nil
	}
	return filters
}

// stringListValue decodes a GraphQL list value.
func stringListValue(value reflect.Value) []string {
	if !value.IsValid() {
		return nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Slice && value.Kind() != reflect.Array {
		return nil
	}
	out := make([]string, 0, value.Len())
	for index := 0; index < value.Len(); index++ {
		element := value.Index(index)
		if element.Kind() == reflect.Interface {
			if element.IsNil() {
				continue
			}
			element = element.Elem()
		}
		if element.Kind() == reflect.String {
			out = append(out, element.String())
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// boolValue decodes a GraphQL Boolean value.
func boolValue(value reflect.Value) (bool, bool) {
	if !value.IsValid() {
		return false, false
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return false, false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Bool {
		return false, false
	}
	return value.Bool(), true
}

// textValue decodes a GraphQL String/DateTime value.
func textValue(value reflect.Value) (string, bool) {
	if !value.IsValid() {
		return "", false
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return "", false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.String {
		return "", false
	}
	return value.String(), true
}

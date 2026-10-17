package itemsreading

import (
	"net/http"
	"reflect"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// resolver owns the five migrated roots.
type resolver struct {
	svc *itemsdomain.Service
}

// Register adds the five read roots, the object types they project, and the
// nested types the item projection needs. workspaceRegistered reports whether
// the workspace package already registered the three shared processed-item
// types, in which case they are reused as-is instead of being registered twice.
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

	model := &ItemModel{
		CreatedAt:  meta.CreatedAt.Time,
		ID:         meta.ID,
		IngestedAt: meta.CreatedAt.Time,
		OrgID:      meta.OrgID,
		Status:     meta.Status,
		Title:      meta.Name,
		UpdatedAt:  meta.UpdatedAt.Time,
	}
	if meta.PublishedAt != nil {
		formatted := itemsdomain.FormatISOTime(meta.PublishedAt.Time)
		model.PublishedAt = &formatted
	}

	var readModelMeta *itemsdomain.ReadModelDocument
	var readModelRaw *itemsdomain.ReadModelDocument
	var readModelRawPreview *itemsdomain.ReadModelDocument
	var readModelProcessed *itemsdomain.ReadModelDocument
	var readModelProcessedPreview *itemsdomain.ReadModelDocument
	if r.svc.ReadModelEnabled() {
		readModelMeta, err = r.svc.ReadModelProjection(ctx.Ctx, orgID, meta.ID, itemsdomain.ReadModelProjections.Meta)
		if err != nil {
			return nil, internalFailure(err)
		}
		readModelRaw, err = r.svc.ReadModelProjection(ctx.Ctx, orgID, meta.ID, itemsdomain.ReadModelProjections.Raw)
		if err != nil {
			return nil, internalFailure(err)
		}
		readModelRawPreview, err = r.svc.ReadModelProjection(ctx.Ctx, orgID, meta.ID, itemsdomain.ReadModelProjections.RawPreview)
		if err != nil {
			return nil, internalFailure(err)
		}
		readModelProcessed, err = r.svc.ReadModelProjection(ctx.Ctx, orgID, meta.ID, itemsdomain.ReadModelProjections.Processed)
		if err != nil {
			return nil, internalFailure(err)
		}
		readModelProcessedPreview, err = r.svc.ReadModelProjection(ctx.Ctx, orgID, meta.ID, itemsdomain.ReadModelProjections.ProcessedPreview)
		if err != nil {
			return nil, internalFailure(err)
		}
	}

	mongoRaw, err := r.svc.RawItemBound(ctx.Ctx, meta.ID, meta.MongoRef)
	if err != nil {
		return nil, internalFailure(err)
	}
	mongoProcessedByItem, err := r.svc.ProcessedByKeys(ctx.Ctx, orgID, []string{meta.ID}, true)
	if err != nil {
		return nil, internalFailure(err)
	}
	mongoProcessed, hasMongoProcessed := mongoProcessedByItem[meta.ID]

	// meta (non-null). The read-model snapshot wins when present; otherwise the
	// organization-scoped MySQL row is authoritative, because the item root was
	// already resolved through it.
	if readModelMeta != nil && strings.TrimSpace(readModelMeta.Meta.ID) != "" {
		model.Meta = ItemMetaModel{
			CreatedAt:  readModelMeta.Meta.CreatedAt.Time,
			ExternalID: readModelMeta.Meta.ExternalID,
			ID:         readModelMeta.Meta.ID,
			MongoRef:   readModelMeta.Meta.MongoRef,
			Name:       readModelMeta.Meta.Name,
			Status:     readModelMeta.Meta.Status,
			UpdatedAt:  readModelMeta.Meta.UpdatedAt.Time,
		}
	} else {
		model.Meta = ItemMetaModel{
			CreatedAt:  meta.CreatedAt.Time,
			ExternalID: meta.ExternalID,
			ID:         meta.ID,
			MongoRef:   meta.MongoRef,
			Name:       meta.Name,
			Status:     meta.Status,
			UpdatedAt:  meta.UpdatedAt.Time,
		}
	}

	// raw
	if readModelRaw != nil && readModelRaw.Raw != nil {
		model.Raw = &RawItemModelGraph{
			CreatedAt:  readModelRaw.Raw.CreatedAt.Time,
			ID:         readModelRaw.Raw.ID,
			ItemMetaID: readModelRaw.Raw.ItemMetaID,
			Payload:    string(readModelRaw.Raw.Payload.Bytes()),
			Source:     readModelRaw.Raw.Source,
			UpdatedAt:  readModelRaw.Raw.UpdatedAt.Time,
		}
	} else if mongoRaw != nil {
		payload := "null"
		if mongoRaw.Payload.Valid() {
			payload = string(mongoRaw.Payload.Bytes())
		}
		model.Raw = &RawItemModelGraph{
			CreatedAt:  mongoRaw.CreatedAt.Time,
			ID:         mongoRaw.HexID(),
			ItemMetaID: mongoRaw.ItemMetaID,
			Payload:    payload,
			Source:     mongoRaw.Source,
			UpdatedAt:  mongoRaw.UpdatedAt.Time,
		}
	}

	// rawPreview
	if readModelRawPreview != nil && readModelRawPreview.Raw != nil {
		model.RawPreview = buildRawPreviewModel(itemsdomain.ExtractRawPreviewReadModel(readModelRawPreview.Raw.Payload))
	} else if mongoRaw != nil {
		model.RawPreview = buildRawPreviewModel(itemsdomain.ExtractRawPreviewMongo(mongoRaw.Payload))
	}

	// processed
	if readModelProcessed != nil && readModelProcessed.Processed != nil {
		graph, err := r.buildReadModelProcessedGraph(ctx, orgID, readModelProcessed.Processed)
		if err != nil {
			return nil, internalFailure(err)
		}
		model.Processed = graph
	} else if hasMongoProcessed {
		graph, err := r.buildMongoProcessedGraph(ctx, orgID, mongoProcessed)
		if err != nil {
			return nil, internalFailure(err)
		}
		model.Processed = graph
	}

	// processedPreview
	if readModelProcessedPreview != nil && readModelProcessedPreview.Processed != nil {
		model.ProcessedPreview = r.buildReadModelProcessedPreviewGraph(ctx, orgID, readModelProcessedPreview)
	} else if hasMongoProcessed {
		model.ProcessedPreview = r.buildMongoProcessedPreviewGraph(ctx, orgID, mongoProcessed)
	}

	// publishedAt fallback chain: item value -> read model -> processed result
	// -> raw payload.
	if model.PublishedAt == nil && readModelMeta != nil && readModelMeta.PublishedAt != nil {
		formatted := itemsdomain.FormatISOTime(readModelMeta.PublishedAt.Time)
		model.PublishedAt = &formatted
	}
	if model.PublishedAt == nil {
		if readModelProcessed != nil && readModelProcessed.Processed != nil {
			model.PublishedAt = itemsdomain.ResolvePublishedFromResult(readModelProcessed.Processed.Result)
		} else if hasMongoProcessed {
			model.PublishedAt = itemsdomain.ResolvePublishedFromResult(mongoProcessed.Result)
		}
	}
	if model.PublishedAt == nil {
		if readModelRaw != nil && readModelRaw.Raw != nil {
			model.PublishedAt = itemsdomain.ResolvePublishedFromPayload(readModelRaw.Raw.Payload)
		} else if mongoRaw != nil {
			model.PublishedAt = itemsdomain.ResolvePublishedFromPayload(mongoRaw.Payload)
		}
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

// buildReadModelProcessedGraph converts a read-model processed snapshot.
func (r *resolver) buildReadModelProcessedGraph(
	ctx contract.Context,
	orgID string,
	processed *itemsdomain.ReadModelProcessedDoc,
) (*workspace.ProcessedItemModelGraph, error) {
	graph := &workspace.ProcessedItemModelGraph{
		CreatedAt:                  processed.CreatedAt.Time,
		DuplicateSimilarity:        processed.DuplicateSimilarity,
		Error:                      convertError(processed.Error),
		ID:                         processed.ID,
		ItemMetaID:                 processed.ItemMetaID,
		Llm:                        processed.Llm,
		Result:                     itemsdomain.ResultStringToken(processed.Result),
		ResultJSON:                 itemsdomain.ResultJSONPointer(processed.Result),
		Status:                     processed.Status,
		SummaryEmbeddingDimensions: processed.SummaryEmbeddingDimensions,
		SummaryEmbeddingModel:      processed.SummaryEmbeddingModel,
		Tags:                       processed.Tags,
	}
	if processed.DuplicateOf != nil {
		resolved, err := r.svc.ResolveDuplicateOfHex(ctx.Ctx, orgID, *processed.DuplicateOf)
		if err != nil {
			return nil, err
		}
		graph.DuplicateOf = resolved
	}
	eventID, err := r.svc.ResolveEventID(ctx.Ctx, orgID, processed.ID)
	if err != nil {
		return nil, err
	}
	graph.EventID = eventID
	return graph, nil
}

// buildMongoProcessedGraph converts a Mongo processed document.
func (r *resolver) buildMongoProcessedGraph(
	ctx contract.Context,
	orgID string,
	processed itemsdomain.ProcessedItemDoc,
) (*workspace.ProcessedItemModelGraph, error) {
	graph := &workspace.ProcessedItemModelGraph{
		CreatedAt:                  processed.CreatedAt.Time,
		DuplicateSimilarity:        processed.DuplicateSimilarity,
		Error:                      convertError(processed.Error),
		ID:                         processed.HexID(),
		ItemMetaID:                 processed.ItemMetaID,
		Llm:                        processed.Llm,
		Result:                     itemsdomain.ResultStringToken(processed.Result),
		ResultJSON:                 itemsdomain.ResultJSONPointer(processed.Result),
		Status:                     processed.Status,
		SummaryEmbeddingDimensions: processed.SummaryEmbeddingDimensions,
		SummaryEmbeddingModel:      processed.SummaryEmbeddingModel,
		Tags:                       processed.Tags,
	}
	if processed.DuplicateOf != nil && !processed.DuplicateOf.IsZero() {
		resolved, err := r.svc.ResolveDuplicateOfHex(ctx.Ctx, orgID, processed.DuplicateOf.Hex())
		if err != nil {
			return nil, err
		}
		graph.DuplicateOf = resolved
	}
	eventID, err := r.svc.ResolveEventID(ctx.Ctx, orgID, processed.HexID())
	if err != nil {
		return nil, err
	}
	graph.EventID = eventID
	return graph, nil
}

// convertError maps the stored error document onto the GraphQL object.
func convertError(source *itemsdomain.ProcessedItemErrorDoc) *workspace.ProcessedItemErrorModelGraph {
	if source == nil {
		return nil
	}
	return &workspace.ProcessedItemErrorModelGraph{Message: source.Message, Name: source.Name}
}

// buildReadModelProcessedPreviewGraph converts a read-model preview snapshot.
func (r *resolver) buildReadModelProcessedPreviewGraph(
	ctx contract.Context,
	orgID string,
	doc *itemsdomain.ReadModelDocument,
) *ProcessedItemPreviewModelGraph {
	processed := doc.Processed
	extracted := itemsdomain.ExtractProcessedResultFieldsReadModel(processed.Result)
	graph := &ProcessedItemPreviewModelGraph{
		CreatedAt:           processed.CreatedAt.Time,
		DuplicateSimilarity: processed.DuplicateSimilarity,
		ID:                  processed.ID,
		ItemMetaID:          processed.ItemMetaID,
		Llm:                 processed.Llm,
		Status:              processed.Status,
		Tags:                processed.Tags,
		Topics:              nonNil(extracted.Topics, doc.Topics),
		Entities:            nonNil(extracted.Entities, doc.Entities),
		Source:              firstOptional(extracted.Source, doc.SourceName),
		Title:               firstOptional(extracted.Title, doc.Title),
		Language:            firstOptional(extracted.Language, doc.Language),
		Sentiment:           firstOptional(extracted.Sentiment, doc.Sentiment),
		ContentType:         firstOptional(extracted.ContentType, doc.ContentType),
		QualityScore:        firstOptionalFloat(extracted.QualityScore, doc.QualityScore),
		Location:            firstOptional(extracted.Location, extracted.Region, doc.Location, doc.Region),
	}
	if extracted.PublishedAt != nil {
		graph.PublishedAt = extracted.PublishedAt
	} else if doc.PublishedAt != nil {
		formatted := itemsdomain.FormatISOTime(doc.PublishedAt.Time)
		graph.PublishedAt = &formatted
	}
	r.attachPreviewLinks(ctx, orgID, processed.ID, processed.DuplicateOf, graph)
	return graph
}

// buildMongoProcessedPreviewGraph converts a Mongo processed document using the
// resolver-side projection.
func (r *resolver) buildMongoProcessedPreviewGraph(
	ctx contract.Context,
	orgID string,
	processed itemsdomain.ProcessedItemDoc,
) *ProcessedItemPreviewModelGraph {
	extracted := itemsdomain.ExtractProcessedResultFieldsResolver(processed.Result)
	location := extracted.Location
	if location == "" {
		location = extracted.Region
	}
	graph := &ProcessedItemPreviewModelGraph{
		CreatedAt:           processed.CreatedAt.Time,
		DuplicateSimilarity: processed.DuplicateSimilarity,
		ID:                  processed.HexID(),
		ItemMetaID:          processed.ItemMetaID,
		Llm:                 processed.Llm,
		Status:              processed.Status,
		Tags:                processed.Tags,
		Topics:              nonNil(extracted.Topics, nil),
		Entities:            nonNil(extracted.Entities, nil),
		Source:              optionalString(extracted.Source),
		Title:               optionalString(extracted.Title),
		Language:            optionalString(extracted.Language),
		Sentiment:           optionalString(extracted.Sentiment),
		ContentType:         optionalString(extracted.ContentType),
		QualityScore:        extracted.QualityScore,
		Location:            optionalString(location),
		PublishedAt:         extracted.PublishedAt,
	}
	var duplicateOfHex *string
	if processed.DuplicateOf != nil && !processed.DuplicateOf.IsZero() {
		hex := processed.DuplicateOf.Hex()
		duplicateOfHex = &hex
	}
	r.attachPreviewLinks(ctx, orgID, processed.HexID(), duplicateOfHex, graph)
	return graph
}

// attachPreviewLinks resolves duplicateOf and eventId for a preview object.
func (r *resolver) attachPreviewLinks(
	ctx contract.Context,
	orgID string,
	processedID string,
	duplicateOfHex *string,
	graph *ProcessedItemPreviewModelGraph,
) {
	if duplicateOfHex != nil {
		if resolved, err := r.svc.ResolveDuplicateOfHex(ctx.Ctx, orgID, *duplicateOfHex); err == nil {
			graph.DuplicateOf = resolved
		}
	}
	if processedID != "" {
		if eventID, err := r.svc.ResolveEventID(ctx.Ctx, orgID, processedID); err == nil {
			graph.EventID = eventID
		}
	}
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

// internalFailure maps an unexpected error to a 500 GraphQL failure.
func internalFailure(err error) error {
	if err == nil {
		return nil
	}
	if failure, ok := err.(*contract.Failure); ok {
		return failure
	}
	var vectorError *itemsdomain.ItemVectorUnavailableError
	if asError(err, &vectorError) {
		return &contract.Failure{
			Message: vectorError.Message,
			Status:  http.StatusServiceUnavailable,
			AppCode: "VECTOR_SEARCH_UNAVAILABLE",
		}
	}
	return &contract.Failure{Message: "Internal server error", Status: http.StatusInternalServerError}
}

// asError is a tiny errors.As replacement that keeps the adapter free of extra
// imports.
func asError(err error, target **itemsdomain.ItemVectorUnavailableError) bool {
	for err != nil {
		if typed, ok := err.(*itemsdomain.ItemVectorUnavailableError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
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

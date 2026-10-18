package itemsreading

import (
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// itemProjectionNeeds is the resolved nested-field requirement of one query. It
// drives which read-model projections and Mongo collections a page loads, so an
// id-only selection never reads raw payloads or processed results.
type itemProjectionNeeds struct {
	raw              bool
	rawPreview       bool
	processed        bool
	processedResult  bool
	processedPreview bool
	publishedAt      bool
}

// itemNeedsFromSelection maps the resolved selection set of an ItemModel onto
// the projection requirement.
func itemNeedsFromSelection(selection *contract.FieldSet) itemProjectionNeeds {
	needs := itemProjectionNeeds{
		raw:              selection.Has("raw"),
		rawPreview:       selection.Has("rawPreview"),
		processed:        selection.Has("processed"),
		processedPreview: selection.Has("processedPreview"),
		publishedAt:      selection.Has("publishedAt"),
	}
	if processed := selection.Child("processed"); processed != nil {
		needs.processedResult = processed.Any("result", "resultJson")
	}
	return needs
}

// itemLinks holds the pre-resolved eventId / duplicateOf values of one page.
type itemLinks struct {
	eventIDByProcessedID map[string]*string
	duplicateByHex       map[string]*string
}

// buildItemModels assembles the ItemModel of every row in one pass. Every
// collection is read once for the whole page: the five read-model projections
// in read-model mode, or the batched raw/processed lookups otherwise, plus the
// two link batches. This replaces the per-edge item() call, which would issue a
// query per nested field.
func (r *resolver) buildItemModels(
	ctx contract.Context,
	orgID string,
	rows []itemsdomain.ItemMetaRow,
	needs itemProjectionNeeds,
) (map[string]*ItemModel, error) {
	out := make(map[string]*ItemModel, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}

	var (
		readModelMeta             map[string]itemsdomain.ReadModelDocument
		readModelRaw              map[string]itemsdomain.ReadModelDocument
		readModelRawPreview       map[string]itemsdomain.ReadModelDocument
		readModelProcessed        map[string]itemsdomain.ReadModelDocument
		readModelProcessedPreview map[string]itemsdomain.ReadModelDocument
		mongoRaw                  map[string]itemsdomain.RawItemDoc
		mongoProcessed            map[string]itemsdomain.ProcessedItemDoc
	)
	if r.svc.ReadModelEnabled() {
		var err error
		readModelMeta, err = r.svc.ReadModelProjectionBatch(ctx.Ctx, orgID, ids, itemsdomain.ReadModelProjections.Meta)
		if err != nil {
			return nil, internalFailure(err)
		}
		if needs.raw {
			readModelRaw, err = r.svc.ReadModelProjectionBatch(ctx.Ctx, orgID, ids, itemsdomain.ReadModelProjections.Raw)
			if err != nil {
				return nil, internalFailure(err)
			}
		}
		if needs.rawPreview || (needs.publishedAt && !needs.raw) {
			readModelRawPreview, err = r.svc.ReadModelProjectionBatch(ctx.Ctx, orgID, ids, itemsdomain.ReadModelProjections.RawPreview)
			if err != nil {
				return nil, internalFailure(err)
			}
		}
		// The full processed projection carries the result leaf, which the
		// publishedAt fallback chain reads. It is loaded when the caller
		// selected result/resultJson or publishedAt.
		if (needs.processed && needs.processedResult) || needs.publishedAt {
			readModelProcessed, err = r.svc.ReadModelProjectionBatch(ctx.Ctx, orgID, ids, itemsdomain.ReadModelProjections.Processed)
			if err != nil {
				return nil, internalFailure(err)
			}
		}
		// The processed-preview projection carries the scalar processed fields
		// plus the denormalized preview columns, so it serves both the preview
		// field and the processed field when result/resultJson was not selected.
		if needs.processedPreview || (needs.processed && !needs.processedResult) {
			readModelProcessedPreview, err = r.svc.ReadModelProjectionBatch(ctx.Ctx, orgID, ids, itemsdomain.ReadModelProjections.ProcessedPreview)
			if err != nil {
				return nil, internalFailure(err)
			}
		}
	}

	// The Mongo raw/processed batch is loaded in both modes, because the read
	// model document may exist without a raw or processed snapshot and the
	// resolver then falls back to the collection, exactly like the NestJS
	// loaders. It stays one query per collection for the whole page.
	if needs.raw || needs.rawPreview || needs.publishedAt {
		bindings := make(map[string]string, len(rows))
		for _, row := range rows {
			bindings[row.ID] = row.MongoRef
		}
		raw, err := r.svc.RawItemsBound(ctx.Ctx, bindings)
		if err != nil {
			return nil, internalFailure(err)
		}
		mongoRaw = raw
	}
	if needs.processed || needs.processedPreview || needs.publishedAt {
		// The Mongo processed loader is the fallback when the read-model
		// snapshot is missing the processed sub-document. The result leaf is
		// requested for the processed preview fields and for the publishedAt
		// chain.
		includeResult := needs.processedResult || needs.processedPreview || needs.publishedAt
		processed, err := r.svc.ProcessedByKeys(ctx.Ctx, orgID, ids, includeResult)
		if err != nil {
			return nil, internalFailure(err)
		}
		mongoProcessed = processed
	}

	links, err := r.resolveItemLinks(ctx, orgID, rows, readModelProcessed, readModelProcessedPreview, mongoProcessed)
	if err != nil {
		return nil, err
	}

	for _, row := range rows {
		model := &ItemModel{
			CreatedAt:  row.CreatedAt.Time,
			ID:         row.ID,
			IngestedAt: row.CreatedAt.Time,
			OrgID:      row.OrgID,
			Status:     row.Status,
			Title:      row.Name,
			UpdatedAt:  row.UpdatedAt.Time,
		}
		if row.PublishedAt != nil {
			formatted := itemsdomain.FormatISOTime(row.PublishedAt.Time)
			model.PublishedAt = &formatted
		}

		metaDoc, hasMetaDoc := readModelMeta[row.ID]
		if hasMetaDoc && strings.TrimSpace(metaDoc.Meta.ID) != "" {
			model.Meta = ItemMetaModel{
				CreatedAt:  metaDoc.Meta.CreatedAt.Time,
				ExternalID: metaDoc.Meta.ExternalID,
				ID:         metaDoc.Meta.ID,
				MongoRef:   metaDoc.Meta.MongoRef,
				Name:       metaDoc.Meta.Name,
				Status:     metaDoc.Meta.Status,
				UpdatedAt:  metaDoc.Meta.UpdatedAt.Time,
			}
		} else {
			model.Meta = ItemMetaModel{
				CreatedAt:  row.CreatedAt.Time,
				ExternalID: row.ExternalID,
				ID:         row.ID,
				MongoRef:   row.MongoRef,
				Name:       row.Name,
				Status:     row.Status,
				UpdatedAt:  row.UpdatedAt.Time,
			}
		}

		rawDoc, hasRawDoc := readModelRaw[row.ID]
		mongoRawDoc, hasMongoRaw := mongoRaw[row.ID]
		if hasRawDoc && rawDoc.Raw != nil {
			model.Raw = &RawItemModelGraph{
				CreatedAt:  rawDoc.Raw.CreatedAt.Time,
				ID:         rawDoc.Raw.ID,
				ItemMetaID: rawDoc.Raw.ItemMetaID,
				Payload:    string(rawDoc.Raw.Payload.Bytes()),
				Source:     rawDoc.Raw.Source,
				UpdatedAt:  rawDoc.Raw.UpdatedAt.Time,
			}
		} else if hasMongoRaw {
			payload := "null"
			if mongoRawDoc.Payload.Valid() {
				payload = string(mongoRawDoc.Payload.Bytes())
			}
			model.Raw = &RawItemModelGraph{
				CreatedAt:  mongoRawDoc.CreatedAt.Time,
				ID:         mongoRawDoc.HexID(),
				ItemMetaID: mongoRawDoc.ItemMetaID,
				Payload:    payload,
				Source:     mongoRawDoc.Source,
				UpdatedAt:  mongoRawDoc.UpdatedAt.Time,
			}
		}

		rawPreviewDoc, hasRawPreviewDoc := readModelRawPreview[row.ID]
		if hasRawPreviewDoc && rawPreviewDoc.Raw != nil {
			model.RawPreview = buildRawPreviewModel(itemsdomain.ExtractRawPreviewReadModel(rawPreviewDoc.Raw.Payload))
		} else if hasMongoRaw {
			model.RawPreview = buildRawPreviewModel(itemsdomain.ExtractRawPreviewMongo(mongoRawDoc.Payload))
		}

		processedDoc, hasProcessedDoc := readModelProcessed[row.ID]
		processedPreviewDoc, hasProcessedPreviewDoc := readModelProcessedPreview[row.ID]
		mongoProcessedDoc, hasMongoProcessed := mongoProcessed[row.ID]
		eventID, duplicateOf := linkValues(links, processedDoc, processedPreviewDoc, mongoProcessedDoc, hasMongoProcessed)

		if hasProcessedDoc && processedDoc.Processed != nil {
			model.Processed = buildReadModelProcessedGraph(processedDoc.Processed, eventID, duplicateOf)
		} else if hasProcessedPreviewDoc && processedPreviewDoc.Processed != nil {
			// When result/resultJson was not selected the scalar processed
			// fields come from the preview projection, exactly like the NestJS
			// readModelProcessedPreview loader.
			model.Processed = buildReadModelProcessedGraph(processedPreviewDoc.Processed, eventID, duplicateOf)
		} else if hasMongoProcessed {
			model.Processed = buildMongoProcessedGraph(mongoProcessedDoc, eventID, duplicateOf)
		}

		if hasProcessedPreviewDoc && processedPreviewDoc.Processed != nil {
			model.ProcessedPreview = buildReadModelProcessedPreviewGraph(&processedPreviewDoc, eventID, duplicateOf)
		} else if hasMongoProcessed {
			model.ProcessedPreview = buildMongoProcessedPreviewGraph(mongoProcessedDoc, eventID, duplicateOf)
		}

		// publishedAt fallback chain: meta row value -> read-model meta ->
		// processed result -> raw payload. The NestJS field resolver runs this
		// chain even though the item root already filled the property, so it is
		// reproduced here for both entry points.
		if model.PublishedAt == nil && hasMetaDoc && metaDoc.PublishedAt != nil {
			formatted := itemsdomain.FormatISOTime(metaDoc.PublishedAt.Time)
			model.PublishedAt = &formatted
		}
		if model.PublishedAt == nil {
			switch {
			case hasProcessedDoc && processedDoc.Processed != nil:
				model.PublishedAt = itemsdomain.ResolvePublishedFromResult(processedDoc.Processed.Result)
			case hasMongoProcessed:
				model.PublishedAt = itemsdomain.ResolvePublishedFromResult(mongoProcessedDoc.Result)
			}
		}
		if model.PublishedAt == nil {
			switch {
			case hasRawDoc && rawDoc.Raw != nil:
				model.PublishedAt = itemsdomain.ResolvePublishedFromPayload(rawDoc.Raw.Payload)
			case hasRawPreviewDoc && rawPreviewDoc.Raw != nil:
				model.PublishedAt = itemsdomain.ResolvePublishedFromPayload(rawPreviewDoc.Raw.Payload)
			case hasMongoRaw:
				model.PublishedAt = itemsdomain.ResolvePublishedFromPayload(mongoRawDoc.Payload)
			}
		}
		out[row.ID] = model
	}
	return out, nil
}

// resolveItemLinks batches the eventId and duplicateOf resolution for a page.
// Only the ids that actually carry a processed document are queried.
func (r *resolver) resolveItemLinks(
	ctx contract.Context,
	orgID string,
	rows []itemsdomain.ItemMetaRow,
	readModelProcessed map[string]itemsdomain.ReadModelDocument,
	readModelProcessedPreview map[string]itemsdomain.ReadModelDocument,
	mongoProcessed map[string]itemsdomain.ProcessedItemDoc,
) (itemLinks, error) {
	links := itemLinks{
		eventIDByProcessedID: map[string]*string{},
		duplicateByHex:       map[string]*string{},
	}
	processedIDs := make([]string, 0, len(rows))
	duplicateHexes := make([]string, 0, len(rows))
	for _, row := range rows {
		if doc, ok := readModelProcessed[row.ID]; ok && doc.Processed != nil {
			if id := strings.TrimSpace(doc.Processed.ID); id != "" {
				processedIDs = append(processedIDs, id)
			}
			if doc.Processed.DuplicateOf != nil && strings.TrimSpace(*doc.Processed.DuplicateOf) != "" {
				duplicateHexes = append(duplicateHexes, strings.TrimSpace(*doc.Processed.DuplicateOf))
			}
			continue
		}
		if doc, ok := readModelProcessedPreview[row.ID]; ok && doc.Processed != nil {
			if id := strings.TrimSpace(doc.Processed.ID); id != "" {
				processedIDs = append(processedIDs, id)
			}
			if doc.Processed.DuplicateOf != nil && strings.TrimSpace(*doc.Processed.DuplicateOf) != "" {
				duplicateHexes = append(duplicateHexes, strings.TrimSpace(*doc.Processed.DuplicateOf))
			}
			continue
		}
		if doc, ok := mongoProcessed[row.ID]; ok {
			if !doc.MongoID.IsZero() {
				processedIDs = append(processedIDs, doc.HexID())
			}
			if doc.DuplicateOf != nil && !doc.DuplicateOf.IsZero() {
				duplicateHexes = append(duplicateHexes, doc.DuplicateOf.Hex())
			}
		}
	}
	if len(processedIDs) > 0 {
		eventIDs, err := r.svc.ResolveEventIDs(ctx.Ctx, orgID, processedIDs)
		if err != nil {
			return itemLinks{}, internalFailure(err)
		}
		links.eventIDByProcessedID = eventIDs
	}
	if len(duplicateHexes) > 0 {
		duplicates, err := r.svc.ResolveDuplicateOfHexes(ctx.Ctx, orgID, duplicateHexes)
		if err != nil {
			return itemLinks{}, internalFailure(err)
		}
		links.duplicateByHex = duplicates
	}
	return links, nil
}

// linkValues returns the pre-resolved eventId and duplicateOf of one row.
func linkValues(
	links itemLinks,
	processedDoc itemsdomain.ReadModelDocument,
	processedPreviewDoc itemsdomain.ReadModelDocument,
	mongoDoc itemsdomain.ProcessedItemDoc,
	hasMongo bool,
) (*string, *string) {
	if processedDoc.Processed != nil {
		return links.eventIDByProcessedID[processedDoc.Processed.ID], duplicateOfValue(links, processedDoc.Processed.DuplicateOf)
	}
	if processedPreviewDoc.Processed != nil {
		return links.eventIDByProcessedID[processedPreviewDoc.Processed.ID], duplicateOfValue(links, processedPreviewDoc.Processed.DuplicateOf)
	}
	if hasMongo {
		var hex *string
		if mongoDoc.DuplicateOf != nil && !mongoDoc.DuplicateOf.IsZero() {
			value := mongoDoc.DuplicateOf.Hex()
			hex = &value
		}
		return links.eventIDByProcessedID[mongoDoc.HexID()], duplicateOfValue(links, hex)
	}
	return nil, nil
}

// duplicateOfValue maps a stored duplicateOf hex onto the target ItemMeta id.
func duplicateOfValue(links itemLinks, hex *string) *string {
	if hex == nil {
		return nil
	}
	return links.duplicateByHex[strings.TrimSpace(*hex)]
}

// buildReadModelProcessedGraph converts a read-model processed snapshot with
// its pre-resolved links.
func buildReadModelProcessedGraph(
	processed *itemsdomain.ReadModelProcessedDoc,
	eventID *string,
	duplicateOf *string,
) *workspace.ProcessedItemModelGraph {
	return &workspace.ProcessedItemModelGraph{
		CreatedAt:                  processed.CreatedAt.Time,
		DuplicateOf:                duplicateOf,
		DuplicateSimilarity:        processed.DuplicateSimilarity,
		Error:                      convertError(processed.Error),
		EventID:                    eventID,
		ID:                         processed.ID,
		ItemMetaID:                 processed.ItemMetaID,
		LLM:                        convertLlm(processed.Llm),
		Result:                     itemsdomain.ResultStringToken(processed.Result),
		ResultJSON:                 itemsdomain.ResultJSONPointer(processed.Result),
		Status:                     processed.Status,
		SummaryEmbeddingDimensions: processed.SummaryEmbeddingDimensions,
		SummaryEmbeddingModel:      processed.SummaryEmbeddingModel,
		Tags:                       processed.Tags,
	}
}

// buildMongoProcessedGraph converts a Mongo processed document.
func buildMongoProcessedGraph(
	processed itemsdomain.ProcessedItemDoc,
	eventID *string,
	duplicateOf *string,
) *workspace.ProcessedItemModelGraph {
	return &workspace.ProcessedItemModelGraph{
		CreatedAt:                  processed.CreatedAt.Time,
		DuplicateOf:                duplicateOf,
		DuplicateSimilarity:        processed.DuplicateSimilarity,
		Error:                      convertError(processed.Error),
		EventID:                    eventID,
		ID:                         processed.HexID(),
		ItemMetaID:                 processed.ItemMetaID,
		LLM:                        convertLlm(processed.Llm),
		Result:                     itemsdomain.ResultStringToken(processed.Result),
		ResultJSON:                 itemsdomain.ResultJSONPointer(processed.Result),
		Status:                     processed.Status,
		SummaryEmbeddingDimensions: processed.SummaryEmbeddingDimensions,
		SummaryEmbeddingModel:      processed.SummaryEmbeddingModel,
		Tags:                       processed.Tags,
	}
}

// buildReadModelProcessedPreviewGraph converts a read-model preview snapshot.
func buildReadModelProcessedPreviewGraph(
	doc *itemsdomain.ReadModelDocument,
	eventID *string,
	duplicateOf *string,
) *ProcessedItemPreviewModelGraph {
	processed := doc.Processed
	extracted := itemsdomain.ExtractProcessedResultFieldsReadModel(processed.Result)
	graph := &ProcessedItemPreviewModelGraph{
		CreatedAt:           processed.CreatedAt.Time,
		DuplicateOf:         duplicateOf,
		DuplicateSimilarity: processed.DuplicateSimilarity,
		EventID:             eventID,
		ID:                  processed.ID,
		ItemMetaID:          processed.ItemMetaID,
		Llm:                 convertLlm(processed.Llm),
		Status:              processed.Status,
		Tags:                processed.Tags,
		Topics:              nonNil(extracted.Topics, doc.Topics),
		Entities:            nonNil(extracted.Entities, doc.Entities),
		Summary:             firstOptional(optionalString(extracted.Summary), doc.Summary),
		Source:              firstOptional(optionalString(extracted.Source), doc.SourceName),
		Title:               firstOptional(optionalString(extracted.Title), optionalString(doc.Title)),
		Language:            firstOptional(optionalString(extracted.Language), doc.Language),
		Sentiment:           firstOptional(optionalString(extracted.Sentiment), doc.Sentiment),
		ContentType:         firstOptional(optionalString(extracted.ContentType), doc.ContentType),
		QualityScore:        firstOptionalFloat(extracted.QualityScore, doc.QualityScore),
		Location:            firstOptional(optionalString(extracted.Location), optionalString(extracted.Region), doc.Location, doc.Region),
	}
	if extracted.PublishedAt != nil {
		graph.PublishedAt = extracted.PublishedAt
	} else if doc.PublishedAt != nil {
		formatted := itemsdomain.FormatISOTime(doc.PublishedAt.Time)
		graph.PublishedAt = &formatted
	}
	return graph
}

// buildMongoProcessedPreviewGraph converts a Mongo processed document using the
// resolver-side projection.
func buildMongoProcessedPreviewGraph(
	processed itemsdomain.ProcessedItemDoc,
	eventID *string,
	duplicateOf *string,
) *ProcessedItemPreviewModelGraph {
	extracted := itemsdomain.ExtractProcessedResultFieldsResolver(processed.Result)
	location := extracted.Location
	if location == "" {
		location = extracted.Region
	}
	return &ProcessedItemPreviewModelGraph{
		CreatedAt:           processed.CreatedAt.Time,
		DuplicateOf:         duplicateOf,
		DuplicateSimilarity: processed.DuplicateSimilarity,
		EventID:             eventID,
		ID:                  processed.HexID(),
		ItemMetaID:          processed.ItemMetaID,
		Llm:                 convertLlm(processed.Llm),
		Status:              processed.Status,
		Tags:                processed.Tags,
		Topics:              nonNil(extracted.Topics, nil),
		Entities:            nonNil(extracted.Entities, nil),
		Source:              optionalString(extracted.Source),
		Title:               optionalString(extracted.Title),
		Language:            optionalString(extracted.Language),
		Sentiment:           optionalString(extracted.Sentiment),
		ContentType:         optionalString(extracted.ContentType),
		Summary:             optionalString(extracted.Summary),
		QualityScore:        extracted.QualityScore,
		Location:            optionalString(location),
		PublishedAt:         extracted.PublishedAt,
	}
}

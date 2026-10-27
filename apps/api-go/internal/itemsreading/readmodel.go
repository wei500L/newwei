package itemsreading

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// searchTermsLimit is the NestJS slice(0, 240) budget on the stored searchTerms
// stream.
const searchTermsLimit = 240

// readModelService builds and reads the Mongo itemreadmodels projection. It
// ports ItemsReadModelService: hydration is organization scoped everywhere, the
// source-id resolution chain cannot cross organizations, and a snapshot that is
// missing at hydration time is $unset rather than written as an explicit null.
type readModelService struct {
	mysql *mySQLStore
	mongo *mongoStore
}

// newReadModelService wires the hydration dependencies.
func newReadModelService(mysql *mySQLStore, mongo *mongoStore) *readModelService {
	return &readModelService{mysql: mysql, mongo: mongo}
}

// ListReadModelMetaRows pages the read-model meta projection.
func (s *mongoStore) ListReadModelMetaRows(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
	orderBy ItemsOrderBy,
	offset int,
	limit int,
) ([]ReadModelDocument, error) {
	match := readModelScopedMatch(orgID, scopedIDs)
	sortDoc := bson.D{{Key: "createdAt", Value: -1}, {Key: "itemMetaId", Value: -1}}
	if orderBy == ItemsOrderByPublishedDesc {
		sortDoc = bson.D{{Key: "sortAt", Value: -1}, {Key: "itemMetaId", Value: -1}}
	}
	opts := options.Find().
		SetProjection(readModelProjectionMeta()).
		SetSort(sortDoc).
		SetSkip(int64(offset)).
		SetLimit(int64(limit))
	cursor, err := s.readModels().Find(ctx, match, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]ReadModelDocument, 0, limit)
	for cursor.Next(ctx) {
		var doc ReadModelDocument
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// CountReadModelMetaRows counts the same range.
func (s *mongoStore) CountReadModelMetaRows(ctx context.Context, orgID string, scopedIDs []string) (int, error) {
	count, err := s.readModels().CountDocuments(ctx, readModelScopedMatch(orgID, scopedIDs))
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// readModelScopedMatch builds the organization-scoped read-model match. A
// non-nil empty scopedIDs means "no candidates", not "no restriction".
func readModelScopedMatch(orgID string, scopedIDs []string) bson.D {
	base := readModelBaseMatch(orgID)
	if scopedIDs == nil {
		return base
	}
	return bson.D{{Key: "$and", Value: bson.A{
		base,
		bson.D{{Key: "itemMetaId", Value: bson.D{{Key: "$in", Value: scopedIDs}}}},
	}}}
}

// hydrateItemReadModelsBatch ports hydrateItemReadModelsBatch. It returns the
// documents it built, keyed by itemMetaId.
func (s *readModelService) hydrateItemReadModelsBatch(
	ctx context.Context,
	orgID string,
	itemMetaIDs []string,
) (map[string]ReadModelDocument, error) {
	unique := DedupeItemMetaIDs(itemMetaIDs)
	hydrated := make(map[string]ReadModelDocument, len(unique))
	for start := 0; start < len(unique); start += ItemReadModelHydrateBatchSize {
		end := start + ItemReadModelHydrateBatchSize
		if end > len(unique) {
			end = len(unique)
		}
		batch := unique[start:end]
		metas, err := s.mysql.FindItemMetaRows(ctx, orgID, batch)
		if err != nil {
			return nil, err
		}
		if len(metas) == 0 {
			continue
		}
		orderedMetas := make([]ItemMetaRow, 0, len(batch))
		bindings := make(map[string]string, len(batch))
		for _, id := range batch {
			meta, ok := metas[id]
			if !ok {
				continue
			}
			orderedMetas = append(orderedMetas, meta)
			if trimmedRef := strings.TrimSpace(meta.MongoRef); trimmedRef != "" {
				bindings[meta.ID] = trimmedRef
			}
		}
		if len(orderedMetas) == 0 {
			continue
		}
		rawByItemMetaID, err := s.mongo.FindRawItemsBound(ctx, bindings)
		if err != nil {
			return nil, err
		}
		processedByItemMetaID, err := s.loadProcessedSnapshots(ctx, orgID, orderedMetas)
		if err != nil {
			return nil, err
		}
		raws := make(map[string]ReadModelRawDoc, len(rawByItemMetaID))
		for itemMetaID, doc := range rawByItemMetaID {
			raws[itemMetaID] = ReadModelRawDoc{
				ID:         doc.HexID(),
				ItemMetaID: doc.ItemMetaID,
				Source:     doc.Source,
				Payload:    doc.Payload,
				CreatedAt:  doc.CreatedAt,
				UpdatedAt:  doc.UpdatedAt,
			}
		}
		processeds := make(map[string]ReadModelProcessedDoc, len(processedByItemMetaID))
		for itemMetaID, doc := range processedByItemMetaID {
			processeds[itemMetaID] = processedSnapshot(doc)
		}
		sourceIDs, err := s.resolveSourceIDs(ctx, orgID, orderedMetas, raws, processeds)
		if err != nil {
			return nil, err
		}
		docs := make([]ReadModelDocument, 0, len(orderedMetas))
		for _, meta := range orderedMetas {
			raw, hasRaw := raws[meta.ID]
			processed, hasProcessed := processeds[meta.ID]
			var rawSnapshot *ReadModelRawDoc
			if hasRaw {
				rawValue := raw
				rawSnapshot = &rawValue
			}
			var processedSnapshot *ReadModelProcessedDoc
			if hasProcessed {
				processedValue := processed
				processedSnapshot = &processedValue
			}
			doc := buildReadModelDocument(buildReadModelInput{
				Meta:      meta,
				Raw:       rawSnapshot,
				Processed: processedSnapshot,
				SourceID:  sourceIDs[meta.ID],
			})
			docs = append(docs, doc)
		}
		if err := s.mongo.UpsertReadModels(ctx, docs); err != nil {
			return nil, err
		}
		for _, doc := range docs {
			hydrated[doc.ItemMetaID] = doc
		}
	}
	return hydrated, nil
}

// loadProcessedSnapshots loads the newest snapshot per item in any status.
// NestJS loadProcessedReadModelSnapshots takes the latest createdAt/_id row
// regardless of status, so a just-enqueued pending document is visible instead
// of an older completed one. The completed-only search helper is untouched.
func (s *readModelService) loadProcessedSnapshots(
	ctx context.Context,
	orgID string,
	metas []ItemMetaRow,
) (map[string]ProcessedItemDoc, error) {
	ids := make([]string, 0, len(metas))
	for _, meta := range metas {
		ids = append(ids, meta.ID)
	}
	docs, err := s.mongo.ListLatestProcessedSnapshotsAnyStatus(ctx, orgID, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string]ProcessedItemDoc, len(docs))
	for _, doc := range docs {
		if _, exists := out[doc.ItemMetaID]; exists {
			continue
		}
		out[doc.ItemMetaID] = doc
	}
	return out, nil
}

// processedSnapshot maps a stored processed document onto the read-model
// snapshot shape.
func processedSnapshot(doc ProcessedItemDoc) ReadModelProcessedDoc {
	var rawItemID *string
	if !doc.RawItemID.IsZero() {
		value := doc.RawItemID.Hex()
		rawItemID = &value
	}
	return ReadModelProcessedDoc{
		ID:                         doc.HexID(),
		ItemMetaID:                 doc.ItemMetaID,
		RawItemID:                  rawItemID,
		PipelineJobID:              doc.PipelineJobID,
		SourceID:                   doc.SourceID,
		Status:                     doc.Status,
		Error:                      doc.Error,
		Tags:                       normalizeTagList(doc.Tags),
		Result:                     NormalizeProcessedResult(doc.Result),
		DuplicateOf:                objectIDPointer(doc.DuplicateOf),
		DuplicateSimilarity:        doc.DuplicateSimilarity,
		SummaryEmbeddingModel:      doc.SummaryEmbeddingModel,
		SummaryEmbeddingDimensions: doc.SummaryEmbeddingDimensions,
		Llm:                        doc.Llm,
		CreatedAt:                  doc.CreatedAt,
		UpdatedAt:                  doc.UpdatedAt,
	}
}

// normalizeTagList trims, drops blanks and dedupes.
func normalizeTagList(tags []string) []string {
	return dedupeStrings(tags)
}

// objectIDPointer renders an ObjectId as a hex string pointer.
func objectIDPointer(value *bson.ObjectID) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	hex := value.Hex()
	return &hex
}

// resolveSourceIDs ports resolveReadModelSourceIds. The PipelineJob and
// CrawlResult lookups are organization scoped, and the raw metadata is only
// consulted for the organization-scoped meta that referenced the raw document.
func (s *readModelService) resolveSourceIDs(
	ctx context.Context,
	orgID string,
	metas []ItemMetaRow,
	raws map[string]ReadModelRawDoc,
	processeds map[string]ReadModelProcessedDoc,
) (map[string]string, error) {
	out := make(map[string]string, len(metas))
	type pending struct {
		itemMetaID     string
		pipelineJobIDs []string
		crawlResultIDs []string
	}
	unresolved := make([]pending, 0, len(metas))
	pipelineJobIDs := make(map[string]struct{})
	crawlResultIDs := make(map[string]struct{})

	for _, meta := range metas {
		if processed, ok := processeds[meta.ID]; ok {
			if direct := nonEmptyString(processed.SourceID); direct != "" {
				out[meta.ID] = direct
				continue
			}
		}
		metadata := rawMetadataOf(raws[meta.ID].Payload)
		if rawSource := nonEmptyString(metadata.SourceID); rawSource != "" {
			out[meta.ID] = rawSource
			continue
		}
		jobIDs := dedupeStrings([]string{
			nonEmptyString(processeds[meta.ID].PipelineJobID),
			nonEmptyString(metadata.PipelineJobID),
		})
		crawlIDs := dedupeStrings([]string{
			nonEmptyString(metadata.CrawlResultID),
			extractCrawlResultIDFromExternalID(meta.ExternalID),
		})
		if len(jobIDs) == 0 && len(crawlIDs) == 0 {
			continue
		}
		unresolved = append(unresolved, pending{itemMetaID: meta.ID, pipelineJobIDs: jobIDs, crawlResultIDs: crawlIDs})
		for _, id := range jobIDs {
			pipelineJobIDs[id] = struct{}{}
		}
		for _, id := range crawlIDs {
			crawlResultIDs[id] = struct{}{}
		}
	}
	if len(unresolved) == 0 {
		return out, nil
	}
	jobSourceIDs, err := s.mysql.PipelineJobSourceIDs(ctx, orgID, setKeys(pipelineJobIDs))
	if err != nil {
		return nil, err
	}
	crawlSourceIDs, err := s.mysql.CrawlResultSourceIDs(ctx, orgID, setKeys(crawlResultIDs))
	if err != nil {
		return nil, err
	}
	for _, record := range unresolved {
		resolved := ""
		for _, id := range record.pipelineJobIDs {
			if sourceID := strings.TrimSpace(jobSourceIDs[id]); sourceID != "" {
				resolved = sourceID
				break
			}
		}
		if resolved == "" {
			for _, id := range record.crawlResultIDs {
				if sourceID := strings.TrimSpace(crawlSourceIDs[id]); sourceID != "" {
					resolved = sourceID
					break
				}
			}
		}
		if resolved != "" {
			out[record.itemMetaID] = resolved
		}
	}
	return out, nil
}

// setKeys materializes a set as a sorted-free slice.
func setKeys(values map[string]struct{}) []string {
	out := make([]string, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	return out
}

// rawMetadataFields is the typed view of the raw payload metadata used by the
// source-id resolution chain.
type rawMetadataFields struct {
	SourceID      *string `json:"sourceId"`
	PipelineJobID *string `json:"pipelineJobId"`
	CrawlResultID *string `json:"crawlResultId"`
}

// rawMetadataOf reads the metadata sub-object of an open raw payload.
func rawMetadataOf(payload OpenJSON) rawMetadataFields {
	projection := decodeRawPayloadProjection(payload)
	if projection == nil || projection.Metadata == nil {
		return rawMetadataFields{}
	}
	encoded, err := json.Marshal(projection.Metadata)
	if err != nil {
		return rawMetadataFields{}
	}
	var fields rawMetadataFields
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return rawMetadataFields{}
	}
	return fields
}

// extractCrawlResultIDFromExternalID ports extractCrawlResultIdFromExternalId.
func extractCrawlResultIDFromExternalID(externalID string) string {
	raw := strings.TrimSpace(externalID)
	if raw == "" {
		return ""
	}
	for _, prefix := range []string{"crawlResult:", "crawl:"} {
		if strings.HasPrefix(raw, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(raw, prefix))
		}
	}
	return ""
}

// buildReadModelInput is the typed hydration input.
type buildReadModelInput struct {
	Meta      ItemMetaRow
	Raw       *ReadModelRawDoc
	Processed *ReadModelProcessedDoc
	SourceID  string
}

// buildReadModelDocument ports buildItemReadModelDocument.
func buildReadModelDocument(input buildReadModelInput) ReadModelDocument {
	meta := input.Meta
	var rawPayload OpenJSON
	if input.Raw != nil {
		rawPayload = input.Raw.Payload
	}
	rawFields := extractRawPreviewReadModel(rawPayload)
	var result OpenJSON
	if input.Processed != nil {
		result = input.Processed.Result
	}
	processedFields := ExtractProcessedResultFieldsReadModel(result)

	title := processedFields.Title
	if title == "" {
		title = meta.Name
	}
	var publishedAt *ISOTime
	if processedFields.PublishedAt != nil {
		if parsed, ok := parseTimeValue(*processedFields.PublishedAt); ok {
			value := NewISOTime(parsed)
			publishedAt = &value
		}
	}
	if publishedAt == nil {
		if fromRaw := resolvePublishedAtFromRawPayload(rawPayload); fromRaw != nil {
			if parsed, ok := parseTimeValue(*fromRaw); ok {
				value := NewISOTime(parsed)
				publishedAt = &value
			}
		}
	}
	if publishedAt == nil && meta.PublishedAt != nil {
		value := NewISOTime(meta.PublishedAt.Time)
		publishedAt = &value
	}
	sortAt := meta.SortAt
	if publishedAt != nil {
		sortAt = *publishedAt
	} else if sortAt.IsZero() {
		sortAt = meta.CreatedAt
	}

	sourceName := processedFields.Source
	if sourceName == "" {
		sourceName = rawFields.SourceName
	}
	region := processedFields.Region
	if region == "" {
		region = rawFields.Region
	}
	location := processedFields.Location
	if location == "" {
		location = rawFields.Location
	}
	if location == "" {
		location = region
	}
	topics := processedFields.Topics
	if len(topics) > 20 {
		topics = topics[:20]
	}
	entities := processedFields.Entities
	if len(entities) > 20 {
		entities = entities[:20]
	}
	var tags []string
	if input.Processed != nil {
		tags = normalizeTagList(input.Processed.Tags)
	}

	searchParts := make([]string, 0, 16)
	for _, part := range []string{
		title,
		meta.ExternalID,
		sourceName,
		rawFields.Summary,
		processedFields.Summary,
		rawFields.URL,
		rawFields.Ticker,
		region,
		location,
	} {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			searchParts = append(searchParts, trimmed)
		}
	}
	searchParts = append(searchParts, topics...)
	searchParts = append(searchParts, entities...)
	searchParts = append(searchParts, tags...)

	summary := processedFields.Summary
	if summary == "" {
		summary = rawFields.Summary
	}
	sourceID := strings.TrimSpace(input.SourceID)
	if sourceID == "" && input.Processed != nil {
		sourceID = nonEmptyString(input.Processed.SourceID)
	}
	embeddingDimensions := (*int)(nil)
	if input.Processed != nil {
		embeddingDimensions = input.Processed.SummaryEmbeddingDimensions
	}

	doc := ReadModelDocument{
		OrgID:               meta.OrgID,
		ItemMetaID:          meta.ID,
		Meta:                readModelMeta(meta),
		ExternalID:          meta.ExternalID,
		ExternalIDLower:     strings.ToLower(meta.ExternalID),
		Title:               title,
		TitleLower:          strings.ToLower(title),
		Status:              meta.Status,
		IngestedAt:          meta.CreatedAt,
		CreatedAt:           meta.CreatedAt,
		UpdatedAt:           meta.UpdatedAt,
		PublishedAt:         publishedAt,
		SortAt:              sortAt,
		Topics:              nonNilStrings(topics),
		TopicKeys:           lowerStrings(topics),
		Entities:            nonNilStrings(entities),
		EntityKeys:          lowerStrings(entities),
		Tags:                nonNilStrings(tags),
		Summary:             stringPointer(summary),
		SourceName:          stringPointer(sourceName),
		SourceNameLower:     lowerPointer(sourceName),
		URL:                 stringPointer(rawFields.URL),
		Thumbnail:           stringPointer(rawFields.Thumbnail),
		Domain:              normalizeURLDomain(rawFields.URL),
		Language:            stringPointer(processedFields.Language),
		Region:              stringPointer(region),
		RegionKey:           lowerPointer(region),
		Location:            stringPointer(location),
		LocationKey:         lowerPointer(location),
		Sentiment:           lowerPointer(processedFields.Sentiment),
		ContentType:         stringPointer(processedFields.ContentType),
		QualityScore:        processedFields.QualityScore,
		HasVector:           input.Processed != nil && nonEmptyString(input.Processed.SummaryEmbeddingModel) != "" && embeddingDimensions != nil && *embeddingDimensions > 0,
		EmbeddingModel:      processedModelPointer(input.Processed),
		SearchText:          strings.Join(searchParts, "\n"),
		SearchTerms:         nonNilStrings(buildSearchTerms(searchParts)),
		ProjectionUpdatedAt: NewISOTime(time.Now().UTC()),
		Raw:                 input.Raw,
		Processed:           input.Processed,
	}
	if sourceID != "" {
		doc.SourceID = &sourceID
	}
	if input.Processed != nil {
		doc.DuplicateOf = input.Processed.DuplicateOf
		doc.DuplicateSimilarity = input.Processed.DuplicateSimilarity
	}
	return doc
}

// readModelMeta projects an ItemMetaRow onto the embedded meta snapshot.
func readModelMeta(meta ItemMetaRow) ReadModelMetaDoc {
	sortAt := meta.SortAt
	if sortAt.IsZero() {
		sortAt = meta.CreatedAt
	}
	return ReadModelMetaDoc{
		ID:          meta.ID,
		ExternalID:  meta.ExternalID,
		Name:        meta.Name,
		Status:      meta.Status,
		MongoRef:    meta.MongoRef,
		Version:     meta.Version,
		PublishedAt: meta.PublishedAt,
		SortAt:      sortAt,
		CreatedAt:   meta.CreatedAt,
		UpdatedAt:   meta.UpdatedAt,
	}
}

func processedModelPointer(processed *ReadModelProcessedDoc) *string {
	if processed == nil {
		return nil
	}
	return processed.SummaryEmbeddingModel
}

func stringPointer(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(value)
	return &trimmed
}

func lowerPointer(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	lowered := strings.ToLower(trimmed)
	return &lowered
}

func nonNilStrings(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	return values
}

func lowerStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, strings.ToLower(value))
	}
	return out
}

// buildSearchTerms ports the searchTerms derivation: lowercase, split on any
// character outside [a-z0-9_ latin-extended CJK], keep terms of at least two
// characters, cut the flat term stream to its first 240 entries and then dedupe.
//
// The order matters: NestJS slices the flatMap result before Array.from(new
// Set(...)), so duplicates inside the first 240 occurrences consume the budget
// and the stored array can hold fewer than 240 unique terms. Deduping while
// collecting would keep up to 240 unique terms and store a different array.
func buildSearchTerms(parts []string) []string {
	stream := make([]string, 0, 64)
	for _, part := range parts {
		for _, term := range splitSearchTerms(strings.ToLower(part)) {
			if len(term) < 2 {
				continue
			}
			stream = append(stream, term)
			if len(stream) >= searchTermsLimit {
				break
			}
		}
		if len(stream) >= searchTermsLimit {
			break
		}
	}
	seen := make(map[string]struct{}, len(stream))
	terms := make([]string, 0, len(stream))
	for _, term := range stream {
		if _, ok := seen[term]; ok {
			continue
		}
		seen[term] = struct{}{}
		terms = append(terms, term)
	}
	return terms
}

// splitSearchTerms splits on the delimiters the NestJS regex treats as
// separators.
func splitSearchTerms(value string) []string {
	out := make([]string, 0, 8)
	current := make([]rune, 0, 16)
	flush := func() {
		if len(current) > 0 {
			out = append(out, string(current))
			current = current[:0]
		}
	}
	for _, r := range value {
		if isSearchTermRune(r) {
			current = append(current, r)
			continue
		}
		flush()
	}
	flush()
	return out
}

// isSearchTermRune reports whether a rune belongs to the allowed search-term
// alphabet of the NestJS split regex: ASCII letters and digits, underscore,
// latin-extended (U+00C0-U+024F) and CJK (U+4E00-U+9FFF). Every other rune —
// including Cyrillic, Greek, kana and half-width forms — is a separator there, so
// it must be a separator here too or the stored projection would carry terms the
// NestJS writer never produces.
func isSearchTermRune(r rune) bool {
	if r >= 'a' && r <= 'z' {
		return true
	}
	if r >= '0' && r <= '9' {
		return true
	}
	if r == '_' {
		return true
	}
	if r >= 0x00C0 && r <= 0x024F {
		return true
	}
	return r >= 0x4E00 && r <= 0x9FFF
}

// normalizeURLDomain ports normalizeUrlDomain.
func normalizeURLDomain(value string) *string {
	candidate := strings.TrimSpace(value)
	if candidate == "" {
		return nil
	}
	parse := func(input string) *string {
		parsed, err := url.Parse(input)
		if err != nil || parsed.Hostname() == "" {
			return nil
		}
		host := strings.TrimPrefix(strings.ToLower(parsed.Hostname()), "www.")
		if host == "" {
			return nil
		}
		return &host
	}
	if result := parse(candidate); result != nil {
		return result
	}
	return parse("https://" + candidate)
}

// loadItemReadModel ports loadItemReadModel.
func (s *readModelService) loadItemReadModel(
	ctx context.Context,
	orgID string,
	itemMetaID string,
	hydrateMissing bool,
) (*ReadModelDocument, error) {
	normalized := strings.TrimSpace(itemMetaID)
	if normalized == "" {
		return nil, nil
	}
	docs, err := s.mongo.FindReadModelsByIDs(ctx, orgID, []string{normalized})
	if err != nil {
		return nil, err
	}
	if doc, ok := docs[normalized]; ok {
		return &doc, nil
	}
	if !hydrateMissing {
		return nil, nil
	}
	hydrated, err := s.hydrateItemReadModelsBatch(ctx, orgID, []string{normalized})
	if err != nil {
		return nil, err
	}
	if doc, ok := hydrated[normalized]; ok {
		return &doc, nil
	}
	return nil, nil
}

// loadItemReadModelsByIDs ports loadItemReadModelsByIds.
func (s *readModelService) loadItemReadModelsByIDs(
	ctx context.Context,
	orgID string,
	ids []string,
) (map[string]ReadModelDocument, error) {
	unique := DedupeItemMetaIDs(ids)
	if len(unique) == 0 {
		return map[string]ReadModelDocument{}, nil
	}
	docs, err := s.mongo.FindReadModelsByIDs(ctx, orgID, unique)
	if err != nil {
		return nil, err
	}
	missing := make([]string, 0, len(unique))
	for _, id := range unique {
		if _, ok := docs[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		hydrated, err := s.hydrateItemReadModelsBatch(ctx, orgID, missing)
		if err != nil {
			return nil, err
		}
		for _, id := range missing {
			if doc, ok := hydrated[id]; ok {
				docs[id] = doc
			}
		}
	}
	return docs, nil
}

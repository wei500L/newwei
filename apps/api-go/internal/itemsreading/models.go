package itemsreading

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ItemStatus mirrors the NestJS ItemStatus enum
// (apps/api/src/common/pipeline-status.ts). The values are stored verbatim in
// MySQL ItemMeta.status and in the Mongo read model.
type ItemStatus string

const (
	// ItemStatusDraft is a manually created item that has not been ingested.
	ItemStatusDraft ItemStatus = "draft"
	// ItemStatusPending waits for the pipeline.
	ItemStatusPending ItemStatus = "pending"
	// ItemStatusProcessing is being processed.
	ItemStatusProcessing ItemStatus = "processing"
	// ItemStatusCompleted finished processing.
	ItemStatusCompleted ItemStatus = "completed"
	// ItemStatusFailed failed processing.
	ItemStatusFailed ItemStatus = "failed"
	// ItemStatusDuplicate was classified as a duplicate and is excluded from
	// every reading list, facet and suggestion.
	ItemStatusDuplicate ItemStatus = "duplicate"
)

// PipelineStageStatus mirrors the NestJS PipelineStageStatus enum.
type PipelineStageStatus string

const (
	// PipelineStagePending waits for a worker.
	PipelineStagePending PipelineStageStatus = "pending"
	// PipelineStageProcessing is running.
	PipelineStageProcessing PipelineStageStatus = "processing"
	// PipelineStageCompleted finished successfully.
	PipelineStageCompleted PipelineStageStatus = "completed"
	// PipelineStageFailed failed.
	PipelineStageFailed PipelineStageStatus = "failed"
)

// ItemsOrderBy is the REST orderBy contract. It only has the two values the
// ListItemsDto whitelists; PERSONALIZED is not migrated.
type ItemsOrderBy string

const (
	// ItemsOrderByCreatedDesc orders by createdAt DESC, id DESC.
	ItemsOrderByCreatedDesc ItemsOrderBy = "CREATED_DESC"
	// ItemsOrderByPublishedDesc orders by sortAt DESC, id DESC.
	ItemsOrderByPublishedDesc ItemsOrderBy = "PUBLISHED_DESC"
)

// SuggestionType is the GraphQL SearchSuggestionType enum member.
type SuggestionType string

const (
	// SuggestionTypeTopic is a topic or entity suggestion.
	SuggestionTypeTopic SuggestionType = "TOPIC"
	// SuggestionTypeRegion is a region/location suggestion.
	SuggestionTypeRegion SuggestionType = "REGION"
	// SuggestionTypeSource is a source-name suggestion.
	SuggestionTypeSource SuggestionType = "SOURCE"
	// SuggestionTypeSentiment is a sentiment suggestion.
	SuggestionTypeSentiment SuggestionType = "SENTIMENT"
)

// SuggestionOrigin is the GraphQL SearchSuggestionOrigin enum member.
type SuggestionOrigin string

const (
	// SuggestionOriginLexical matched only the lexical facet index.
	SuggestionOriginLexical SuggestionOrigin = "LEXICAL"
	// SuggestionOriginSemantic came only from the vector recall.
	SuggestionOriginSemantic SuggestionOrigin = "SEMANTIC"
	// SuggestionOriginHybrid matched both the lexical index and the vector
	// recall.
	SuggestionOriginHybrid SuggestionOrigin = "HYBRID"
)

// RssTranslationProvider is the GraphQL RssTranslationProvider enum member.
type RssTranslationProvider string

const (
	// RssTranslationProviderDeepLx is the DeepLX (and fallback) provider.
	RssTranslationProviderDeepLx RssTranslationProvider = "deeplx"
	// RssTranslationProviderLlm is the LLM gateway provider.
	RssTranslationProviderLlm RssTranslationProvider = "llm"
)

// SearchCandidateSource names one recall source of the candidate fusion. The
// weights live in candidateWeights and must stay in sync with
// apps/api/src/modules/items/items-search.helpers.ts.
type SearchCandidateSource string

const (
	// SearchCandidateMeta is the MySQL ItemMeta FULLTEXT/prefix recall.
	SearchCandidateMeta SearchCandidateSource = "meta"
	// SearchCandidateProcessed is the Mongo ProcessedItem full-text recall.
	SearchCandidateProcessed SearchCandidateSource = "processed"
	// SearchCandidateProcessedArticle is the ProcessedArticle FULLTEXT recall
	// linked through cleanedMarkdownRef.
	SearchCandidateProcessedArticle SearchCandidateSource = "processedArticle"
	// SearchCandidateVector is the embedding/vector recall.
	SearchCandidateVector SearchCandidateSource = "vector"
	// SearchCandidateElasticsearch is the Elasticsearch recall.
	SearchCandidateElasticsearch SearchCandidateSource = "elasticsearch"
)

// ISOTime renders a timestamp exactly like JavaScript
// Date.prototype.toISOString: UTC, millisecond precision, trailing Z. The
// default time.Time JSON encoding trims trailing zero fractions, which would
// answer "…:30Z" where NestJS answers "…:30.000Z".
type ISOTime struct {
	Time time.Time
}

// NewISOTime normalizes a timestamp to UTC.
func NewISOTime(value time.Time) ISOTime {
	return ISOTime{Time: value.UTC()}
}

// FormatISOTime formats a timestamp the way JavaScript does.
func FormatISOTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// MarshalJSON implements json.Marshaler.
func (t ISOTime) MarshalJSON() ([]byte, error) {
	return json.Marshal(FormatISOTime(t.Time))
}

// UnmarshalBSONValue implements bson.ValueUnmarshaler so a stored BSON date
// decodes into the wrapper (a plain struct target cannot receive a date value).
func (t *ISOTime) UnmarshalBSONValue(typ byte, data []byte) error {
	if typ == 0x0A || len(data) == 0 {
		*t = ISOTime{}
		return nil
	}
	if typ != 0x09 {
		return fmt.Errorf("itemsreading: cannot decode BSON type %d into ISOTime", typ)
	}
	if len(data) < 8 {
		return errors.New("itemsreading: truncated BSON datetime")
	}
	millis := int64(binary.LittleEndian.Uint64(data[:8]))
	*t = NewISOTime(time.UnixMilli(millis).UTC())
	return nil
}

// MarshalBSONValue implements bson.ValueMarshaler so a read-model upsert writes
// a real BSON date instead of an empty document.
func (t ISOTime) MarshalBSONValue() (byte, []byte, error) {
	if t.Time.IsZero() {
		return 0x0A, nil, nil
	}
	buffer := make([]byte, 8)
	binary.LittleEndian.PutUint64(buffer, uint64(t.Time.UTC().UnixMilli()))
	return 0x09, buffer, nil
}

// IsZero reports whether the timestamp is the zero value.
func (t ISOTime) IsZero() bool {
	return t.Time.IsZero()
}

// OpenJSON keeps a JSON value byte-exact so an open schema field such as
// RawItem.payload or ProcessedItem.result can round-trip without an untyped Go
// map. It is a leaf helper only: every business projection decodes into a
// named struct.
type OpenJSON struct {
	raw   json.RawMessage
	valid bool
}

// NewOpenJSON wraps already-valid JSON bytes.
func NewOpenJSON(raw []byte) OpenJSON {
	if len(raw) == 0 || !json.Valid(raw) {
		return OpenJSON{}
	}
	cloned := make([]byte, len(raw))
	copy(cloned, raw)
	return OpenJSON{raw: cloned, valid: true}
}

// Valid reports whether the value holds JSON.
func (o OpenJSON) Valid() bool { return o.valid }

// Bytes returns the raw JSON bytes.
func (o OpenJSON) Bytes() json.RawMessage {
	if !o.valid {
		return nil
	}
	return o.raw
}

// MarshalJSON implements json.Marshaler. A missing value marshals as null so a
// caller can still distinguish "absent" through Valid.
func (o OpenJSON) MarshalJSON() ([]byte, error) {
	if !o.valid || len(o.raw) == 0 {
		return []byte("null"), nil
	}
	return o.raw, nil
}

// UnmarshalJSON implements json.Unmarshaler.
func (o *OpenJSON) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*o = OpenJSON{}
		return nil
	}
	*o = NewOpenJSON(data)
	return nil
}

// UnmarshalBSONValue implements bson.ValueUnmarshaler. The BSON value is
// converted to compact JSON without an intermediate untyped map.
func (o *OpenJSON) UnmarshalBSONValue(typ byte, data []byte) error {
	switch typ {
	case 0x03: // embedded document
		converted, ok := bsonDocumentToJSON(data)
		if !ok {
			*o = OpenJSON{}
			return nil
		}
		*o = NewOpenJSON(converted)
		return nil
	case 0x04: // array
		converted, ok := bsonArrayToJSON(data)
		if !ok {
			*o = OpenJSON{}
			return nil
		}
		*o = NewOpenJSON(converted)
		return nil
	default: // null, scalars, and anything else has no open representation
		*o = OpenJSON{}
		return nil
	}
}

// MarshalBSONValue implements bson.ValueMarshaler so an open JSON leaf can be
// written back to Mongo (the read-model hydration upsert) without an untyped
// map.
func (o OpenJSON) MarshalBSONValue() (byte, []byte, error) {
	if !o.valid || len(o.raw) == 0 {
		return 0x0A, nil, nil // BSON null
	}
	encoded, ok := jsonBytesToBSON(o.raw)
	if !ok {
		return 0x0A, nil, nil
	}
	return 0x03, encoded, nil
}

// DocumentEcho preserves a Mongo document's stored key order and key presence
// so the legacy Mongoose lean() REST shape (which omits absent keys and
// renders stored nulls as null) can be reproduced exactly. ObjectIds become
// their hex string, exactly like JSON.stringify of a Mongoose lean document.
type DocumentEcho struct {
	fields []echoField
}

// echoField is one stored key. A nil value means the stored value was BSON
// null (or an unrepresentable type), which still renders as JSON null.
type echoField struct {
	key   string
	value json.RawMessage
}

// UnmarshalBSON implements bson.Unmarshaler. The driver only calls
// UnmarshalBSONValue for individual values inside a document, so a whole
// document target (FindOne().Decode) must implement UnmarshalBSON.
func (e *DocumentEcho) UnmarshalBSON(data []byte) error {
	return e.UnmarshalBSONValue(0x03, data)
}

// UnmarshalBSONValue implements bson.ValueUnmarshaler for the nested-value case.
func (e *DocumentEcho) UnmarshalBSONValue(typ byte, data []byte) error {
	if typ != 0x03 {
		e.fields = nil
		return nil
	}
	fields, ok := decodeEchoFields(data)
	if !ok {
		e.fields = nil
		return nil
	}
	e.fields = fields
	return nil
}

// MarshalJSON implements json.Marshaler.
func (e DocumentEcho) MarshalJSON() ([]byte, error) {
	out := make([]byte, 0, 64)
	out = append(out, '{')
	for index, field := range e.fields {
		if index > 0 {
			out = append(out, ',')
		}
		key, err := json.Marshal(field.key)
		if err != nil {
			return nil, err
		}
		out = append(out, key...)
		out = append(out, ':')
		if len(field.value) == 0 {
			out = append(out, "null"...)
			continue
		}
		out = append(out, field.value...)
	}
	out = append(out, '}')
	return out, nil
}

// Lookup returns the raw JSON of a stored key and whether it exists.
func (e DocumentEcho) Lookup(key string) (json.RawMessage, bool) {
	for _, field := range e.fields {
		if field.key == key {
			return field.value, true
		}
	}
	return nil, false
}

// Has reports whether the stored document has the key.
func (e DocumentEcho) Has(key string) bool {
	_, ok := e.Lookup(key)
	return ok
}

// decodeEchoFields converts every element of a raw BSON document into a JSON
// token. It reuses the same byte-level reader as the open JSON leaf.
func decodeEchoFields(document []byte) ([]echoField, bool) {
	size, ok := bsonDocumentSize(document)
	if !ok {
		return nil, false
	}
	body := document[:size]
	fields := make([]echoField, 0, 16)
	offset := 4
	for {
		if offset >= len(body) {
			return nil, false
		}
		elementType := body[offset]
		offset++
		if elementType == 0x00 {
			break
		}
		key, next, readOK := readCString(body, offset)
		if !readOK {
			return nil, false
		}
		offset = next
		encoded, after, valueOK := appendBSONValue(make([]byte, 0, 32), body, offset, elementType)
		if !valueOK {
			return nil, false
		}
		offset = after
		if string(encoded) == "null" {
			fields = append(fields, echoField{key: key})
			continue
		}
		fields = append(fields, echoField{key: key, value: json.RawMessage(encoded)})
	}
	return fields, true
}

// ItemMetaRow is the organization-scoped MySQL ItemMeta projection shared by
// the REST list/detail responses, the read-model hydration and the filter
// pipeline. Field names match the Prisma columns exactly.
type ItemMetaRow struct {
	ID          string   `json:"id"`
	OrgID       string   `json:"orgId"`
	ExternalID  string   `json:"externalId"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	MongoRef    string   `json:"mongoRef"`
	Version     int      `json:"version"`
	PublishedAt *ISOTime `json:"publishedAt"`
	SortAt      ISOTime  `json:"sortAt"`
	CreatedAt   ISOTime  `json:"createdAt"`
	UpdatedAt   ISOTime  `json:"updatedAt"`
}

// ItemListResult is the GET /api/items response envelope.
type ItemListResult struct {
	Items    []ItemMetaRow `json:"items"`
	Total    int           `json:"total"`
	Page     int           `json:"page"`
	PageSize int           `json:"pageSize"`
}

// ItemDateRangeFilter mirrors ItemsDateRangeInput.
type ItemDateRangeFilter struct {
	Start *time.Time `json:"start,omitempty"`
	End   *time.Time `json:"end,omitempty"`
}

// ItemFilters mirrors the ItemsFiltersInput GraphQL input object and the
// historical __items_filters__ search payload filters.
type ItemFilters struct {
	SourceIDs         []string             `json:"sourceIds,omitempty"`
	Regions           []string             `json:"regions,omitempty"`
	Topics            []string             `json:"topics,omitempty"`
	Sentiments        []string             `json:"sentiments,omitempty"`
	ContentTypes      []string             `json:"contentTypes,omitempty"`
	ExcludeDuplicates bool                 `json:"excludeDuplicates,omitempty"`
	DateRange         *ItemDateRangeFilter `json:"dateRange,omitempty"`
}

// Active reports whether at least one filter restricts the candidate set.
func (f *ItemFilters) Active() bool {
	if f == nil {
		return false
	}
	return len(f.SourceIDs) > 0 || len(f.Regions) > 0 || len(f.Topics) > 0 ||
		len(f.Sentiments) > 0 || len(f.ContentTypes) > 0 || f.ExcludeDuplicates ||
		(f.DateRange != nil && (f.DateRange.Start != nil || f.DateRange.End != nil))
}

// ParsedSearchPayload is the result of parseSearchPayload: either a plain
// search term or the decoded historical filter envelope.
type ParsedSearchPayload struct {
	Search  string
	Filters *ItemFilters
}

// FacetOption is one {value,count} pair of an itemFacets group.
type FacetOption struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// ItemFacets is the itemFacets GraphQL payload.
type ItemFacets struct {
	Regions      []FacetOption `json:"regions"`
	Topics       []FacetOption `json:"topics"`
	Sentiments   []FacetOption `json:"sentiments"`
	ContentTypes []FacetOption `json:"contentTypes"`
}

// RssSourceOption is the rssSources GraphQL element.
type RssSourceOption struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Language        *string `json:"language"`
	SiteURL         string  `json:"siteUrl"`
	FeedURL         string  `json:"feedUrl"`
	LatestItemAt    *string `json:"latestItemAt"`
	ItemCountWindow int     `json:"itemCountWindow"`
}

// RssTranslationProviderStatus is one rssTranslationStatus element.
type RssTranslationProviderStatus struct {
	Provider                RssTranslationProvider `json:"provider"`
	Available               bool                   `json:"available"`
	Message                 *string                `json:"message"`
	TargetLanguageSupported bool                   `json:"targetLanguageSupported"`
}

// SearchSuggestion is one searchSuggestions element.
type SearchSuggestion struct {
	Type   SuggestionType   `json:"type"`
	Value  string           `json:"value"`
	Origin SuggestionOrigin `json:"origin"`
}

// RawItemDoc is the typed projection used by the GraphQL raw field and by the
// read-model hydration. Mongo's `_id` is carried in MongoID.
type RawItemDoc struct {
	MongoID    bson.ObjectID `bson:"_id" json:"-"`
	ItemMetaID string        `bson:"itemMetaId" json:"itemMetaId"`
	Payload    OpenJSON      `bson:"payload" json:"payload"`
	Source     *string       `bson:"source" json:"source"`
	CreatedAt  ISOTime       `bson:"createdAt" json:"createdAt"`
	UpdatedAt  ISOTime       `bson:"updatedAt" json:"updatedAt"`
}

// HexID returns the document id as a hex string, the form Mongoose serializes
// an ObjectId into.
func (d RawItemDoc) HexID() string { return d.MongoID.Hex() }

// ProcessedItemErrorDoc is the stored processeditems.error sub-document.
type ProcessedItemErrorDoc struct {
	Message string  `bson:"message" json:"message"`
	Name    *string `bson:"name" json:"name"`
	Stack   *string `bson:"stack" json:"stack,omitempty"`
}

// ProcessedItemLlmDoc is the stored processeditems.llm sub-document.
type ProcessedItemLlmDoc struct {
	Model            *string  `bson:"model" json:"model"`
	PromptVersion    *string  `bson:"promptVersion" json:"promptVersion"`
	PromptTokens     *float64 `bson:"promptTokens" json:"promptTokens"`
	CompletionTokens *float64 `bson:"completionTokens" json:"completionTokens"`
	TotalTokens      *float64 `bson:"totalTokens" json:"totalTokens"`
	CostUSD          *float64 `bson:"costUsd" json:"costUsd"`
	LatencyMs        *float64 `bson:"latencyMs" json:"latencyMs"`
}

// ProcessedItemDoc is the typed projection used by the GraphQL processed
// field, the filter/facet pipelines and the read-model hydration. The result
// sub-document stays an open JSON leaf because its extension keys are not part
// of a fixed schema; typed projections decode specific keys from it.
type ProcessedItemDoc struct {
	MongoID                    bson.ObjectID          `bson:"_id" json:"-"`
	RawItemID                  bson.ObjectID          `bson:"rawItemId" json:"rawItemId"`
	ItemMetaID                 string                 `bson:"itemMetaId" json:"itemMetaId"`
	OrgID                      string                 `bson:"orgId" json:"orgId"`
	PipelineJobID              *string                `bson:"pipelineJobId" json:"pipelineJobId"`
	SourceID                   *string                `bson:"sourceId" json:"sourceId"`
	Status                     string                 `bson:"status" json:"status"`
	Tags                       []string               `bson:"tags" json:"tags"`
	Result                     OpenJSON               `bson:"result" json:"result"`
	Error                      *ProcessedItemErrorDoc `bson:"error" json:"error"`
	Llm                        *ProcessedItemLlmDoc   `bson:"llm" json:"llm"`
	SortedAt                   *ISOTime               `bson:"sortAt" json:"sortAt"`
	IngestedAt                 *ISOTime               `bson:"ingestedAt" json:"ingestedAt"`
	DuplicateOf                *bson.ObjectID         `bson:"duplicateOf" json:"duplicateOf"`
	DuplicateSimilarity        *float64               `bson:"duplicateSimilarity" json:"duplicateSimilarity"`
	SummaryEmbedding           []float64              `bson:"summaryEmbedding" json:"summaryEmbedding"`
	SummaryEmbeddingModel      *string                `bson:"summaryEmbeddingModel" json:"summaryEmbeddingModel"`
	SummaryEmbeddingDimensions *int                   `bson:"summaryEmbeddingDimensions" json:"summaryEmbeddingDimensions"`
	CreatedAt                  ISOTime                `bson:"createdAt" json:"createdAt"`
	UpdatedAt                  ISOTime                `bson:"updatedAt" json:"updatedAt"`
}

// HexID returns the document id as a hex string.
func (d ProcessedItemDoc) HexID() string { return d.MongoID.Hex() }

// ReadModelRawDoc is the denormalized raw snapshot stored inside an
// itemreadmodels document. Its JSON shape is also the read-model REST detail
// shape for `rawItem`.
type ReadModelRawDoc struct {
	ID         string   `bson:"id" json:"id"`
	ItemMetaID string   `bson:"itemMetaId" json:"itemMetaId"`
	Source     *string  `bson:"source" json:"source"`
	Payload    OpenJSON `bson:"payload" json:"payload"`
	CreatedAt  ISOTime  `bson:"createdAt" json:"createdAt"`
	UpdatedAt  ISOTime  `bson:"updatedAt" json:"updatedAt"`
}

// ReadModelProcessedDoc is the denormalized processed snapshot stored inside
// an itemreadmodels document. Its JSON shape is also the read-model REST
// detail shape for `processed`.
type ReadModelProcessedDoc struct {
	ID                         string                 `bson:"id" json:"id"`
	ItemMetaID                 string                 `bson:"itemMetaId" json:"itemMetaId"`
	RawItemID                  *string                `bson:"rawItemId" json:"rawItemId"`
	PipelineJobID              *string                `bson:"pipelineJobId" json:"pipelineJobId"`
	SourceID                   *string                `bson:"sourceId" json:"sourceId"`
	Status                     string                 `bson:"status" json:"status"`
	Error                      *ProcessedItemErrorDoc `bson:"error" json:"error"`
	Tags                       []string               `bson:"tags" json:"tags"`
	Result                     OpenJSON               `bson:"result" json:"result"`
	DuplicateOf                *string                `bson:"duplicateOf" json:"duplicateOf"`
	DuplicateSimilarity        *float64               `bson:"duplicateSimilarity" json:"duplicateSimilarity"`
	SummaryEmbeddingModel      *string                `bson:"summaryEmbeddingModel" json:"summaryEmbeddingModel"`
	SummaryEmbeddingDimensions *int                   `bson:"summaryEmbeddingDimensions" json:"summaryEmbeddingDimensions"`
	Llm                        *ProcessedItemLlmDoc   `bson:"llm" json:"llm"`
	CreatedAt                  ISOTime                `bson:"createdAt" json:"createdAt"`
	UpdatedAt                  ISOTime                `bson:"updatedAt" json:"updatedAt"`
}

// ReadModelMetaDoc is the denormalized ItemMeta snapshot inside an
// itemreadmodels document.
type ReadModelMetaDoc struct {
	ID          string   `bson:"id" json:"id"`
	ExternalID  string   `bson:"externalId" json:"externalId"`
	Name        string   `bson:"name" json:"name"`
	Status      string   `bson:"status" json:"status"`
	MongoRef    string   `bson:"mongoRef" json:"mongoRef"`
	Version     int      `bson:"version" json:"version"`
	PublishedAt *ISOTime `bson:"publishedAt" json:"publishedAt"`
	SortAt      ISOTime  `bson:"sortAt" json:"sortAt"`
	CreatedAt   ISOTime  `bson:"createdAt" json:"createdAt"`
	UpdatedAt   ISOTime  `bson:"updatedAt" json:"updatedAt"`
}

// ReadModelDocument is one Mongo itemreadmodels document.
type ReadModelDocument struct {
	MongoID             string                 `bson:"_id,omitempty" json:"_id,omitempty"`
	OrgID               string                 `bson:"orgId" json:"orgId"`
	ItemMetaID          string                 `bson:"itemMetaId" json:"itemMetaId"`
	Meta                ReadModelMetaDoc       `bson:"meta" json:"meta"`
	Raw                 *ReadModelRawDoc       `bson:"raw" json:"raw"`
	Processed           *ReadModelProcessedDoc `bson:"processed" json:"processed"`
	ExternalID          string                 `bson:"externalId" json:"externalId"`
	ExternalIDLower     string                 `bson:"externalIdLower" json:"externalIdLower"`
	Title               string                 `bson:"title" json:"title"`
	TitleLower          string                 `bson:"titleLower" json:"titleLower"`
	Status              string                 `bson:"status" json:"status"`
	IngestedAt          ISOTime                `bson:"ingestedAt" json:"ingestedAt"`
	CreatedAt           ISOTime                `bson:"createdAt" json:"createdAt"`
	UpdatedAt           ISOTime                `bson:"updatedAt" json:"updatedAt"`
	PublishedAt         *ISOTime               `bson:"publishedAt" json:"publishedAt"`
	SortAt              ISOTime                `bson:"sortAt" json:"sortAt"`
	SourceID            *string                `bson:"sourceId" json:"sourceId"`
	SourceName          *string                `bson:"sourceName" json:"sourceName"`
	SourceNameLower     *string                `bson:"sourceNameLower" json:"sourceNameLower"`
	URL                 *string                `bson:"url" json:"url"`
	Thumbnail           *string                `bson:"thumbnail" json:"thumbnail"`
	Domain              *string                `bson:"domain" json:"domain"`
	Language            *string                `bson:"language" json:"language"`
	Summary             *string                `bson:"summary" json:"summary"`
	Topics              []string               `bson:"topics" json:"topics"`
	TopicKeys           []string               `bson:"topicKeys" json:"topicKeys"`
	Entities            []string               `bson:"entities" json:"entities"`
	EntityKeys          []string               `bson:"entityKeys" json:"entityKeys"`
	Region              *string                `bson:"region" json:"region"`
	RegionKey           *string                `bson:"regionKey" json:"regionKey"`
	Location            *string                `bson:"location" json:"location"`
	LocationKey         *string                `bson:"locationKey" json:"locationKey"`
	Sentiment           *string                `bson:"sentiment" json:"sentiment"`
	ContentType         *string                `bson:"contentType" json:"contentType"`
	QualityScore        *float64               `bson:"qualityScore" json:"qualityScore"`
	DuplicateOf         *string                `bson:"duplicateOf" json:"duplicateOf"`
	DuplicateSimilarity *float64               `bson:"duplicateSimilarity" json:"duplicateSimilarity"`
	Tags                []string               `bson:"tags" json:"tags"`
	HasVector           bool                   `bson:"hasVector" json:"hasVector"`
	EmbeddingModel      *string                `bson:"embeddingModel" json:"embeddingModel"`
	SearchText          string                 `bson:"searchText" json:"searchText"`
	SearchTerms         []string               `bson:"searchTerms" json:"searchTerms"`
	ProjectionUpdatedAt ISOTime                `bson:"projectionUpdatedAt" json:"projectionUpdatedAt"`
}

// ItemMetaRowFromReadModel projects a read-model document onto the shared
// ItemMetaRow shape, mirroring ItemsReadModelService.itemMetaRowFromReadModel.
func ItemMetaRowFromReadModel(doc ReadModelDocument) ItemMetaRow {
	sortAt := doc.Meta.SortAt
	if sortAt.IsZero() {
		sortAt = doc.Meta.CreatedAt
	}
	return ItemMetaRow{
		ID:          doc.Meta.ID,
		OrgID:       doc.OrgID,
		ExternalID:  doc.Meta.ExternalID,
		Name:        doc.Meta.Name,
		Status:      doc.Meta.Status,
		MongoRef:    doc.Meta.MongoRef,
		Version:     doc.Meta.Version,
		PublishedAt: doc.Meta.PublishedAt,
		SortAt:      sortAt,
		CreatedAt:   doc.Meta.CreatedAt,
		UpdatedAt:   doc.Meta.UpdatedAt,
	}
}

// ItemDetail is the GET /api/items/:id envelope. RawItem and Processed hold a
// JSON token because the legacy Mongoose echo and the read-model snapshot
// shapes are deliberately different (see the batch notes); each variant is
// produced by a typed struct, never by an untyped map.
type ItemDetail struct {
	ItemMeta  ItemMetaRow
	RawItem   json.RawMessage
	Processed json.RawMessage
}

// MarshalJSON implements json.Marshaler for the envelope.
func (d ItemDetail) MarshalJSON() ([]byte, error) {
	raw := d.RawItem
	if len(raw) == 0 {
		raw = json.RawMessage("null")
	}
	processed := d.Processed
	if len(processed) == 0 {
		processed = json.RawMessage("null")
	}
	out := make([]byte, 0, 256)
	out = append(out, `{"itemMeta":`...)
	meta, err := json.Marshal(d.ItemMeta)
	if err != nil {
		return nil, err
	}
	out = append(out, meta...)
	out = append(out, `,"rawItem":`...)
	out = append(out, raw...)
	out = append(out, `,"processed":`...)
	out = append(out, processed...)
	out = append(out, '}')
	return out, nil
}

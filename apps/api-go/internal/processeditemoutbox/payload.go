package processeditemoutbox

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
)

// Payload is the validated processed_item MongoOutbox envelope. Its shape and
// defaults mirror ProcessedItemOutboxPayloadSchema in news-pipeline-internal.ts.
type Payload struct {
	Type     string   `json:"type"`
	Document Document `json:"document"`
}

// Document is the ProcessedItem snapshot carried by the outbox row.
type Document struct {
	ID                    string
	RawItemID             string
	ItemMetaID            string
	OrgID                 string
	SourceID              *string
	Status                string
	Tags                  []string
	Result                CleanedNews
	LLM                   LLMMetadata
	SummaryEmbedding      []float64
	SummaryEmbeddingSet   bool
	SummaryEmbeddingModel *string
	DuplicateOf           *string
	DuplicateSimilarity   *float64
	Error                 json.RawMessage
	ErrorSet              bool
}

// LLMMetadata is the llm sub-document of a processed item. Every member is
// present in the stored document; a missing or non-conforming input becomes
// null, exactly like LlmCallMetadataSchema's nullable preprocessors.
type LLMMetadata struct {
	Model            *string  `json:"model" bson:"model"`
	PromptVersion    *string  `json:"promptVersion" bson:"promptVersion"`
	PromptTokens     *float64 `json:"promptTokens" bson:"promptTokens"`
	CompletionTokens *float64 `json:"completionTokens" bson:"completionTokens"`
	TotalTokens      *float64 `json:"totalTokens" bson:"totalTokens"`
	CostUSD          *float64 `json:"costUsd" bson:"costUsd"`
	LatencyMs        *float64 `json:"latencyMs" bson:"latencyMs"`
}

// CleanedNews is the normalized CleanedNewsSchema result. Nullable scalar
// members are written as null when absent, matching the Mongoose result
// sub-schema defaults. Arrays are always emitted with their schema defaults.
type CleanedNews struct {
	Title                 *string                   `json:"title" bson:"title"`
	Subtitle              *string                   `json:"subtitle" bson:"subtitle"`
	Author                *string                   `json:"author" bson:"author"`
	Source                *string                   `json:"source" bson:"source"`
	PublishedAt           *string                   `json:"published_at" bson:"published_at"`
	Language              *string                   `json:"language" bson:"language"`
	Location              *string                   `json:"location" bson:"location"`
	Category              *string                   `json:"category" bson:"category"`
	ContentType           *string                   `json:"content_type" bson:"content_type"`
	CategoryPath          *string                   `json:"category_path" bson:"category_path"`
	CategoryLabels        []string                  `json:"category_labels" bson:"category_labels"`
	CategoryConfidence    *float64                  `json:"category_confidence" bson:"category_confidence"`
	CategoryReason        *string                   `json:"category_reason" bson:"category_reason"`
	CategoryMethod        *string                   `json:"category_method" bson:"category_method"`
	CategoryCandidates    []ClassificationCandidate `json:"category_candidates" bson:"category_candidates"`
	Sentiment             *string                   `json:"sentiment" bson:"sentiment"`
	SentimentLabel        *string                   `json:"sentiment_label" bson:"sentiment_label"`
	Topics                []string                  `json:"topics" bson:"topics"`
	Summary               *string                   `json:"summary" bson:"summary"`
	KeyPoints             []string                  `json:"key_points" bson:"key_points"`
	Entities              []Entity                  `json:"entities" bson:"entities"`
	KGRelations           []KGRelation              `json:"kg_relations" bson:"kg_relations"`
	StageMeta             *StageMeta                `json:"stage_meta,omitempty" bson:"stage_meta,omitempty"`
	CleanedMarkdown       string                    `json:"cleaned_markdown" bson:"cleaned_markdown"`
	CleanedMarkdownSource *string                   `json:"cleaned_markdown_source,omitempty" bson:"cleaned_markdown_source,omitempty"`
	RemovedNoiseTypes     []string                  `json:"removed_noise_types" bson:"removed_noise_types"`
	QualityScore          *float64                  `json:"quality_score" bson:"quality_score"`
	LLMModel              *string                   `json:"llm_model" bson:"llm_model"`
	LLMPromptVersion      *string                   `json:"llm_prompt_version" bson:"llm_prompt_version"`
}

// ClassificationCandidate is one category_candidates member.
type ClassificationCandidate struct {
	Path           string  `json:"path" bson:"path"`
	Score          float64 `json:"score" bson:"score"`
	LegacyCategory string  `json:"legacy_category" bson:"legacy_category"`
	Reason         *string `json:"reason" bson:"reason"`
}

// Entity is one entities member.
type Entity struct {
	Name       string  `json:"name" bson:"name"`
	Type       string  `json:"type" bson:"type"`
	Confidence float64 `json:"confidence" bson:"confidence"`
}

// KGRelation is one kg_relations member.
type KGRelation struct {
	Subject    KGEntityRef     `json:"subject" bson:"subject"`
	Predicate  string          `json:"predicate" bson:"predicate"`
	Object     KGEntityRef     `json:"object" bson:"object"`
	Confidence float64         `json:"confidence" bson:"confidence"`
	Properties json.RawMessage `json:"properties,omitempty" bson:"properties,omitempty"`
	Evidence   *string         `json:"evidence,omitempty" bson:"evidence,omitempty"`
}

// KGEntityRef is a knowledge-graph entity reference.
type KGEntityRef struct {
	Name string `json:"name" bson:"name"`
	Type string `json:"type" bson:"type"`
}

// StageMeta is the optional stage_meta object. It stays an open Mongo Mixed
// leaf; the typed entries only validate and normalize the fixed stage keys.
type StageMeta struct {
	Preflight   *StageMetaEntry `json:"preflight,omitempty" bson:"preflight,omitempty"`
	Clean       *StageMetaEntry `json:"clean,omitempty" bson:"clean,omitempty"`
	QualityGate *StageMetaEntry `json:"quality_gate,omitempty" bson:"quality_gate,omitempty"`
	Entities    *StageMetaEntry `json:"entities,omitempty" bson:"entities,omitempty"`
	Sentiment   *StageMetaEntry `json:"sentiment,omitempty" bson:"sentiment,omitempty"`
	KG          *StageMetaEntry `json:"kg,omitempty" bson:"kg,omitempty"`
	Classify    *StageMetaEntry `json:"classify,omitempty" bson:"classify,omitempty"`
	Dedupe      *StageMetaEntry `json:"dedupe,omitempty" bson:"dedupe,omitempty"`
}

// StageMetaEntry is one stage metadata entry.
type StageMetaEntry struct {
	Status           string   `json:"status" bson:"status"`
	Provider         *string  `json:"provider,omitempty" bson:"provider,omitempty"`
	Reason           *string  `json:"reason,omitempty" bson:"reason,omitempty"`
	Model            *string  `json:"model,omitempty" bson:"model,omitempty"`
	PromptVersion    *string  `json:"prompt_version,omitempty" bson:"prompt_version,omitempty"`
	PromptTokens     *float64 `json:"prompt_tokens,omitempty" bson:"prompt_tokens,omitempty"`
	CompletionTokens *float64 `json:"completion_tokens,omitempty" bson:"completion_tokens,omitempty"`
	TotalTokens      *float64 `json:"total_tokens,omitempty" bson:"total_tokens,omitempty"`
	CostUSD          *float64 `json:"cost_usd,omitempty" bson:"cost_usd,omitempty"`
	LatencyMs        *float64 `json:"latency_ms,omitempty" bson:"latency_ms,omitempty"`
}

// ParsePayload validates the outbox JSON with the same field-level constraints
// as ProcessedItemOutboxPayloadSchema and returns the normalized snapshot.
func ParsePayload(raw []byte) (*Payload, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, errors.New("empty payload")
	}
	var envelope rawPayload
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if envelope.Type == nil || *envelope.Type != "processed_item" {
		return nil, errors.New("type must be processed_item")
	}
	if envelope.Document == nil {
		return nil, errors.New("document is required")
	}
	document, err := envelope.Document.normalize()
	if err != nil {
		return nil, err
	}
	return &Payload{Type: "processed_item", Document: document}, nil
}

type rawPayload struct {
	Type     *string      `json:"type"`
	Document *rawDocument `json:"document"`
}

type rawDocument struct {
	ID                    *string              `json:"_id"`
	RawItemID             *string              `json:"rawItemId"`
	ItemMetaID            *string              `json:"itemMetaId"`
	OrgID                 *string              `json:"orgId"`
	SourceID              optionalStringValue  `json:"sourceId"`
	Status                *string              `json:"status"`
	Tags                  requiredStringArray  `json:"tags"`
	Result                *rawCleanedNews      `json:"result"`
	LLM                   *rawLLMMetadata      `json:"llm"`
	SummaryEmbedding      optionalEmbedding    `json:"summaryEmbedding"`
	SummaryEmbeddingModel optionalStringValue  `json:"summaryEmbeddingModel"`
	DuplicateOf           optionalStringValue  `json:"duplicateOf"`
	DuplicateSimilarity   optionalFiniteNumber `json:"duplicateSimilarity"`
	Error                 optionalRawValue     `json:"error"`
}

func (d *rawDocument) normalize() (Document, error) {
	if d.ID == nil || d.RawItemID == nil || d.ItemMetaID == nil || d.OrgID == nil {
		return Document{}, errors.New("document ids are required")
	}
	if d.Status == nil || *d.Status != "completed" {
		return Document{}, errors.New("document.status must be completed")
	}
	if d.Result == nil {
		return Document{}, errors.New("document.result is required")
	}
	if d.LLM == nil {
		return Document{}, errors.New("document.llm is required")
	}
	result, err := d.Result.normalize()
	if err != nil {
		return Document{}, err
	}
	tags := d.Tags.Value
	if tags == nil {
		tags = []string{}
	}
	return Document{
		ID:                    *d.ID,
		RawItemID:             *d.RawItemID,
		ItemMetaID:            *d.ItemMetaID,
		OrgID:                 *d.OrgID,
		SourceID:              d.SourceID.Value,
		Status:                *d.Status,
		Tags:                  tags,
		Result:                result,
		LLM:                   d.LLM.normalize(),
		SummaryEmbedding:      d.SummaryEmbedding.Value,
		SummaryEmbeddingSet:   d.SummaryEmbedding.Set,
		SummaryEmbeddingModel: d.SummaryEmbeddingModel.Value,
		DuplicateOf:           d.DuplicateOf.Value,
		DuplicateSimilarity:   d.DuplicateSimilarity.Value,
		Error:                 d.Error.Value,
		ErrorSet:              d.Error.Set,
	}, nil
}

// optionalStringValue mirrors NullableStringSchema's preprocess: a string is
// kept (including the empty string), anything else becomes null.
type optionalStringValue struct {
	Set   bool
	Value *string
}

func (o *optionalStringValue) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		o.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		o.Value = nil
		return nil
	}
	o.Value = &value
	return nil
}

// looseString is the required nullable member form: missing or any non-string
// becomes null.
type looseString struct {
	Value *string
}

func (o *looseString) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		o.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		o.Value = nil
		return nil
	}
	o.Value = &value
	return nil
}

// looseNumber mirrors NullableFiniteNumberSchema: a finite JSON number is
// kept, anything else becomes null.
type looseNumber struct {
	Value *float64
}

func (o *looseNumber) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		o.Value = nil
		return nil
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		o.Value = nil
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var number json.Number
	if err := decoder.Decode(&number); err != nil {
		o.Value = nil
		return nil
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		o.Value = nil
		return nil
	}
	o.Value = &value
	return nil
}

// optionalFiniteNumber mirrors the optional nullable number preprocess: a
// finite number is kept; anything else is absent.
type optionalFiniteNumber struct {
	Set   bool
	Value *float64
}

func (o *optionalFiniteNumber) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		o.Value = nil
		return nil
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		o.Value = nil
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var number json.Number
	if err := decoder.Decode(&number); err != nil {
		o.Value = nil
		return nil
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		o.Value = nil
		return nil
	}
	o.Value = &value
	return nil
}

// optionalEmbedding mirrors OptionalNumberArraySchema: only arrays are kept,
// and every element must be a finite number.
type optionalEmbedding struct {
	Set   bool
	Value []float64
}

func (o *optionalEmbedding) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '[' {
		o.Value = nil
		return nil
	}
	var values []float64
	if err := json.Unmarshal(trimmed, &values); err != nil {
		return err
	}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return errors.New("summaryEmbedding contains a non-finite number")
		}
	}
	if values == nil {
		values = []float64{}
	}
	o.Value = values
	return nil
}

// optionalRawValue keeps an unknown JSON leaf byte-exact.
type optionalRawValue struct {
	Set   bool
	Value json.RawMessage
}

func (o *optionalRawValue) UnmarshalJSON(data []byte) error {
	o.Set = true
	o.Value = append(json.RawMessage(nil), data...)
	return nil
}

// requiredStringArray is z.array(z.string()): null and non-arrays fail.
type requiredStringArray struct {
	Set   bool
	Value []string
}

func (o *requiredStringArray) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '[' {
		return errors.New("expected an array of strings")
	}
	if err := json.Unmarshal(trimmed, &o.Value); err != nil {
		return err
	}
	return nil
}

// nonEmptyStringArray is the min(1) string array used by the result schema.
type nonEmptyStringArray struct {
	Set   bool
	Value []string
}

func (o *nonEmptyStringArray) UnmarshalJSON(data []byte) error {
	var values requiredStringArray
	if err := values.UnmarshalJSON(data); err != nil {
		return err
	}
	for _, value := range values.Value {
		if len(value) == 0 {
			return errors.New("array item must not be empty")
		}
	}
	o.Set = true
	o.Value = values.Value
	return nil
}

type rawCleanedNews struct {
	Title                 *string                   `json:"title"`
	Subtitle              *string                   `json:"subtitle"`
	Author                *string                   `json:"author"`
	Source                *string                   `json:"source"`
	PublishedAt           optionalTransformedString `json:"published_at"`
	Language              *string                   `json:"language"`
	Location              *string                   `json:"location"`
	Category              *string                   `json:"category"`
	ContentType           optionalTransformedString `json:"content_type"`
	CategoryPath          *string                   `json:"category_path"`
	CategoryLabels        nonEmptyStringArray       `json:"category_labels"`
	CategoryConfidence    *float64                  `json:"category_confidence"`
	CategoryReason        *string                   `json:"category_reason"`
	CategoryMethod        *string                   `json:"category_method"`
	CategoryCandidates    classificationList        `json:"category_candidates"`
	Sentiment             optionalTransformedString `json:"sentiment"`
	SentimentLabel        optionalTransformedString `json:"sentiment_label"`
	Topics                nonEmptyStringArray       `json:"topics"`
	Summary               *string                   `json:"summary"`
	KeyPoints             nonEmptyStringArray       `json:"key_points"`
	Entities              entityList                `json:"entities"`
	KGRelations           kgRelationList            `json:"kg_relations"`
	StageMeta             optionalStageMeta         `json:"stage_meta"`
	CleanedMarkdown       *string                   `json:"cleaned_markdown"`
	CleanedMarkdownSource optionalTransformedString `json:"cleaned_markdown_source"`
	RemovedNoiseTypes     nonEmptyStringArray       `json:"removed_noise_types"`
	QualityScore          *float64                  `json:"quality_score"`
	LLMModel              *string                   `json:"llm_model"`
	LLMPromptVersion      *string                   `json:"llm_prompt_version"`
}

func (r *rawCleanedNews) normalize() (CleanedNews, error) {
	if r.CleanedMarkdown == nil || len(*r.CleanedMarkdown) == 0 {
		return CleanedNews{}, errors.New("cleaned_markdown is required")
	}
	if r.CategoryConfidence != nil && !validProbability(*r.CategoryConfidence) {
		return CleanedNews{}, errors.New("category_confidence must be between 0 and 1")
	}
	if r.QualityScore != nil && !validProbability(*r.QualityScore) {
		return CleanedNews{}, errors.New("quality_score must be between 0 and 1")
	}
	publishedAt := r.PublishedAt.Value
	if publishedAt != nil {
		publishedAt = normalizeISODateTime(*publishedAt)
	}
	contentType := normalizeContentTypePointer(r.ContentType.Value)
	sentiment := normalizeSentimentPointer(r.Sentiment.Value)
	sentimentLabel := normalizeSentimentPointer(r.SentimentLabel.Value)
	var markdownSource *string
	if r.CleanedMarkdownSource.Value != nil {
		switch *r.CleanedMarkdownSource.Value {
		case "llm", "crawl_fallback":
			value := *r.CleanedMarkdownSource.Value
			markdownSource = &value
		}
	}
	categoryLabels := r.CategoryLabels.Value
	if categoryLabels == nil {
		categoryLabels = []string{}
	}
	topics := r.Topics.Value
	if topics == nil {
		topics = []string{}
	}
	keyPoints := r.KeyPoints.Value
	if keyPoints == nil {
		keyPoints = []string{}
	}
	candidates := r.CategoryCandidates.Value
	if candidates == nil {
		candidates = []ClassificationCandidate{}
	}
	entities := r.Entities.Value
	if entities == nil {
		entities = []Entity{}
	}
	relations := r.KGRelations.Value
	if relations == nil {
		relations = []KGRelation{}
	}
	noise := r.RemovedNoiseTypes.Value
	if noise == nil {
		noise = []string{}
	}
	return CleanedNews{
		Title:                 r.Title,
		Subtitle:              r.Subtitle,
		Author:                r.Author,
		Source:                r.Source,
		PublishedAt:           publishedAt,
		Language:              r.Language,
		Location:              r.Location,
		Category:              r.Category,
		ContentType:           contentType,
		CategoryPath:          r.CategoryPath,
		CategoryLabels:        categoryLabels,
		CategoryConfidence:    r.CategoryConfidence,
		CategoryReason:        r.CategoryReason,
		CategoryMethod:        r.CategoryMethod,
		CategoryCandidates:    candidates,
		Sentiment:             sentiment,
		SentimentLabel:        sentimentLabel,
		Topics:                topics,
		Summary:               r.Summary,
		KeyPoints:             keyPoints,
		Entities:              entities,
		KGRelations:           relations,
		StageMeta:             r.StageMeta.Value,
		CleanedMarkdown:       *r.CleanedMarkdown,
		CleanedMarkdownSource: markdownSource,
		RemovedNoiseTypes:     noise,
		QualityScore:          r.QualityScore,
		LLMModel:              r.LLMModel,
		LLMPromptVersion:      r.LLMPromptVersion,
	}, nil
}

// optionalTransformedString keeps only string inputs and records absence for
// everything else, matching the transform-based optional schemas.
type optionalTransformedString struct {
	Set   bool
	Value *string
}

func (o *optionalTransformedString) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		o.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		o.Value = nil
		return nil
	}
	o.Value = &value
	return nil
}

type rawClassificationCandidate struct {
	Path           *string  `json:"path"`
	Score          *float64 `json:"score"`
	LegacyCategory *string  `json:"legacy_category"`
	Reason         *string  `json:"reason"`
}

type classificationList struct {
	Set   bool
	Value []ClassificationCandidate
}

func (o *classificationList) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '[' {
		return errors.New("category_candidates must be an array")
	}
	var raw []rawClassificationCandidate
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return err
	}
	out := make([]ClassificationCandidate, 0, len(raw))
	for _, entry := range raw {
		if entry.Path == nil || len(*entry.Path) == 0 || entry.LegacyCategory == nil || len(*entry.LegacyCategory) == 0 {
			return errors.New("category candidate path/legacy_category are required")
		}
		if entry.Score == nil || !validProbability(*entry.Score) {
			return errors.New("category candidate score must be between 0 and 1")
		}
		out = append(out, ClassificationCandidate{
			Path: *entry.Path, Score: *entry.Score, LegacyCategory: *entry.LegacyCategory, Reason: entry.Reason,
		})
	}
	o.Value = out
	return nil
}

type rawEntity struct {
	Name       *string  `json:"name"`
	Type       *string  `json:"type"`
	Confidence *float64 `json:"confidence"`
}

type entityList struct {
	Set   bool
	Value []Entity
}

func (o *entityList) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '[' {
		return errors.New("entities must be an array")
	}
	var raw []rawEntity
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return err
	}
	out := make([]Entity, 0, len(raw))
	for _, entry := range raw {
		if entry.Name == nil || len(*entry.Name) == 0 || entry.Type == nil || len(*entry.Type) == 0 {
			return errors.New("entity name/type are required")
		}
		if entry.Confidence == nil || !validProbability(*entry.Confidence) {
			return errors.New("entity confidence must be between 0 and 1")
		}
		out = append(out, Entity{Name: *entry.Name, Type: *entry.Type, Confidence: *entry.Confidence})
	}
	o.Value = out
	return nil
}

type rawKGEntityRef struct {
	Name *string `json:"name"`
	Type *string `json:"type"`
}

type rawKGRelation struct {
	Subject    *rawKGEntityRef `json:"subject"`
	Predicate  *string         `json:"predicate"`
	Object     *rawKGEntityRef `json:"object"`
	Confidence *float64        `json:"confidence"`
	Properties optionalObject  `json:"properties"`
	Evidence   *string         `json:"evidence"`
}

type kgRelationList struct {
	Set   bool
	Value []KGRelation
}

func (o *kgRelationList) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '[' {
		return errors.New("kg_relations must be an array")
	}
	var raw []rawKGRelation
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return err
	}
	out := make([]KGRelation, 0, len(raw))
	for _, entry := range raw {
		if entry.Subject == nil || entry.Subject.Name == nil || len(*entry.Subject.Name) == 0 ||
			entry.Subject.Type == nil || len(*entry.Subject.Type) == 0 {
			return errors.New("kg relation subject is invalid")
		}
		if entry.Object == nil || entry.Object.Name == nil || len(*entry.Object.Name) == 0 ||
			entry.Object.Type == nil || len(*entry.Object.Type) == 0 {
			return errors.New("kg relation object is invalid")
		}
		if entry.Predicate == nil || len(*entry.Predicate) == 0 {
			return errors.New("kg relation predicate is required")
		}
		if entry.Confidence == nil || !validProbability(*entry.Confidence) {
			return errors.New("kg relation confidence must be between 0 and 1")
		}
		out = append(out, KGRelation{
			Subject:    KGEntityRef{Name: *entry.Subject.Name, Type: *entry.Subject.Type},
			Predicate:  *entry.Predicate,
			Object:     KGEntityRef{Name: *entry.Object.Name, Type: *entry.Object.Type},
			Confidence: *entry.Confidence,
			Properties: entry.Properties.Value,
			Evidence:   entry.Evidence,
		})
	}
	o.Value = out
	return nil
}

// optionalObject keeps only JSON objects, matching optionalJsonObject.
type optionalObject struct {
	Set   bool
	Value json.RawMessage
}

func (o *optionalObject) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	o.Set = true
	o.Value = append(json.RawMessage(nil), trimmed...)
	return nil
}

type optionalStageMeta struct {
	Set   bool
	Value *StageMeta
}

func (o *optionalStageMeta) UnmarshalJSON(data []byte) error {
	o.Set = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '{' {
		return errors.New("stage_meta must be an object")
	}
	var raw mapStageMeta
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return err
	}
	meta, err := raw.normalize()
	if err != nil {
		return err
	}
	o.Value = meta
	return nil
}

type mapStageMeta struct {
	Preflight   json.RawMessage `json:"preflight"`
	Clean       json.RawMessage `json:"clean"`
	QualityGate json.RawMessage `json:"quality_gate"`
	Entities    json.RawMessage `json:"entities"`
	Sentiment   json.RawMessage `json:"sentiment"`
	KG          json.RawMessage `json:"kg"`
	Classify    json.RawMessage `json:"classify"`
	Dedupe      json.RawMessage `json:"dedupe"`
}

func (m mapStageMeta) normalize() (*StageMeta, error) {
	meta := &StageMeta{}
	entries := []struct {
		target **StageMetaEntry
		raw    json.RawMessage
	}{
		{&meta.Preflight, m.Preflight},
		{&meta.Clean, m.Clean},
		{&meta.QualityGate, m.QualityGate},
		{&meta.Entities, m.Entities},
		{&meta.Sentiment, m.Sentiment},
		{&meta.KG, m.KG},
		{&meta.Classify, m.Classify},
		{&meta.Dedupe, m.Dedupe},
	}
	for _, entry := range entries {
		if len(bytes.TrimSpace(entry.raw)) == 0 {
			continue
		}
		trimmed := bytes.TrimSpace(entry.raw)
		if string(trimmed) == "null" || trimmed[0] != '{' {
			return nil, errors.New("stage_meta entry must be an object")
		}
		var raw rawStageEntry
		if err := json.Unmarshal(trimmed, &raw); err != nil {
			return nil, err
		}
		normalized, err := raw.normalize()
		if err != nil {
			return nil, err
		}
		*entry.target = normalized
	}
	return meta, nil
}

type rawStageEntry struct {
	Status           *string  `json:"status"`
	Provider         *string  `json:"provider"`
	Reason           *string  `json:"reason"`
	Model            *string  `json:"model"`
	PromptVersion    *string  `json:"prompt_version"`
	PromptTokens     *float64 `json:"prompt_tokens"`
	CompletionTokens *float64 `json:"completion_tokens"`
	TotalTokens      *float64 `json:"total_tokens"`
	CostUSD          *float64 `json:"cost_usd"`
	LatencyMs        *float64 `json:"latency_ms"`
}

func (r rawStageEntry) normalize() (*StageMetaEntry, error) {
	if r.Status == nil {
		return nil, errors.New("stage_meta status is required")
	}
	switch *r.Status {
	case "completed", "skipped", "rejected", "failed":
	default:
		return nil, fmt.Errorf("invalid stage_meta status %q", *r.Status)
	}
	return &StageMetaEntry{
		Status: *r.Status, Provider: r.Provider, Reason: r.Reason, Model: r.Model,
		PromptVersion: r.PromptVersion, PromptTokens: r.PromptTokens,
		CompletionTokens: r.CompletionTokens, TotalTokens: r.TotalTokens,
		CostUSD: r.CostUSD, LatencyMs: r.LatencyMs,
	}, nil
}

type rawLLMMetadata struct {
	Model            looseString `json:"model"`
	PromptVersion    looseString `json:"promptVersion"`
	PromptTokens     looseNumber `json:"promptTokens"`
	CompletionTokens looseNumber `json:"completionTokens"`
	TotalTokens      looseNumber `json:"totalTokens"`
	CostUSD          looseNumber `json:"costUsd"`
	LatencyMs        looseNumber `json:"latencyMs"`
}

func (m *rawLLMMetadata) normalize() LLMMetadata {
	return LLMMetadata{
		Model: m.Model.Value, PromptVersion: m.PromptVersion.Value,
		PromptTokens: m.PromptTokens.Value, CompletionTokens: m.CompletionTokens.Value,
		TotalTokens: m.TotalTokens.Value, CostUSD: m.CostUSD.Value, LatencyMs: m.LatencyMs.Value,
	}
}

// normalizeISODateTime mirrors optionalNullableIsoDateTimeString: invalid or
// blank values become null, and a valid value is rendered with JavaScript's
// Date.prototype.toISOString shape.
func normalizeISODateTime(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	parsed, ok := parseDateTimeValue(trimmed)
	if !ok {
		return nil
	}
	formatted := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
	return &formatted
}

// parseDateTimeValue accepts the ISO forms generated by the pipeline and the
// common fallback layouts accepted by @modular/utils parseDateTime.
func parseDateTimeValue(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func normalizeContentTypePointer(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := normalizeNewsContentType(*value)
	if normalized == "" {
		return nil
	}
	return stringPointer(normalized)
}

// normalizeNewsContentType ports normalizeNewsContentType from
// news-content-type.ts.
func normalizeNewsContentType(value string) string {
	normalized := sanitizeContentTypeToken(value)
	if normalized == "" {
		return ""
	}
	if mapped, ok := contentTypeAliases[normalized]; ok {
		return mapped
	}
	return ""
}

var contentTypeAliases = map[string]string{
	"news_fact": "news_fact", "news-fact": "news_fact", "newsfact": "news_fact",
	"fact": "news_fact", "factual": "news_fact", "report": "news_fact",
	"reporting": "news_fact", "hard_news": "news_fact", "straight_news": "news_fact",
	"新闻事实": "news_fact", "事实": "news_fact", "事实报道": "news_fact",
	"资讯": "news_fact", "快讯": "news_fact",
	"opinion": "opinion", "op-ed": "opinion", "oped": "opinion",
	"editorial": "opinion", "commentary": "opinion", "column": "opinion",
	"观点": "opinion", "评论": "opinion", "社论": "opinion", "专栏": "opinion",
	"analysis": "analysis", "analytical": "analysis", "explainer": "analysis",
	"deep_dive": "analysis", "解读": "analysis", "分析": "analysis",
	"研判": "analysis", "复盘": "analysis",
	"mixed": "mixed", "hybrid": "mixed", "mixed_content": "mixed",
	"mixed-content": "mixed", "综合": "mixed", "混合": "mixed",
	"事实+观点": "mixed", "fact_and_opinion": "mixed",
}

func sanitizeContentTypeToken(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	trimmed = collapseWhitespaceToUnderscore(trimmed)
	var builder strings.Builder
	builder.Grow(len(trimmed))
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '+' ||
			(r >= '\u4e00' && r <= '\u9fff') {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func collapseWhitespaceToUnderscore(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	inSpace := false
	for _, r := range value {
		if unicode.IsSpace(r) {
			if !inSpace {
				builder.WriteByte('_')
				inSpace = true
			}
			continue
		}
		inSpace = false
		builder.WriteRune(r)
	}
	return builder.String()
}

func normalizeSentimentPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	normalized := strings.ToLower(trimmed)
	switch {
	case normalized == "positive" || strings.HasPrefix(normalized, "pos") ||
		strings.Contains(normalized, "正面") || strings.Contains(normalized, "积极") || strings.Contains(normalized, "利好"):
		return stringPointer("positive")
	case normalized == "negative" || strings.HasPrefix(normalized, "neg") ||
		strings.Contains(normalized, "负面") || strings.Contains(normalized, "消极") || strings.Contains(normalized, "利空"):
		return stringPointer("negative")
	case normalized == "neutral" || strings.HasPrefix(normalized, "neu") ||
		strings.Contains(normalized, "中性") || strings.Contains(normalized, "中立"):
		return stringPointer("neutral")
	default:
		return stringPointer(normalized)
	}
}

func validProbability(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func stringPointer(value string) *string {
	return &value
}

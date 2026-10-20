package newsclassifier

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

// orderedObject preserves the stored ProcessedItem.result member order and any
// extension members while the known classification fields are replaced.
type orderedObject struct {
	keys   []string
	values map[string]json.RawMessage
}

func parseOrderedObject(raw json.RawMessage) (*orderedObject, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errors.New("result is not a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("result is not a JSON object")
	}
	object := &orderedObject{values: map[string]json.RawMessage{}}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("result member name is not a string")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if _, exists := object.values[key]; !exists {
			object.keys = append(object.keys, key)
		}
		object.values[key] = value
	}
	return object, nil
}

func (o *orderedObject) set(key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, exists := o.values[key]; !exists {
		*o = orderedObject{keys: append(o.keys, key), values: o.values}
	}
	o.values[key] = encoded
	return nil
}

func (o *orderedObject) raw(key string) (json.RawMessage, bool) {
	value, ok := o.values[key]
	return value, ok
}

func (o *orderedObject) marshal() (json.RawMessage, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		buffer.Write(o.values[key])
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// StoredCleanedNews is the validated ProcessedItem.result projection.
type StoredCleanedNews struct {
	document       *orderedObject
	Title          string
	Subtitle       string
	Summary        string
	Source         string
	Language       string
	Topics         []string
	KeyPoints      []string
	ContentType    string
	Category       string
	CategoryPath   string
	CategoryMethod string
	Location       string
}

// ParseStoredCleanedNews mirrors CleanedNewsSchema.safeParse: an invalid document
// is a skip, and the parsed projection carries the members the classifier needs.
func ParseStoredCleanedNews(raw json.RawMessage) (*StoredCleanedNews, bool) {
	document, err := parseOrderedObject(raw)
	if err != nil {
		return nil, false
	}
	var record rawCleanedNews
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, false
	}
	if record.CleanedMarkdown == nil || *record.CleanedMarkdown == "" {
		return nil, false
	}
	topics, ok := validateStringArray(record.Topics)
	if !ok {
		return nil, false
	}
	keyPoints, ok := validateStringArray(record.KeyPoints)
	if !ok {
		return nil, false
	}
	if _, ok := validateStringArray(record.CategoryLabels); !ok {
		return nil, false
	}
	if _, ok := validateStringArray(record.RemovedNoiseTypes); !ok {
		return nil, false
	}
	if !validOptionalUnitNumber(record.CategoryConfidence) || !validOptionalUnitNumber(record.QualityScore) {
		return nil, false
	}
	if !validCandidates(record.CategoryCandidates) || !validEntities(record.Entities) || !validKgRelations(record.KgRelations) {
		return nil, false
	}
	if !validStageMeta(record.StageMeta) {
		return nil, false
	}
	if !validNullableStringRaw(record.ContentType) || !validNullableStringRaw(record.Sentiment) ||
		!validNullableStringRaw(record.SentimentLabel) || !validNullableStringRaw(record.PublishedAt) {
		return nil, false
	}
	if !validMarkdownSource(record.CleanedMarkdownSource) {
		return nil, false
	}
	cleaned := &StoredCleanedNews{
		document:       document,
		Title:          stringPointerValue(record.Title),
		Subtitle:       stringPointerValue(record.Subtitle),
		Summary:        stringPointerValue(record.Summary),
		Source:         stringPointerValue(record.Source),
		Language:       stringPointerValue(record.Language),
		Topics:         topics,
		KeyPoints:      keyPoints,
		Category:       stringPointerValue(record.Category),
		CategoryPath:   normalizeStoredCategoryPath(stringPointerValue(record.CategoryPath)),
		CategoryMethod: normalizeStoredCategoryMethod(stringPointerValue(record.CategoryMethod)),
		Location:       stringPointerValue(record.Location),
	}
	if normalized, ok := archivereading.NormalizeNewsContentTypeValue(stringValueRaw(record.ContentType)); ok {
		cleaned.ContentType = normalized
	}
	return cleaned, true
}

// ResolveContentType applies resolveStoredContentTypeForBackfill.
func (c *StoredCleanedNews) ResolveContentType(sourceURL, sourceLabel string) {
	if c == nil {
		return
	}
	if _, ok := archivereading.NormalizeNewsContentTypeValue(c.ContentType); ok && c.ContentType != "" {
		return
	}
	source := c.Source
	if source == "" {
		source = sourceLabel
	}
	c.ContentType = archivereading.InferNewsContentTypeValue(
		c.Title, c.Summary, source, sourceURL, c.Topics, nil,
	)
}

// NeedsClassification reports the exact "has no content type and no category"
// condition the classifier backfill uses after content-type resolution.
func (c *StoredCleanedNews) NeedsClassification() bool {
	if c == nil {
		return false
	}
	hasContentType := c.ContentType != ""
	hasCategory := c.CategoryPath != "" || c.CategoryMethod != ""
	return !(hasContentType && hasCategory)
}

// ClassifierInput returns the CleanedNews projection.
func (c *StoredCleanedNews) ClassifierInput() CleanedNews {
	return CleanedNews{
		Title: c.Title, Subtitle: c.Subtitle, Summary: c.Summary,
		Source: c.Source, Language: c.Language, Topics: c.Topics, KeyPoints: c.KeyPoints,
	}
}

// ApplyToCleanedNews reproduces applyToCleanedNews while keeping unknown result
// members. content_type is written from the resolved value, exactly like the
// resolvedCleaned spread.
func (c *StoredCleanedNews) ApplyToCleanedNews(result Result) (json.RawMessage, error) {
	if c == nil || c.document == nil {
		return nil, errors.New("stored cleaned news is empty")
	}
	if err := c.document.set("content_type", nullableString(c.ContentType)); err != nil {
		return nil, err
	}
	category := result.LegacyCategory
	if category == "" {
		category = c.Category
	}
	if err := c.document.set("category", nullableString(category)); err != nil {
		return nil, err
	}
	var categoryPath any
	if result.CategoryPath != nil {
		categoryPath = *result.CategoryPath
	}
	if err := c.document.set("category_path", categoryPath); err != nil {
		return nil, err
	}
	labels := result.Labels
	if labels == nil {
		labels = []string{}
	}
	if err := c.document.set("category_labels", labels); err != nil {
		return nil, err
	}
	var confidence any
	if result.Confidence != nil {
		confidence = *result.Confidence
	}
	if err := c.document.set("category_confidence", confidence); err != nil {
		return nil, err
	}
	var reason any
	if result.Reason != nil {
		reason = *result.Reason
	}
	if err := c.document.set("category_reason", reason); err != nil {
		return nil, err
	}
	if err := c.document.set("category_method", result.Method); err != nil {
		return nil, err
	}
	candidates := make([]candidateDocument, 0, len(result.Candidates))
	for _, candidate := range result.Candidates {
		candidates = append(candidates, candidateDocument{
			Path: candidate.Path, Score: candidate.Score,
			LegacyCategory: candidate.LegacyCategory, Reason: candidate.Reason,
		})
	}
	if err := c.document.set("category_candidates", candidates); err != nil {
		return nil, err
	}
	return c.document.marshal()
}

// candidateDocument is the stored category candidate shape.
type candidateDocument struct {
	Path           string  `json:"path"`
	Score          float64 `json:"score"`
	LegacyCategory string  `json:"legacy_category"`
	Reason         *string `json:"reason"`
}

// HasLocation reproduces processedItemHasLocation.
func HasLocation(result json.RawMessage) bool {
	var document struct {
		Location *string `json:"location"`
	}
	if json.Unmarshal(result, &document) != nil || document.Location == nil {
		return false
	}
	return jsTrim(*document.Location) != ""
}

// ParseHasLocation reads the member from an already parsed document.
func (o *orderedObject) HasLocation() bool {
	raw, ok := o.raw("location")
	if !ok {
		return false
	}
	var value *string
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return false
	}
	return jsTrim(*value) != ""
}

// --- schema validation ---

type rawCleanedNews struct {
	Title                 *string          `json:"title"`
	Subtitle              *string          `json:"subtitle"`
	Author                *string          `json:"author"`
	Source                *string          `json:"source"`
	PublishedAt           json.RawMessage  `json:"published_at"`
	Language              *string          `json:"language"`
	Location              *string          `json:"location"`
	Category              *string          `json:"category"`
	ContentType           json.RawMessage  `json:"content_type"`
	CategoryPath          *string          `json:"category_path"`
	CategoryLabels        *[]string        `json:"category_labels"`
	CategoryConfidence    *float64         `json:"category_confidence"`
	CategoryReason        *string          `json:"category_reason"`
	CategoryMethod        *string          `json:"category_method"`
	CategoryCandidates    *[]rawCandidate  `json:"category_candidates"`
	Sentiment             json.RawMessage  `json:"sentiment"`
	SentimentLabel        json.RawMessage  `json:"sentiment_label"`
	Topics                *[]string        `json:"topics"`
	Summary               *string          `json:"summary"`
	KeyPoints             *[]string        `json:"key_points"`
	Entities              *[]rawEntity     `json:"entities"`
	KgRelations           *[]rawKgRelation `json:"kg_relations"`
	StageMeta             json.RawMessage  `json:"stage_meta"`
	CleanedMarkdown       *string          `json:"cleaned_markdown"`
	CleanedMarkdownSource json.RawMessage  `json:"cleaned_markdown_source"`
	RemovedNoiseTypes     *[]string        `json:"removed_noise_types"`
	QualityScore          *float64         `json:"quality_score"`
	LLMModel              *string          `json:"llm_model"`
	LLMPromptVersion      *string          `json:"llm_prompt_version"`
}

type rawCandidate struct {
	Path           *string  `json:"path"`
	Score          *float64 `json:"score"`
	LegacyCategory *string  `json:"legacy_category"`
	Reason         *string  `json:"reason"`
}

type rawEntity struct {
	Name       *string  `json:"name"`
	Type       *string  `json:"type"`
	Confidence *float64 `json:"confidence"`
}

type rawKgRelation struct {
	Subject    *rawKgEntityRef `json:"subject"`
	Predicate  *string         `json:"predicate"`
	Object     *rawKgEntityRef `json:"object"`
	Confidence *float64        `json:"confidence"`
	Evidence   *string         `json:"evidence"`
}

type rawKgEntityRef struct {
	Name *string `json:"name"`
	Type *string `json:"type"`
}

type rawStageMeta struct {
	Entries map[string]json.RawMessage
}

func (m *rawStageMeta) UnmarshalJSON(raw []byte) error {
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return err
	}
	m.Entries = entries
	return nil
}

func validateStringArray(values *[]string) ([]string, bool) {
	if values == nil {
		return []string{}, true
	}
	out := make([]string, 0, len(*values))
	for _, value := range *values {
		if value == "" {
			return nil, false
		}
		out = append(out, value)
	}
	return out, true
}

func validOptionalUnitNumber(value *float64) bool {
	if value == nil {
		return true
	}
	return !math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= 0 && *value <= 1
}

func validCandidates(values *[]rawCandidate) bool {
	if values == nil {
		return true
	}
	for _, candidate := range *values {
		if candidate.Path == nil || *candidate.Path == "" {
			return false
		}
		if candidate.Score == nil || math.IsNaN(*candidate.Score) || *candidate.Score < 0 || *candidate.Score > 1 {
			return false
		}
		if candidate.LegacyCategory == nil || *candidate.LegacyCategory == "" {
			return false
		}
	}
	return true
}

func validEntities(values *[]rawEntity) bool {
	if values == nil {
		return true
	}
	for _, entity := range *values {
		if entity.Name == nil || *entity.Name == "" || entity.Type == nil || *entity.Type == "" {
			return false
		}
		if entity.Confidence == nil || math.IsNaN(*entity.Confidence) || *entity.Confidence < 0 || *entity.Confidence > 1 {
			return false
		}
	}
	return true
}

func validKgRelations(values *[]rawKgRelation) bool {
	if values == nil {
		return true
	}
	for _, relation := range *values {
		if relation.Subject == nil || relation.Subject.Name == nil || *relation.Subject.Name == "" ||
			relation.Subject.Type == nil || *relation.Subject.Type == "" {
			return false
		}
		if relation.Predicate == nil || *relation.Predicate == "" {
			return false
		}
		if relation.Object == nil || relation.Object.Name == nil || *relation.Object.Name == "" ||
			relation.Object.Type == nil || *relation.Object.Type == "" {
			return false
		}
		if relation.Confidence == nil || math.IsNaN(*relation.Confidence) || *relation.Confidence < 0 || *relation.Confidence > 1 {
			return false
		}
	}
	return true
}

func validStageMeta(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return true
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return false
	}
	var meta rawStageMeta
	if err := json.Unmarshal(trimmed, &meta); err != nil {
		return false
	}
	for _, value := range meta.Entries {
		var entry struct {
			Status           *string  `json:"status"`
			Provider         *string  `json:"provider"`
			Reason           *string  `json:"reason"`
			Model            *string  `json:"model"`
			PromptVersion    *string  `json:"prompt_version"`
			PromptTokens     *float64 `json:"prompt_tokens"`
			CompletionTokens *float64 `json:"completion_tokens"`
			TotalTokens      *float64 `json:"total_tokens"`
			CostUSD          *float64 `json:"cost_usd"`
			LatencyMS        *float64 `json:"latency_ms"`
		}
		if json.Unmarshal(value, &entry) != nil {
			return false
		}
		if entry.Status == nil {
			return false
		}
		switch *entry.Status {
		case "completed", "skipped", "rejected", "failed":
		default:
			return false
		}
	}
	return true
}

func validMarkdownSource(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return true
	}
	if trimmed[0] != '"' {
		return true // the preprocess turns a non-string into undefined
	}
	var value string
	if json.Unmarshal(trimmed, &value) != nil {
		return false
	}
	switch jsTrim(value) {
	case "", "llm", "crawl_fallback":
		return true
	default:
		return true // the preprocess maps any other string to undefined
	}
}

// validNullableStringRaw accepts an absent member, a string or null. A present
// number/object/array fails the corresponding Zod union.
func validNullableStringRaw(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return true
	}
	return trimmed[0] == '"'
}

// normalizeStoredCategoryPath mirrors normalizeStoredCategoryPath.
func normalizeStoredCategoryPath(value string) string {
	normalized := strings.ToLower(jsTrim(value))
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	return strings.Trim(normalized, "/")
}

// normalizeStoredCategoryMethod mirrors normalizeStoredCategoryMethod.
func normalizeStoredCategoryMethod(value string) string { return jsTrim(value) }

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

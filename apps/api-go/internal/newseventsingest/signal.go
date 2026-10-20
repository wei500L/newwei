package newseventsingest

import (
	"encoding/json"
	"time"
)

// NewsSentimentLabel mirrors NewsSentimentLabel in news-signal.ts.
type NewsSentimentLabel string

const (
	// NewsSentimentLabelPositive is "positive".
	NewsSentimentLabelPositive NewsSentimentLabel = "positive"
	// NewsSentimentLabelNeutral is "neutral".
	NewsSentimentLabelNeutral NewsSentimentLabel = "neutral"
	// NewsSentimentLabelNegative is "negative".
	NewsSentimentLabelNegative NewsSentimentLabel = "negative"
)

// NewsSignalEntity mirrors NewsSignalEntity: a named entity with an optional
// type and an optional 0..1 confidence.
type NewsSignalEntity struct {
	Name       string
	Type       *string
	Confidence *float64
}

// NewsSignal mirrors NewsSignal in news-signals/news-signal.ts. It is the only
// shape the assignment path consumes.
type NewsSignal struct {
	ArticleID          string
	ProcessedArticleID string
	ProcessedItemID    *string
	Timestamp          time.Time
	Language           *string
	Title              *string
	Summary            *string
	Topics             []string
	Entities           []NewsSignalEntity
	Sentiment          *NewsSentimentLabel
	QualityScore       *float64
	LegacyCategory     *string
	CategoryPath       *string
	CategoryConfidence *float64
}

// ProcessedArticleRecord is the exact column set the ingestion batch selects
// from ProcessedArticle plus the joined Article.crawlAt and the Mongo
// ProcessedItem.result leaf.
//
// TopicsJSON and EntitiesJSON are the raw Prisma Json columns; the JSON column
// may hold any shape, so the builder normalizes them exactly like the NestJS
// unknown-typed input.
type ProcessedArticleRecord struct {
	ID                 string
	ArticleID          string
	ProcessedAt        *time.Time
	PublishedAt        *time.Time
	Language           *string
	Title              *string
	Summary            *string
	Category           *string
	TopicsJSON         []byte
	EntitiesJSON       []byte
	QualityScore       *float64
	CleanedMarkdownRef *string
	ArticleCrawlAt     *time.Time
	// ProcessedItemResult is the ProcessedItem.result document converted to
	// relaxed JSON. A nil value means the member was absent or Mongo null.
	ProcessedItemResult json.RawMessage
}

// BuildNewsSignalInput mirrors BuildNewsSignalFromProcessedArticleInput. Now is
// the clock Date.now() would read; a zero value falls back to time.Now.
type BuildNewsSignalInput struct {
	ProcessedArticle    ProcessedArticleRecord
	ProcessedItemResult json.RawMessage
	Now                 time.Time
}

// processedItemResultDocument is the additive projection of the open
// ProcessedItem.result leaf. Every member is kept raw because the stored value
// may be a string, a number or a nested document, and the NestJS extractors
// discriminate on the runtime type.
type processedItemResultDocument struct {
	SentimentLabel          json.RawMessage `json:"sentiment_label"`
	SentimentLabelCamelCase json.RawMessage `json:"sentimentLabel"`
	Sentiment               json.RawMessage `json:"sentiment"`
	Category                json.RawMessage `json:"category"`
	LegacyCategory          json.RawMessage `json:"legacy_category"`
	CategoryPath            json.RawMessage `json:"category_path"`
	CategoryPathCamelCase   json.RawMessage `json:"categoryPath"`
	CategoryConfidence      json.RawMessage `json:"category_confidence"`
	CategoryConfidenceCamel json.RawMessage `json:"categoryConfidence"`
}

// legacyCategories is the closed set normalizeLegacyCategory accepts.
var legacyCategories = map[string]struct{}{
	"politics": {},
	"tech":     {},
	"finance":  {},
	"gov":      {},
	"ai":       {},
	"intel":    {},
}

// normalizeLegacyCategory mirrors normalizeLegacyCategory: trim, lowercase and
// whitelist. An empty or unknown value yields nil.
func normalizeLegacyCategory(value *string) *string {
	normalized := jsNormalizeOptionalString(value)
	if normalized == nil {
		return nil
	}
	lowered := lowerASCII(*normalized)
	if _, ok := legacyCategories[lowered]; !ok {
		return nil
	}
	return &lowered
}

// normalizeLegacyCategoryRaw applies normalizeLegacyCategory to a raw JSON
// string member.
func normalizeLegacyCategoryRaw(raw json.RawMessage) *string {
	text, ok := jsonString(raw)
	if !ok {
		return nil
	}
	return normalizeLegacyCategory(&text)
}

// normalizeCategoryPath mirrors normalizeCategoryPath: trim, lowercase,
// backslashes to slashes, every `\s+` run to one dash, every `/` run to one
// slash, then strip the leading and trailing slashes.
func normalizeCategoryPath(value *string) *string {
	normalized := jsNormalizeOptionalString(value)
	if normalized == nil {
		return nil
	}
	lowered := lowerASCII(*normalized)
	slashed := replaceAllRune(lowered, '\\', '/')
	dashed := collapseJSWhitespaceToDash(slashed)
	collapsed := collapseRuneRuns(dashed, '/')
	trimmed := trimRun(collapsed, '/')
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeCategoryPathRaw applies normalizeCategoryPath to a raw JSON string
// member.
func normalizeCategoryPathRaw(raw json.RawMessage) *string {
	text, ok := jsonString(raw)
	if !ok {
		return nil
	}
	return normalizeCategoryPath(&text)
}

// normalizeSentimentLabel mirrors normalizeSentimentLabel. The prefix rules are
// applied in the positive, negative, neutral order of the original.
func normalizeSentimentLabel(raw json.RawMessage) *NewsSentimentLabel {
	text, ok := jsonString(raw)
	if !ok {
		return nil
	}
	normalized := jsNormalizeOptionalString(&text)
	if normalized == nil {
		return nil
	}
	lowered := lowerASCII(*normalized)
	switch {
	case lowered == string(NewsSentimentLabelPositive) || hasPrefix(lowered, "pos"):
		label := NewsSentimentLabelPositive
		return &label
	case lowered == string(NewsSentimentLabelNegative) || hasPrefix(lowered, "neg"):
		label := NewsSentimentLabelNegative
		return &label
	case lowered == string(NewsSentimentLabelNeutral) || hasPrefix(lowered, "neu"):
		label := NewsSentimentLabelNeutral
		return &label
	}
	return nil
}

// normalizeTopics mirrors normalizeTopics: keep the string entries and the
// name/topic member of object entries, drop everything blank, then de-duplicate
// preserving the first occurrence.
func normalizeTopics(raw []byte) []string {
	elements, ok := jsonArrayElements(raw)
	if !ok {
		return nil
	}
	topics := make([]string, 0, len(elements))
	seen := make(map[string]struct{}, len(elements))
	for _, element := range elements {
		var candidate string
		if text, isString := jsonString(element); isString {
			candidate = jsTrim(text)
		} else {
			var object struct {
				Name  json.RawMessage `json:"name"`
				Topic json.RawMessage `json:"topic"`
			}
			if jsonObjectFields(element, &object) {
				if name, isString := jsonString(object.Name); isString {
					if normalized := jsNormalizeOptionalString(&name); normalized != nil {
						candidate = *normalized
					}
				}
				if candidate == "" {
					if topic, isString := jsonString(object.Topic); isString {
						if normalized := jsNormalizeOptionalString(&topic); normalized != nil {
							candidate = *normalized
						}
					}
				}
			}
		}
		if candidate == "" {
			continue
		}
		if _, duplicate := seen[candidate]; duplicate {
			continue
		}
		seen[candidate] = struct{}{}
		topics = append(topics, candidate)
	}
	if len(topics) == 0 {
		return nil
	}
	return topics
}

// normalizeEntities mirrors normalizeEntities: a string entry becomes a named
// entity without type or confidence, an object entry requires a non-blank name
// and clamps its numeric confidence into 0..1.
func normalizeEntities(raw []byte) []NewsSignalEntity {
	elements, ok := jsonArrayElements(raw)
	if !ok {
		return nil
	}
	entities := make([]NewsSignalEntity, 0, len(elements))
	for _, element := range elements {
		if text, isString := jsonString(element); isString {
			if normalized := jsNormalizeOptionalString(&text); normalized != nil {
				entities = append(entities, NewsSignalEntity{Name: *normalized})
			}
			continue
		}
		var object struct {
			Name       json.RawMessage `json:"name"`
			Type       json.RawMessage `json:"type"`
			Confidence json.RawMessage `json:"confidence"`
		}
		if !jsonObjectFields(element, &object) {
			continue
		}
		name, isString := jsonString(object.Name)
		if !isString {
			continue
		}
		normalizedName := jsNormalizeOptionalString(&name)
		if normalizedName == nil {
			continue
		}
		entity := NewsSignalEntity{Name: *normalizedName}
		if typeText, isString := jsonString(object.Type); isString {
			entity.Type = jsNormalizeOptionalString(&typeText)
		}
		if confidence, _, isNumber := jsonNumber(object.Confidence); isNumber {
			clamped := jsClampUnit(confidence)
			entity.Confidence = &clamped
		}
		entities = append(entities, entity)
	}
	if len(entities) == 0 {
		return nil
	}
	return entities
}

// extractSentimentFromProcessedItemResult mirrors
// extractSentimentFromProcessedItemResult.
func extractSentimentFromProcessedItemResult(raw json.RawMessage) *NewsSentimentLabel {
	var document processedItemResultDocument
	if !jsonObjectFields(raw, &document) {
		return nil
	}
	if label := normalizeSentimentLabel(document.SentimentLabel); label != nil {
		return label
	}
	if label := normalizeSentimentLabel(document.SentimentLabelCamelCase); label != nil {
		return label
	}
	return normalizeSentimentLabel(document.Sentiment)
}

// classificationFromProcessedItemResult is the extracted classification block.
type classificationFromProcessedItemResult struct {
	LegacyCategory     *string
	CategoryPath       *string
	CategoryConfidence *float64
}

// extractClassificationFromProcessedItemResult mirrors
// extractClassificationFromProcessedItemResult: the snake_case members win over
// the camelCase ones and a non-numeric confidence is null.
func extractClassificationFromProcessedItemResult(raw json.RawMessage) classificationFromProcessedItemResult {
	var document processedItemResultDocument
	if !jsonObjectFields(raw, &document) {
		return classificationFromProcessedItemResult{}
	}
	classification := classificationFromProcessedItemResult{
		CategoryPath: firstNonNil(
			normalizeCategoryPathRaw(document.CategoryPath),
			normalizeCategoryPathRaw(document.CategoryPathCamelCase),
		),
	}
	classification.LegacyCategory = firstNonNil(
		normalizeLegacyCategoryRaw(document.Category),
		normalizeLegacyCategoryRaw(document.LegacyCategory),
	)
	confidence, _, isNumber := jsonNumber(document.CategoryConfidence)
	if !isNumber {
		confidence, _, isNumber = jsonNumber(document.CategoryConfidenceCamel)
	}
	if isNumber {
		clamped := jsClampUnit(confidence)
		classification.CategoryConfidence = &clamped
	}
	return classification
}

// normalizeQualityScore mirrors normalizeQualityScore.
func normalizeQualityScore(value *float64) *float64 {
	if value == nil {
		return nil
	}
	clamped := jsClampUnit(*value)
	return &clamped
}

// clampFutureTimestamp mirrors clampFutureTimestamp: a missing or non-positive
// value becomes now, a future value is capped at now.
func clampFutureTimestamp(value time.Time, now time.Time) time.Time {
	if value.IsZero() || value.UnixMilli() <= 0 {
		return now
	}
	if value.After(now) {
		return now
	}
	return value
}

// resolveSignalTimestamp mirrors resolveTimestamp: publishedAt, then crawlAt,
// then processedAt, each clamped at now; the final fallback is now.
func resolveSignalTimestamp(publishedAt, crawlAt, processedAt *time.Time, now time.Time) time.Time {
	if publishedAt != nil {
		return clampFutureTimestamp(*publishedAt, now)
	}
	if crawlAt != nil {
		return clampFutureTimestamp(*crawlAt, now)
	}
	if processedAt != nil {
		return clampFutureTimestamp(*processedAt, now)
	}
	return now
}

// BuildNewsSignalFromProcessedArticle mirrors
// buildNewsSignalFromProcessedArticle. The ingestion batch selects only
// Article.crawlAt, so no article language participates.
func BuildNewsSignalFromProcessedArticle(input BuildNewsSignalInput) NewsSignal {
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()
	record := input.ProcessedArticle
	processedItemResult := input.ProcessedItemResult

	classification := extractClassificationFromProcessedItemResult(processedItemResult)

	legacyCategory := classification.LegacyCategory
	if legacyCategory == nil {
		legacyCategory = normalizeLegacyCategory(record.Category)
	}

	return NewsSignal{
		ArticleID:          record.ArticleID,
		ProcessedArticleID: record.ID,
		ProcessedItemID:    jsNormalizeOptionalString(record.CleanedMarkdownRef),
		Timestamp:          resolveSignalTimestamp(record.PublishedAt, record.ArticleCrawlAt, record.ProcessedAt, now),
		Language:           jsNormalizeOptionalString(record.Language),
		Title:              jsNormalizeOptionalString(record.Title),
		Summary:            jsNormalizeOptionalString(record.Summary),
		Topics:             normalizeTopics(record.TopicsJSON),
		Entities:           normalizeEntities(record.EntitiesJSON),
		Sentiment:          extractSentimentFromProcessedItemResult(processedItemResult),
		QualityScore:       normalizeQualityScore(record.QualityScore),
		LegacyCategory:     legacyCategory,
		CategoryPath:       classification.CategoryPath,
		CategoryConfidence: classification.CategoryConfidence,
	}
}

// firstNonNil returns the first non-nil value, mirroring `a ?? b`.
func firstNonNil(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// lowerASCII lowercases a string. JavaScript toLowerCase is locale independent
// and also folds non-ASCII letters; the categories and sentiment labels this
// package compares are ASCII, so the ASCII fold is sufficient and never changes
// a non-ASCII byte.
func lowerASCII(value string) string {
	buffer := []byte(value)
	changed := false
	for index, char := range buffer {
		if char >= 'A' && char <= 'Z' {
			buffer[index] = char + ('a' - 'A')
			changed = true
		}
	}
	if !changed {
		return value
	}
	return string(buffer)
}

// hasPrefix reports strings.HasPrefix without importing strings here.
func hasPrefix(value, prefix string) bool {
	if len(prefix) > len(value) {
		return false
	}
	return value[:len(prefix)] == prefix
}

// replaceAllRune replaces every from rune with to.
func replaceAllRune(value string, from, to rune) string {
	runes := []rune(value)
	for index, char := range runes {
		if char == from {
			runes[index] = to
		}
	}
	return string(runes)
}

// collapseJSWhitespaceToDash replaces every JavaScript `\s+` run with one dash.
func collapseJSWhitespaceToDash(value string) string {
	var builder []rune
	builder = make([]rune, 0, len(value))
	inRun := false
	for _, char := range value {
		if jsWhitespace(char) {
			if !inRun {
				builder = append(builder, '-')
				inRun = true
			}
			continue
		}
		inRun = false
		builder = append(builder, char)
	}
	return string(builder)
}

// collapseRuneRuns replaces every run of target with a single target.
func collapseRuneRuns(value string, target rune) string {
	builder := make([]rune, 0, len(value))
	inRun := false
	for _, char := range value {
		if char == target {
			if !inRun {
				builder = append(builder, target)
				inRun = true
			}
			continue
		}
		inRun = false
		builder = append(builder, char)
	}
	return string(builder)
}

// trimRun strips every leading and trailing occurrence of target.
func trimRun(value string, target rune) string {
	start := 0
	end := len(value)
	for start < end && rune(value[start]) == target {
		start++
	}
	for end > start && rune(value[end-1]) == target {
		end--
	}
	return value[start:end]
}

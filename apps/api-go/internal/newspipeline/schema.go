package newspipeline

// This file ports the two Zod schemas that guard the pipeline's JSON boundary:
// NormalizedNewsPayloadSchema (queue payload normalization) and CleanedNewsSchema
// (the LLM clean result). Both schemas are strict in the same places Zod is
// strict: unknown keys are stripped, wrong member types fail the parse, array
// defaults are emitted as [] and null/optional semantics match the Zod
// declarations. A failed parse is permanent: it must never be retried, which is
// why the error carries the "ZodError" name the queue classifier looks for.

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
)

// ParseError is the Go equivalent of a ZodError on the pipeline boundary.
// Error() renders "<path>: <message>" so it is stable in TaskLog
// reason/failedReason columns; Name() returns the same token NestJS
// classifyQueueError sees ("ZodError"), which itempipeline maps to permanent.
type ParseError struct {
	Path    string
	Message string
}

// Error implements error with the stable "<path>: <message>" format.
func (e *ParseError) Error() string {
	if e == nil {
		return ""
	}
	if e.Path == "" {
		return e.Message
	}
	return e.Path + ": " + e.Message
}

// Name reports the ZodError classification token.
func (e *ParseError) Name() string { return "ZodError" }

func newParseError(path, message string) *ParseError {
	return &ParseError{Path: path, Message: message}
}

// isParseError reports whether err is (or wraps) a schema parse error.
func isParseError(err error) bool {
	var target *ParseError
	return errors.As(err, &target)
}

func errorRequired(path string) *ParseError {
	return newParseError(path, "Required")
}

func errorExpected(path, expected, received string) *ParseError {
	return newParseError(path, "Expected "+expected+", received "+received)
}

// errorInvalidInput is Zod's invalid_union message.
func errorInvalidInput(path string) *ParseError {
	return newParseError(path, "Invalid input")
}

func errorEnum(path, expected, received string) *ParseError {
	return newParseError(path, "Invalid enum value. Expected "+expected+", received "+received)
}

func errorMinLength(path string) *ParseError {
	return newParseError(path, "String must contain at least 1 character(s)")
}

func errorNumberMin(path string, minimum float64) *ParseError {
	return newParseError(path, "Number must be greater than or equal to "+formatNumber(minimum))
}

func errorNumberMax(path string, maximum float64) *ParseError {
	return newParseError(path, "Number must be less than or equal to "+formatNumber(maximum))
}

func formatNumber(value float64) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "0"
	}
	return string(encoded)
}

// jsonKind reports the JSON type using Zod's vocabulary ("undefined" for an
// absent value, "null", "string", "number", "boolean", "array", "object").
func jsonKind(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "undefined"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		if bytes.Equal(trimmed, []byte("null")) {
			return "null"
		}
	}
	if !json.Valid(trimmed) {
		return "undefined"
	}
	return "number"
}

func memberPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func itemPath(path string, index int) string {
	encoded, _ := json.Marshal(index)
	return path + "[" + string(encoded) + "]"
}

// requireJSONObject decodes the value and rejects everything that is not a JSON
// object, exactly like z.object(...) on a non-object input.
func requireJSONObject(raw json.RawMessage, path string) (map[string]json.RawMessage, *ParseError) {
	kind := jsonKind(raw)
	if kind == "undefined" {
		return nil, errorExpected(path, "object", "undefined")
	}
	if kind != "object" {
		return nil, errorExpected(path, "object", kind)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, errorExpected(path, "object", "unknown")
	}
	if object == nil {
		object = map[string]json.RawMessage{}
	}
	return object, nil
}

func decodeJSONString(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func decodeJSONNumber(raw json.RawMessage) (float64, bool) {
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// --- shared member readers -------------------------------------------------

// optionalMinLengthString is z.string().nullish() without trimming for nullable
// members of CleanedNews; the second return reports whether a value is set.
func nullableStringMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "string" {
		return nil, errorExpected(memberPath(path, key), "string", kind)
	}
	value, _ := decodeJSONString(raw)
	return stringPointer(value), nil
}

// optionalMinLengthValue parses an optional z.string().min(1) member.
func optionalMinLengthStringMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "string" {
		return nil, errorExpected(memberPath(path, key), "string", kind)
	}
	value, _ := decodeJSONString(raw)
	if value == "" {
		return nil, errorMinLength(memberPath(path, key))
	}
	return stringPointer(value), nil
}

// optionalTrimmedStringMember is optionalTrimmedString
// (z.string().optional().transform(trim -> undefined when empty)).
func optionalTrimmedStringMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind != "string" {
		return nil, errorExpected(memberPath(path, key), "string", kind)
	}
	value, _ := decodeJSONString(raw)
	trimmed := jsTrimString(value)
	if trimmed == "" {
		return nil, nil
	}
	return stringPointer(trimmed), nil
}

// optionalNullableTrimmedStringMember is optionalNullableTrimmedString
// (z.union([z.string(), z.null()]).optional(); null survives as null).
func optionalNullableTrimmedStringMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "string" {
		return nil, errorInvalidInput(memberPath(path, key))
	}
	value, _ := decodeJSONString(raw)
	trimmed := jsTrimString(value)
	if trimmed == "" {
		return nil, nil
	}
	return stringPointer(trimmed), nil
}

// optionalNullableISOStringMember is optionalNullableIsoDateTimeString: null and
// an unparseable value both normalize to null, a parseable value to the
// JS toISOString() representation (UTC, millisecond precision).
func optionalNullableISOStringMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "string" {
		return nil, errorInvalidInput(memberPath(path, key))
	}
	value, _ := decodeJSONString(raw)
	trimmed := jsTrimString(value)
	if trimmed == "" {
		return nil, nil
	}
	parsed := parseDate(trimmed)
	if parsed == nil {
		return nil, nil
	}
	return stringPointer(formatISOString(*parsed)), nil
}

// optionalNullableSentimentMember is optionalNullableSentimentLabel.
func optionalNullableSentimentMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "string" {
		return nil, errorInvalidInput(memberPath(path, key))
	}
	value, _ := decodeJSONString(raw)
	return normalizeSentimentLabel(value), nil
}

func normalizeSentimentLabel(value string) *string {
	trimmed := jsTrimString(value)
	if trimmed == "" {
		return nil
	}
	normalized := jsLowercase(trimmed)
	if normalized == "positive" || hasPrefix(normalized, "pos") ||
		containsAny(normalized, "正面", "积极", "利好") {
		return stringPointer("positive")
	}
	if normalized == "negative" || hasPrefix(normalized, "neg") ||
		containsAny(normalized, "负面", "消极", "利空") {
		return stringPointer("negative")
	}
	if normalized == "neutral" || hasPrefix(normalized, "neu") ||
		containsAny(normalized, "中性", "中立") {
		return stringPointer("neutral")
	}
	return stringPointer(normalized)
}

// optionalNullableContentTypeMember is optionalNullableContentType.
func optionalNullableContentTypeMember(object map[string]json.RawMessage, key, path string) (*string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "string" {
		return nil, errorInvalidInput(memberPath(path, key))
	}
	value, _ := decodeJSONString(raw)
	return normalizeNewsContentType(&value), nil
}

func nullableFiniteNumberMember(object map[string]json.RawMessage, key, path string) (*float64, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	if kind != "number" {
		return nil, errorExpected(memberPath(path, key), "number", kind)
	}
	value, _ := decodeJSONNumber(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, newParseError(memberPath(path, key), "Number must be finite")
	}
	return floatPointer(value), nil
}

func nullableUnitNumberMember(object map[string]json.RawMessage, key, path string) (*float64, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind == "null" {
		return nil, nil
	}
	value, err := parseUnitNumber(raw, memberPath(path, key))
	if err != nil {
		return nil, err
	}
	return floatPointer(value), nil
}

func parseUnitNumber(raw json.RawMessage, path string) (float64, *ParseError) {
	kind := jsonKind(raw)
	if kind == "undefined" {
		return 0, errorRequired(path)
	}
	if kind != "number" {
		return 0, errorExpected(path, "number", kind)
	}
	value, _ := decodeJSONNumber(raw)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, newParseError(path, "Number must be finite")
	}
	if value < 0 {
		return 0, errorNumberMin(path, 0)
	}
	if value > 1 {
		return 0, errorNumberMax(path, 1)
	}
	return value, nil
}

func requiredMinLengthString(raw json.RawMessage, path string) (string, *ParseError) {
	kind := jsonKind(raw)
	if kind == "undefined" {
		return "", errorRequired(path)
	}
	if kind != "string" {
		return "", errorExpected(path, "string", kind)
	}
	value, _ := decodeJSONString(raw)
	if value == "" {
		return "", errorMinLength(path)
	}
	return value, nil
}

// optionalJSONObjectMember is optionalJsonObject: a non-object value is
// preprocessed to undefined, a JSON object is kept as-is.
func optionalJSONObjectMember(object map[string]json.RawMessage, key string) json.RawMessage {
	raw, ok := object[key]
	if !ok {
		return nil
	}
	if jsonKind(raw) != "object" {
		return nil
	}
	return append(json.RawMessage(nil), bytes.TrimSpace(raw)...)
}

// minLengthStringArrayMember parses z.array(z.string().min(1)).default([]).
func minLengthStringArrayMember(object map[string]json.RawMessage, key, path string) ([]string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return []string{}, nil
	}
	kind := jsonKind(raw)
	if kind != "array" {
		return nil, errorExpected(memberPath(path, key), "array", kind)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, errorExpected(memberPath(path, key), "array", "unknown")
	}
	out := make([]string, 0, len(entries))
	for index, entry := range entries {
		value, err := requiredMinLengthString(entry, itemPath(memberPath(path, key), index))
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

// --- NormalizedNewsPayloadSchema ------------------------------------------

// NormalizePayload ports NormalizedNewsPayloadSchema. Unknown members are
// stripped (the contract struct only carries the schema members), string lists
// trim/filter their entries, metadata always becomes a JSON object and
// forceRefresh uses JavaScript Boolean() coercion.
func NormalizePayload(raw json.RawMessage) (NormalizedPayload, error) {
	object, parseErr := requireJSONObject(raw, "")
	if parseErr != nil {
		return NormalizedPayload{}, parseErr
	}
	payload := NormalizedPayload{
		Keywords:     []string{},
		Tags:         []string{},
		SummaryHints: []string{},
	}

	urlRaw, ok := object["url"]
	if !ok {
		return NormalizedPayload{}, errorRequired("url")
	}
	urlKind := jsonKind(urlRaw)
	if urlKind != "string" {
		return NormalizedPayload{}, errorExpected("url", "string", urlKind)
	}
	url, _ := decodeJSONString(urlRaw)
	url = jsTrimString(url)
	if url == "" {
		return NormalizedPayload{}, newParseError("url", "url is required")
	}
	payload.URL = url

	if payload.Language, parseErr = optionalTrimmedStringMember(object, "language", ""); parseErr != nil {
		return NormalizedPayload{}, parseErr
	}
	if payload.SourceName, parseErr = optionalNullableTrimmedStringMember(object, "sourceName", ""); parseErr != nil {
		return NormalizedPayload{}, parseErr
	}
	if payload.Keywords, parseErr = payloadStringList(object, "keywords"); parseErr != nil {
		return NormalizedPayload{}, parseErr
	}
	if payload.Tags, parseErr = payloadStringList(object, "tags"); parseErr != nil {
		return NormalizedPayload{}, parseErr
	}
	if payload.SummaryHints, parseErr = payloadStringList(object, "summaryHints"); parseErr != nil {
		return NormalizedPayload{}, parseErr
	}

	// metadata: preprocess(non-object -> {}) then z.record(z.unknown()).
	if metadataRaw, present := object["metadata"]; present && jsonKind(metadataRaw) == "object" {
		payload.Metadata = append(json.RawMessage(nil), bytes.TrimSpace(metadataRaw)...)
	} else {
		payload.Metadata = json.RawMessage("{}")
	}

	// crawlOptions: preprocess(non-object -> undefined) then an optional
	// catchall object, so unknown crawl members survive untouched.
	if crawlOptionsRaw, present := object["crawlOptions"]; present && jsonKind(crawlOptionsRaw) == "object" {
		payload.CrawlOptions = append(json.RawMessage(nil), bytes.TrimSpace(crawlOptionsRaw)...)
	}

	if prefetchedRaw, present := object["prefetchedArticle"]; present {
		prefetchedKind := jsonKind(prefetchedRaw)
		if prefetchedKind != "object" {
			return NormalizedPayload{}, errorExpected("prefetchedArticle", "object", prefetchedKind)
		}
		prefetchedObject, err := requireJSONObject(prefetchedRaw, "prefetchedArticle")
		if err != nil {
			return NormalizedPayload{}, err
		}
		prefetched, err := normalizePrefetchedArticle(prefetchedObject)
		if err != nil {
			return NormalizedPayload{}, err
		}
		payload.Prefetched = prefetched
	}

	if forceRefreshRaw, present := object["forceRefresh"]; present {
		payload.ForceRefresh = jsBooleanCoerce(forceRefreshRaw)
	}
	return payload, nil
}

// payloadStringList is the stringList preprocessing: a non-array value becomes
// [], string entries are trimmed and empty entries are dropped.
func payloadStringList(object map[string]json.RawMessage, key string) ([]string, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return []string{}, nil
	}
	if jsonKind(raw) != "array" {
		return []string{}, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return []string{}, nil
	}
	out := make([]string, 0, len(entries))
	for index, entry := range entries {
		kind := jsonKind(entry)
		if kind != "string" {
			return nil, errorExpected(itemPath(key, index), "string", kind)
		}
		value, _ := decodeJSONString(entry)
		trimmed := jsTrimString(value)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out, nil
}

func normalizePrefetchedArticle(object map[string]json.RawMessage) (*PrefetchedArticle, *ParseError) {
	article := &PrefetchedArticle{}
	const path = "prefetchedArticle"
	var err *ParseError
	if article.Title, err = optionalTrimmedStringMember(object, "title", path); err != nil {
		return nil, err
	}
	if article.Description, err = optionalTrimmedStringMember(object, "description", path); err != nil {
		return nil, err
	}
	if article.Author, err = optionalTrimmedStringMember(object, "author", path); err != nil {
		return nil, err
	}
	if article.Markdown, err = optionalTrimmedStringMember(object, "markdown", path); err != nil {
		return nil, err
	}
	if article.PublishedAt, err = optionalNullableISOStringMember(object, "publishedAt", path); err != nil {
		return nil, err
	}
	article.Metadata = optionalJSONObjectMember(object, "metadata")
	return article, nil
}

// --- CleanedNewsSchema -----------------------------------------------------

// ParseCleanedNews ports CleanedNewsSchema exactly. Every array member defaults
// to [] (never nil), sentiment/content_type/published_at are normalized,
// stage_meta keeps only the eight known keys with their entries validated, and
// unknown members are stripped. Violations return *ParseError (ZodError).
func ParseCleanedNews(raw json.RawMessage) (CleanedNews, error) {
	object, parseErr := requireJSONObject(raw, "")
	if parseErr != nil {
		return CleanedNews{}, parseErr
	}
	cleaned := CleanedNews{
		CategoryLabels:     []string{},
		CategoryCandidates: []ClassificationCandidate{},
		Topics:             []string{},
		KeyPoints:          []string{},
		Entities:           []Entity{},
		KGRelations:        []KGRelation{},
		RemovedNoiseTypes:  []string{},
	}
	var err *ParseError

	if cleaned.Title, err = nullableStringMember(object, "title", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Subtitle, err = nullableStringMember(object, "subtitle", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Author, err = nullableStringMember(object, "author", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Source, err = nullableStringMember(object, "source", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.PublishedAt, err = optionalNullableISOStringMember(object, "published_at", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Language, err = nullableStringMember(object, "language", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Location, err = nullableStringMember(object, "location", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Category, err = nullableStringMember(object, "category", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.ContentType, err = optionalNullableContentTypeMember(object, "content_type", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.CategoryPath, err = nullableStringMember(object, "category_path", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.CategoryLabels, err = minLengthStringArrayMember(object, "category_labels", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.CategoryConfidence, err = nullableUnitNumberMember(object, "category_confidence", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.CategoryReason, err = nullableStringMember(object, "category_reason", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.CategoryMethod, err = nullableStringMember(object, "category_method", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.CategoryCandidates, err = categoryCandidatesMember(object); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Sentiment, err = optionalNullableSentimentMember(object, "sentiment", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.SentimentLabel, err = optionalNullableSentimentMember(object, "sentiment_label", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Topics, err = minLengthStringArrayMember(object, "topics", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Summary, err = nullableStringMember(object, "summary", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.KeyPoints, err = minLengthStringArrayMember(object, "key_points", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.Entities, err = entitiesMember(object); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.KGRelations, err = kgRelationsMember(object); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.StageMeta, err = stageMetaMember(object); err != nil {
		return CleanedNews{}, err
	}

	cleanedMarkdownRaw, ok := object["cleaned_markdown"]
	if !ok {
		return CleanedNews{}, errorRequired("cleaned_markdown")
	}
	markdown, err := requiredMinLengthString(cleanedMarkdownRaw, "cleaned_markdown")
	if err != nil {
		return CleanedNews{}, err
	}
	cleaned.CleanedMarkdown = markdown

	cleaned.CleanedMarkdownSource = markdownSourceMember(object, "cleaned_markdown_source")

	if cleaned.RemovedNoiseTypes, err = minLengthStringArrayMember(object, "removed_noise_types", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.QualityScore, err = nullableUnitNumberMember(object, "quality_score", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.LLMModel, err = nullableStringMember(object, "llm_model", ""); err != nil {
		return CleanedNews{}, err
	}
	if cleaned.LLMPromptVersion, err = nullableStringMember(object, "llm_prompt_version", ""); err != nil {
		return CleanedNews{}, err
	}
	return cleaned, nil
}

// markdownSourceMember is cleanedMarkdownSourceSchema: a non-string value is
// preprocessed to undefined, an unknown string is mapped to undefined and only
// the trim()ed llm/crawl_fallback tokens survive.
func markdownSourceMember(object map[string]json.RawMessage, key string) *string {
	raw, ok := object[key]
	if !ok || jsonKind(raw) != "string" {
		return nil
	}
	value, _ := decodeJSONString(raw)
	trimmed := jsTrimString(value)
	if trimmed == "llm" || trimmed == "crawl_fallback" {
		return stringPointer(trimmed)
	}
	return nil
}

func categoryCandidatesMember(object map[string]json.RawMessage) ([]ClassificationCandidate, *ParseError) {
	raw, ok := object["category_candidates"]
	if !ok {
		return []ClassificationCandidate{}, nil
	}
	kind := jsonKind(raw)
	if kind != "array" {
		return nil, errorExpected("category_candidates", "array", kind)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, errorExpected("category_candidates", "array", "unknown")
	}
	out := make([]ClassificationCandidate, 0, len(entries))
	for index, entry := range entries {
		path := itemPath("category_candidates", index)
		record, err := requireJSONObject(entry, path)
		if err != nil {
			return nil, err
		}
		pathRaw, present := record["path"]
		if !present {
			return nil, errorRequired(memberPath(path, "path"))
		}
		candidatePath, err := requiredMinLengthString(pathRaw, memberPath(path, "path"))
		if err != nil {
			return nil, err
		}
		scoreRaw, present := record["score"]
		if !present {
			return nil, errorRequired(memberPath(path, "score"))
		}
		score, scoreErr := parseUnitNumber(scoreRaw, memberPath(path, "score"))
		if scoreErr != nil {
			return nil, scoreErr
		}
		legacyRaw, present := record["legacy_category"]
		if !present {
			return nil, errorRequired(memberPath(path, "legacy_category"))
		}
		legacyCategory, legacyErr := requiredMinLengthString(legacyRaw, memberPath(path, "legacy_category"))
		if legacyErr != nil {
			return nil, legacyErr
		}
		reason, reasonErr := nullableStringMember(record, "reason", path)
		if reasonErr != nil {
			return nil, reasonErr
		}
		out = append(out, ClassificationCandidate{
			Path:           candidatePath,
			Score:          score,
			LegacyCategory: legacyCategory,
			Reason:         reason,
		})
	}
	return out, nil
}

func entitiesMember(object map[string]json.RawMessage) ([]Entity, *ParseError) {
	raw, ok := object["entities"]
	if !ok {
		return []Entity{}, nil
	}
	kind := jsonKind(raw)
	if kind != "array" {
		return nil, errorExpected("entities", "array", kind)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, errorExpected("entities", "array", "unknown")
	}
	out := make([]Entity, 0, len(entries))
	for index, entry := range entries {
		path := itemPath("entities", index)
		record, err := requireJSONObject(entry, path)
		if err != nil {
			return nil, err
		}
		nameRaw, present := record["name"]
		if !present {
			return nil, errorRequired(memberPath(path, "name"))
		}
		name, nameErr := requiredMinLengthString(nameRaw, memberPath(path, "name"))
		if nameErr != nil {
			return nil, nameErr
		}
		typeRaw, present := record["type"]
		if !present {
			return nil, errorRequired(memberPath(path, "type"))
		}
		entityType, typeErr := requiredMinLengthString(typeRaw, memberPath(path, "type"))
		if typeErr != nil {
			return nil, typeErr
		}
		confidenceRaw, present := record["confidence"]
		if !present {
			return nil, errorRequired(memberPath(path, "confidence"))
		}
		confidence, confidenceErr := parseUnitNumber(confidenceRaw, memberPath(path, "confidence"))
		if confidenceErr != nil {
			return nil, confidenceErr
		}
		out = append(out, Entity{Name: name, Type: entityType, Confidence: confidence})
	}
	return out, nil
}

func kgRelationsMember(object map[string]json.RawMessage) ([]KGRelation, *ParseError) {
	raw, ok := object["kg_relations"]
	if !ok {
		return []KGRelation{}, nil
	}
	kind := jsonKind(raw)
	if kind != "array" {
		return nil, errorExpected("kg_relations", "array", kind)
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, errorExpected("kg_relations", "array", "unknown")
	}
	out := make([]KGRelation, 0, len(entries))
	for index, entry := range entries {
		path := itemPath("kg_relations", index)
		record, err := requireJSONObject(entry, path)
		if err != nil {
			return nil, err
		}
		subjectRaw, present := record["subject"]
		if !present {
			return nil, errorRequired(memberPath(path, "subject"))
		}
		subject, subjectErr := kgEntityRef(subjectRaw, memberPath(path, "subject"))
		if subjectErr != nil {
			return nil, subjectErr
		}
		predicateRaw, present := record["predicate"]
		if !present {
			return nil, errorRequired(memberPath(path, "predicate"))
		}
		predicate, predicateErr := requiredMinLengthString(predicateRaw, memberPath(path, "predicate"))
		if predicateErr != nil {
			return nil, predicateErr
		}
		objectRaw, present := record["object"]
		if !present {
			return nil, errorRequired(memberPath(path, "object"))
		}
		kgObject, objectErr := kgEntityRef(objectRaw, memberPath(path, "object"))
		if objectErr != nil {
			return nil, objectErr
		}
		confidenceRaw, present := record["confidence"]
		if !present {
			return nil, errorRequired(memberPath(path, "confidence"))
		}
		confidence, confidenceErr := parseUnitNumber(confidenceRaw, memberPath(path, "confidence"))
		if confidenceErr != nil {
			return nil, confidenceErr
		}
		properties := optionalJSONObjectMember(record, "properties")
		evidence, evidenceErr := nullableStringMember(record, "evidence", path)
		if evidenceErr != nil {
			return nil, evidenceErr
		}
		out = append(out, KGRelation{
			Subject:    subject,
			Predicate:  predicate,
			Object:     kgObject,
			Confidence: confidence,
			Properties: properties,
			Evidence:   evidence,
		})
	}
	return out, nil
}

func kgEntityRef(raw json.RawMessage, path string) (KGEntityRef, *ParseError) {
	record, err := requireJSONObject(raw, path)
	if err != nil {
		return KGEntityRef{}, err
	}
	nameRaw, present := record["name"]
	if !present {
		return KGEntityRef{}, errorRequired(memberPath(path, "name"))
	}
	name, nameErr := requiredMinLengthString(nameRaw, memberPath(path, "name"))
	if nameErr != nil {
		return KGEntityRef{}, nameErr
	}
	typeRaw, present := record["type"]
	if !present {
		return KGEntityRef{}, errorRequired(memberPath(path, "type"))
	}
	entityType, typeErr := requiredMinLengthString(typeRaw, memberPath(path, "type"))
	if typeErr != nil {
		return KGEntityRef{}, typeErr
	}
	return KGEntityRef{Name: name, Type: entityType}, nil
}

// stageMetaMember validates the optional stage_meta object. The eight known keys
// keep their insertion order in the contract struct; unknown keys are stripped
// like z.object(...). A present but null/unknown-shaped stage is a parse error.
func stageMetaMember(object map[string]json.RawMessage) (*StageMeta, *ParseError) {
	raw, ok := object["stage_meta"]
	if !ok {
		return nil, nil
	}
	kind := jsonKind(raw)
	if kind != "object" {
		return nil, errorExpected("stage_meta", "object", kind)
	}
	record, err := requireJSONObject(raw, "stage_meta")
	if err != nil {
		return nil, err
	}
	meta := &StageMeta{}
	if meta.Preflight, err = stageMetaEntryMember(record, "preflight"); err != nil {
		return nil, err
	}
	if meta.Clean, err = stageMetaEntryMember(record, "clean"); err != nil {
		return nil, err
	}
	if meta.QualityGate, err = stageMetaEntryMember(record, "quality_gate"); err != nil {
		return nil, err
	}
	if meta.Entities, err = stageMetaEntryMember(record, "entities"); err != nil {
		return nil, err
	}
	if meta.Sentiment, err = stageMetaEntryMember(record, "sentiment"); err != nil {
		return nil, err
	}
	if meta.KG, err = stageMetaEntryMember(record, "kg"); err != nil {
		return nil, err
	}
	if meta.Classify, err = stageMetaEntryMember(record, "classify"); err != nil {
		return nil, err
	}
	if meta.Dedupe, err = stageMetaEntryMember(record, "dedupe"); err != nil {
		return nil, err
	}
	return meta, nil
}

func stageMetaEntryMember(object map[string]json.RawMessage, key string) (*StageMetaEntry, *ParseError) {
	raw, ok := object[key]
	if !ok {
		return nil, nil
	}
	path := memberPath("stage_meta", key)
	record, err := requireJSONObject(raw, path)
	if err != nil {
		return nil, err
	}
	statusRaw, present := record["status"]
	if !present {
		return nil, errorRequired(memberPath(path, "status"))
	}
	statusKind := jsonKind(statusRaw)
	if statusKind != "string" {
		return nil, errorEnum(memberPath(path, "status"), "'completed' | 'skipped' | 'rejected' | 'failed'", statusKind)
	}
	status, _ := decodeJSONString(statusRaw)
	switch status {
	case "completed", "skipped", "rejected", "failed":
	default:
		return nil, errorEnum(memberPath(path, "status"), "'completed' | 'skipped' | 'rejected' | 'failed'", "'"+status+"'")
	}
	entry := &StageMetaEntry{Status: status}
	if entry.Provider, err = nullableStringMember(record, "provider", path); err != nil {
		return nil, err
	}
	if entry.Reason, err = nullableStringMember(record, "reason", path); err != nil {
		return nil, err
	}
	if entry.Model, err = nullableStringMember(record, "model", path); err != nil {
		return nil, err
	}
	if entry.PromptVersion, err = nullableStringMember(record, "prompt_version", path); err != nil {
		return nil, err
	}
	if entry.PromptTokens, err = nullableFiniteNumberMember(record, "prompt_tokens", path); err != nil {
		return nil, err
	}
	if entry.CompletionTokens, err = nullableFiniteNumberMember(record, "completion_tokens", path); err != nil {
		return nil, err
	}
	if entry.TotalTokens, err = nullableFiniteNumberMember(record, "total_tokens", path); err != nil {
		return nil, err
	}
	if entry.CostUSD, err = nullableFiniteNumberMember(record, "cost_usd", path); err != nil {
		return nil, err
	}
	if entry.LatencyMS, err = nullableFiniteNumberMember(record, "latency_ms", path); err != nil {
		return nil, err
	}
	return entry, nil
}

// jsBooleanCoerce reproduces JavaScript Boolean(value) over parsed JSON.
func jsBooleanCoerce(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	switch jsonKind(trimmed) {
	case "null":
		return false
	case "boolean":
		return bytes.Equal(trimmed, []byte("true"))
	case "string":
		value, _ := decodeJSONString(trimmed)
		return value != ""
	case "number":
		value, ok := decodeJSONNumber(trimmed)
		if !ok {
			return false
		}
		return value != 0
	default:
		// Arrays and objects are truthy even when empty.
		return true
	}
}

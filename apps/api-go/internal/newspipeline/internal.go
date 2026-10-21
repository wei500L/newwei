package newspipeline

// This file ports news-pipeline-internal.ts: the pure helpers shared by the
// stages, the persist path and the crawl bridge. Behaviour is kept byte-exact
// with the TypeScript implementation: JS trim/UTF-16 semantics, sha256
// lowercase hex, 6-decimal LLM metadata rounding, ordered fallback rewrites and
// the same Mongo/MySQL error classification.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/go-sql-driver/mysql"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// FrontierLogMetadata is resolveFrontierLogMetadata's resolved projection.
type FrontierLogMetadata struct {
	RunID     string
	NodeID    string
	ProfileID string
}

// defaultURLQueryParamAllowlist is DEFAULT_URL_QUERY_PARAM_ALLOWLIST from
// @modular/utils (normalizeUrlQueryParamAllowlist fallback).
var defaultURLQueryParamAllowlist = []string{
	"id", "story", "article", "post", "item", "p", "page", "v", "ver", "lang", "locale", "hl",
}

const (
	maxURLQueryParamAllowlistSize = 64
	maxQueryParamKeyLength        = 64
)

var (
	queryParamKeyPattern = regexp.MustCompile(`^[a-z0-9_.-]+$`)
	unixTimestampPattern = regexp.MustCompile(`^\d{10,13}$`)
	explicitTimeZoneEnd  = regexp.MustCompile(`([zZ]|[+-]\d{2}:?\d{2})$`)
	gmtWordPattern       = regexp.MustCompile(`\bGMT\b`)
	quarterPattern       = regexp.MustCompile(`^(\d{4})\s*(?:Q([1-4])|第\s*([1-4])\s*季度)$`)
	quarterWithYear      = regexp.MustCompile(`^(\d{4})\s*年\s*(?:Q([1-4])|第\s*([1-4])\s*季度)$`)
	chineseDatePattern   = regexp.MustCompile(`^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?(?:\s*(\d{1,2})(?:[:时]\s*(\d{1,2}))?(?:[:分]\s*(\d{1,2}))?(?:\.(\d{1,3}))?\s*(?:秒)?)?\s*$`)
	ymdDateTimePattern   = regexp.MustCompile(`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?\s*$`)
	yearMonthPattern     = regexp.MustCompile(`^(\d{4})[-/.](\d{1,2})\s*$`)
	yearOnlyPattern      = regexp.MustCompile(`^(\d{4})\s*(?:年)?\s*$`)
)

// --- generic JS-ish helpers ------------------------------------------------

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func hasPrefix(value, prefix string) bool { return strings.HasPrefix(value, prefix) }

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

// jsLowercase is String.prototype.toLowerCase for the ASCII/Chinese tokens the
// pipeline deals with.
func jsLowercase(value string) string { return strings.ToLower(value) }

// jsTrimString reproduces String.prototype.trim: Unicode whitespace plus BOM.
func jsTrimString(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\uFEFF' || unicode.IsSpace(r)
	})
}

func jsTrimEnd(value string) string {
	return strings.TrimRightFunc(value, func(r rune) bool {
		return r == '\uFEFF' || unicode.IsSpace(r)
	})
}

func utf16Length(value string) int { return len(utf16.Encode([]rune(value))) }

// truncateUTF16 truncates like String.prototype.slice for a non-negative bound.
func truncateUTF16(value string, limit int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= limit {
		return value
	}
	return string(utf16.Decode(units[:limit]))
}

// formatISOString formats the JS Date.toISOString() representation.
func formatISOString(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// --- metadata / hashing ----------------------------------------------------

// hashContent is hashContent: sha256 of the UTF-8 bytes, lowercase hex.
func hashContent(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// parseDate is parseDate: it accepts anything the call sites have (string,
// *string, time.Time) and returns nil when the value cannot be parsed.
func parseDate(value any) *time.Time {
	switch typed := value.(type) {
	case nil:
		return nil
	case time.Time:
		parsed := typed
		return &parsed
	case *time.Time:
		if typed == nil {
			return nil
		}
		parsed := *typed
		return &parsed
	case string:
		parsed, ok := parseDateTimeValue(typed)
		if !ok {
			return nil
		}
		return &parsed
	case *string:
		if typed == nil {
			return nil
		}
		parsed, ok := parseDateTimeValue(*typed)
		if !ok {
			return nil
		}
		return &parsed
	default:
		return nil
	}
}

// parseDateTimeValue ports parseDateTime's accepted forms (unix timestamps,
// explicit time zones, naive date/time strings, Chinese year-month-day forms
// and year/month fallbacks) in UTC.
func parseDateTimeValue(value string) (time.Time, bool) {
	trimmed := jsTrimString(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	if parsed, ok := parseUnixTimestamp(trimmed); ok {
		return parsed, true
	}
	if hasExplicitTimeZone(trimmed) {
		for _, layout := range []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02T15:04:05Z07:00",
			"2006-01-02 15:04:05Z07:00",
			"2006-01-02T15:04:05.999999999Z0700",
			"2006-01-02 15:04:05.999999999Z0700",
			time.RFC1123Z,
			time.RFC1123,
		} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				return parsed, true
			}
		}
		if gmtWordPattern.MatchString(trimmed) {
			stripped := jsTrimString(gmtWordPattern.ReplaceAllString(trimmed, ""))
			if parsed, ok := parseNaiveDateTime(stripped); ok {
				return parsed, true
			}
		}
	}
	if parsed, ok := parseNaiveDateTime(trimmed); ok {
		return parsed, true
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"2006/01/02",
		"2006.01.02",
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func parseUnixTimestamp(value string) (time.Time, bool) {
	if !unixTimestampPattern.MatchString(value) {
		return time.Time{}, false
	}
	numeric, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	if len(value) <= 10 {
		numeric *= 1000
	}
	return time.UnixMilli(numeric).UTC(), true
}

func hasExplicitTimeZone(value string) bool {
	return explicitTimeZoneEnd.MatchString(value) || gmtWordPattern.MatchString(value)
}

func parseNaiveDateTime(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	if match := quarterPattern.FindStringSubmatch(value); match != nil {
		return buildUTCDateTime(atoiDefault(match[1], 0), quarterMonth(match[2], match[3]), 1, 0, 0, 0, 0), true
	}
	if match := quarterWithYear.FindStringSubmatch(value); match != nil {
		return buildUTCDateTime(atoiDefault(match[1], 0), quarterMonth(match[2], match[3]), 1, 0, 0, 0, 0), true
	}
	if match := chineseDatePattern.FindStringSubmatch(value); match != nil {
		year := atoiDefault(match[1], 0)
		month := atoiDefault(match[2], 0)
		day := 1
		if match[3] != "" {
			day = atoiDefault(match[3], 1)
		}
		hour, minute, second, millisecond := 0, 0, 0, 0
		if match[4] != "" {
			hour = atoiDefault(match[4], 0)
			if match[5] != "" {
				minute = atoiDefault(match[5], 0)
			}
			if match[6] != "" {
				second = atoiDefault(match[6], 0)
			}
			if match[7] != "" {
				millisecond = millisecondsFromFraction(match[7])
			}
		}
		if !validCalendarParts(year, month, day) {
			return time.Time{}, false
		}
		return buildUTCDateTime(year, month, day, hour, minute, second, millisecond), true
	}
	if match := ymdDateTimePattern.FindStringSubmatch(value); match != nil {
		year := atoiDefault(match[1], 0)
		month := atoiDefault(match[2], 0)
		day := atoiDefault(match[3], 0)
		if !validCalendarParts(year, month, day) {
			return time.Time{}, false
		}
		hour, minute, second, millisecond := 0, 0, 0, 0
		if match[4] != "" {
			hour = atoiDefault(match[4], 0)
			if match[5] != "" {
				minute = atoiDefault(match[5], 0)
			}
			if match[6] != "" {
				second = atoiDefault(match[6], 0)
			}
			if match[7] != "" {
				millisecond = millisecondsFromFraction(match[7])
			}
		}
		return buildUTCDateTime(year, month, day, hour, minute, second, millisecond), true
	}
	if match := yearMonthPattern.FindStringSubmatch(value); match != nil {
		year := atoiDefault(match[1], 0)
		month := atoiDefault(match[2], 0)
		if !validCalendarParts(year, month, 1) {
			return time.Time{}, false
		}
		return buildUTCDateTime(year, month, 1, 0, 0, 0, 0), true
	}
	if match := yearOnlyPattern.FindStringSubmatch(value); match != nil {
		year := atoiDefault(match[1], 0)
		if !validCalendarParts(year, 1, 1) {
			return time.Time{}, false
		}
		return buildUTCDateTime(year, 1, 1, 0, 0, 0, 0), true
	}
	return time.Time{}, false
}

func quarterMonth(first, second string) int {
	quarter := atoiDefault(first, 0)
	if quarter == 0 {
		quarter = atoiDefault(second, 0)
	}
	if quarter < 1 || quarter > 4 {
		return 1
	}
	return (quarter-1)*3 + 1
}

func millisecondsFromFraction(value string) int {
	padded := value
	for len(padded) < 3 {
		padded += "0"
	}
	if len(padded) > 3 {
		padded = padded[:3]
	}
	return atoiDefault(padded, 0)
}

func buildUTCDateTime(year, month, day, hour, minute, second, millisecond int) time.Time {
	return time.Date(year, time.Month(month), day, hour, minute, second, millisecond*int(time.Millisecond), time.UTC)
}

func validCalendarParts(year, month, day int) bool {
	return month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1
}

func atoiDefault(value string, fallback int) int {
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

// --- LLM metadata ----------------------------------------------------------

// emptyLlmMetadata is emptyLlmMetadata.
func emptyLlmMetadata() LLMMetadata { return EmptyLLMMetadata() }

// mergeLlmMetadata is mergeLlmMetadata: model/promptVersion come from base first
// and every summed member is rounded to 6 decimals like
// Number(x.toFixed(6)). A nil extra returns base unchanged.
func mergeLlmMetadata(base LLMMetadata, extra *LLMMetadata) LLMMetadata {
	if extra == nil {
		return base
	}
	sumOrNull := func(left, right *float64) *float64 {
		if left == nil && right == nil {
			return nil
		}
		total := 0.0
		if left != nil {
			total += *left
		}
		if right != nil {
			total += *right
		}
		return floatPointer(math.Round(total*1e6) / 1e6)
	}
	firstNonNull := func(left, right *string) *string {
		if left != nil {
			return left
		}
		return right
	}
	return LLMMetadata{
		Model:            firstNonNull(base.Model, extra.Model),
		PromptVersion:    firstNonNull(base.PromptVersion, extra.PromptVersion),
		PromptTokens:     sumOrNull(base.PromptTokens, extra.PromptTokens),
		CompletionTokens: sumOrNull(base.CompletionTokens, extra.CompletionTokens),
		TotalTokens:      sumOrNull(base.TotalTokens, extra.TotalTokens),
		CostUSD:          sumOrNull(base.CostUSD, extra.CostUSD),
		LatencyMS:        sumOrNull(base.LatencyMS, extra.LatencyMS),
	}
}

// withPromptMetadata is withPromptMetadata: the parsed values win, the caller's
// values fill the gaps.
func withPromptMetadata(cleaned CleanedNews, promptVersion *string, model *string) CleanedNews {
	if cleaned.LLMModel == nil {
		if model != nil {
			cleaned.LLMModel = stringPointer(*model)
		}
	}
	if cleaned.LLMPromptVersion == nil {
		if promptVersion != nil {
			cleaned.LLMPromptVersion = stringPointer(*promptVersion)
		}
	}
	return cleaned
}

// withResolvedContentType is withResolvedContentType: keep a valid stored type,
// otherwise infer from title/summary/source/url/topics/tags.
func withResolvedContentType(cleaned CleanedNews, payload NormalizedPayload, article *CrawledArticle) CleanedNews {
	resolved := normalizeNewsContentType(cleaned.ContentType)
	if resolved == nil {
		source := cleaned.Source
		if source == nil {
			source = payload.SourceName
		}
		url := stringPointer(payload.URL)
		if article != nil {
			url = stringPointer(article.SourceURL)
		}
		inferred := inferNewsContentType(inferNewsContentTypeInput{
			Title:   cleaned.Title,
			Summary: cleaned.Summary,
			Source:  source,
			URL:     url,
			Topics:  cleaned.Topics,
			Tags:    payload.Tags,
		})
		resolved = stringPointer(inferred)
	}
	cleaned.ContentType = resolved
	return cleaned
}

// resolveStoredContentTypeForBackfill is resolveStoredContentTypeForBackfill.
func resolveStoredContentTypeForBackfill(cleaned CleanedNews, sourceURL *string, sourceLabel *string) CleanedNews {
	resolved := normalizeNewsContentType(cleaned.ContentType)
	if resolved == nil {
		source := cleaned.Source
		if source == nil {
			source = sourceLabel
		}
		inferred := inferNewsContentType(inferNewsContentTypeInput{
			Title:   cleaned.Title,
			Summary: cleaned.Summary,
			Source:  source,
			URL:     sourceURL,
			Topics:  cleaned.Topics,
			Tags:    []string{},
		})
		resolved = stringPointer(inferred)
	}
	cleaned.ContentType = resolved
	return cleaned
}

// normalizeProcessedItemRef is normalizeProcessedItemRef: only a Mongo ObjectId
// shaped string survives.
func normalizeProcessedItemRef(ref *string) *string {
	if ref == nil || *ref == "" {
		return nil
	}
	if !isValidObjectIDString(*ref) {
		return nil
	}
	return stringPointer(*ref)
}

func isValidObjectIDString(value string) bool {
	if len(value) == 12 {
		return true
	}
	if len(value) != 24 {
		return false
	}
	for _, r := range value {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			continue
		}
		return false
	}
	return true
}

// parseStoredCleanedNewsResult is CleanedNewsSchema.safeParse: nil means the
// stored result is invalid and the caller must skip/fall back.
func parseStoredCleanedNewsResult(raw json.RawMessage) *CleanedNews {
	cleaned, err := ParseCleanedNews(raw)
	if err != nil {
		return nil
	}
	return &cleaned
}

// normalizeStoredCategoryPath is normalizeStoredCategoryPath.
func normalizeStoredCategoryPath(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := jsLowercase(jsTrimString(*value))
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	normalized = strings.Trim(normalized, "/")
	if normalized == "" {
		return nil
	}
	return stringPointer(normalized)
}

// normalizeStoredCategoryMethod is normalizeStoredCategoryMethod.
func normalizeStoredCategoryMethod(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := jsTrimString(*value)
	if normalized == "" {
		return nil
	}
	return stringPointer(normalized)
}

// --- ordered JSON rewrite for the LLM clean fallback -----------------------

// schemaOrderedObject keeps JSON members and their insertion order so the
// fallback rewrite changes only the members the TypeScript function touches.
type schemaOrderedObject struct {
	keys   []string
	values map[string]json.RawMessage
}

func parseSchemaOrderedObject(raw json.RawMessage) (*schemaOrderedObject, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if _, ok := token.(json.Delim); !ok {
		return nil, false
	}
	object := &schemaOrderedObject{values: map[string]json.RawMessage{}}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false
		}
		if _, exists := object.values[key]; !exists {
			object.keys = append(object.keys, key)
		}
		object.values[key] = value
	}
	return object, true
}

func (o *schemaOrderedObject) set(key string, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = encoded
}

func (o *schemaOrderedObject) string(key string) (string, bool) {
	raw, ok := o.values[key]
	if !ok || jsonKind(raw) != "string" {
		return "", false
	}
	value, ok := decodeJSONString(raw)
	return value, ok
}

func (o *schemaOrderedObject) marshal() json.RawMessage {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		buffer.Write(o.values[key])
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

// applyCleanedMarkdownFallback is applyCleanedMarkdownFallback: the contentType
// alias is promoted to content_type, a non-empty cleaned markdown candidate wins
// verbatim, otherwise a non-empty fallback is stored with source
// crawl_fallback. Unknown members and member order are preserved.
func applyCleanedMarkdownFallback(parsed json.RawMessage, fallback string) json.RawMessage {
	object, ok := parseSchemaOrderedObject(parsed)
	if !ok {
		return parsed
	}
	contentTypeAlias := ""
	hasContentTypeAlias := false
	if value, ok := object.string("contentType"); ok {
		contentTypeAlias = value
		hasContentTypeAlias = true
	} else if value, ok := object.string("content_type"); ok {
		contentTypeAlias = value
		hasContentTypeAlias = true
	}
	// The TypeScript code only writes the alias when it is a non-empty string.
	if hasContentTypeAlias && contentTypeAlias != "" {
		object.set("content_type", contentTypeAlias)
	}
	candidate, hasCandidate := object.string("cleaned_markdown")
	if !hasCandidate {
		candidate, hasCandidate = object.string("cleanedMarkdown")
	}
	if hasCandidate && jsTrimString(candidate) != "" {
		object.set("cleaned_markdown", candidate)
		return object.marshal()
	}
	if jsTrimString(fallback) != "" {
		object.set("cleaned_markdown", fallback)
		object.set("cleaned_markdown_source", "crawl_fallback")
	}
	return object.marshal()
}

// --- payload metadata extraction ------------------------------------------

func payloadMetadataMap(payload NormalizedPayload) map[string]json.RawMessage {
	raw := payload.Metadata
	if jsonKind(raw) != "object" {
		return map[string]json.RawMessage{}
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return map[string]json.RawMessage{}
	}
	return object
}

func stringMember(object map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := object[key]
	if !ok || jsonKind(raw) != "string" {
		return "", false
	}
	return decodeJSONString(raw)
}

func objectMember(object map[string]json.RawMessage, key string) map[string]json.RawMessage {
	raw, ok := object[key]
	if !ok || jsonKind(raw) != "object" {
		return nil
	}
	var child map[string]json.RawMessage
	if err := json.Unmarshal(raw, &child); err != nil {
		return nil
	}
	return child
}

func numberMember(object map[string]json.RawMessage, key string) (float64, bool) {
	raw, ok := object[key]
	if !ok || jsonKind(raw) != "number" {
		return 0, false
	}
	return decodeJSONNumber(raw)
}

// extractUrlQueryParamAllowlist is extractUrlQueryParamAllowlist: the payload
// metadata value goes through resolveQueryParamAllowlist with the default list
// as fallback.
func extractUrlQueryParamAllowlist(payload NormalizedPayload) []string {
	metadata := payloadMetadataMap(payload)
	raw, present := metadata["urlQueryParamAllowlist"]
	if !present {
		return normalizeURLQueryParamAllowlist(nil, defaultURLQueryParamAllowlist)
	}
	return normalizeURLQueryParamAllowlist(raw, defaultURLQueryParamAllowlist)
}

// normalizeURLQueryParamAllowlist ports normalizeUrlQueryParamAllowlist for the
// JSON domain.
func normalizeURLQueryParamAllowlist(value json.RawMessage, fallback []string) []string {
	normalized := make([]string, 0, len(fallback))
	seen := make(map[string]struct{}, len(fallback))
	appendKey := func(entry string) {
		key := jsLowercase(jsTrimString(entry))
		if key == "" || len(key) > maxQueryParamKeyLength || !queryParamKeyPattern.MatchString(key) {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		normalized = append(normalized, key)
	}

	useInput := jsonKind(value) != "undefined" && jsonKind(value) != "null"
	if !useInput {
		for _, entry := range fallback {
			appendKey(entry)
		}
		return normalized
	}
	switch jsonKind(value) {
	case "array":
		var entries []json.RawMessage
		if err := json.Unmarshal(value, &entries); err != nil {
			return normalized
		}
		for _, entry := range entries {
			if jsonKind(entry) != "string" {
				continue
			}
			text, _ := decodeJSONString(entry)
			appendKey(text)
			if len(normalized) >= maxURLQueryParamAllowlistSize {
				break
			}
		}
	case "string":
		text, _ := decodeJSONString(value)
		for _, entry := range splitAllowlistString(text) {
			appendKey(entry)
			if len(normalized) >= maxURLQueryParamAllowlistSize {
				break
			}
		}
	}
	return normalized
}

func splitAllowlistString(value string) []string {
	parts := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == '\n' })
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := jsTrimString(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// extractSeedDedupeWindowHours is extractSeedDedupeWindowHours: the seed's
// dedupeWindowHours rounded and clamped to [0, 30 days].
func extractSeedDedupeWindowHours(payload NormalizedPayload) *int {
	metadata := payloadMetadataMap(payload)
	seed := objectMember(metadata, "newsSourceSeed")
	if seed == nil {
		return nil
	}
	raw, ok := numberMember(seed, "dedupeWindowHours")
	if !ok || math.IsNaN(raw) || math.IsInf(raw, 0) {
		return nil
	}
	rounded := int(math.Round(raw))
	if rounded < 0 {
		rounded = 0
	}
	if rounded > 24*30 {
		rounded = 24 * 30
	}
	return intPointer(rounded)
}

// extractSourceId is extractSourceId: metadata.sourceId wins over
// metadata.newsnow.sourceId.
func extractSourceId(payload NormalizedPayload) *string {
	metadata := payloadMetadataMap(payload)
	if value, ok := stringMember(metadata, "sourceId"); ok {
		trimmed := jsTrimString(value)
		if trimmed != "" {
			return stringPointer(trimmed)
		}
	}
	newsnow := objectMember(metadata, "newsnow")
	if newsnow == nil {
		return nil
	}
	if value, ok := stringMember(newsnow, "sourceId"); ok {
		trimmed := jsTrimString(value)
		if trimmed != "" {
			return stringPointer(trimmed)
		}
	}
	return nil
}

// extractCrawlResultId is extractCrawlResultId.
func extractCrawlResultId(payload NormalizedPayload) *string {
	metadata := payloadMetadataMap(payload)
	value, ok := stringMember(metadata, "crawlResultId")
	if !ok {
		return nil
	}
	trimmed := jsTrimString(value)
	if trimmed == "" {
		return nil
	}
	return stringPointer(trimmed)
}

// --- tags / column bounds --------------------------------------------------

// buildTags is buildTags: payload tags first, then lowercased topics, deduped
// and capped at 20.
func buildTags(payload NormalizedPayload, cleaned CleanedNews) []string {
	seen := make(map[string]struct{}, len(payload.Tags)+len(cleaned.Topics))
	out := make([]string, 0, len(payload.Tags)+len(cleaned.Topics))
	add := func(value string) {
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	for _, tag := range payload.Tags {
		add(tag)
	}
	for _, topic := range cleaned.Topics {
		add(jsLowercase(topic))
	}
	if len(out) > 20 {
		out = out[:20]
	}
	return out
}

// toItemMetaName is toItemMetaName: 191 UTF-16 units, truncated with an
// ellipsis suffix.
func toItemMetaName(value string) string {
	trimmed := jsTrimString(value)
	if utf16Length(trimmed) <= 191 {
		return trimmed
	}
	return jsTrimEnd(truncateUTF16(trimmed, 190)) + "…"
}

// toArticleUrl is toArticleUrl: 512 UTF-16 units upper bound.
func toArticleUrl(value string) string {
	trimmed := jsTrimString(value)
	if utf16Length(trimmed) <= 512 {
		return trimmed
	}
	return truncateUTF16(trimmed, 512)
}

// computeBackoffDelay is computeBackoffDelay with an injectable random source
// (Math.random replacement) so retries stay deterministic in tests.
func computeBackoffDelay(baseDelayMs, attempt, maxAttempts int, random func() float64) int {
	if random == nil {
		random = func() float64 { return 0.5 }
	}
	bounded := attempt
	if bounded > maxAttempts {
		bounded = maxAttempts
	}
	exponent := bounded - 1
	if exponent < 0 {
		exponent = 0
	}
	exponentialDelay := float64(baseDelayMs) * math.Pow(2, float64(exponent))
	jitterFactor := 0.5 + random()
	return int(math.Round(exponentialDelay * jitterFactor))
}

// resolveFrontierLogMetadata is resolveFrontierLogMetadata: only non-empty
// string members are reported; nil when none matched.
func resolveFrontierLogMetadata(metadata json.RawMessage) *FrontierLogMetadata {
	if jsonKind(metadata) != "object" {
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(metadata, &object); err != nil {
		return nil
	}
	read := func(keys ...string) string {
		for _, key := range keys {
			value, ok := stringMember(object, key)
			if !ok {
				continue
			}
			trimmed := jsTrimString(value)
			if trimmed != "" {
				return trimmed
			}
		}
		return ""
	}
	resolved := &FrontierLogMetadata{
		RunID:     read("frontierRunId", "runId"),
		NodeID:    read("frontierNodeId", "nodeId"),
		ProfileID: read("crawlSiteProfileId", "profileId"),
	}
	if resolved.RunID == "" && resolved.NodeID == "" && resolved.ProfileID == "" {
		return nil
	}
	return resolved
}

// --- markdown selection ----------------------------------------------------

// readMarkdownField returns the first member that is a JSON string.
func readMarkdownField(record map[string]json.RawMessage, keys []string) *string {
	for _, key := range keys {
		value, ok := stringMember(record, key)
		if !ok {
			continue
		}
		return stringPointer(value)
	}
	return nil
}

// normalizeMarkdownCandidate trims a markdown candidate and treats blank as
// absent.
func normalizeMarkdownCandidate(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrimString(*value)
	if trimmed == "" {
		return nil
	}
	return stringPointer(trimmed)
}

// isLikelyBotChallengeMarkdown is isLikelyBotChallengeMarkdown; the length guard
// compares UTF-16 units like String.prototype.length.
func isLikelyBotChallengeMarkdown(markdown string) bool {
	normalized := jsLowercase(markdown)
	strongIndicators := []string{
		"verification required",
		"please enable js and disable any ad blocker",
		"please enable javascript",
		"checking your browser before accessing",
		"you are being rate limited",
		"verify you are human",
		"verifying the device",
	}
	for _, indicator := range strongIndicators {
		if strings.Contains(normalized, indicator) {
			return true
		}
	}
	weakIndicators := []string{
		"captcha",
		"cloudflare",
		"datadome",
		"are you human",
		"access denied",
		"security check",
		"automated requests",
		"bot detection",
	}
	weakHits := 0
	for _, indicator := range weakIndicators {
		if strings.Contains(normalized, indicator) {
			weakHits++
		}
	}
	return weakHits >= 2 && utf16Length(normalized) < 12000
}

// selectBestMarkdownFromContentDoc is selectBestMarkdownFromContentDoc: prefer a
// richer non-challenge citation/raw markdown over the primary crawl markdown.
func selectBestMarkdownFromContentDoc(record map[string]json.RawMessage) *string {
	primary := normalizeMarkdownCandidate(readMarkdownField(record, []string{"markdown"}))
	citations := normalizeMarkdownCandidate(readMarkdownField(record, []string{"markdownWithCitations", "markdown_with_citations"}))
	raw := normalizeMarkdownCandidate(readMarkdownField(record, []string{"rawMarkdown", "raw_markdown"}))
	fit := normalizeMarkdownCandidate(readMarkdownField(record, []string{"fitMarkdown", "fit_markdown"}))

	current := primary
	if current == nil {
		current = citations
	}
	if current == nil {
		current = raw
	}
	if current == nil {
		current = fit
	}
	if current == nil {
		return nil
	}

	var richer *string
	switch {
	case citations == nil:
		richer = raw
	case raw == nil:
		richer = citations
	case utf16Length(*citations) >= utf16Length(*raw):
		richer = citations
	default:
		richer = raw
	}
	if richer == nil || *richer == *current {
		return current
	}

	currentChallenge := isLikelyBotChallengeMarkdown(*current)
	richerChallenge := isLikelyBotChallengeMarkdown(*richer)
	if currentChallenge && !richerChallenge {
		return richer
	}
	currentLength := utf16Length(*current)
	richerLength := utf16Length(*richer)
	if fit != nil && *current == *fit && richerLength >= 1600 && currentLength <= 800 {
		return richer
	}
	if richerLength >= 1200 && float64(currentLength) < float64(richerLength)*0.33 {
		return richer
	}
	if currentLength < 320 && richerLength >= 1000 {
		return richer
	}
	return current
}

// --- open JSON coercion ----------------------------------------------------

// toStringArray is toStringArray: strings are trimmed, numbers are rendered,
// everything else is dropped and blank entries are filtered out.
func toStringArray(value json.RawMessage) []string {
	if jsonKind(value) != "array" {
		return []string{}
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(value, &entries); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var candidate string
		switch jsonKind(entry) {
		case "string":
			candidate, _ = decodeJSONString(entry)
		case "number":
			number, ok := decodeJSONNumber(entry)
			if !ok {
				continue
			}
			candidate = jsNumberToString(number)
		default:
			continue
		}
		trimmed := jsTrimString(candidate)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

// jsNumberToString approximates Number.prototype.toString for the numeric
// entries toStringArray can see.
func jsNumberToString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	absolute := math.Abs(value)
	if absolute == 0 {
		return "0"
	}
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	return normalizeExponent(formatted)
}

func normalizeExponent(formatted string) string {
	index := strings.IndexAny(formatted, "eE")
	if index < 0 {
		return formatted
	}
	mantissa := formatted[:index]
	exponent := formatted[index+1:]
	sign := "+"
	if len(exponent) > 0 && (exponent[0] == '+' || exponent[0] == '-') {
		sign = string(exponent[0])
		exponent = exponent[1:]
	}
	for len(exponent) > 1 && exponent[0] == '0' {
		exponent = exponent[1:]
	}
	if exponent == "0" {
		return mantissa
	}
	return mantissa + "e" + sign + exponent
}

// normalizeEntities is normalizeEntities: malformed entries are dropped instead
// of failing the pipeline, confidence is clamped to [0,1] and defaults to 0.
func normalizeEntities(value json.RawMessage) []Entity {
	if jsonKind(value) != "array" {
		return []Entity{}
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(value, &entries); err != nil {
		return []Entity{}
	}
	out := make([]Entity, 0, len(entries))
	for _, entry := range entries {
		if jsonKind(entry) != "object" {
			continue
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(entry, &record); err != nil {
			continue
		}
		name, nameOK := stringMember(record, "name")
		entityType, typeOK := stringMember(record, "type")
		if !nameOK || !typeOK {
			continue
		}
		confidence := 0.0
		if raw, ok := numberMember(record, "confidence"); ok && !math.IsNaN(raw) && !math.IsInf(raw, 0) {
			confidence = math.Min(1, math.Max(0, raw))
		}
		out = append(out, Entity{Name: name, Type: entityType, Confidence: confidence})
	}
	return out
}

// normalizeKgRelations is normalizeKgRelations: kg_relations is safeParsed with
// the CleanedNews schema slice; any invalid entry drops the whole list.
func normalizeKgRelations(value json.RawMessage) []KGRelation {
	relations, err := kgRelationsMember(map[string]json.RawMessage{"kg_relations": value})
	if err != nil {
		return []KGRelation{}
	}
	return relations
}

// --- LLM JSON extraction ---------------------------------------------------

// ExtractFirstJSON ports extractFirstJson: strip a surrounding markdown code
// fence, then return the first balanced JSON object/array slice. An empty
// string means no JSON value was found (the TypeScript helper returns null).
func ExtractFirstJSON(text string) string {
	cleaned := stripMarkdownCodeFence(text)
	startObject := strings.Index(cleaned, "{")
	startArray := strings.Index(cleaned, "[")
	start := startObject
	if start == -1 {
		start = startArray
	} else if startArray != -1 && startArray < start {
		start = startArray
	}
	if start == -1 {
		return ""
	}
	stack := make([]byte, 0, 4)
	inString := false
	escaped := false
	for index := start; index < len(cleaned); index++ {
		character := cleaned[index]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if character == '\\' {
				escaped = true
				continue
			}
			if character == '"' {
				inString = false
			}
			continue
		}
		switch character {
		case '"':
			inString = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) == 0 {
				return ""
			}
			expected := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if expected != character {
				return ""
			}
			if len(stack) == 0 {
				return jsTrimString(cleaned[start : index+1])
			}
		}
	}
	return ""
}

// stripMarkdownCodeFence ports stripMarkdownCodeFence.
func stripMarkdownCodeFence(text string) string {
	trimmed := jsTrimString(text)
	if !strings.HasPrefix(trimmed, "```") {
		return trimmed
	}
	firstNewline := strings.IndexByte(trimmed, '\n')
	if firstNewline == -1 {
		return trimmed
	}
	afterFence := trimmed[firstNewline+1:]
	closingFence := strings.LastIndex(afterFence, "```")
	if closingFence == -1 {
		return trimmed
	}
	return jsTrimString(afterFence[:closingFence])
}

// safeJSONParseFromText ports safeJsonParseFromText: extract the first JSON
// value and decode it, reporting false when the text holds no valid JSON.
func safeJSONParseFromText(text string) (json.RawMessage, bool) {
	extracted := ExtractFirstJSON(text)
	if extracted == "" {
		return nil, false
	}
	if !json.Valid([]byte(extracted)) {
		return nil, false
	}
	return json.RawMessage(extracted), true
}

// --- stored-row error classification --------------------------------------

// isPrismaUniqueConstraintError maps Prisma P2002 to the MySQL duplicate-key
// error it originates from.
func isPrismaUniqueConstraintError(err error) bool {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	return false
}

// isDuplicateKeyError reports Mongo duplicate-key errors and their MySQL
// equivalent (Prisma raw 1062).
func isDuplicateKeyError(err error) bool {
	if err == nil {
		return false
	}
	if mongo.IsDuplicateKeyError(err) {
		return true
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	return false
}

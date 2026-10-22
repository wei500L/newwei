package newspipeline

// This file ports NewsExtractionSettingsService, NewsDedupeSettingsService and
// NewsPromptConfigService.getConfig to Go.
//
// Every read follows the NestJS degradation path: a Redis cache entry wins when
// it decodes, a database read failure falls back to the built-in defaults and a
// successful database read is written back to the same 60 second cache keys
// NestJS uses. There is no error return by design: the pipeline must keep
// running on missing/invalid settings.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/redis/go-redis/v9"
)

const (
	settingsCacheTTL = 60 * time.Second

	extractionSettingsCacheKeyPrefix = "newsExtraction:settings:"
	extractionSystemSettingKeyPrefix = "news_extraction_settings:"

	dedupeSettingsCacheKeyPrefix = "newsDedupe:settings:"
	dedupeSystemSettingKeyPrefix = "news_dedupe_settings:"

	promptConfigSystemSettingKey = "news_pipeline_prompt_config"

	minExtractionWordCount   = 0
	maxExtractionWordCount   = 10_000
	minCleanedChars          = 0
	maxCleanedChars          = 100_000
	minExtractionScore       = 0
	maxExtractionScore       = 1
	maxScopedThresholds      = 100
	maxScopeSourceIDLength   = 191
	maxScopeLanguageLength   = 32
	maxScopeCategoryPathLen  = 240
	minDedupeThreshold       = 0
	maxDedupeThreshold       = 1
	maxJudgeInstructionsLen  = 2_000
	maxJudgeModelLength      = 120
	defaultJudgeConcurrency  = 4
	minJudgeConcurrency      = 1
	maxJudgeConcurrency      = 8
	defaultJudgeComparisons  = 12
	minJudgeComparisons      = 1
	maxJudgeComparisons      = 30
	defaultJudgeCandidateLen = 1_200
	minJudgeCandidateChars   = 200
	maxJudgeCandidateChars   = 5_000
	maxJudgePromptVersionLen = 80
	maxJudgeTemplateLength   = 12_000
)

// SettingsReader implements SettingsProvider against MySQL + Redis.
type SettingsReader struct {
	db     *sql.DB
	redis  *redis.Client
	config NewsPipelineConfig
}

// NewSettingsReader wires the shared MySQL pool, Redis client and the merged
// pipeline config (the dedupe default threshold comes from it, like
// NewsDedupeSettingsService depends on NewsPipelineConfigService).
func NewSettingsReader(db *sql.DB, redisClient *redis.Client, config NewsPipelineConfig) *SettingsReader {
	return &SettingsReader{db: db, redis: redisClient, config: config}
}

// Extraction returns the effective extraction settings, degrading to defaults.
func (s *SettingsReader) Extraction(ctx context.Context, orgID string) ExtractionSettings {
	defaults := fallbackExtractionSettings()
	cacheKey := extractionSettingsCacheKeyPrefix + orgID
	if document, ok := s.readCachedDocument(ctx, cacheKey); ok {
		return normalizeExtractionSettings(document)
	}
	document, loaded := s.loadSettingsDocument(ctx, extractionSystemSettingKeyPrefix+orgID)
	if !loaded {
		return defaults
	}
	settings := normalizeExtractionSettings(document)
	s.writeCachedSettings(ctx, cacheKey, newExtractionSettingsCacheDocument(settings))
	return settings
}

// ExtractionSettings is an explicit alias of Extraction.
func (s *SettingsReader) ExtractionSettings(ctx context.Context, orgID string) ExtractionSettings {
	return s.Extraction(ctx, orgID)
}

// Dedupe returns the effective dedupe settings, degrading to defaults.
func (s *SettingsReader) Dedupe(ctx context.Context, orgID string) DedupeSettings {
	defaults := s.fallbackDedupeSettings()
	cacheKey := dedupeSettingsCacheKeyPrefix + orgID
	if document, ok := s.readCachedDocument(ctx, cacheKey); ok {
		return normalizeDedupeSettings(document, defaults)
	}
	document, loaded := s.loadSettingsDocument(ctx, dedupeSystemSettingKeyPrefix+orgID)
	if !loaded {
		return defaults
	}
	settings := normalizeDedupeSettings(document, defaults)
	s.writeCachedSettings(ctx, cacheKey, newDedupeSettingsCacheDocument(settings))
	return settings
}

// DedupeSettings is an explicit alias of Dedupe.
func (s *SettingsReader) DedupeSettings(ctx context.Context, orgID string) DedupeSettings {
	return s.Dedupe(ctx, orgID)
}

// PromptConfig returns the global prompt configuration (no org scoping, no
// cache, exactly like NewsPromptConfigService.getConfig).
func (s *SettingsReader) PromptConfig(ctx context.Context) PromptConfig {
	raw, err := s.loadSetting(ctx, promptConfigSystemSettingKey)
	if err != nil {
		return DefaultNewsPromptConfig
	}
	return normalizePromptConfig(raw)
}

// readCachedDocument reads and decodes one cached settings document. Any cache
// error or malformed value is a cache miss.
func (s *SettingsReader) readCachedDocument(ctx context.Context, cacheKey string) (map[string]json.RawMessage, bool) {
	if s == nil || s.redis == nil {
		return nil, false
	}
	encoded, err := s.redis.Get(ctx, cacheKey).Bytes()
	if err != nil {
		return nil, false
	}
	return decodeSettingDocument(encoded)
}

// decodeSettingDocument unmarshals a JSON settings document into its raw
// members. A document that is not a JSON object is treated as a cache miss.
func decodeSettingDocument(encoded []byte) (map[string]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(encoded)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return nil, false
	}
	return document, document != nil
}

// loadSettingsDocument reads one SystemSetting JSON document. The bool is false
// only on a database failure; a missing row yields an empty document, exactly
// like Prisma findUnique returning null followed by normalize({}).
func (s *SettingsReader) loadSettingsDocument(ctx context.Context, key string) (map[string]json.RawMessage, bool) {
	raw, err := s.loadSetting(ctx, key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return map[string]json.RawMessage{}, true
		}
		return nil, false
	}
	return jsonObjectOrEmpty(raw), true
}

// settingsCacheDocument is one typed settings cache payload. The cache write path
// takes this interface instead of a schema-less container so the cached document
// stays a named type (the same shape NestJS serializes into the shared cache
// keys).
type settingsCacheDocument interface {
	encodeSettingsCacheDocument() ([]byte, error)
}

// writeCachedSettings is the best-effort CacheService.set call.
func (s *SettingsReader) writeCachedSettings(ctx context.Context, cacheKey string, document settingsCacheDocument) {
	if s == nil || s.redis == nil {
		return
	}
	encoded, err := document.encodeSettingsCacheDocument()
	if err != nil {
		return
	}
	_ = s.redis.Set(ctx, cacheKey, encoded, settingsCacheTTL).Err()
}

// loadSetting reads one SystemSetting value by key.
func (s *SettingsReader) loadSetting(ctx context.Context, key string) ([]byte, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("newspipeline: mysql is not configured")
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

// jsonObjectOrEmpty decodes a JSON object member document; anything else
// becomes an empty document (missing SystemSetting row semantics).
func jsonObjectOrEmpty(raw json.RawMessage) map[string]json.RawMessage {
	if jsonKind(raw) != "object" {
		return map[string]json.RawMessage{}
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		return map[string]json.RawMessage{}
	}
	return document
}

// --- raw settings document readers ----------------------------------------

func settingObject(document map[string]json.RawMessage, key string) map[string]json.RawMessage {
	raw, ok := document[key]
	if !ok || jsonKind(raw) != "object" {
		return nil
	}
	var child map[string]json.RawMessage
	if err := json.Unmarshal(raw, &child); err != nil {
		return nil
	}
	return child
}

func settingBool(document map[string]json.RawMessage, key string) (bool, bool) {
	raw, ok := document[key]
	if !ok || jsonKind(raw) != "boolean" {
		return false, false
	}
	return bytes.Equal(bytes.TrimSpace(raw), []byte("true")), true
}

func settingString(document map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := document[key]
	if !ok || jsonKind(raw) != "string" {
		return "", false
	}
	return decodeJSONString(raw)
}

// settingNumber is the extraction service's typeof check: a JSON number only.
func settingNumber(document map[string]json.RawMessage, key string) (float64, bool) {
	raw, ok := document[key]
	if !ok || jsonKind(raw) != "number" {
		return 0, false
	}
	value, ok := decodeJSONNumber(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// settingNumberOrString is the dedupe service's toNumber: a JSON number or a
// numeric string.
func settingNumberOrString(document map[string]json.RawMessage, key string) (float64, bool) {
	raw, ok := document[key]
	if !ok {
		return 0, false
	}
	switch jsonKind(raw) {
	case "number":
		value, ok := decodeJSONNumber(raw)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	case "string":
		text, _ := decodeJSONString(raw)
		trimmed := jsTrimString(text)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func settingArray(document map[string]json.RawMessage, key string) []json.RawMessage {
	raw, ok := document[key]
	if !ok || jsonKind(raw) != "array" {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	return entries
}

// --- extraction settings ---------------------------------------------------

func fallbackExtractionSettings() ExtractionSettings {
	return ExtractionSettings{
		PipelineMode: PipelineModeStaged,
		PreflightGate: PreflightGate{
			Enabled:            true,
			MinWordCount:       120,
			MinQualityScore:    0.35,
			RejectBotChallenge: true,
			RejectListLike:     true,
		},
		PostCleanGate: PostCleanGate{
			Enabled:         true,
			MinQualityScore: 0.35,
			MinCleanedChars: 400,
			RequireSummary:  true,
		},
		Capabilities: ExtractionCapabilities{Entities: true, Sentiment: true, KG: true},
		Providers: ExtractionProviders{
			Clean: "llm", Entities: "llm", Sentiment: "llm", KG: "llm",
		},
	}
}

// normalizeExtractionSettings is normalizeSettings from
// NewsExtractionSettingsService.
func normalizeExtractionSettings(value map[string]json.RawMessage) ExtractionSettings {
	defaults := fallbackExtractionSettings()
	if value == nil {
		return defaults
	}
	preflight := settingObject(value, "preflightGate")
	postClean := settingObject(value, "postCleanGate")
	capabilities := settingObject(value, "capabilities")
	providers := settingObject(value, "providers")
	return ExtractionSettings{
		PipelineMode: normalizeExtractionPipelineMode(settingStringValue(value, "pipelineMode"), defaults.PipelineMode),
		PreflightGate: PreflightGate{
			Enabled:            boolOrDefault(settingBoolValue(preflight, "enabled"), defaults.PreflightGate.Enabled),
			MinWordCount:       extractionClampInt(settingNumberValue(preflight, "minWordCount"), minExtractionWordCount, maxExtractionWordCount, defaults.PreflightGate.MinWordCount),
			MinQualityScore:    extractionClampFloat(settingNumberValue(preflight, "minQualityScore"), minExtractionScore, maxExtractionScore, defaults.PreflightGate.MinQualityScore),
			RejectBotChallenge: boolOrDefault(settingBoolValue(preflight, "rejectBotChallenge"), defaults.PreflightGate.RejectBotChallenge),
			RejectListLike:     boolOrDefault(settingBoolValue(preflight, "rejectListLike"), defaults.PreflightGate.RejectListLike),
		},
		PostCleanGate: PostCleanGate{
			Enabled:         boolOrDefault(settingBoolValue(postClean, "enabled"), defaults.PostCleanGate.Enabled),
			MinQualityScore: extractionClampFloat(settingNumberValue(postClean, "minQualityScore"), minExtractionScore, maxExtractionScore, defaults.PostCleanGate.MinQualityScore),
			MinCleanedChars: extractionClampInt(settingNumberValue(postClean, "minCleanedChars"), minCleanedChars, maxCleanedChars, defaults.PostCleanGate.MinCleanedChars),
			RequireSummary:  boolOrDefault(settingBoolValue(postClean, "requireSummary"), defaults.PostCleanGate.RequireSummary),
		},
		Capabilities: ExtractionCapabilities{
			Entities:  boolOrDefault(settingBoolValue(capabilities, "entities"), defaults.Capabilities.Entities),
			Sentiment: boolOrDefault(settingBoolValue(capabilities, "sentiment"), defaults.Capabilities.Sentiment),
			KG:        boolOrDefault(settingBoolValue(capabilities, "kg"), defaults.Capabilities.KG),
		},
		Providers: ExtractionProviders{
			Clean:     normalizeExtractionProvider(settingStringValue(providers, "clean"), defaults.Providers.Clean),
			Entities:  normalizeExtractionProvider(settingStringValue(providers, "entities"), defaults.Providers.Entities),
			Sentiment: normalizeExtractionProvider(settingStringValue(providers, "sentiment"), defaults.Providers.Sentiment),
			KG:        normalizeExtractionProvider(settingStringValue(providers, "kg"), defaults.Providers.KG),
		},
	}
}

func settingBoolValue(document map[string]json.RawMessage, key string) *bool {
	if value, ok := settingBool(document, key); ok {
		copy := value
		return &copy
	}
	return nil
}

func settingNumberValue(document map[string]json.RawMessage, key string) *float64 {
	if value, ok := settingNumber(document, key); ok {
		copy := value
		return &copy
	}
	return nil
}

func settingStringValue(document map[string]json.RawMessage, key string) *string {
	if value, ok := settingString(document, key); ok {
		copy := value
		return &copy
	}
	return nil
}

func boolOrDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func normalizeExtractionPipelineMode(value *string, fallback PipelineMode) PipelineMode {
	if value == nil {
		return fallback
	}
	switch PipelineMode(*value) {
	case PipelineModeStaged:
		return PipelineModeStaged
	case PipelineModeLegacy:
		return PipelineModeLegacy
	default:
		return fallback
	}
}

func normalizeExtractionProvider(value *string, fallback string) string {
	if value != nil && *value == "llm" {
		return "llm"
	}
	return fallback
}

// extractionClampFloat is clampFloat: a missing/non-number value yields the
// fallback.
func extractionClampFloat(value *float64, minimum, maximum, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	numeric := *value
	if numeric < minimum {
		return minimum
	}
	if numeric > maximum {
		return maximum
	}
	return numeric
}

// extractionClampInt is clampInt: round then clamp, fallback when absent.
func extractionClampInt(value *float64, minimum, maximum, fallback int) int {
	if value == nil {
		return fallback
	}
	rounded := int(math.Round(*value))
	if rounded < minimum {
		return minimum
	}
	if rounded > maximum {
		return maximum
	}
	return rounded
}

// --- dedupe settings -------------------------------------------------------

func (s *SettingsReader) fallbackDedupeSettings() DedupeSettings {
	defaultThreshold := 0.0
	if s != nil {
		defaultThreshold = s.config.Pipeline.SummaryDedupThreshold
	}
	return DedupeSettings{
		DefaultThreshold:       defaultThreshold,
		ScopedThresholds:       []ScopedThreshold{},
		UseEmbeddings:          true,
		LLMJudgeInstructions:   nil,
		LLMJudgeModel:          nil,
		LLMJudgeConcurrency:    defaultJudgeConcurrency,
		LLMJudgeMaxComparisons: defaultJudgeComparisons,
		LLMJudgeCandidateChars: defaultJudgeCandidateLen,
		LLMJudgePromptVersion:  DefaultNewsDedupePromptVersion,
		LLMJudgeSystemPrompt:   DefaultNewsDedupeSystemPromptTemplate,
		LLMJudgeUserPrompt:     DefaultNewsDedupeUserPromptTemplate,
	}
}

// normalizeDedupeSettings is normalizeSettings from
// NewsDedupeSettingsService, including scoped-threshold normalization.
func normalizeDedupeSettings(value map[string]json.RawMessage, defaults DedupeSettings) DedupeSettings {
	if value == nil {
		return defaults
	}
	defaultThreshold := dedupeClampFloat(settingNumberOrStringValue(value, "defaultThreshold"), minDedupeThreshold, maxDedupeThreshold, defaults.DefaultThreshold)
	useEmbeddings := boolOrDefault(settingBoolValue(value, "useEmbeddings"), defaults.UseEmbeddings)
	instructions := cleanJudgeString(settingStringValue(value, "llmJudgeInstructions"), maxJudgeInstructionsLen)
	model := cleanJudgeString(settingStringValue(value, "llmJudgeModel"), maxJudgeModelLength)
	concurrency := dedupeClampInt(settingNumberOrStringValue(value, "llmJudgeConcurrency"), minJudgeConcurrency, maxJudgeConcurrency, defaults.LLMJudgeConcurrency)
	maxComparisons := dedupeClampInt(settingNumberOrStringValue(value, "llmJudgeMaxComparisons"), minJudgeComparisons, maxJudgeComparisons, defaults.LLMJudgeMaxComparisons)
	candidateChars := dedupeClampInt(settingNumberOrStringValue(value, "llmJudgeCandidateChars"), minJudgeCandidateChars, maxJudgeCandidateChars, defaults.LLMJudgeCandidateChars)
	promptVersion := defaults.LLMJudgePromptVersion
	if cleaned := cleanJudgeString(settingStringValue(value, "llmJudgePromptVersion"), maxJudgePromptVersionLen); cleaned != nil {
		promptVersion = *cleaned
	}
	systemPrompt := defaults.LLMJudgeSystemPrompt
	if cleaned := cleanJudgeString(settingStringValue(value, "llmJudgeSystemPromptTemplate"), maxJudgeTemplateLength); cleaned != nil {
		systemPrompt = *cleaned
	}
	userPrompt := defaults.LLMJudgeUserPrompt
	if cleaned := cleanJudgeString(settingStringValue(value, "llmJudgeUserPromptTemplate"), maxJudgeTemplateLength); cleaned != nil {
		userPrompt = *cleaned
	}
	return DedupeSettings{
		DefaultThreshold:       defaultThreshold,
		ScopedThresholds:       normalizeScopedThresholds(value, defaultThreshold),
		UseEmbeddings:          useEmbeddings,
		LLMJudgeInstructions:   instructions,
		LLMJudgeModel:          model,
		LLMJudgeConcurrency:    concurrency,
		LLMJudgeMaxComparisons: maxComparisons,
		LLMJudgeCandidateChars: candidateChars,
		LLMJudgePromptVersion:  promptVersion,
		LLMJudgeSystemPrompt:   systemPrompt,
		LLMJudgeUserPrompt:     userPrompt,
	}
}

func settingNumberOrStringValue(document map[string]json.RawMessage, key string) *float64 {
	if value, ok := settingNumberOrString(document, key); ok {
		copy := value
		return &copy
	}
	return nil
}

// cleanJudgeString is cleanLlmJudgeInstructions/cleanLlmJudgeModel/
// cleanPromptVersion/cleanPromptTemplate: trim, empty means absent, truncate.
func cleanJudgeString(value *string, maxLength int) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrimString(*value)
	if trimmed == "" {
		return nil
	}
	if utf16Length(trimmed) > maxLength {
		trimmed = truncateUTF16(trimmed, maxLength)
	}
	return stringPointer(trimmed)
}

// dedupeClampFloat is clampFloat with the service's toNumber semantics.
func dedupeClampFloat(value *float64, minimum, maximum, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	numeric := *value
	if numeric < minimum {
		return minimum
	}
	if numeric > maximum {
		return maximum
	}
	return numeric
}

func dedupeClampInt(value *float64, minimum, maximum, fallback int) int {
	if value == nil {
		return fallback
	}
	rounded := int(math.Round(*value))
	if rounded < minimum {
		return minimum
	}
	if rounded > maximum {
		return maximum
	}
	return rounded
}

// scopedThresholdDraft carries the precomputed map/sort keys so the comparator
// never rebuilds them (same optimization as the TypeScript service).
type scopedThresholdDraft struct {
	value   ScopedThreshold
	scope   string
	sortKey string
}

func normalizeScopedThresholds(value map[string]json.RawMessage, defaultThreshold float64) []ScopedThreshold {
	normalized := make(map[string]scopedThresholdDraft)
	add := func(entry ScopedThreshold) {
		draft := scopedThresholdDraft{
			value:   entry,
			scope:   buildDedupeScopeKey(entry.SourceID, entry.Language, entry.CategoryPath),
			sortKey: buildDedupeScopeSortKey(entry),
		}
		normalized[draft.scope] = draft
	}
	for _, rawEntry := range settingArray(value, "scopedThresholds") {
		record := rawJSONObject(rawEntry)
		if record == nil {
			continue
		}
		sourceID := cleanScopeToken(settingStringValue(record, "sourceId"), maxScopeSourceIDLength, false)
		language := cleanScopeToken(settingStringValue(record, "language"), maxScopeLanguageLength, true)
		categoryPath := cleanScopeToken(settingStringValue(record, "categoryPath"), maxScopeCategoryPathLen, false)
		if sourceID == nil && language == nil && categoryPath == nil {
			continue
		}
		threshold := dedupeClampFloat(settingNumberOrStringValue(record, "threshold"), minDedupeThreshold, maxDedupeThreshold, defaultThreshold)
		add(ScopedThreshold{SourceID: sourceID, Language: language, CategoryPath: categoryPath, Threshold: threshold})
		if len(normalized) >= maxScopedThresholds {
			break
		}
	}
	for _, rawEntry := range settingArray(value, "categoryThresholds") {
		record := rawJSONObject(rawEntry)
		if record == nil {
			continue
		}
		categoryPath := cleanScopeToken(settingStringValue(record, "category"), maxScopeCategoryPathLen, false)
		if categoryPath == nil {
			continue
		}
		threshold := dedupeClampFloat(settingNumberOrStringValue(record, "threshold"), minDedupeThreshold, maxDedupeThreshold, defaultThreshold)
		entry := ScopedThreshold{SourceID: nil, Language: nil, CategoryPath: categoryPath, Threshold: threshold}
		scope := buildDedupeScopeKey(entry.SourceID, entry.Language, entry.CategoryPath)
		if _, exists := normalized[scope]; !exists {
			add(entry)
		}
		if len(normalized) >= maxScopedThresholds {
			break
		}
	}
	drafts := make([]scopedThresholdDraft, 0, len(normalized))
	for _, draft := range normalized {
		drafts = append(drafts, draft)
	}
	sort.SliceStable(drafts, func(left, right int) bool {
		return drafts[left].sortKey < drafts[right].sortKey
	})
	out := make([]ScopedThreshold, 0, len(drafts))
	for _, draft := range drafts {
		out = append(out, draft.value)
	}
	return out
}

func rawJSONObject(raw json.RawMessage) map[string]json.RawMessage {
	if jsonKind(raw) != "object" {
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil
	}
	return object
}

// cleanScopeToken is cleanScopeToken: collapse internal whitespace, bound the
// length and optionally lowercase.
func cleanScopeToken(value *string, maxLength int, forceLowercase bool) *string {
	if value == nil {
		return nil
	}
	collapsed := collapseWhitespace(jsTrimString(*value))
	if collapsed == "" {
		return nil
	}
	if utf16Length(collapsed) > maxLength {
		collapsed = truncateUTF16(collapsed, maxLength)
	}
	if forceLowercase {
		collapsed = jsLowercase(collapsed)
	}
	return stringPointer(collapsed)
}

// collapseWhitespace is String.prototype.replace(/\s+/g, " ").
func collapseWhitespace(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	previousWhitespace := false
	for _, r := range value {
		if r == '\uFEFF' || unicode.IsSpace(r) {
			if !previousWhitespace {
				builder.WriteByte(' ')
				previousWhitespace = true
			}
			continue
		}
		builder.WriteRune(r)
		previousWhitespace = false
	}
	return builder.String()
}

func normalizeDedupeScopePart(value *string) string {
	if value == nil || *value == "" {
		return "*"
	}
	return jsLowercase(collapseWhitespace(jsTrimString(*value)))
}

func buildDedupeScopeKey(sourceID, language, categoryPath *string) string {
	return normalizeDedupeScopePart(sourceID) + "|" + normalizeDedupeScopePart(language) + "|" + normalizeDedupeScopePart(categoryPath)
}

func buildDedupeScopeSortKey(scope ScopedThreshold) string {
	value := ""
	if scope.SourceID != nil {
		value = *scope.SourceID
	}
	language := ""
	if scope.Language != nil {
		language = *scope.Language
	}
	categoryPath := ""
	if scope.CategoryPath != nil {
		categoryPath = *scope.CategoryPath
	}
	return value + "\x00" + language + "\x00" + categoryPath + "\x00" + strconv.FormatFloat(scope.Threshold, 'f', 6, 64)
}

// ResolveDedupeBaseThreshold is NewsDedupeSettingsService.resolveBaseThreshold:
// the most specific matching scope wins, otherwise the default threshold.
func ResolveDedupeBaseThreshold(
	settings DedupeSettings,
	sourceID *string,
	language *string,
	categoryPath *string,
) (float64, *ScopedThreshold) {
	index := make(map[string]ScopedThreshold, len(settings.ScopedThresholds))
	for _, entry := range settings.ScopedThresholds {
		index[buildDedupeScopeKey(entry.SourceID, entry.Language, entry.CategoryPath)] = entry
	}
	cleanedSourceID := cleanScopeToken(sourceID, maxScopeSourceIDLength, false)
	cleanedLanguage := cleanScopeToken(language, maxScopeLanguageLength, true)
	cleanedCategoryPath := cleanScopeToken(categoryPath, maxScopeCategoryPathLen, false)
	candidates := []ScopedThreshold{
		{SourceID: cleanedSourceID, Language: cleanedLanguage, CategoryPath: cleanedCategoryPath},
		{SourceID: cleanedSourceID, Language: cleanedLanguage},
		{SourceID: cleanedSourceID},
		{Language: cleanedLanguage, CategoryPath: cleanedCategoryPath},
		{Language: cleanedLanguage},
		{CategoryPath: cleanedCategoryPath},
	}
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		key := buildDedupeScopeKey(candidate.SourceID, candidate.Language, candidate.CategoryPath)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		if match, ok := index[key]; ok {
			matched := match
			return match.Threshold, &matched
		}
	}
	return settings.DefaultThreshold, nil
}

// extractionSettingsCacheDocument is the camelCase document NestJS serializes
// into the shared newsExtraction:settings:{orgId} cache key. The members are
// named fields so the cached payload is a typed contract instead of a
// schema-less map.
type extractionSettingsCacheDocument struct {
	PipelineMode  string `json:"pipelineMode"`
	PreflightGate struct {
		Enabled            bool    `json:"enabled"`
		MinWordCount       int     `json:"minWordCount"`
		MinQualityScore    float64 `json:"minQualityScore"`
		RejectBotChallenge bool    `json:"rejectBotChallenge"`
		RejectListLike     bool    `json:"rejectListLike"`
	} `json:"preflightGate"`
	PostCleanGate struct {
		Enabled         bool    `json:"enabled"`
		MinQualityScore float64 `json:"minQualityScore"`
		MinCleanedChars int     `json:"minCleanedChars"`
		RequireSummary  bool    `json:"requireSummary"`
	} `json:"postCleanGate"`
	Capabilities struct {
		Entities  bool `json:"entities"`
		Sentiment bool `json:"sentiment"`
		KG        bool `json:"kg"`
	} `json:"capabilities"`
	Providers struct {
		Clean     string `json:"clean"`
		Entities  string `json:"entities"`
		Sentiment string `json:"sentiment"`
		KG        string `json:"kg"`
	} `json:"providers"`
}

// encodeSettingsCacheDocument implements settingsCacheDocument.
func (d extractionSettingsCacheDocument) encodeSettingsCacheDocument() ([]byte, error) {
	return json.Marshal(d)
}

// newExtractionSettingsCacheDocument builds the typed cache document.
func newExtractionSettingsCacheDocument(settings ExtractionSettings) extractionSettingsCacheDocument {
	var document extractionSettingsCacheDocument
	document.PipelineMode = string(settings.PipelineMode)
	document.PreflightGate.Enabled = settings.PreflightGate.Enabled
	document.PreflightGate.MinWordCount = settings.PreflightGate.MinWordCount
	document.PreflightGate.MinQualityScore = settings.PreflightGate.MinQualityScore
	document.PreflightGate.RejectBotChallenge = settings.PreflightGate.RejectBotChallenge
	document.PreflightGate.RejectListLike = settings.PreflightGate.RejectListLike
	document.PostCleanGate.Enabled = settings.PostCleanGate.Enabled
	document.PostCleanGate.MinQualityScore = settings.PostCleanGate.MinQualityScore
	document.PostCleanGate.MinCleanedChars = settings.PostCleanGate.MinCleanedChars
	document.PostCleanGate.RequireSummary = settings.PostCleanGate.RequireSummary
	document.Capabilities.Entities = settings.Capabilities.Entities
	document.Capabilities.Sentiment = settings.Capabilities.Sentiment
	document.Capabilities.KG = settings.Capabilities.KG
	document.Providers.Clean = settings.Providers.Clean
	document.Providers.Entities = settings.Providers.Entities
	document.Providers.Sentiment = settings.Providers.Sentiment
	document.Providers.KG = settings.Providers.KG
	return document
}

// dedupeSettingsCacheScope is one normalized scoped-threshold entry of the
// dedupe cache document. Absent scope members stay JSON null like the
// TypeScript object.
type dedupeSettingsCacheScope struct {
	SourceID     *string `json:"sourceId"`
	Language     *string `json:"language"`
	CategoryPath *string `json:"categoryPath"`
	Threshold    float64 `json:"threshold"`
}

// dedupeSettingsCacheDocument is the camelCase document NestJS serializes into
// the shared newsDedupe:settings:{orgId} cache key.
type dedupeSettingsCacheDocument struct {
	DefaultThreshold       float64                    `json:"defaultThreshold"`
	ScopedThresholds       []dedupeSettingsCacheScope `json:"scopedThresholds"`
	UseEmbeddings          bool                       `json:"useEmbeddings"`
	LLMJudgeInstructions   *string                    `json:"llmJudgeInstructions"`
	LLMJudgeModel          *string                    `json:"llmJudgeModel"`
	LLMJudgeConcurrency    int                        `json:"llmJudgeConcurrency"`
	LLMJudgeMaxComparisons int                        `json:"llmJudgeMaxComparisons"`
	LLMJudgeCandidateChars int                        `json:"llmJudgeCandidateChars"`
	LLMJudgePromptVersion  string                     `json:"llmJudgePromptVersion"`
	LLMJudgeSystemPrompt   string                     `json:"llmJudgeSystemPromptTemplate"`
	LLMJudgeUserPrompt     string                     `json:"llmJudgeUserPromptTemplate"`
}

// encodeSettingsCacheDocument implements settingsCacheDocument.
func (d dedupeSettingsCacheDocument) encodeSettingsCacheDocument() ([]byte, error) {
	return json.Marshal(d)
}

// newDedupeSettingsCacheDocument builds the typed cache document.
func newDedupeSettingsCacheDocument(settings DedupeSettings) dedupeSettingsCacheDocument {
	scoped := make([]dedupeSettingsCacheScope, 0, len(settings.ScopedThresholds))
	for _, entry := range settings.ScopedThresholds {
		scoped = append(scoped, dedupeSettingsCacheScope{
			SourceID:     entry.SourceID,
			Language:     entry.Language,
			CategoryPath: entry.CategoryPath,
			Threshold:    entry.Threshold,
		})
	}
	return dedupeSettingsCacheDocument{
		DefaultThreshold:       settings.DefaultThreshold,
		ScopedThresholds:       scoped,
		UseEmbeddings:          settings.UseEmbeddings,
		LLMJudgeInstructions:   settings.LLMJudgeInstructions,
		LLMJudgeModel:          settings.LLMJudgeModel,
		LLMJudgeConcurrency:    settings.LLMJudgeConcurrency,
		LLMJudgeMaxComparisons: settings.LLMJudgeMaxComparisons,
		LLMJudgeCandidateChars: settings.LLMJudgeCandidateChars,
		LLMJudgePromptVersion:  settings.LLMJudgePromptVersion,
		LLMJudgeSystemPrompt:   settings.LLMJudgeSystemPrompt,
		LLMJudgeUserPrompt:     settings.LLMJudgeUserPrompt,
	}
}

package rsstranslation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

const (
	// defaultTargetLanguage is the SDL/service default.
	defaultTargetLanguage = "zh-CN"
	// maxTranslationItemIDs is the service-level item id limit.
	maxTranslationItemIDs = 50
)

// SettingsReader is the narrow port over the item reading settings surface: the
// two-provider status list and the resolved DeepLX runtime. Both are exported
// by itemsreading; no private symbol is crossed.
type SettingsReader interface {
	RssTranslationStatus(ctx context.Context, targetLanguage *string) ([]itemsreading.RssTranslationProviderStatus, error)
	TranslationRuntime(ctx context.Context) (itemsreading.TranslationRuntimeConfig, error)
}

// Options wires the RSS translation service. The database handles are required
// by the wiring layer; the service never proxies NestJS for a request it
// claims to serve.
type Options struct {
	// DB is the MySQL pool (SystemSetting reads and the daily metrics upsert).
	DB *sql.DB
	// Mongo is the Mongo database (processeditems and llmrequestlogs).
	Mongo *mongo.Database
	// Redis is the shared cache client (the two translation caches).
	Redis *redis.Client
	// Settings resolves provider availability and the DeepLX runtime.
	Settings SettingsReader
	// Completion performs one LLM text completion.
	Completion publicportal.RssTranslationCompleter
	// Observer receives every real LLM attempt. It may be nil.
	Observer publicportal.RssTranslationObserver
}

// Service performs the synchronous RSS translation chain.
type Service struct {
	db         *sql.DB
	mongo      *mongo.Database
	cache      *rssCache
	settings   SettingsReader
	completion publicportal.RssTranslationCompleter
	observer   publicportal.RssTranslationObserver
	deeplx     *deepLxClient
	llmSem     *semaphore
}

// NewService builds the RSS translation core.
func NewService(opts Options) *Service {
	cache := newRssCache(opts.Redis)
	return &Service{
		db:         opts.DB,
		mongo:      opts.Mongo,
		cache:      cache,
		settings:   opts.Settings,
		completion: opts.Completion,
		observer:   opts.Observer,
		deeplx:     newDeepLxClient(opts.Settings, cache),
		llmSem:     newSemaphore(defaultLLMConcurrency),
	}
}

// Translate ports ItemsRssTranslationService.translate. A normalized empty item
// id list returns immediately: no provider check, no Mongo read and no metrics
// row, exactly like NestJS.
func (s *Service) Translate(ctx context.Context, orgID string, input TranslateInput) (TranslateResult, error) {
	provider := input.Provider
	if provider == "" {
		provider = ProviderDeepLx
	}
	targetLanguage := normalizeTargetLanguage(input.TargetLanguage)
	itemIDs, err := normalizeItemIDs(input.ItemIDs)
	if err != nil {
		return TranslateResult{}, err
	}
	fields := normalizeFields(input.Fields)
	if len(itemIDs) == 0 || len(fields) == 0 {
		return TranslateResult{Provider: provider, TargetLanguage: targetLanguage, Translations: []ItemTranslation{}}, nil
	}

	metrics := newMetricsAccumulator(len(itemIDs))
	startedAt := time.Now()
	result, translateErr := s.translate(ctx, orgID, provider, targetLanguage, itemIDs, fields, metrics)
	// Mirror the NestJS catch: a request-level failure always reports at least
	// one failure even when no text was attempted.
	if translateErr != nil && metrics.failureCount == 0 {
		metrics.failureCount = 1
	}
	s.recordMetricsBestEffort(ctx, orgID, provider, targetLanguage, metrics, int(time.Since(startedAt).Milliseconds()))
	if translateErr != nil {
		return TranslateResult{}, translateErr
	}
	return result, nil
}

func (s *Service) translate(ctx context.Context, orgID string, provider Provider, targetLanguage string, itemIDs []string, fields []Field, metrics *metricsAccumulator) (TranslateResult, error) {
	if err := s.assertProviderAvailable(ctx, provider, targetLanguage); err != nil {
		return TranslateResult{}, err
	}

	var llmModel *string
	var llmConcurrency int
	if provider == ProviderLLM {
		model, err := s.completion.PrimaryModel(ctx)
		if err != nil {
			return TranslateResult{}, err
		}
		llmModel = normalizeOptionalString(model)
		llmConcurrency = s.resolveLLMConcurrency(ctx)
		s.llmSem.setLimit(llmConcurrency)
	}

	records, err := s.fetchLatestProcessedRecords(ctx, orgID, itemIDs)
	if err != nil {
		return TranslateResult{}, err
	}

	options := translateOptions{
		orgID:          orgID,
		provider:       provider,
		targetLanguage: targetLanguage,
		llmModel:       llmModel,
		llmConcurrency: llmConcurrency,
		metrics:        metrics,
	}
	// Per-item rejection only removes that item; the successful items keep
	// their order. This is the Promise.allSettled contract of the source
	// service, implemented sequentially because the per-item work is already
	// independent.
	translations := make([]ItemTranslation, 0, len(itemIDs))
	for _, itemID := range itemIDs {
		record, ok := records[itemID]
		if !ok {
			translations = append(translations, ItemTranslation{ItemID: itemID})
			continue
		}
		translated, err := s.translateRecordFields(ctx, itemID, record, fields, options)
		if err != nil {
			continue
		}
		translations = append(translations, translated)
	}
	return TranslateResult{Provider: provider, TargetLanguage: targetLanguage, Translations: translations}, nil
}

// translateRecordFields ports translateRecordFields. Fields are processed in
// the source order title -> summary -> key_points -> cleaned_markdown, and a
// field the caller did not request or whose source value is absent stays nil.
func (s *Service) translateRecordFields(ctx context.Context, itemID string, record processedRecord, fields []Field, options translateOptions) (ItemTranslation, error) {
	translated := ItemTranslation{ItemID: itemID}

	if containsField(fields, FieldTitle) && record.Title != nil {
		value, err := s.translateText(ctx, *record.Title, options)
		if err != nil {
			return ItemTranslation{}, err
		}
		translated.Title = &value
	}
	if containsField(fields, FieldSummary) && record.Summary != nil {
		value, err := s.translateText(ctx, *record.Summary, options)
		if err != nil {
			return ItemTranslation{}, err
		}
		translated.Summary = &value
	}
	if containsField(fields, FieldKeyPoints) && len(record.KeyPoints) > 0 {
		values, err := s.translateTextList(ctx, record.KeyPoints, options)
		if err != nil {
			return ItemTranslation{}, err
		}
		translated.KeyPoints = &values
	}
	if containsField(fields, FieldCleanedMarkdown) && record.CleanedMarkdown != nil {
		value, err := s.translateMarkdown(ctx, *record.CleanedMarkdown, options)
		if err != nil {
			return ItemTranslation{}, err
		}
		translated.CleanedMarkdown = &value
	}
	return translated, nil
}

// translateText ports translateText: the single element of translateTextList,
// with the original text as the fallback.
func (s *Service) translateText(ctx context.Context, text string, options translateOptions) (string, error) {
	values, err := s.translateTextList(ctx, []string{text}, options)
	if err != nil {
		return "", err
	}
	if len(values) == 0 {
		return text, nil
	}
	return values[0], nil
}

// translateTextList ports translateTextList. The outer cache is read with one
// MGET over the order-preserving deduplicated inputs; only successful,
// non-empty translations are written back, so a failure is retried by a later
// request instead of being cached.
func (s *Service) translateTextList(ctx context.Context, texts []string, options translateOptions) ([]string, error) {
	normalizedInputs := make([]string, 0, len(texts))
	for _, text := range texts {
		trimmed := strings.TrimSpace(text)
		if trimmed != "" {
			normalizedInputs = append(normalizedInputs, trimmed)
		}
	}
	if len(normalizedInputs) == 0 {
		return []string{}, nil
	}
	options.metrics.textCount += len(normalizedInputs)

	translatedByText := make(map[string]string, len(normalizedInputs))
	inputsForTranslation := make([]string, 0, len(normalizedInputs))
	for _, text := range normalizedInputs {
		if jsLength(text) <= maxTranslationTextChars {
			inputsForTranslation = append(inputsForTranslation, text)
			continue
		}
		// A plain text over the limit is returned verbatim and never sent
		// upstream or cached.
		options.metrics.skipTooLongCount++
		translatedByText[text] = text
	}
	if len(inputsForTranslation) == 0 {
		return mapTranslated(normalizedInputs, translatedByText), nil
	}

	uniqueInputs := dedupeStrings(inputsForTranslation)
	cacheKeys := make([]string, len(uniqueInputs))
	for index, text := range uniqueInputs {
		cacheKeys[index] = buildRSSKey(options.provider, options.targetLanguage, text, options.llmModel)
	}
	cached, err := s.cache.getManyStrings(ctx, cacheKeys)
	if err != nil {
		return nil, err
	}
	missingTexts := make([]string, 0, len(uniqueInputs))
	for index, text := range uniqueInputs {
		var cachedValue *string
		if index < len(cached) {
			cachedValue = cached[index]
		}
		if cachedValue != nil && strings.TrimSpace(*cachedValue) != "" {
			options.metrics.cacheHitCount++
			translatedByText[text] = strings.TrimSpace(*cachedValue)
			continue
		}
		options.metrics.cacheMissCount++
		missingTexts = append(missingTexts, text)
	}

	if len(missingTexts) > 0 {
		var translatedMissing map[string]string
		if options.provider == ProviderDeepLx {
			translatedMissing = s.deeplx.TranslateBestEffort(ctx, missingTexts)
		} else {
			translatedMissing = s.translateMissingViaLLM(ctx, missingTexts, options)
		}
		// A cache write failure fails the item like NestJS, but the remaining
		// successful texts are still written so a later request can hit them.
		var setErr error
		for _, text := range missingTexts {
			translatedValue := strings.TrimSpace(translatedMissing[text])
			if translatedValue == "" {
				options.metrics.failureCount++
				translatedByText[text] = text
				continue
			}
			options.metrics.translatedCount++
			translatedByText[text] = translatedValue
			if err := s.cache.setString(ctx, buildRSSKey(options.provider, options.targetLanguage, text, options.llmModel), translatedValue, rssCacheTTLSeconds); err != nil && setErr == nil {
				setErr = err
			}
		}
		if setErr != nil {
			return nil, setErr
		}
	}
	return mapTranslated(normalizedInputs, translatedByText), nil
}

// translateMarkdown ports translateMarkdown: an over-long document or one that
// needs more than 80 chunks is returned unchanged and only counted as skipped.
func (s *Service) translateMarkdown(ctx context.Context, markdown string, options translateOptions) (string, error) {
	if jsLength(markdown) > maxMarkdownChars {
		options.metrics.skipTooLongCount++
		return markdown, nil
	}
	chunks := splitMarkdownIntoChunks(markdown)
	if len(chunks) > maxMarkdownChunks {
		options.metrics.skipTooLongCount++
		return markdown, nil
	}
	translated, err := s.translateTextList(ctx, chunks, options)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.Join(translated, "\n\n")), nil
}

// translateMissingViaLLM ports translateMissingViaLlm: each text is translated
// under the shared LLM concurrency limit and a per-text failure only drops that
// text (the caller then falls back to the original).
func (s *Service) translateMissingViaLLM(ctx context.Context, texts []string, options translateOptions) map[string]string {
	if s.completion == nil {
		return map[string]string{}
	}
	s.llmSem.setLimit(normalizeLLMConcurrency(options.llmConcurrency))
	mapped := make(map[string]string, len(texts))
	var mu sync.Mutex
	var wait sync.WaitGroup
	for _, text := range texts {
		if text == "" {
			continue
		}
		wait.Add(1)
		go func(text string) {
			defer wait.Done()
			var translated string
			permitErr := s.llmSem.withPermit(ctx, func() {
				value, err := s.translateSingleTextViaLLM(ctx, text, options)
				if err != nil {
					log.Printf("api-go: RSS translation LLM call failed; using the original text")
					return
				}
				translated = value
			})
			if permitErr != nil || translated == "" {
				return
			}
			mu.Lock()
			mapped[text] = translated
			mu.Unlock()
		}(text)
	}
	wait.Wait()
	return mapped
}

// translateSingleTextViaLLM ports translateSingleTextViaLlm. The prompt is the
// verbatim source prompt; temperature is 0 and the token budget is derived from
// the JS length of the source text.
func (s *Service) translateSingleTextViaLLM(ctx context.Context, text string, options translateOptions) (string, error) {
	system := "You are a professional translation engine. Translate accurately, preserve markdown structure, links, numbers, and named entities. Return only the translated text without commentary."
	user := strings.Join([]string{
		"Target language: " + options.targetLanguage,
		"If the source text is already in target language, return the original text.",
		"Text:",
		text,
	}, "\n")
	maxTokens := int(math.Max(512, math.Min(4_000, math.Ceil(float64(jsLength(text))*1.6))))
	result, err := s.completion.CompleteText(ctx, publicportal.RssTranslationCompletionRequest{
		OrgID:          options.orgID,
		System:         system,
		User:           user,
		TargetLanguage: options.targetLanguage,
		MaxTokens:      maxTokens,
		Observer:       s.observer,
	})
	if err != nil {
		return "", err
	}
	content := strings.TrimSpace(result.Content)
	if content == "" {
		return "", errors.New("LLM translation response is empty")
	}
	return content, nil
}

// assertProviderAvailable ports assertProviderAvailable: the status list is
// computed for both providers first, so a global settings read or governance
// failure keeps its request-level error instead of being hidden behind the
// provider actually selected.
func (s *Service) assertProviderAvailable(ctx context.Context, provider Provider, targetLanguage string) error {
	if s.settings == nil {
		return &RequestError{Message: "RSS translation service is unavailable", Status: 400}
	}
	statuses, err := s.settings.RssTranslationStatus(ctx, &targetLanguage)
	if err != nil {
		return err
	}
	fallbackMessage := fmt.Sprintf("Translation provider '%s' is currently unavailable.", provider)
	for _, status := range statuses {
		if Provider(status.Provider) != provider {
			continue
		}
		if status.Available {
			return nil
		}
		if status.Message != nil && strings.TrimSpace(*status.Message) != "" {
			return &RequestError{Message: *status.Message, Status: 400}
		}
		return &RequestError{Message: fallbackMessage, Status: 400}
	}
	return &RequestError{Message: fallbackMessage, Status: 400}
}

// resolveLLMConcurrency ports resolveConfiguredLlmTranslationConcurrency: a
// settings read failure falls back to the default instead of failing the
// request, and the value is clamped to 1..20.
func (s *Service) resolveLLMConcurrency(ctx context.Context) int {
	if s.settings == nil {
		return defaultLLMConcurrency
	}
	runtime, err := s.settings.TranslationRuntime(ctx)
	if err != nil {
		log.Printf("api-go: RSS translation failed to load the LLM translation concurrency; using the default")
		return defaultLLMConcurrency
	}
	return normalizeLLMConcurrency(runtime.MaxConcurrency)
}

// normalizeLLMConcurrency ports normalizeConfiguredLlmTranslationConcurrency.
func normalizeLLMConcurrency(value int) int {
	if value < 1 {
		return defaultLLMConcurrency
	}
	if value > maxLLMConcurrency {
		return maxLLMConcurrency
	}
	return value
}

func normalizeTargetLanguage(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return defaultTargetLanguage
	}
	return trimmed
}

// normalizeItemIDs ports normalizeItemIds: trim, drop blanks, keep order,
// deduplicate, then enforce the 50 item limit.
func normalizeItemIDs(itemIDs []string) ([]string, error) {
	normalized := make([]string, 0, len(itemIDs))
	seen := make(map[string]struct{}, len(itemIDs))
	for _, itemID := range itemIDs {
		trimmed := strings.TrimSpace(itemID)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		normalized = append(normalized, trimmed)
	}
	if len(normalized) > maxTranslationItemIDs {
		return nil, &RequestError{
			Message: fmt.Sprintf("RSS translation accepts at most %d itemIds per request.", maxTranslationItemIDs),
			Status:  400,
		}
	}
	return normalized, nil
}

// normalizeFields ports normalizeFields: an omitted, null or empty list uses
// the default title+summary+key_points projection.
func normalizeFields(fields []Field) []Field {
	source := fields
	if len(source) == 0 {
		source = DefaultFieldSet
	}
	out := make([]Field, 0, len(source))
	seen := make(map[Field]struct{}, len(source))
	for _, field := range source {
		if _, exists := seen[field]; exists {
			continue
		}
		seen[field] = struct{}{}
		out = append(out, field)
	}
	return out
}

func containsField(fields []Field, target Field) bool {
	for _, field := range fields {
		if field == target {
			return true
		}
	}
	return false
}

func normalizeOptionalString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func mapTranslated(inputs []string, translated map[string]string) []string {
	out := make([]string, len(inputs))
	for index, text := range inputs {
		if value, ok := translated[text]; ok {
			out[index] = value
			continue
		}
		out[index] = text
	}
	return out
}

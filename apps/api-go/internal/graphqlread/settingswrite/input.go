package settingswrite

import (
	"strconv"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// This file converts the executor's coerced GraphQL argument map into the named
// input structs the business layer consumes. It is the only untyped boundary
// this package touches; every stored document, response model and audit
// metadata value below is a named struct.

// rateLimitBucketInput is a validated RateLimitBucketInput.
type rateLimitBucketInput struct {
	Limit         int
	WindowSeconds int
}

// updateRateLimitSettingsInput is a validated UpdateRateLimitSettingsInput.
type updateRateLimitSettingsInput struct {
	Login       rateLimitBucketInput
	CrawlCreate rateLimitBucketInput
	RbacWrite   rateLimitBucketInput
}

// updateAuthCacheSettingsInput is a validated UpdateAuthCacheSettingsInput.
type updateAuthCacheSettingsInput struct {
	ProfileTTLSeconds int
	LockTTLMs         int
	MaxWaitMs         int
	RetryDelayMs      int
}

// updateCrawlClientSettingsInput is a validated
// UpdateCrawlClientSettingsInput. Optional properties are pointers: an absent
// or null value keeps the stored setting through the shared normalizer.
type updateCrawlClientSettingsInput struct {
	HealthCheckTTLMs                         int
	MaxRetries                               int
	RetryBackoffMs                           int
	QueueOverloadCooldownMs                  int
	RequestTimeoutMs                         *int
	RequestTimeoutHotMs                      *int
	RequestTimeoutNormalMs                   *int
	ConditionalRequestEnabled                *bool
	ConditionalRequestTimeoutMs              *int
	ConditionalRequestMaxRetries             *int
	DetailPublishSignalHeadFetchTimeoutMs    *int
	DetailPublishSignalHeadFetchConcurrency  *int
	DetailPublishSignalHeadFetchMaxReadBytes *int
	AdaptiveConcurrencyEnabled               *bool
	AdaptiveWindowMinutes                    *int
	AdaptiveCooldownMinutes                  *int
	AdaptiveLatencyThresholdRatio            *float64
	AdaptiveErrorRateThreshold               *float64
	AdaptiveMemoryHeadroomThreshold          *float64
}

// updateAuditLogRetentionInput is a validated UpdateAuditLogRetentionInput.
type updateAuditLogRetentionInput struct {
	RetentionDays int
}

// updateEntityImpactGraphSettingsInput is a validated
// UpdateEntityImpactGraphSettingsInput.
type updateEntityImpactGraphSettingsInput struct {
	Enabled             bool
	MinEntityConfidence float64
	MinCorrelation      float64
	MinCoOccurrence     int
	MaxNodes            int
	Categories          []string
	CacheTTLSeconds     int
}

// updateKnowledgeGraphSettingsInput is a validated
// UpdateKnowledgeGraphSettingsInput. The optional properties are merged with the
// stored setting by the resolver semantics (`?? current`).
type updateKnowledgeGraphSettingsInput struct {
	Enabled                                    bool
	IngestionEnabled                           bool
	MaxBatchSize                               int
	MaxRelationsPerArticle                     int
	MinEdgeConfidence                          *float64
	DynamicEdgeConfidenceEnabled               *bool
	DynamicEdgeConfidenceQuantile              *float64
	MultiModelValidationEnabled                *bool
	MultiModelValidationModels                 *[]string
	MultiModelValidationModelCount             *int
	MultiModelValidationMaxRelationsPerArticle *int
	EntityDisambiguationEnabled                *bool
	EntityDisambiguationMaxCandidates          *int
	CacheTTLSeconds                            int
}

// updateNewsEventSettingsInput is a validated UpdateNewsEventSettingsInput.
type updateNewsEventSettingsInput struct {
	Enabled                               bool
	IngestionEnabled                      bool
	TimelineEnabled                       bool
	ClusteringMode                        *string
	BertopicMinItemsPerGroup              *int
	BertopicMaxItemsPerRequest            *int
	BertopicMinTopicSize                  *int
	ForceAuthoritativeMode                *bool
	ForceMinAuthoritativeSources          *int
	MaxBatchSize                          int
	BackfillDays                          int
	LookbackDays                          int
	TimelineMaxEventsPerRun               int
	VectorMinScore                        float64
	CrossLanguagePenalty                  float64
	ClassificationGateEnabled             *bool
	CategoryConflictReject                *bool
	CategorySoftPenalty                   *float64
	MinCategoryConfidenceForGate          *float64
	TimelineLowConfidenceThreshold        *float64
	TimelineHighConfidenceThreshold       *float64
	TimelineDriftKlThreshold              *float64
	TimelineMinBucketItemsForDrift        *int
	TimelineCrossCategoryWarningShare     *float64
	TimelineMaxCategoryDistributionItems  *int
	TimelineMaxPhaseSummaries             *int
	TimelinePresetCustomDistanceThreshold *float64
	CacheTTLSeconds                       int
}

// updateNewsIndicatorSettingsInput is a validated
// UpdateNewsIndicatorSettingsInput.
type updateNewsIndicatorSettingsInput struct {
	Enabled                     bool
	IngestionEnabled            bool
	WindowDays                  int
	MaxLagDays                  int
	MinSampleSize               int
	MinAbsCorrelation           float64
	MaxPValue                   float64
	TopEntities                 int
	TopTopics                   int
	MaxAssociationsPerIndicator int
	IndicatorSlugs              []string
	BacktestTriggerZScore       float64
	BacktestBaselineDays        int
	BacktestHoldoutDays         int
	CacheTTLSeconds             int
}

// taxonomyNodeInput is the resolver-mapped NewsClassificationTaxonomyNodeInput:
// keywords and synonyms are always present (the resolver maps undefined to []).
type taxonomyNodeInput struct {
	Path           string
	DisplayName    string
	Description    string
	LegacyCategory string
	Keywords       []string
	Synonyms       []string
}

// updateNewsClassificationSettingsInput is a validated
// UpdateNewsClassificationSettingsInput.
type updateNewsClassificationSettingsInput struct {
	Enabled         *bool
	StrictFail      *bool
	EnableLlm       *bool
	EnableEmbedding *bool
	EnableRerank    *bool
	LlmModel        *string
	LlmModelPresent bool
	MinConfidence   *float64
	EmbeddingTopK   *int
	RerankTopN      *int
	CacheTTLSeconds *int
	TaxonomyVersion *string
	Taxonomy        []taxonomyNodeInput
	TaxonomyPresent bool
}

// updateClassificationQualitySettingsInput is a validated
// UpdateClassificationQualitySettingsInput.
type updateClassificationQualitySettingsInput struct {
	LowConfidenceThreshold    *float64
	LlmP95LatencyWarnMs       *int
	EmbeddingP95LatencyWarnMs *int
	RerankP95LatencyWarnMs    *int
	GateRejectRateWarn        *float64
	GatePenalizedRateWarn     *float64
	ReportMinPairCount        *int
	ReportMinPairErrorRate    *float64
	CacheTTLSeconds           *int
}

// dedupeScopedThresholdInput is the resolver-mapped
// NewsDedupeScopedThresholdInput: the three selectors are explicit nulls when
// omitted.
type dedupeScopedThresholdInput struct {
	SourceID     *string
	Language     *string
	CategoryPath *string
	Threshold    float64
}

// optionalValue is a resolver-style tri-state property: absent, explicit null,
// or a value. It models the `input.x === undefined ? current.x : input.x`
// merge without an untyped container.
type optionalValue[T any] struct {
	present bool
	value   *T
}

// or returns the fallback for an omitted property and the submitted value
// (possibly null) otherwise.
func (o optionalValue[T]) or(fallback *T) *T {
	if !o.present {
		return fallback
	}
	return o.value
}

// updateNewsDedupeSettingsInput is a validated UpdateNewsDedupeSettingsInput.
// The judge properties distinguish an omitted value (keep the stored setting)
// from an explicit null (reset to the built-in default), exactly like the
// resolver's `=== undefined` checks.
type updateNewsDedupeSettingsInput struct {
	DefaultThreshold             float64
	UseEmbeddings                bool
	ScopedThresholds             []dedupeScopedThresholdInput
	LlmJudgeInstructions         optionalValue[string]
	LlmJudgeModel                optionalValue[string]
	LlmJudgeConcurrency          optionalValue[int]
	LlmJudgeMaxComparisons       optionalValue[int]
	LlmJudgeCandidateChars       optionalValue[int]
	LlmJudgePromptVersion        optionalValue[string]
	LlmJudgeSystemPromptTemplate optionalValue[string]
	LlmJudgeUserPromptTemplate   optionalValue[string]
}

// extractionPreflightGateInput is a validated
// NewsExtractionPreflightGateSettingsInput.
type extractionPreflightGateInput struct {
	Enabled            *bool
	MinWordCount       *int
	MinQualityScore    *float64
	RejectBotChallenge *bool
	RejectListLike     *bool
}

// extractionPostCleanGateInput is a validated
// NewsExtractionPostCleanGateSettingsInput.
type extractionPostCleanGateInput struct {
	Enabled         *bool
	MinQualityScore *float64
	MinCleanedChars *int
	RequireSummary  *bool
}

// extractionCapabilitiesInput is a validated
// NewsExtractionCapabilitiesSettingsInput.
type extractionCapabilitiesInput struct {
	Entities  *bool
	Sentiment *bool
	Kg        *bool
}

// extractionProvidersInput is a validated NewsExtractionProvidersSettingsInput.
type extractionProvidersInput struct {
	Clean     *string
	Entities  *string
	Sentiment *string
	Kg        *string
}

// updateNewsExtractionSettingsInput is a validated
// UpdateNewsExtractionSettingsInput. PipelineMode is nil when the caller omitted
// the argument and points at "legacy" when the caller sent an explicit null,
// mirroring the resolver's enum mapping. Every nested object is nil when the
// caller omitted it.
type updateNewsExtractionSettingsInput struct {
	PipelineMode  *string
	PreflightGate *extractionPreflightGateInput
	PostCleanGate *extractionPostCleanGateInput
	Capabilities  *extractionCapabilitiesInput
	Providers     *extractionProvidersInput
}

// updateNewsPromptConfigInput is a validated UpdateNewsPromptConfigInput.
type updateNewsPromptConfigInput struct {
	Version                       string
	SystemPromptTemplate          string
	UserPromptTemplate            string
	EntitySystemPromptTemplate    string
	EntityUserPromptTemplate      string
	SentimentSystemPromptTemplate string
	SentimentUserPromptTemplate   string
	KgSystemPromptTemplate        string
	KgUserPromptTemplate          string
}

// ---- parsers ----

func parseRateLimitBucket(input map[string]any, name string, messages *[]string) rateLimitBucketInput {
	limit := requiredInt(input, "limit", 1, 1000, messages)
	window := requiredInt(input, "windowSeconds", 5, 86400, messages)
	return rateLimitBucketInput{Limit: limit, WindowSeconds: window}
}

func parseUpdateRateLimitSettingsInput(args map[string]any) (updateRateLimitSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateRateLimitSettingsInput{}, err
	}
	messages := []string{}
	out := updateRateLimitSettingsInput{}
	for _, bucket := range []struct {
		name   string
		target *rateLimitBucketInput
	}{
		{"login", &out.Login},
		{"crawlCreate", &out.CrawlCreate},
		{"rbacWrite", &out.RbacWrite},
	} {
		nested, ok := contract.MapArg(raw, bucket.name)
		if !ok {
			// The GraphQL type is non-null, so this is unreachable through the
			// executor; the message mirrors @ValidateNested failing.
			*messages = append(*messages, bucket.name+" must be an object")
			continue
		}
		*bucket.target = parseRateLimitBucket(nested, bucket.name, &messages)
	}
	if len(messages) > 0 {
		return updateRateLimitSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

func parseUpdateAuthCacheSettingsInput(args map[string]any) (updateAuthCacheSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateAuthCacheSettingsInput{}, err
	}
	messages := []string{}
	out := updateAuthCacheSettingsInput{
		ProfileTTLSeconds: requiredInt(raw, "profileTtlSeconds", 60, 86400, &messages),
		LockTTLMs:         requiredInt(raw, "lockTtlMs", 100, 60000, &messages),
		MaxWaitMs:         requiredInt(raw, "maxWaitMs", 50, 120000, &messages),
		RetryDelayMs:      requiredInt(raw, "retryDelayMs", 10, 1000, &messages),
	}
	if len(messages) > 0 {
		return updateAuthCacheSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

func parseUpdateCrawlClientSettingsInput(args map[string]any) (updateCrawlClientSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateCrawlClientSettingsInput{}, err
	}
	messages := []string{}
	out := updateCrawlClientSettingsInput{
		HealthCheckTTLMs:        requiredInt(raw, "healthCheckTtlMs", 5000, 900000, &messages),
		MaxRetries:              requiredInt(raw, "maxRetries", 1, 10, &messages),
		RetryBackoffMs:          requiredInt(raw, "retryBackoffMs", 500, 600000, &messages),
		QueueOverloadCooldownMs: requiredInt(raw, "queueOverloadCooldownMs", 5000, 600000, &messages),
		RequestTimeoutMs:        optionalInt(raw, "requestTimeoutMs", 5000, 900000, &messages),
		RequestTimeoutHotMs:     optionalInt(raw, "requestTimeoutHotMs", 5000, 900000, &messages),
		RequestTimeoutNormalMs:  optionalInt(raw, "requestTimeoutNormalMs", 5000, 900000, &messages),
		ConditionalRequestEnabled: optionalBool(
			raw, "conditionalRequestEnabled", &messages),
		ConditionalRequestTimeoutMs:  optionalInt(raw, "conditionalRequestTimeoutMs", 500, 60000, &messages),
		ConditionalRequestMaxRetries: optionalInt(raw, "conditionalRequestMaxRetries", 0, 5, &messages),
		DetailPublishSignalHeadFetchTimeoutMs: optionalInt(
			raw, "detailPublishSignalHeadFetchTimeoutMs", 500, 10000, &messages),
		DetailPublishSignalHeadFetchConcurrency: optionalInt(
			raw, "detailPublishSignalHeadFetchConcurrency", 1, 8, &messages),
		DetailPublishSignalHeadFetchMaxReadBytes: optionalInt(
			raw, "detailPublishSignalHeadFetchMaxReadBytes", 1048576, 64000000, &messages),
		AdaptiveConcurrencyEnabled:      optionalBool(raw, "adaptiveConcurrencyEnabled", &messages),
		AdaptiveWindowMinutes:           optionalInt(raw, "adaptiveWindowMinutes", 1, 180, &messages),
		AdaptiveCooldownMinutes:         optionalInt(raw, "adaptiveCooldownMinutes", 1, 60, &messages),
		AdaptiveLatencyThresholdRatio:   optionalFloat(raw, "adaptiveLatencyThresholdRatio", 0.01, 0.99, &messages),
		AdaptiveErrorRateThreshold:      optionalFloat(raw, "adaptiveErrorRateThreshold", 0.01, 0.99, &messages),
		AdaptiveMemoryHeadroomThreshold: optionalFloat(raw, "adaptiveMemoryHeadroomThreshold", 0.01, 0.99, &messages),
	}
	if len(messages) > 0 {
		return updateCrawlClientSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

func parseUpdateAuditLogRetentionInput(args map[string]any) (updateAuditLogRetentionInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateAuditLogRetentionInput{}, err
	}
	messages := []string{}
	out := updateAuditLogRetentionInput{
		RetentionDays: requiredInt(raw, "retentionDays", 1, 3650, &messages),
	}
	if len(messages) > 0 {
		return updateAuditLogRetentionInput{}, newInputFailure(messages)
	}
	return out, nil
}

func parseUpdateEntityImpactGraphSettingsInput(args map[string]any) (updateEntityImpactGraphSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateEntityImpactGraphSettingsInput{}, err
	}
	messages := []string{}
	out := updateEntityImpactGraphSettingsInput{
		Enabled:             requiredBool(raw, "enabled", &messages),
		MinEntityConfidence: requiredFloat(raw, "minEntityConfidence", 0, 1, &messages),
		MinCorrelation:      requiredFloat(raw, "minCorrelation", 0, 1, &messages),
		MinCoOccurrence:     requiredInt(raw, "minCoOccurrence", 1, 100, &messages),
		MaxNodes:            requiredInt(raw, "maxNodes", 10, 500, &messages),
		CacheTTLSeconds:     requiredInt(raw, "cacheTtlSeconds", 0, 3600, &messages),
	}
	out.Categories = entityImpactCategories(raw, &messages)
	if len(messages) > 0 {
		return updateEntityImpactGraphSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// entityImpactCategories validates the categories property: @ArrayMinSize(1),
// @ArrayMaxSize(4) and @IsIn(allowed, { each: true }) are evaluated
// independently and reported in the decorator application order.
func entityImpactCategories(input map[string]any, messages *[]string) []string {
	allowed := []string{"person", "organization", "stock", "commodity"}
	value, state := contract.Lookup(input, "categories")
	items, ok := []any(nil), false
	if state == contract.ArgValue {
		items, ok = value.([]any)
	}
	if !ok {
		*messages = append(*messages,
			eachInListMessage("categories", allowed),
			arrayMaxSizeMessage("categories", 4),
			arrayMinSizeMessage("categories", 1))
		return nil
	}
	out := make([]string, 0, len(items))
	invalid := false
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			invalid = true
			continue
		}
		matched := false
		for _, candidate := range allowed {
			if text == candidate {
				matched = true
				break
			}
		}
		if !matched {
			invalid = true
		}
		out = append(out, text)
	}
	if invalid {
		*messages = append(*messages, eachInListMessage("categories", allowed))
	}
	if len(items) > 4 {
		*messages = append(*messages, arrayMaxSizeMessage("categories", 4))
	}
	if len(items) < 1 {
		*messages = append(*messages, arrayMinSizeMessage("categories", 1))
	}
	return out
}

func parseUpdateKnowledgeGraphSettingsInput(args map[string]any) (updateKnowledgeGraphSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateKnowledgeGraphSettingsInput{}, err
	}
	messages := []string{}
	out := updateKnowledgeGraphSettingsInput{
		Enabled:                requiredBool(raw, "enabled", &messages),
		IngestionEnabled:       requiredBool(raw, "ingestionEnabled", &messages),
		MaxBatchSize:           requiredInt(raw, "maxBatchSize", 1, 500, &messages),
		MaxRelationsPerArticle: requiredInt(raw, "maxRelationsPerArticle", 0, 100, &messages),
		MinEdgeConfidence:      optionalFloat(raw, "minEdgeConfidence", 0, 1, &messages),
		DynamicEdgeConfidenceEnabled: optionalBool(
			raw, "dynamicEdgeConfidenceEnabled", &messages),
		DynamicEdgeConfidenceQuantile:  optionalFloat(raw, "dynamicEdgeConfidenceQuantile", 0, 1, &messages),
		MultiModelValidationEnabled:    optionalBool(raw, "multiModelValidationEnabled", &messages),
		MultiModelValidationModels:     optionalStringList(raw, "multiModelValidationModels", 10, &messages),
		MultiModelValidationModelCount: optionalInt(raw, "multiModelValidationModelCount", 2, 3, &messages),
		MultiModelValidationMaxRelationsPerArticle: optionalInt(
			raw, "multiModelValidationMaxRelationsPerArticle", 0, 20, &messages),
		EntityDisambiguationEnabled: optionalBool(
			raw, "entityDisambiguationEnabled", &messages),
		EntityDisambiguationMaxCandidates: optionalInt(
			raw, "entityDisambiguationMaxCandidates", 2, 20, &messages),
		CacheTTLSeconds: requiredInt(raw, "cacheTtlSeconds", 0, 3600, &messages),
	}
	if len(messages) > 0 {
		return updateKnowledgeGraphSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// optionalStringList validates @IsOptional @ArrayMaxSize(max) @IsString({each})
// and reports whether the property was supplied with a non-null value.
func optionalStringList(input map[string]any, name string, maxItems int, messages *[]string) *[]string {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages, "each value in "+name+" must be a string", arrayMaxSizeMessage(name, maxItems))
		return nil
	}
	out := make([]string, 0, len(items))
	invalid := false
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			invalid = true
			continue
		}
		out = append(out, text)
	}
	if invalid {
		*messages = append(*messages, "each value in "+name+" must be a string")
	}
	if len(items) > maxItems {
		*messages = append(*messages, arrayMaxSizeMessage(name, maxItems))
	}
	return &out
}

func parseUpdateNewsEventSettingsInput(args map[string]any) (updateNewsEventSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsEventSettingsInput{}, err
	}
	messages := []string{}
	out := updateNewsEventSettingsInput{
		Enabled:          requiredBool(raw, "enabled", &messages),
		IngestionEnabled: requiredBool(raw, "ingestionEnabled", &messages),
		TimelineEnabled:  requiredBool(raw, "timelineEnabled", &messages),
		ClusteringMode:   mustOptionalInList(raw, "clusteringMode", []string{"vector", "bertopic_primary"}, &messages),
		MaxBatchSize:     requiredInt(raw, "maxBatchSize", 1, 500, &messages),
		BackfillDays:     requiredInt(raw, "backfillDays", 1, 365, &messages),
		LookbackDays:     requiredInt(raw, "lookbackDays", 1, 180, &messages),
		TimelineMaxEventsPerRun: requiredInt(
			raw, "timelineMaxEventsPerRun", 1, 200, &messages),
		VectorMinScore:       requiredFloat(raw, "vectorMinScore", 0, 1, &messages),
		CrossLanguagePenalty: requiredFloat(raw, "crossLanguagePenalty", 0, 1, &messages),
		CacheTTLSeconds:      requiredInt(raw, "cacheTtlSeconds", 0, 3600, &messages),
		BertopicMinItemsPerGroup: optionalInt(
			raw, "bertopicMinItemsPerGroup", 2, 100, &messages),
		BertopicMaxItemsPerRequest: optionalInt(
			raw, "bertopicMaxItemsPerRequest", 2, 500, &messages),
		BertopicMinTopicSize: optionalInt(
			raw, "bertopicMinTopicSize", 2, 100, &messages),
		ForceAuthoritativeMode: optionalBool(
			raw, "forceAuthoritativeMode", &messages),
		ForceMinAuthoritativeSources: optionalInt(
			raw, "forceMinAuthoritativeSources", 1, 5, &messages),
		ClassificationGateEnabled: optionalBool(
			raw, "classificationGateEnabled", &messages),
		CategoryConflictReject: optionalBool(
			raw, "categoryConflictReject", &messages),
		CategorySoftPenalty: optionalFloat(
			raw, "categorySoftPenalty", 0, 1, &messages),
		MinCategoryConfidenceForGate: optionalFloat(
			raw, "minCategoryConfidenceForGate", 0, 1, &messages),
		TimelineLowConfidenceThreshold: optionalFloat(
			raw, "timelineLowConfidenceThreshold", 0, 1, &messages),
		TimelineHighConfidenceThreshold: optionalFloat(
			raw, "timelineHighConfidenceThreshold", 0, 1, &messages),
		TimelineDriftKlThreshold: optionalFloat(
			raw, "timelineDriftKlThreshold", 0, 5, &messages),
		TimelineMinBucketItemsForDrift: optionalInt(
			raw, "timelineMinBucketItemsForDrift", 1, 50, &messages),
		TimelineCrossCategoryWarningShare: optionalFloat(
			raw, "timelineCrossCategoryWarningShare", 0, 1, &messages),
		TimelineMaxCategoryDistributionItems: optionalInt(
			raw, "timelineMaxCategoryDistributionItems", 4, 64, &messages),
		TimelineMaxPhaseSummaries: optionalInt(
			raw, "timelineMaxPhaseSummaries", 1, 20, &messages),
		TimelinePresetCustomDistanceThreshold: optionalFloat(
			raw, "timelinePresetCustomDistanceThreshold", 0, 7, &messages),
	}
	if len(messages) > 0 {
		return updateNewsEventSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// mustOptionalInList reads @IsOptional @IsEnum and returns the enum member, or
// nil for an absent or null property.
func mustOptionalInList(input map[string]any, name string, allowed []string, messages *[]string) *string {
	value, _ := optionalInList(input, name, allowed, messages)
	return value
}

func parseUpdateNewsIndicatorSettingsInput(args map[string]any) (updateNewsIndicatorSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsIndicatorSettingsInput{}, err
	}
	messages := []string{}
	out := updateNewsIndicatorSettingsInput{
		Enabled:                     requiredBool(raw, "enabled", &messages),
		IngestionEnabled:            requiredBool(raw, "ingestionEnabled", &messages),
		WindowDays:                  requiredInt(raw, "windowDays", 7, 3650, &messages),
		MaxLagDays:                  requiredInt(raw, "maxLagDays", 0, 30, &messages),
		MinSampleSize:               requiredInt(raw, "minSampleSize", 10, 2000, &messages),
		MinAbsCorrelation:           requiredFloat(raw, "minAbsCorrelation", 0, 1, &messages),
		MaxPValue:                   requiredFloat(raw, "maxPValue", 0, 1, &messages),
		TopEntities:                 requiredInt(raw, "topEntities", 0, 500, &messages),
		TopTopics:                   requiredInt(raw, "topTopics", 0, 500, &messages),
		MaxAssociationsPerIndicator: requiredInt(raw, "maxAssociationsPerIndicator", 1, 1000, &messages),
		BacktestTriggerZScore:       requiredFloat(raw, "backtestTriggerZScore", 0, 10, &messages),
		BacktestBaselineDays:        requiredInt(raw, "backtestBaselineDays", 5, 365, &messages),
		BacktestHoldoutDays:         requiredInt(raw, "backtestHoldoutDays", 0, 365, &messages),
		CacheTTLSeconds:             requiredInt(raw, "cacheTtlSeconds", 0, 3600, &messages),
	}
	out.IndicatorSlugs = indicatorSlugs(raw, &messages)
	if len(messages) > 0 {
		return updateNewsIndicatorSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// indicatorSlugs validates @ArrayMaxSize(50) @ArrayMinSize(0)
// @MaxLength(128, { each: true }) and returns the raw entries.
func indicatorSlugs(input map[string]any, messages *[]string) []string {
	value, state := contract.Lookup(input, "indicatorSlugs")
	items, ok := []any(nil), false
	if state == contract.ArgValue {
		items, ok = value.([]any)
	}
	if !ok {
		*messages = append(*messages,
			eachMaxLengthMessage("indicatorSlugs", 128),
			arrayMinSizeMessage("indicatorSlugs", 0),
			arrayMaxSizeMessage("indicatorSlugs", 50))
		return nil
	}
	out := make([]string, 0, len(items))
	invalid := false
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			invalid = true
			continue
		}
		if jsMaxLengthLen(text) > 128 {
			invalid = true
		}
		out = append(out, text)
	}
	if invalid {
		*messages = append(*messages, eachMaxLengthMessage("indicatorSlugs", 128))
	}
	if len(items) > 50 {
		*messages = append(*messages, arrayMaxSizeMessage("indicatorSlugs", 50))
	}
	return out
}

func parseUpdateNewsClassificationSettingsInput(args map[string]any) (updateNewsClassificationSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsClassificationSettingsInput{}, err
	}
	messages := []string{}
	out := updateNewsClassificationSettingsInput{
		Enabled:         optionalBool(raw, "enabled", &messages),
		StrictFail:      optionalBool(raw, "strictFail", &messages),
		EnableLlm:       optionalBool(raw, "enableLlm", &messages),
		EnableEmbedding: optionalBool(raw, "enableEmbedding", &messages),
		EnableRerank:    optionalBool(raw, "enableRerank", &messages),
		MinConfidence:   optionalFloat(raw, "minConfidence", 0, 1, &messages),
		EmbeddingTopK:   optionalInt(raw, "embeddingTopK", 1, 100, &messages),
		RerankTopN:      optionalInt(raw, "rerankTopN", 1, 30, &messages),
		CacheTTLSeconds: optionalInt(raw, "cacheTtlSeconds", 0, 3600, &messages),
	}
	out.LlmModel, out.LlmModelPresent = optionalStringMax(raw, "llmModel", 120, &messages)
	out.TaxonomyVersion, _ = optionalStringMax(raw, "taxonomyVersion", 64, &messages)
	out.Taxonomy, out.TaxonomyPresent = classificationTaxonomy(raw, &messages)
	if len(messages) > 0 {
		return updateNewsClassificationSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// classificationTaxonomy validates @IsOptional @ValidateNested({ each: true })
// @ArrayMinSize(1) @ArrayMaxSize(512) and applies the resolver's node mapping
// (keywords and synonyms become [] when omitted).
func classificationTaxonomy(input map[string]any, messages *[]string) ([]taxonomyNodeInput, bool) {
	value, state := contract.Lookup(input, "taxonomy")
	if state != contract.ArgValue {
		return nil, false
	}
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	legacyCategories := settingscrawl.AllowedLegacyCategories()
	out := make([]taxonomyNodeInput, 0, len(items))
	for index := range items {
		record, ok := listAt(items, index)
		if !ok {
			continue
		}
		prefix := "taxonomy." + strconv.Itoa(index) + "."
		node := taxonomyNodeInput{}
		node.Path = nestedStringMax(record, "path", prefix, 160, messages)
		node.DisplayName = nestedStringMax(record, "displayName", prefix, 200, messages)
		node.Description = nestedStringMax(record, "description", prefix, 500, messages)
		node.LegacyCategory = nestedInList(record, "legacyCategory", prefix, legacyCategories, messages)
		node.Keywords = nestedStringList(record, "keywords", prefix, 50, 80, messages)
		node.Synonyms = nestedStringList(record, "synonyms", prefix, 50, 80, messages)
		out = append(out, node)
	}
	if len(items) < 1 {
		*messages = append(*messages, arrayMinSizeMessage("taxonomy", 1))
	}
	if len(items) > 512 {
		*messages = append(*messages, arrayMaxSizeMessage("taxonomy", 512))
	}
	return out, true
}

// nestedStringMax validates a nested String! property with @MaxLength(max); the
// message keeps the flattened ValidationPipe property path.
func nestedStringMax(record map[string]any, name, prefix string, max int, messages *[]string) string {
	value, state := contract.Lookup(record, name)
	text, ok := "", false
	if state == contract.ArgValue {
		text, ok = value.(string)
	}
	if !ok {
		*messages = append(*messages, maxLengthMessage(prefix+name, max), prefix+name+" must be a string")
		return ""
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(prefix+name, max))
	}
	return text
}

// nestedOptionalStringMax validates a nested String property with @IsOptional /
// @IsString / @MaxLength(max) and reports an explicit null as absent.
func nestedOptionalStringMax(record map[string]any, name, prefix string, max int, messages *[]string) *string {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, maxLengthMessage(prefix+name, max), prefix+name+" must be a string")
		return nil
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxLengthMessage(prefix+name, max))
		return nil
	}
	return &text
}

// nestedInList validates a nested String! property with @IsIn.
func nestedInList(record map[string]any, name, prefix string, allowed []string, messages *[]string) string {
	value, state := contract.Lookup(record, name)
	text, ok := "", false
	if state == contract.ArgValue {
		text, ok = value.(string)
	}
	if ok {
		for _, candidate := range allowed {
			if text == candidate {
				return text
			}
		}
	}
	*messages = append(*messages, inListMessage(prefix+name, allowed))
	return ""
}

// nestedStringList validates a nested [String!] property with @IsOptional /
// @ArrayMinSize(0) / @ArrayMaxSize(maxItems) / @IsString({ each }) /
// @MaxLength(maxLength, { each }) and returns the resolver-mapped entries.
func nestedStringList(record map[string]any, name, prefix string, maxItems, maxLength int, messages *[]string) []string {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return []string{}
	}
	items, ok := value.([]any)
	if !ok {
		*messages = append(*messages,
			eachMaxLengthMessage(prefix+name, maxLength),
			"each value in "+prefix+name+" must be a string",
			arrayMaxSizeMessage(prefix+name, maxItems),
			arrayMinSizeMessage(prefix+name, 0))
		return []string{}
	}
	out := make([]string, 0, len(items))
	lengthInvalid := false
	typeInvalid := false
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			typeInvalid = true
			continue
		}
		if jsMaxLengthLen(text) > maxLength {
			lengthInvalid = true
		}
		out = append(out, text)
	}
	if lengthInvalid {
		*messages = append(*messages, eachMaxLengthMessage(prefix+name, maxLength))
	}
	if typeInvalid {
		*messages = append(*messages, "each value in "+prefix+name+" must be a string")
	}
	if len(items) > maxItems {
		*messages = append(*messages, arrayMaxSizeMessage(prefix+name, maxItems))
	}
	return out
}

// optionalStringSlice is the resolver's `entry.keywords ?? []`.
func optionalStringSlice(record map[string]any, name string) []string {
	value, state := contract.Lookup(record, name)
	if state != contract.ArgValue {
		return []string{}
	}
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func parseUpdateClassificationQualitySettingsInput(args map[string]any) (updateClassificationQualitySettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateClassificationQualitySettingsInput{}, err
	}
	messages := []string{}
	out := updateClassificationQualitySettingsInput{
		LowConfidenceThreshold:    optionalFloat(raw, "lowConfidenceThreshold", 0, 1, &messages),
		LlmP95LatencyWarnMs:       optionalInt(raw, "llmP95LatencyWarnMs", 100, 120000, &messages),
		EmbeddingP95LatencyWarnMs: optionalInt(raw, "embeddingP95LatencyWarnMs", 100, 120000, &messages),
		RerankP95LatencyWarnMs:    optionalInt(raw, "rerankP95LatencyWarnMs", 100, 120000, &messages),
		GateRejectRateWarn:        optionalFloat(raw, "gateRejectRateWarn", 0, 1, &messages),
		GatePenalizedRateWarn:     optionalFloat(raw, "gatePenalizedRateWarn", 0, 1, &messages),
		ReportMinPairCount:        optionalInt(raw, "reportMinPairCount", 1, 1000, &messages),
		ReportMinPairErrorRate:    optionalFloat(raw, "reportMinPairErrorRate", 0, 1, &messages),
		CacheTTLSeconds:           optionalInt(raw, "cacheTtlSeconds", 0, 3600, &messages),
	}
	if len(messages) > 0 {
		return updateClassificationQualitySettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

func parseUpdateNewsDedupeSettingsInput(args map[string]any) (updateNewsDedupeSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsDedupeSettingsInput{}, err
	}
	messages := []string{}
	out := updateNewsDedupeSettingsInput{
		DefaultThreshold:             requiredFloat(raw, "defaultThreshold", 0, 1, &messages),
		UseEmbeddings:                requiredBool(raw, "useEmbeddings", &messages),
		LlmJudgeInstructions:         optionalStringValue(raw, "llmJudgeInstructions", 2000, &messages),
		LlmJudgeModel:                optionalStringValue(raw, "llmJudgeModel", 120, &messages),
		LlmJudgeConcurrency:          optionalIntValue(raw, "llmJudgeConcurrency", 1, 8, &messages),
		LlmJudgeMaxComparisons:       optionalIntValue(raw, "llmJudgeMaxComparisons", 1, 30, &messages),
		LlmJudgeCandidateChars:       optionalIntValue(raw, "llmJudgeCandidateChars", 200, 5000, &messages),
		LlmJudgePromptVersion:        optionalStringValue(raw, "llmJudgePromptVersion", 80, &messages),
		LlmJudgeSystemPromptTemplate: optionalStringValue(raw, "llmJudgeSystemPromptTemplate", 12000, &messages),
		LlmJudgeUserPromptTemplate:   optionalStringValue(raw, "llmJudgeUserPromptTemplate", 12000, &messages),
	}
	out.ScopedThresholds = dedupeScopedThresholds(raw, &messages)
	if len(messages) > 0 {
		return updateNewsDedupeSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// optionalStringValue reads an optional tri-state string property.
func optionalStringValue(input map[string]any, name string, max int, messages *[]string) optionalValue[string] {
	value, present := optionalStringMax(input, name, max, messages)
	return optionalValue[string]{present: present, value: value}
}

// optionalIntValue reads an optional tri-state integer property.
func optionalIntValue(input map[string]any, name string, min, max int, messages *[]string) optionalValue[int] {
	_, present := contract.Lookup(input, name)
	return optionalValue[int]{present: present, value: optionalInt(input, name, min, max, messages)}
}

// dedupeScopedThresholds validates @ArrayMaxSize(100) @ValidateNested({ each })
// and applies the resolver's `entry.x ?? null` mapping.
func dedupeScopedThresholds(input map[string]any, messages *[]string) []dedupeScopedThresholdInput {
	value, state := contract.Lookup(input, "scopedThresholds")
	items, ok := []any(nil), false
	if state == contract.ArgValue {
		items, ok = value.([]any)
	}
	if !ok {
		*messages = append(*messages, arrayMaxSizeMessage("scopedThresholds", 100))
		return nil
	}
	out := make([]dedupeScopedThresholdInput, 0, len(items))
	for index := range items {
		record, ok := listAt(items, index)
		if !ok {
			continue
		}
		prefix := "scopedThresholds." + strconv.Itoa(index) + "."
		entry := dedupeScopedThresholdInput{
			SourceID:     nestedOptionalStringMax(record, "sourceId", prefix, 191, messages),
			Language:     nestedOptionalStringMax(record, "language", prefix, 32, messages),
			CategoryPath: nestedOptionalStringMax(record, "categoryPath", prefix, 240, messages),
		}
		entry.Threshold = requiredFloat(record, "threshold", 0, 1, messages)
		out = append(out, entry)
	}
	if len(items) > 100 {
		*messages = append(*messages, arrayMaxSizeMessage("scopedThresholds", 100))
	}
	return out
}

func parseUpdateNewsExtractionSettingsInput(args map[string]any) (updateNewsExtractionSettingsInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsExtractionSettingsInput{}, err
	}
	messages := []string{}
	out := updateNewsExtractionSettingsInput{}
	out.PipelineMode = extractionPipelineMode(raw, &messages)
	if nested, ok := contract.MapArg(raw, "preflightGate"); ok {
		out.PreflightGate = &extractionPreflightGateInput{
			Enabled:            optionalBool(nested, "enabled", &messages),
			MinWordCount:       optionalInt(nested, "minWordCount", 0, 10000, &messages),
			MinQualityScore:    optionalFloat(nested, "minQualityScore", 0, 1, &messages),
			RejectBotChallenge: optionalBool(nested, "rejectBotChallenge", &messages),
			RejectListLike:     optionalBool(nested, "rejectListLike", &messages),
		}
	}
	if nested, ok := contract.MapArg(raw, "postCleanGate"); ok {
		out.PostCleanGate = &extractionPostCleanGateInput{
			Enabled:         optionalBool(nested, "enabled", &messages),
			MinQualityScore: optionalFloat(nested, "minQualityScore", 0, 1, &messages),
			MinCleanedChars: optionalInt(nested, "minCleanedChars", 0, 100000, &messages),
			RequireSummary:  optionalBool(nested, "requireSummary", &messages),
		}
	}
	if nested, ok := contract.MapArg(raw, "capabilities"); ok {
		out.Capabilities = &extractionCapabilitiesInput{
			Entities:  optionalBool(nested, "entities", &messages),
			Sentiment: optionalBool(nested, "sentiment", &messages),
			Kg:        optionalBool(nested, "kg", &messages),
		}
	}
	if nested, ok := contract.MapArg(raw, "providers"); ok {
		out.Providers = &extractionProvidersInput{
			Clean:     extractionProvider(nested, "clean", &messages),
			Entities:  extractionProvider(nested, "entities", &messages),
			Sentiment: extractionProvider(nested, "sentiment", &messages),
			Kg:        extractionProvider(nested, "kg", &messages),
		}
	}
	if len(messages) > 0 {
		return updateNewsExtractionSettingsInput{}, newInputFailure(messages)
	}
	return out, nil
}

// extractionPipelineMode mirrors the resolver's enum mapping: an omitted
// argument stays undefined, while any present value other than "staged" maps to
// "legacy" (including an explicit null).
func extractionPipelineMode(input map[string]any, messages *[]string) *string {
	value, state := contract.Lookup(input, "pipelineMode")
	if state != contract.ArgValue {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		*messages = append(*messages, inListMessage("pipelineMode", []string{"legacy", "staged"}))
		return nil
	}
	if text == "staged" {
		staged := "staged"
		return &staged
	}
	legacy := "legacy"
	return &legacy
}

// extractionProvider mirrors the resolver's provider mapping: an explicit null
// maps to undefined, so it behaves exactly like an omitted value.
func extractionProvider(input map[string]any, name string, messages *[]string) *string {
	value, _ := optionalInList(input, name, []string{"llm"}, messages)
	return value
}

func parseUpdateNewsPromptConfigInput(args map[string]any) (updateNewsPromptConfigInput, error) {
	raw, err := inputObject(args)
	if err != nil {
		return updateNewsPromptConfigInput{}, err
	}
	messages := []string{}
	out := updateNewsPromptConfigInput{
		Version:                       requiredStringMax(raw, "version", 120, &messages),
		SystemPromptTemplate:          requiredStringMax(raw, "systemPromptTemplate", 6000, &messages),
		UserPromptTemplate:            requiredStringMax(raw, "userPromptTemplate", 12000, &messages),
		EntitySystemPromptTemplate:    requiredStringMax(raw, "entitySystemPromptTemplate", 6000, &messages),
		EntityUserPromptTemplate:      requiredStringMax(raw, "entityUserPromptTemplate", 12000, &messages),
		SentimentSystemPromptTemplate: requiredStringMax(raw, "sentimentSystemPromptTemplate", 4000, &messages),
		SentimentUserPromptTemplate:   requiredStringMax(raw, "sentimentUserPromptTemplate", 8000, &messages),
		KgSystemPromptTemplate:        requiredStringMax(raw, "kgSystemPromptTemplate", 6000, &messages),
		KgUserPromptTemplate:          requiredStringMax(raw, "kgUserPromptTemplate", 12000, &messages),
	}
	if len(messages) > 0 {
		return updateNewsPromptConfigInput{}, newInputFailure(messages)
	}
	return out, nil
}

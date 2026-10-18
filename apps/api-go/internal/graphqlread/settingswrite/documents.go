package settingswrite

import (
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// This file holds the JSON documents this package persists, caches and feeds to
// the shared normalizers. Every one is a named struct with explicit json tags;
// the GraphQL models carry graphql tags only, so they are never marshalled
// straight into MySQL or Redis.

// ---- rate limit ----

// rateLimitBucketDocument is one stored rate_limit_* value.
type rateLimitBucketDocument struct {
	Limit         int `json:"limit"`
	WindowSeconds int `json:"windowSeconds"`
}

// rateLimitSettingsDocument is the stored/cached rate_limit:settings document.
type rateLimitSettingsDocument struct {
	Login       rateLimitBucketDocument `json:"login"`
	CrawlCreate rateLimitBucketDocument `json:"crawlCreate"`
	RbacWrite   rateLimitBucketDocument `json:"rbacWrite"`
}

func rateLimitBucketDocumentOf(bucket settingscrawl.RateLimitBucketModel) rateLimitBucketDocument {
	return rateLimitBucketDocument{Limit: bucket.Limit, WindowSeconds: bucket.WindowSeconds}
}

func newRateLimitSettingsDocument(model settingscrawl.RateLimitSettingsModel) rateLimitSettingsDocument {
	return rateLimitSettingsDocument{
		Login:       rateLimitBucketDocumentOf(model.Login),
		CrawlCreate: rateLimitBucketDocumentOf(model.CrawlCreate),
		RbacWrite:   rateLimitBucketDocumentOf(model.RbacWrite),
	}
}

// rateLimitBucketCandidate is one submitted bucket fed to the shared normalizer.
type rateLimitBucketCandidate struct {
	Limit         int `json:"limit"`
	WindowSeconds int `json:"windowSeconds"`
}

// ---- auth cache ----

// authCacheSettingsDocument is the stored/cached auth_profile_cache_settings
// value.
type authCacheSettingsDocument struct {
	ProfileTTLSeconds int `json:"profileTtlSeconds"`
	LockTTLMs         int `json:"lockTtlMs"`
	MaxWaitMs         int `json:"maxWaitMs"`
	RetryDelayMs      int `json:"retryDelayMs"`
}

func newAuthCacheSettingsDocument(model settingscrawl.AuthCacheSettingsModel) authCacheSettingsDocument {
	return authCacheSettingsDocument{
		ProfileTTLSeconds: model.ProfileTTLSeconds,
		LockTTLMs:         model.LockTTLMs,
		MaxWaitMs:         model.MaxWaitMs,
		RetryDelayMs:      model.RetryDelayMs,
	}
}

// authCacheCandidate is the submitted document fed to the shared normalizer.
type authCacheCandidate = authCacheSettingsDocument

// ---- crawl client ----

// crawlClientDocument is the stored/cached crawl_client_settings value: the
// nineteen GraphQL fields plus maxConcurrency.
type crawlClientDocument struct {
	HealthCheckTtlMs                         int     `json:"healthCheckTtlMs"`
	RequestTimeoutMs                         int     `json:"requestTimeoutMs"`
	RequestTimeoutHotMs                      int     `json:"requestTimeoutHotMs"`
	RequestTimeoutNormalMs                   int     `json:"requestTimeoutNormalMs"`
	ConditionalRequestEnabled                bool    `json:"conditionalRequestEnabled"`
	ConditionalRequestTimeoutMs              int     `json:"conditionalRequestTimeoutMs"`
	ConditionalRequestMaxRetries             int     `json:"conditionalRequestMaxRetries"`
	DetailPublishSignalHeadFetchTimeoutMs    int     `json:"detailPublishSignalHeadFetchTimeoutMs"`
	DetailPublishSignalHeadFetchConcurrency  int     `json:"detailPublishSignalHeadFetchConcurrency"`
	DetailPublishSignalHeadFetchMaxReadBytes int     `json:"detailPublishSignalHeadFetchMaxReadBytes"`
	MaxRetries                               int     `json:"maxRetries"`
	RetryBackoffMs                           int     `json:"retryBackoffMs"`
	QueueOverloadCooldownMs                  int     `json:"queueOverloadCooldownMs"`
	AdaptiveConcurrencyEnabled               bool    `json:"adaptiveConcurrencyEnabled"`
	AdaptiveWindowMinutes                    int     `json:"adaptiveWindowMinutes"`
	AdaptiveCooldownMinutes                  int     `json:"adaptiveCooldownMinutes"`
	AdaptiveLatencyThresholdRatio            float64 `json:"adaptiveLatencyThresholdRatio"`
	AdaptiveErrorRateThreshold               float64 `json:"adaptiveErrorRateThreshold"`
	AdaptiveMemoryHeadroomThreshold          float64 `json:"adaptiveMemoryHeadroomThreshold"`
	MaxConcurrency                           int     `json:"maxConcurrency"`
}

func newCrawlClientDocument(normalized settingscrawl.CrawlClientNormalized) crawlClientDocument {
	settings := normalized.Settings
	return crawlClientDocument{
		HealthCheckTtlMs:                         settings.HealthCheckTTLMs,
		RequestTimeoutMs:                         settings.RequestTimeoutMs,
		RequestTimeoutHotMs:                      settings.RequestTimeoutHotMs,
		RequestTimeoutNormalMs:                   settings.RequestTimeoutNormalMs,
		ConditionalRequestEnabled:                settings.ConditionalRequestEnabled,
		ConditionalRequestTimeoutMs:              settings.ConditionalRequestTimeoutMs,
		ConditionalRequestMaxRetries:             settings.ConditionalRequestMaxRetries,
		DetailPublishSignalHeadFetchTimeoutMs:    settings.DetailPublishSignalHeadFetchTimeoutMs,
		DetailPublishSignalHeadFetchConcurrency:  settings.DetailPublishSignalHeadFetchConcurrency,
		DetailPublishSignalHeadFetchMaxReadBytes: settings.DetailPublishSignalHeadFetchMaxReadBytes,
		MaxRetries:                               settings.MaxRetries,
		RetryBackoffMs:                           settings.RetryBackoffMs,
		QueueOverloadCooldownMs:                  settings.QueueOverloadCooldownMs,
		AdaptiveConcurrencyEnabled:               settings.AdaptiveConcurrencyEnabled,
		AdaptiveWindowMinutes:                    settings.AdaptiveWindowMinutes,
		AdaptiveCooldownMinutes:                  settings.AdaptiveCooldownMinutes,
		AdaptiveLatencyThresholdRatio:            settings.AdaptiveLatencyThresholdRatio,
		AdaptiveErrorRateThreshold:               settings.AdaptiveErrorRateThreshold,
		AdaptiveMemoryHeadroomThreshold:          settings.AdaptiveMemoryHeadroomThreshold,
		MaxConcurrency:                           normalized.MaxConcurrency,
	}
}

// crawlClientCandidate is the submitted document fed to the shared normalizer.
// Only the four required fields are always emitted; every optional property is
// omitted when the caller did not supply it, so the normalizer keeps the stored
// value.
type crawlClientCandidate struct {
	HealthCheckTtlMs                         int      `json:"healthCheckTtlMs"`
	MaxRetries                               int      `json:"maxRetries"`
	RetryBackoffMs                           int      `json:"retryBackoffMs"`
	QueueOverloadCooldownMs                  int      `json:"queueOverloadCooldownMs"`
	RequestTimeoutMs                         *int     `json:"requestTimeoutMs,omitempty"`
	RequestTimeoutHotMs                      *int     `json:"requestTimeoutHotMs,omitempty"`
	RequestTimeoutNormalMs                   *int     `json:"requestTimeoutNormalMs,omitempty"`
	ConditionalRequestEnabled                *bool    `json:"conditionalRequestEnabled,omitempty"`
	ConditionalRequestTimeoutMs              *int     `json:"conditionalRequestTimeoutMs,omitempty"`
	ConditionalRequestMaxRetries             *int     `json:"conditionalRequestMaxRetries,omitempty"`
	DetailPublishSignalHeadFetchTimeoutMs    *int     `json:"detailPublishSignalHeadFetchTimeoutMs,omitempty"`
	DetailPublishSignalHeadFetchConcurrency  *int     `json:"detailPublishSignalHeadFetchConcurrency,omitempty"`
	DetailPublishSignalHeadFetchMaxReadBytes *int     `json:"detailPublishSignalHeadFetchMaxReadBytes,omitempty"`
	AdaptiveConcurrencyEnabled               *bool    `json:"adaptiveConcurrencyEnabled,omitempty"`
	AdaptiveWindowMinutes                    *int     `json:"adaptiveWindowMinutes,omitempty"`
	AdaptiveCooldownMinutes                  *int     `json:"adaptiveCooldownMinutes,omitempty"`
	AdaptiveLatencyThresholdRatio            *float64 `json:"adaptiveLatencyThresholdRatio,omitempty"`
	AdaptiveErrorRateThreshold               *float64 `json:"adaptiveErrorRateThreshold,omitempty"`
	AdaptiveMemoryHeadroomThreshold          *float64 `json:"adaptiveMemoryHeadroomThreshold,omitempty"`
}

// ---- entity impact graph ----

// entityImpactGraphSettingsDocument is the stored/cached
// entity_impact_graph_settings:<orgId> value.
type entityImpactGraphSettingsDocument struct {
	Enabled             bool     `json:"enabled"`
	MinEntityConfidence float64  `json:"minEntityConfidence"`
	MinCorrelation      float64  `json:"minCorrelation"`
	MinCoOccurrence     int      `json:"minCoOccurrence"`
	MaxNodes            int      `json:"maxNodes"`
	Categories          []string `json:"categories"`
	CacheTTLSeconds     int      `json:"cacheTtlSeconds"`
}

func newEntityImpactGraphSettingsDocument(model settingscrawl.EntityImpactGraphSettingsModel) entityImpactGraphSettingsDocument {
	return entityImpactGraphSettingsDocument{
		Enabled:             model.Enabled,
		MinEntityConfidence: model.MinEntityConfidence,
		MinCorrelation:      model.MinCorrelation,
		MinCoOccurrence:     model.MinCoOccurrence,
		MaxNodes:            model.MaxNodes,
		Categories:          model.Categories,
		CacheTTLSeconds:     model.CacheTTLSeconds,
	}
}

// entityImpactGraphCandidate is the submitted document fed to the shared
// normalizer; every field is required.
type entityImpactGraphCandidate = entityImpactGraphSettingsDocument

// ---- knowledge graph ----

// knowledgeGraphSettingsDocument is the stored/cached
// knowledge_graph_settings:<orgId> value.
type knowledgeGraphSettingsDocument struct {
	Enabled                                    bool     `json:"enabled"`
	IngestionEnabled                           bool     `json:"ingestionEnabled"`
	MaxBatchSize                               int      `json:"maxBatchSize"`
	MaxRelationsPerArticle                     int      `json:"maxRelationsPerArticle"`
	MinEdgeConfidence                          float64  `json:"minEdgeConfidence"`
	DynamicEdgeConfidenceEnabled               bool     `json:"dynamicEdgeConfidenceEnabled"`
	DynamicEdgeConfidenceQuantile              float64  `json:"dynamicEdgeConfidenceQuantile"`
	MultiModelValidationEnabled                bool     `json:"multiModelValidationEnabled"`
	MultiModelValidationModels                 []string `json:"multiModelValidationModels"`
	MultiModelValidationModelCount             int      `json:"multiModelValidationModelCount"`
	MultiModelValidationMaxRelationsPerArticle int      `json:"multiModelValidationMaxRelationsPerArticle"`
	EntityDisambiguationEnabled                bool     `json:"entityDisambiguationEnabled"`
	EntityDisambiguationMaxCandidates          int      `json:"entityDisambiguationMaxCandidates"`
	CacheTTLSeconds                            int      `json:"cacheTtlSeconds"`
}

func newKnowledgeGraphSettingsDocument(model settingscrawl.KnowledgeGraphSettingsModel) knowledgeGraphSettingsDocument {
	return knowledgeGraphSettingsDocument{
		Enabled:                                    model.Enabled,
		IngestionEnabled:                           model.IngestionEnabled,
		MaxBatchSize:                               model.MaxBatchSize,
		MaxRelationsPerArticle:                     model.MaxRelationsPerArticle,
		MinEdgeConfidence:                          model.MinEdgeConfidence,
		DynamicEdgeConfidenceEnabled:               model.DynamicEdgeConfidenceEnabled,
		DynamicEdgeConfidenceQuantile:              model.DynamicEdgeConfidenceQuantile,
		MultiModelValidationEnabled:                model.MultiModelValidationEnabled,
		MultiModelValidationModels:                 model.MultiModelValidationModels,
		MultiModelValidationModelCount:             model.MultiModelValidationModelCount,
		MultiModelValidationMaxRelationsPerArticle: model.MultiModelValidationMaxRelationsPerArticle,
		EntityDisambiguationEnabled:                model.EntityDisambiguationEnabled,
		EntityDisambiguationMaxCandidates:          model.EntityDisambiguationMaxCandidates,
		CacheTTLSeconds:                            model.CacheTTLSeconds,
	}
}

// knowledgeGraphCandidate is the resolved document fed to the shared
// normalizer; the resolver merges every optional input with the stored setting,
// so all fields are present.
type knowledgeGraphCandidate = knowledgeGraphSettingsDocument

// ---- news events ----

// newsEventSettingsDocument is the stored/cached news_event_settings:<orgId>
// value.
type newsEventSettingsDocument struct {
	Enabled                               bool    `json:"enabled"`
	IngestionEnabled                      bool    `json:"ingestionEnabled"`
	TimelineEnabled                       bool    `json:"timelineEnabled"`
	ClusteringMode                        string  `json:"clusteringMode"`
	BertopicMinItemsPerGroup              int     `json:"bertopicMinItemsPerGroup"`
	BertopicMaxItemsPerRequest            int     `json:"bertopicMaxItemsPerRequest"`
	BertopicMinTopicSize                  int     `json:"bertopicMinTopicSize"`
	ForceAuthoritativeMode                bool    `json:"forceAuthoritativeMode"`
	ForceMinAuthoritativeSources          int     `json:"forceMinAuthoritativeSources"`
	MaxBatchSize                          int     `json:"maxBatchSize"`
	BackfillDays                          int     `json:"backfillDays"`
	LookbackDays                          int     `json:"lookbackDays"`
	TimelineMaxEventsPerRun               int     `json:"timelineMaxEventsPerRun"`
	VectorMinScore                        float64 `json:"vectorMinScore"`
	CrossLanguagePenalty                  float64 `json:"crossLanguagePenalty"`
	ClassificationGateEnabled             bool    `json:"classificationGateEnabled"`
	CategoryConflictReject                bool    `json:"categoryConflictReject"`
	CategorySoftPenalty                   float64 `json:"categorySoftPenalty"`
	MinCategoryConfidenceForGate          float64 `json:"minCategoryConfidenceForGate"`
	TimelineLowConfidenceThreshold        float64 `json:"timelineLowConfidenceThreshold"`
	TimelineHighConfidenceThreshold       float64 `json:"timelineHighConfidenceThreshold"`
	TimelineDriftKlThreshold              float64 `json:"timelineDriftKlThreshold"`
	TimelineMinBucketItemsForDrift        int     `json:"timelineMinBucketItemsForDrift"`
	TimelineCrossCategoryWarningShare     float64 `json:"timelineCrossCategoryWarningShare"`
	TimelineMaxCategoryDistributionItems  int     `json:"timelineMaxCategoryDistributionItems"`
	TimelineMaxPhaseSummaries             int     `json:"timelineMaxPhaseSummaries"`
	TimelinePresetCustomDistanceThreshold float64 `json:"timelinePresetCustomDistanceThreshold"`
	CacheTTLSeconds                       int     `json:"cacheTtlSeconds"`
}

func newNewsEventSettingsDocument(model settingscrawl.NewsEventSettingsModel) newsEventSettingsDocument {
	return newsEventSettingsDocument{
		Enabled:                               model.Enabled,
		IngestionEnabled:                      model.IngestionEnabled,
		TimelineEnabled:                       model.TimelineEnabled,
		ClusteringMode:                        string(model.ClusteringMode),
		BertopicMinItemsPerGroup:              model.BertopicMinItemsPerGroup,
		BertopicMaxItemsPerRequest:            model.BertopicMaxItemsPerRequest,
		BertopicMinTopicSize:                  model.BertopicMinTopicSize,
		ForceAuthoritativeMode:                model.ForceAuthoritativeMode,
		ForceMinAuthoritativeSources:          model.ForceMinAuthoritativeSources,
		MaxBatchSize:                          model.MaxBatchSize,
		BackfillDays:                          model.BackfillDays,
		LookbackDays:                          model.LookbackDays,
		TimelineMaxEventsPerRun:               model.TimelineMaxEventsPerRun,
		VectorMinScore:                        model.VectorMinScore,
		CrossLanguagePenalty:                  model.CrossLanguagePenalty,
		ClassificationGateEnabled:             model.ClassificationGateEnabled,
		CategoryConflictReject:                model.CategoryConflictReject,
		CategorySoftPenalty:                   model.CategorySoftPenalty,
		MinCategoryConfidenceForGate:          model.MinCategoryConfidenceForGate,
		TimelineLowConfidenceThreshold:        model.TimelineLowConfidenceThreshold,
		TimelineHighConfidenceThreshold:       model.TimelineHighConfidenceThreshold,
		TimelineDriftKlThreshold:              model.TimelineDriftKlThreshold,
		TimelineMinBucketItemsForDrift:        model.TimelineMinBucketItemsForDrift,
		TimelineCrossCategoryWarningShare:     model.TimelineCrossCategoryWarningShare,
		TimelineMaxCategoryDistributionItems:  model.TimelineMaxCategoryDistributionItems,
		TimelineMaxPhaseSummaries:             model.TimelineMaxPhaseSummaries,
		TimelinePresetCustomDistanceThreshold: model.TimelinePresetCustomDistanceThreshold,
		CacheTTLSeconds:                       model.CacheTTLSeconds,
	}
}

// newsEventCandidate is the resolved document fed to the shared normalizer.
type newsEventCandidate = newsEventSettingsDocument

// ---- news indicator ----

// newsIndicatorSettingsDocument is the stored/cached
// news_indicator_association_settings:<orgId> value.
type newsIndicatorSettingsDocument struct {
	Enabled                     bool     `json:"enabled"`
	IngestionEnabled            bool     `json:"ingestionEnabled"`
	WindowDays                  int      `json:"windowDays"`
	MaxLagDays                  int      `json:"maxLagDays"`
	MinSampleSize               int      `json:"minSampleSize"`
	MinAbsCorrelation           float64  `json:"minAbsCorrelation"`
	MaxPValue                   float64  `json:"maxPValue"`
	TopEntities                 int      `json:"topEntities"`
	TopTopics                   int      `json:"topTopics"`
	MaxAssociationsPerIndicator int      `json:"maxAssociationsPerIndicator"`
	IndicatorSlugs              []string `json:"indicatorSlugs"`
	BacktestTriggerZScore       float64  `json:"backtestTriggerZScore"`
	BacktestBaselineDays        int      `json:"backtestBaselineDays"`
	BacktestHoldoutDays         int      `json:"backtestHoldoutDays"`
	CacheTTLSeconds             int      `json:"cacheTtlSeconds"`
}

func newNewsIndicatorSettingsDocument(model settingscrawl.NewsIndicatorSettingsModel) newsIndicatorSettingsDocument {
	return newsIndicatorSettingsDocument{
		Enabled:                     model.Enabled,
		IngestionEnabled:            model.IngestionEnabled,
		WindowDays:                  model.WindowDays,
		MaxLagDays:                  model.MaxLagDays,
		MinSampleSize:               model.MinSampleSize,
		MinAbsCorrelation:           model.MinAbsCorrelation,
		MaxPValue:                   model.MaxPValue,
		TopEntities:                 model.TopEntities,
		TopTopics:                   model.TopTopics,
		MaxAssociationsPerIndicator: model.MaxAssociationsPerIndicator,
		IndicatorSlugs:              model.IndicatorSlugs,
		BacktestTriggerZScore:       model.BacktestTriggerZScore,
		BacktestBaselineDays:        model.BacktestBaselineDays,
		BacktestHoldoutDays:         model.BacktestHoldoutDays,
		CacheTTLSeconds:             model.CacheTTLSeconds,
	}
}

// newsIndicatorCandidate is the submitted document fed to the shared
// normalizer; every field is required.
type newsIndicatorCandidate = newsIndicatorSettingsDocument

// ---- classification ----

// newsClassificationTaxonomyNodeDocument is one stored taxonomy node.
type newsClassificationTaxonomyNodeDocument struct {
	Path           string   `json:"path"`
	DisplayName    string   `json:"displayName"`
	Description    string   `json:"description"`
	LegacyCategory string   `json:"legacyCategory"`
	Keywords       []string `json:"keywords"`
	Synonyms       []string `json:"synonyms"`
}

// newsClassificationSettingsDocument is the stored/cached
// news_classification_settings:<orgId> value.
type newsClassificationSettingsDocument struct {
	Enabled         bool                                     `json:"enabled"`
	StrictFail      bool                                     `json:"strictFail"`
	EnableLlm       bool                                     `json:"enableLlm"`
	EnableEmbedding bool                                     `json:"enableEmbedding"`
	EnableRerank    bool                                     `json:"enableRerank"`
	LlmModel        *string                                  `json:"llmModel"`
	MinConfidence   float64                                  `json:"minConfidence"`
	EmbeddingTopK   int                                      `json:"embeddingTopK"`
	RerankTopN      int                                      `json:"rerankTopN"`
	CacheTTLSeconds int                                      `json:"cacheTtlSeconds"`
	TaxonomyVersion string                                   `json:"taxonomyVersion"`
	Taxonomy        []newsClassificationTaxonomyNodeDocument `json:"taxonomy"`
}

func newNewsClassificationTaxonomyNodeDocument(node settingscrawl.NewsClassificationTaxonomyNodeModel) newsClassificationTaxonomyNodeDocument {
	return newsClassificationTaxonomyNodeDocument{
		Path:           node.Path,
		DisplayName:    node.DisplayName,
		Description:    node.Description,
		LegacyCategory: node.LegacyCategory,
		Keywords:       node.Keywords,
		Synonyms:       node.Synonyms,
	}
}

func newNewsClassificationSettingsDocument(model settingscrawl.NewsClassificationSettingsModel) newsClassificationSettingsDocument {
	nodes := make([]newsClassificationTaxonomyNodeDocument, 0, len(model.Taxonomy))
	for _, node := range model.Taxonomy {
		nodes = append(nodes, newNewsClassificationTaxonomyNodeDocument(node))
	}
	return newsClassificationSettingsDocument{
		Enabled:         model.Enabled,
		StrictFail:      model.StrictFail,
		EnableLlm:       model.EnableLlm,
		EnableEmbedding: model.EnableEmbedding,
		EnableRerank:    model.EnableRerank,
		LlmModel:        model.LlmModel,
		MinConfidence:   model.MinConfidence,
		EmbeddingTopK:   model.EmbeddingTopK,
		RerankTopN:      model.RerankTopN,
		CacheTTLSeconds: model.CacheTTLSeconds,
		TaxonomyVersion: model.TaxonomyVersion,
		Taxonomy:        nodes,
	}
}

// newsClassificationCandidate is the submitted document fed to the shared
// normalizer. llmModel and taxonomy are raw JSON so an omitted property can be
// distinguished from an explicit null (the resolver's cleanNullableString and
// `value.taxonomy === undefined` checks).
type newsClassificationCandidate struct {
	Enabled         *bool           `json:"enabled,omitempty"`
	StrictFail      *bool           `json:"strictFail,omitempty"`
	EnableLlm       *bool           `json:"enableLlm,omitempty"`
	EnableEmbedding *bool           `json:"enableEmbedding,omitempty"`
	EnableRerank    *bool           `json:"enableRerank,omitempty"`
	LlmModel        json.RawMessage `json:"llmModel,omitempty"`
	MinConfidence   *float64        `json:"minConfidence,omitempty"`
	EmbeddingTopK   *int            `json:"embeddingTopK,omitempty"`
	RerankTopN      *int            `json:"rerankTopN,omitempty"`
	CacheTTLSeconds *int            `json:"cacheTtlSeconds,omitempty"`
	TaxonomyVersion *string         `json:"taxonomyVersion,omitempty"`
	Taxonomy        json.RawMessage `json:"taxonomy,omitempty"`
}

// ---- classification quality ----

// classificationQualitySettingsDocument is the stored/cached
// classification_quality_settings:<orgId> value.
type classificationQualitySettingsDocument struct {
	LowConfidenceThreshold    float64 `json:"lowConfidenceThreshold"`
	LlmP95LatencyWarnMs       int     `json:"llmP95LatencyWarnMs"`
	EmbeddingP95LatencyWarnMs int     `json:"embeddingP95LatencyWarnMs"`
	RerankP95LatencyWarnMs    int     `json:"rerankP95LatencyWarnMs"`
	GateRejectRateWarn        float64 `json:"gateRejectRateWarn"`
	GatePenalizedRateWarn     float64 `json:"gatePenalizedRateWarn"`
	ReportMinPairCount        int     `json:"reportMinPairCount"`
	ReportMinPairErrorRate    float64 `json:"reportMinPairErrorRate"`
	CacheTTLSeconds           int     `json:"cacheTtlSeconds"`
}

func newClassificationQualitySettingsDocument(model settingscrawl.ClassificationQualitySettingsModel) classificationQualitySettingsDocument {
	return classificationQualitySettingsDocument{
		LowConfidenceThreshold:    model.LowConfidenceThreshold,
		LlmP95LatencyWarnMs:       model.LlmP95LatencyWarnMs,
		EmbeddingP95LatencyWarnMs: model.EmbeddingP95LatencyWarnMs,
		RerankP95LatencyWarnMs:    model.RerankP95LatencyWarnMs,
		GateRejectRateWarn:        model.GateRejectRateWarn,
		GatePenalizedRateWarn:     model.GatePenalizedRateWarn,
		ReportMinPairCount:        model.ReportMinPairCount,
		ReportMinPairErrorRate:    model.ReportMinPairErrorRate,
		CacheTTLSeconds:           model.CacheTTLSeconds,
	}
}

// classificationQualityCandidate is the submitted document fed to the shared
// normalizer; every property is optional.
type classificationQualityCandidate struct {
	LowConfidenceThreshold    *float64 `json:"lowConfidenceThreshold,omitempty"`
	LlmP95LatencyWarnMs       *int     `json:"llmP95LatencyWarnMs,omitempty"`
	EmbeddingP95LatencyWarnMs *int     `json:"embeddingP95LatencyWarnMs,omitempty"`
	RerankP95LatencyWarnMs    *int     `json:"rerankP95LatencyWarnMs,omitempty"`
	GateRejectRateWarn        *float64 `json:"gateRejectRateWarn,omitempty"`
	GatePenalizedRateWarn     *float64 `json:"gatePenalizedRateWarn,omitempty"`
	ReportMinPairCount        *int     `json:"reportMinPairCount,omitempty"`
	ReportMinPairErrorRate    *float64 `json:"reportMinPairErrorRate,omitempty"`
	CacheTTLSeconds           *int     `json:"cacheTtlSeconds,omitempty"`
}

// ---- news dedupe ----

// newsDedupeScopedThresholdDocument is one stored scoped threshold.
type newsDedupeScopedThresholdDocument struct {
	SourceID     *string `json:"sourceId"`
	Language     *string `json:"language"`
	CategoryPath *string `json:"categoryPath"`
	Threshold    float64 `json:"threshold"`
}

// newsDedupeSettingsDocument is the stored/cached news_dedupe_settings:<orgId>
// value.
type newsDedupeSettingsDocument struct {
	DefaultThreshold             float64                             `json:"defaultThreshold"`
	ScopedThresholds             []newsDedupeScopedThresholdDocument `json:"scopedThresholds"`
	UseEmbeddings                bool                                `json:"useEmbeddings"`
	LlmJudgeInstructions         *string                             `json:"llmJudgeInstructions"`
	LlmJudgeModel                *string                             `json:"llmJudgeModel"`
	LlmJudgeConcurrency          int                                 `json:"llmJudgeConcurrency"`
	LlmJudgeMaxComparisons       int                                 `json:"llmJudgeMaxComparisons"`
	LlmJudgeCandidateChars       int                                 `json:"llmJudgeCandidateChars"`
	LlmJudgePromptVersion        string                              `json:"llmJudgePromptVersion"`
	LlmJudgeSystemPromptTemplate string                              `json:"llmJudgeSystemPromptTemplate"`
	LlmJudgeUserPromptTemplate   string                              `json:"llmJudgeUserPromptTemplate"`
}

func newNewsDedupeSettingsDocument(model settingscrawl.NewsDedupeSettingsModel) newsDedupeSettingsDocument {
	scoped := make([]newsDedupeScopedThresholdDocument, 0, len(model.ScopedThresholds))
	for _, entry := range model.ScopedThresholds {
		scoped = append(scoped, newsDedupeScopedThresholdDocument{
			SourceID:     entry.SourceID,
			Language:     entry.Language,
			CategoryPath: entry.CategoryPath,
			Threshold:    entry.Threshold,
		})
	}
	return newsDedupeSettingsDocument{
		DefaultThreshold:             model.DefaultThreshold,
		ScopedThresholds:             scoped,
		UseEmbeddings:                model.UseEmbeddings,
		LlmJudgeInstructions:         model.LlmJudgeInstructions,
		LlmJudgeModel:                model.LlmJudgeModel,
		LlmJudgeConcurrency:          model.LlmJudgeConcurrency,
		LlmJudgeMaxComparisons:       model.LlmJudgeMaxComparisons,
		LlmJudgeCandidateChars:       model.LlmJudgeCandidateChars,
		LlmJudgePromptVersion:        model.LlmJudgePromptVersion,
		LlmJudgeSystemPromptTemplate: model.LlmJudgeSystemPromptTemplate,
		LlmJudgeUserPromptTemplate:   model.LlmJudgeUserPromptTemplate,
	}
}

// newsDedupeCandidate is the resolved document fed to the shared normalizer.
// The eight judge properties are always emitted (an omitted input keeps the
// stored value, an explicit null resets the built-in default).
type newsDedupeCandidate struct {
	DefaultThreshold             float64                             `json:"defaultThreshold"`
	ScopedThresholds             []newsDedupeScopedThresholdDocument `json:"scopedThresholds"`
	UseEmbeddings                bool                                `json:"useEmbeddings"`
	LlmJudgeInstructions         *string                             `json:"llmJudgeInstructions"`
	LlmJudgeModel                *string                             `json:"llmJudgeModel"`
	LlmJudgeConcurrency          *int                                `json:"llmJudgeConcurrency"`
	LlmJudgeMaxComparisons       *int                                `json:"llmJudgeMaxComparisons"`
	LlmJudgeCandidateChars       *int                                `json:"llmJudgeCandidateChars"`
	LlmJudgePromptVersion        *string                             `json:"llmJudgePromptVersion"`
	LlmJudgeSystemPromptTemplate *string                             `json:"llmJudgeSystemPromptTemplate"`
	LlmJudgeUserPromptTemplate   *string                             `json:"llmJudgeUserPromptTemplate"`
}

// ---- news extraction ----

// newsExtractionPreflightGateDocument is the stored preflightGate object.
type newsExtractionPreflightGateDocument struct {
	Enabled            bool    `json:"enabled"`
	MinWordCount       int     `json:"minWordCount"`
	MinQualityScore    float64 `json:"minQualityScore"`
	RejectBotChallenge bool    `json:"rejectBotChallenge"`
	RejectListLike     bool    `json:"rejectListLike"`
}

// newsExtractionPostCleanGateDocument is the stored postCleanGate object.
type newsExtractionPostCleanGateDocument struct {
	Enabled         bool    `json:"enabled"`
	MinQualityScore float64 `json:"minQualityScore"`
	MinCleanedChars int     `json:"minCleanedChars"`
	RequireSummary  bool    `json:"requireSummary"`
}

// newsExtractionCapabilitiesDocument is the stored capabilities object.
type newsExtractionCapabilitiesDocument struct {
	Entities  bool `json:"entities"`
	Sentiment bool `json:"sentiment"`
	Kg        bool `json:"kg"`
}

// newsExtractionProvidersDocument is the stored providers object.
type newsExtractionProvidersDocument struct {
	Clean     string `json:"clean"`
	Entities  string `json:"entities"`
	Sentiment string `json:"sentiment"`
	Kg        string `json:"kg"`
}

// newsExtractionSettingsDocument is the stored/cached
// news_extraction_settings:<orgId> value.
type newsExtractionSettingsDocument struct {
	PipelineMode  string                              `json:"pipelineMode"`
	PreflightGate newsExtractionPreflightGateDocument `json:"preflightGate"`
	PostCleanGate newsExtractionPostCleanGateDocument `json:"postCleanGate"`
	Capabilities  newsExtractionCapabilitiesDocument  `json:"capabilities"`
	Providers     newsExtractionProvidersDocument     `json:"providers"`
}

func newNewsExtractionSettingsDocument(model settingscrawl.NewsExtractionSettingsModel) newsExtractionSettingsDocument {
	return newsExtractionSettingsDocument{
		PipelineMode: string(model.PipelineMode),
		PreflightGate: newsExtractionPreflightGateDocument{
			Enabled:            model.PreflightGate.Enabled,
			MinWordCount:       model.PreflightGate.MinWordCount,
			MinQualityScore:    model.PreflightGate.MinQualityScore,
			RejectBotChallenge: model.PreflightGate.RejectBotChallenge,
			RejectListLike:     model.PreflightGate.RejectListLike,
		},
		PostCleanGate: newsExtractionPostCleanGateDocument{
			Enabled:         model.PostCleanGate.Enabled,
			MinQualityScore: model.PostCleanGate.MinQualityScore,
			MinCleanedChars: model.PostCleanGate.MinCleanedChars,
			RequireSummary:  model.PostCleanGate.RequireSummary,
		},
		Capabilities: newsExtractionCapabilitiesDocument{
			Entities:  model.Capabilities.Entities,
			Sentiment: model.Capabilities.Sentiment,
			Kg:        model.Capabilities.Kg,
		},
		Providers: newsExtractionProvidersDocument{
			Clean:     string(model.Providers.Clean),
			Entities:  string(model.Providers.Entities),
			Sentiment: string(model.Providers.Sentiment),
			Kg:        string(model.Providers.Kg),
		},
	}
}

// newsExtractionCandidateGate is the submitted preflightGate object; every
// property is optional.
type newsExtractionCandidatePreflightGate struct {
	Enabled            *bool    `json:"enabled,omitempty"`
	MinWordCount       *int     `json:"minWordCount,omitempty"`
	MinQualityScore    *float64 `json:"minQualityScore,omitempty"`
	RejectBotChallenge *bool    `json:"rejectBotChallenge,omitempty"`
	RejectListLike     *bool    `json:"rejectListLike,omitempty"`
}

// newsExtractionCandidatePostCleanGate is the submitted postCleanGate object.
type newsExtractionCandidatePostCleanGate struct {
	Enabled         *bool    `json:"enabled,omitempty"`
	MinQualityScore *float64 `json:"minQualityScore,omitempty"`
	MinCleanedChars *int     `json:"minCleanedChars,omitempty"`
	RequireSummary  *bool    `json:"requireSummary,omitempty"`
}

// newsExtractionCandidateCapabilities is the submitted capabilities object.
type newsExtractionCandidateCapabilities struct {
	Entities  *bool `json:"entities,omitempty"`
	Sentiment *bool `json:"sentiment,omitempty"`
	Kg        *bool `json:"kg,omitempty"`
}

// newsExtractionCandidateProviders is the submitted providers object.
type newsExtractionCandidateProviders struct {
	Clean     *string `json:"clean,omitempty"`
	Entities  *string `json:"entities,omitempty"`
	Sentiment *string `json:"sentiment,omitempty"`
	Kg        *string `json:"kg,omitempty"`
}

// newsExtractionCandidate is the submitted document fed to the shared
// normalizer. The extraction service never merges the stored setting: an
// omitted nested object keeps the built-in defaults.
type newsExtractionCandidate struct {
	PipelineMode  *string                               `json:"pipelineMode,omitempty"`
	PreflightGate *newsExtractionCandidatePreflightGate `json:"preflightGate,omitempty"`
	PostCleanGate *newsExtractionCandidatePostCleanGate `json:"postCleanGate,omitempty"`
	Capabilities  *newsExtractionCandidateCapabilities  `json:"capabilities,omitempty"`
	Providers     *newsExtractionCandidateProviders     `json:"providers,omitempty"`
}

// ---- news prompt config ----

// newsPromptConfigDocument is the stored news_pipeline_prompt_config value:
// the nine GraphQL fields plus denoisePromptTemplate, which is persisted but
// not exposed in the schema.
type newsPromptConfigDocument struct {
	Version                       string `json:"version"`
	SystemPromptTemplate          string `json:"systemPromptTemplate"`
	DenoisePromptTemplate         string `json:"denoisePromptTemplate"`
	UserPromptTemplate            string `json:"userPromptTemplate"`
	EntitySystemPromptTemplate    string `json:"entitySystemPromptTemplate"`
	EntityUserPromptTemplate      string `json:"entityUserPromptTemplate"`
	SentimentSystemPromptTemplate string `json:"sentimentSystemPromptTemplate"`
	SentimentUserPromptTemplate   string `json:"sentimentUserPromptTemplate"`
	KgSystemPromptTemplate        string `json:"kgSystemPromptTemplate"`
	KgUserPromptTemplate          string `json:"kgUserPromptTemplate"`
}

// newsPromptCandidate is the submitted document fed to the shared normalizer.
// The GraphQL input has no denoisePromptTemplate property, so an update always
// resets it to the built-in default, exactly like NewsPromptConfigService.
type newsPromptCandidate struct {
	Version                       string `json:"version"`
	SystemPromptTemplate          string `json:"systemPromptTemplate"`
	UserPromptTemplate            string `json:"userPromptTemplate"`
	EntitySystemPromptTemplate    string `json:"entitySystemPromptTemplate"`
	EntityUserPromptTemplate      string `json:"entityUserPromptTemplate"`
	SentimentSystemPromptTemplate string `json:"sentimentSystemPromptTemplate"`
	SentimentUserPromptTemplate   string `json:"sentimentUserPromptTemplate"`
	KgSystemPromptTemplate        string `json:"kgSystemPromptTemplate"`
	KgUserPromptTemplate          string `json:"kgUserPromptTemplate"`
}

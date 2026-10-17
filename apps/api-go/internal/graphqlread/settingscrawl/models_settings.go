package settingscrawl

// RateLimitBucketModel is the GraphQL RateLimitBucketModel object: one rate
// limit window for a single bucket.
type RateLimitBucketModel struct {
	Limit         int `graphql:"limit"`
	WindowSeconds int `graphql:"windowSeconds"`
}

// RateLimitSettingsModel is the GraphQL RateLimitSettingsModel object. The
// three buckets mirror the Redis rate_limit:settings document and the
// RATE_LIMIT_* MySQL keys.
type RateLimitSettingsModel struct {
	CrawlCreate RateLimitBucketModel `graphql:"crawlCreate"`
	Login       RateLimitBucketModel `graphql:"login"`
	RbacWrite   RateLimitBucketModel `graphql:"rbacWrite"`
}

// EntityImpactGraphSettingsModel is the GraphQL EntityImpactGraphSettingsModel
// object.
type EntityImpactGraphSettingsModel struct {
	CacheTTLSeconds     int      `graphql:"cacheTtlSeconds"`
	Categories          []string `graphql:"categories"`
	Enabled             bool     `graphql:"enabled"`
	MaxNodes            int      `graphql:"maxNodes"`
	MinCoOccurrence     int      `graphql:"minCoOccurrence"`
	MinCorrelation      float64  `graphql:"minCorrelation"`
	MinEntityConfidence float64  `graphql:"minEntityConfidence"`
}

// KnowledgeGraphSettingsModel is the GraphQL KnowledgeGraphSettingsModel
// object. Every field is non-null in the SDL.
type KnowledgeGraphSettingsModel struct {
	CacheTTLSeconds                            int      `graphql:"cacheTtlSeconds"`
	DynamicEdgeConfidenceEnabled               bool     `graphql:"dynamicEdgeConfidenceEnabled"`
	DynamicEdgeConfidenceQuantile              float64  `graphql:"dynamicEdgeConfidenceQuantile"`
	Enabled                                    bool     `graphql:"enabled"`
	EntityDisambiguationEnabled                bool     `graphql:"entityDisambiguationEnabled"`
	EntityDisambiguationMaxCandidates          int      `graphql:"entityDisambiguationMaxCandidates"`
	IngestionEnabled                           bool     `graphql:"ingestionEnabled"`
	MaxBatchSize                               int      `graphql:"maxBatchSize"`
	MaxRelationsPerArticle                     int      `graphql:"maxRelationsPerArticle"`
	MinEdgeConfidence                          float64  `graphql:"minEdgeConfidence"`
	MultiModelValidationEnabled                bool     `graphql:"multiModelValidationEnabled"`
	MultiModelValidationMaxRelationsPerArticle int      `graphql:"multiModelValidationMaxRelationsPerArticle"`
	MultiModelValidationModelCount             int      `graphql:"multiModelValidationModelCount"`
	MultiModelValidationModels                 []string `graphql:"multiModelValidationModels"`
}

// NewsEventSettingsModel is the GraphQL NewsEventSettingsModel object.
type NewsEventSettingsModel struct {
	BackfillDays                          int                     `graphql:"backfillDays"`
	BertopicMaxItemsPerRequest            int                     `graphql:"bertopicMaxItemsPerRequest"`
	BertopicMinItemsPerGroup              int                     `graphql:"bertopicMinItemsPerGroup"`
	BertopicMinTopicSize                  int                     `graphql:"bertopicMinTopicSize"`
	CacheTTLSeconds                       int                     `graphql:"cacheTtlSeconds"`
	CategoryConflictReject                bool                    `graphql:"categoryConflictReject"`
	CategorySoftPenalty                   float64                 `graphql:"categorySoftPenalty"`
	ClassificationGateEnabled             bool                    `graphql:"classificationGateEnabled"`
	ClusteringMode                        NewsEventClusteringMode `graphql:"clusteringMode"`
	CrossLanguagePenalty                  float64                 `graphql:"crossLanguagePenalty"`
	Enabled                               bool                    `graphql:"enabled"`
	ForceAuthoritativeMode                bool                    `graphql:"forceAuthoritativeMode"`
	ForceMinAuthoritativeSources          int                     `graphql:"forceMinAuthoritativeSources"`
	IngestionEnabled                      bool                    `graphql:"ingestionEnabled"`
	LookbackDays                          int                     `graphql:"lookbackDays"`
	MaxBatchSize                          int                     `graphql:"maxBatchSize"`
	MinCategoryConfidenceForGate          float64                 `graphql:"minCategoryConfidenceForGate"`
	TimelineCrossCategoryWarningShare     float64                 `graphql:"timelineCrossCategoryWarningShare"`
	TimelineDriftKlThreshold              float64                 `graphql:"timelineDriftKlThreshold"`
	TimelineEnabled                       bool                    `graphql:"timelineEnabled"`
	TimelineHighConfidenceThreshold       float64                 `graphql:"timelineHighConfidenceThreshold"`
	TimelineLowConfidenceThreshold        float64                 `graphql:"timelineLowConfidenceThreshold"`
	TimelineMaxCategoryDistributionItems  int                     `graphql:"timelineMaxCategoryDistributionItems"`
	TimelineMaxEventsPerRun               int                     `graphql:"timelineMaxEventsPerRun"`
	TimelineMaxPhaseSummaries             int                     `graphql:"timelineMaxPhaseSummaries"`
	TimelineMinBucketItemsForDrift        int                     `graphql:"timelineMinBucketItemsForDrift"`
	TimelinePresetCustomDistanceThreshold float64                 `graphql:"timelinePresetCustomDistanceThreshold"`
	VectorMinScore                        float64                 `graphql:"vectorMinScore"`
}

// NewsClassificationTaxonomyNodeModel is the GraphQL
// NewsClassificationTaxonomyNodeModel object.
type NewsClassificationTaxonomyNodeModel struct {
	Description    string   `graphql:"description"`
	DisplayName    string   `graphql:"displayName"`
	Keywords       []string `graphql:"keywords"`
	LegacyCategory string   `graphql:"legacyCategory"`
	Path           string   `graphql:"path"`
	Synonyms       []string `graphql:"synonyms"`
}

// NewsClassificationSettingsModel is the GraphQL
// NewsClassificationSettingsModel object.
type NewsClassificationSettingsModel struct {
	CacheTTLSeconds int                                   `graphql:"cacheTtlSeconds"`
	EmbeddingTopK   int                                   `graphql:"embeddingTopK"`
	EnableEmbedding bool                                  `graphql:"enableEmbedding"`
	EnableLlm       bool                                  `graphql:"enableLlm"`
	EnableRerank    bool                                  `graphql:"enableRerank"`
	Enabled         bool                                  `graphql:"enabled"`
	LlmModel        *string                               `graphql:"llmModel"`
	MinConfidence   float64                               `graphql:"minConfidence"`
	RerankTopN      int                                   `graphql:"rerankTopN"`
	StrictFail      bool                                  `graphql:"strictFail"`
	Taxonomy        []NewsClassificationTaxonomyNodeModel `graphql:"taxonomy"`
	TaxonomyVersion string                                `graphql:"taxonomyVersion"`
}

// ClassificationQualitySettingsModel is the GraphQL
// ClassificationQualitySettingsModel object.
type ClassificationQualitySettingsModel struct {
	CacheTTLSeconds           int     `graphql:"cacheTtlSeconds"`
	EmbeddingP95LatencyWarnMs int     `graphql:"embeddingP95LatencyWarnMs"`
	GatePenalizedRateWarn     float64 `graphql:"gatePenalizedRateWarn"`
	GateRejectRateWarn        float64 `graphql:"gateRejectRateWarn"`
	LlmP95LatencyWarnMs       int     `graphql:"llmP95LatencyWarnMs"`
	LowConfidenceThreshold    float64 `graphql:"lowConfidenceThreshold"`
	ReportMinPairCount        int     `graphql:"reportMinPairCount"`
	ReportMinPairErrorRate    float64 `graphql:"reportMinPairErrorRate"`
	RerankP95LatencyWarnMs    int     `graphql:"rerankP95LatencyWarnMs"`
}

// NewsDedupeScopedThresholdModel is the GraphQL
// NewsDedupeScopedThresholdModel object. The three scope selectors are
// nullable; threshold is non-null.
type NewsDedupeScopedThresholdModel struct {
	CategoryPath *string `graphql:"categoryPath"`
	Language     *string `graphql:"language"`
	SourceID     *string `graphql:"sourceId"`
	Threshold    float64 `graphql:"threshold"`
}

// NewsDedupeSettingsModel is the GraphQL NewsDedupeSettingsModel object.
type NewsDedupeSettingsModel struct {
	DefaultThreshold             float64                          `graphql:"defaultThreshold"`
	LlmJudgeCandidateChars       int                              `graphql:"llmJudgeCandidateChars"`
	LlmJudgeConcurrency          int                              `graphql:"llmJudgeConcurrency"`
	LlmJudgeInstructions         *string                          `graphql:"llmJudgeInstructions"`
	LlmJudgeMaxComparisons       int                              `graphql:"llmJudgeMaxComparisons"`
	LlmJudgeModel                *string                          `graphql:"llmJudgeModel"`
	LlmJudgePromptVersion        string                           `graphql:"llmJudgePromptVersion"`
	LlmJudgeSystemPromptTemplate string                           `graphql:"llmJudgeSystemPromptTemplate"`
	LlmJudgeUserPromptTemplate   string                           `graphql:"llmJudgeUserPromptTemplate"`
	ScopedThresholds             []NewsDedupeScopedThresholdModel `graphql:"scopedThresholds"`
	UseEmbeddings                bool                             `graphql:"useEmbeddings"`
}

// NewsIndicatorSettingsModel is the GraphQL NewsIndicatorSettingsModel object.
type NewsIndicatorSettingsModel struct {
	BacktestBaselineDays        int      `graphql:"backtestBaselineDays"`
	BacktestHoldoutDays         int      `graphql:"backtestHoldoutDays"`
	BacktestTriggerZScore       float64  `graphql:"backtestTriggerZScore"`
	CacheTTLSeconds             int      `graphql:"cacheTtlSeconds"`
	Enabled                     bool     `graphql:"enabled"`
	IndicatorSlugs              []string `graphql:"indicatorSlugs"`
	IngestionEnabled            bool     `graphql:"ingestionEnabled"`
	MaxAssociationsPerIndicator int      `graphql:"maxAssociationsPerIndicator"`
	MaxLagDays                  int      `graphql:"maxLagDays"`
	MaxPValue                   float64  `graphql:"maxPValue"`
	MinAbsCorrelation           float64  `graphql:"minAbsCorrelation"`
	MinSampleSize               int      `graphql:"minSampleSize"`
	TopEntities                 int      `graphql:"topEntities"`
	TopTopics                   int      `graphql:"topTopics"`
	WindowDays                  int      `graphql:"windowDays"`
}

// AuthCacheSettingsModel is the GraphQL AuthCacheSettingsModel object.
type AuthCacheSettingsModel struct {
	LockTTLMs         int `graphql:"lockTtlMs"`
	MaxWaitMs         int `graphql:"maxWaitMs"`
	ProfileTTLSeconds int `graphql:"profileTtlSeconds"`
	RetryDelayMs      int `graphql:"retryDelayMs"`
}

// CrawlClientSettingsModel is the GraphQL CrawlClientSettingsModel object.
type CrawlClientSettingsModel struct {
	AdaptiveConcurrencyEnabled               bool    `graphql:"adaptiveConcurrencyEnabled"`
	AdaptiveCooldownMinutes                  int     `graphql:"adaptiveCooldownMinutes"`
	AdaptiveErrorRateThreshold               float64 `graphql:"adaptiveErrorRateThreshold"`
	AdaptiveLatencyThresholdRatio            float64 `graphql:"adaptiveLatencyThresholdRatio"`
	AdaptiveMemoryHeadroomThreshold          float64 `graphql:"adaptiveMemoryHeadroomThreshold"`
	AdaptiveWindowMinutes                    int     `graphql:"adaptiveWindowMinutes"`
	ConditionalRequestEnabled                bool    `graphql:"conditionalRequestEnabled"`
	ConditionalRequestMaxRetries             int     `graphql:"conditionalRequestMaxRetries"`
	ConditionalRequestTimeoutMs              int     `graphql:"conditionalRequestTimeoutMs"`
	DetailPublishSignalHeadFetchConcurrency  int     `graphql:"detailPublishSignalHeadFetchConcurrency"`
	DetailPublishSignalHeadFetchMaxReadBytes int     `graphql:"detailPublishSignalHeadFetchMaxReadBytes"`
	DetailPublishSignalHeadFetchTimeoutMs    int     `graphql:"detailPublishSignalHeadFetchTimeoutMs"`
	HealthCheckTTLMs                         int     `graphql:"healthCheckTtlMs"`
	MaxRetries                               int     `graphql:"maxRetries"`
	QueueOverloadCooldownMs                  int     `graphql:"queueOverloadCooldownMs"`
	RequestTimeoutHotMs                      int     `graphql:"requestTimeoutHotMs"`
	RequestTimeoutMs                         int     `graphql:"requestTimeoutMs"`
	RequestTimeoutNormalMs                   int     `graphql:"requestTimeoutNormalMs"`
	RetryBackoffMs                           int     `graphql:"retryBackoffMs"`
}

// AuditLogRetentionModel is the GraphQL AuditLogRetentionModel object.
type AuditLogRetentionModel struct {
	RetentionDays int `graphql:"retentionDays"`
}

// NewsExtractionPreflightGateSettingsModel is the GraphQL
// NewsExtractionPreflightGateSettingsModel object.
type NewsExtractionPreflightGateSettingsModel struct {
	Enabled            bool    `graphql:"enabled"`
	MinQualityScore    float64 `graphql:"minQualityScore"`
	MinWordCount       int     `graphql:"minWordCount"`
	RejectBotChallenge bool    `graphql:"rejectBotChallenge"`
	RejectListLike     bool    `graphql:"rejectListLike"`
}

// NewsExtractionPostCleanGateSettingsModel is the GraphQL
// NewsExtractionPostCleanGateSettingsModel object.
type NewsExtractionPostCleanGateSettingsModel struct {
	Enabled         bool    `graphql:"enabled"`
	MinCleanedChars int     `graphql:"minCleanedChars"`
	MinQualityScore float64 `graphql:"minQualityScore"`
	RequireSummary  bool    `graphql:"requireSummary"`
}

// NewsExtractionCapabilitiesSettingsModel is the GraphQL
// NewsExtractionCapabilitiesSettingsModel object.
type NewsExtractionCapabilitiesSettingsModel struct {
	Entities  bool `graphql:"entities"`
	Kg        bool `graphql:"kg"`
	Sentiment bool `graphql:"sentiment"`
}

// NewsExtractionProvidersSettingsModel is the GraphQL
// NewsExtractionProvidersSettingsModel object.
type NewsExtractionProvidersSettingsModel struct {
	Clean     NewsExtractionProviderId `graphql:"clean"`
	Entities  NewsExtractionProviderId `graphql:"entities"`
	Kg        NewsExtractionProviderId `graphql:"kg"`
	Sentiment NewsExtractionProviderId `graphql:"sentiment"`
}

// NewsExtractionSettingsModel is the GraphQL NewsExtractionSettingsModel
// object.
type NewsExtractionSettingsModel struct {
	Capabilities  NewsExtractionCapabilitiesSettingsModel  `graphql:"capabilities"`
	PipelineMode  NewsExtractionPipelineMode               `graphql:"pipelineMode"`
	PostCleanGate NewsExtractionPostCleanGateSettingsModel `graphql:"postCleanGate"`
	PreflightGate NewsExtractionPreflightGateSettingsModel `graphql:"preflightGate"`
	Providers     NewsExtractionProvidersSettingsModel     `graphql:"providers"`
}

// NewsPromptConfigModel is the GraphQL NewsPromptConfigModel object.
type NewsPromptConfigModel struct {
	EntitySystemPromptTemplate    string `graphql:"entitySystemPromptTemplate"`
	EntityUserPromptTemplate      string `graphql:"entityUserPromptTemplate"`
	KgSystemPromptTemplate        string `graphql:"kgSystemPromptTemplate"`
	KgUserPromptTemplate          string `graphql:"kgUserPromptTemplate"`
	SentimentSystemPromptTemplate string `graphql:"sentimentSystemPromptTemplate"`
	SentimentUserPromptTemplate   string `graphql:"sentimentUserPromptTemplate"`
	SystemPromptTemplate          string `graphql:"systemPromptTemplate"`
	UserPromptTemplate            string `graphql:"userPromptTemplate"`
	Version                       string `graphql:"version"`
}

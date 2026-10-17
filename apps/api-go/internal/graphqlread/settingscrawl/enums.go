package settingscrawl

// CrawlTaskStatus is the GraphQL CrawlTaskStatus enum. The executor projects
// the constant value as the SDL enum member name.
type CrawlTaskStatus string

// CrawlTaskStatus members exactly mirror the SDL enum.
const (
	CrawlTaskStatusCompleted CrawlTaskStatus = "completed"
	CrawlTaskStatusFailed    CrawlTaskStatus = "failed"
	CrawlTaskStatusPaused    CrawlTaskStatus = "paused"
	CrawlTaskStatusPending   CrawlTaskStatus = "pending"
	CrawlTaskStatusQueued    CrawlTaskStatus = "queued"
	CrawlTaskStatusRunning   CrawlTaskStatus = "running"
)

// NewsEventClusteringMode is the GraphQL NewsEventClusteringMode enum.
type NewsEventClusteringMode string

// NewsEventClusteringMode members exactly mirror the SDL enum.
const (
	NewsEventClusteringModeBertopicPrimary NewsEventClusteringMode = "bertopic_primary"
	NewsEventClusteringModeVector          NewsEventClusteringMode = "vector"
)

// NewsEventSourcePolicyRevisionOperation is the GraphQL enum for the source
// policy revision operation. It is also the persisted JSON literal.
type NewsEventSourcePolicyRevisionOperation string

// NewsEventSourcePolicyRevisionOperation members exactly mirror the SDL enum.
const (
	NewsEventSourcePolicyRevisionOperationReset    NewsEventSourcePolicyRevisionOperation = "reset"
	NewsEventSourcePolicyRevisionOperationRollback NewsEventSourcePolicyRevisionOperation = "rollback"
	NewsEventSourcePolicyRevisionOperationUpdate   NewsEventSourcePolicyRevisionOperation = "update"
)

// NewsExtractionPipelineMode is the GraphQL NewsExtractionPipelineMode enum.
type NewsExtractionPipelineMode string

// NewsExtractionPipelineMode members exactly mirror the SDL enum.
const (
	NewsExtractionPipelineModeLegacy NewsExtractionPipelineMode = "legacy"
	NewsExtractionPipelineModeStaged NewsExtractionPipelineMode = "staged"
)

// NewsExtractionProviderId is the GraphQL NewsExtractionProviderId enum. The
// extractor only ever reports the single llm provider.
type NewsExtractionProviderId string

// NewsExtractionProviderIdLlm is the only NewsExtractionProviderId member.
const NewsExtractionProviderIdLlm NewsExtractionProviderId = "llm"

// sourcePolicyWarningCode is the persisted source policy sync warning literal.
// Persisting the code alongside the critical sections lets the reader report
// the same degraded state NestJS writes during a mutation.
type sourcePolicyWarningCode string

// Source policy sync warning codes, byte-for-byte the NestJS literals.
const (
	sourcePolicyWarningCacheWriteFailed      sourcePolicyWarningCode = "CACHE_WRITE_FAILED"
	sourcePolicyWarningPolicyCacheStale      sourcePolicyWarningCode = "POLICY_CACHE_STALE"
	sourcePolicyWarningPresetCacheStale      sourcePolicyWarningCode = "PRESET_CACHE_STALE"
	sourcePolicyWarningPolicyCacheMiss       sourcePolicyWarningCode = "POLICY_CACHE_MISS"
	sourcePolicyWarningPresetCacheMiss       sourcePolicyWarningCode = "PRESET_CACHE_MISS"
	sourcePolicyWarningPolicyCacheReadFailed sourcePolicyWarningCode = "POLICY_CACHE_READ_FAILED"
	sourcePolicyWarningPresetCacheReadFailed sourcePolicyWarningCode = "PRESET_CACHE_READ_FAILED"
	sourcePolicyWarningPolicyDBReadFailed    sourcePolicyWarningCode = "POLICY_DB_READ_FAILED"
	sourcePolicyWarningPresetDBReadFailed    sourcePolicyWarningCode = "PRESET_DB_READ_FAILED"
)

// evidenceReviewStatus is the persisted evidence review verdict inside the
// KnowledgeEdgeEvidence.evidence JSON document. Only these three literals mark
// a row as reviewed; every other value counts as unreviewed.
type evidenceReviewStatus string

// Evidence review verdicts, byte-for-byte the NestJS whitelist.
const (
	evidenceReviewStatusApproved  evidenceReviewStatus = "approved"
	evidenceReviewStatusRejected  evidenceReviewStatus = "rejected"
	evidenceReviewStatusCorrected evidenceReviewStatus = "corrected"
)

// Package newsnowclusteringops serves nine NewsNow local-computation and
// news-event clustering failure HTTP endpoints with a Go implementation that is
// byte-compatible with the NestJS originals.
//
// The endpoints are taken over only when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go:
//
//	GET  /api/news-aggregator/metadata
//	GET  /api/news-aggregator/resolve
//	POST /api/news-aggregator/sources/order
//	GET  /api/news-aggregator/domestic-opinion-index
//	GET  /api/system-settings/news-events/clustering/readiness
//	GET  /api/system-settings/news-events/clustering/overview
//	GET  /api/system-settings/news-events/clustering/failures
//	POST /api/system-settings/news-events/clustering/failures/:groupId/vector-backfill
//	POST /api/system-settings/news-events/clustering/failures/:groupId/ignore
//
// Nothing in this package fetches an external news source, calls an LLM or
// delivers a queue job. The endpoints that do stay on NestJS.
package newsnowclusteringops

// SortMode is the personalized-ordering mode reported back to the console.
// It mirrors NewsnowPersonalizationOrderPayload["sortMode"] in NestJS.
type SortMode string

const (
	// SortModeManual means the stored manual column order was applied verbatim
	// and no scoring ran.
	SortModeManual SortMode = "manual"
	// SortModePersonalized means affinity and behavior scoring produced the
	// returned order.
	SortModePersonalized SortMode = "personalized"
)

// NewsnowDataState mirrors NewsnowDataState in news-aggregator.types.ts.
type NewsnowDataState string

const (
	// NewsnowDataStateReady means at least one trend bucket exists.
	NewsnowDataStateReady NewsnowDataState = "ready"
	// NewsnowDataStateEmpty means neither snapshots nor pipeline data exist for
	// the requested window.
	NewsnowDataStateEmpty NewsnowDataState = "empty"
)

// NewsnowDomesticOpinionEmptyReason mirrors
// NewsnowDomesticOpinionEmptyReason in news-aggregator.types.ts.
type NewsnowDomesticOpinionEmptyReason string

// NewsnowDomesticOpinionEmptyReasonNoRecentSnapshotsOrPipelineData is the only
// empty reason the endpoint ever reports.
const NewsnowDomesticOpinionEmptyReasonNoRecentSnapshotsOrPipelineData NewsnowDomesticOpinionEmptyReason = "no_recent_snapshots_or_pipeline_data"

// ArchiveVertical mirrors the ArchiveVertical enum of the archive module.
// Only DomesticAffairs is consumed by this package, but the full set is needed
// because the rule classifier scores every vertical before picking a winner.
type ArchiveVertical string

const (
	// ArchiveVerticalEastSea is the East China Sea / Korean peninsula vertical.
	ArchiveVerticalEastSea ArchiveVertical = "EAST_SEA"
	// ArchiveVerticalSouthSea is the South China Sea vertical.
	ArchiveVerticalSouthSea ArchiveVertical = "SOUTH_SEA"
	// ArchiveVerticalWestFront is the western-front vertical.
	ArchiveVerticalWestFront ArchiveVertical = "WEST_FRONT"
	// ArchiveVerticalForeignAffairs is the default foreign-affairs vertical.
	ArchiveVerticalForeignAffairs ArchiveVertical = "FOREIGN_AFFAIRS"
	// ArchiveVerticalDomesticAffairs is the domestic-affairs vertical that the
	// domestic opinion index pipeline selector matches against.
	ArchiveVerticalDomesticAffairs ArchiveVertical = "DOMESTIC_AFFAIRS"
)

// ClusteringFailureStatus mirrors NewsEventClusteringFailureStatus in
// news-event-clustering-failure.service.ts.
type ClusteringFailureStatus string

const (
	// ClusteringFailureStatusPending is the only status a group can be claimed
	// from by the atomic vector-backfill takeover.
	ClusteringFailureStatusPending ClusteringFailureStatus = "pending"
	// ClusteringFailureStatusProcessing marks a group owned by a running
	// recovery.
	ClusteringFailureStatusProcessing ClusteringFailureStatus = "processing"
	// ClusteringFailureStatusResolved marks a group whose items were assigned.
	ClusteringFailureStatusResolved ClusteringFailureStatus = "resolved"
	// ClusteringFailureStatusIgnored marks a group an operator dismissed.
	ClusteringFailureStatusIgnored ClusteringFailureStatus = "ignored"
)

// StaleTTLStrategy mirrors NewsnowPersonalizationStaleTtlStrategy.
type StaleTTLStrategy string

const (
	// StaleTTLStrategyMultiplier derives the stale TTL from cacheTtlMs times
	// staleTtlMultiplier.
	StaleTTLStrategyMultiplier StaleTTLStrategy = "multiplier"
	// StaleTTLStrategyFixed uses staleTtlFixedMs directly.
	StaleTTLStrategyFixed StaleTTLStrategy = "fixed"
)

// newsEventAssignmentOverlap is the only NewsEventItem.assignedBy value the
// local (non-vector) path can produce. It mirrors
// NewsEventAssignmentMethod.overlap.
const newsEventAssignmentOverlap = "overlap"

// ---------------------------------------------------------------------------
// GET /api/news-aggregator/resolve
// ---------------------------------------------------------------------------

// ResolveResponse is the payload of GET /api/news-aggregator/resolve. The
// optional fields are omitted exactly like the NestJS object spread.
type ResolveResponse struct {
	Matched    bool     `json:"matched"`
	ItemID     string   `json:"itemId,omitempty"`
	EventID    string   `json:"eventId,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
	MatchedURL string   `json:"matchedUrl,omitempty"`
}

// ---------------------------------------------------------------------------
// POST /api/news-aggregator/sources/order
// ---------------------------------------------------------------------------

// SourceScoreDetail is one entry of sourceScoreDetails. Every field is the
// same 4-decimal rounded number the NestJS implementation emits.
type SourceScoreDetail struct {
	CombinedScore        float64 `json:"combinedScore"`
	AffinityScore        float64 `json:"affinityScore"`
	BehaviorScore        float64 `json:"behaviorScore"`
	AffinityWeight       float64 `json:"affinityWeight"`
	BehaviorWeight       float64 `json:"behaviorWeight"`
	AffinityContribution float64 `json:"affinityContribution"`
	BehaviorContribution float64 `json:"behaviorContribution"`
	NegativeContribution float64 `json:"negativeContribution"`
	FocusBonus           float64 `json:"focusBonus"`
}

// ScoreWeights is the normalized affinity/behavior pair plus the raw focus
// bonus reported to the console.
type ScoreWeights struct {
	Affinity   float64 `json:"affinity"`
	Behavior   float64 `json:"behavior"`
	FocusBonus float64 `json:"focusBonus"`
}

// PersonalizedOrderPayload is the response of POST
// /api/news-aggregator/sources/order.
type PersonalizedOrderPayload struct {
	ColumnKey          string                       `json:"columnKey"`
	SortMode           SortMode                     `json:"sortMode"`
	SourceIDs          []string                     `json:"sourceIds"`
	SourceScores       map[string]float64           `json:"sourceScores"`
	SourceScoreDetails map[string]SourceScoreDetail `json:"sourceScoreDetails"`
	ScoreWeights       ScoreWeights                 `json:"scoreWeights"`
	ComputedAt         string                       `json:"computedAt"`
}

// ---------------------------------------------------------------------------
// GET /api/news-aggregator/domestic-opinion-index
// ---------------------------------------------------------------------------

// CandidateKeywordSummary is one weighted keyword of the opinion index.
type CandidateKeywordSummary struct {
	Keyword string  `json:"keyword"`
	Weight  float64 `json:"weight"`
}

// DomesticOpinionIndexDiagnostics reports what the query actually scanned.
type DomesticOpinionIndexDiagnostics struct {
	RequestedHours      int `json:"requestedHours"`
	SnapshotCount       int `json:"snapshotCount"`
	PipelineBucketCount int `json:"pipelineBucketCount"`
}

// DomesticOpinionIndexPoint is one merged hourly bucket of the blended index.
type DomesticOpinionIndexPoint struct {
	BucketStart       string  `json:"bucketStart"`
	IndexValue        float64 `json:"indexValue"`
	AttentionScore    float64 `json:"attentionScore"`
	BreadthScore      float64 `json:"breadthScore"`
	FreshnessScore    float64 `json:"freshnessScore"`
	SentimentPressure float64 `json:"sentimentPressure"`
	CandidateCount    int     `json:"candidateCount"`
}

// DomesticOpinionIndexTopCandidate is one entry of the latest bucket's
// candidate ranking.
type DomesticOpinionIndexTopCandidate struct {
	Label          string  `json:"label"`
	CandidateScore float64 `json:"candidateScore"`
	SourceCount    int     `json:"sourceCount"`
}

// DomesticOpinionIndexBreakdownSourcePoint is the NewsNow snapshot side of a
// breakdown entry.
type DomesticOpinionIndexBreakdownSourcePoint struct {
	BucketStart       string  `json:"bucketStart"`
	IndexValue        float64 `json:"indexValue"`
	AttentionScore    float64 `json:"attentionScore"`
	BreadthScore      float64 `json:"breadthScore"`
	FreshnessScore    float64 `json:"freshnessScore"`
	SentimentPressure float64 `json:"sentimentPressure"`
	CandidateCount    int     `json:"candidateCount"`
}

// DomesticOpinionIndexPipelineBreakdownSourcePoint is the processed-article
// pipeline side of a breakdown entry.
type DomesticOpinionIndexPipelineBreakdownSourcePoint struct {
	BucketStart       string  `json:"bucketStart"`
	IndexValue        float64 `json:"indexValue"`
	AttentionScore    float64 `json:"attentionScore"`
	BreadthScore      float64 `json:"breadthScore"`
	FreshnessScore    float64 `json:"freshnessScore"`
	SentimentPressure float64 `json:"sentimentPressure"`
	ArticleCount      int     `json:"articleCount"`
	SourceCount       int     `json:"sourceCount"`
}

// DomesticOpinionIndexBreakdownPoint returns the two unblended contributions
// behind one merged bucket.
type DomesticOpinionIndexBreakdownPoint struct {
	BucketStart string                                            `json:"bucketStart"`
	Newsnow     *DomesticOpinionIndexBreakdownSourcePoint         `json:"newsnow"`
	Pipeline    *DomesticOpinionIndexPipelineBreakdownSourcePoint `json:"pipeline"`
}

// DomesticOpinionIndexBreakdownTopKeywords splits the latest bucket's keywords
// by source.
type DomesticOpinionIndexBreakdownTopKeywords struct {
	Newsnow  []CandidateKeywordSummary `json:"newsnow"`
	Pipeline []CandidateKeywordSummary `json:"pipeline"`
}

// DomesticOpinionIndexBreakdown is the explainability block of the response.
type DomesticOpinionIndexBreakdown struct {
	Latest      *DomesticOpinionIndexBreakdownPoint      `json:"latest"`
	Trend       []DomesticOpinionIndexBreakdownPoint     `json:"trend"`
	TopKeywords DomesticOpinionIndexBreakdownTopKeywords `json:"topKeywords"`
}

// DomesticOpinionIndexResponse is the response of GET
// /api/news-aggregator/domestic-opinion-index.
type DomesticOpinionIndexResponse struct {
	GeneratedAt   string                             `json:"generatedAt"`
	DataState     NewsnowDataState                   `json:"dataState"`
	EmptyReason   *NewsnowDomesticOpinionEmptyReason `json:"emptyReason"`
	Diagnostics   DomesticOpinionIndexDiagnostics    `json:"diagnostics"`
	Latest        *DomesticOpinionIndexPoint         `json:"latest"`
	Trend         []DomesticOpinionIndexPoint        `json:"trend"`
	TopKeywords   []CandidateKeywordSummary          `json:"topKeywords"`
	TopCandidates []DomesticOpinionIndexTopCandidate `json:"topCandidates"`
	Breakdown     DomesticOpinionIndexBreakdown      `json:"breakdown"`
}

// ---------------------------------------------------------------------------
// GET /api/system-settings/news-events/clustering/readiness
// ---------------------------------------------------------------------------

// ModelServiceReadiness reports whether the model service is callable.
type ModelServiceReadiness struct {
	Ready    bool    `json:"ready"`
	Enabled  bool    `json:"enabled"`
	BaseURL  *string `json:"baseUrl"`
	HasToken bool    `json:"hasToken"`
}

// LLMBackfillReadiness reports whether a completion profile can serve the
// manual LLM backfill. It is informational only: the Go takeover never
// enqueues that job.
type LLMBackfillReadiness struct {
	Ready       bool    `json:"ready"`
	ProfileID   *string `json:"profileId"`
	ProfileName *string `json:"profileName"`
	Model       *string `json:"model"`
	APISurface  *string `json:"apiSurface"`
}

// RecoveryAutomationReadiness mirrors the hardcoded scheduler description the
// NestJS service reports.
type RecoveryAutomationReadiness struct {
	Enabled           bool   `json:"enabled"`
	IntervalSeconds   int    `json:"intervalSeconds"`
	RetryAfterSeconds int    `json:"retryAfterSeconds"`
	BatchSize         int    `json:"batchSize"`
	ActorID           string `json:"actorId"`
}

// ReadinessResponse is the response of the clustering readiness endpoint.
type ReadinessResponse struct {
	ModelService       ModelServiceReadiness       `json:"modelService"`
	LLMBackfill        LLMBackfillReadiness        `json:"llmBackfill"`
	RecoveryAutomation RecoveryAutomationReadiness `json:"recoveryAutomation"`
}

// ---------------------------------------------------------------------------
// News-event clustering failure administration
// ---------------------------------------------------------------------------

// ClusteringFailureOverview counts the failure groups of one organization.
type ClusteringFailureOverview struct {
	PendingCount    int     `json:"pendingCount"`
	ProcessingCount int     `json:"processingCount"`
	ResolvedCount   int     `json:"resolvedCount"`
	IgnoredCount    int     `json:"ignoredCount"`
	LatestFailureAt *string `json:"latestFailureAt"`
}

// ClusteringFailureSummary is one row of the failure list.
type ClusteringFailureSummary struct {
	GroupID                string                  `json:"groupId"`
	Status                 ClusteringFailureStatus `json:"status"`
	ClusteringMode         string                  `json:"clusteringMode"`
	FailureReason          string                  `json:"failureReason"`
	FailureMessage         *string                 `json:"failureMessage"`
	Language               *string                 `json:"language"`
	EmbeddingModel         *string                 `json:"embeddingModel"`
	ItemCount              int                     `json:"itemCount"`
	SampleTitles           []string                `json:"sampleTitles"`
	AttemptCount           int                     `json:"attemptCount"`
	LastAttemptAt          *string                 `json:"lastAttemptAt"`
	LastError              *string                 `json:"lastError"`
	ActiveJobID            *string                 `json:"activeJobId"`
	ProgressProcessedCount int                     `json:"progressProcessedCount"`
	ProgressTotalCount     int                     `json:"progressTotalCount"`
	LastRecoveryModel      *string                 `json:"lastRecoveryModel"`
	ResolvedAt             *string                 `json:"resolvedAt"`
	ResolutionMode         *string                 `json:"resolutionMode"`
	ResolvedEventIDs       []string                `json:"resolvedEventIds"`
	CreatedAt              string                  `json:"createdAt"`
	UpdatedAt              string                  `json:"updatedAt"`
}

// VectorBackfillResult is the response of a successful vector backfill.
type VectorBackfillResult struct {
	GroupID          string   `json:"groupId"`
	AssignedCount    int      `json:"assignedCount"`
	SkippedCount     int      `json:"skippedCount"`
	ResolvedEventIDs []string `json:"resolvedEventIds"`
	ResolvedAt       string   `json:"resolvedAt"`
}

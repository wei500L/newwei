package crawlreadtelemetry

// CrawlQualitySampleCounts mirrors CrawlQualityMetricSampleCounts.
type CrawlQualitySampleCounts struct {
	MarkdownCount               int `json:"markdownCount"`
	ExpansionTriggeredTaskCount int `json:"expansionTriggeredTaskCount"`
	HeadSignalAttemptedCount    int `json:"headSignalAttemptedCount"`
	PreflightRunCount           int `json:"preflightRunCount"`
	DedupeEvaluatedCount        int `json:"dedupeEvaluatedCount"`
}

// CrawlQualityRejectBreakdown mirrors CrawlQualityRejectBreakdown.
type CrawlQualityRejectBreakdown struct {
	IncludePattern    int `json:"includePattern"`
	ExcludePattern    int `json:"excludePattern"`
	PublishConfidence int `json:"publishConfidence"`
}

// CrawlQualityConfidenceBuckets mirrors CrawlQualityConfidenceBuckets.
type CrawlQualityConfidenceBuckets struct {
	Lt04       int `json:"lt04"`
	From04To06 int `json:"from04To06"`
	From06To08 int `json:"from06To08"`
	Gte08      int `json:"gte08"`
}

// CrawlQualityAlertThresholds mirrors CrawlQualityAlertThresholds.
type CrawlQualityAlertThresholds struct {
	PreflightFailureRateHigh float64 `json:"preflightFailureRateHigh"`
	HTTP304HitRateLow        float64 `json:"http304HitRateLow"`
	OrgHashDedupeHitRateHigh float64 `json:"orgHashDedupeHitRateHigh"`
}

// CrawlQualityMetricsSourceSnapshot mirrors CrawlQualityMetricsSourceSnapshot.
type CrawlQualityMetricsSourceSnapshot struct {
	SourceID                      string                        `json:"sourceId"`
	TaskCount                     int                           `json:"taskCount"`
	SampleCounts                  CrawlQualitySampleCounts      `json:"sampleCounts"`
	LowSignalRatio                float64                       `json:"lowSignalRatio"`
	EmptyMarkdownRate             float64                       `json:"emptyMarkdownRate"`
	ExpansionTriggerRate          float64                       `json:"expansionTriggerRate"`
	ExpansionSuccessRate          float64                       `json:"expansionSuccessRate"`
	AvgMarkdownChars              int                           `json:"avgMarkdownChars"`
	CandidateRejects              CrawlQualityRejectBreakdown   `json:"candidateRejects"`
	PublishConfidenceBuckets      CrawlQualityConfidenceBuckets `json:"publishConfidenceBuckets"`
	FitMarkdownPreferenceRate     float64                       `json:"fitMarkdownPreferenceRate"`
	HeadSignalSuccessRate         float64                       `json:"headSignalSuccessRate"`
	HeadSignalSoftFailureRate     float64                       `json:"headSignalSoftFailureRate"`
	HeadSignalTruncatedRate       float64                       `json:"headSignalTruncatedRate"`
	HeadSignalNoPublishSignalRate float64                       `json:"headSignalNoPublishSignalRate"`
	HTTP304HitRate                float64                       `json:"http304HitRate"`
	OrgHashDedupeHitRate          float64                       `json:"orgHashDedupeHitRate"`
	PreflightFailureRate          float64                       `json:"preflightFailureRate"`
}

// CrawlQualityMetricsSnapshot is the ObservabilitySnapshot payload for the
// crawl_quality_metrics scope. Field order follows buildSnapshot.
type CrawlQualityMetricsSnapshot struct {
	OrgID                         string                              `json:"orgId"`
	From                          JSTime                              `json:"from"`
	To                            JSTime                              `json:"to"`
	TaskCount                     int                                 `json:"taskCount"`
	SampleCounts                  CrawlQualitySampleCounts            `json:"sampleCounts"`
	LowSignalRatio                float64                             `json:"lowSignalRatio"`
	EmptyMarkdownRate             float64                             `json:"emptyMarkdownRate"`
	ExpansionTriggerRate          float64                             `json:"expansionTriggerRate"`
	ExpansionSuccessRate          float64                             `json:"expansionSuccessRate"`
	AvgMarkdownChars              int                                 `json:"avgMarkdownChars"`
	CandidateRejects              CrawlQualityRejectBreakdown         `json:"candidateRejects"`
	PublishConfidenceBuckets      CrawlQualityConfidenceBuckets       `json:"publishConfidenceBuckets"`
	FitMarkdownPreferenceRate     float64                             `json:"fitMarkdownPreferenceRate"`
	HeadSignalSuccessRate         float64                             `json:"headSignalSuccessRate"`
	HeadSignalSoftFailureRate     float64                             `json:"headSignalSoftFailureRate"`
	HeadSignalTruncatedRate       float64                             `json:"headSignalTruncatedRate"`
	HeadSignalNoPublishSignalRate float64                             `json:"headSignalNoPublishSignalRate"`
	HTTP304HitRate                float64                             `json:"http304HitRate"`
	OrgHashDedupeHitRate          float64                             `json:"orgHashDedupeHitRate"`
	PreflightFailureRate          float64                             `json:"preflightFailureRate"`
	GroupedBySource               []CrawlQualityMetricsSourceSnapshot `json:"groupedBySource"`
	AlertThresholds               CrawlQualityAlertThresholds         `json:"alertThresholds"`
}

// emptyCrawlQualitySampleCounts is the zero-valued sample counter.
func emptyCrawlQualitySampleCounts() CrawlQualitySampleCounts {
	return CrawlQualitySampleCounts{}
}

// emptyCrawlQualityRejectBreakdown is the zero-valued reject breakdown.
func emptyCrawlQualityRejectBreakdown() CrawlQualityRejectBreakdown {
	return CrawlQualityRejectBreakdown{}
}

// emptyCrawlQualityConfidenceBuckets is the zero-valued confidence histogram.
func emptyCrawlQualityConfidenceBuckets() CrawlQualityConfidenceBuckets {
	return CrawlQualityConfidenceBuckets{}
}

// crawlQualityTaskExpansionSummary is one Mongo expansion aggregation row.
type crawlQualityTaskExpansionSummary struct {
	TaskID                                string `bson:"taskId"`
	LowSignalTaskCount                    int    `bson:"lowSignalTaskCount"`
	ExpansionTriggeredTaskCount           int    `bson:"expansionTriggeredTaskCount"`
	ExpansionImprovedTaskCount            int    `bson:"expansionImprovedTaskCount"`
	CandidateRejectIncludePatternCount    int    `bson:"candidateRejectIncludePatternCount"`
	CandidateRejectExcludePatternCount    int    `bson:"candidateRejectExcludePatternCount"`
	CandidateRejectPublishConfidenceCount int    `bson:"candidateRejectPublishConfidenceCount"`
	PublishConfidenceLt04Count            int    `bson:"publishConfidenceLt04Count"`
	PublishConfidenceFrom04To06Count      int    `bson:"publishConfidenceFrom04To06Count"`
	PublishConfidenceFrom06To08Count      int    `bson:"publishConfidenceFrom06To08Count"`
	PublishConfidenceGte08Count           int    `bson:"publishConfidenceGte08Count"`
	FitMarkdownPreferenceTaskCount        int    `bson:"fitMarkdownPreferenceTaskCount"`
	HeadSignalAttemptedCount              int    `bson:"headSignalAttemptedCount"`
	HeadSignalSucceededCount              int    `bson:"headSignalSucceededCount"`
	HeadSignalSoftFailureCount            int    `bson:"headSignalSoftFailureCount"`
	HeadSignalTruncatedCount              int    `bson:"headSignalTruncatedCount"`
	HeadSignalNoPublishSignalCount        int    `bson:"headSignalNoPublishSignalCount"`
}

// crawlQualityTaskPreflightSummary is one Mongo preflight aggregation row.
type crawlQualityTaskPreflightSummary struct {
	TaskID                string `bson:"taskId"`
	PreflightRunCount     int    `bson:"preflightRunCount"`
	PreflightFailureCount int    `bson:"preflightFailureCount"`
	Preflight304HitCount  int    `bson:"preflight304HitCount"`
}

// crawlQualityTaskDedupeSummary is one Mongo dedupe aggregation row.
type crawlQualityTaskDedupeSummary struct {
	TaskID               string `bson:"taskId"`
	DedupeEvaluatedCount int    `bson:"dedupeEvaluatedCount"`
	DedupeOrgReuseCount  int    `bson:"dedupeOrgReuseCount"`
}

// crawlQualityTaskMarkdownSummary is one Mongo markdown aggregation row.
type crawlQualityTaskMarkdownSummary struct {
	TaskID             string `bson:"taskId"`
	MarkdownCount      int    `bson:"markdownCount"`
	MarkdownCharsTotal int    `bson:"markdownCharsTotal"`
	EmptyMarkdownCount int    `bson:"emptyMarkdownCount"`
}

// crawlQualityTaskSnapshotRow aggregates one crawl task into the MySQL
// CrawlQualityTaskSnapshot table.
type crawlQualityTaskSnapshotRow struct {
	TaskID                                string
	OrgID                                 string
	SourceID                              string
	TaskCreatedAt                         JSTime
	TaskUpdatedAt                         JSTime
	RolledAt                              JSTime
	LowSignalTaskCount                    int
	ExpansionTriggeredTaskCount           int
	ExpansionImprovedTaskCount            int
	MarkdownCount                         int
	MarkdownCharsTotal                    int
	EmptyMarkdownCount                    int
	CandidateRejectIncludePatternCount    int
	CandidateRejectExcludePatternCount    int
	CandidateRejectPublishConfidenceCount int
	PublishConfidenceLt04Count            int
	PublishConfidenceFrom04To06Count      int
	PublishConfidenceFrom06To08Count      int
	PublishConfidenceGte08Count           int
	FitMarkdownPreferenceTaskCount        int
	HeadSignalAttemptedCount              int
	HeadSignalSucceededCount              int
	HeadSignalSoftFailureCount            int
	HeadSignalTruncatedCount              int
	HeadSignalNoPublishSignalCount        int
	PreflightRunCount                     int
	PreflightFailureCount                 int
	Preflight304HitCount                  int
	DedupeEvaluatedCount                  int
	DedupeOrgReuseCount                   int
}

// crawlQualitySnapshotMetadata is the stored snapshot identity used to decide
// whether a task has to be rolled again.
type crawlQualitySnapshotMetadata struct {
	TaskID        string
	TaskUpdatedAt JSTime
	RolledAt      JSTime
}

// crawlQualityAggregateRow is one CrawlQualityTaskSnapshot aggregate row. Every
// counter is scanned as a nullable integer because the grouped query returns
// COUNT/SUM values that MySQL may report as DECIMAL or BIGINT.
type crawlQualityAggregateRow struct {
	SourceID *string

	TaskCount                             int64
	LowSignalTaskCount                    int64
	ExpansionTriggeredTaskCount           int64
	ExpansionImprovedTaskCount            int64
	MarkdownCount                         int64
	MarkdownCharsTotal                    int64
	EmptyMarkdownCount                    int64
	CandidateRejectIncludePatternCount    int64
	CandidateRejectExcludePatternCount    int64
	CandidateRejectPublishConfidenceCount int64
	PublishConfidenceLt04Count            int64
	PublishConfidenceFrom04To06Count      int64
	PublishConfidenceFrom06To08Count      int64
	PublishConfidenceGte08Count           int64
	FitMarkdownPreferenceTaskCount        int64
	HeadSignalAttemptedCount              int64
	HeadSignalSucceededCount              int64
	HeadSignalSoftFailureCount            int64
	HeadSignalTruncatedCount              int64
	HeadSignalNoPublishSignalCount        int64
	PreflightRunCount                     int64
	PreflightFailureCount                 int64
	Preflight304HitCount                  int64
	DedupeEvaluatedCount                  int64
	DedupeOrgReuseCount                   int64
}

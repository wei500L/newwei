package classificationrssops

// QualityWindow is the classification quality aggregation window. The values
// match the QUALITY_WINDOWS tuple of classification-quality.dto.ts.
type QualityWindow string

const (
	// QualityWindow1h covers the last hour with five-minute buckets.
	QualityWindow1h QualityWindow = "1h"
	// QualityWindow24h covers the last day with hourly buckets.
	QualityWindow24h QualityWindow = "24h"
	// QualityWindow7d covers the last week with six-hour buckets.
	QualityWindow7d QualityWindow = "7d"
)

// qualityWindows is the ordered whitelist used by validation messages.
var qualityWindows = []string{"1h", "24h", "7d"}

// ReviewDecisionStatus is the human review verdict accepted by the decision
// endpoints (REVIEW_DECISION_STATUSES in the DTO).
type ReviewDecisionStatus string

const (
	// ReviewDecisionApproved accepts the predicted category.
	ReviewDecisionApproved ReviewDecisionStatus = "approved"
	// ReviewDecisionRejected rejects the predicted category.
	ReviewDecisionRejected ReviewDecisionStatus = "rejected"
	// ReviewDecisionCorrected replaces the predicted category.
	ReviewDecisionCorrected ReviewDecisionStatus = "corrected"
)

// ConfidenceBand is the stratification key for manual sampling (CONFIDENCE_BANDS).
type ConfidenceBand string

const (
	// ConfidenceBandLow is a confidence below 0.4.
	ConfidenceBandLow ConfidenceBand = "low"
	// ConfidenceBandMedium is a confidence in [0.4, 0.75).
	ConfidenceBandMedium ConfidenceBand = "medium"
	// ConfidenceBandHigh is a confidence of at least 0.75.
	ConfidenceBandHigh ConfidenceBand = "high"
)

// ClassifiedSourceType is the source authority label produced by the source
// classifier (ClassifiedSourceType in news-event-source-classifier.ts).
type ClassifiedSourceType string

const (
	// ClassifiedSourceAuthoritative is an authoritative newsroom or agency.
	ClassifiedSourceAuthoritative ClassifiedSourceType = "authoritative"
	// ClassifiedSourceBlog is a blog or low-trust host.
	ClassifiedSourceBlog ClassifiedSourceType = "blog"
	// ClassifiedSourceUnknown means the classifier matched neither list.
	ClassifiedSourceUnknown ClassifiedSourceType = "unknown"
)

// RssSourceVisibility describes how an RSS source surfaces in the console
// (RssDiagnosticsSourceRow.visibility).
type RssSourceVisibility string

const (
	// RssSourceVisibilityProcessed means completed processed items reference it.
	RssSourceVisibilityProcessed RssSourceVisibility = "processed"
	// RssSourceVisibilityArticleFallback means only MySQL articles reference it.
	RssSourceVisibilityArticleFallback RssSourceVisibility = "article_fallback"
	// RssSourceVisibilityNone means the source has no recent items at all.
	RssSourceVisibilityNone RssSourceVisibility = "none"
)

// latencyAlert is one classification latency threshold check. The same shape is
// embedded in the summary response and in the notification payload.
type latencyAlert struct {
	Stage       string   `json:"stage"`
	ThresholdMs int      `json:"thresholdMs"`
	P95Ms       *float64 `json:"p95Ms"`
	Triggered   bool     `json:"triggered"`
}

// gateAlert is one category-gate rate threshold check.
type gateAlert struct {
	Metric    string  `json:"metric"`
	Threshold float64 `json:"threshold"`
	Value     float64 `json:"value"`
	Triggered bool    `json:"triggered"`
}

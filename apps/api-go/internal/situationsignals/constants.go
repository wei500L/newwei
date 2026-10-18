package situationsignals

import "time"

// HTTP paths owned by this batch. The gateway registers exactly these, so the
// handler's own switch is a safety net rather than the routing authority.
const (
	catalogPath         = "/api/situation-monitor/catalog"
	feedbackPath        = "/api/situation-monitor/feedback"
	refreshRunsPrefix   = "/api/situation-monitor/refresh-runs/"
	telegramFeedPath    = "/api/situation-monitor/telegram-feed"
	orefAlertsPath      = "/api/situation-monitor/oref-alerts"
	orefHistoryPath     = "/api/situation-monitor/oref-history"
	liveHLSProxyPath    = "/api/situation-monitor/live-hls-proxy-config"
	requiredReadPerm    = "items.read"
	requiredWritePerm   = "items.write"
	monitorLimit        = 200
	monitorDefaultLimit = 50
)

// Redis keys and TTLs mirrored from
// apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.constants.ts
// and situation-monitor-refresh.service.ts.
const (
	telegramStateKey  = "situation-monitor:signals:telegram:state:v1"
	orefAlertsKey     = "situation-monitor:signals:oref:alerts:v1"
	orefHistoryKey    = "situation-monitor:signals:oref:history:v1"
	telegramStateTTL  = 24 * time.Hour
	refreshRunPrefix  = "situation-monitor:refresh-run:"
	refreshRunTTL     = 15 * time.Minute
	insightsRevPrefix = "situation-monitor:insights:learning-rev:v1"
	insightsRevTTL    = 90 * 24 * time.Hour
)

// Mongo collections holding the feedback document and the learning state.
// Mongoose pluralizes the model names, which is where these come from.
const (
	feedbackCollection      = "situationsignalfeedbacks"
	learningStateCollection = "situationsignallearningstates"
)

// Monitor matching constants, copied verbatim from
// apps/api/src/modules/situation-monitor/situation-monitor-monitors.service.ts.
const (
	matchEmbeddingBatchSize    = 96
	semanticIncludeThreshold   = 0.82
	semanticShortlistThreshold = 0.68
	rerankIncludeThreshold     = 0.55
	rerankShortlistLimit       = 8
	maxApprovedTerms           = 36
	maxApprovedSuggestions     = 24
	lexicalHitLimit            = 6
	matchedTermLimit           = 8
	matchEmbeddingFeature      = "situation_monitor_monitors"
	matchEmbeddingSource       = "situation-monitor-monitors"
	matchEmbeddingStage        = "candidate-embedding"
	monitorRerankStage         = "monitor-rerank"
)

// crawlTaskStatus enumerates CrawlTask.status.
type crawlTaskStatus string

const (
	crawlTaskPending   crawlTaskStatus = "pending"
	crawlTaskQueued    crawlTaskStatus = "queued"
	crawlTaskRunning   crawlTaskStatus = "running"
	crawlTaskCompleted crawlTaskStatus = "completed"
	crawlTaskFailed    crawlTaskStatus = "failed"
	crawlTaskPaused    crawlTaskStatus = "paused"
)

// allCrawlTaskStatuses is the counting order of the progress block.
var allCrawlTaskStatuses = []crawlTaskStatus{
	crawlTaskPending,
	crawlTaskQueued,
	crawlTaskRunning,
	crawlTaskCompleted,
	crawlTaskFailed,
	crawlTaskPaused,
}

// pipelineJobStatus enumerates PipelineJob.status.
type pipelineJobStatus string

const (
	pipelineJobPending   pipelineJobStatus = "pending"
	pipelineJobQueued    pipelineJobStatus = "queued"
	pipelineJobRunning   pipelineJobStatus = "running"
	pipelineJobCompleted pipelineJobStatus = "completed"
	pipelineJobFailed    pipelineJobStatus = "failed"
	pipelineJobDelayed   pipelineJobStatus = "delayed"
)

// allPipelineJobStatuses is the counting order of the progress block.
var allPipelineJobStatuses = []pipelineJobStatus{
	pipelineJobPending,
	pipelineJobQueued,
	pipelineJobRunning,
	pipelineJobCompleted,
	pipelineJobFailed,
	pipelineJobDelayed,
}

// refreshLifecycleStatus is the refresh-run status union.
type refreshLifecycleStatus string

const (
	refreshStatusQueued    refreshLifecycleStatus = "queued"
	refreshStatusRunning   refreshLifecycleStatus = "running"
	refreshStatusCompleted refreshLifecycleStatus = "completed"
	refreshStatusPartial   refreshLifecycleStatus = "partial"
	refreshStatusFailed    refreshLifecycleStatus = "failed"
)

// signalType is the feedback signal union.
type signalType string

const (
	signalTypeNarrative   signalType = "narrative"
	signalTypeCorrelation signalType = "correlation"
)

// feedbackLabel is the feedback label union.
type feedbackLabel string

const (
	feedbackLabelFalsePositive feedbackLabel = "false_positive"
	feedbackLabelFalseNegative feedbackLabel = "false_negative"
)

// matchGeoStatus is the geo verdict union of a monitor match.
type matchGeoStatus string

const (
	geoStatusNotConfigured matchGeoStatus = "not_configured"
	geoStatusMatched       matchGeoStatus = "matched"
	geoStatusCountryMatch  matchGeoStatus = "country_match"
	geoStatusConflict      matchGeoStatus = "conflict"
	geoStatusUnresolved    matchGeoStatus = "unresolved"
)

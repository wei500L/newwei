package classificationrssops

import (
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Collection names follow the Mongoose defaults (lowercased, pluralized model
// names) used by NestJS.
const (
	processedItemsCollection     = "processeditems"
	taskLogsCollection           = "tasklogs"
	reviewsCollection            = "classificationreviews"
	samplesCollection            = "classificationsamples"
	annotationsCollection        = "classificationannotations"
	reportJobsCollection         = "classificationreportjobs"
	reportResultsCollection      = "classificationreportresults"
	rawItemsCollection           = "rawitems"
	rssDiagnosticsSnapshotScope  = "rss_diagnostics"
	summaryCachePrefix           = "quality:classification:summary:"
	alertNotificationCachePrefix = "quality:classification:alert:notify:"
	alertRecipientsCachePrefix   = "quality:classification:alert:recipients:"
	settingsCachePrefix          = "classificationQuality:settings:"
	settingsSystemKeyPrefix      = "classification_quality_settings:"
	sourcePolicyKeyPrefix        = "news_event_source_policy:"
	gateSettingsKeyPrefix        = "news_event_settings:"
)

// Bounded scans and defaults translated from classification-quality.service.ts.
const (
	summaryCacheTTLSeconds    = 60
	sourceItemsLimitDefault   = 50
	sourceItemsLimitMax       = 200
	reviewQueueLimitDefault   = 50
	reviewQueueLimitMax       = 200
	samplingFetchLimit        = 3000
	summaryItemsLimit         = 3000
	latencyLogsLimit          = 20000
	gateLogsLimit             = 20000
	reviewRetentionDays       = 180
	sampleRetentionDays       = 180
	annotationRetentionDays   = 365
	reportJobRetentionDays    = 365
	alertNotificationTTLSecs  = 900
	alertRecipientsCacheTTL   = 300
	settingsCacheTTLSeconds   = 60
	sourcePolicyCacheSeconds  = 60
	maxReviewBatchIDs         = 500
	unresolvedBackfillSamples = 20
)

// qualitySettings mirrors ClassificationQualitySettings. Every field is a
// concrete scalar so callers never read settings through an untyped record.
type qualitySettings struct {
	LowConfidenceThreshold    float64
	LLMP95LatencyWarnMs       int
	EmbeddingP95LatencyWarnMs int
	RerankP95LatencyWarnMs    int
	GateRejectRateWarn        float64
	GatePenalizedRateWarn     float64
	ReportMinPairCount        int
	ReportMinPairErrorRate    float64
	CacheTTLSeconds           int
}

// defaultQualitySettings mirrors getFallbackSettings.
func defaultQualitySettings() qualitySettings {
	return qualitySettings{
		LowConfidenceThreshold:    0.4,
		LLMP95LatencyWarnMs:       8000,
		EmbeddingP95LatencyWarnMs: 3000,
		RerankP95LatencyWarnMs:    4000,
		GateRejectRateWarn:        0.2,
		GatePenalizedRateWarn:     0.35,
		ReportMinPairCount:        3,
		ReportMinPairErrorRate:    0.2,
		CacheTTLSeconds:           60,
	}
}

// classificationQualitySettingsRecord is the JSON stored in MySQL SystemSetting
// under classification_quality_settings:<orgId>.
type classificationQualitySettingsRecord struct {
	LowConfidenceThreshold    *float64 `json:"lowConfidenceThreshold"`
	LLMP95LatencyWarnMs       *float64 `json:"llmP95LatencyWarnMs"`
	EmbeddingP95LatencyWarnMs *float64 `json:"embeddingP95LatencyWarnMs"`
	RerankP95LatencyWarnMs    *float64 `json:"rerankP95LatencyWarnMs"`
	GateRejectRateWarn        *float64 `json:"gateRejectRateWarn"`
	GatePenalizedRateWarn     *float64 `json:"gatePenalizedRateWarn"`
	ReportMinPairCount        *float64 `json:"reportMinPairCount"`
	ReportMinPairErrorRate    *float64 `json:"reportMinPairErrorRate"`
	CacheTTLSeconds           *float64 `json:"cacheTTLSeconds"`
}

// sourceInfo is a NewsSource row used for classifier lookups.
type sourceInfo struct {
	ID   string
	Name string
	URL  string
}

// articleContext mirrors the private ArticleContext interface: the MySQL
// ProcessedArticle join used to fill articleUrl and a fallback sourceId.
type articleContext struct {
	ProcessedItemID string
	ArticleURL      *string
	SourceID        *string
}

// ---- Mongo documents: processeditems ----

// processedItemResultDocument is the result subdocument projection.
type processedItemResultDocument struct {
	Title              bson.RawValue `bson:"title"`
	Summary            bson.RawValue `bson:"summary"`
	Source             bson.RawValue `bson:"source"`
	Category           bson.RawValue `bson:"category"`
	CategoryPath       bson.RawValue `bson:"category_path"`
	CategoryConfidence bson.RawValue `bson:"category_confidence"`
	CategoryMethod     bson.RawValue `bson:"category_method"`
}

// processedItemDocument is the processeditems projection used by the summary,
// the low-confidence list, the sampling query and the sourceId backfill.
type processedItemDocument struct {
	ID            bson.RawValue               `bson:"_id"`
	ItemMetaID    bson.RawValue               `bson:"itemMetaId"`
	SourceID      bson.RawValue               `bson:"sourceId"`
	PipelineJobID bson.RawValue               `bson:"pipelineJobId"`
	RawItemID     bson.RawValue               `bson:"rawItemId"`
	CreatedAt     bson.RawValue               `bson:"createdAt"`
	Result        processedItemResultDocument `bson:"result"`
}

// processedItemCountRow is the $group projection of the RSS source window
// statistics.
type processedItemCountRow struct {
	SourceID     bson.RawValue `bson:"_id"`
	ItemCount    bson.RawValue `bson:"itemCountWindow"`
	LatestItemAt bson.RawValue `bson:"latestItemAt"`
}

// ---- Mongo documents: tasklogs ----

// taskLogLatencyData is the typed projection of TaskLog.data for the classify
// stage.
type taskLogLatencyData struct {
	LLMLatencyMs       bson.RawValue `bson:"llmLatencyMs"`
	EmbeddingLatencyMs bson.RawValue `bson:"embeddingLatencyMs"`
	RerankLatencyMs    bson.RawValue `bson:"rerankLatencyMs"`
}

// taskLogLatencyDocument is one classify task log row.
type taskLogLatencyDocument struct {
	Data taskLogLatencyData `bson:"data"`
}

// taskLogGateData is the typed projection of TaskLog.data for the category gate.
type taskLogGateData struct {
	Decision bson.RawValue `bson:"decision"`
}

// taskLogGateDocument is one category-gate task log row.
type taskLogGateDocument struct {
	Data taskLogGateData `bson:"data"`
}

// ---- Mongo documents: classificationreviews ----

// candidatePath mirrors one ClassificationReview.candidatePaths entry. The
// optional fields keep the absent/null distinction Mongoose stores.
type candidatePath struct {
	Path           optionalString `json:"path,omitzero"`
	Score          optionalNumber `json:"score,omitzero"`
	LegacyCategory optionalString `json:"legacy_category,omitzero"`
	Reason         optionalString `json:"reason,omitzero"`
}

// classificationReviewDocument is one classificationreviews row.
type classificationReviewDocument struct {
	ID                      bson.RawValue `bson:"_id"`
	OrgID                   bson.RawValue `bson:"orgId"`
	EvidenceID              bson.RawValue `bson:"evidenceId"`
	ProcessedItemID         bson.RawValue `bson:"processedItemId"`
	ItemMetaID              bson.RawValue `bson:"itemMetaId"`
	SourceID                bson.RawValue `bson:"sourceId"`
	SourceType              bson.RawValue `bson:"sourceType"`
	ArticleURL              bson.RawValue `bson:"articleUrl"`
	ArticleTitle            bson.RawValue `bson:"articleTitle"`
	ArticleSummary          bson.RawValue `bson:"articleSummary"`
	PredictedCategoryPath   bson.RawValue `bson:"predictedCategoryPath"`
	PredictedLegacyCategory bson.RawValue `bson:"predictedLegacyCategory"`
	PredictedConfidence     bson.RawValue `bson:"predictedConfidence"`
	PredictedMethod         bson.RawValue `bson:"predictedMethod"`
	CandidatePaths          bson.RawValue `bson:"candidatePaths"`
	Status                  bson.RawValue `bson:"status"`
	CorrectedCategoryPath   bson.RawValue `bson:"correctedCategoryPath"`
	Note                    bson.RawValue `bson:"note"`
	QuickTags               bson.RawValue `bson:"quickTags"`
	ReviewerID              bson.RawValue `bson:"reviewerId"`
	ReviewedAt              bson.RawValue `bson:"reviewedAt"`
	ExpiresAt               bson.RawValue `bson:"expiresAt"`
	Version                 bson.RawValue `bson:"__v"`
	CreatedAt               bson.RawValue `bson:"createdAt"`
	UpdatedAt               bson.RawValue `bson:"updatedAt"`
}

// reviewQueueRow is the listReviewQueue response row.
type reviewQueueRow struct {
	ID                      string          `json:"id"`
	EvidenceID              *string         `json:"evidenceId"`
	ProcessedItemID         *string         `json:"processedItemId"`
	ItemMetaID              *string         `json:"itemMetaId"`
	SourceID                *string         `json:"sourceId"`
	SourceType              *string         `json:"sourceType"`
	ArticleURL              *string         `json:"articleUrl"`
	ArticleTitle            *string         `json:"articleTitle"`
	ArticleSummary          *string         `json:"articleSummary"`
	PredictedCategoryPath   *string         `json:"predictedCategoryPath"`
	PredictedLegacyCategory *string         `json:"predictedLegacyCategory"`
	PredictedConfidence     *float64        `json:"predictedConfidence"`
	PredictedMethod         *string         `json:"predictedMethod"`
	CandidatePaths          []candidatePath `json:"candidatePaths"`
	Status                  string          `json:"status"`
	CorrectedCategoryPath   *string         `json:"correctedCategoryPath"`
	Note                    *string         `json:"note"`
	QuickTags               []string        `json:"quickTags"`
	ReviewerID              *string         `json:"reviewerId"`
	ReviewedAt              *string         `json:"reviewedAt"`
	CreatedAt               string          `json:"createdAt"`
	UpdatedAt               string          `json:"updatedAt"`
}

// classificationReviewResponse mirrors the raw Mongoose document returned after
// a single review decision. Fields use the optional wrappers so an absent key is
// omitted exactly the way JSON.stringify drops undefined.
type classificationReviewResponse struct {
	ID                      string          `json:"_id"`
	OrgID                   optionalString  `json:"orgId,omitzero"`
	EvidenceID              optionalString  `json:"evidenceId,omitzero"`
	ProcessedItemID         optionalString  `json:"processedItemId,omitzero"`
	ItemMetaID              optionalString  `json:"itemMetaId,omitzero"`
	SourceID                optionalString  `json:"sourceId,omitzero"`
	SourceType              optionalString  `json:"sourceType,omitzero"`
	ArticleURL              optionalString  `json:"articleUrl,omitzero"`
	ArticleTitle            optionalString  `json:"articleTitle,omitzero"`
	ArticleSummary          optionalString  `json:"articleSummary,omitzero"`
	PredictedCategoryPath   optionalString  `json:"predictedCategoryPath,omitzero"`
	PredictedLegacyCategory optionalString  `json:"predictedLegacyCategory,omitzero"`
	PredictedConfidence     optionalNumber  `json:"predictedConfidence,omitzero"`
	PredictedMethod         optionalString  `json:"predictedMethod,omitzero"`
	CandidatePaths          []candidatePath `json:"candidatePaths"`
	Status                  optionalString  `json:"status,omitzero"`
	CorrectedCategoryPath   optionalString  `json:"correctedCategoryPath,omitzero"`
	Note                    optionalString  `json:"note,omitzero"`
	QuickTags               []string        `json:"quickTags"`
	ReviewerID              optionalString  `json:"reviewerId,omitzero"`
	ReviewedAt              optionalTime    `json:"reviewedAt,omitzero"`
	ExpiresAt               optionalTime    `json:"expiresAt,omitzero"`
	Version                 optionalNumber  `json:"__v,omitzero"`
	CreatedAt               optionalTime    `json:"createdAt,omitzero"`
	UpdatedAt               optionalTime    `json:"updatedAt,omitzero"`
}

// batchDecisionResult is the batch decision response.
type batchDecisionResult struct {
	Matched  int `json:"matched"`
	Modified int `json:"modified"`
}

// ---- Mongo documents: classificationsamples ----

// classificationSampleFilters mirrors the filters object written with a sample.
type classificationSampleFilters struct {
	Window          QualityWindow         `bson:"window"`
	SourceType      *ClassifiedSourceType `bson:"sourceType"`
	SourceIDs       []string              `bson:"sourceIds"`
	CategoryPrefix  *string               `bson:"categoryPrefix"`
	ConfidenceBands []ConfidenceBand      `bson:"confidenceBands"`
	Methods         []string              `bson:"methods"`
}

// classificationSampleStratum mirrors one strata entry.
type classificationSampleStratum struct {
	Key   string `bson:"key" json:"key"`
	Count int    `bson:"count" json:"count"`
}

// classificationSampleItem mirrors one classificationsamples.items entry.
type classificationSampleItem struct {
	ProcessedItemID         string               `bson:"processedItemId" json:"processedItemId"`
	ItemMetaID              *string              `bson:"itemMetaId" json:"itemMetaId"`
	SourceID                *string              `bson:"sourceId" json:"sourceId"`
	SourceType              ClassifiedSourceType `bson:"sourceType" json:"sourceType"`
	ArticleURL              *string              `bson:"articleUrl" json:"articleUrl"`
	ArticleTitle            *string              `bson:"articleTitle" json:"articleTitle"`
	PredictedCategoryPath   *string              `bson:"predictedCategoryPath" json:"predictedCategoryPath"`
	PredictedLegacyCategory *string              `bson:"predictedLegacyCategory" json:"predictedLegacyCategory"`
	PredictedConfidence     float64              `bson:"predictedConfidence" json:"predictedConfidence"`
	PredictedMethod         string               `bson:"predictedMethod" json:"predictedMethod"`
	ConfidenceBand          ConfidenceBand       `bson:"confidenceBand" json:"confidenceBand"`
	SampledAt               time.Time            `bson:"sampledAt" json:"sampledAt"`
}

// sampleItemJSON is the JSON projection of one classificationsamples.items
// entry: sampledAt is rendered with Date.prototype.toISOString precision so the
// API response matches NestJS byte for byte.
type sampleItemJSON struct {
	ProcessedItemID         string               `json:"processedItemId"`
	ItemMetaID              *string              `json:"itemMetaId"`
	SourceID                *string              `json:"sourceId"`
	SourceType              ClassifiedSourceType `json:"sourceType"`
	ArticleURL              *string              `json:"articleUrl"`
	ArticleTitle            *string              `json:"articleTitle"`
	PredictedCategoryPath   *string              `json:"predictedCategoryPath"`
	PredictedLegacyCategory *string              `json:"predictedLegacyCategory"`
	PredictedConfidence     float64              `json:"predictedConfidence"`
	PredictedMethod         string               `json:"predictedMethod"`
	ConfidenceBand          ConfidenceBand       `json:"confidenceBand"`
	SampledAt               string               `json:"sampledAt"`
}

// MarshalJSON renders the stored sample item with the JavaScript ISO format.
func (item classificationSampleItem) MarshalJSON() ([]byte, error) {
	return json.Marshal(sampleItemJSON{
		ProcessedItemID:         item.ProcessedItemID,
		ItemMetaID:              item.ItemMetaID,
		SourceID:                item.SourceID,
		SourceType:              item.SourceType,
		ArticleURL:              item.ArticleURL,
		ArticleTitle:            item.ArticleTitle,
		PredictedCategoryPath:   item.PredictedCategoryPath,
		PredictedLegacyCategory: item.PredictedLegacyCategory,
		PredictedConfidence:     item.PredictedConfidence,
		PredictedMethod:         item.PredictedMethod,
		ConfidenceBand:          item.ConfidenceBand,
		SampledAt:               formatJSTime(item.SampledAt),
	})
}

// classificationSampleDocument is the document inserted into classificationsamples.
// The explicit _id and timestamp fields mirror what Mongoose writes, so the Go
// insert produces byte-comparable documents.
type classificationSampleDocument struct {
	ID          bson.ObjectID                 `bson:"_id"`
	OrgID       string                        `bson:"orgId"`
	CreatedByID string                        `bson:"createdById"`
	Filters     classificationSampleFilters   `bson:"filters"`
	Strata      []classificationSampleStratum `bson:"strata"`
	ItemCount   int                           `bson:"itemCount"`
	Items       []classificationSampleItem    `bson:"items"`
	ExpiresAt   time.Time                     `bson:"expiresAt"`
	CreatedAt   time.Time                     `bson:"createdAt"`
	UpdatedAt   time.Time                     `bson:"updatedAt"`
}

// samplingQueryResponse is the createSample response.
type samplingQueryResponse struct {
	SampleID  *string                       `json:"sampleId"`
	ItemCount int                           `json:"itemCount"`
	Strata    []classificationSampleStratum `json:"strata"`
	Items     []classificationSampleItem    `json:"items"`
	CreatedAt string                        `json:"createdAt"`
}

// ---- Mongo documents: classificationannotations ----

// classificationAnnotationDocument is the upsert payload for
// classificationannotations. metadata is a legacy Mixed column no writer touches.
type classificationAnnotationDocument struct {
	OrgID                 string    `bson:"orgId"`
	SampleID              string    `bson:"sampleId"`
	ProcessedItemID       string    `bson:"processedItemId"`
	AnnotatorID           string    `bson:"annotatorId"`
	PredictedCategoryPath *string   `bson:"predictedCategoryPath"`
	PredictedMethod       *string   `bson:"predictedMethod"`
	PredictedConfidence   *float64  `bson:"predictedConfidence"`
	HumanCategoryPath     string    `bson:"humanCategoryPath"`
	Note                  *string   `bson:"note"`
	QuickTags             []string  `bson:"quickTags"`
	ExpiresAt             time.Time `bson:"expiresAt"`
}

// annotationPairDocument is the narrow projection computeSampleMetrics reads.
type annotationPairDocument struct {
	PredictedCategoryPath bson.RawValue `bson:"predictedCategoryPath"`
	HumanCategoryPath     bson.RawValue `bson:"humanCategoryPath"`
}

// confusionEntry is one confusion matrix cell.
type confusionEntry struct {
	PredictedPath string `json:"predictedPath"`
	ActualPath    string `json:"actualPath"`
	Count         int    `json:"count"`
}

// problemPathPair is one problem pair above the configured thresholds.
type problemPathPair struct {
	PredictedPath string  `json:"predictedPath"`
	ActualPath    string  `json:"actualPath"`
	Count         int     `json:"count"`
	ErrorRate     float64 `json:"errorRate"`
}

// sampleMetrics mirrors the computeSampleMetrics return value.
type sampleMetrics struct {
	Total            int               `json:"total"`
	Correct          int               `json:"correct"`
	Accuracy         float64           `json:"accuracy"`
	ConfusionMatrix  []confusionEntry  `json:"confusionMatrix"`
	ProblemPathPairs []problemPathPair `json:"problemPathPairs"`
}

// annotationSubmissionResponse is the submitAnnotations response.
type annotationSubmissionResponse struct {
	SampleID         string            `json:"sampleId"`
	Updated          int               `json:"updated"`
	Total            int               `json:"total"`
	Correct          int               `json:"correct"`
	Accuracy         float64           `json:"accuracy"`
	ConfusionMatrix  []confusionEntry  `json:"confusionMatrix"`
	ProblemPathPairs []problemPathPair `json:"problemPathPairs"`
}

// ---- Mongo documents: classificationreportjobs / classificationreportresults ----

// classificationReportJobError mirrors the only shape written into
// ClassificationReportJob.error: { message }.
type classificationReportJobError struct {
	Message string `bson:"message" json:"message"`
}

// classificationReportJobDocument is one classificationreportjobs row.
type classificationReportJobDocument struct {
	ID             bson.RawValue `bson:"_id"`
	Status         bson.RawValue `bson:"status"`
	SampleID       bson.RawValue `bson:"sampleId"`
	Progress       bson.RawValue `bson:"progress"`
	ReportResultID bson.RawValue `bson:"reportResultId"`
	StartedAt      bson.RawValue `bson:"startedAt"`
	CompletedAt    bson.RawValue `bson:"completedAt"`
	Error          bson.RawValue `bson:"error"`
	CreatedAt      bson.RawValue `bson:"createdAt"`
	UpdatedAt      bson.RawValue `bson:"updatedAt"`
}

// reportResultMetadata is the typed mirror of ClassificationReportResult.metadata,
// a legacy Mongo Mixed column. No code path in classification-quality.service.ts
// writes it, so the mirror stays empty rather than degrading to an untyped bag.
type reportResultMetadata struct{}

// reportResultConfusionEntry mirrors one stored confusionMatrix entry.
type reportResultConfusionEntry struct {
	PredictedPath string `bson:"predictedPath" json:"predictedPath"`
	ActualPath    string `bson:"actualPath" json:"actualPath"`
	Count         int    `bson:"count" json:"count"`
}

// reportResultProblemPair mirrors one stored problemPathPairs entry.
type reportResultProblemPair struct {
	PredictedPath string  `bson:"predictedPath" json:"predictedPath"`
	ActualPath    string  `bson:"actualPath" json:"actualPath"`
	Count         int     `bson:"count" json:"count"`
	ErrorRate     float64 `bson:"errorRate" json:"errorRate"`
}

// classificationReportResultDocument is one classificationreportresults row.
type classificationReportResultDocument struct {
	ID               bson.RawValue                `bson:"_id"`
	Total            bson.RawValue                `bson:"total"`
	Correct          bson.RawValue                `bson:"correct"`
	Accuracy         bson.RawValue                `bson:"accuracy"`
	ConfusionMatrix  []reportResultConfusionEntry `bson:"confusionMatrix"`
	ProblemPathPairs []reportResultProblemPair    `bson:"problemPathPairs"`
	Metadata         bson.RawValue                `bson:"metadata"`
}

// reportJobProgress mirrors the job sub-object of the report job response.
type reportJobProgress struct {
	ID          *string                       `json:"id"`
	Status      string                        `json:"status"`
	SampleID    *string                       `json:"sampleId"`
	Progress    float64                       `json:"progress"`
	StartedAt   *string                       `json:"startedAt"`
	CompletedAt *string                       `json:"completedAt"`
	Error       *classificationReportJobError `json:"error"`
	CreatedAt   string                        `json:"createdAt"`
	UpdatedAt   string                        `json:"updatedAt"`
}

// reportJobResult mirrors the result sub-object of the report job response.
type reportJobResult struct {
	ID               *string                      `json:"id"`
	Total            float64                      `json:"total"`
	Correct          float64                      `json:"correct"`
	Accuracy         float64                      `json:"accuracy"`
	ConfusionMatrix  []reportResultConfusionEntry `json:"confusionMatrix"`
	ProblemPathPairs []reportResultProblemPair    `json:"problemPathPairs"`
	Metadata         *reportResultMetadata        `json:"metadata"`
}

// reportJobResponse is the GET reports/:jobId response (null when missing).
type reportJobResponse struct {
	Job    reportJobProgress `json:"job"`
	Result *reportJobResult  `json:"result"`
}

// ---- Response models: summary and low-confidence items ----

// methodDistributionEntry is one group of the method distribution.
type methodDistributionEntry struct {
	Group string  `json:"group"`
	Count int     `json:"count"`
	Share float64 `json:"share"`
}

// confidenceTrendEntry is one trend bucket.
type confidenceTrendEntry struct {
	BucketStart        string   `json:"bucketStart"`
	Total              int      `json:"total"`
	AvgConfidence      *float64 `json:"avgConfidence"`
	LowConfidenceCount int      `json:"lowConfidenceCount"`
}

// latencyPercentiles is the p50/p95/p99 triple of one pipeline stage.
type latencyPercentiles struct {
	SampleSize int      `json:"sampleSize"`
	P50Ms      *float64 `json:"p50Ms"`
	P95Ms      *float64 `json:"p95Ms"`
	P99Ms      *float64 `json:"p99Ms"`
}

// latencyPercentileSet groups the three classification stages.
type latencyPercentileSet struct {
	LLM       latencyPercentiles `json:"llm"`
	Embedding latencyPercentiles `json:"embedding"`
	Rerank    latencyPercentiles `json:"rerank"`
}

// categoryGateStats is the category-gate decision mix.
type categoryGateStats struct {
	Reject        int     `json:"reject"`
	Penalized     int     `json:"penalized"`
	Total         int     `json:"total"`
	RejectRate    float64 `json:"rejectRate"`
	PenalizedRate float64 `json:"penalizedRate"`
}

// lowConfidenceSource is one entry of the top-10 low-confidence source list.
type lowConfidenceSource struct {
	SourceID           string   `json:"sourceId"`
	SourceName         string   `json:"sourceName"`
	SourceURL          string   `json:"sourceUrl"`
	Total              int      `json:"total"`
	LowConfidenceCount int      `json:"lowConfidenceCount"`
	LowConfidenceRate  float64  `json:"lowConfidenceRate"`
	AvgConfidence      *float64 `json:"avgConfidence"`
}

// sourceCategoryEntry is one source-type/category-prefix bucket.
type sourceCategoryEntry struct {
	SourceType     ClassifiedSourceType `json:"sourceType"`
	CategoryPrefix string               `json:"categoryPrefix"`
	Count          int                  `json:"count"`
}

// summarySampling groups the three bounded-scan coverage reports.
type summarySampling struct {
	ClassifiedItems samplingMeta `json:"classifiedItems"`
	LatencyLogs     samplingMeta `json:"latencyLogs"`
	GateLogs        samplingMeta `json:"gateLogs"`
}

// classificationQualitySummary is the GET summary response.
type classificationQualitySummary struct {
	Window                  QualityWindow             `json:"window"`
	From                    string                    `json:"from"`
	To                      string                    `json:"to"`
	TotalItems              int                       `json:"totalItems"`
	MethodDistribution      []methodDistributionEntry `json:"methodDistribution"`
	ConfidenceHistogram     []histogramBucket         `json:"confidenceHistogram"`
	ConfidenceTrend         []confidenceTrendEntry    `json:"confidenceTrend"`
	LowConfidenceSources    []lowConfidenceSource     `json:"lowConfidenceSources"`
	LatencyPercentiles      latencyPercentileSet      `json:"latencyPercentiles"`
	CategoryGate            categoryGateStats         `json:"categoryGate"`
	SourceCategoryBreakdown []sourceCategoryEntry     `json:"sourceCategoryBreakdown"`
	PendingReviewCount      int                       `json:"pendingReviewCount"`
	AlertStatus             []latencyAlert            `json:"alertStatus"`
	GateAlertStatus         []gateAlert               `json:"gateAlertStatus"`
	Sampling                summarySampling           `json:"sampling"`
}

// lowConfidenceItem is one row of the source item list.
type lowConfidenceItem struct {
	ProcessedItemID string   `json:"processedItemId"`
	ItemMetaID      *string  `json:"itemMetaId"`
	ArticleURL      *string  `json:"articleUrl"`
	ArticleTitle    *string  `json:"articleTitle"`
	ArticleSummary  *string  `json:"articleSummary"`
	CategoryPath    *string  `json:"categoryPath"`
	Confidence      *float64 `json:"confidence"`
	Method          *string  `json:"method"`
	CreatedAt       string   `json:"createdAt"`
}

// sourceItemsResponse is the GET sources/:sourceId/items response.
type sourceItemsResponse struct {
	SourceID   string              `json:"sourceId"`
	From       string              `json:"from"`
	To         string              `json:"to"`
	Items      []lowConfidenceItem `json:"items"`
	NextCursor *string             `json:"nextCursor"`
}

package newseventstimeline

import (
	"encoding/json"
	"time"
)

// Constants copied verbatim from news-events-timeline.service.ts.
const (
	maxItemsPerEvent                = 5000
	maxReferencedArticlesPerBucket  = 20
	klEpsilon                       = 1e-6
	dayMilliseconds                 = 24 * 60 * 60 * 1000
	rebuildTickGateTTL              = 9*time.Minute + 45*time.Second
	rebuildOrgLockTTL               = 9 * time.Minute
	minDriftKLThreshold             = 0
	maxDriftKLThreshold             = 5
	minMaxCategoryDistributionItems = 4
	maxMaxCategoryDistributionItems = 64
	minMaxPhaseSummaries            = 1
	maxMaxPhaseSummaries            = 20
	minMinBucketItemsForDrift       = 1
	maxMinBucketItemsForDrift       = 50
)

// Tick gate and organization lease keys, byte-identical to the NestJS cron.
const (
	tickGateKey      = "cron:news-events-timeline:tick-gate"
	orgLockKeyPrefix = "cron:news-events-timeline:org:"
)

// legacyCategories is the closed set normalizeLegacyCategory accepts.
var legacyCategories = map[string]struct{}{
	"politics": {},
	"tech":     {},
	"finance":  {},
	"gov":      {},
	"ai":       {},
	"intel":    {},
}

// timelineSourceItem is one NewsEventItem joined with its processed article and
// the Mongo classification, after normalization.
type timelineSourceItem struct {
	ProcessedArticleID string
	ArticleID          string
	ProcessedItemID    *string
	Timestamp          time.Time
	Title              *string
	Summary            *string
	KeyPoints          json.RawMessage
	QualityScore       *float64
	LegacyCategory     *string
	CategoryPath       *string
	CategoryConfidence *float64
}

// processedItemClassification is the Mongo result subset the timeline uses.
type processedItemClassification struct {
	LegacyCategory     *string
	CategoryPath       *string
	CategoryConfidence *float64
}

// timelineEntryClassification is the per-bucket leaf stored under
// metadata.timeline.entries.
type timelineEntryClassification struct {
	CategoryPath       *string  `json:"categoryPath"`
	CategoryConfidence *float64 `json:"categoryConfidence"`
	Tentative          bool     `json:"tentative"`
	Anchor             bool     `json:"anchor"`
	ImportanceScore    float64  `json:"importanceScore"`
	ItemCount          int      `json:"itemCount"`
}

// timelinePhaseSummary is one metadata.timeline.phaseSummaries entry.
type timelinePhaseSummary struct {
	Phase          int    `json:"phase"`
	Label          string `json:"label"`
	CategoryPrefix string `json:"categoryPrefix"`
	StartAt        string `json:"startAt"`
	EndAt          string `json:"endAt"`
	ItemCount      int    `json:"itemCount"`
	BucketCount    int    `json:"bucketCount"`
	Summary        string `json:"summary"`
}

// topicDriftWarning is one metadata.timeline.driftWarnings entry.
type topicDriftWarning struct {
	FromBucketStart    string  `json:"fromBucketStart"`
	ToBucketStart      string  `json:"toBucketStart"`
	KLDivergence       float64 `json:"klDivergence"`
	FromCategoryPrefix string  `json:"fromCategoryPrefix"`
	ToCategoryPrefix   string  `json:"toCategoryPrefix"`
}

// categoryDistributionEntry is one metadata.timeline.categoryDistribution
// entry.
type categoryDistributionEntry struct {
	CategoryPath string  `json:"categoryPath"`
	Count        int     `json:"count"`
	Share        float64 `json:"share"`
}

// timelineSubEvent is one metadata.timeline.subEvents entry.
type timelineSubEvent struct {
	ID            string `json:"id"`
	ParentEventID string `json:"parentEventId"`
	Phase         int    `json:"phase"`
	Title         string `json:"title"`
	CategoryPath  string `json:"categoryPath"`
	StartAt       string `json:"startAt"`
	EndAt         string `json:"endAt"`
	ItemCount     int    `json:"itemCount"`
	BucketCount   int    `json:"bucketCount"`
	Summary       string `json:"summary"`
}

// timelineMetadata is the metadata.timeline payload. Field order is the order
// mergeTimelineMetadata builds the object in. MySQL JSON columns do not preserve
// key order, so the read side only depends on the names and values.
type timelineMetadata struct {
	Entries              map[string]timelineEntryClassification `json:"entries"`
	CategoryDistribution []categoryDistributionEntry            `json:"categoryDistribution"`
	TopicDriftWarning    bool                                   `json:"topicDriftWarning"`
	TopicDriftSummary    *string                                `json:"topicDriftSummary"`
	DriftWarnings        []topicDriftWarning                    `json:"driftWarnings"`
	PhaseSummaries       []timelinePhaseSummary                 `json:"phaseSummaries"`
	SubEvents            []timelineSubEvent                     `json:"subEvents"`
	UpdatedAt            string                                 `json:"updatedAt"`
}

// timelineAnalysis is the analyzeTimeline result.
type timelineAnalysis struct {
	CategoryDistribution []categoryDistributionEntry
	TopicDriftWarning    bool
	TopicDriftSummary    *string
	DriftWarnings        []topicDriftWarning
	PhaseSummaries       []timelinePhaseSummary
}

// builtTimelineEntry is one bucket ready to be written.
type builtTimelineEntry struct {
	EventID                string
	BucketStart            time.Time
	Title                  *string
	Summary                *string
	KeyPoints              json.RawMessage
	ReferencedArticleIDs   []string
	Classification         timelineEntryClassification
	Distribution           *orderedDistribution
	DominantCategoryPrefix string
}

// timelineRuntimeSettings is resolveTimelineRuntimeSettings.
type timelineRuntimeSettings struct {
	ConfidenceFallback           float64
	LowConfidenceThreshold       float64
	HighConfidenceThreshold      float64
	DriftKLThreshold             float64
	MinBucketItemsForDrift       int
	CrossCategoryWarningShare    float64
	MaxCategoryDistributionItems int
	MaxPhaseSummaries            int
}

// eventRow is one NewsEvent selected by rebuildOrg. MetadataEntries is the raw
// JSON_EXTRACT of metadata.timeline.entries and MetadataIsObject is
// JSON_TYPE(metadata) = 'OBJECT'; the rest of the metadata column is never read
// (O2).
type eventRow struct {
	ID               string
	MetadataEntries  json.RawMessage
	MetadataIsObject bool
}

// storedTimelineEntry is one NewsEventTimelineEntry selected for an event.
type storedTimelineEntry struct {
	EventID              string
	BucketStart          time.Time
	Title                *string
	Summary              *string
	KeyPoints            json.RawMessage
	ReferencedArticleIDs json.RawMessage
}

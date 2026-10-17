package classificationrssops

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// RSS diagnostics bounds translated from rss-diagnostics.service.ts.
const (
	rssDefaultWindowDays    = 7
	rssMaxWindowDays        = 30
	rssDefaultLookbackHours = 24
	rssMaxLookbackHours     = 24 * 30
	rssDefaultBackfillLimit = 500
	rssMaxBackfillLimit     = 5000
	rssSnapshotTTLSeconds   = 60
	rssSchedulerDisplayName = "NewsSource:"
)

// rssSourceCounts is the chain.sources sub-object.
type rssSourceCounts struct {
	RSSTotal       int `json:"rssTotal"`
	RSSActive      int `json:"rssActive"`
	SeedEnabled    int `json:"seedEnabled"`
	MissingFeedURL int `json:"missingFeedUrl"`
}

// rssVisibility is the chain.visibility sub-object.
type rssVisibility struct {
	VisibleByProcessed       int `json:"visibleByProcessed"`
	VisibleByArticleFallback int `json:"visibleByArticleFallback"`
	HiddenSources            int `json:"hiddenSources"`
}

// rssProcessedCoverage is the chain.processedCoverage sub-object.
type rssProcessedCoverage struct {
	CompletedTotal  int     `json:"completedTotal"`
	MissingSourceID int     `json:"missingSourceId"`
	MissingRate     float64 `json:"missingRate"`
}

// rssArticleCoverage is the chain.articleCoverage sub-object.
type rssArticleCoverage struct {
	Total           int     `json:"total"`
	MissingSourceID int     `json:"missingSourceId"`
	MissingRate     float64 `json:"missingRate"`
}

// rssPipelineJobCounts is the chain.pipelineJobs sub-object.
type rssPipelineJobCounts struct {
	Total           int     `json:"total"`
	Queued          int     `json:"queued"`
	Running         int     `json:"running"`
	Completed       int     `json:"completed"`
	Failed          int     `json:"failed"`
	LatestCreatedAt *string `json:"latestCreatedAt"`
}

// rssCrawlTaskCounts is the chain.crawlTasks sub-object.
type rssCrawlTaskCounts struct {
	Total           int     `json:"total"`
	Queued          int     `json:"queued"`
	Running         int     `json:"running"`
	Completed       int     `json:"completed"`
	Failed          int     `json:"failed"`
	LatestUpdatedAt *string `json:"latestUpdatedAt"`
}

// rssCrawlResultCounts is the chain.crawlResults sub-object.
type rssCrawlResultCounts struct {
	Total              int     `json:"total"`
	MissingMarkdownRef int     `json:"missingMarkdownRef"`
	LatestFetchedAt    *string `json:"latestFetchedAt"`
}

// rssDiagnosticsChain is the chain object of the RSS diagnostics overview.
type rssDiagnosticsChain struct {
	GeneratedAt       string               `json:"generatedAt"`
	WindowDays        int                  `json:"windowDays"`
	LookbackHours     int                  `json:"lookbackHours"`
	SchedulerEnabled  bool                 `json:"schedulerEnabled"`
	Sources           rssSourceCounts      `json:"sources"`
	Visibility        rssVisibility        `json:"visibility"`
	ProcessedCoverage rssProcessedCoverage `json:"processedCoverage"`
	ArticleCoverage   rssArticleCoverage   `json:"articleCoverage"`
	PipelineJobs      rssPipelineJobCounts `json:"pipelineJobs"`
	CrawlTasks        rssCrawlTaskCounts   `json:"crawlTasks"`
	CrawlResults      rssCrawlResultCounts `json:"crawlResults"`
	Recommendations   []string             `json:"recommendations"`
}

// rssSourcePipelineStats is the jobs24h sub-object of a source row.
type rssSourcePipelineStats struct {
	Queued    int `json:"queued"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
}

// rssDiagnosticsSourceRow is one entry of the RSS diagnostics source list.
type rssDiagnosticsSourceRow struct {
	SourceID             string                 `json:"sourceId"`
	Name                 string                 `json:"name"`
	IsActive             bool                   `json:"isActive"`
	Language             *string                `json:"language"`
	SiteURL              string                 `json:"siteUrl"`
	FeedURL              *string                `json:"feedUrl"`
	SeedEnabled          bool                   `json:"seedEnabled"`
	ItemCountByProcessed int                    `json:"itemCountByProcessed"`
	LatestByProcessed    *string                `json:"latestByProcessed"`
	ItemCountByArticle   int                    `json:"itemCountByArticle"`
	LatestByArticle      *string                `json:"latestByArticle"`
	Visibility           RssSourceVisibility    `json:"visibility"`
	Jobs24h              rssSourcePipelineStats `json:"jobs24h"`
	LastJobStatus        *string                `json:"lastJobStatus"`
	LastJobCreatedAt     *string                `json:"lastJobCreatedAt"`
	LastFailureAt        *string                `json:"lastFailureAt"`
	ConsecutiveFailures  int                    `json:"consecutiveFailures"`
	CircuitOpenUntil     *string                `json:"circuitOpenUntil"`
	Issues               []string               `json:"issues"`
}

// rssDiagnosticsOverview is the payload stored in ObservabilitySnapshot and
// returned by GET overview.
type rssDiagnosticsOverview struct {
	GeneratedAt string                    `json:"generatedAt"`
	Chain       rssDiagnosticsChain       `json:"chain"`
	Sources     []rssDiagnosticsSourceRow `json:"sources"`
}

// rssBackfillUnresolvedSample mirrors BackfillUnresolvedSample.
type rssBackfillUnresolvedSample struct {
	ProcessedItemID string `json:"processedItemId"`
	ItemMetaID      string `json:"itemMetaId"`
	Reason          string `json:"reason"`
}

// rssSourceIDBackfillResponse is the POST backfill-source-id response.
type rssSourceIDBackfillResponse struct {
	DryRun            bool                          `json:"dryRun"`
	Limit             int                           `json:"limit"`
	Scanned           int                           `json:"scanned"`
	Matched           int                           `json:"matched"`
	Updated           int                           `json:"updated"`
	Unresolved        int                           `json:"unresolved"`
	UnresolvedSamples []rssBackfillUnresolvedSample `json:"unresolvedSamples"`
}

// rssSourceRow is one NewsSource row with an RSS seed configuration.
type rssSourceRow struct {
	ID                  string
	Name                string
	IsActive            bool
	SiteURL             string
	Language            *string
	SeedEnabled         bool
	FeedURL             *string
	LastFailureAt       *time.Time
	ConsecutiveFailures int
	CircuitOpenUntil    *time.Time
}

// rssSourceWindowStats is one per-source window aggregation.
type rssSourceWindowStats struct {
	ItemCount    int
	LatestItemAt *time.Time
}

// rssNewsSourceConfigDocument is the NewsSource.config JSON used to detect RSS
// seeded sources.
type rssNewsSourceConfigDocument struct {
	Seed *rssNewsSourceSeedDocument `json:"seed"`
}

// rssNewsSourceSeedDocument is the seed sub-object of NewsSource.config.
type rssNewsSourceSeedDocument struct {
	Enabled *bool   `json:"enabled"`
	Mode    *string `json:"mode"`
	FeedURL *string `json:"feedUrl"`
}

// crawlTaskConfigDocument is the CrawlTask.config JSON parsed during the
// multi-hop sourceId resolution.
type crawlTaskConfigDocument struct {
	SourceID    *string                       `json:"sourceId"`
	ItemPayload *crawlTaskItemPayloadDocument `json:"itemPayload"`
}

// crawlTaskItemPayloadDocument is the itemPayload sub-object.
type crawlTaskItemPayloadDocument struct {
	Metadata *crawlTaskItemMetadataDocument `json:"metadata"`
}

// crawlTaskItemMetadataDocument is the metadata sub-object.
type crawlTaskItemMetadataDocument struct {
	SourceID *string `json:"sourceId"`
}

// rssSourceStatsAggregate is the MySQL article/crawl aggregate row.
type rssSourceStatsAggregate struct {
	SourceID     string
	ItemCount    int
	LatestItemAt *time.Time
}

// rssPipelineStatusCount is one (sourceId, status) group row.
type rssPipelineStatusCount struct {
	SourceID string
	Status   string
	Count    int
}

// rssLatestPipelineJob is the newest job per source.
type rssLatestPipelineJob struct {
	SourceID  string
	Status    string
	CreatedAt time.Time
}

// rssCrawlTaskStatusCount is one crawl-task status group row.
type rssCrawlTaskStatusCount struct {
	Status string
	Count  int
}

// rssBackfillCandidate is one processed item missing sourceId, plus every
// resolved hop used by the multi-hop backfill.
type rssBackfillCandidate struct {
	ProcessedItemID       string
	RawItemID             string
	ItemMetaID            string
	PipelineJobID         *string
	RawSourceID           *string
	RawPipelineJobID      *string
	CrawlResultID         *string
	FallbackCrawlResultID *string
}

// rawItemMetadataDocument is the RawItem.payload.metadata sub-object.
type rawItemMetadataDocument struct {
	SourceID      bson.RawValue `bson:"sourceId"`
	PipelineJobID bson.RawValue `bson:"pipelineJobId"`
	CrawlResultID bson.RawValue `bson:"crawlResultId"`
}

// rawItemPayloadDocument is the RawItem.payload sub-object.
type rawItemPayloadDocument struct {
	Metadata rawItemMetadataDocument `bson:"metadata"`
}

// rawItemDocument is the rawitems projection used by the backfill.
type rawItemDocument struct {
	ID      bson.RawValue          `bson:"_id"`
	Payload rawItemPayloadDocument `bson:"payload"`
}

// rssItemMetaDocument is the ItemMeta projection used for the externalId hop.
type rssItemMetaDocument struct {
	ID         string
	ExternalID *string
}

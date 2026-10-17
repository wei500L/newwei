package settingscrawl

import (
	"encoding/json"
	"time"
)

// CrawlTaskConnection is the GraphQL CrawlTaskConnection object. totalCount is
// a GraphQL Float in the SDL, so it stays a float64.
type CrawlTaskConnection struct {
	Edges      []CrawlTaskEdge `graphql:"edges"`
	PageInfo   PageInfo        `graphql:"pageInfo"`
	TotalCount float64         `graphql:"totalCount"`
}

// CrawlTaskEdge is the GraphQL CrawlTaskEdge object.
type CrawlTaskEdge struct {
	Cursor string         `graphql:"cursor"`
	Node   CrawlTaskModel `graphql:"node"`
}

// PageInfo is the GraphQL PageInfo object shared by cursor connections.
type PageInfo struct {
	EndCursor   *string `graphql:"endCursor"`
	HasNextPage bool    `graphql:"hasNextPage"`
}

// CrawlExecutionSummaryModel is the GraphQL CrawlExecutionSummaryModel object:
// the counters of the most recent run.
type CrawlExecutionSummaryModel struct {
	Inserted          float64    `graphql:"inserted"`
	ItemsQueueFailed  *float64   `graphql:"itemsQueueFailed"`
	ItemsQueued       *float64   `graphql:"itemsQueued"`
	LastFetchedAt     *time.Time `graphql:"lastFetchedAt"`
	RetryableFailures *float64   `graphql:"retryableFailures"`
	RunID             *string    `graphql:"runId"`
	Skipped           float64    `graphql:"skipped"`
}

// CrawlMemoryStatsModel is the GraphQL CrawlMemoryStatsModel object.
type CrawlMemoryStatsModel struct {
	EfficiencyPercent *float64 `graphql:"efficiencyPercent"`
	PeakMemoryMb      *float64 `graphql:"peakMemoryMb"`
	ServerMemoryMb    *float64 `graphql:"serverMemoryMb"`
}

// CrawlLinkModel is the GraphQL CrawlLinkModel object: one extracted link.
type CrawlLinkModel struct {
	BaseDomain      *string  `graphql:"baseDomain"`
	ContextualScore *float64 `graphql:"contextualScore"`
	Href            string   `graphql:"href"`
	IntrinsicScore  *float64 `graphql:"intrinsicScore"`
	Rel             *string  `graphql:"rel"`
	Text            *string  `graphql:"text"`
	Title           *string  `graphql:"title"`
	TotalScore      *float64 `graphql:"totalScore"`
	Type            *string  `graphql:"type"`
}

// CrawlLinkBucketModel is the GraphQL CrawlLinkBucketModel object.
type CrawlLinkBucketModel struct {
	Kind  string           `graphql:"kind"`
	Links []CrawlLinkModel `graphql:"links"`
}

// CrawlLinkStatsModel is the GraphQL CrawlLinkStatsModel object.
type CrawlLinkStatsModel struct {
	AverageIntrinsicScore *float64 `graphql:"averageIntrinsicScore"`
	ExternalLinks         float64  `graphql:"externalLinks"`
	HighQualityLinks      *float64 `graphql:"highQualityLinks"`
	InternalLinks         float64  `graphql:"internalLinks"`
	LowQualityLinks       *float64 `graphql:"lowQualityLinks"`
	TotalLinks            float64  `graphql:"totalLinks"`
}

// CrawlLinkAnalysisModel is the GraphQL CrawlLinkAnalysisModel object.
type CrawlLinkAnalysisModel struct {
	Buckets         []CrawlLinkBucketModel `graphql:"buckets"`
	LowQualityLinks []CrawlLinkModel       `graphql:"lowQualityLinks"`
	Stats           CrawlLinkStatsModel    `graphql:"stats"`
	TopLinks        []CrawlLinkModel       `graphql:"topLinks"`
}

// CrawlResultModel is the GraphQL CrawlResultModel object: one crawled page.
type CrawlResultModel struct {
	FetchedAt             time.Time               `graphql:"fetchedAt"`
	FitMarkdown           *string                 `graphql:"fitMarkdown"`
	ID                    string                  `graphql:"id"`
	ItemID                *string                 `graphql:"itemId"`
	ItemStatus            *string                 `graphql:"itemStatus"`
	LinkAnalysis          *CrawlLinkAnalysisModel `graphql:"linkAnalysis"`
	Markdown              string                  `graphql:"markdown"`
	MarkdownWithCitations *string                 `graphql:"markdownWithCitations"`
	Media                 *string                 `graphql:"media"`
	MediaAssets           *string                 `graphql:"mediaAssets"`
	Metadata              *string                 `graphql:"metadata"`
	ReferencesMarkdown    *string                 `graphql:"referencesMarkdown"`
	SourceURL             string                  `graphql:"sourceUrl"`
	Tables                *json.RawMessage        `graphql:"tables"`
}

// CrawlTaskModel is the GraphQL CrawlTaskModel object. Results is a nullable
// list: a task detail without result rows projects GraphQL null, while a task
// that produced rows projects them.
type CrawlTaskModel struct {
	Concurrency          float64                     `graphql:"concurrency"`
	Config               *string                     `graphql:"config"`
	CreatedAt            time.Time                   `graphql:"createdAt"`
	DisplayName          *string                     `graphql:"displayName"`
	ID                   string                      `graphql:"id"`
	Keywords             []string                    `graphql:"keywords"`
	LastCursor           *string                     `graphql:"lastCursor"`
	LastError            *string                     `graphql:"lastError"`
	LastMemoryEfficiency *float64                    `graphql:"lastMemoryEfficiency"`
	LastPeakMemoryMb     *float64                    `graphql:"lastPeakMemoryMb"`
	LastResultAt         *time.Time                  `graphql:"lastResultAt"`
	LastRunAt            *time.Time                  `graphql:"lastRunAt"`
	LastRunSummary       *CrawlExecutionSummaryModel `graphql:"lastRunSummary"`
	LastServerMemoryMb   *float64                    `graphql:"lastServerMemoryMb"`
	LastSuccessAt        *time.Time                  `graphql:"lastSuccessAt"`
	MemoryStats          *CrawlMemoryStatsModel      `graphql:"memoryStats"`
	ResultCount          float64                     `graphql:"resultCount"`
	Results              []CrawlResultModel          `graphql:"results"`
	RunCount             float64                     `graphql:"runCount"`
	Status               CrawlTaskStatus             `graphql:"status"`
	TargetURL            string                      `graphql:"targetUrl"`
	TimeRangeFrom        *time.Time                  `graphql:"timeRangeFrom"`
	TimeRangeTo          *time.Time                  `graphql:"timeRangeTo"`
	UpdatedAt            time.Time                   `graphql:"updatedAt"`
}

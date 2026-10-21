package crawlexecution

import (
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// taskRow is the CrawlTask projection runTask reads. It mirrors the Prisma
// crawlTask.findFirst({where:{id, orgId}}) row plus the columns the terminal
// updates compare against (lastResultAt/lastCursor/memory stats).
type taskRow struct {
	ID                   string
	OrgID                string
	NewsSourceID         *string
	CreatedByID          string
	TargetURL            string
	DisplayName          *string
	Status               string
	Config               json.RawMessage
	Keywords             json.RawMessage
	LastResultAt         *time.Time
	LastCursor           *string
	LastServerMemoryMB   *float64
	LastPeakMemoryMB     *float64
	LastMemoryEfficiency *float64
}

// partitionedResults is CrawlExecutionResultsService.partitionCrawlerResults.
type partitionedResults struct {
	Successes           []crawl4ai.PipelineArticle
	Failures            []Failure
	LowSignalCandidates []crawl4ai.PipelineArticle
}

// httpValidationState is CrawlResultHttpValidationState.
type httpValidationState struct {
	ResultID     string
	FetchedAt    time.Time
	ETag         *string
	LastModified *string
}

// conditionalRequestSettings is ConditionalRequestSettings.
type conditionalRequestSettings struct {
	Enabled    bool
	TimeoutMs  int
	MaxRetries int
}

// conditionalPreflightResult is ConditionalPreflightResult.
type conditionalPreflightResult struct {
	Status       int
	ETag         *string
	LastModified *string
	Method       string
	CheckedAt    string
}

// conditionalPreflightOutcome is ConditionalPreflightOutcome.
type conditionalPreflightOutcome struct {
	Status   string // "completed" | "failed"
	Result   *conditionalPreflightResult
	Attempts int
	Failures int
}

// memoryStats is CrawlMemoryStats.
type memoryStats struct {
	ServerMemoryMB    *float64
	PeakMemoryMB      *float64
	EfficiencyPercent *float64
}

// crawlRun is one anti-bot crawl attempt result (response + effective options +
// partitioned results) so the branches can hand results around without
// re-partitioning.
type crawlRun struct {
	Response  crawl4ai.PipelineResponse
	Options   normalizedOptions
	Successes []crawl4ai.PipelineArticle
	Failures  []Failure
	LowSignal []crawl4ai.PipelineArticle
}

// markdownResult is CrawlResultService.extractMarkdownResult's projection.
type markdownResult struct {
	Primary    *string
	Raw        *string
	Citations  *string
	References *string
	Fit        *string
}

// persistedResult is persistSingleResult's outcome.
type persistedResult struct {
	ResultID  string
	FetchedAt time.Time
	Inserted  bool
}

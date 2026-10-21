package crawlfrontiernode

// types.go declares the shared types of the Frontier node execution chain. It is
// the contract between the files of this package: every option object below is
// the Go form of one NestJS options argument, so a reader can diff it against
// crawl-frontier.service.ts field by field.
//
// NestJS treats the single "undefined" value as "key absent" in JSON, while Go
// distinguishes nil from a zero value. The optional pointer fields below carry
// that distinction: a nil pointer means the NestJS key was undefined (omit the
// key), and a non-nil pointer to a zero value means the key was present.

import (
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// The node chain reuses the record shapes the judge/learn chain already reads so
// a node read by one worker is the same value the other worker sees.
type (
	nodeRecord    = crawlfrontierllm.NodeRecord
	profileRecord = crawlfrontierllm.ProfileRecord
	candidate     = crawlfrontierllm.Candidate
	// candidateDecision is the layeredExecutor candidate trace decision.
	candidateDecision = crawlfrontierllm.CandidateDecision
)

// runRecord is crawlfrontierllm.RunRecord plus the startedAt column
// processQueuedNode reads (`startedAt: node.run.startedAt ?? new Date()`). The
// shared RunRecord projection is left untouched so the judge/learn reads keep
// their column list.
type runRecord struct {
	crawlfrontierllm.RunRecord
	StartedAt *time.Time
}

// seedRunRef is the inline run projection discoverSeedNodes/materializeSeed
// take: {id, seedUrl, maxDepth, maxPages}.
type seedRunRef struct {
	ID       string
	SeedURL  string
	MaxDepth int
	MaxPages int
}

// resolvedSeedDiscoveryConfig is CrawlStrategyResolvedSeedDiscoveryConfig.
type resolvedSeedDiscoveryConfig struct {
	Mode                 string
	FreshnessWindowHours float64
	MaxSeedURLs          int
	TopologyBudgetPages  int
	TopologyBudgetDepth  int
	QualityThresholds    crawlfrontierllm.SeedQualityThresholds
}

// seedDiscoveryOutcome is CrawlStrategyRootSeedDiscoveryOutcome /
// CrawlStrategySeedMaterializationOutcome.
type seedDiscoveryOutcome struct {
	Created                int
	SelectedPageTypeCounts *crawlfrontierllm.Object
	Diagnostics            *crawlfrontierllm.Object
}

// rootSeedPlan is CrawlStrategyRootSeedPlan.
type rootSeedPlan struct {
	SeedStrategy          string
	SeedConfig            resolvedSeedDiscoveryConfig
	TopologyBudgetDepth   *int
	TopologyBudgetPages   *int
	TopologyMetadataPatch *crawlfrontierllm.Object
}

// candidateExtraction is CrawlStrategyLayeredCandidateExtraction.
type candidateExtraction struct {
	Candidates  []crawlfrontierllm.Candidate
	Decisions   []crawlfrontierllm.CandidateDecision
	Diagnostics *crawlfrontierllm.Object
}

// rootBranchSummary is rootExecutor.buildRootBranchSummary's result.
type rootBranchSummary struct {
	CombinedWarningFlags  []string
	PendingLlmJudgeJobs   int
	LlmJudgeDeferredModes []string
	MetadataPatch         *crawlfrontierllm.Object
}

// nativeDiscoveryMaterialization is
// CrawlStrategyNativeDiscoveryMaterialization.
type nativeDiscoveryMaterialization struct {
	AcceptedCount          int
	CreatedCount           int
	ScannedSourceURLs      []string
	RejectionCounts        *crawlfrontierllm.Object
	AcceptedPageTypeCounts *crawlfrontierllm.Object
	SelectedPageTypeCounts *crawlfrontierllm.Object
	NativeWarningFlags     []string
}

// frontierStoredResult is one CrawlResult row persistFrontierResponse reads back
// for the self-result lookup.
type frontierStoredResult struct {
	ID        string
	SourceURL string
	Metadata  *crawlfrontierllm.Object
	FetchedAt time.Time
}

// executeNodeOptions is executeNode's options object (crawl-frontier.service.ts
// 1459-1475). Run is the run projection with keywords coerced and
// workflowRunId resolved, exactly like the object processQueuedNode builds.
type executeNodeOptions struct {
	Node             *crawlfrontierllm.NodeRecord
	Run              *runRecord
	Profile          *crawlfrontierllm.ProfileRecord
	Task             *crawlexecution.FrontierCrawlTask
	RequestTimeoutMs int
}

// persistFrontierOptions is persistFrontierResponse's options object (2478).
type persistFrontierOptions struct {
	Response      crawl4ai.PipelineResponse
	Node          *crawlfrontierllm.NodeRecord
	Profile       *crawlfrontierllm.ProfileRecord
	RunID         string
	Task          *crawlexecution.FrontierCrawlTask
	CrawlOptions  layeredCrawlOptions
	ExecutionMode string
}

// persistFrontierOutcome is persistFrontierResponse's result.
type persistFrontierOutcome struct {
	Summary            CrawlExecutionSummary
	SelfResult         *frontierStoredResult
	SelfScore          *float64
	SelfFreshnessScore *float64
	Results            []frontierStoredResult
}

// discoverChildNodesInput is discoverChildNodes' options object (2980-2991).
type discoverChildNodesInput struct {
	Node             *crawlfrontierllm.NodeRecord
	RunID            string
	TaskID           string
	MaxDepth         int
	MaxPages         int
	Profile          *crawlfrontierllm.ProfileRecord
	Results          []crawl4ai.PipelineArticle
	MaxDepthOverride *int
	MaxNewNodes      *int
	MetadataPatch    *crawlfrontierllm.Object
}

// discoverSeedNodesInput is discoverSeedNodes' options object (3036-3047).
type discoverSeedNodesInput struct {
	Node             *crawlfrontierllm.NodeRecord
	Run              seedRunRef
	Profile          *crawlfrontierllm.ProfileRecord
	TaskID           string
	RequestTimeoutMs int
}

// deferJudgeDiscoveryInput is deferLlmJudgeForDiscovery's options object (3157).
type deferJudgeDiscoveryInput struct {
	Node                  *crawlfrontierllm.NodeRecord
	RunID                 string
	TaskID                string
	MaxDepth              int
	MaxPages              int
	Profile               *crawlfrontierllm.ProfileRecord
	Candidates            []crawlfrontierllm.Candidate
	ExtractionDiagnostics *crawlfrontierllm.Object
	WorkflowRunID         string
	MaxDepthOverride      *int
	MaxNewNodes           *int
	MetadataPatch         *crawlfrontierllm.Object
}

// deferJudgeSeedInput is deferLlmJudgeForSeed's options object (3251).
type deferJudgeSeedInput struct {
	Node               *crawlfrontierllm.NodeRecord
	Run                seedRunRef
	TaskID             string
	Profile            *crawlfrontierllm.ProfileRecord
	Candidates         []crawlfrontierllm.Candidate
	DiscoveredCount    int
	SeedConfig         resolvedSeedDiscoveryConfig
	SitemapDiagnostics *crawlfrontierllm.Object
}

// rootSeedBranchInput is executeRootSeedBranch's options object (3456). The
// NestJS `discoverSeedBranch` callback becomes a plain call: the Go branch
// always runs discoverSeedNodes with these inputs.
type rootSeedBranchInput struct {
	WorkflowRunID    string
	Node             *crawlfrontierllm.NodeRecord
	Run              seedRunRef
	Profile          *crawlfrontierllm.ProfileRecord
	TaskID           string
	RequestTimeoutMs int
	SeedStrategy     string
}

// rootBranchSummaryInput is buildRootBranchSummary's options object (214).
type rootBranchSummaryInput struct {
	NodeMetadata    *crawlfrontierllm.Object
	LastError       *string
	RuntimeMetadata *crawlfrontierllm.Object
	// ExtraWarningFlags is the optional `extraWarningFlags` argument. NestJS
	// spreads it between the runtime metadata flags and the branch metadata
	// flags, so its position in the combined list is part of the contract.
	ExtraWarningFlags []string
	BranchMetadata    *crawlfrontierllm.Object
	SeedDiscovery     *seedDiscoveryOutcome
	SeedPlan          rootSeedPlan
}

// rootSeedBranchEventInput is recordRootSeedBranchEvent's options object (261).
type rootSeedBranchEventInput struct {
	WorkflowRunID  string
	Node           *crawlfrontierllm.NodeRecord
	SeedStrategy   string
	SeedDiscovery  *seedDiscoveryOutcome
	SeedPlan       rootSeedPlan
	DiscoveryError error
}

// nativeFallbackInput is recordNativeFallbackExecution's options object (343).
type nativeFallbackInput struct {
	WorkflowRunID             string
	NodeID                    string
	AcceptedCount             int
	CreatedCount              int
	MinAcceptedResults        int
	MinArticleResults         int
	NativeAcceptedArticles    int
	FallbackDiscoveryMetadata *crawlfrontierllm.Object
	TriggerReason             string
}

// persistedResultRef is the `{id, sourceUrl}` projection the native discovery
// materialization reads back after persistResults.
type persistedResultRef struct {
	ID        string
	SourceURL string
}

// nativeMaterializeInput is materializeNativeDiscoveryCandidates' options
// object (layeredExecutor 1661-1681).
type nativeMaterializeInput struct {
	WorkflowRunID    string
	Node             *crawlfrontierllm.NodeRecord
	Run              seedRunRef
	Profile          *crawlfrontierllm.ProfileRecord
	PersistedResults []persistedResultRef
	RawResultsByURL  map[string]crawl4ai.PipelineArticle
}

// nodeCompletionInput is recordNodeCompletion's options object (5112) and
// rootExecutor.recordNodeCompletion's (576).
type nodeCompletionInput struct {
	WorkflowRunID    string
	Node             *crawlfrontierllm.NodeRecord
	StepKey          string
	WorkflowNodeID   string
	WorkflowNodeType string
	Label            string
	DurationMs       int
	OutputURLs       []string
	OutputCount      *int
	RejectedCount    int
	Metrics          *crawlfrontierllm.Object
}

// nodeRuntimeMetadataInput is buildNodeRuntimeMetadata's options object (2770).
type nodeRuntimeMetadataInput struct {
	Node         *crawlfrontierllm.NodeRecord
	Profile      *crawlfrontierllm.ProfileRecord
	Response     crawl4ai.PipelineResponse
	SelfMetadata *crawlfrontierllm.Object
	CrawlOptions layeredCrawlOptions
}

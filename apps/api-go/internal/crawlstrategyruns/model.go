package crawlstrategyruns

import (
	"encoding/json"
	"fmt"
	"time"
)

// This file defines the typed workflow-run documents. The JSON shapes are the
// source's: CrawlStrategyWorkflowCandidate / CrawlStrategyWorkflowStepResult /
// CrawlStrategyCandidateTraceEntry / CrawlStrategyWorkflowRunEvent
// (apps/api/src/modules/crawl/crawl-strategy.types.ts:91-190) and the
// recorder's mapCandidate/mapStep/mapEvent.

// Workflow node type values (CrawlStrategyWorkflowNodeType).
const (
	NodeTypeSeedDiscovery      = "seed-discovery"
	NodeTypeListDiscovery      = "list-discovery"
	NodeTypeDeepDiscovery      = "deep-discovery"
	NodeTypeURLFilter          = "url-filter"
	NodeTypeContentFilter      = "content-filter"
	NodeTypePageTypeClassifier = "page-type-classifier"
	NodeTypeURLScorer          = "url-scorer"
	NodeTypeFreshnessScorer    = "freshness-scorer"
	NodeTypeBranch             = "branch"
	NodeTypeBudgetControl      = "budget-control"
	NodeTypeFallbackStrategy   = "fallback-strategy"
	NodeTypePersistResult      = "persist-result"
)

// Candidate trace actions.
const (
	TraceActionDiscovered = "discovered"
	TraceActionClassified = "classified"
	TraceActionFiltered   = "filtered"
	TraceActionScored     = "scored"
	TraceActionBranched   = "branched"
	TraceActionBudgeted   = "budgeted"
	TraceActionFallback   = "fallback"
	TraceActionPersisted  = "persisted"
)

// Candidate statuses.
const (
	CandidateStatusActive   = "active"
	CandidateStatusSelected = "selected"
	CandidateStatusRejected = "rejected"
)

// Run statuses (CrawlStrategyWorkflowRunStatus).
const (
	RunStatusPending   = "pending"
	RunStatusQueued    = "queued"
	RunStatusRunning   = "running"
	RunStatusCompleted = "completed"
	RunStatusFailed    = "failed"
	RunStatusCanceled  = "canceled"
)

// Run kinds (CrawlStrategyWorkflowRunKind) and the DTO's allowed trial kinds.
const (
	RunKindTrial             = "trial"
	RunKindProfilePreview    = "profile_preview"
	RunKindNewsSourcePreview = "news_source_preview"
	RunKindFrontierCompile   = "frontier_compile"
	RunKindFrontierRun       = "frontier_run"
)

// Workflow origins.
const (
	WorkflowOriginBound        = "bound"
	WorkflowOriginLegacyBridge = "legacy_bridge"
)

// Trace is CrawlStrategyCandidateTraceEntry.
type Trace struct {
	NodeID         string          `json:"nodeId"`
	NodeType       string          `json:"nodeType"`
	Action         string          `json:"action"`
	Message        string          `json:"message"`
	Accepted       *bool           `json:"accepted,omitempty"`
	ScoreDelta     *float64        `json:"scoreDelta,omitempty"`
	FreshnessDelta *float64        `json:"freshnessDelta,omitempty"`
	RuleHits       []string        `json:"ruleHits,omitempty"`
	RejectedReason *string         `json:"rejectedReason,omitempty"`
	BeforeSnapshot json.RawMessage `json:"beforeSnapshot,omitempty"`
	AfterSnapshot  json.RawMessage `json:"afterSnapshot,omitempty"`
	Details        json.RawMessage `json:"details,omitempty"`
	Timestamp      string          `json:"timestamp"`
}

// Candidate is CrawlStrategyWorkflowCandidate.
type Candidate struct {
	ID               string          `json:"id"`
	URL              string          `json:"url"`
	Title            *string         `json:"title,omitempty"`
	Description      *string         `json:"description,omitempty"`
	Author           *string         `json:"author,omitempty"`
	PageType         *string         `json:"pageType,omitempty"`
	RelevanceScore   *float64        `json:"relevanceScore,omitempty"`
	Score            *float64        `json:"score,omitempty"`
	FreshnessScore   *float64        `json:"freshnessScore,omitempty"`
	QualityScore     *float64        `json:"qualityScore,omitempty"`
	PublishedAt      *string         `json:"publishedAt"`
	CrawledAt        *string         `json:"crawledAt"`
	EffectiveAt      *string         `json:"effectiveAt"`
	Status           string          `json:"status"`
	RejectedByNodeID *string         `json:"rejectedByNodeId"`
	RejectedReason   *string         `json:"rejectedReason"`
	SourceNodeID     string          `json:"sourceNodeId"`
	Metadata         json.RawMessage `json:"metadata"`
	Trace            []Trace         `json:"trace"`
}

// Step is CrawlStrategyWorkflowStepResult.
type Step struct {
	StepKey       string          `json:"stepKey,omitempty"`
	NodeID        string          `json:"nodeId"`
	NodeType      string          `json:"nodeType"`
	Label         string          `json:"label"`
	Status        string          `json:"status"`
	DurationMs    int             `json:"durationMs"`
	InputCount    int             `json:"inputCount"`
	OutputCount   int             `json:"outputCount"`
	RejectedCount int             `json:"rejectedCount"`
	SampleURLs    []string        `json:"sampleUrls"`
	Metrics       json.RawMessage `json:"metrics,omitempty"`
	Error         *string         `json:"error,omitempty"`
}

// SystemEvent is CrawlStrategyWorkflowRunEvent.
type SystemEvent struct {
	ID            string          `json:"id,omitempty"`
	Sequence      *int            `json:"sequence,omitempty"`
	Level         string          `json:"level"`
	EventType     string          `json:"eventType"`
	NodeID        *string         `json:"nodeId"`
	NodeType      *string         `json:"nodeType"`
	Message       string          `json:"message"`
	TriggerReason *string         `json:"triggerReason"`
	BeforeCount   *int            `json:"beforeCount"`
	AfterCount    *int            `json:"afterCount"`
	RescuedCount  *int            `json:"rescuedCount"`
	Details       json.RawMessage `json:"details,omitempty"`
	Timestamp     string          `json:"timestamp"`
}

// RunResult is CrawlStrategyWorkflowRunResult.
type RunResult struct {
	Definition         json.RawMessage `json:"definition"`
	Steps              []Step          `json:"steps"`
	Candidates         []Candidate     `json:"candidates"`
	SelectedCandidates []Candidate     `json:"selectedCandidates"`
	ParameterSources   []any           `json:"parameterSources"`
	SystemEvents       []SystemEvent   `json:"systemEvents"`
}

// TrialRunWorkflow is the trial/replay response's workflow object.
type TrialRunWorkflow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	VersionID string `json:"versionId"`
	Version   int    `json:"version"`
}

// TrialRunResponse is the trialRunWorkflow/replayRun HTTP body:
// `{ runId, workflow, ...result }`.
type TrialRunResponse struct {
	RunID              string           `json:"runId"`
	Workflow           TrialRunWorkflow `json:"workflow"`
	Definition         json.RawMessage  `json:"definition"`
	Steps              []Step           `json:"steps"`
	Candidates         []Candidate      `json:"candidates"`
	SelectedCandidates []Candidate      `json:"selectedCandidates"`
	ParameterSources   []any            `json:"parameterSources"`
	SystemEvents       []SystemEvent    `json:"systemEvents"`
}

// runRow is one CrawlStrategyWorkflowRun row needed by replay.
type runRow struct {
	ID                string
	OrgID             string
	WorkflowID        *string
	WorkflowVersionID *string
	WorkflowOrigin    string
	Status            string
	RunKind           string
	Input             json.RawMessage
	WorkflowName      *string
	VersionValue      *int
}

// createRunInput is CreateWorkflowRunInput.
type createRunInput struct {
	OrgID             string
	CreatedByID       string
	WorkflowID        *string
	WorkflowVersionID *string
	WorkflowOrigin    string
	ProfileID         *string
	NewsSourceID      *string
	FrontierRunID     *string
	Status            string
	RunKind           string
	Input             json.RawMessage
	GraphSnapshot     json.RawMessage
	ParameterSources  []any
	StartedAt         *time.Time
}

// finalizeRunInput is FinalizeWorkflowRunInput.
type finalizeRunInput struct {
	Status           string
	Output           json.RawMessage
	Steps            []Step
	Candidates       []Candidate
	ParameterSources []any
	Events           []SystemEvent
	Error            *string
	FinishedAt       *time.Time
}

// candidateSnapshot is the beforeSnapshot/afterSnapshot object
// (buildCandidateSnapshot).
type candidateSnapshot struct {
	URL            string   `json:"url"`
	PageType       *string  `json:"pageType"`
	Score          *float64 `json:"score"`
	FreshnessScore *float64 `json:"freshnessScore"`
	RelevanceScore *float64 `json:"relevanceScore"`
	Status         *string  `json:"status"`
	RejectedReason *string  `json:"rejectedReason"`
}

func marshalJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

func marshalEmptyObjectIfNil(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("{}")
	}
	return value
}

func isoNow(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z")
}

// nullableTime passes a *time.Time to the MySQL driver as a real datetime value
// (a formatted string would be rejected by DATETIME(3) columns).
func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Truncate(time.Millisecond)
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("null")
	}
	return encoded
}

func quote(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

func formatFloat(value float64, digits int) string {
	return fmt.Sprintf("%.*f", digits, value)
}

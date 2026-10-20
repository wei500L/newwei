package crawlfrontierllm

import (
	"encoding/json"
)

// This file defines the named strong types the two queues carry. Open-ended
// leaves Nest reads as Record<string, unknown> stay *Object (ordered, keeps
// unknown keys) instead of map[string]any.

// JobData is CrawlJobData for the two LLM queues.
type JobData struct {
	TaskID           string           `json:"taskId"`
	OrgID            string           `json:"orgId"`
	TraceID          string           `json:"traceId"`
	JobKind          string           `json:"jobKind"`
	FrontierRunID    string           `json:"frontierRunId"`
	FrontierNodeID   string           `json:"frontierNodeId"`
	FrontierLlmJudge *LlmJudgePayload `json:"frontierLlmJudge,omitempty"`
	FrontierLlmLearn *LlmLearnPayload `json:"frontierLlmLearn,omitempty"`
}

// JobKind values.
const (
	JobKindFrontierNode     = "frontier_node"
	JobKindFrontierLlmJudge = "frontier_llm_judge"
	JobKindFrontierLlmLearn = "frontier_llm_learn"
)

// JudgeMode is the deferred judge mode.
type JudgeMode string

const (
	JudgeModeSeed      JudgeMode = "seed"
	JudgeModeDiscovery JudgeMode = "discovery"
)

// Candidate is CrawlFrontierCandidatePayload.
type Candidate struct {
	URL            string          `json:"url"`
	PageType       string          `json:"pageType"`
	Score          float64         `json:"score"`
	FreshnessScore float64         `json:"freshnessScore"`
	Metadata       json.RawMessage `json:"metadata"`
}

// metadataObject reads the candidate metadata as an ordered object; a missing
// or non-object leaf is an empty object, exactly like the isPlainObject check
// in processQueuedLlmJudge.
func (c Candidate) metadataObject() *Object {
	object, ok := ParseObject(c.Metadata)
	if !ok {
		return NewObject()
	}
	return object
}

// LlmJudgePayload is CrawlFrontierLlmJudgeJobPayload.
type LlmJudgePayload struct {
	Mode             JudgeMode       `json:"mode"`
	RunID            string          `json:"runId"`
	NodeID           string          `json:"nodeId"`
	TaskID           string          `json:"taskId"`
	MaxDepth         int             `json:"maxDepth"`
	MaxPages         int             `json:"maxPages"`
	Candidates       []Candidate     `json:"candidates"`
	Diagnostics      json.RawMessage `json:"diagnostics,omitempty"`
	MaxDepthOverride *int            `json:"maxDepthOverride,omitempty"`
	MaxNewNodes      *int            `json:"maxNewNodes,omitempty"`
	MetadataPatch    json.RawMessage `json:"metadataPatch,omitempty"`
	SeedContext      *SeedContext    `json:"seedContext,omitempty"`
}

// SeedContext is the deferred seed payload branch.
type SeedContext struct {
	SeedMethod        *string         `json:"seedMethod"`
	SeedDiscoveryMode *string         `json:"seedDiscoveryMode"`
	Diagnostics       json.RawMessage `json:"diagnostics,omitempty"`
	DiscoveredCount   int             `json:"discoveredCount"`
	QualityThresholds json.RawMessage `json:"qualityThresholds,omitempty"`
}

// LlmLearnPayload is CrawlFrontierLlmLearnJobPayload.
type LlmLearnPayload struct {
	RunID string `json:"runId"`
}

// diagnosticsObject reads a diagnostics leaf as an ordered object.
func (p *LlmJudgePayload) diagnosticsObject() *Object {
	object, ok := ParseObject(p.Diagnostics)
	if !ok {
		return nil
	}
	return object
}

// seedDiagnosticsObject reads the seed diagnostics leaf.
func (s *SeedContext) seedDiagnosticsObject() *Object {
	if s == nil {
		return nil
	}
	object, ok := ParseObject(s.Diagnostics)
	if !ok {
		return NewObject()
	}
	return object
}

// qualityThresholds reads the seed quality gate thresholds.
type qualityThresholds struct {
	MinCandidates   float64
	MinArticleRatio float64
	MaxNoiseRatio   float64
	MinFreshRatio   float64
}

func parseQualityThresholds(raw json.RawMessage) qualityThresholds {
	out := qualityThresholds{MinCandidates: 1, MaxNoiseRatio: 1}
	object, ok := ParseObject(raw)
	if !ok {
		return out
	}
	if value, ok := object.Number("minCandidates"); ok {
		out.MinCandidates = value
	}
	if value, ok := object.Number("minArticleRatio"); ok {
		out.MinArticleRatio = value
	}
	if value, ok := object.Number("maxNoiseRatio"); ok {
		out.MaxNoiseRatio = value
	}
	if value, ok := object.Number("minFreshRatio"); ok {
		out.MinFreshRatio = value
	}
	return out
}

// RunRecord is the CrawlFrontierRun subset the chain reads.
type RunRecord struct {
	ID             string
	OrgID          string
	ProfileID      *string
	WorkflowRunID  *string
	SeedURL        string
	CrawlTaskID    *string
	ExecutionMode  string
	Status         string
	MaxDepth       int
	MaxPages       int
	Keywords       []string
	PageCount      int
	NodeCount      int
	ArticleCount   int
	FailedCount    int
	DuplicateCount int
	LastError      *string
	Metadata       *Object
	CreatedByID    string
}

// NodeRecord is the CrawlFrontierNode subset the chain reads.
type NodeRecord struct {
	ID              string
	RunID           string
	ParentNodeID    *string
	OrgID           string
	URL             string
	CanonicalURL    *string
	URLFingerprint  *string
	PageType        string
	Depth           int
	QueueClass      string
	Status          string
	Score           *float64
	FreshnessScore  *float64
	QueuedAt        *string
	RejectionReason *string
	LastError       *string
	Metadata        *Object
	DiscoveredAt    string
}

// ProfileRecord is the CrawlSiteProfile subset the chain reads.
type ProfileRecord struct {
	ID                  string
	OrgID               string
	Name                string
	Description         *string
	MatchHost           string
	IsActive            bool
	ExecutionMode       string
	WorkflowID          *string
	WorkflowVersionID   *string
	WorkflowBindingMode string
	Version             int
	Config              *Object
	CreatedByID         string
}

// ConfigString reads a top-level string from the normalized profile config.
func (p ProfileRecord) ConfigString(key string) (string, bool) {
	if p.Config == nil {
		return "", false
	}
	return p.Config.String(key)
}

// ConfigObject reads a top-level object from the normalized profile config.
func (p ProfileRecord) ConfigObject(key string) (*Object, bool) {
	if p.Config == nil {
		return nil, false
	}
	return p.Config.Object(key)
}

// LlmAssist is resolveEffectiveLlmAssistConfig's result.
type LlmAssist struct {
	Enabled                   bool
	RecallMode                string
	JudgeModel                *string
	SiteLearnerModel          *string
	CandidateBudgetByPageType *Object
	MinJudgeConfidence        float64
	ShadowEvaluationRuns      int
	AutoPublishThresholds     *Object
	Shadow                    *Object
}

// NestError is a NestJS-style HTTP error the processor surfaces as a failed job.
type NestError struct {
	Status  int
	Message string
}

func (e *NestError) Error() string { return e.Message }

func notFound(message string) error   { return &NestError{Status: 404, Message: message} }
func badRequest(message string) error { return &NestError{Status: 400, Message: message} }

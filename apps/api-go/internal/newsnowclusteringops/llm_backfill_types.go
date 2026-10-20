package newsnowclusteringops

import (
	"context"
	"time"
)

// Constants of the news-event clustering LLM backfill chain. They mirror the
// NestJS news-event-clustering-recovery.constants.ts and
// news-event-clustering-recovery.service.ts values.
const (
	// LlmBackfillQueueName is the BullMQ queue shared with the NestJS worker.
	LlmBackfillQueueName = "news_event_clustering_recovery"
	// LlmBackfillJobType is the only job type this chain serves and the BullMQ
	// job name NestJS writes.
	LlmBackfillJobType = "llm_backfill"
	// LlmBackfillActorID is the actor recorded for an automatic scan enqueue.
	LlmBackfillActorID = "system:news-event-clustering-recovery"
	// LlmBackfillBatchSize mirrors AUTO_BACKFILL_BATCH_SIZE (25).
	LlmBackfillBatchSize = 25
	// LlmBackfillRetryAfter mirrors AUTO_BACKFILL_RETRY_AFTER_MS (15 minutes).
	// It is also the age threshold of the stale-processing recovery rule.
	LlmBackfillRetryAfter = 15 * time.Minute
	// LlmBackfillStaleBatchSize bounds one stale-processing recovery scan.
	LlmBackfillStaleBatchSize = 100
	// llmBackfillCandidateLimit is the candidate count requested from the
	// assignment-candidate query (NestJS passes {limit: 6}).
	llmBackfillCandidateLimit = 6
	// llmBackfillVectorSearchLimit mirrors DEFAULT_VECTOR_SEARCH_LIMIT (50).
	llmBackfillVectorSearchLimit = 50
)

// Error messages of the manual enqueue and worker paths. The first four are
// the exact NestJS messages; the remaining two are the worker-side equivalents
// NestJS raises as plain Errors.
const (
	msgLlmBackfillNotReady            = "LLM gateway completion profile is not ready for manual backfill"
	msgLlmBackfillWorkerNotReady      = "LLM gateway completion profile is not ready"
	msgLlmBackfillNotReadyForRecovery = "Failure group is not ready for recovery"
	msgLlmBackfillEmptyContent        = "LiteLLM returned empty content for manual backfill"
	msgLlmBackfillInvalidJSON         = "LiteLLM returned invalid JSON for manual backfill"
	msgLlmBackfillInvalidDecision     = "LiteLLM returned a decision that does not match the manual backfill schema"
	msgLlmBackfillMissingEventID      = "LLM backfill response did not include an eventId"
	msgLlmBackfillUnknownEventID      = "LLM backfill selected an unknown event candidate"
	msgLlmBackfillLostJob             = "LLM backfill job was lost before completion"
)

// Task-log stages of this chain. llm_backfill_queue and llm_backfill mirror the
// two NestJS writeTaskLogBestEffort calls; llm_backfill_recovery is the stage
// of the new stale-processing recovery rule (R1).
const (
	llmBackfillStageQueue    = "llm_backfill_queue"
	llmBackfillStageProcess  = "llm_backfill"
	llmBackfillStageRecovery = "llm_backfill_recovery"
)

// LlmBackfillJob is the BullMQ payload. The JSON member names and the
// optional trigger are byte-identical to the NestJS
// NewsEventClusteringRecoveryJobPayload, so a job enqueued by one runtime can
// be consumed by the other.
type LlmBackfillJob struct {
	JobType string `json:"jobType" msgpack:"jobType"`
	OrgID   string `json:"orgId" msgpack:"orgId"`
	ActorID string `json:"actorId" msgpack:"actorId"`
	GroupID string `json:"groupId" msgpack:"groupId"`
	TraceID string `json:"traceId" msgpack:"traceId"`
	Trigger string `json:"trigger,omitempty" msgpack:"trigger,omitempty"`
}

// LlmBackfillAccepted is the 201 body of the manual enqueue route.
type LlmBackfillAccepted struct {
	GroupID                string  `json:"groupId"`
	Status                 string  `json:"status"`
	ActiveJobID            string  `json:"activeJobId"`
	ProgressProcessedCount int     `json:"progressProcessedCount"`
	ProgressTotalCount     int     `json:"progressTotalCount"`
	LastRecoveryModel      *string `json:"lastRecoveryModel"`
	AttemptCount           int     `json:"attemptCount"`
}

// LlmBackfillScanResult is the outcome of one five-minute scan.
type LlmBackfillScanResult struct {
	Scanned         int  `json:"scanned"`
	Queued          int  `json:"queued"`
	Skipped         int  `json:"skipped"`
	Failed          int  `json:"failed"`
	Recovered       int  `json:"recovered"`
	SkippedNotReady bool `json:"skippedNotReady"`
}

// LlmBackfillProducer adds one claimed job to the shared BullMQ queue. The
// implementation lives outside this package; a failed Add makes the caller
// release the Mongo claim.
type LlmBackfillProducer interface {
	AddLlmBackfill(ctx context.Context, jobID string, job LlmBackfillJob) error
}

// LlmBackfillJobLiveness reports whether a BullMQ job still owns its failure
// group. It is the liveness probe of the stale-processing recovery rule.
type LlmBackfillJobLiveness interface {
	LlmBackfillJobActive(ctx context.Context, jobID string) (bool, error)
}

// LlmBackfillModelRequest is one model decision request. The caller builds the
// verbatim prompts and the fingerprint; the completion implementation owns the
// fixed parameters and the json_schema envelope.
type LlmBackfillModelRequest struct {
	OrgID              string
	Model              string
	System             string
	User               string
	CandidateCount     int
	ArticleFingerprint string
}

// LlmBackfillModelResponse is the raw assistant content.
type LlmBackfillModelResponse struct {
	Content string
}

// LlmBackfillCompleter performs one decision completion. The production adapter
// wraps publicportal.ClusteringDecisionCompleter.
type LlmBackfillCompleter interface {
	CompleteLlmBackfillDecision(ctx context.Context, req LlmBackfillModelRequest) (LlmBackfillModelResponse, error)
}

// SummaryVectorSearchRequest is one vector-service similarity search over the
// summary embeddings of an organization.
type SummaryVectorSearchRequest struct {
	OrgID          string
	EmbeddingModel string
	Vector         []float64
	Limit          int
	MinScore       float64
	Lookback       time.Duration
}

// SummaryVectorMatch is one vector-service hit.
type SummaryVectorMatch struct {
	ProcessedItemID string
	Score           float64
}

// SummaryVectorSearcher searches summary embeddings. A nil result and a
// non-nil error both mean "no vector candidates", matching the NestJS
// searchBestEffort null contract; the Go implementation intentionally keeps no
// in-process circuit breaker.
type SummaryVectorSearcher interface {
	SearchSummaryVectors(ctx context.Context, req SummaryVectorSearchRequest) ([]SummaryVectorMatch, error)
}

// LlmBackfillDeps are the ports one process/scan call needs.
type LlmBackfillDeps struct {
	Producer  LlmBackfillProducer
	Liveness  LlmBackfillJobLiveness
	Completer LlmBackfillCompleter
	Vectors   SummaryVectorSearcher
	// Now is an optional clock; a nil value uses time.Now.
	Now func() time.Time
	// Logger is an optional logger. Scan and recovery failures of one group
	// are reported here and never abort the whole tick.
	Logger func(format string, args ...any)
}

func (d LlmBackfillDeps) now() time.Time {
	if d.Now == nil {
		return time.Now().UTC().Truncate(time.Millisecond)
	}
	return d.Now().UTC().Truncate(time.Millisecond)
}

// LlmBackfillDecision is the validated model decision. EventID is already
// trimmed, and nil means the model sent null or omitted the member.
type LlmBackfillDecision struct {
	Action     string
	EventID    *string
	Confidence *float64
	Reasoning  *string
}

// AssignmentCandidate is one event the model may assign an article to. The
// score already includes the language penalty and the category gate; it is the
// NestJS NewsEventAssignmentCandidate projection.
type AssignmentCandidate struct {
	EventID       string
	Score         float64
	MatchOrigin   string
	Title         *string
	Summary       *string
	Language      *string
	PrimaryTopic  *string
	PrimaryEntity *string
	StartAt       time.Time
	LastAt        time.Time
	ItemCount     int
}

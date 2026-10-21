package queueops

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// Request limits. They are exported through the handler docs rather than as
// constants on purpose: the console contract is the JSON shape, and these bounds
// are the server-side guard rails.
const (
	// maxJSONBytes caps one request body, matching the crawl task write routes.
	maxJSONBytes int64 = 1 << 20
	// jobsDefaultLimit and jobsMaxLimit bound one job page.
	jobsDefaultLimit = 50
	jobsMaxLimit     = 200
	// batchDefaultLimit and batchMaxLimit bound the queue-level batch routes
	// (retry-failed and clean).
	batchDefaultLimit = 100
	batchMaxLimit     = 1000
	// dlqBatchDefaultLimit and dlqBatchMaxLimit bound one DLQ replay batch.
	dlqBatchDefaultLimit = 50
	dlqBatchMaxLimit     = 500
	// maxGraceMillis is 30 days; BullMQ's Queue.clean accepts a grace in
	// milliseconds and nothing in this deployment retains a job that long.
	maxGraceMillis int64 = 30 * 24 * 60 * 60 * 1000
	// dataPreviewBytes caps JobSummary.dataPreview, counted in bytes.
	dataPreviewBytes = 2000
	// jobDetailDataBytes caps JobDetail.data, counted in bytes (256 KiB).
	jobDetailDataBytes = 262144
	// jobLogsLimit is how many of the newest log rows JobDetail.logs returns.
	jobLogsLimit int64 = 50
	// replayJobIDPrefix makes a replay job id deterministic and idempotent.
	replayJobIDPrefix = "replay-"
)

// JobState is one BullMQ job state the console can list.
type JobState string

const (
	// StateWaiting is the "waiting" view; BullMQ stores it under "wait".
	StateWaiting JobState = "waiting"
	// StateActive is the active list.
	StateActive JobState = "active"
	// StateDelayed is the delayed sorted set.
	StateDelayed JobState = "delayed"
	// StateCompleted is the completed sorted set.
	StateCompleted JobState = "completed"
	// StateFailed is the failed sorted set.
	StateFailed JobState = "failed"
)

// bullmqKey is the Redis key suffix of the state: BullMQ aliases "waiting" to
// "wait" in getRanges/getCounts.
func (s JobState) bullmqKey() string {
	if s == StateWaiting {
		return "wait"
	}
	return string(s)
}

// parseJobState validates the state query parameter. An empty value is the
// documented default ("waiting").
func parseJobState(raw string) (JobState, error) {
	switch JobState(strings.TrimSpace(raw)) {
	case "":
		return StateWaiting, nil
	case StateWaiting:
		return StateWaiting, nil
	case StateActive:
		return StateActive, nil
	case StateDelayed:
		return StateDelayed, nil
	case StateCompleted:
		return StateCompleted, nil
	case StateFailed:
		return StateFailed, nil
	default:
		return "", newValidationError("state must be one of waiting, active, delayed, completed, failed")
	}
}

// CleanState is one state Queue.clean may delete from. Unlike JobState it uses
// the raw BullMQ key names, because Queue.clean takes a set name.
type CleanState string

const (
	// CleanStateCompleted is the completed sorted set.
	CleanStateCompleted CleanState = "completed"
	// CleanStateFailed is the failed sorted set.
	CleanStateFailed CleanState = "failed"
	// CleanStateWait is the waiting list.
	CleanStateWait CleanState = "wait"
	// CleanStateActive is the active list.
	CleanStateActive CleanState = "active"
	// CleanStateDelayed is the delayed sorted set.
	CleanStateDelayed CleanState = "delayed"
	// CleanStatePaused is the paused list.
	CleanStatePaused CleanState = "paused"
)

// parseCleanState validates the clean state.
func parseCleanState(raw string) (CleanState, error) {
	switch CleanState(strings.TrimSpace(raw)) {
	case CleanStateCompleted:
		return CleanStateCompleted, nil
	case CleanStateFailed:
		return CleanStateFailed, nil
	case CleanStateWait:
		return CleanStateWait, nil
	case CleanStateActive:
		return CleanStateActive, nil
	case CleanStateDelayed:
		return CleanStateDelayed, nil
	case CleanStatePaused:
		return CleanStatePaused, nil
	default:
		return "", newValidationError("state must be one of completed, failed, wait, active, delayed, paused")
	}
}

// QueueCounts is the BullMQ getCounts result for one queue.
type QueueCounts struct {
	Waiting   int64 `json:"waiting"`
	Active    int64 `json:"active"`
	Delayed   int64 `json:"delayed"`
	Completed int64 `json:"completed"`
	Failed    int64 `json:"failed"`
	Paused    int64 `json:"paused"`
}

// QueueSummary is one entry of GET /queues.
type QueueSummary struct {
	Name        string      `json:"name"`
	Counts      QueueCounts `json:"counts"`
	Paused      bool        `json:"paused"`
	Concurrency *int64      `json:"concurrency"`
	IsDLQ       bool        `json:"isDLQ"`
}

// QueueList is the GET /queues payload.
type QueueList struct {
	Queues []QueueSummary `json:"queues"`
}

// JobSummary is one row of GET /jobs.
//
// DataPreview is the stored job payload truncated to 2000 bytes on a UTF-8
// boundary, with a trailing "…" when it was cut. It is byte-bounded, not
// rune-bounded, and the result is always valid UTF-8.
type JobSummary struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Timestamp    int64  `json:"timestamp"`
	ProcessedOn  *int64 `json:"processedOn"`
	FinishedOn   *int64 `json:"finishedOn"`
	AttemptsMade int64  `json:"attemptsMade"`
	FailedReason string `json:"failedReason"`
	DataPreview  string `json:"dataPreview"`
}

// JobDetail is the GET /jobs/detail payload: the summary fields plus the full
// stored documents.
//
// Data is the raw json.RawMessage of the job hash. When it exceeds 256 KiB it is
// replaced by a JSON string holding the truncated text (a truncated JSON object
// would not be a valid document) and DataTruncated is true. OrgID is null when
// the payload has no orgId.
type JobDetail struct {
	JobSummary
	Data          json.RawMessage `json:"data"`
	Opts          json.RawMessage `json:"opts"`
	ReturnValue   json.RawMessage `json:"returnvalue"`
	Stacktrace    []string        `json:"stacktrace"`
	Logs          []string        `json:"logs"`
	DataTruncated bool            `json:"dataTruncated"`
	OrgID         *string         `json:"orgId"`
}

// JobDetailResponse is the GET /jobs/detail payload envelope.
type JobDetailResponse struct {
	Job JobDetail `json:"job"`
}

// JobsPage is the GET /jobs payload.
type JobsPage struct {
	Queue      string       `json:"queue"`
	State      JobState     `json:"state"`
	Jobs       []JobSummary `json:"jobs"`
	NextCursor *string      `json:"nextCursor"`
}

// RetryResult is the POST /jobs/retry payload. State is the state the job
// moved to ("waiting"), which is what Job.retry produces.
type RetryResult struct {
	Queue string `json:"queue"`
	JobID string `json:"jobId"`
	State string `json:"state"`
}

// DeleteResult is the POST /jobs/delete payload.
type DeleteResult struct {
	Queue   string `json:"queue"`
	JobID   string `json:"jobId"`
	Deleted bool   `json:"deleted"`
}

// PromoteResult is the POST /jobs/promote payload.
type PromoteResult struct {
	Queue string `json:"queue"`
	JobID string `json:"jobId"`
}

// RetryFailedResult is the POST /queues/retry-failed payload.
type RetryFailedResult struct {
	Queue   string `json:"queue"`
	Matched int    `json:"matched"`
	Retried int    `json:"retried"`
}

// CleanResult is the POST /queues/clean payload.
type CleanResult struct {
	Queue   string `json:"queue"`
	State   string `json:"state"`
	Removed int    `json:"removed"`
}

// PauseResult is the POST /queues/pause and /queues/resume payload.
type PauseResult struct {
	Queue  string `json:"queue"`
	Paused bool   `json:"paused"`
}

// DLQReplayResult is one entry of the POST /dlq/replay payload.
//
// Replayed is true once the new itemPipeline job exists. DlqRemoved reports
// whether the dead-letter job was deleted afterwards; a false value with
// Replayed true is the documented "enqueued but not cleaned up" outcome and
// carries a Warning. When Replayed is false, Warning holds the failure reason
// (batch mode never aborts on one bad dead-letter job).
type DLQReplayResult struct {
	DlqJobID      string  `json:"dlqJobId"`
	OriginalJobID string  `json:"originalJobId"`
	OriginalQueue string  `json:"originalQueue"`
	OrgID         string  `json:"orgId"`
	NewJobID      string  `json:"newJobId"`
	Replayed      bool    `json:"replayed"`
	DlqRemoved    bool    `json:"dlqRemoved"`
	Warning       *string `json:"warning"`
}

// DLQReplayResponse is the POST /dlq/replay payload envelope.
type DLQReplayResponse struct {
	Results []DLQReplayResult `json:"results"`
}

// DLQDeleteResult is one entry of the POST /dlq/delete payload.
type DLQDeleteResult struct {
	DlqJobID string `json:"dlqJobId"`
	Deleted  bool   `json:"deleted"`
}

// DLQDeleteResponse is the POST /dlq/delete payload envelope.
type DLQDeleteResponse struct {
	Results []DLQDeleteResult `json:"results"`
}

// jobRequest is the POST /jobs/retry, /jobs/delete and /jobs/promote body.
type jobRequest struct {
	Queue string `json:"queue"`
	JobID string `json:"jobId"`
}

// queueRequest is the POST /queues/pause and /queues/resume body.
type queueRequest struct {
	Queue string `json:"queue"`
}

// retryFailedRequest is the POST /queues/retry-failed body.
type retryFailedRequest struct {
	Queue string `json:"queue"`
	Limit *int   `json:"limit"`
}

// cleanRequest is the POST /queues/clean body. Grace is required: defaulting a
// missing grace to 0 would let a typo delete every finished job of a queue.
type cleanRequest struct {
	Queue string `json:"queue"`
	State string `json:"state"`
	Grace *int64 `json:"grace"`
	Limit *int   `json:"limit"`
}

// dlqReplayRequest is the POST /dlq/replay body. JobID and JobIDs are mutually
// exclusive; when neither is given the first Limit waiting dead-letter jobs are
// replayed.
type dlqReplayRequest struct {
	JobID  string   `json:"jobId"`
	JobIDs []string `json:"jobIds"`
	DryRun bool     `json:"dryRun"`
	Limit  *int     `json:"limit"`
}

// dlqDeleteRequest is the POST /dlq/delete body.
type dlqDeleteRequest struct {
	JobID  string   `json:"jobId"`
	JobIDs []string `json:"jobIds"`
}

// jobsQuery is the parsed GET /jobs query string.
type jobsQuery struct {
	Queue  string
	State  JobState
	Offset int
	Limit  int
}

// jobDetailQuery is the parsed GET /jobs/detail query string.
type jobDetailQuery struct {
	Queue string
	JobID string
}

// parseJobsQuery validates the GET /jobs parameters. Queue membership is checked
// by the service because the inventory lives there.
func parseJobsQuery(r *http.Request) (jobsQuery, error) {
	values := r.URL.Query()
	queue := values.Get("queue")
	if strings.TrimSpace(queue) == "" {
		return jobsQuery{}, newValidationError("queue is required")
	}
	state, err := parseJobState(values.Get("state"))
	if err != nil {
		return jobsQuery{}, err
	}
	offset := 0
	if raw := strings.TrimSpace(values.Get("cursor")); raw != "" {
		parsed, convErr := strconv.Atoi(raw)
		if convErr != nil || parsed < 0 {
			return jobsQuery{}, newValidationError("cursor must be a non-negative integer")
		}
		offset = parsed
	}
	limit := jobsDefaultLimit
	if raw := strings.TrimSpace(values.Get("limit")); raw != "" {
		parsed, convErr := strconv.Atoi(raw)
		if convErr != nil {
			return jobsQuery{}, newValidationError("limit must be an integer between 1 and 200")
		}
		limit = parsed
	}
	if limit < 1 || limit > jobsMaxLimit {
		return jobsQuery{}, newValidationError("limit must be an integer between 1 and 200")
	}
	return jobsQuery{Queue: queue, State: state, Offset: offset, Limit: limit}, nil
}

// parseJobDetailQuery validates the GET /jobs/detail query string.
func parseJobDetailQuery(r *http.Request) (jobDetailQuery, error) {
	values := r.URL.Query()
	queue := values.Get("queue")
	if strings.TrimSpace(queue) == "" {
		return jobDetailQuery{}, newValidationError("queue is required")
	}
	jobID := values.Get("jobId")
	if jobID == "" {
		return jobDetailQuery{}, newValidationError("jobId is required")
	}
	return jobDetailQuery{Queue: queue, JobID: jobID}, nil
}

// validateJobRequest validates a job mutation body.
func validateJobRequest(req jobRequest) (string, string, error) {
	if strings.TrimSpace(req.Queue) == "" {
		return "", "", newValidationError("queue is required")
	}
	if req.JobID == "" {
		return "", "", newValidationError("jobId is required")
	}
	return req.Queue, req.JobID, nil
}

// validateQueueRequest validates a queue-level mutation body.
func validateQueueRequest(req queueRequest) (string, error) {
	if strings.TrimSpace(req.Queue) == "" {
		return "", newValidationError("queue is required")
	}
	return req.Queue, nil
}

// validateBatchLimit applies the batch limit bounds of one route family.
func validateBatchLimit(raw *int, defaultValue, maxValue int) (int, error) {
	if raw == nil {
		return defaultValue, nil
	}
	if *raw < 1 || *raw > maxValue {
		return 0, newValidationError("limit must be between 1 and " + strconv.Itoa(maxValue))
	}
	return *raw, nil
}

// validateGrace validates the clean grace in milliseconds.
func validateGrace(raw *int64) (int64, error) {
	if raw == nil {
		return 0, newValidationError("grace is required")
	}
	if *raw < 0 || *raw > maxGraceMillis {
		return 0, newValidationError("grace must be between 0 and 2592000000 milliseconds")
	}
	return *raw, nil
}

// replayPlan is the validated POST /dlq/replay request.
type replayPlan struct {
	// JobIDs are the explicit dead-letter job ids; empty means "derive the
	// first Limit waiting jobs".
	JobIDs []string
	// Single is true when the caller addressed exactly one jobId. A single
	// replay reports a missing or malformed envelope as 404/422; a batch
	// reports it per item so one bad job never aborts the rest.
	Single bool
	// Limit bounds a derived batch.
	Limit  int
	DryRun bool
}

// validateDLQReplayRequest validates the replay body. Exactly one addressing
// mode is allowed: a single jobId, an explicit jobIds list, or neither (derive
// the first Limit waiting dead-letter jobs).
func validateDLQReplayRequest(req dlqReplayRequest) (replayPlan, error) {
	limit, err := validateBatchLimit(req.Limit, dlqBatchDefaultLimit, dlqBatchMaxLimit)
	if err != nil {
		return replayPlan{}, err
	}
	if req.JobID != "" && len(req.JobIDs) > 0 {
		return replayPlan{}, newValidationError("provide either jobId or jobIds, not both")
	}
	if len(req.JobIDs) > dlqBatchMaxLimit {
		return replayPlan{}, newValidationError("jobIds must contain at most 500 ids")
	}
	for _, jobID := range req.JobIDs {
		if jobID == "" {
			return replayPlan{}, newValidationError("jobIds must not contain empty ids")
		}
	}
	ids := make([]string, 0, len(req.JobIDs)+1)
	if req.JobID != "" {
		ids = append(ids, req.JobID)
	}
	ids = append(ids, req.JobIDs...)
	return replayPlan{JobIDs: ids, Single: req.JobID != "", Limit: limit, DryRun: req.DryRun}, nil
}

// validateDLQDeleteRequest validates the delete body. The second return value
// reports whether the caller addressed exactly one jobId, which changes the
// error contract (404/409 for one job, per-item results for a batch).
func validateDLQDeleteRequest(req dlqDeleteRequest) ([]string, bool, error) {
	if req.JobID != "" && len(req.JobIDs) > 0 {
		return nil, false, newValidationError("provide either jobId or jobIds, not both")
	}
	if len(req.JobIDs) > dlqBatchMaxLimit {
		return nil, false, newValidationError("jobIds must contain at most 500 ids")
	}
	ids := make([]string, 0, len(req.JobIDs)+1)
	if req.JobID != "" {
		ids = append(ids, req.JobID)
	}
	ids = append(ids, req.JobIDs...)
	if len(ids) == 0 {
		return nil, false, newValidationError("jobId or jobIds is required")
	}
	for _, jobID := range ids {
		if jobID == "" {
			return nil, false, newValidationError("jobId must not be empty")
		}
	}
	return ids, req.JobID != "", nil
}

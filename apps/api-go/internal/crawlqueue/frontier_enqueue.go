package crawlqueue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/vmihailenco/msgpack/v5"
)

// frontier_enqueue.go is the producer side of the Frontier node and Frontier LLM
// queues. It only adds new exported files to crawlqueue and leaves producer.go,
// scripts.go and model.go untouched, so the crawl4ai task producer keeps its
// existing behaviour and the parallel news-source-scheduler /
// crawl-maintenance windows keep their own new files.
//
// The three add calls mirror crawl-queue.service.ts enqueueFrontierNode,
// enqueueFrontierLlmJudge and enqueueFrontierLlmLearn field by field: the job
// name, data order, jobId shape, deduplication key, attempts, backoff and the
// failed-job retention.

// LLM queue names (crawl.constants.ts).
const (
	FrontierLlmJudgeQueue = "frontier-llm-judge"
	FrontierLlmLearnQueue = "frontier-llm-learn"
)

// Frontier node job name.
const FrontierNodeJobName = "crawl-frontier-node"

// LLM job names.
const (
	FrontierLlmJudgeJobName = "crawl-frontier-llm-judge"
	FrontierLlmLearnJobName = "crawl-frontier-llm-learn"
)

// EnqueueFrontierNodeOptions is EnqueueFrontierNodeOptions.
type EnqueueFrontierNodeOptions struct {
	OrgID          string
	TaskID         string
	FrontierRunID  string
	FrontierNodeID string
	PriorityClass  PriorityClass
	SourcePriority *int
}

// FrontierNodeJobData is CrawlJobData for a frontier_node job.
type FrontierNodeJobData struct {
	TaskID                 string `json:"taskId"`
	OrgID                  string `json:"orgId"`
	TraceID                string `json:"traceId"`
	MemoryPressureRequeues int    `json:"memoryPressureRequeues"`
	PriorityClass          string `json:"priorityClass"`
	SourcePriority         *int   `json:"sourcePriority,omitempty"`
	JobKind                string `json:"jobKind"`
	FrontierRunID          string `json:"frontierRunId"`
	FrontierNodeID         string `json:"frontierNodeId"`
}

// EnqueueFrontierLlmJudgeOptions is EnqueueFrontierLlmJudgeOptions. Payload is
// the already-encoded CrawlFrontierLlmJudgeJobPayload object.
type EnqueueFrontierLlmJudgeOptions struct {
	OrgID   string
	TaskID  string
	RunID   string
	NodeID  string
	Mode    string
	Payload json.RawMessage
}

// FrontierLlmJudgeJobData is CrawlJobData for a frontier_llm_judge job.
type FrontierLlmJudgeJobData struct {
	TaskID           string          `json:"taskId"`
	OrgID            string          `json:"orgId"`
	TraceID          string          `json:"traceId"`
	JobKind          string          `json:"jobKind"`
	FrontierRunID    string          `json:"frontierRunId"`
	FrontierNodeID   string          `json:"frontierNodeId"`
	FrontierLlmJudge json.RawMessage `json:"frontierLlmJudge"`
}

// EnqueueFrontierLlmLearnOptions is EnqueueFrontierLlmLearnOptions.
type EnqueueFrontierLlmLearnOptions struct {
	OrgID  string
	TaskID string
	RunID  string
}

// FrontierLlmLearnJobData is CrawlJobData for a frontier_llm_learn job.
type FrontierLlmLearnJobData struct {
	TaskID           string               `json:"taskId"`
	OrgID            string               `json:"orgId"`
	TraceID          string               `json:"traceId"`
	JobKind          string               `json:"jobKind"`
	FrontierRunID    string               `json:"frontierRunId"`
	FrontierLlmLearn FrontierLlmLearnBody `json:"frontierLlmLearn"`
}

// FrontierLlmLearnBody is the frontierLlmLearn payload.
type FrontierLlmLearnBody struct {
	RunID string `json:"runId"`
}

// EnqueueFrontierNode mirrors enqueueFrontierNode: the job goes to the hot or
// normal crawl4ai queue with the task-scoped node dedupe key and the
// max(1, maxRetries) attempt budget.
func (p *Producer) EnqueueFrontierNode(ctx context.Context, options EnqueueFrontierNodeOptions) error {
	if p == nil || p.redis == nil {
		return errNoRedis
	}
	settings := p.settings.Read(ctx)
	attempts := settings.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	traceID := newTraceID()
	queueClass := NormalizePriorityClass(options.PriorityClass)
	queueName := QueueNormal
	if queueClass == PriorityClassHot {
		queueName = QueueHot
	}
	jobID := FrontierNodeJobID(options.FrontierNodeID, queueClass, p.now())
	data := FrontierNodeJobData{
		TaskID:                 options.TaskID,
		OrgID:                  options.OrgID,
		TraceID:                traceID,
		MemoryPressureRequeues: 0,
		PriorityClass:          string(queueClass),
		SourcePriority:         options.SourcePriority,
		JobKind:                JobKindFrontierNodeConstant,
		FrontierRunID:          options.FrontierRunID,
		FrontierNodeID:         options.FrontierNodeID,
	}
	encodedData, err := json.Marshal(data)
	if err != nil {
		return err
	}
	jobOptions := jobOptions{
		Attempts:         int64(attempts),
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: failedRetentionAge, Count: failedRetentionCount},
		JobID:            jobID,
		Deduplication:    &deduplicationOptions{ID: "crawl-frontier-node:" + options.FrontierNodeID},
		Priority:         ToBullmqPriority(options.SourcePriority),
	}
	if settings.RetryBackoffMs != 0 {
		jobOptions.Backoff = &backoffOptions{Type: "exponential", Delay: int64(settings.RetryBackoffMs)}
	}
	return p.addFrontierJob(ctx, queueName, FrontierNodeJobName, jobID, encodedData, jobOptions)
}

// EnqueueFrontierLlmJudge mirrors enqueueFrontierLlmJudge: one attempt, the
// node+mode dedupe key and the frontier payload verbatim.
func (p *Producer) EnqueueFrontierLlmJudge(ctx context.Context, options EnqueueFrontierLlmJudgeOptions) error {
	if p == nil || p.redis == nil {
		return errNoRedis
	}
	settings := p.settings.Read(ctx)
	data := FrontierLlmJudgeJobData{
		TaskID:           options.TaskID,
		OrgID:            options.OrgID,
		TraceID:          newTraceID(),
		JobKind:          "frontier_llm_judge",
		FrontierRunID:    options.RunID,
		FrontierNodeID:   options.NodeID,
		FrontierLlmJudge: options.Payload,
	}
	encodedData, err := json.Marshal(data)
	if err != nil {
		return err
	}
	jobID := FrontierLlmJudgeJobID(options.NodeID, options.Mode, p.now())
	jobOptions := jobOptions{
		Attempts:         1,
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: failedRetentionAge, Count: failedRetentionCount},
		JobID:            jobID,
		Deduplication:    &deduplicationOptions{ID: fmt.Sprintf("crawl-frontier-llm-judge:%s:%s", options.NodeID, options.Mode)},
	}
	if settings.RetryBackoffMs != 0 {
		jobOptions.Backoff = &backoffOptions{Type: "exponential", Delay: int64(settings.RetryBackoffMs)}
	}
	return p.addFrontierJob(ctx, FrontierLlmJudgeQueue, FrontierLlmJudgeJobName, jobID, encodedData, jobOptions)
}

// EnqueueFrontierLlmLearn mirrors enqueueFrontierLlmLearn: one attempt and the
// run-scoped dedupe key.
func (p *Producer) EnqueueFrontierLlmLearn(ctx context.Context, options EnqueueFrontierLlmLearnOptions) error {
	if p == nil || p.redis == nil {
		return errNoRedis
	}
	settings := p.settings.Read(ctx)
	data := FrontierLlmLearnJobData{
		TaskID:           options.TaskID,
		OrgID:            options.OrgID,
		TraceID:          newTraceID(),
		JobKind:          "frontier_llm_learn",
		FrontierRunID:    options.RunID,
		FrontierLlmLearn: FrontierLlmLearnBody{RunID: options.RunID},
	}
	encodedData, err := json.Marshal(data)
	if err != nil {
		return err
	}
	jobID := FrontierLlmLearnJobID(options.RunID, p.now())
	jobOptions := jobOptions{
		Attempts:         1,
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: failedRetentionAge, Count: failedRetentionCount},
		JobID:            jobID,
		Deduplication:    &deduplicationOptions{ID: "crawl-frontier-llm-learn:" + options.RunID},
	}
	if settings.RetryBackoffMs != 0 {
		jobOptions.Backoff = &backoffOptions{Type: "exponential", Delay: int64(settings.RetryBackoffMs)}
	}
	return p.addFrontierJob(ctx, FrontierLlmLearnQueue, FrontierLlmLearnJobName, jobID, encodedData, jobOptions)
}

// JobKindFrontierNodeConstant is the frontier_node jobKind literal. It mirrors
// craw-queue.service.ts and stays a constant so the data struct cannot drift.
const JobKindFrontierNodeConstant = "frontier_node"

// addFrontierJob runs the official add script. The LLM queues never use a
// priority, so the standard script (the same one EnqueueTask uses for its
// non-prioritized branch) is enough; the prioritized path keeps the existing
// script for symmetry with producer.go.
func (p *Producer) addFrontierJob(ctx context.Context, queueName, jobName, jobID string, data []byte, options jobOptions) error {
	keys := keysFor(queueName)
	encodedOptions, err := msgpack.Marshal(options)
	if err != nil {
		return err
	}
	deduplicationKey := keys.dedup + options.Deduplication.ID
	arguments := []any{
		Prefix + ":" + queueName + ":",
		jobID,
		jobName,
		p.now().UnixMilli(),
		nil, // parentKey
		nil, // parentDependenciesKey
		nil, // parent
		nil, // repeatJobKey
		deduplicationKey,
	}
	encodedArguments, err := msgpack.Marshal(arguments)
	if err != nil {
		return err
	}
	script := addStandardJobScript
	scriptKeys := []string{
		keys.wait, keys.paused, keys.meta, keys.id, keys.completed,
		keys.delayed, keys.active, keys.events, keys.marker,
	}
	if options.Priority != nil && *options.Priority != 0 {
		script = addPrioritizedJobScript
		scriptKeys = []string{
			keys.marker, keys.meta, keys.id, keys.prioritized, keys.delayed,
			keys.completed, keys.active, keys.events, keys.pc,
		}
	}
	result, err := p.redis.Eval(ctx, script, scriptKeys, encodedArguments, string(data), encodedOptions).Result()
	if err != nil {
		return err
	}
	if _, err := jobIDFromEval(result); err != nil {
		return err
	}
	return nil
}

// FrontierNodeJobID is `${frontierNodeId}-${Date.now()}-${queueClass}`.
func FrontierNodeJobID(nodeID string, queueClass PriorityClass, now time.Time) string {
	return fmt.Sprintf("%s-%d-%s", nodeID, now.UnixMilli(), queueClass)
}

// FrontierLlmJudgeJobID is `llm-judge:${nodeId}:${mode}:${Date.now()}`.
func FrontierLlmJudgeJobID(nodeID, mode string, now time.Time) string {
	return fmt.Sprintf("llm-judge:%s:%s:%d", nodeID, mode, now.UnixMilli())
}

// FrontierLlmLearnJobID is `llm-learn:${runId}:${Date.now()}`.
func FrontierLlmLearnJobID(runID string, now time.Time) string {
	return fmt.Sprintf("llm-learn:%s:%d", runID, now.UnixMilli())
}

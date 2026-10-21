package queueops

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqcleanup"
	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// Fixed queue names. The pipeline queue comes from the producer package; the
// dead-letter queue is the name itempipeline/dlq.go writes to. Everything else
// comes from bullmqcleanup.Inventory.
const (
	// dlqQueue is the itemPipeline dead-letter queue.
	dlqQueue = "itemPipelineDlq"
)

// errRedisUnavailable is returned when the console was built without a Redis
// client. It maps to the fail-closed 500.
var errRedisUnavailable = errors.New("queueops: redis is not configured")

// Actor is the authenticated caller of one console operation. Both fields come
// from the authhttp identity, never from the request body.
type Actor struct {
	// OrgID is the caller's organization; it is the AuditLog orgId.
	OrgID string
	// UserID is the caller's user id; it is the AuditLog actorId.
	UserID string
}

// Options wires the console service.
type Options struct {
	// DB is the MySQL pool. It backs the audit rows only; every queue read and
	// write is Redis.
	DB *sql.DB
	// Redis is the shared BullMQ client.
	Redis *redis.Client
	// Producer enqueues the replayed itemPipeline jobs. It must share Redis with
	// the console; it needs no Mongo handle because a replay never inserts a
	// ProcessedItem.
	Producer *pipelineenqueue.Producer
	// Now is the clock of the clean timestamp. nil means time.Now.
	Now func() time.Time
}

// Service implements the queue operations console.
type Service struct {
	db       *sql.DB
	redis    *redis.Client
	producer *pipelineenqueue.Producer
	now      func() time.Time
	prefix   string
	queues   []bullmqcleanup.QueueSpec
	known    map[string]bool
}

// NewService builds the console service for the tracked queue inventory.
func NewService(opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	specs := bullmqcleanup.Inventory()
	known := make(map[string]bool, len(specs))
	for _, spec := range specs {
		known[spec.Name] = true
	}
	return &Service{
		db:       opts.DB,
		redis:    opts.Redis,
		producer: opts.Producer,
		now:      now,
		prefix:   bullmqwire.Prefix,
		queues:   specs,
		known:    known,
	}
}

// Inventory returns the queue names the console manages, in cleanup order.
func (s *Service) Inventory() []string {
	if s == nil {
		return nil
	}
	names := make([]string, 0, len(s.queues))
	for _, spec := range s.queues {
		names = append(names, spec.Name)
	}
	return names
}

// queueKeys returns the BullMQ key set of one tracked queue.
func (s *Service) queueKeys(name string) bullmqwire.Keys {
	return bullmqwire.NewKeys(s.prefix, name)
}

// validateQueue checks a queue name against the inventory. An empty name is a
// validation error; an unknown name is a 404, because the console only manages
// the queues the NestJS cleanup registry tracks.
func (s *Service) validateQueue(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", newValidationError("queue is required")
	}
	if !s.known[name] {
		return "", newStatus(http.StatusNotFound, "queue not found")
	}
	return name, nil
}

// ListQueues returns every tracked queue with its counts, paused flag and global
// concurrency.
//
// All queues are read in one Redis pipeline: one EVAL (getCounts) and two HGETs
// per queue, never one round trip per queue.
func (s *Service) ListQueues(ctx context.Context) (QueueList, error) {
	if s == nil || s.redis == nil {
		return QueueList{}, errRedisUnavailable
	}
	// A pipelined EVAL cannot fall back from NOSCRIPT, so the script is primed
	// first.
	if err := s.loadScripts(ctx, scriptGetCounts); err != nil {
		return QueueList{}, err
	}
	type queueRead struct {
		name        string
		counts      *redis.Cmd
		paused      *redis.BoolCmd
		concurrency *redis.StringCmd
	}
	pipe := s.redis.Pipeline()
	reads := make([]queueRead, 0, len(s.queues))
	for _, spec := range s.queues {
		keys := s.queueKeys(spec.Name)
		read := queueRead{
			name:        spec.Name,
			counts:      scriptGetCounts.Run(ctx, pipe, []string{keys.Base}, countStateArguments...),
			paused:      pipe.HExists(ctx, keys.Meta, "paused"),
			concurrency: pipe.HGet(ctx, keys.Meta, "concurrency"),
		}
		reads = append(reads, read)
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return QueueList{}, err
	}
	out := QueueList{Queues: make([]QueueSummary, 0, len(reads))}
	for _, read := range reads {
		rawCounts, err := read.counts.Result()
		if err != nil {
			return QueueList{}, err
		}
		counts := countsFromStateValues(rawCounts)
		summary := QueueSummary{
			Name:   read.name,
			Counts: counts,
			IsDLQ:  read.name == dlqQueue,
		}
		// Queue.isPaused is exactly this HEXISTS, not the stored value.
		paused, err := read.paused.Result()
		if err != nil {
			return QueueList{}, err
		}
		summary.Paused = paused
		concurrency, err := read.concurrency.Result()
		switch {
		case err == nil:
			if parsed, convErr := strconv.ParseInt(strings.TrimSpace(concurrency), 10, 64); convErr == nil {
				summary.Concurrency = &parsed
			}
		case errors.Is(err, redis.Nil):
		default:
			return QueueList{}, err
		}
		out.Queues = append(out.Queues, summary)
	}
	return out, nil
}

// ListJobs returns one page of the requested state, newest first.
//
// The page is addressed by an offset cursor over BullMQ's own ordering, with
// asc=0 like the Bull Board tables: a list (wait, active, paused) is read from
// its head, which is the newest entry because BullMQ LPUSHes, and a sorted set
// is read from the highest score down (the newest finishedOn for failed and
// completed, the latest deadline for delayed). One getRanges call lists the ids
// and one HMGET pipeline reads their summaries.
func (s *Service) ListJobs(ctx context.Context, query jobsQuery) (JobsPage, error) {
	queue, err := s.validateQueue(query.Queue)
	if err != nil {
		return JobsPage{}, err
	}
	if s.redis == nil {
		return JobsPage{}, errRedisUnavailable
	}
	keys := s.queueKeys(queue)
	start := int64(query.Offset)
	end := start + int64(query.Limit) - 1
	raw, err := scriptGetRanges.Run(ctx, s.redis, []string{keys.Base},
		start, end, "0", query.State.bullmqKey()).Result()
	if err != nil {
		return JobsPage{}, err
	}
	ids := firstRangeIDs(raw)
	page := JobsPage{Queue: queue, State: query.State, Jobs: []JobSummary{}}
	if len(ids) == 0 {
		return page, nil
	}
	pipe := s.redis.Pipeline()
	commands := make([]*redis.SliceCmd, len(ids))
	for index, jobID := range ids {
		commands[index] = pipe.HMGet(ctx, keys.Job(jobID), summaryHashFields...)
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return JobsPage{}, err
	}
	for index, jobID := range ids {
		values, err := commands[index].Result()
		if err != nil {
			return JobsPage{}, err
		}
		// The job may have been removed between the range read and the hash
		// read; a fully missing hash is skipped rather than rendered empty.
		if !hashValuesPresent(values) {
			continue
		}
		page.Jobs = append(page.Jobs, jobSummaryFromHash(jobID, values))
	}
	if len(ids) == query.Limit {
		next := strconv.Itoa(query.Offset + query.Limit)
		page.NextCursor = &next
	}
	return page, nil
}

// JobDetail returns one job with its full stored documents.
func (s *Service) JobDetail(ctx context.Context, query jobDetailQuery) (JobDetailResponse, error) {
	queue, err := s.validateQueue(query.Queue)
	if err != nil {
		return JobDetailResponse{}, err
	}
	if s.redis == nil {
		return JobDetailResponse{}, errRedisUnavailable
	}
	keys := s.queueKeys(queue)
	job, err := bullmqwire.ReadJob(ctx, s.redis, keys, query.JobID)
	if err != nil {
		return JobDetailResponse{}, err
	}
	if job == nil {
		return JobDetailResponse{}, newStatus(http.StatusNotFound, "job not found")
	}
	logs, err := bullmqwire.ReadJobLogs(ctx, s.redis, keys, query.JobID, jobLogsLimit)
	if err != nil {
		return JobDetailResponse{}, err
	}
	data, dataTruncated := truncateJSONDocument(job.Data)
	detail := JobDetail{
		JobSummary: JobSummary{
			ID:           job.ID,
			Name:         job.Name,
			Timestamp:    job.Timestamp,
			ProcessedOn:  job.ProcessedOn,
			FinishedOn:   job.FinishedOn,
			AttemptsMade: job.AttemptsMade,
			FailedReason: job.FailedReason,
			DataPreview:  dataPreview(job.Data),
		},
		Data:          data,
		Opts:          job.Opts,
		ReturnValue:   job.ReturnValue,
		Stacktrace:    stringSlice(job.Stacktrace),
		Logs:          stringSlice(logs),
		DataTruncated: dataTruncated,
	}
	if orgID := bullmqwire.OrgIDFromData(job.Data); orgID != "" {
		detail.OrgID = &orgID
	}
	return JobDetailResponse{Job: detail}, nil
}

// countStateArguments is the getCounts ARGV tuple. The order is the order
// QueueCounts declares its fields; "wait" is the raw key BullMQ uses for
// "waiting".
var countStateArguments = []any{"wait", "active", "delayed", "completed", "failed", "paused"}

// summaryHashFields is the HMGet field list of one JobSummary. Its order is the
// order jobSummaryFromHash reads.
var summaryHashFields = []string{
	"name",
	"timestamp",
	"processedOn",
	"finishedOn",
	"attemptsMade",
	"failedReason",
	"data",
}

// countsFromStateValues maps one getCounts reply onto QueueCounts.
//
// The argument is go-redis's generic Lua array result, not business data; every
// entry of a getCounts reply is an integer.
func countsFromStateValues(raw any) QueueCounts {
	values := int64List(raw)
	at := func(index int) int64 {
		if index < 0 || index >= len(values) {
			return 0
		}
		return values[index]
	}
	return QueueCounts{
		Waiting:   at(0),
		Active:    at(1),
		Delayed:   at(2),
		Completed: at(3),
		Failed:    at(4),
		Paused:    at(5),
	}
}

// firstRangeIDs unwraps the getRanges reply: one id array per requested state,
// and this package always requests exactly one.
func firstRangeIDs(raw any) []string {
	groups, ok := raw.([]any)
	if !ok || len(groups) == 0 {
		return nil
	}
	page, ok := groups[0].([]any)
	if !ok {
		return nil
	}
	ids := make([]string, 0, len(page))
	for _, entry := range page {
		if text, ok := entry.(string); ok {
			ids = append(ids, text)
		}
	}
	return ids
}

// jobSummaryFromHash builds one JobSummary from a summaryHashFields HMGet reply.
func jobSummaryFromHash(jobID string, values []any) JobSummary {
	return JobSummary{
		ID:           jobID,
		Name:         hashString(values, 0),
		Timestamp:    hashInt64(values, 1),
		ProcessedOn:  hashMillis(values, 2),
		FinishedOn:   hashMillis(values, 3),
		AttemptsMade: hashInt64(values, 4),
		FailedReason: hashString(values, 5),
		DataPreview:  dataPreview(jsonText(values, 6)),
	}
}

// hashValuesPresent reports whether at least one field of an HMGet reply is set.
func hashValuesPresent(values []any) bool {
	for _, value := range values {
		if value != nil {
			return true
		}
	}
	return false
}

// hashString reads one HMGet slot as text.
//
// The []any argument is the go-redis HMGet protocol result, not business data.
func hashString(values []any, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	switch value := values[index].(type) {
	case nil:
		return ""
	case string:
		return value
	case []byte:
		return string(value)
	case int64:
		return strconv.FormatInt(value, 10)
	default:
		return ""
	}
}

// hashInt64 reads one numeric HMGet slot; a missing or malformed value is 0.
func hashInt64(values []any, index int) int64 {
	raw := hashString(values, index)
	if raw == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}

// hashMillis reads one optional millisecond slot.
func hashMillis(values []any, index int) *int64 {
	raw := hashString(values, index)
	if raw == "" {
		return nil
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

// jsonText keeps a stored JSON document as text for the preview.
func jsonText(values []any, index int) []byte {
	return []byte(hashString(values, index))
}

// int64List normalizes one Lua numeric array result.
func int64List(raw any) []int64 {
	entries, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]int64, len(entries))
	for index, entry := range entries {
		switch value := entry.(type) {
		case int64:
			out[index] = value
		case int:
			out[index] = int64(value)
		case float64:
			out[index] = int64(value)
		case string:
			if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
				out[index] = parsed
			}
		}
	}
	return out
}

// stringSlice returns a non-nil copy so the JSON response carries [] not null.
func stringSlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

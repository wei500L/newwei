// Package crawlqueue implements the BullMQ producer and control surface for the
// three crawl4ai queues: crawl4ai-hot, crawl4ai-normal and the legacy crawl4ai
// queue.
//
// NestJS CrawlQueueProcessor remains the only consumer of these queues. This
// package writes the exact BullMQ v5.63.2 Redis protocol NestJS writes (job
// hash, wait list / prioritized zset, deduplication key, events stream, meta),
// and it never starts a worker, a queue event consumer or a janitor. The add
// scripts are embedded from the locked bullmq@5.63.2 package (see NOTICE).
//
// Ordering and dedup follow crawl-queue.service.ts:
//   - deduplication.id is crawl-task:{taskId}, task-scoped and queue-class
//     independent, so a retry cannot run the same task in two queues;
//   - the job id is {taskId}-{Date.now()}-{class}; the add script returns the
//     existing job id when deduplication fires, and only a fresh id increments
//     the crawl:activity counter;
//   - priority is sourcePriority clamped to [-100,100], then 101-value.
package crawlqueue

// Queue names (crawl.constants.ts).
const (
	QueueHot     = "crawl4ai-hot"
	QueueNormal  = "crawl4ai-normal"
	QueueLegacy  = "crawl4ai"
	Prefix       = "bull"
	JobName      = "crawl-task"
	HotThreshold = 50
)

// Queue control channels and counters.
const (
	WorkerConcurrencyChannel = "crawl:worker-concurrency:v1"
	ActivityHashKey          = "crawl:activity"
	CrawlSettingsCacheKey    = "crawl_client:settings"
	CrawlSettingsKey         = "crawl_client_settings"
)

// Activity hash fields (crawl-activity.service.ts).
const (
	ActiveTaskCountField = "activeTaskCount"
	LastEnqueuedAtField  = "lastEnqueuedAt"
	LastTerminalAtField  = "lastTerminalAt"
)

// Failed job retention (BULLMQ_FAILED_JOB_RETENTION).
const (
	failedRetentionAge   = 7 * 24 * 60 * 60
	failedRetentionCount = 10_000
	sourcePriorityMin    = -100
	sourcePriorityMax    = 100
	removeScanLimit      = 5_000
	removePageSize       = 200
)

// PriorityClass is CrawlPriorityClass.
type PriorityClass string

const (
	PriorityClassHot    PriorityClass = "hot"
	PriorityClassNormal PriorityClass = "normal"
)

// NormalizePriorityClass is normalizeQueueClass: only "hot" is special.
func NormalizePriorityClass(value PriorityClass) PriorityClass {
	if value == PriorityClassHot {
		return PriorityClassHot
	}
	return PriorityClassNormal
}

// ToBullmqPriority is toBullmqPriority: undefined for a non-finite value, then
// round, clamp to [-100,100] and invert into BullMQ's 1..201 range.
func ToBullmqPriority(sourcePriority *int) *int {
	if sourcePriority == nil {
		return nil
	}
	clamped := *sourcePriority
	if clamped < sourcePriorityMin {
		clamped = sourcePriorityMin
	}
	if clamped > sourcePriorityMax {
		clamped = sourcePriorityMax
	}
	value := sourcePriorityMax + 1 - clamped
	return &value
}

// TaskJobData is CrawlJobData for a crawl-task job. Field order is the NestJS
// object literal order; optional keys are omitted when undefined.
type TaskJobData struct {
	TaskID                 string  `json:"taskId"`
	OrgID                  string  `json:"orgId"`
	SourceID               *string `json:"sourceId,omitempty"`
	TriggeredByID          *string `json:"triggeredById,omitempty"`
	TraceID                string  `json:"traceId"`
	MemoryPressureRequeues int     `json:"memoryPressureRequeues"`
	PriorityClass          string  `json:"priorityClass"`
	SourcePriority         *int    `json:"sourcePriority,omitempty"`
}

// QueueCounts is the Queue.getJobCounts projection for one queue. Field order
// matches the getCounts argument order.
type QueueCounts struct {
	Waiting int64 `json:"waiting"`
	Active  int64 `json:"active"`
	Delayed int64 `json:"delayed"`
	Failed  int64 `json:"failed"`
	Paused  int64 `json:"paused"`
}

// Add returns the element-wise sum, matching mergeCounts.
func (c QueueCounts) Add(other QueueCounts) QueueCounts {
	return QueueCounts{
		Waiting: c.Waiting + other.Waiting,
		Active:  c.Active + other.Active,
		Delayed: c.Delayed + other.Delayed,
		Failed:  c.Failed + other.Failed,
		Paused:  c.Paused + other.Paused,
	}
}

// Pending is sumPendingFromCounts: waiting + delayed + active.
func (c QueueCounts) Pending() int64 {
	return c.Waiting + c.Delayed + c.Active
}

// EnqueueOptions mirrors EnqueueCrawlTaskOptions.
type EnqueueOptions struct {
	PriorityClass  PriorityClass
	SourcePriority *int
	SourceID       *string
	TriggeredByID  *string
	TraceID        string
}

// EnqueueResult reports the job id and whether BullMQ deduplicated the add.
type EnqueueResult struct {
	JobID        string
	Deduplicated bool
}

// queueKeys holds the bull:{queue}:* key names QueueKeys produces.
type queueKeys struct {
	queue       string
	wait        string
	paused      string
	meta        string
	id          string
	completed   string
	delayed     string
	active      string
	events      string
	marker      string
	prioritized string
	failed      string
	pc          string
	dedup       string
}

func keysFor(queue string) queueKeys {
	prefix := Prefix + ":" + queue + ":"
	return queueKeys{
		queue:       queue,
		wait:        prefix + "wait",
		paused:      prefix + "paused",
		meta:        prefix + "meta",
		id:          prefix + "id",
		completed:   prefix + "completed",
		delayed:     prefix + "delayed",
		active:      prefix + "active",
		events:      prefix + "events",
		marker:      prefix + "marker",
		prioritized: prefix + "prioritized",
		failed:      prefix + "failed",
		pc:          prefix + "pc",
		dedup:       prefix + "de:",
	}
}

// jobKey is bull:{queue}:{id}.
func (k queueKeys) jobKey(id string) string {
	return Prefix + ":" + k.queue + ":" + id
}

// queueEntries mirrors queueEntries(true): hot, normal, legacy.
func queueEntries() []queueKeys {
	return []queueKeys{keysFor(QueueHot), keysFor(QueueNormal), keysFor(QueueLegacy)}
}
